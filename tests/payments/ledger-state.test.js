import { describe, expect, it } from "vitest";
import {
  computeBookingPaymentTotals,
  derivePaymentState,
  parseRiyalsToHalalas,
  riyalsNumberToHalalas,
  halalasToRiyalsDisplay,
  effectiveNetPaidHalalas,
} from "../../supabase/functions/_shared/ledger-core.mjs";

const tx = (over) => ({
  transaction_type: "payment",
  direction: "in",
  amount_halalas: 0,
  status: "succeeded",
  ...over,
});

describe("ledger totals", () => {
  it("sums succeeded in/out rows and ignores pending/failed", () => {
    const t = computeBookingPaymentTotals([
      tx({ amount_halalas: 50000 }),
      tx({ amount_halalas: 25000, transaction_type: "manual_payment" }),
      tx({ amount_halalas: 10000, direction: "out", transaction_type: "refund" }),
      tx({ amount_halalas: 99999, status: "pending" }),
      tx({ amount_halalas: 88888, status: "failed" }),
    ]);
    expect(t).toEqual({
      grossPaidHalalas: 75000,
      refundedHalalas: 10000,
      netPaidHalalas: 65000,
      pendingTxCount: 1,
    });
  });

  it("legacy opening balances count as paid money", () => {
    const t = computeBookingPaymentTotals([
      tx({ amount_halalas: 30000, transaction_type: "legacy_opening_balance", payment_method: "other" }),
    ]);
    expect(t.netPaidHalalas).toBe(30000);
  });
});

describe("payment state derivation (documented rules, mirrors SQL)", () => {
  const base = {
    totalHalalas: 90000,
    grossPaidHalalas: 0,
    refundedHalalas: 0,
    netPaidHalalas: 0,
    hasPendingOrder: false,
    lastOrderStatus: null,
  };

  it("unpaid by default", () => {
    expect(derivePaymentState(base)).toBe("unpaid");
  });
  it("pending while an active order exists and nothing is paid", () => {
    expect(derivePaymentState({ ...base, hasPendingOrder: true })).toBe("pending");
  });
  it("partially_paid when 0 < net < total", () => {
    expect(derivePaymentState({ ...base, grossPaidHalalas: 30000, netPaidHalalas: 30000 })).toBe("partially_paid");
  });
  it("paid at exactly the total and above it (overpayment stays paid)", () => {
    expect(derivePaymentState({ ...base, grossPaidHalalas: 90000, netPaidHalalas: 90000 })).toBe("paid");
    expect(derivePaymentState({ ...base, grossPaidHalalas: 95000, netPaidHalalas: 95000 })).toBe("paid");
  });
  it("failed / expired only when nothing was collected", () => {
    expect(derivePaymentState({ ...base, lastOrderStatus: "failed" })).toBe("failed");
    expect(derivePaymentState({ ...base, lastOrderStatus: "expired" })).toBe("expired");
    expect(
      derivePaymentState({ ...base, grossPaidHalalas: 10000, netPaidHalalas: 10000, lastOrderStatus: "failed" }),
    ).toBe("partially_paid");
  });
  it("partially_refunded while net > 0, refunded when net returns to 0", () => {
    expect(
      derivePaymentState({ ...base, grossPaidHalalas: 90000, refundedHalalas: 20000, netPaidHalalas: 70000 }),
    ).toBe("partially_refunded");
    expect(
      derivePaymentState({ ...base, grossPaidHalalas: 90000, refundedHalalas: 90000, netPaidHalalas: 0 }),
    ).toBe("refunded");
  });
});

