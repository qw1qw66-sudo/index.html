import { beforeEach, describe, expect, it } from "vitest";
import { TestProviderAdapter } from "../../supabase/functions/_shared/providers/test-adapter.mjs";
import { LedgerStore } from "./helpers/ledger-store.mjs";
import { bookingPaymentState, createSession, deliverWebhook } from "./helpers/pipeline.mjs";

const WS = "TESTWS";
const BOOKING_ID = "9d454757-97ac-435c-9ed0-000000000001";
const booking = {
  id: BOOKING_ID,
  total: 900, // 90000 halalas
  status: "confirmed",
  deleted_at: null,
};

let store;
let adapter;

beforeEach(() => {
  store = new LedgerStore();
  adapter = new TestProviderAdapter({ webhookSecret: "unit-test-secret" });
});

async function makeOrder(opts = {}) {
  const r = await createSession(store, adapter, {
    workspaceKey: WS,
    booking,
    bookingId: BOOKING_ID,
    idempotencyKey: opts.idempotencyKey || "idem-1",
    requestedAmountHalalas: opts.requestedAmountHalalas ?? null,
    allowPartial: opts.allowPartial ?? false,
  });
  expect(r.ok).toBe(true);
  return r.order;
}

function signedEvent(event) {
  return adapter.buildSignedEvent(event);
}

