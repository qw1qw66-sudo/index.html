import { describe, expect, it } from "vitest";
import {
  applyNightAnchor,
  availabilityCheck,
  isSlotAvailable,
  periodInterval,
} from "../../supabase/functions/_shared/assistant/availability.mjs";
import {
  derivePaymentState,
  validateCreateSession,
  validateManualPayment,
} from "../../supabase/functions/_shared/ledger-core.mjs";

// R11 infra hardening. Pure-function regressions for the two findings that live
// in importable modules:
//   * D-P6-1 — availability.mjs periodInterval must treat a grandfathered
//     zero-length period (start===end) as a full 24h interval (SQL parity),
//     instead of null → unknown_interval → AVAILABILITY_UNPROVABLE that
//     hard-blocked EVERY booking on the chalet.
//   * E-P5-1 — ledger-core.mjs must clamp the effective net-paid at 0 so a
//     stored over-refund (negative net) can never inflate `remaining` /
//     paid-state above the booking total.
//
// The three index.html validations are DOM-side (no node harness for
// saveChalet) and are verified by reading + the playwright e2e suite:
//   * D-P6-1 save-reject — saveChalet refuses a period whose start===end
//     («وقت البداية والنهاية لا يمكن أن يكونا متطابقين»).
//   * D-P14-1 — saveChalet refuses an out-of-range time hour>23 / minute>59
//     e.g. "25:70" («صيغة الوقت غير صحيحة»).
//   * D-EXTRA-1 — index.html periodsOverlap now applies the <06:00 night-anchor
//     shift (matching intervalFor/applyNightAnchor) so the advisory «فترات
//     متداخلة» banner stops under-reporting night-anchored template collisions.

const D = "2099-07-12";

describe("D-P6-1 — zero-length period grandfathered as a 24h interval", () => {
  it("periodInterval({12:00,12:00}) returns a full 24h interval, not null", () => {
    const iv = periodInterval({ start: "12:00", end: "12:00" }, D);
    expect(iv).not.toBeNull();
    const base = new Date(`${D}T00:00:00Z`).getTime();
    expect(iv.start).toBe(base + 12 * 3600000); // T
    expect(iv.end).toBe(base + 12 * 3600000 + 86400000); // T + 1 day
    expect(iv.end - iv.start).toBe(86400000); // exactly 24h
  });

  it("applyNightAnchor folds start===end into a +1-day wrap (the 24h source)", () => {
    expect(applyNightAnchor(1000, 1000, 12)).toEqual({ start: 1000, end: 1000 + 86400000 });
  });

  it("fail-closed contract preserved: genuinely missing/incomplete times stay null", () => {
    expect(periodInterval({ start: "", end: "" }, D)).toBeNull();
    expect(periodInterval({ start: "12:00" }, D)).toBeNull(); // missing end
    expect(periodInterval({ start: "12:00", end: "9:99" }, D)).toBeNull(); // malformed
    expect(periodInterval(undefined, D)).toBeNull();
    expect(periodInterval({ start: "12:00", end: "12:00" }, "not-a-date")).toBeNull();
  });

  it("a grandfathered zero-length booking blocks ONLY its real 24h night, not everything", () => {
    const doc = {
      chalets: [
        {
          id: "c1",
          deleted_at: null,
          periods: [
            { id: "zero", label: "صفري", start: "12:00", end: "12:00", active: true },
            { id: "day", label: "دوام", start: "07:00", end: "17:00", active: true },
          ],
        },
      ],
      bookings: [
        {
          id: "b0",
          chalet_id: "c1",
          period_id: "zero",
          booking_date: D,
          status: "confirmed",
          deleted_at: null,
          customer_name: "قديم",
        },
      ],
    };
    // SAME night: the 24h window [D 12:00, D+1 12:00] really overlaps 07:00–17:00,
    // so the block is a CONCRETE overlap — no longer the blanket unknown_interval.
    const same = availabilityCheck(doc, "c1", D, { start: "07:00", end: "17:00" });
    expect(same).toMatchObject({ available: false, cause: "overlap" });
    // A far-future date used to be hard-blocked (unknown_interval blocked every
    // booking). With the 24h grandfather it is correctly AVAILABLE again.
    expect(isSlotAvailable(doc, "c1", "2099-08-20", { start: "07:00", end: "17:00" })).toBe(true);
  });
});

describe("E-P5-1 — over-refund cannot inflate remaining / paid-state (dormant path)", () => {
  // 90000-halala (900-riyal) booking, gross 90000, refunded 180000 → net -90000.
  const booking = { total: 900, status: "confirmed", deleted_at: null };

  it("derivePaymentState clamps net to 0: fully-(over)refunded reads 'refunded', not inflating", () => {
    const state = derivePaymentState({
      totalHalalas: 90000,
      grossPaidHalalas: 90000,
      refundedHalalas: 180000,
      netPaidHalalas: -90000,
      hasPendingOrder: false,
      lastOrderStatus: null,
    });
    expect(state).toBe("refunded");
    expect(["paid", "partially_paid"]).not.toContain(state);
  });

  it("validateCreateSession remaining clamps to the total (90000), never 2x (180000)", () => {
    const r = validateCreateSession({
      booking,
      requestedAmountHalalas: null,
      netPaidHalalas: -90000,
      hasActivePendingOrder: false,
      allowPartial: true,
    });
    expect(r.ok).toBe(true);
    expect(r.totalHalalas).toBe(90000);
    expect(r.remainingHalalas).toBe(90000); // NOT 180000
    expect(r.amountHalalas).toBe(90000);
  });

  it("validateManualPayment over-collection guard uses the clamped remaining", () => {
    const over = validateManualPayment({
      booking,
      amountHalalas: 90001, // just past the clamped remaining
      paymentMethod: "cash",
      netPaidHalalas: -90000,
      allowOverCollection: false,
    });
    expect(over.ok).toBe(false);
    expect(over.error).toBe("AMOUNT_EXCEEDS_REMAINING");
    expect(over.remainingHalalas).toBe(90000); // clamped, not 180000

    const exact = validateManualPayment({
      booking,
      amountHalalas: 90000,
      paymentMethod: "cash",
      netPaidHalalas: -90000,
      allowOverCollection: false,
    });
    expect(exact.ok).toBe(true);
    expect(exact.remainingHalalas).toBe(90000);
  });

  it("regression guard: ordinary non-negative net is unaffected by the clamp", () => {
    expect(
      derivePaymentState({
        totalHalalas: 90000,
        grossPaidHalalas: 30000,
        refundedHalalas: 0,
        netPaidHalalas: 30000,
        hasPendingOrder: false,
        lastOrderStatus: null,
      }),
    ).toBe("partially_paid");
    const r = validateCreateSession({
      booking,
      requestedAmountHalalas: null,
      netPaidHalalas: 30000,
      hasActivePendingOrder: false,
      allowPartial: true,
    });
    expect(r.remainingHalalas).toBe(60000);
  });
});
