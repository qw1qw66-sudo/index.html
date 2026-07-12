// payment-webhook — pure, runtime-agnostic request handler.
//
// Executed in Node/vitest (tests/payments/edge-webhook.test.js) driving real
// Request objects, so the shell is genuinely exercised (reverse-audit R-7).
// index.ts is a thin Deno wrapper building `deps` from a Supabase service-role
// client + real provider adapter.
//
// Order of operations is security-critical and unchanged:
//   1. verify provider signature on the RAW body (401 on failure);
//   2. record the raw event (dedupe via unique (provider, event_id));
//   3. decide via applyWebhookEvent (pure) and execute the actions;
//   4. derived state always comes from the ledger, never the event alone.
//
// deps: {
//   env,
//   createProviderAdapter(env),
//   insertWebhookEvent(row),                 // -> {id} ; throws {code:'23505'} on dup
//   findWebhookEvent(provider, providerEventId),
//   findOrderByProviderRef(provider, providerOrderId),
//   findTxByProviderRef(provider, providerTxnId),
//   insertTransaction(row),                  // throws {code:'23505'} on dup
//   updateOrderStatus(orderId, from, to),
//   insertAuditFlag(row),
//   markEventProcessed(eventId, status, errorMessage),
// }

import { applyWebhookEvent } from "../_shared/ledger-core.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleWebhook(req, deps) {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const factory = deps.createProviderAdapter(deps.env);
  if (!factory.ok) return json(503, { ok: false, error: factory.error });
  const adapter = factory.adapter;

  const rawBody = await req.text();

  // 1. Signature first. Nothing unverified is trusted or stored as valid.
  const headers = {};
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

  // 2. Record the raw event; duplicates collide on the unique constraint.
  let eventRow;
  try {
    eventRow = await deps.insertWebhookEvent({
      provider: adapter.name,
      provider_event_id: event.providerEventId,
      event_type: event.eventType,
      payload: JSON.parse(rawBody),
      signature_valid: true,
      processing_status: "received",
    });
  } catch (e) {
    if (e && e.code === "23505") {
      // A duplicate already finalized is a normal replay. A row still marked
      // "received" means a prior invocation crashed mid-flight; resume it so
      // a partial ledger/order update cannot be stranded forever.
      try {
        eventRow = await deps.findWebhookEvent?.(adapter.name, event.providerEventId);
      } catch {
        return json(500, { ok: false, error: "EVENT_READ_FAILED" });
      }
      if (!eventRow) return json(500, { ok: false, error: "EVENT_READ_FAILED" });
      if (String(eventRow.event_type || "") !== String(event.eventType || "")) {
        return json(409, { ok: false, error: "EVENT_ID_COLLISION" });
      }
      if (eventRow.processing_status !== "received") {
        return json(200, { ok: true, duplicate: true, status: eventRow.processing_status });
      }
    } else {
      return json(500, { ok: false, error: "EVENT_WRITE_FAILED" });
    }
  }

  // 3. Load context and decide (pure), then execute the actions.
  const order = event.providerOrderId
    ? await deps.findOrderByProviderRef(adapter.name, event.providerOrderId)
    : null;
  const existingTransaction = event.providerTransactionId
    ? await deps.findTxByProviderRef(adapter.name, event.providerTransactionId)
    : null;

  const { actions } = applyWebhookEvent({
    event,
    order: order ?? null,
    existingTransaction: existingTransaction ?? null,
  });

  let processingStatus = "processed";
  let errorMessage = null;

  try {
    for (const action of actions) {
      if (action.type === "reject") {
        processingStatus = "failed";
        errorMessage = String(action.error); // sanitized code only — never payload/secrets
        break;
      }
      if (action.type === "skip_duplicate") {
        processingStatus = "skipped_duplicate";
        continue;
      }
      if (action.type === "insert_transaction") {
        try {
          await deps.insertTransaction(action.transaction);
        } catch (e) {
          if (e && e.code === "23505") processingStatus = "skipped_duplicate";
          else throw e;
        }
        continue;
      }
      if (action.type === "update_order_status") {
        await deps.updateOrderStatus(action.orderId, action.from, action.to);
        continue;
      }
      if (action.type === "flag_for_review") {
        await deps.insertAuditFlag({
          workspace_key: order?.workspace_key ?? "",
          booking_id: order?.booking_id ?? null,
          actor_label: "webhook",
          action: "flag_for_review",
          reason: action.code,
          metadata: { detail: action.detail, provider_event_id: event.providerEventId },
        });
        continue;
      }
    }
    await deps.markEventProcessed(eventRow.id, processingStatus, errorMessage);
  } catch {
    // Keep the event at "received" so the provider retry can resume safely.
    // Never return database details or the signed payload.
    return json(500, { ok: false, error: "PROCESSING_FAILED" });
  }
  return json(200, { ok: processingStatus !== "failed", status: processingStatus });
}
