// ledger-core.mjs — pure payment-ledger logic shared by the Supabase Edge
// Functions (Deno) and the vitest unit tests (Node). No I/O, no framework,
// no provider SDK: every function here is deterministic and side-effect free.
//
// Money is ALWAYS integer halalas (1 SAR = 100 halalas). Floats are only
// accepted at the riyal→halala conversion boundary, which rejects sub-halala
// precision instead of rounding silently.
//
// The rules here mirror database/migrations/0002_payment_ledger.sql
// (derive_payment_state, riyals_to_halalas, v_booking_payment_totals).
// If you change one side, change the other and the tests.

export const HALALAS_PER_RIYAL = 100;

export const TRANSACTION_TYPES = Object.freeze([
  "payment",
  "manual_payment",
  "refund",
  "adjustment",
  "legacy_opening_balance",
]);

export const PAYMENT_STATES = Object.freeze([
  "unpaid",
  "pending",
  "partially_paid",
  "paid",
  "failed",
  "expired",
  "partially_refunded",
  "refunded",
]);

// ---------------------------------------------------------------------------
// Digit + money parsing (mirrors index.html normalizeDigits; stricter on
// separators: ambiguous comma usage is an error, never a silent 10× value).
// ---------------------------------------------------------------------------

const ARABIC_DIGITS = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

export function normalizeDigits(value) {
  return String(value ?? "").replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_DIGITS[ch] || ch);
}

/**
 * Parse a human money input (riyals) into integer halalas.
 * Accepts Arabic/Persian/Latin digits, optional Arabic decimal separator
 * (٫ U+066B) or dot, thousands separators (",", "٬" U+066C) only when they
 * are unambiguous (followed by exactly 3 digits). Returns:
 *   { ok: true, halalas } or { ok: false, error }.
 * Never rounds: sub-halala precision is an error.
 */
export function parseRiyalsToHalalas(input) {
  let s = normalizeDigits(input).trim();
  if (s === "") return { ok: false, error: "EMPTY_AMOUNT" };
  s = s.replace(/[\s]/g, "");
  s = s.replace(/٫/g, ".").replace(/٬/g, ",");
  if (s.includes(",")) {
    // Accept commas strictly as thousands separators: each must be followed
    // by exactly 3 digits and the integer part must be well-grouped.
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
      return { ok: false, error: "AMBIGUOUS_SEPARATOR" };
    }
    s = s.replace(/,/g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: "NOT_A_NUMBER" };
  const negative = s.startsWith("-");
  if (negative) return { ok: false, error: "NEGATIVE_AMOUNT" };
  const [intPart, fracPart = ""] = s.split(".");
  if (fracPart.length > 2 && /[1-9]/.test(fracPart.slice(2))) {
    return { ok: false, error: "SUB_HALALA_PRECISION" };
  }
  const frac2 = (fracPart + "00").slice(0, 2);
  const halalas = BigInt(intPart) * 100n + BigInt(frac2 || "0");
  if (halalas > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "AMOUNT_TOO_LARGE" };
  }
  return { ok: true, halalas: Number(halalas) };
}

/**
 * Convert a numeric riyal amount (e.g. booking.total from the JSON document)
 * to halalas. Mirrors SQL riyals_to_halalas: throws-style error result on
 * sub-halala precision (e.g. 12.345) instead of rounding.
 */
export function riyalsNumberToHalalas(value) {
  if (typeof value !== "number" || !isFinite(value)) {
    return { ok: false, error: "NOT_A_NUMBER" };
  }
  if (value < 0) return { ok: false, error: "NEGATIVE_AMOUNT" };
  const scaled = value * HALALAS_PER_RIYAL;
  const rounded = Math.round(scaled);
  // Tolerance only for float representation error (e.g. 300.01*100 =
  // 30000.999999999996), never for real sub-halala amounts.
  if (Math.abs(scaled - rounded) > 1e-6) {
    return { ok: false, error: "SUB_HALALA_PRECISION" };
  }
  if (!Number.isSafeInteger(rounded)) return { ok: false, error: "AMOUNT_TOO_LARGE" };
  return { ok: true, halalas: rounded };
}

