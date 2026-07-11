// In-memory ledger store used by the payment pipeline tests. It enforces the
// same uniqueness/transition rules as supabase/migrations/20260701000002_payment_ledger.sql
// (which were separately verified against a real PostgreSQL 16 instance —
// see the audit and PR notes), so the pure decision logic can be exercised
// end-to-end without a database.

import { randomUUID } from "node:crypto";

export class LedgerStore {
  constructor() {
    this.orders = new Map(); // id -> order row
    this.transactions = new Map(); // id -> tx row
    this.webhookEvents = new Map(); // provider:eventId -> event row
    this.reviewFlags = [];
  }

  // ---- payment_orders ----

  insertOrder(row) {
    for (const o of this.orders.values()) {
      // Idempotency uniqueness is WORKSPACE-SCOPED (migration 0002 follow-up).
      if (o.workspace_key === row.workspace_key && o.idempotency_key === row.idempotency_key) {
        const err = new Error("unique_violation:idempotency_key");
        err.code = "23505";
        err.existing = o;
        throw err;
      }
      if (
        row.provider_order_id &&
        o.provider === row.provider &&
        o.provider_order_id === row.provider_order_id
      ) {
        const err = new Error("unique_violation:provider_order_id");
        err.code = "23505";
        throw err;
      }
      if (
        row.status === "pending" &&
        o.status === "pending" &&
        o.workspace_key === row.workspace_key &&
        o.booking_id === row.booking_id
      ) {
        const err = new Error("unique_violation:one_active_per_booking");
        err.code = "23505";
        throw err;
      }
    }
    if (!(row.amount_halalas > 0)) throw new Error("check_violation:amount_positive");
    if (row.currency !== "SAR") throw new Error("check_violation:currency");
    const order = { id: randomUUID(), status: "pending", currency: "SAR", ...row };
    this.orders.set(order.id, order);
    return order;
  }

  updateOrderStatus(orderId, from, to) {
    const o = this.orders.get(orderId);
    if (!o || o.status !== from) return false; // optimistic guard, like .eq("status", from)
    const allowed =
      (from === "pending" && ["paid", "partially_paid", "failed", "expired", "cancelled"].includes(to)) ||
      (from === "partially_paid" && ["paid", "expired", "cancelled"].includes(to));
    if (!allowed) throw new Error(`transition_forbidden:${from}->${to}`);
    o.status = to;
    return true;
  }

  findOrderByProviderRef(provider, providerOrderId) {
    for (const o of this.orders.values()) {
      if (o.provider === provider && o.provider_order_id === providerOrderId) return o;
    }
    return null;
  }

  // Workspace-scoped idempotency lookup (mirrors the composite unique index).
  findOrderByIdempotency(workspaceKey, key) {
    for (const o of this.orders.values()) {
      if (o.workspace_key === workspaceKey && o.idempotency_key === key) return o;
    }
    return null;
  }

  // Mirrors expire_stale_payment_orders(): transition pending+past-expiry rows
  // to 'expired' so an expired order cannot block a replacement.
  expireStale(workspaceKey, bookingId, nowMs = Date.now()) {
    let n = 0;
    for (const o of this.orders.values()) {
      if (
        o.workspace_key === workspaceKey &&
        o.booking_id === bookingId &&
        o.status === "pending" &&
        o.expires_at &&
        new Date(o.expires_at).getTime() <= nowMs
      ) {
        o.status = "expired";
        n++;
      }
    }
    return n;
  }

  hasActivePendingOrder(workspaceKey, bookingId) {
    for (const o of this.orders.values()) {
      if (
        o.workspace_key === workspaceKey &&
        o.booking_id === bookingId &&
        o.status === "pending"
      )
        return true;
    }
    return false;
  }

  // ---- payment_transactions (append-only) ----

  insertTransaction(row) {
    for (const t of this.transactions.values()) {
      if (
        row.idempotency_key &&
        t.workspace_key === row.workspace_key &&
        t.idempotency_key === row.idempotency_key
      ) {
        const err = new Error("unique_violation:tx_idempotency_key");
        err.code = "23505";
        err.existing = t;
        throw err;
      }
      if (
        row.provider_transaction_id &&
        t.provider === row.provider &&
        t.provider_transaction_id === row.provider_transaction_id
      ) {
        const err = new Error("unique_violation:provider_transaction_id");
        err.code = "23505";
        err.existing = t;
        throw err;
      }
    }
    if (!(row.amount_halalas >= 0)) throw new Error("check_violation:amount_non_negative");
    const tx = { id: randomUUID(), status: "succeeded", currency: "SAR", ...row };
    this.transactions.set(tx.id, tx);
    return tx;
  }

  findTransactionByProviderRef(provider, providerTransactionId) {
    for (const t of this.transactions.values()) {
      if (t.provider === provider && t.provider_transaction_id === providerTransactionId) return t;
    }
    return null;
  }

  transactionsFor(workspaceKey, bookingId) {
    return [...this.transactions.values()].filter(
      (t) => t.workspace_key === workspaceKey && t.booking_id === bookingId,
    );
  }

  // ---- payment_webhook_events ----

  insertWebhookEvent(row) {
    const key = `${row.provider}:${row.provider_event_id}`;
    if (this.webhookEvents.has(key)) {
      const err = new Error("unique_violation:webhook_event");
      err.code = "23505";
      throw err;
    }
    const evt = { id: randomUUID(), processing_status: "received", ...row };
    this.webhookEvents.set(key, evt);
    return evt;
  }

  flagForReview(flag) {
    this.reviewFlags.push(flag);
  }
}
