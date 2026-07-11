// test-adapter.mjs — TEST-ONLY payment provider adapter.
//
// ⚠️ THIS ADAPTER NEVER MOVES REAL MONEY. It exists so the payment
// foundation can be exercised end-to-end in unit tests and in a staging
// project without any real provider account. Its payment URLs use the
// RFC 2606 reserved TLD `.invalid`, which cannot resolve in any browser.
//
// It cannot be enabled by accident:
//   - providers/index.mjs refuses provider="test" unless
//     PAYMENTS_ALLOW_TEST_PROVIDER === "true" AND the runtime is not
//     marked production (DENO_ENV / NODE_ENV !== "production").
//
// Real payments are NOT operational anywhere in this repository. A real
// adapter (Moyasar / Tap / HyperPay / …) must implement the same five
// methods and be verified against the provider's sandbox first.

import { createHmac, randomUUID } from "node:crypto";

const SIGNATURE_HEADER = "x-test-signature";

export class TestProviderAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.webhookSecret HMAC secret for signing/verifying
   *   fake webhook payloads (tests generate their own throwaway value —
   *   never a real provider secret).
   * @param {number} [opts.sessionTtlMs] payment-link lifetime.
   */
  constructor({ webhookSecret, sessionTtlMs = 30 * 60 * 1000 } = {}) {
    if (!webhookSecret) throw new Error("TestProviderAdapter requires a webhookSecret");
    this.name = "test";
    this.webhookSecret = webhookSecret;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map(); // providerOrderId -> session
    this.refunds = new Map();
  }

  /** createPaymentSession(order) -> { providerOrderId, paymentUrl, expiresAt } */
  async createPaymentSession(order) {
    if (!order || !Number.isSafeInteger(order.amountHalalas) || order.amountHalalas <= 0) {
      throw new Error("TEST_ADAPTER_INVALID_AMOUNT");
    }
    if (order.currency !== "SAR") throw new Error("TEST_ADAPTER_UNSUPPORTED_CURRENCY");
    const providerOrderId = `test_ord_${randomUUID()}`;
    const session = {
      providerOrderId,
      amountHalalas: order.amountHalalas,
      currency: order.currency,
      status: "pending",
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
    };
    this.sessions.set(providerOrderId, session);
    return {
      providerOrderId,
      // Reserved TLD: guaranteed non-resolvable. A user clicking this link
      // in a misconfigured environment reaches nothing.
      paymentUrl: `https://pay.test.invalid/checkout/${providerOrderId}`,
      expiresAt: session.expiresAt,
    };
  }

  /** verifyWebhookSignature(rawBody, headers) -> boolean (constant-time) */
  verifyWebhookSignature(rawBody, headers) {
    const given = String(headers?.[SIGNATURE_HEADER] ?? headers?.get?.(SIGNATURE_HEADER) ?? "");
    const expected = this.signPayload(rawBody);
    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  /** parseWebhookEvent(rawBody) -> normalized event (throws on garbage) */
  parseWebhookEvent(rawBody) {
    const p = JSON.parse(String(rawBody));
    if (!p || typeof p !== "object" || !p.id || !p.type) {
      throw new Error("TEST_ADAPTER_MALFORMED_EVENT");
    }
    return {
      providerEventId: String(p.id),
      eventType: String(p.type),
      providerTransactionId: p.transaction_id ? String(p.transaction_id) : null,
      providerOrderId: p.order_id ? String(p.order_id) : null,
      amountHalalas: p.amount_halalas === undefined ? null : Number(p.amount_halalas),
      occurredAt: p.occurred_at ? String(p.occurred_at) : new Date().toISOString(),
    };
  }

  /** getPaymentStatus(providerOrderId) -> normalized status */
  async getPaymentStatus(providerOrderId) {
    const s = this.sessions.get(providerOrderId);
    return s ? s.status : "unknown";
  }

  /** refundPayment(providerTransactionId, amountHalalas) -> { providerRefundId } */
  async refundPayment(providerTransactionId, amountHalalas) {
    if (!Number.isSafeInteger(amountHalalas) || amountHalalas <= 0) {
      throw new Error("TEST_ADAPTER_INVALID_REFUND_AMOUNT");
    }
    const providerRefundId = `test_ref_${randomUUID()}`;
    this.refunds.set(providerRefundId, { providerTransactionId, amountHalalas });
    return { providerRefundId };
  }

  // ---- test helpers (used only by the test suite) ----

  signPayload(rawBody) {
    return createHmac("sha256", this.webhookSecret).update(String(rawBody)).digest("hex");
  }

  /** Build a signed fake webhook delivery: { rawBody, headers }. */
  buildSignedEvent(event) {
    const rawBody = JSON.stringify(event);
    return { rawBody, headers: { [SIGNATURE_HEADER]: this.signPayload(rawBody) } };
  }

  static get signatureHeader() {
    return SIGNATURE_HEADER;
  }
}
