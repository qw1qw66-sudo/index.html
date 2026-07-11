// executors.mjs — the narrow dispatcher that runs a CONFIRMED assistant action
// through an EXISTING application contract. This is the only place a sensitive
// tool becomes a real side effect.
//
// HARD RULES:
//   - only the registered confirmed tools are executable (explicit switch);
//     an unknown tool returns UNKNOWN_TOOL and does nothing.
//   - NO arbitrary SQL / RPC name / table / URL / shell / model-supplied code.
//   - booking writes go ONLY through save_shared_workspace_v2 (no v1 fallback);
//     the server reconstructs the document from authoritative data — it never
//     trusts a full document from the model/browser.
//   - payments go ONLY through record_manual_payment / create-payment-session;
//     never a direct payment_transactions insert, never booking.paid edits.
//   - money is integer halalas at the ledger boundary.
//
// Recoverability pattern (see handler): the confirmation token is consumed
// once (prepared->confirmed) BEFORE this runs. Each business operation is made
// idempotent with an action-derived key, so if the request is retried after a
// crash the underlying contract de-duplicates (record_manual_payment /
// create-payment-session are workspace+idempotency-scoped; save v2 is
// revision-atomic). A repeated *confirm* is short-circuited earlier by the
// already-used token and returns the stored result.

import { riyalsNumberToHalalas } from "../ledger-core.mjs";
import { resolveOutbound, detectMode } from "./whatsapp.mjs";

const ALLOWED = new Set([
  "confirm_booking_create",
  "confirm_booking_update",
  "confirm_booking_cancel",
  "confirm_manual_payment",
  "create_payment_link",
  "confirm_outbound_message",
]);

function findChalet(doc, id) {
  return (doc.chalets || []).find((c) => c.id === id && !c.deleted_at);
}
function findPeriod(chalet, id) {
  return ((chalet && chalet.periods) || []).find((p) => p.id === id);
}
function findBooking(doc, id) {
  return (doc.bookings || []).find((b) => b.id === id && !b.deleted_at);
}

/**
 * @param {object} ctx { wsKey, pin, toolName, payload:{args}, actionId }
 * @param {object} deps injected primitives (real Supabase in index.ts;
 *   real-Postgres or in-memory in tests)
 * @returns {{ ok, result_reference?, safe_result?, error? }}
 */
export async function executeConfirmedAction(ctx, deps) {
  const { wsKey, pin, toolName, payload, actionId } = ctx;
  if (!ALLOWED.has(toolName)) return { ok: false, error: "UNKNOWN_TOOL" };
  const args = (payload && payload.args) || {};

  switch (toolName) {
    case "confirm_booking_create":
      return await bookingCreate(wsKey, pin, args, deps);
    case "confirm_booking_update":
      return await bookingUpdate(wsKey, pin, args, deps);
    case "confirm_booking_cancel":
      return await bookingCancel(wsKey, pin, args, deps);
    case "confirm_manual_payment":
      return await manualPayment(wsKey, pin, args, actionId, deps);
    case "create_payment_link":
      return await paymentLink(wsKey, pin, args, actionId, deps);
    case "confirm_outbound_message":
      return await outboundMessage(wsKey, pin, args, deps);
    default:
      return { ok: false, error: "UNKNOWN_TOOL" };
  }
}

// ---------------------------------------------------------------------------
// Booking executors — reconstruct the document server-side, save via v2 only.
// ---------------------------------------------------------------------------

async function bookingCreate(wsKey, pin, args, deps) {
  const snap = await deps.getWorkspaceDoc(wsKey);
  if (!snap || !snap.data) return { ok: false, error: "WORKSPACE_NOT_FOUND" };
  const doc = snap.data;
  const chalet = findChalet(doc, String(args.chalet_id || ""));
  if (!chalet) return { ok: false, error: "CHALET_NOT_FOUND" };
  const period = findPeriod(chalet, String(args.period_id || ""));
  if (!period) return { ok: false, error: "PERIOD_NOT_FOUND" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.booking_date || ""))) {
    return { ok: false, error: "INVALID_DATE" };
  }
  if (!String(args.customer_name || "").trim()) return { ok: false, error: "CUSTOMER_NAME_REQUIRED" };
  const total = Number(args.total) || 0;
  if (total < 0) return { ok: false, error: "INVALID_TOTAL" };

  const now = new Date().toISOString();
  const booking = {
    id: deps.newId(),
    customer_name: String(args.customer_name).trim(),
    customer_phone: String(args.customer_phone || "").trim(),
    chalet_id: chalet.id,
    booking_date: String(args.booking_date),
    period_id: period.id,
    guests: Math.max(1, Number(args.guests) || 1),
    total,
    paid: 0,
    status: "confirmed",
    notes: String(args.notes || "").trim(),
    remaining_status: "",
    remaining_note: "",
    remaining_updated_at: "",
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  const nextDoc = { ...doc, bookings: [...(doc.bookings || []), booking] };
  const saved = await deps.saveWorkspaceV2(wsKey, pin, nextDoc, snap.updated_at);
  if (!saved.ok) return { ok: false, error: saved.error || "SAVE_FAILED" };
  return {
    ok: true,
    result_reference: booking.id,
    safe_result: { booking_id: booking.id, updated_at: saved.updated_at, action: "booking_created" },
  };
}

