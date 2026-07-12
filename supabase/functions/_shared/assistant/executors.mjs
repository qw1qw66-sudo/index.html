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
import { availabilityCheck, availabilityFailureAr, findDocConflictPair, docConflictReasonAr, isPeriodBookable } from "./availability.mjs";

// The SQL save guard validates the WHOLE document, so its bare
// «BOOKING_CONFLICT:id:id» token needs owner-actionable wording: either the
// booking being written truly overlaps (name the blocker) or a PRE-EXISTING
// pair blocks every save until the owner fixes it from the bookings tab.
function mapSaveFailure(saved, nextDoc, subjectId) {
  const base = String(saved.error || "").split(":", 1)[0];
  if (base !== "BOOKING_CONFLICT") return { ok: false, error: saved.error || "SAVE_FAILED" };
  const pair = findDocConflictPair(nextDoc);
  if (pair && subjectId && (pair.a.id === String(subjectId) || pair.b.id === String(subjectId))) {
    const other = pair.a.id === String(subjectId) ? pair.b : pair.a;
    const fail = availabilityFailureAr({ available: false, cause: "overlap", conflict: other });
    return { ok: false, error: "BOOKING_CONFLICT", reason_ar: fail.reason_ar };
  }
  if (pair) return { ok: false, error: "WORKSPACE_DATA_CONFLICT", reason_ar: docConflictReasonAr(pair) };
  return { ok: false, error: saved.error || "SAVE_FAILED" };
}

const ALLOWED = new Set([
  "confirm_booking_create",
  "confirm_booking_update",
  "confirm_booking_cancel",
  "confirm_manual_payment",
  "confirm_payment_link",
  "confirm_outbound_message",
]);

function findChalet(doc, id) {
  return (doc.chalets || []).find((c) => c.id === id && !c.deleted_at);
}
function findPeriod(chalet, id) {
  return ((chalet && chalet.periods) || []).find((p) => p.id === id && p.active !== false);
}
function findBooking(doc, id) {
  return (doc.bookings || []).find((b) => b.id === id && !b.deleted_at);
}