describe("payment pipeline (create session + webhooks against DB-constraint store)", () => {
  it("1. full payment: succeeded webhook settles order and state becomes paid", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id,
      transaction_id: "ptx-1", amount_halalas: 90000,
    });
    const res = deliverWebhook(store, adapter, rawBody, headers);
    expect(res.processingStatus).toBe("processed");
    expect(store.orders.get(order.id).status).toBe("paid");
    const s = bookingPaymentState(store, WS, BOOKING_ID, booking);
    expect(s.netPaidHalalas).toBe(90000);
    expect(s.state).toBe("paid");
  });

  it("2. partial payment: state becomes partially_paid", async () => {
    const order = await makeOrder({ requestedAmountHalalas: 30000, allowPartial: true });
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id,
      transaction_id: "ptx-1", amount_halalas: 30000,
    });
    deliverWebhook(store, adapter, rawBody, headers);
    const s = bookingPaymentState(store, WS, BOOKING_ID, booking);
    expect(s.netPaidHalalas).toBe(30000);
    expect(s.state).toBe("partially_paid");
  });

  it("3. multiple partial payments complete the booking", async () => {
    const o1 = await makeOrder({ idempotencyKey: "i-1", requestedAmountHalalas: 40000, allowPartial: true });
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: o1.provider_order_id, transaction_id: "ptx-1", amount_halalas: 40000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);

    const o2 = await makeOrder({ idempotencyKey: "i-2", requestedAmountHalalas: 50000, allowPartial: true });
    e = signedEvent({ id: "evt-2", type: "payment_succeeded", order_id: o2.provider_order_id, transaction_id: "ptx-2", amount_halalas: 50000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);

    const s = bookingPaymentState(store, WS, BOOKING_ID, booking);
    expect(s.netPaidHalalas).toBe(90000);
    expect(s.state).toBe("paid");
  });

  it("5. duplicate payment-session request returns the same order (idempotency)", async () => {
    const o1 = await makeOrder({ idempotencyKey: "same-key" });
    const r2 = await createSession(store, adapter, {
      workspaceKey: WS, booking, bookingId: BOOKING_ID, idempotencyKey: "same-key",
    });
    expect(r2.ok).toBe(true);
    expect(r2.duplicate).toBe(true);
    expect(r2.order.id).toBe(o1.id);
    expect(store.orders.size).toBe(1);
  });

  it("5b. second session for the same booking while one is active is refused", async () => {
    await makeOrder({ idempotencyKey: "i-1" });
    const r2 = await createSession(store, adapter, {
      workspaceKey: WS, booking, bookingId: BOOKING_ID, idempotencyKey: "i-2",
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("ACTIVE_ORDER_EXISTS");
  });

  it("6. duplicate webhook delivery is acknowledged and not reprocessed", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id,
      transaction_id: "ptx-1", amount_halalas: 90000,
    });
    deliverWebhook(store, adapter, rawBody, headers);
    const res2 = deliverWebhook(store, adapter, rawBody, headers);
    expect(res2.status).toBe(200);
    expect(res2.duplicate).toBe(true);
    // exactly one ledger row — the same payment was NOT recorded twice
    expect(store.transactionsFor(WS, BOOKING_ID)).toHaveLength(1);
  });

  it("6b. same provider transaction under a different event id is still recorded once", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    const res = deliverWebhook(store, adapter, e.rawBody, e.headers);
    expect(res.processingStatus).toBe("skipped_duplicate");
    expect(store.transactionsFor(WS, BOOKING_ID)).toHaveLength(1);
  });

  it("7. out-of-order: failure arriving after success never un-pays", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "payment_failed", order_id: order.provider_order_id, transaction_id: "ptx-1" });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    expect(store.orders.get(order.id).status).toBe("paid");
    expect(bookingPaymentState(store, WS, BOOKING_ID, booking).state).toBe("paid");
    expect(store.reviewFlags.some((f) => f.code === "FAILURE_AFTER_SUCCESS")).toBe(true);
  });

  it("7b. out-of-order: expiry arriving after settlement is ignored", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "order_expired", order_id: order.provider_order_id });
    const res = deliverWebhook(store, adapter, e.rawBody, e.headers);
    expect(res.processingStatus).toBe("skipped_duplicate");
    expect(store.orders.get(order.id).status).toBe("paid");
  });

  it("7c. late settlement after expiry records the money and flags for review", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "order_expired", order_id: order.provider_order_id });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    expect(store.orders.get(order.id).status).toBe("expired");
    e = signedEvent({ id: "evt-2", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    // money recorded (ledger is truth), order stays terminal, review flagged
    expect(store.transactionsFor(WS, BOOKING_ID)).toHaveLength(1);
    expect(store.orders.get(order.id).status).toBe("expired");
    expect(store.reviewFlags.some((f) => f.code === "LATE_SETTLEMENT_ON_TERMINAL_ORDER")).toBe(true);
  });

  it("11. failed payment: order fails, state derives failed", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_failed", order_id: order.provider_order_id, transaction_id: "ptx-1",
    });
    deliverWebhook(store, adapter, rawBody, headers);
    expect(store.orders.get(order.id).status).toBe("failed");
    expect(bookingPaymentState(store, WS, BOOKING_ID, booking).state).toBe("failed");
  });

  it("12. expired order: state derives expired", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "order_expired", order_id: order.provider_order_id,
    });
    deliverWebhook(store, adapter, rawBody, headers);
    expect(store.orders.get(order.id).status).toBe("expired");
    expect(bookingPaymentState(store, WS, BOOKING_ID, booking).state).toBe("expired");
  });

  it("13. partial refund: state becomes partially_refunded", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "refund_succeeded", order_id: order.provider_order_id, transaction_id: "ref-1", amount_halalas: 20000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    const s = bookingPaymentState(store, WS, BOOKING_ID, booking);
    expect(s.refundedHalalas).toBe(20000);
    expect(s.netPaidHalalas).toBe(70000);
    expect(s.state).toBe("partially_refunded");
  });

  it("14. full refund: state becomes refunded", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "refund_succeeded", order_id: order.provider_order_id, transaction_id: "ref-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    const s = bookingPaymentState(store, WS, BOOKING_ID, booking);
    expect(s.netPaidHalalas).toBe(0);
    expect(s.state).toBe("refunded");
  });

  it("14b. duplicate refund webhook records the refund exactly once", async () => {
    const order = await makeOrder();
    let e = signedEvent({ id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id, transaction_id: "ptx-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    e = signedEvent({ id: "evt-2", type: "refund_succeeded", order_id: order.provider_order_id, transaction_id: "ref-1", amount_halalas: 90000 });
    deliverWebhook(store, adapter, e.rawBody, e.headers);
    const eDup = signedEvent({ id: "evt-3", type: "refund_succeeded", order_id: order.provider_order_id, transaction_id: "ref-1", amount_halalas: 90000 });
    const res = deliverWebhook(store, adapter, eDup.rawBody, eDup.headers);
    expect(res.processingStatus).toBe("skipped_duplicate");
    expect(bookingPaymentState(store, WS, BOOKING_ID, booking).refundedHalalas).toBe(90000);
  });

  it("rejects tampered payloads before anything is recorded", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id,
      transaction_id: "ptx-1", amount_halalas: 90000,
    });
    const tampered = rawBody.replace("90000", "1");
    const res = deliverWebhook(store, adapter, tampered, headers);
    expect(res.status).toBe(401);
    expect(store.webhookEvents.size).toBe(0);
    expect(store.transactionsFor(WS, BOOKING_ID)).toHaveLength(0);
  });

  it("amount mismatch between event and order is recorded and flagged", async () => {
    const order = await makeOrder();
    const { rawBody, headers } = signedEvent({
      id: "evt-1", type: "payment_succeeded", order_id: order.provider_order_id,
      transaction_id: "ptx-1", amount_halalas: 45000,
    });
    deliverWebhook(store, adapter, rawBody, headers);
    expect(bookingPaymentState(store, WS, BOOKING_ID, booking).netPaidHalalas).toBe(45000);
    expect(store.orders.get(order.id).status).toBe("partially_paid");
    expect(store.reviewFlags.some((f) => f.code === "AMOUNT_MISMATCH")).toBe(true);
  });
});
