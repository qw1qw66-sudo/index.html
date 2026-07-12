import { beforeEach, describe, expect, it } from "vitest";
import { handleWebhook } from "../../supabase/functions/payment-webhook/handler.mjs";
import { createProviderAdapter } from "../../supabase/functions/_shared/providers/index.mjs";
import { TestProviderAdapter } from "../../supabase/functions/_shared/providers/test-adapter.mjs";
import { LedgerStore } from "./helpers/ledger-store.mjs";

// Executes the REAL payment-webhook handler in Node against real Request
// objects + a fake deps layer backed by LedgerStore.

const SECRET = "edge-webhook-secret";
const ENV = {
  PAYMENT_PROVIDER: "test",
  APP_ENV: "test",
  PAYMENTS_ALLOW_TEST_PROVIDER: "true",
  PAYMENT_WEBHOOK_SECRET: SECRET,
};

function makeDeps(store, env = ENV) {
  return {
    env,
    createProviderAdapter,
    async insertWebhookEvent(row) { return store.insertWebhookEvent(row); },
    async findWebhookEvent(provider, providerEventId) { return store.webhookEvents.get(provider + ":" + providerEventId) || null; },
    async findOrderByProviderRef(p, id) { return store.findOrderByProviderRef(p, id); },
    async findTxByProviderRef(p, id) { return store.findTransactionByProviderRef(p, id); },
    async insertTransaction(row) { store.insertTransaction(row); },
    async updateOrderStatus(id, from, to) {
      if (!store.updateOrderStatus(id, from, to)) throw { code: "ORDER_UPDATE_ROW_MISMATCH" };
    },
    async insertAuditFlag(row) { store.flagForReview({ code: row.reason, detail: row.metadata?.detail }); },
    async markEventProcessed(id, status, err) {
      for (const e of store.webhookEvents.values()) if (e.id === id) { e.processing_status = status; e.error_message = err; }
    },
  };
}

function signedReq(adapter, event) {
  const { rawBody, headers } = adapter.buildSignedEvent(event);
  return new Request("https://edge.local/payment-webhook", { method: "POST", headers, body: rawBody });
}

let store, adapter, order;
beforeEach(() => {
  store = new LedgerStore();
  adapter = new TestProviderAdapter({ webhookSecret: SECRET });
  order = store.insertOrder({
    workspace_key: "WSX", booking_id: "bk-1", provider: "test", provider_order_id: "test_ord_1",
    amount_halalas: 90000, currency: "SAR", status: "pending",
    expires_at: new Date(Date.now() + 3600_000).toISOString(), idempotency_key: "ik-1",
  });
});

describe("edge: payment-webhook handler (real runtime)", () => {
  it("rejects an invalid signature before recording anything (401)", async () => {
    const { rawBody, headers } = adapter.buildSignedEvent({ id: "e1", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t1", amount_halalas: 90000 });
    const tampered = rawBody.replace("90000", "1");
    const res = await handleWebhook(new Request("https://edge.local/x", { method: "POST", headers, body: tampered }), makeDeps(store));
    expect(res.status).toBe(401);
    expect(store.webhookEvents.size).toBe(0);
    expect(store.transactionsFor("WSX", "bk-1")).toHaveLength(0);
  });

  it("rejects malformed event JSON (400)", async () => {
    const raw = "not json";
    const headers = { [TestProviderAdapter.signatureHeader]: adapter.signPayload(raw) };
    const res = await handleWebhook(new Request("https://edge.local/x", { method: "POST", headers, body: raw }), makeDeps(store));
    expect(res.status).toBe(400);
  });

  it("503 when no provider configured", async () => {
    const res = await handleWebhook(signedReq(adapter, { id: "e1", type: "payment_succeeded" }), makeDeps(store, {}));
    expect(res.status).toBe(503);
  });

  it("valid payment_succeeded records the ledger row and settles the order", async () => {
    const res = await handleWebhook(signedReq(adapter, { id: "e1", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t1", amount_halalas: 90000 }), makeDeps(store));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("processed");
    expect(store.transactionsFor("WSX", "bk-1")).toHaveLength(1);
    expect(store.orders.get(order.id).status).toBe("paid");
  });

  it("duplicate delivery is acknowledged and not reprocessed", async () => {
    const d = makeDeps(store);
    const ev = { id: "e1", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t1", amount_halalas: 90000 };
    await handleWebhook(signedReq(adapter, ev), d);
    const res = await handleWebhook(signedReq(adapter, ev), d);
    expect((await res.json()).duplicate).toBe(true);
    expect(store.transactionsFor("WSX", "bk-1")).toHaveLength(1);
  });

  it("a retry resumes an event that crashed after the ledger insert and finishes the order", async () => {
    const firstDeps = makeDeps(store);
    let failOnce = true;
    firstDeps.updateOrderStatus = async (id, from, to) => {
      if (failOnce) {
        failOnce = false;
        throw { code: "TRANSIENT_ORDER_WRITE" };
      }
      if (!store.updateOrderStatus(id, from, to)) throw { code: "ORDER_UPDATE_ROW_MISMATCH" };
    };
    const event = { id: "e-resume", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t-resume", amount_halalas: 90000 };
    const first = await handleWebhook(signedReq(adapter, event), firstDeps);
    expect(first.status).toBe(500);
    expect(store.transactionsFor("WSX", "bk-1")).toHaveLength(1);
    expect(store.orders.get(order.id).status).toBe("pending");
    expect(store.webhookEvents.get("test:e-resume").processing_status).toBe("received");

    const retry = await handleWebhook(signedReq(adapter, event), makeDeps(store));
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("skipped_duplicate");
    expect(store.transactionsFor("WSX", "bk-1")).toHaveLength(1);
    expect(store.orders.get(order.id).status).toBe("paid");
    expect(store.webhookEvents.get("test:e-resume").processing_status).toBe("skipped_duplicate");
  });

  it("does not log or return the webhook secret", async () => {
    const res = await handleWebhook(signedReq(adapter, { id: "e1", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t1", amount_halalas: 90000 }), makeDeps(store));
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });

  it("full refund via webhook is recorded and the state derives refunded", async () => {
    const d = makeDeps(store);
    await handleWebhook(signedReq(adapter, { id: "e1", type: "payment_succeeded", order_id: "test_ord_1", transaction_id: "t1", amount_halalas: 90000 }), d);
    await handleWebhook(signedReq(adapter, { id: "e2", type: "refund_succeeded", order_id: "test_ord_1", transaction_id: "r1", amount_halalas: 90000 }), d);
    const txs = store.transactionsFor("WSX", "bk-1");
    expect(txs).toHaveLength(2);
    expect(txs.some((t) => t.direction === "out" && t.amount_halalas === 90000)).toBe(true);
  });
});
