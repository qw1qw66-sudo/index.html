import { describe, it, expect } from "vitest";
import { convo } from "./helpers/audit-harness.mjs";
import { suggestedPrice } from "../../supabase/functions/_shared/assistant/booking-planner.mjs";

// G3 — the model LEADS the scattered/delegated bookings the deterministic
// planner cannot resolve (it can only ask «أي شاليه؟»). A delegation cue
// («احجز أي شاليه فاضي» / «دبّر أنسب شاليه») yields to the model loop, which
// reads availability and proposes a full prepare_booking_create — every
// validator + the owner-token confirm gate unchanged. A CONCRETE booking with a
// named chalet (or no delegation cue) stays fully deterministic (model_calls=0).
// The harness's callModel returns "unreachable", so a yield still registers a
// model call even though the loop then fails closed.

describe("G3: delegated bookings YIELD to the model", () => {
  const DELEGATED = [
    "احجز أي شاليه فاضي بكرة",
    "دبّر لي أنسب شاليه نهاية الأسبوع",
    "احجز أرخص شاليه متاح",
    "اختر لي شاليه مناسب للعائلة",
    "وش تنصح أحجز؟",
  ];
  for (const msg of DELEGATED) {
    it(`«${msg}» reaches the model (not stuck deterministic)`, async () => {
      const c = convo();
      await c.say(msg);
      // callModel is invoked ONLY by the model loop — the deterministic pipeline
      // never calls it — so a recorded call is definitive proof of the yield.
      expect(c.deps._modelCalls.length).toBeGreaterThan(0);
    });
  }
});

describe("G3: concrete bookings STAY deterministic (model_calls=0)", () => {
  const CONCRETE = [
    "ثبت لي حجز بكرة", // booking intent, no delegation cue
    "احجز شاليه تولوم بكرة الفترة المسائية", // a named chalet
    "ابغى احجز تولوم", // a named chalet
  ];
  for (const msg of CONCRETE) {
    it(`«${msg}» never falls to the model`, async () => {
      const c = convo();
      const r = await c.say(msg);
      expect(c.deps._modelCalls.length).toBe(0);
      expect(r.model_calls).toBe(0);
    });
  }

  it("a mid-draft turn never yields even with a delegation-shaped word", async () => {
    const c = convo();
    const t0 = await c.say("ثبت لي حجز بكرة"); // opens a draft, asks chalet
    expect(t0.model_calls).toBe(0);
    const t1 = await c.say("أي شاليه تنصح؟"); // «أي شاليه» but a draft is active
    expect(t1.model_calls).toBe(0); // active draft → deterministic, never yields
  });
});

describe("G3: find_empty_dates price enrichment uses the CARD price (never invented)", () => {
  const period = { weekday_price: 300, weekend_price: 500 };
  it("weekday date → weekday_price; KSA weekend (Fri/Sat) → weekend_price", () => {
    expect(suggestedPrice(period, "2026-07-16")).toBe(300); // Thu
    expect(suggestedPrice(period, "2026-07-17")).toBe(500); // Fri (weekend)
    expect(suggestedPrice(period, "2026-07-18")).toBe(500); // Sat (weekend)
  });
  it("a period with no positive price → null (the model must ASK, never invent)", () => {
    expect(suggestedPrice({ weekday_price: 0, weekend_price: 0 }, "2026-07-16")).toBe(null);
  });
});
