import { describe, expect, it } from "vitest";
import {
  validateCreateSession,
  validateManualPayment,
} from "../../supabase/functions/_shared/ledger-core.mjs";

const booking = { id: "b-1", total: 900, status: "confirmed", deleted_at: null };

describe("create-payment-session server-side validation", () => {
  const base = {
    booking,
    requestedAmountHalalas: null,
    netPaidHalalas: 0,
    hasActivePendingOrder: false,
    allowPartial: false,
  };

  it("defaults to the full remaining amount computed on the server", () => {
    const r = validateCreateSession(base);
    expect(r).toMatchObject({ ok: true, amountHalalas: 90000, remainingHalalas: 90000 });
  });

  it("8. rejects a cancelled booking", () => {
    const r = validateCreateSession({ ...base, booking: { ...booking, status: "cancelled" } });
    expect(r).toEqual({ ok: false, error: "BOOKING_CANCELLED" });
  });

  it("9. rejects a deleted booking", () => {
    const r = validateCreateSession({ ...base, booking: { ...booking, deleted_at: "2026-01-01T00:00:00Z" } });
    expect(r).toEqual({ ok: false, error: "BOOKING_DELETED" });
  });

  it("9b. rejects a missing booking", () => {
    expect(validateCreateSession({ ...base, booking: null })).toEqual({ ok: false, error: "BOOKING_NOT_FOUND" });
  });

  it("10. rejects amounts above the remaining balance", () => {
    const r = validateCreateSession({ ...base, netPaidHalalas: 60000, requestedAmountHalalas: 40000 });
    expect(r).toEqual({ ok: false, error: "AMOUNT_EXCEEDS_REMAINING" });
  });

  it("computes remaining from the ledger, not from the browser", () => {
    const r = validateCreateSession({ ...base, netPaidHalalas: 60000 });
    expect(r).toMatchObject({ ok: true, amountHalalas: 30000 });
  });

  it("rejects partial amounts unless partial payments are configured", () => {
    const r = validateCreateSession({ ...base, requestedAmountHalalas: 10000 });
    expect(r).toEqual({ ok: false, error: "PARTIAL_NOT_ALLOWED" });
    const ok = validateCreateSession({ ...base, requestedAmountHalalas: 10000, allowPartial: true });
    expect(ok).toMatchObject({ ok: true, amountHalalas: 10000 });
  });

  it("rejects when nothing remains to pay", () => {
    const r = validateCreateSession({ ...base, netPaidHalalas: 90000 });
    expect(r).toEqual({ ok: false, error: "NOTHING_REMAINING" });
  });

  it("refuses a second active payment link for the same booking", () => {
    const r = validateCreateSession({ ...base, hasActivePendingOrder: true });
    expect(r).toEqual({ ok: false, error: "ACTIVE_ORDER_EXISTS" });
  });

  it("rejects zero/negative/fractional requested amounts", () => {
    expect(validateCreateSession({ ...base, requestedAmountHalalas: 0 }).error).toBe("AMOUNT_MUST_BE_POSITIVE");
    expect(validateCreateSession({ ...base, requestedAmountHalalas: -5 }).error).toBe("AMOUNT_MUST_BE_POSITIVE");
    expect(validateCreateSession({ ...base, requestedAmountHalalas: 10.5 }).error).toBe("AMOUNT_MUST_BE_POSITIVE");
  });

  it("rejects bookings whose stored total has sub-halala precision", () => {
    const r = validateCreateSession({ ...base, booking: { ...booking, total: 12.345 } });
    expect(r).toEqual({ ok: false, error: "BOOKING_TOTAL_INVALID" });
  });
});

describe("4. manual payment validation (cash / bank transfer / POS / worker)", () => {
  const base = { booking, amountHalalas: 20000, paymentMethod: "cash", reason: "", netPaidHalalas: 0 };

  it("accepts a normal cash payment below remaining", () => {
    expect(validateManualPayment(base)).toMatchObject({ ok: true, remainingHalalas: 90000 });
  });

  it("requires a reference for bank transfers", () => {
    expect(validateManualPayment({ ...base, paymentMethod: "bank_transfer" }).error)
      .toBe("REFERENCE_REQUIRED_FOR_BANK_TRANSFER");
    expect(validateManualPayment({ ...base, paymentMethod: "bank_transfer", reason: "حوالة 123" }).ok)
      .toBe(true);
  });

  it("prevents negative and zero amounts", () => {
    expect(validateManualPayment({ ...base, amountHalalas: 0 }).error).toBe("AMOUNT_MUST_BE_POSITIVE");
    expect(validateManualPayment({ ...base, amountHalalas: -100 }).error).toBe("AMOUNT_MUST_BE_POSITIVE");
  });

  it("prevents overpayment unless explicitly allowed (audited policy)", () => {
    const over = { ...base, amountHalalas: 95000 };
    expect(validateManualPayment(over).error).toBe("AMOUNT_EXCEEDS_REMAINING");
    const allowed = validateManualPayment({ ...over, allowOverCollection: true });
    expect(allowed).toMatchObject({ ok: true, overCollection: true });
  });

  it("rejects cancelled and deleted bookings", () => {
    expect(validateManualPayment({ ...base, booking: { ...booking, status: "cancelled" } }).error)
      .toBe("BOOKING_CANCELLED");
    expect(validateManualPayment({ ...base, booking: { ...booking, deleted_at: "2026-01-01" } }).error)
      .toBe("BOOKING_DELETED");
  });

  it("rejects unknown payment methods", () => {
    expect(validateManualPayment({ ...base, paymentMethod: "crypto" }).error).toBe("INVALID_PAYMENT_METHOD");
  });
});
