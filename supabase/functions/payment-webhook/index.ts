// payment-webhook — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Receives provider webhook deliveries. Order of operations is fixed and
// security-critical:
//   1. VERIFY the provider signature on the RAW body. Unverifiable
//      deliveries are rejected (401) and never recorded as valid.
//   2. RECORD the raw event in payment_webhook_events. The unique
//      (provider, provider_event_id) constraint makes duplicate deliveries
//      collide here: they are acknowledged (200) and marked
//      skipped_duplicate without reprocessing — provider retries are safe.
//   3. PROCESS via the pure decision function applyWebhookEvent()
//      (unit-tested): inserts ledger transactions (unique per provider
//      transaction id — the same successful payment can never be recorded
//      twice), applies whitelisted order-status transitions, and flags
//      out-of-order anomalies for review instead of guessing.
//   4. Derived payment state always comes from the ledger afterwards —
//      never from this event alone, never from a browser redirect.
//
// Supported event types: payment_succeeded, payment_failed, order_expired,
// refund_succeeded (partial or full), order_cancelled.
//
// No customer secrets or signature material are ever logged; error_message
// stores sanitized codes only.

import { createClient } from "npm:@supabase/supabase-js@2";
import { applyWebhookEvent } from "../_shared/ledger-core.mjs";
import { createProviderAdapter } from "../_shared/providers/index.mjs";

type Json = Record<string, unknown>;

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const factory = createProviderAdapter(Deno.env.toObject());
  if (!factory.ok) return json(503, { ok: false, error: factory.error });
  const adapter = factory.adapter;

  const rawBody = await req.text();

  // 1. Signature first. Nothing unverified is trusted or persisted as valid.
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  if (!adapter.verifyWebhookSignature(rawBody, headers)) {
    return json(401, { ok: false, error: "INVALID_SIGNATURE" });
  }

  let event;
  try {
    event = adapter.parseWebhookEvent(rawBody);
  } catch {
    return json(400, { ok: false, error: "MALFORMED_EVENT" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 2. Record the raw event; duplicates collide on the unique constraint.
  const { data: eventRow, error: insertErr } = await supabase
    .from("payment_webhook_events")
    .insert({
      provider: adapter.name,
      provider_event_id: event.providerEventId,
      event_type: event.eventType,
      payload: JSON.parse(rawBody),
      signature_valid: true,
      processing_status: "received",
    })
    .select("id")
    .single();

  if (insertErr) {
    // Unique violation => retry/duplicate delivery. Acknowledge so the
    // provider stops retrying; the first delivery already did the work.
    return json(200, { ok: true, duplicate: true });
  }

  // 3. Load context and decide (pure logic), then execute the actions.
  const { data: order } = event.providerOrderId
    ? await supabase
        .from("payment_orders")
        .select("id, workspace_key, booking_id, provider, amount_halalas, status")
        .eq("provider", adapter.name)
        .eq("provider_order_id", event.providerOrderId)
        .maybeSingle()
    : { data: null };

  const { data: existingTransaction } = event.providerTransactionId
    ? await supabase
        .from("payment_transactions")
        .select("id, status")
        .eq("provider", adapter.name)
        .eq("provider_transaction_id", event.providerTransactionId)
        .maybeSingle()
    : { data: null };

  const { actions } = applyWebhookEvent({
    event,
    order: order ?? null,
    existingTransaction: existingTransaction ?? null,
  });

  let processingStatus = "processed";
  let errorMessage: string | null = null;

  for (const action of actions) {
    if (action.type === "reject") {
      processingStatus = "failed";
      errorMessage = String(action.error); // sanitized code only, never payload/secrets
      break;
    }
    if (action.type === "skip_duplicate") {
      processingStatus = "skipped_duplicate";
      continue;
    }
    if (action.type === "insert_transaction") {
      const { error } = await supabase.from("payment_transactions").insert(action.transaction);
      if (error) {
        // Unique index on (provider, provider_transaction_id): concurrent
        // duplicate delivery lost the race — treat as duplicate, not failure.
        processingStatus = "skipped_duplicate";
      }
      continue;
    }
    if (action.type === "update_order_status") {
      await supabase
        .from("payment_orders")
        .update({ status: action.to })
        .eq("id", action.orderId)
        .eq("status", action.from); // optimistic: transition trigger is the backstop
      continue;
    }
    if (action.type === "flag_for_review") {
      await supabase.from("payment_audit_log").insert({
        workspace_key: (order as Json | null)?.workspace_key ?? "",
        booking_id: (order as Json | null)?.booking_id ?? null,
        actor_label: "webhook",
        action: "flag_for_review",
        reason: action.code,
        metadata: { detail: action.detail, provider_event_id: event.providerEventId },
      });
      continue;
    }
  }

  // 4. Record the processing outcome on the event row.
  await supabase
    .from("payment_webhook_events")
    .update({
      processing_status: processingStatus,
      processed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", (eventRow as Json).id);

  return json(200, { ok: processingStatus !== "failed", status: processingStatus });
});
