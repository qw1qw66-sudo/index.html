// Deterministic period reads (get_bookings_summary): «كم حجز عندي هالأسبوع؟»,
// «الحجوزات السابقة», «كم دخلي هالشهر؟» answer with a COUNT + total income and
// ZERO model calls. runReadTool is wired to the REAL bookingsSummary over a
// fixture doc, so the intent → dispatch → summary → Arabic render is exercised
// end-to-end (the index.ts readFromDoc wiring is covered by the live smoke).
import { describe, it, expect } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { bookingsSummary } from "../../supabase/functions/_shared/assistant/booking-reads.mjs";
import { redactObject } from "../../supabase/functions/_shared/assistant/redact.mjs";
import { riyadhToday, addDays } from "../../supabase/functions/_shared/assistant/availability.mjs";

const WS = "WSD";
const TODAY = riyadhToday(Date.now());

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
      // Mirror production: readFromDoc's result is wrapped in redactObject (which
      // DROPS customer_phone) before it leaves runReadTool.
      if (name === "get_bookings_summary") {
        const s = bookingsSummary(doc.bookings, { from: String(args.from || ""), to: String(args.to || "") });
        return redactObject({ summary: true, count: s.count, total_income: s.total_income, paid_total: s.paid_total, from: s.from, to: s.to, bookings: s.bookings.slice(0, 10) });
      }
      if (name === "list_bookings") {
        return redactObject({ bookings: doc.bookings.filter((b) => !b.deleted_at && b.status !== "cancelled" && (!args.from || b.booking_date >= args.from) && (!args.to || b.booking_date <= args.to)) });
      }
      return {};
    },
  };
}

const ask = (deps, message) =>
  handleAssistant(
    new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", message }) }),
    deps,
  ).then((r) => r.json());

const DOC = [
  { id: "1", customer_name: "علي", customer_phone: "0559990001", booking_date: addDays(TODAY, 2), total: 500, paid: 0, status: "confirmed", deleted_at: null }, // this week
  { id: "2", customer_name: "سعد", customer_phone: "0559990002", booking_date: addDays(TODAY, 4), total: 300, paid: 0, status: "pending", deleted_at: null }, // this week
  { id: "3", customer_name: "خالد", customer_phone: "0559990003", booking_date: addDays(TODAY, -10), total: 400, paid: 0, status: "confirmed", deleted_at: null }, // past
  { id: "4", customer_name: "منى", customer_phone: "0559990004", booking_date: addDays(TODAY, -3), total: 250, paid: 0, status: "confirmed", deleted_at: null }, // past
  { id: "5", customer_name: "زيد", customer_phone: "0559990005", booking_date: addDays(TODAY, 5), total: 999, paid: 0, status: "cancelled", deleted_at: null }, // excluded
];

describe("deterministic period summaries (count + income, zero model calls)", () => {
  it("«كم حجز عندي هالأسبوع؟» → this-week count + income, model-free, phone-free", async () => {
    const deps = makeDeps(DOC);
    const r = await ask(deps, "كم حجز عندي هالأسبوع؟");
    expect(r.model_calls).toBe(0);
    expect(r.model).toBe("deterministic-read");
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    expect(r.reply_ar).toContain("حجزان"); // علي + سعد (cancelled زيد excluded)
    expect(r.reply_ar).toContain("800 ريال"); // 500 + 300
    expect(JSON.stringify(r)).not.toMatch(/05599900\d\d/); // no raw phones anywhere
  });

  it("«الحجوزات السابقة» → past count + income", async () => {
    const deps = makeDeps(DOC);
    const r = await ask(deps, "الحجوزات السابقة");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    expect(deps._reads[0].args.to).toBe(addDays(TODAY, -1)); // strictly before today
    expect(r.reply_ar).toContain("حجزان"); // خالد + منى
    expect(r.reply_ar).toContain("650 ريال"); // 400 + 250
  });

  it("«كم دخلي هالشهر؟» → this-month income", async () => {
    const deps = makeDeps(DOC);
    const r = await ask(deps, "كم دخلي هالشهر؟");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("get_bookings_summary");
    expect(r.reply_ar).toContain("إجمالي الدخل");
    expect(r.reply_ar).toContain("ريال");
  });

  it("a SHOW request «اعرض الحجوزات القادمة» stays a plain list (not a summary)", async () => {
    const deps = makeDeps(DOC);
    const r = await ask(deps, "اعرض الحجوزات القادمة");
    expect(r.model_calls).toBe(0);
    expect(deps._reads[0].name).toBe("list_bookings"); // unchanged behavior
  });

  it("no bookings in range → a clear empty answer, still model-free", async () => {
    const deps = makeDeps([]);
    const r = await ask(deps, "كم حجز عندي هالأسبوع؟");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("لا توجد حجوزات في هذه المدة");
  });
});
