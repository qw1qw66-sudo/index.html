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
    "دبّر لي أنسب شاليه نهاية الأسبوع", // imperative «دبّر» (not the «أنسب شاليه» token)
    "دبّر لي أرخص شاليه متاح", // imperative «دبّر»
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
    // Adversarial-review regression: a superlative describing a NAMED chalet is
    // a concrete booking, not a delegation — «أفضل/أنسب/أرخص شاليه» must NOT yield.
    "احجز أفضل شاليه تولوم بكرة",
    "احجز تولوم أفضل شاليه عندي بكرة",
    "احجز أرخص شاليه تولوم",
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

// The critical safety fix (adversarial-review Finding 4): when the MODEL leads a
// prepare, its total is FORCED to the chalet's card price — a hallucinated total
// can never reach the confirmation card. If the period has no card price, the
// prepare is REFUSED so the model must ask the owner (never invents).
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";

const WS = "WSG3";
function makeModelDeps({ modelSeq, suggested_price }) {
  let call = 0;
  const actions = new Map();
  return {
    _actions: actions,
    env: { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" },
    async auth(k, pin) { return k === WS && pin === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "X" }; },
    async callModel() { const r = modelSeq[Math.min(call, modelSeq.length - 1)]; call++; return r; },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "r1"; },
    async runReadTool() { return { empty: [] }; },
    // The resolver binds ids AND returns the card price alongside the args.
    async resolveBookingCreateArgs(_k, args) { return { ok: true, suggested_price, args: { ...args, chalet_id: "c1", period_id: "p1" } }; },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    async getActiveDraft() { return null; },
    async getDraftPrivate() { return {}; },
    async upsertDraft() { return { draft_id: "th-1" }; },
    newId: () => "new-b1",
    async prepareSensitive(_k, spec) { const id = "act-" + (actions.size + 1); actions.set(id, spec); return { action_id: id }; },
  };
}
const chat = (deps, message) => handleAssistant(
  new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", message }) }),
  deps,
).then((r) => r.json());

// A model that leads a booking by preparing with a HALLUCINATED total of 12345.
const HALLUCINATED = [
  { ok: true, reply: "أجهّز الحجز", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "عميل", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 12345 } }] },
  { ok: true, reply: "جهّزت الحجز، بانتظار تأكيدك.", toolCalls: [] },
];

describe("G3: a model-led prepare uses the CARD price, never the model's number", () => {
  it("forces the total to the card price (500), discarding the hallucinated 12345", async () => {
    const deps = makeModelDeps({ modelSeq: HALLUCINATED, suggested_price: 500 });
    await chat(deps, "احجز أي شاليه فاضي بكرة"); // delegated → model leads
    expect(deps._actions.size).toBe(1);
    const armed = [...deps._actions.values()][0];
    expect(armed.args.total).toBe(500); // card price, NOT 12345
    expect(armed.args.total_source).toBe("card");
  });

  it("refuses to arm when the period has no card price (model must ASK)", async () => {
    const deps = makeModelDeps({ modelSeq: HALLUCINATED, suggested_price: null });
    await chat(deps, "احجز أي شاليه فاضي بكرة");
    expect(deps._actions.size).toBe(0); // nothing armed — no invented price
  });
});
