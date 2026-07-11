// create-payment-session — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// POST JSON body:
//   { workspace_key, access_pin, booking_id,
//     amount_halalas?,            // omitted => full remaining amount
//     idempotency_key }           // required; retries return the same order
//
// Guarantees (see docs/PAYMENT_ARCHITECTURE.md §4):
//   - workspace context validated server-side (PIN, via workspace_auth RPC);
//   - booking loaded from shared_workspaces.data (authoritative source);
//   - rejects deleted / cancelled / unknown bookings;
//   - payable amount computed on the server from booking total − ledger net;
//   - never trusts totals from the browser; rejects over-remaining amounts;
//   - partial payment only when PAYMENTS_ALLOW_PARTIAL=true;
//   - one active pending order per booking (DB unique index enforces too);
//   - provider session created server-side only; returns safe values only.
//
// Deploy (owner, staging first — NOT done by this branch):
//   supabase functions deploy create-payment-session
//   supabase secrets set PAYMENT_PROVIDER=... PAYMENT_WEBHOOK_SECRET=... etc.
//
// The service-role key is injected by the platform as
// SUPABASE_SERVICE_ROLE_KEY; it never exists in this repository or in any
// browser-visible surface.

import { createClient } from "npm:@supabase/supabase-js@2";
import { validateCreateSession } from "../_shared/ledger-core.mjs";
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

  let body: Json;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const workspaceKey = String(body.workspace_key ?? "");
  const accessPin = String(body.access_pin ?? "");
  const bookingId = String(body.booking_id ?? "");
  const idempotencyKey = String(body.idempotency_key ?? "");
  const requestedAmount = body.amount_halalas === undefined || body.amount_halalas === null
    ? null
    : Number(body.amount_halalas);

  if (!bookingId) return json(400, { ok: false, error: "MISSING_BOOKING_ID" });
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return json(400, { ok: false, error: "MISSING_IDEMPOTENCY_KEY" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 1. Authenticate workspace context (throttled server-side).
  const { data: auth, error: authErr } = await supabase
    .rpc("workspace_auth", { p_workspace_key: workspaceKey, p_access_pin: accessPin })
    .single();
  if (authErr || !auth || !(auth as Json).ok) {
    return json(401, { ok: false, error: (auth as Json)?.error_code ?? "AUTH_FAILED" });
  }
  const wsKey = String((auth as Json).workspace_key);

  // 2. Idempotency: an existing order for this key is returned as-is.
  const { data: existing } = await supabase
    .from("payment_orders")
    .select("id, status, amount_halalas, currency, payment_url, expires_at")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing) {
    return json(200, { ok: true, duplicate: true, order: existing as Json });
  }

  // 3. Load the booking from the authoritative server-side document.
  const { data: booking } = await supabase
    .rpc("booking_from_workspace", { p_workspace_key: wsKey, p_booking_id: bookingId });

  // 4. Ledger totals + active-order check.
  const { data: totals } = await supabase
    .from("v_booking_payment_totals")
    .select("net_paid_halalas")
    .eq("workspace_key", wsKey)
    .eq("booking_id", bookingId)
    .maybeSingle();

  const { data: activeOrder } = await supabase
    .from("payment_orders")
    .select("id")
    .eq("workspace_key", wsKey)
    .eq("booking_id", bookingId)
    .eq("status", "pending")
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
    .maybeSingle();

  // 5. Server-side validation (pure, unit-tested logic).
  const validation = validateCreateSession({
    booking: booking ?? null,
    requestedAmountHalalas: requestedAmount,
    netPaidHalalas: Number((totals as Json | null)?.net_paid_halalas ?? 0),
    hasActivePendingOrder: Boolean(activeOrder),
    allowPartial: Deno.env.get("PAYMENTS_ALLOW_PARTIAL") === "true",
  });
  if (!validation.ok) return json(422, { ok: false, error: validation.error });

  // 6. Provider session — created server-side only.
  const factory = createProviderAdapter(Deno.env.toObject());
  if (!factory.ok) {
    // No provider configured: payment links are disabled. The frontend shows
    // an Arabic explanation; nothing is charged, nothing is recorded.
    return json(503, { ok: false, error: factory.error });
  }

  const session = await factory.adapter.createPaymentSession({
    amountHalalas: validation.amountHalalas,
    currency: "SAR",
    bookingId,
    workspaceKey: wsKey,
    description: `Booking ${bookingId}`,
  });

  // 7. Record the order. Unique indexes (idempotency, one-active-per-booking,
  // provider order ref) make double-creation impossible even under races.
  const { data: order, error: insErr } = await supabase
    .from("payment_orders")
    .insert({
      workspace_key: wsKey,
      booking_id: bookingId,
      provider: factory.adapter.name,
      provider_order_id: session.providerOrderId,
      amount_halalas: validation.amountHalalas,
      currency: "SAR",
      status: "pending",
      payment_url: session.paymentUrl,
      expires_at: session.expiresAt,
      idempotency_key: idempotencyKey,
    })
    .select("id, status, amount_halalas, currency, payment_url, expires_at")
    .single();

  if (insErr) {
    // Unique-violation race: someone else inserted with the same key/booking.
    const { data: raced } = await supabase
      .from("payment_orders")
      .select("id, status, amount_halalas, currency, payment_url, expires_at")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (raced) return json(200, { ok: true, duplicate: true, order: raced as Json });
    return json(409, { ok: false, error: "ORDER_CONFLICT" });
  }

  // Only safe public values leave the server.
  return json(200, { ok: true, order: order as Json });
});