export function halalasToRiyalsDisplay(halalas) {
  const n = Number(halalas) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const riyals = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}${riyals}` : `${sign}${riyals}.${String(rem).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Ledger totals + derived payment state (mirror of the SQL view + function)
// ---------------------------------------------------------------------------

/**
 * transactions: [{ transaction_type, direction, amount_halalas, status }]
 */
export function computeBookingPaymentTotals(transactions) {
  let gross = 0;
  let refunded = 0;
  let pendingCount = 0;
  for (const t of transactions || []) {
    if (t.status === "pending") pendingCount += 1;
    if (t.status !== "succeeded") continue;
    if (t.direction === "in") gross += t.amount_halalas;
    else if (t.direction === "out") refunded += t.amount_halalas;
  }
  return {
    grossPaidHalalas: gross,
    refundedHalalas: refunded,
    netPaidHalalas: gross - refunded,
    pendingTxCount: pendingCount,
  };
}

/**
 * Exact mirror of SQL derive_payment_state (same rule order).
 */
export function derivePaymentState({
  totalHalalas,
  grossPaidHalalas,
  refundedHalalas,
  netPaidHalalas,
  hasPendingOrder,
  lastOrderStatus,
}) {
  if (refundedHalalas > 0 && netPaidHalalas === 0 && grossPaidHalalas > 0) return "refunded";
  if (refundedHalalas > 0 && netPaidHalalas > 0) return "partially_refunded";
  if (totalHalalas > 0 && netPaidHalalas >= totalHalalas) return "paid";
  if (netPaidHalalas > 0) return "partially_paid";
  if (hasPendingOrder) return "pending";
  if (lastOrderStatus === "failed") return "failed";
  if (lastOrderStatus === "expired") return "expired";
  return "unpaid";
}

// ---------------------------------------------------------------------------
// Booking checks (booking objects come from the workspace JSON document,
// loaded SERVER-SIDE — browser-supplied booking data is never trusted)
// ---------------------------------------------------------------------------

export function bookingIsDeleted(booking) {
  const v = booking?.deleted_at;
  return v !== null && v !== undefined && String(v) !== "" && String(v) !== "null";
}

export function bookingIsCancelled(booking) {
  return String(booking?.status || "") === "cancelled";
}

/**
 * Validate a create-payment-session request. All amounts in halalas.
 * The caller provides:
 *  - booking: the booking object read from the workspace document (or null);
 *  - requestedAmountHalalas: null/undefined = "the full remaining amount";
 *  - netPaidHalalas: from the ledger;
 *  - hasActivePendingOrder: an unexpired pending order already exists;
 *  - allowPartial: server-side configuration flag.
 * Returns { ok:true, amountHalalas, totalHalalas, remainingHalalas } or
 * { ok:false, error }.
 */
export function validateCreateSession({
  booking,
  requestedAmountHalalas,
  netPaidHalalas,
  hasActivePendingOrder,
  allowPartial,
}) {
  if (!booking) return { ok: false, error: "BOOKING_NOT_FOUND" };
  if (bookingIsDeleted(booking)) return { ok: false, error: "BOOKING_DELETED" };
  if (bookingIsCancelled(booking)) return { ok: false, error: "BOOKING_CANCELLED" };

  const conv = riyalsNumberToHalalas(Number(booking.total));
  if (!conv.ok) return { ok: false, error: "BOOKING_TOTAL_INVALID" };
  const totalHalalas = conv.halalas;
  if (totalHalalas <= 0) return { ok: false, error: "BOOKING_TOTAL_NOT_PAYABLE" };

  const net = Number(netPaidHalalas) || 0;
  const remaining = Math.max(0, totalHalalas - net);
  if (remaining <= 0) return { ok: false, error: "NOTHING_REMAINING" };

  if (hasActivePendingOrder) return { ok: false, error: "ACTIVE_ORDER_EXISTS" };

  let amount = remaining;
  if (requestedAmountHalalas !== null && requestedAmountHalalas !== undefined) {
    if (!Number.isSafeInteger(requestedAmountHalalas) || requestedAmountHalalas <= 0) {
      return { ok: false, error: "AMOUNT_MUST_BE_POSITIVE" };
    }
    if (requestedAmountHalalas > remaining) {
      return { ok: false, error: "AMOUNT_EXCEEDS_REMAINING" };
    }
    if (requestedAmountHalalas < remaining && !allowPartial) {
      return { ok: false, error: "PARTIAL_NOT_ALLOWED" };
    }
    amount = requestedAmountHalalas;
  }

  return { ok: true, amountHalalas: amount, totalHalalas, remainingHalalas: remaining };
}

/**
 * Validate a manual payment (cash / bank transfer / POS / worker).
 * Mirrors the SQL RPC record_manual_payment's rules; amounts in halalas.
 */
export function validateManualPayment({
  booking,
  amountHalalas,
  paymentMethod,
  reason,
  netPaidHalalas,
  allowOverCollection = false,
}) {
  if (!Number.isSafeInteger(amountHalalas) || amountHalalas <= 0) {
    return { ok: false, error: "AMOUNT_MUST_BE_POSITIVE" };
  }
  if (!["cash", "bank_transfer", "pos", "worker", "other"].includes(paymentMethod)) {
    return { ok: false, error: "INVALID_PAYMENT_METHOD" };
  }
  if (paymentMethod === "bank_transfer" && !String(reason || "").trim()) {
    return { ok: false, error: "REFERENCE_REQUIRED_FOR_BANK_TRANSFER" };
  }
  if (!booking) return { ok: false, error: "BOOKING_NOT_FOUND" };
  if (bookingIsDeleted(booking)) return { ok: false, error: "BOOKING_DELETED" };
  if (bookingIsCancelled(booking)) return { ok: false, error: "BOOKING_CANCELLED" };
  const conv = riyalsNumberToHalalas(Number(booking.total));
  if (!conv.ok) return { ok: false, error: "BOOKING_TOTAL_INVALID" };
  const remaining = Math.max(0, conv.halalas - (Number(netPaidHalalas) || 0));
  if (amountHalalas > remaining && !allowOverCollection) {
    return { ok: false, error: "AMOUNT_EXCEEDS_REMAINING", remainingHalalas: remaining };
  }
  return { ok: true, remainingHalalas: remaining, overCollection: amountHalalas > remaining };
}

// ---------------------------------------------------------------------------
// Webhook event application — pure decision function.
// The Edge Function shell executes the returned actions inside one DB
// transaction. Replays, retries, and out-of-order deliveries are resolved
// HERE so the behavior is unit-testable without a database.
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  "payment_succeeded",
  "payment_failed",
  "order_expired",
  "refund_succeeded",
  "order_cancelled",
]);