async function bookingUpdate(wsKey, pin, args, deps) {
  const snap = await deps.getWorkspaceDoc(wsKey);
  if (!snap || !snap.data) return { ok: false, error: "WORKSPACE_NOT_FOUND" };
  const doc = snap.data;
  const bookingId = String(args.booking_id || "");
  const existing = findBooking(doc, bookingId);
  if (!existing) return { ok: false, error: "BOOKING_NOT_FOUND" };

  // Apply ONLY the normalized patch fields. Never change id or paid.
  const patch = {};
  if (args.customer_name !== undefined) patch.customer_name = String(args.customer_name).trim();
  if (args.chalet_id !== undefined) {
    if (!findChalet(doc, String(args.chalet_id))) return { ok: false, error: "CHALET_NOT_FOUND" };
    patch.chalet_id = String(args.chalet_id);
  }
  if (args.period_id !== undefined) patch.period_id = String(args.period_id);
  if (args.booking_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.booking_date))) return { ok: false, error: "INVALID_DATE" };
    patch.booking_date = String(args.booking_date);
  }
  if (args.guests !== undefined) patch.guests = Math.max(1, Number(args.guests) || 1);
  if (args.total !== undefined) {
    if (Number(args.total) < 0) return { ok: false, error: "INVALID_TOTAL" };
    patch.total = Number(args.total);
  }
  if (args.notes !== undefined) patch.notes = String(args.notes).trim();

  const bookings = (doc.bookings || []).map((b) =>
    b.id === bookingId ? { ...b, ...patch, id: b.id, paid: b.paid, updated_at: new Date().toISOString() } : b,
  );
  const saved = await deps.saveWorkspaceV2(wsKey, pin, { ...doc, bookings }, snap.updated_at);
  if (!saved.ok) return { ok: false, error: saved.error || "SAVE_FAILED" };
  return { ok: true, result_reference: bookingId, safe_result: { booking_id: bookingId, updated_at: saved.updated_at, action: "booking_updated" } };
}

async function bookingCancel(wsKey, pin, args, deps) {
  const snap = await deps.getWorkspaceDoc(wsKey);
  if (!snap || !snap.data) return { ok: false, error: "WORKSPACE_NOT_FOUND" };
  const doc = snap.data;
  const bookingId = String(args.booking_id || "");
  const existing = findBooking(doc, bookingId);
  if (!existing) return { ok: false, error: "BOOKING_NOT_FOUND" };

  // Do NOT physically delete or auto-refund. Existing policy = status cancelled.
  // If the ledger shows recorded payments, proceed but flag for owner review.
  let warning = null;
  try {
    const pay = await deps.getBookingPayments(wsKey, pin, bookingId);
    if (pay && Number(pay.net_paid_halalas) > 0) warning = "HAS_RECORDED_PAYMENTS_NO_AUTO_REFUND";
  } catch { /* ledger unavailable — cancellation still proceeds */ }

  const bookings = (doc.bookings || []).map((b) =>
    b.id === bookingId ? { ...b, status: "cancelled", updated_at: new Date().toISOString() } : b,
  );
  const saved = await deps.saveWorkspaceV2(wsKey, pin, { ...doc, bookings }, snap.updated_at);
  if (!saved.ok) return { ok: false, error: saved.error || "SAVE_FAILED" };
  return { ok: true, result_reference: bookingId, safe_result: { booking_id: bookingId, updated_at: saved.updated_at, action: "booking_cancelled", warning } };
}

// ---------------------------------------------------------------------------
// Payment executors — existing contracts only.
// ---------------------------------------------------------------------------

