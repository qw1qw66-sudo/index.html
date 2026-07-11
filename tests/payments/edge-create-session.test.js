import { beforeEach, describe, expect, it } from "vitest";
import { handleCreatePaymentSession } from "../../supabase/functions/create-payment-session/handler.mjs";
import { createProviderAdapter } from "../../supabase/functions/_shared/providers/index.mjs";
import { computeBookingPaymentTotals } from "../../supabase/functions/_shared/ledger-core.mjs";
import { LedgerStore } from "./helpers/ledger-store.mjs";

// Executes the REAL create-payment-session handler in Node against real
// Request/Response objects and a fake deps layer backed by LedgerStore (whose
// constraints mirror migration 0002, separately verified on Postgres).
// Satisfies item 10 (Edge Function shell runtime-tested) minus a literal Deno
// run, which needs the Supabase local stack (documented as owner-side).

const TEST_ENV = {
  PAYMENT_PROVIDER: "test",
  APP_ENV: "test",
  PAYMENTS_ALLOW_TEST_PROVIDER: "true",
  PAYMENT_WEBHOOK_SECRET: "edge-test-secret",
};

const WS = "WSX";
const BOOKING = { id: "bk-1", total: 900, status: "confirmed", deleted_at: null };

function makeDeps(store, { env = TEST_ENV, workspaces = { [WS]: { pin: "123456", bookings: { "bk-1": BOOKING } } } } = {}) {
  return {
    env,
    createProviderAdapter,
    async auth(wsKey, pin) {
      const w = workspaces[wsKey];
      if (!w || w.pin !== pin) return { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
      return { ok: true, workspace_key: wsKey };
    },
    async findOrderByIdempotency(wsKey, key) {
      return store.findOrderByIdempotency(wsKey, key);
    },
    async expireStaleOrders(wsKey, bookingId) {
      store.expireStale(wsKey, bookingId);
    },
    async bookingFromWorkspace(wsKey, bookingId) {
      return workspaces[wsKey]?.bookings?.[bookingId] ?? null;
    },
    async netPaidHalalas(wsKey, bookingId) {
      return computeBookingPaymentTotals(store.transactionsFor(wsKey, bookingId)).netPaidHalalas;
    },
    async hasActivePendingOrder(wsKey, bookingId) {
      return store.hasActivePendingOrder(wsKey, bookingId);
    },
    async insertOrder(row) {
      return store.insertOrder(row);
    },
  };
}

function req(body, method = "POST") {
  return new Request("https://edge.local/create-payment-session", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let store;
beforeEach(() => {
  store = new LedgerStore();
});

describe("edge: create-payment-session handler (real runtime)", () => {
  it("valid request creates an order and returns only safe fields", async () => {
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-0001" }),
      makeDeps(store),
    );
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ok).toBe(true);
    expect(b.order).toMatchObject({ status: "pending", amount_halalas: 90000, currency: "SAR" });
    // No workspace_key / idempotency_key / provider secrets leak to the client.
    expect(b.order.workspace_key).toBeUndefined();
    expect(b.order.idempotency_key).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("edge-test-secret");
  });

  it("rejects invalid JSON", async () => {
    const bad = new Request("https://edge.local/x", { method: "POST", body: "{not json" });
    const res = await handleCreatePaymentSession(bad, makeDeps(store));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_JSON");
  });

  it("rejects non-POST", async () => {
    const res = await handleCreatePaymentSession(req(undefined, "GET"), makeDeps(store));
    expect(res.status).toBe(405);
  });

  it("rejects missing booking id and short idempotency key", async () => {
    let res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", idempotency_key: "idem-0001" }),
      makeDeps(store),
    );
    expect((await res.json()).error).toBe("MISSING_BOOKING_ID");
    res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "short" }),
      makeDeps(store),
    );
    expect((await res.json()).error).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("rejects wrong workspace PIN with 401", async () => {
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "wrong", booking_id: "bk-1", idempotency_key: "idem-0001" }),
      makeDeps(store),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("WORKSPACE_NOT_FOUND_OR_PIN_INVALID");
  });

  it("503 when no provider is configured (payment links disabled)", async () => {
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-0001" }),
      makeDeps(store, { env: {} }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("NO_PROVIDER_CONFIGURED");
  });

  it("test provider blocked when APP_ENV=production", async () => {
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-0001" }),
      makeDeps(store, { env: { ...TEST_ENV, APP_ENV: "production" } }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("TEST_PROVIDER_BLOCKED");
  });

  it("exact duplicate idempotency request returns the original order (no new provider session)", async () => {
    const d = makeDeps(store);
    const first = await (await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-dup" }), d,
    )).json();
    const second = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-dup" }), d,
    );
    const body = await second.json();
    expect(body.duplicate).toBe(true);
    expect(body.order.id).toBe(first.order.id);
    expect(store.orders.size).toBe(1);
  });

  it("same key + different booking => IDEMPOTENCY_KEY_REUSE_CONFLICT", async () => {
    const workspaces = { [WS]: { pin: "123456", bookings: {
      "bk-1": BOOKING, "bk-2": { id: "bk-2", total: 500, status: "confirmed", deleted_at: null },
    } } };
    const d = makeDeps(store, { workspaces });
    await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "reuse-key" }), d,
    );
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-2", idempotency_key: "reuse-key" }), d,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("IDEMPOTENCY_KEY_REUSE_CONFLICT");
  });

  it("same key + different explicit amount => IDEMPOTENCY_KEY_REUSE_CONFLICT", async () => {
    const d = makeDeps(store);
    await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", amount_halalas: 30000, idempotency_key: "amt-key-1" }),
      { ...d, env: { ...TEST_ENV, PAYMENTS_ALLOW_PARTIAL: "true" } },
    );
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", amount_halalas: 40000, idempotency_key: "amt-key-1" }),
      { ...d, env: { ...TEST_ENV, PAYMENTS_ALLOW_PARTIAL: "true" } },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("IDEMPOTENCY_KEY_REUSE_CONFLICT");
  });

  it("cross-workspace: workspace B cannot retrieve workspace A's order via a shared key", async () => {
    const workspaces = {
      WSA: { pin: "111111", bookings: { "bk-1": BOOKING } },
      WSB: { pin: "222222", bookings: { "bk-9": { id: "bk-9", total: 700, status: "confirmed", deleted_at: null } } },
    };
    const d = makeDeps(store, { workspaces });
    const aRes = await (await handleCreatePaymentSession(
      req({ workspace_key: "WSA", access_pin: "111111", booking_id: "bk-1", idempotency_key: "shared-idem" }), d,
    )).json();
    const bRes = await handleCreatePaymentSession(
      req({ workspace_key: "WSB", access_pin: "222222", booking_id: "bk-9", idempotency_key: "shared-idem" }), d,
    );
    const bBody = await bRes.json();
    // B gets its OWN new order, not A's; and not a reuse-conflict.
    expect(bBody.ok).toBe(true);
    expect(bBody.duplicate).toBeUndefined();
    expect(bBody.order.id).not.toBe(aRes.order.id);
    expect(store.orders.size).toBe(2);
  });

  it("expired pending order is replaced; a fresh link is issued", async () => {
    const d = makeDeps(store);
    // Seed an already-expired pending order for bk-1.
    store.insertOrder({
      workspace_key: WS, booking_id: "bk-1", provider: "test", provider_order_id: "test_old",
      amount_halalas: 90000, currency: "SAR", status: "pending",
      expires_at: new Date(Date.now() - 3600_000).toISOString(), idempotency_key: "old-key",
    });
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "new-key-01" }), d,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const pending = [...store.orders.values()].filter((o) => o.booking_id === "bk-1" && o.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotency_key).toBe("new-key-01");
  });

  it("a NON-expired pending order blocks a new link (ACTIVE_ORDER_EXISTS)", async () => {
    const d = makeDeps(store);
    store.insertOrder({
      workspace_key: WS, booking_id: "bk-1", provider: "test", provider_order_id: "test_live",
      amount_halalas: 90000, currency: "SAR", status: "pending",
      expires_at: new Date(Date.now() + 3600_000).toISOString(), idempotency_key: "live-key",
    });
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "another-key" }), d,
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("ACTIVE_ORDER_EXISTS");
  });

  it("rejects a cancelled booking (422 BOOKING_CANCELLED)", async () => {
    const workspaces = { [WS]: { pin: "123456", bookings: { "bk-1": { ...BOOKING, status: "cancelled" } } } };
    const res = await handleCreatePaymentSession(
      req({ workspace_key: WS, access_pin: "123456", booking_id: "bk-1", idempotency_key: "idem-cxl" }),
      makeDeps(store, { workspaces }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("BOOKING_CANCELLED");
  });
});
