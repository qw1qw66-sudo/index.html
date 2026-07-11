// create-payment-session — pure, runtime-agnostic request handler.
//
// This holds the REAL orchestration logic and is executed in Node/vitest
// (tests/payments/edge-create-session.test.js) driving real Request/Response
// objects, so the shell is no longer "unexecuted-by-any-runtime code"
// (reverse-audit R-7). index.ts is a thin Deno wrapper that builds `deps`
// from a Supabase service-role client and calls this.
//
// deps: {
//   env,                                     // plain object (Deno.env.toObject())
//   createProviderAdapter(env),              // from _shared/providers
//   auth(workspaceKey, pin),                 // -> { ok, error_code?, workspace_key }
//   findOrderByIdempotency(wsKey, key),      // -> order | null   (workspace-scoped)
//   expireStaleOrders(wsKey, bookingId),     // -> void           (SQL now(), atomic)
//   bookingFromWorkspace(wsKey, bookingId),  // -> booking | null
//   netPaidHalalas(wsKey, bookingId),        // -> number
//   hasActivePendingOrder(wsKey, bookingId), // -> boolean
//   insertOrder(row),                        // -> order ; throws {code:'23505'} on dup
// }

import { validateCreateSession } from "../_shared/ledger-core.mjs";

const SAFE_ORDER_FIELDS = ["id", "status", "amount_halalas", "currency", "payment_url", "expires_at"];

function pickOrder(o) {
  if (!o) return o;
  const out = {};
  for (const k of SAFE_ORDER_FIELDS) if (k in o) out[k] = o[k];
  return out;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleCreatePaymentSession(req, deps) {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const workspaceKey = String(body.workspace_key ?? "");
  const accessPin = String(body.access_pin ?? "");
  const bookingId = String(body.booking_id ?? "");
  const idempotencyKey = String(body.idempotency_key ?? "");
  const requestedAmount =
    body.amount_halalas === undefined || body.amount_halalas === null
      ? null
      : Number(body.amount_halalas);

  if (!bookingId) return json(400, { ok: false, error: "MISSING_BOOKING_ID" });
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return json(400, { ok: false, error: "MISSING_IDEMPOTENCY_KEY" });
  }

  // 1. Authenticate (throttled server-side).
  const auth = await deps.auth(workspaceKey, accessPin);
  if (!auth || !auth.ok) {
    return json(401, { ok: false, error: auth?.error_code ?? "AUTH_FAILED" });
  }
  const wsKey = String(auth.workspace_key);

  // 2. Workspace-scoped idempotency (reverse-audit follow-up 1.6). A key is
  // only ever matched WITHIN the caller's workspace, so workspace B can never
  // retrieve workspace A's order via a key collision.
  const existing = await deps.findOrderByIdempotency(wsKey, idempotencyKey);
  if (existing) {
    // Changed payload under the same key is a conflict, not a silent reuse.
    const sameBooking = String(existing.booking_id) === bookingId;
    const sameAmount = requestedAmount === null || Number(existing.amount_halalas) === requestedAmount;
    if (!sameBooking || !sameAmount) {
      return json(409, { ok: false, error: "IDEMPOTENCY_KEY_REUSE_CONFLICT" });
    }
    return json(200, { ok: true, duplicate: true, order: pickOrder(existing) });
  }

  // 3. Atomically expire stale pending orders so an expired one cannot block a
  // new link (reverse-audit follow-up 1.7). The time check is in SQL (now()).
  await deps.expireStaleOrders(wsKey, bookingId);

  // 4. Load booking + ledger net + active-order state (all server-side).
  const booking = await deps.bookingFromWorkspace(wsKey, bookingId);
  const netPaid = await deps.netPaidHalalas(wsKey, bookingId);
  const hasActive = await deps.hasActivePendingOrder(wsKey, bookingId);

  // 5. Server-side validation (pure, unit-tested).
  const validation = validateCreateSession({
    booking: booking ?? null,
    requestedAmountHalalas: requestedAmount,
    netPaidHalalas: Number(netPaid) || 0,
    hasActivePendingOrder: Boolean(hasActive),
    allowPartial: deps.env.PAYMENTS_ALLOW_PARTIAL === "true",
  });
  if (!validation.ok) return json(422, { ok: false, error: validation.error });

  // 6. Provider session — server-side only; 503 when no provider is configured.
  const factory = deps.createProviderAdapter(deps.env);
  if (!factory.ok) return json(503, { ok: false, error: factory.error });

  let session;
  try {
    session = await factory.adapter.createPaymentSession({
      amountHalalas: validation.amountHalalas,
      currency: "SAR",
      bookingId,
      workspaceKey: wsKey,
      description: `Booking ${bookingId}`,
    });
  } catch {
    return json(502, { ok: false, error: "PROVIDER_SESSION_FAILED" });
  }

  // 7. Record the order. Unique indexes make double-creation impossible.
  let order;
  try {
    order = await deps.insertOrder({
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
    });
  } catch (e) {
    if (e && e.code === "23505") {
      // Race: someone inserted concurrently. Re-resolve within the workspace.
      const raced = await deps.findOrderByIdempotency(wsKey, idempotencyKey);
      if (raced) return json(200, { ok: true, duplicate: true, order: pickOrder(raced) });
      return json(409, { ok: false, error: "ORDER_CONFLICT" });
    }
    return json(500, { ok: false, error: "ORDER_WRITE_FAILED" });
  }

  return json(200, { ok: true, order: pickOrder(order) });
}