async function manualPayment(wsKey, pin, args, actionId, deps) {
  const halalas = Number(args.amount_halalas);
  if (!Number.isSafeInteger(halalas) || halalas <= 0) return { ok: false, error: "AMOUNT_MUST_BE_POSITIVE" };
  // Action-derived, workspace-scoped idempotency key: a retried confirm of the
  // SAME action can never create a second transaction.
  const idempotencyKey = "assist:" + String(actionId || args.booking_id);
  const r = await deps.recordManualPayment(wsKey, pin, {
    booking_id: String(args.booking_id || ""),
    amount_halalas: halalas,
    payment_method: String(args.payment_method || "cash"),
    actor_label: String(args.actor_label || "assistant"),
    reason: String(args.reason || ""),
    idempotency_key: idempotencyKey,
  });
  if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || "PAYMENT_FAILED" };
  return {
    ok: true,
    result_reference: r.transaction_id || null,
    safe_result: { transaction_id: r.transaction_id || null, duplicate: Boolean(r.duplicate), action: "manual_payment_recorded" },
  };
}

async function paymentLink(wsKey, pin, args, actionId, deps) {
  const idempotencyKey = "assist-link:" + String(actionId || args.booking_id);
  const r = await deps.createPaymentSession(wsKey, pin, {
    booking_id: String(args.booking_id || ""),
    amount_halalas: args.amount_halalas !== undefined ? Number(args.amount_halalas) : null,
    idempotency_key: idempotencyKey,
  });
  if (!r || r.ok !== true) {
    // Provider-unconfigured / disabled -> honest error, no fake URL.
    return { ok: false, error: (r && r.error) || "PAYMENT_LINK_FAILED" };
  }
  const order = r.order || {};
  return {
    ok: true,
    result_reference: order.id || null,
    safe_result: { order_id: order.id || null, payment_url: order.payment_url || null, action: "payment_link_created" },
  };
}

// ---------------------------------------------------------------------------
// Communication executor — one adapter, three modes. Phone resolved ONLY here.
// ---------------------------------------------------------------------------

async function outboundMessage(wsKey, pin, args, deps) {
  const body = String(args.body || "").slice(0, 2000);
  if (!body.trim()) return { ok: false, error: "EMPTY_MESSAGE" };
  const mode = detectMode(deps.env || {});

  if (mode === "disconnected") {
    // Manual open is still possible from the frontend; automatic send is not.
    // Resolve the phone server-side to build a manual wa.me link (never sent).
    const phone = await deps.resolveCustomerPhone(wsKey, pin, String(args.booking_id || ""));
    const res = resolveOutbound({ mode: "open_manual_whatsapp", phone, body, automatic: false });
    if (res.action !== "manual_link") {
      return { ok: false, error: "WHATSAPP_NOT_CONFIGURED", safe_result: { mode } };
    }
    await deps.recordOutbound?.(wsKey, { booking_id: args.booking_id, mode: "open_manual_whatsapp", status: "opened_manual", safe_message_body: body });
    return { ok: true, safe_result: { mode: "open_manual_whatsapp", status: "opened_manual", manual_url: res.url, action: "whatsapp_opened_manual" } };
  }

  // official_cloud_api
  const phone = await deps.resolveCustomerPhone(wsKey, pin, String(args.booking_id || ""));
  const res = resolveOutbound({ mode: "official_cloud_api", phone, body, automatic: false });
  if (res.action !== "api_send") return { ok: false, error: "INVALID_DESTINATION" };
  const sent = await deps.sendOfficialWhatsApp?.({ to: res.to, body });
  if (!sent || sent.ok !== true) {
    await deps.recordOutbound?.(wsKey, { booking_id: args.booking_id, mode: "official_cloud_api", status: "failed", safe_message_body: body });
    return { ok: false, error: "WHATSAPP_SEND_FAILED" };
  }
  await deps.recordOutbound?.(wsKey, { booking_id: args.booking_id, mode: "official_cloud_api", status: "sent", provider_message_id: sent.provider_message_id, safe_message_body: body });
  return { ok: true, result_reference: sent.provider_message_id || null, safe_result: { mode: "official_cloud_api", status: "sent", action: "whatsapp_sent" } };
}

// Exported for the frontend/report to know exactly which tools are executable.
export const EXECUTABLE_TOOLS = Array.from(ALLOWED);
export { riyalsNumberToHalalas };