/**
 * @param event  normalized provider event:
 *   { providerEventId, eventType, providerTransactionId, providerOrderId,
 *     amountHalalas, occurredAt }
 * @param order  the payment_orders row matched by providerOrderId (or null)
 * @param existingTransaction  ledger row already recorded for this
 *   provider transaction id (or null) — the duplicate/out-of-order anchor
 * @returns { actions: Action[] } where Action is one of
 *   { type: "skip_duplicate", reason }
 *   { type: "insert_transaction", transaction: {...} }
 *   { type: "update_order_status", orderId, from, to }
 *   { type: "flag_for_review", code, detail }
 *   { type: "reject", error }
 */
export function applyWebhookEvent({ event, order, existingTransaction }) {
  const actions = [];
  const et = event?.eventType;

  if (!WEBHOOK_EVENT_TYPES.includes(et)) {
    return { actions: [{ type: "reject", error: "UNSUPPORTED_EVENT_TYPE" }] };
  }
  if (!order && et !== "refund_succeeded") {
    // Refunds may reference the original transaction rather than an order.
    return { actions: [{ type: "reject", error: "ORDER_NOT_FOUND" }] };
  }

  const amount = Number(event.amountHalalas);

  switch (et) {
    case "payment_succeeded": {
      if (!event.providerTransactionId) {
        return { actions: [{ type: "reject", error: "MISSING_PROVIDER_TRANSACTION_ID" }] };
      }
      if (existingTransaction) {
        // Provider retry / duplicate delivery: the money is already recorded.
        return { actions: [{ type: "skip_duplicate", reason: "TRANSACTION_ALREADY_RECORDED" }] };
      }
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return { actions: [{ type: "reject", error: "INVALID_AMOUNT" }] };
      }
      actions.push({
        type: "insert_transaction",
        transaction: {
          payment_order_id: order.id,
          workspace_key: order.workspace_key,
          booking_id: order.booking_id,
          transaction_type: "payment",
          payment_method: "provider",
          direction: "in",
          amount_halalas: amount,
          provider: order.provider,
          provider_transaction_id: event.providerTransactionId,
          status: "succeeded",
          occurred_at: event.occurredAt,
          idempotency_key: `wh:${order.provider}:${event.providerTransactionId}`,
          metadata: amount !== order.amount_halalas
            ? { amount_mismatch: true, order_amount_halalas: order.amount_halalas }
            : {},
        },
      });
      if (order.status === "pending" || order.status === "partially_paid") {
        actions.push({
          type: "update_order_status",
          orderId: order.id,
          from: order.status,
          to: amount >= order.amount_halalas ? "paid" : "partially_paid",
        });
      } else {
        // Out-of-order: money arrived after expiry/cancellation. Record the
        // truth (the transaction above) but never rewrite a terminal order.
        actions.push({
          type: "flag_for_review",
          code: "LATE_SETTLEMENT_ON_TERMINAL_ORDER",
          detail: `order ${order.id} status=${order.status}`,
        });
      }
      if (amount !== order.amount_halalas) {
        actions.push({
          type: "flag_for_review",
          code: "AMOUNT_MISMATCH",
          detail: `event=${amount} order=${order.amount_halalas}`,
        });
      }
      break;
    }

    case "payment_failed": {
      if (existingTransaction && existingTransaction.status === "succeeded") {
        // Out-of-order failure after recorded success: never un-pay.
        actions.push({
          type: "flag_for_review",
          code: "FAILURE_AFTER_SUCCESS",
          detail: `provider_txn=${event.providerTransactionId}`,
        });
        break;
      }
      if (order.status === "pending") {
        actions.push({ type: "update_order_status", orderId: order.id, from: "pending", to: "failed" });
      } else {
        actions.push({ type: "skip_duplicate", reason: `ORDER_ALREADY_${String(order.status).toUpperCase()}` });
      }
      break;
    }

    case "order_expired": {
      if (order.status === "pending") {
        actions.push({ type: "update_order_status", orderId: order.id, from: "pending", to: "expired" });
      } else if (order.status === "paid" || order.status === "partially_paid") {
        // Expiry arriving after payment settled: ignore, keep the money state.
        actions.push({ type: "skip_duplicate", reason: "EXPIRY_AFTER_SETTLEMENT" });
      } else {
        actions.push({ type: "skip_duplicate", reason: `ORDER_ALREADY_${String(order.status).toUpperCase()}` });
      }
      break;
    }

    case "order_cancelled": {
      if (order.status === "pending") {
        actions.push({ type: "update_order_status", orderId: order.id, from: "pending", to: "cancelled" });
      } else {
        actions.push({ type: "skip_duplicate", reason: `ORDER_ALREADY_${String(order.status).toUpperCase()}` });
      }
      break;
    }

    case "refund_succeeded": {
      if (!event.providerTransactionId) {
        return { actions: [{ type: "reject", error: "MISSING_PROVIDER_TRANSACTION_ID" }] };
      }
      if (existingTransaction) {
        return { actions: [{ type: "skip_duplicate", reason: "REFUND_ALREADY_RECORDED" }] };
      }
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return { actions: [{ type: "reject", error: "INVALID_AMOUNT" }] };
      }
      if (!order) {
        return { actions: [{ type: "reject", error: "REFUND_ORDER_NOT_FOUND" }] };
      }
      actions.push({
        type: "insert_transaction",
        transaction: {
          payment_order_id: order.id,
          workspace_key: order.workspace_key,
          booking_id: order.booking_id,
          transaction_type: "refund",
          payment_method: "provider",
          direction: "out",
          amount_halalas: amount,
          provider: order.provider,
          provider_transaction_id: event.providerTransactionId,
          status: "succeeded",
          occurred_at: event.occurredAt,
          idempotency_key: `wh:${order.provider}:${event.providerTransactionId}`,
          metadata: {},
        },
      });
      break;
    }
  }

  return { actions };
}
