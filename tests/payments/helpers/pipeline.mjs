// Test pipeline that drives the pure ledger-core decision logic against the
// in-memory LedgerStore exactly the way the Edge Function shells do against
// Postgres: create-session validation -> order insert -> webhook event
// recording -> action execution -> derived state from the ledger.

import {
  applyWebhookEvent,
  computeBookingPaymentTotals,
  derivePaymentState,
  riyalsNumberToHalalas,
  validateCreateSession,
} from "../../../supabase/functions/_shared/ledger-core.mjs";

export function createSession(store, adapter, { workspaceKey, booking, bookingId, requestedAmountHalalas = null, idempotencyKey, allowPartial = false }) {
  // Idempotency: same key returns the existing order without a new provider session.
  for (const o of store.orders.values()) {
    if (o.idempotency_key === idempotencyKey) return { ok: true, duplicate: true, order: o };
  }
  const totals = computeBookingPaymentTotals(store.transactionsFor(workspaceKey, bookingId));
  const v = validateCreateSession({
    booking,
    requestedAmountHalalas,
    netPaidHalalas: totals.netPaidHalalas,
    hasActivePendingOrder: store.hasActivePendingOrder(workspaceKey, bookingId),
    allowPartial,
  });
  if (!v.ok) return v;
  return adapter.createPaymentSession({ amountHalalas: v.amountHalalas, currency: "SAR" }).then((session) => {
    try {
      const order = store.insertOrder({
        workspace_key: workspaceKey,
        booking_id: bookingId,
        provider: adapter.name,
        provider_order_id: session.providerOrderId,
        amount_halalas: v.amountHalalas,
        currency: "SAR",
        status: "pending",
        payment_url: session.paymentUrl,
        expires_at: session.expiresAt,
        idempotency_key: idempotencyKey,
      });
      return { ok: true, order };
    } catch (e) {
      if (e.code === "23505" && e.existing) return { ok: true, duplicate: true, order: e.existing };
      return { ok: false, error: "ORDER_CONFLICT" };
    }
  });
}

/**
 * Deliver a signed webhook payload through the same steps as the Edge
 * Function: verify signature -> record raw event (dedupe) -> decide via
 * applyWebhookEvent -> execute actions against the store.
 */
export function deliverWebhook(store, adapter, rawBody, headers) {
  if (!adapter.verifyWebhookSignature(rawBody, headers)) {
    return { status: 401, ok: false, error: "INVALID_SIGNATURE" };
  }
  const event = adapter.parseWebhookEvent(rawBody);

  let eventRow;
  try {
    eventRow = store.insertWebhookEvent({
      provider: adapter.name,
      provider_event_id: event.providerEventId,
      event_type: event.eventType,
      payload: JSON.parse(rawBody),
      signature_valid: true,
    });
  } catch (e) {
    if (e.code === "23505") return { status: 200, ok: true, duplicate: true };
    throw e;
  }

  const order = event.providerOrderId
    ? store.findOrderByProviderRef(adapter.name, event.providerOrderId)
    : null;
  const existingTransaction = event.providerTransactionId
    ? store.findTransactionByProviderRef(adapter.name, event.providerTransactionId)
    : null;

  const { actions } = applyWebhookEvent({ event, order, existingTransaction });

  let processingStatus = "processed";
  let errorMessage = null;
  for (const action of actions) {
    if (action.type === "reject") {
      processingStatus = "failed";
      errorMessage = action.error;
      break;
    }
    if (action.type === "skip_duplicate") {
      processingStatus = "skipped_duplicate";
      continue;
    }
    if (action.type === "insert_transaction") {
      try {
        store.insertTransaction(action.transaction);
      } catch (e) {
        if (e.code === "23505") processingStatus = "skipped_duplicate";
        else throw e;
      }
      continue;
    }
    if (action.type === "update_order_status") {
      store.updateOrderStatus(action.orderId, action.from, action.to);
      continue;
    }
    if (action.type === "flag_for_review") {
      store.flagForReview({ code: action.code, detail: action.detail });
      continue;
    }
  }

  eventRow.processing_status = processingStatus;
  eventRow.error_message = errorMessage;
  return { status: 200, ok: processingStatus !== "failed", processingStatus, actions };
}

/** Derived state for a booking, exactly as reconcile/get would compute it. */
export function bookingPaymentState(store, workspaceKey, bookingId, booking) {
  const totals = computeBookingPaymentTotals(store.transactionsFor(workspaceKey, bookingId));
  const conv = riyalsNumberToHalalas(Number(booking.total));
  const orders = [...store.orders.values()]
    .filter((o) => o.workspace_key === workspaceKey && o.booking_id === bookingId);
  const hasPendingOrder = orders.some(
    (o) => o.status === "pending" && (!o.expires_at || new Date(o.expires_at) > new Date()),
  );
  const last = orders[orders.length - 1];
  return {
    ...totals,
    state: derivePaymentState({
      totalHalalas: conv.ok ? conv.halalas : 0,
      grossPaidHalalas: totals.grossPaidHalalas,
      refundedHalalas: totals.refundedHalalas,
      netPaidHalalas: totals.netPaidHalalas,
      hasPendingOrder,
      lastOrderStatus: last ? last.status : null,
    }),
  };
}
