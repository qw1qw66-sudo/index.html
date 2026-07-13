// R12 (reverse audit 360°) — deterministic ROUTING fixes for the blind-spot
// angles found by rotating around the project. Each test pins the tool NAME +
// ARGS the handler dispatches (model_calls=0), so a future edit that widens or
// narrows an intent can't silently regress the owner's answer:
//   R3  «كم دخلي اليوم؟»        → today-only income (was: whole month)
//   R5  «كم حجز بكرة؟»/«كم حجوزاتي؟» → deterministic range (was: fell to model)
//   R4  «وش الشاليهات المتاحة اليوم؟» → availability (was: static catalog)
//   R7  «ثبت لي حجز بكرة»        → booking pipeline (was: fell to model)
//   R9  mid-draft «...عدد الضيوف ٥» → binds to draft (never hijacked to summary)
import { describe, it, expect } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { bookingsSummary } from "../../supabase/functions/_shared/assistant/booking-reads.mjs";
import { redactObject } from "../../supabase/functions/_shared/assistant/redact.mjs";
import { riyadhToday, addDays } from "../../supabase/functions/_shared/assistant/availability.mjs";
import { convo, TODAY as HARNESS_TODAY } from "./helpers/audit-harness.mjs";

const WS = "WSD";
const TODAY = riyadhToday(Date.now());

// A read-capturing deps mock (booking-summary.test.js shape): the REAL handler
// runs, and every read tool it dispatches is recorded in _reads with its args.
function makeDeps(bookings) {
  const doc = { chalets: [], bookings };
  const readsCalled = [];
  return {
    _reads: readsCalled,
    env: { ASSISTANT_CONFIRM_SECRET: "s", DEEPSEEK_API_KEY: "k" },
    async auth() { return { ok: true, workspace_key: WS }; },
    async callModel() { return { ok: false, error: "DEEPSEEK_UNREACHABLE" }; },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "r"; },
    async getWorkspaceData() { return { data: doc, updated_at: "r" }; },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    async getActiveDraft() { return null; },
    async getDraftPrivate() { return {}; },
    async upsertDraft() { return { draft_id: "th-1" }; },
    async runReadTool(_k, name, args) {
      readsCalled.push({ name, args });
      if (name === "get_bookings_summary") {
        const s = bookingsSummary(doc.bookings, { from: String(args.from || ""), to: String(args.to || "") });
        return redactObject({ summary: true, count: s.count, total_income: s.total_income, paid_total: s.paid_total, from: s.from, to: s.to, bookings: s.bookings.slice(0, 10) });
      }
      return {}; // find_empty_dates / list_bookings — routing is what we assert
    },
  };
}

const ask = (deps, message) =>
  handleAssistant(
    new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", message }) }),
    deps,
  ).then((r) => r.json());

describe("R12 routing — R3: single-day income is NOT widened to a month", () => {
  it("«كم دخلي اليوم؟» → get_bookings_summary scoped to today only (from===to===today)", async () => {
    const deps = makeDeps([
      { id: "t1", customer_name: "علي", customer_phone: "0559990001", booking_date: TODAY, total: 700, paid: 0, status: "confirmed", deleted_at: null },
      { id: "m1", customer_name: "سعد", customer_phone: "0559990002", booking_date: addDays(TODAY, 5), total: 900, paid: 0, status: "confirmed", deleted_at: null },
    ]);
    const r = await ask(deps, "كم دخلي اليوم؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    // The essence of the R3 fix: TODAY..TODAY, not the whole calendar month
    // (which would have swept in the +5-day 900-riyal booking).
    expect(deps._reads[0].args.from).toBe(TODAY);
    expect(deps._reads[0].args.to).toBe(TODAY);
    expect(r.reply_ar).toContain("700 ريال"); // only today's income
    expect(r.reply_ar).not.toContain("1600"); // never 700+900
  });
});

describe("R12 routing — R5: bare/tomorrow count questions stay model-free", () => {
  it("«كم حجز بكرة؟» → get_bookings_summary scoped to tomorrow only, zero model calls", async () => {
    const deps = makeDeps([]);
    const r = await ask(deps, "كم حجز بكرة؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    const tomorrow = addDays(TODAY, 1);
    expect(deps._reads[0].args.from).toBe(tomorrow);
    expect(deps._reads[0].args.to).toBe(tomorrow);
  });

  it("«كم حجوزاتي؟» (no period) → upcoming set, zero model calls (never the model)", async () => {
    const deps = makeDeps([]);
    const r = await ask(deps, "كم حجوزاتي؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    expect(deps._reads[0].args.from).toBe(TODAY); // upcoming default
    expect(deps._reads[0].args.to).toBe(addDays(TODAY, 60));
  });
});

describe("R12 routing — R4: «المتاحة اليوم» asks availability, not the static catalog", () => {
  it("«وش الشاليهات المتاحة اليوم؟» → find_empty_dates (days_ahead 1), not list_chalets", async () => {
    const deps = makeDeps([]);
    const r = await ask(deps, "وش الشاليهات المتاحة اليوم؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("find_empty_dates");
    expect(deps._reads[0].args.days_ahead).toBe(1);
  });

  it("a pure catalog question «وش الشاليهات المسجلة عندي؟» still lists chalets (unchanged)", async () => {
    const deps = makeDeps([]);
    const r = await ask(deps, "وش الشاليهات المسجلة عندي؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("list_chalets");
  });

  it("«وش الشاليهات المتاحة عندي؟» (availability, NO «اليوم») stays deterministic — never the model", async () => {
    // Regression guard: the R4 catalog-exclusion must not drop a دون-يوم
    // availability phrasing to the model. asksAvailability needs «اليوم»; without
    // it, this lists the chalets deterministically (model_calls=0) as before.
    const deps = makeDeps([]);
    const r = await ask(deps, "وش الشاليهات المتاحة عندي؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("list_chalets");
  });
});

describe("R12 routing — R7: a spaced create verb «ثبت لي حجز» enters the booking line", () => {
  it("«ثبت لي حجز بكرة» starts a deterministic draft (model-free), never the model", async () => {
    const c = convo();
    const r = await c.say("ثبت لي حجز بكرة");
    expect(r.model_calls).toBe(0); // did NOT fall through to the model
    expect(c.deps._modelCalls).toHaveLength(0);
    // A draft was opened and the pipeline is asking for the booking fields
    // (chalet), not answering a lookup or erroring out.
    expect(r.fields).not.toBeNull();
    expect(r.reply).toContain("اسم الشاليه");
  });
});

describe("R12 routing — R9 guard: a mid-draft field answer is never read as a summary", () => {
  it("«...شالية تولوم عدد الضيوف ٥» binds to the draft, not get_bookings_summary", async () => {
    const c = convo();
    const t0 = await c.say("ابغى احجز");
    expect(t0.model_calls).toBe(0);
    // The combined answer contains «الحجز» (حجز) AND «عدد الضيوف» (عدد) — the exact
    // pair that used to satisfy the loose asksSummary and hijack to a summary.
    const t1 = await c.say("الحجز باسم محمد التاريخ بعد ٣ ايام شالية تولوم عدد الضيوف ٥");
    expect(t1.model_calls).toBe(0);
    expect(t1.fields.chalet_id).toBe("tulum"); // bound from inside the sentence
    expect(t1.fields.guests).toBe(5);
    expect(t1.fields.booking_date).toBe(addDays(HARNESS_TODAY, 3));
    // It never answered as a bookings summary.
    expect(t1.reply).not.toContain("إجمالي الدخل");
    expect(t1.reply).not.toContain("عدد الحجوزات");
  });
});