describe("integer halala money (no float money in the ledger)", () => {
  it("converts numeric riyals exactly (1,000 SAR = 100000 halalas)", () => {
    expect(riyalsNumberToHalalas(1000)).toEqual({ ok: true, halalas: 100000 });
    expect(riyalsNumberToHalalas(300.01)).toEqual({ ok: true, halalas: 30001 });
    expect(riyalsNumberToHalalas(0)).toEqual({ ok: true, halalas: 0 });
  });
  it("rejects sub-halala precision instead of rounding silently", () => {
    expect(riyalsNumberToHalalas(12.345).ok).toBe(false);
    expect(riyalsNumberToHalalas(12.345).error).toBe("SUB_HALALA_PRECISION");
  });
  it("rejects negatives, NaN and infinities", () => {
    expect(riyalsNumberToHalalas(-1).ok).toBe(false);
    expect(riyalsNumberToHalalas(NaN).ok).toBe(false);
    expect(riyalsNumberToHalalas(Infinity).ok).toBe(false);
  });
  it("parses human input with Arabic digits and Arabic decimal separator", () => {
    expect(parseRiyalsToHalalas("١٠٠٠")).toEqual({ ok: true, halalas: 100000 });
    expect(parseRiyalsToHalalas("۱۲۳۴")).toEqual({ ok: true, halalas: 123400 });
    expect(parseRiyalsToHalalas("١٢٫٥")).toEqual({ ok: true, halalas: 1250 });
    expect(parseRiyalsToHalalas("12.5")).toEqual({ ok: true, halalas: 1250 });
    expect(parseRiyalsToHalalas("1,234")).toEqual({ ok: true, halalas: 123400 });
  });
  it("treats ambiguous decimal-comma input as an error, never a 10x amount", () => {
    // "12,5" parsed as 125 riyals is the audit AUD-011 silent-corruption bug;
    // the ledger boundary refuses to guess.
    expect(parseRiyalsToHalalas("12,5").ok).toBe(false);
    expect(parseRiyalsToHalalas("12,5").error).toBe("AMBIGUOUS_SEPARATOR");
    expect(parseRiyalsToHalalas("12.345").ok).toBe(false);
    expect(parseRiyalsToHalalas("-5").ok).toBe(false);
    expect(parseRiyalsToHalalas("abc").ok).toBe(false);
    expect(parseRiyalsToHalalas("").ok).toBe(false);
  });
  it("renders halalas back to riyal display text", () => {
    expect(halalasToRiyalsDisplay(100000)).toBe("1000");
    expect(halalasToRiyalsDisplay(1250)).toBe("12.50");
    expect(halalasToRiyalsDisplay(-500)).toBe("-5");
  });
});

describe("effectiveNetPaidHalalas: reconcile the doc `paid` field with the ledger", () => {
  it("ledger empty (the live default) → uses the form-tracked paid riyals", () => {
    // 300 SAR recorded on the booking, nothing in the ledger → 30000 halalas.
    expect(effectiveNetPaidHalalas(0, 300)).toBe(30000);
  });
  it("form paid = 0 → falls back to the ledger net (payment-panel usage)", () => {
    expect(effectiveNetPaidHalalas(50000, 0)).toBe(50000);
  });
  it("both records present → the MAX (never double-counts, never over-reports debt)", () => {
    expect(effectiveNetPaidHalalas(20000, 300)).toBe(30000); // form 30000 > ledger 20000
    expect(effectiveNetPaidHalalas(50000, 300)).toBe(50000); // ledger 50000 > form 30000
  });
  it("a fully-paid form booking reads as fully paid → zero remaining", () => {
    // The bug this fixes: total 900 SAR, paid 900 on the form, empty ledger.
    // remaining = total*100 - effectiveNet must be 0, not the full 90000.
    const totalHalalas = 900 * 100;
    expect(totalHalalas - effectiveNetPaidHalalas(0, 900)).toBe(0);
  });
  it("nothing paid anywhere → 0; NaN / negative inputs are clamped to 0", () => {
    expect(effectiveNetPaidHalalas(0, 0)).toBe(0);
    expect(effectiveNetPaidHalalas(NaN, 300)).toBe(30000);
    expect(effectiveNetPaidHalalas(-5, -5)).toBe(0);
    expect(effectiveNetPaidHalalas(undefined, undefined)).toBe(0);
  });
});