// Validate a RESULTING booking against the authoritative document. Used by both
// create and update so a write can never persist an invalid booking (unknown/
// inactive chalet, period not belonging to that chalet or with incomplete
// times, bad date, over-capacity guests, non-finite/negative or sub-halala
// total, an unintended zero total, a malformed phone, or a blank name).
// opts: { allowZeroTotal, validatePhone }
const BOOKING_STATUSES = new Set(["confirmed", "pending", "cancelled", "completed"]);
function validPhoneShape(raw) {
  // Saudi mobile, mirroring the handler's extractBookingPhone normalization.
  let digits = String(raw || "").replace(/[\s()-]/g, "").replace(/\D/g, "");
  if (digits.startsWith("00966")) digits = digits.slice(5);
  else if (digits.startsWith("966")) digits = digits.slice(3);
  if (digits.startsWith("5") && digits.length === 9) digits = "0" + digits;
  return /^05\d{8}$/.test(digits);
}
function validateResultingBooking(doc, booking, opts = {}) {
  const chalet = findChalet(doc, String(booking.chalet_id || ""));
  if (!chalet) return { ok: false, error: "CHALET_NOT_FOUND" };
  const period = findPeriod(chalet, String(booking.period_id || ""));
  if (!period) return { ok: false, error: "PERIOD_NOT_FOUND" };
  // Fail CLOSED on incomplete/malformed period times for any NEW write —
  // availability cannot be proven when the interval cannot be computed.
  if (!isPeriodBookable(period).ok) return { ok: false, error: "PERIOD_TIME_INCOMPLETE" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(booking.booking_date || ""))) return { ok: false, error: "INVALID_DATE" };
  if (!String(booking.customer_name || "").trim()) return { ok: false, error: "CUSTOMER_NAME_REQUIRED" };
  if (!BOOKING_STATUSES.has(String(booking.status || ""))) return { ok: false, error: "INVALID_STATUS" };
  const guests = Number(booking.guests);
  if (!Number.isInteger(guests) || guests < 1) {
    // An update that does NOT touch guests must not newly reject a legacy
    // booking that predates the guests field; NEW bookings always require it.
    if (!(opts.allowMissingGuests && booking.guests === undefined)) {
      return { ok: false, error: "INVALID_GUESTS" };
    }
  }
  const capacity = Number(chalet.capacity) || 0; // 0 => capacity not set (no cap)
  if (capacity > 0 && guests > capacity) return { ok: false, error: "GUESTS_EXCEED_CAPACITY" };
  const total = Number(booking.total);
  const halalas = riyalsNumberToHalalas(total);
  if (!halalas.ok) return { ok: false, error: "INVALID_TOTAL" };
  // A zero price must be an explicit owner decision («الحجز مجاني») — never an
  // omitted or unparsed amount silently becoming free.
  if (total === 0 && !opts.allowZeroTotal) return { ok: false, error: "INVALID_TOTAL" };
  if (opts.validatePhone && String(booking.customer_phone || "").trim() && !validPhoneShape(booking.customer_phone)) {
    return { ok: false, error: "INVALID_PHONE" };
  }
  return { ok: true };
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
    case "confirm_payment_link":
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

  // The booking id is bound at PREPARE time (handler) and travels in the
  // confirmed payload. Fall back to a fresh id only if one was not bound.
  const bookingId = String(args.booking_id || "") || (typeof deps.newId === "function" ? deps.newId() : "");
  if (!bookingId) return { ok: false, error: "BOOKING_ID_MISSING" };

  // Crash-retry idempotency: if this id already exists, the confirmed create
  // already ran — return it instead of writing a second booking.
  const already = (doc.bookings || []).find((b) => String(b.id) === bookingId);
  if (already) {
    return { ok: true, result_reference: bookingId, safe_result: { booking_id: bookingId, updated_at: snap.updated_at, action: "booking_created", duplicate: true } };
  }

  const chalet = findChalet(doc, String(args.chalet_id || ""));
  if (!chalet) return { ok: false, error: "CHALET_NOT_FOUND" };
  const period = findPeriod(chalet, String(args.period_id || ""));
  if (!period) return { ok: false, error: "PERIOD_NOT_FOUND" };

  const now = new Date().toISOString();
  const booking = {
    id: bookingId,
    customer_name: String(args.customer_name || "").trim(),
    customer_phone: String(args.customer_phone || "").trim(),
    chalet_id: chalet.id,
    booking_date: String(args.booking_date || ""),
    period_id: period.id,
    // NO silent defaults: a missing/invalid guests or total fails validation
    // below (INVALID_GUESTS / INVALID_TOTAL) instead of becoming 1 / 0.
    guests: Number(args.guests),
    total: Number(args.total),
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
  const valid = validateResultingBooking(doc, booking, {
    allowZeroTotal: args.total_is_free === true,
    validatePhone: true,
  });
  if (!valid.ok) return valid;
  // Overlap-aware conflict check (mirrors the app's findConflict time rule).
  // The detailed verdict tells the owner WHICH booking blocks — or that a
  // legacy timeless booking makes availability unprovable (data quality).
  const avail = availabilityCheck(doc, booking.chalet_id, booking.booking_date, period);
  if (!avail.available) {
    const fail = availabilityFailureAr(avail);
    return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
  }
  // A pre-existing conflicting pair anywhere in the doc makes the SQL guard
  // reject EVERY save — say so up front instead of a misleading slot conflict.
  const pre = findDocConflictPair(doc);
  if (pre) {
    return { ok: false, error: "WORKSPACE_DATA_CONFLICT", reason_ar: docConflictReasonAr(pre, { tail: "لم يتم حفظ الحجز." }) };
  }

  const nextDoc = { ...doc, bookings: [...(doc.bookings || []), booking] };
  const saved = await deps.saveWorkspaceV2(wsKey, pin, nextDoc, snap.updated_at);
  if (!saved.ok) return mapSaveFailure(saved, nextDoc, booking.id);
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
  if (args.customer_phone !== undefined) patch.customer_phone = String(args.customer_phone).trim();
  if (args.chalet_id !== undefined) patch.chalet_id = String(args.chalet_id);
  if (args.period_id !== undefined) patch.period_id = String(args.period_id);
  if (args.booking_date !== undefined) patch.booking_date = String(args.booking_date);
  if (args.guests !== undefined) patch.guests = Number(args.guests); // invalid => INVALID_GUESTS below
  if (args.total !== undefined) patch.total = Number(args.total);
  if (args.notes !== undefined) patch.notes = String(args.notes).trim();

  // Build the RESULTING booking and validate the whole thing (not just the
  // patch), so an update can never leave a booking pointing at an inactive
  // chalet, a period that is not that chalet's, an over-capacity guest count,
  // or an invalid total.
  const resulting = { ...existing, ...patch, id: existing.id, paid: existing.paid, updated_at: new Date().toISOString() };
  const valid = validateResultingBooking(doc, resulting, {
    // An untouched legacy zero-total stays editable; a NEW zero total needs
    // the explicit free flag. Phones are validated only when being changed,
    // and a legacy row without guests stays editable while guests untouched.
    allowZeroTotal: args.total === undefined ? true : args.total_is_free === true,
    validatePhone: args.customer_phone !== undefined,
    allowMissingGuests: args.guests === undefined,
  });
  if (!valid.ok) return valid;
  const chalet = findChalet(doc, String(resulting.chalet_id));
  const period = findPeriod(chalet, String(resulting.period_id));
  if (resulting.status === "confirmed") {
    const avail = availabilityCheck(doc, resulting.chalet_id, resulting.booking_date, period, { excludeBookingId: bookingId });
    if (!avail.available) {
      const fail = availabilityFailureAr(avail);
      return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
    }
  }

  const bookings = (doc.bookings || []).map((b) => (b.id === bookingId ? resulting : b));
  const nextDoc = { ...doc, bookings };
  // Pre-check the RESULTING doc: a pair NOT involving this booking blocks
  // every save (doc integrity); a pair involving it is this edit's own
  // overlap and the availability check above already reported it in detail.
  const pre = findDocConflictPair(nextDoc);
  if (pre && pre.a.id !== bookingId && pre.b.id !== bookingId) {
    return { ok: false, error: "WORKSPACE_DATA_CONFLICT", reason_ar: docConflictReasonAr(pre, { tail: "لم يتم حفظ التعديل." }) };
  }
  const saved = await deps.saveWorkspaceV2(wsKey, pin, nextDoc, snap.updated_at);
  if (!saved.ok) return mapSaveFailure(saved, nextDoc, bookingId);
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
  // The ledger MUST be consulted first and it must answer: a payment check that
  // fails or is unavailable FAILS CLOSED — we never cancel a booking blind to
  // whether the customer has already paid.
  let paidHalalas;
  try {
    const pay = await deps.getBookingPayments(wsKey, pin, bookingId);
    if (!pay || pay.ok === false) {
      // Fail closed, but carry the inner code so the real cause is visible.
      const inner = pay && pay.error ? ":" + String(pay.error).slice(0, 40) : "";
      return { ok: false, error: "PAYMENT_CHECK_FAILED" + inner };
    }
    paidHalalas = Number(pay.net_paid_halalas || pay.summary?.net_paid_halalas || 0) || 0;
  } catch {
    return { ok: false, error: "PAYMENT_CHECK_FAILED" };
  }
  const warning = paidHalalas > 0 ? "HAS_RECORDED_PAYMENTS_NO_AUTO_REFUND" : null;

  const bookings = (doc.bookings || []).map((b) =>
    b.id === bookingId ? { ...b, status: "cancelled", updated_at: new Date().toISOString() } : b,
  );
  const nextDoc = { ...doc, bookings };
  const saved = await deps.saveWorkspaceV2(wsKey, pin, nextDoc, snap.updated_at);
  // A cancel can itself be blocked by an UNRELATED pre-existing pair (the SQL
  // guard validates the whole doc) — explain it instead of a bare token.
  if (!saved.ok) return mapSaveFailure(saved, nextDoc, null);
  return {
    ok: true,
    result_reference: bookingId,
    safe_result: {
      booking_id: bookingId, updated_at: saved.updated_at, action: "booking_cancelled",
      paid_halalas: paidHalalas, warning,
      note_ar: warning ? "الحجز مدفوع جزئياً/كلياً — لن يتم استرداد تلقائي؛ راجع الاسترداد يدوياً." : null,
    },
  };
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
