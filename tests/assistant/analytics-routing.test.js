// G2 — the analytical intents route DETERMINISTICALLY (model_calls=0) to the new
// read tools, WITHOUT colliding with the existing income/booking-summary block
// (whose loose «حجز|دخل» guard sits right after them). The REAL handler runs; a
// read-capturing deps mock records every dispatched tool + args and computes the
// analytics result exactly as readFromDoc does, so we also assert the rendered
// Arabic. Booking/expense amounts are whole riyals.
import { describe, it, expect } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { bookingsSummary, monthRangeIso } from "../../supabase/functions/_shared/assistant/booking-reads.mjs";
import {
  expenseSummary, netProfit, chaletProfitability, compareMonths, topCustomers, businessOverview, prevMonthKey,
} from "../../supabase/functions/_shared/assistant/analytics.mjs";
import { redactObject } from "../../supabase/functions/_shared/assistant/redact.mjs";
import { riyadhToday } from "../../supabase/functions/_shared/assistant/availability.mjs";

const WS = "WSA";
const TODAY = riyadhToday(Date.now());
const MONTH = monthRangeIso(TODAY);
const THIS_M = TODAY.slice(0, 7);
const PREV_M = prevMonthKey(THIS_M);
const PREV = monthRangeIso(`${PREV_M}-01`);
const LAST_MONTH_DATE = `${PREV_M}-15`;

// readFromDoc's arg→call mapping, mirrored so the render matches production.
function dispatchAnalytics(name, args, doc) {
  const rangeOrMonth = () => (args.from || args.to ? { from: String(args.from || ""), to: String(args.to || "") } : monthRangeIso(TODAY));
  switch (name) {
    case "get_expense_summary": return expenseSummary(doc.expenses, rangeOrMonth());
    case "get_net_profit": return netProfit(doc.bookings, doc.expenses, { ...rangeOrMonth(), chalet_id: String(args.chalet_id || "") });
    case "get_chalet_profitability": return chaletProfitability(doc.chalets, doc.bookings, doc.expenses, rangeOrMonth());
    case "compare_months": return compareMonths(doc.bookings, doc.expenses, String(args.month_a || THIS_M), String(args.month_b || prevMonthKey(THIS_M)));
    case "get_top_customers": return topCustomers(doc.bookings, { from: String(args.from || ""), to: String(args.to || ""), limit: Number(args.limit) || 5 });
    case "get_business_overview": return businessOverview(doc, TODAY);
    default: return null;
  }
}

function makeDeps({ bookings = [], expenses = [], chalets = [] } = {}) {
  const doc = { chalets, bookings, expenses };
  const reads = [];
  return {
    _reads: reads,
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
      reads.push({ name, args });
      const analytic = dispatchAnalytics(name, args, doc);
      if (analytic) return redactObject(analytic);
      if (name === "get_bookings_summary") {
        const s = bookingsSummary(doc.bookings, { from: String(args.from || ""), to: String(args.to || "") });
        return redactObject({ summary: true, count: s.count, total_income: s.total_income, paid_total: s.paid_total, from: s.from, to: s.to, bookings: s.bookings.slice(0, 10) });
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

// Routing table: phrase → expected tool. All must be model_calls=0.
const ROUTES = [
  ["كم صرفت هذا الشهر؟", "get_expense_summary"],
  ["وش مصاريفي؟", "get_expense_summary"],
  ["كم التكاليف؟", "get_expense_summary"],
  ["كم صافي الربح؟", "get_net_profit"],
  ["وش الصافي هذا الشهر؟", "get_net_profit"],
  ["كم ربحت؟", "get_net_profit"],
  ["صافي دخلي هذا الشهر", "get_net_profit"], // the key fix: صافي wins over gross income
  ["أي شاليه أربح؟", "get_chalet_profitability"],
  ["وش الشاليه الأكثر دخل؟", "get_chalet_profitability"],
  ["قارن هذا الشهر بالشهر الماضي", "compare_months"],
  ["قارن دخل الشهر بالماضي", "compare_months"], // contains دخل but compare wins
  ["مين أكثر العملاء؟", "get_top_customers"],
  ["وش أفضل الزبائن عندي؟", "get_top_customers"],
];

describe("G2 routing — analytical intents dispatch deterministically", () => {
  for (const [phrase, tool] of ROUTES) {
    it(`«${phrase}» → ${tool} (model_calls=0)`, async () => {
      const deps = makeDeps();
      const r = await ask(deps, phrase);
      expect(r.model_calls).toBe(0);
      expect(deps._reads[0]?.name).toBe(tool);
    });
  }

  it("«كم صرفت الشهر الماضي؟» scopes to last month's range", async () => {
    const deps = makeDeps();
    await ask(deps, "كم صرفت الشهر الماضي؟");
    expect(deps._reads[0].name).toBe("get_expense_summary");
    expect(deps._reads[0].args).toMatchObject({ from: PREV.from, to: PREV.to });
  });
  it("«كم صرفت هذا الشهر؟» scopes to this month's range", async () => {
    const deps = makeDeps();
    await ask(deps, "كم صرفت هذا الشهر؟");
    expect(deps._reads[0].args).toMatchObject({ from: MONTH.from, to: MONTH.to });
  });
});

// The collision matrix: existing phrasings keep their OLD tool, and the new
// intents never steal them (nor vice-versa).
describe("G2 collision matrix — existing income/summary intents are untouched", () => {
  const KEEP = [
    ["كم دخلي هذا الشهر؟", "get_bookings_summary"], // gross income, NOT net
    ["كم حجز عندي هالأسبوع؟", "get_bookings_summary"],
    ["كم حجوزاتي؟", "get_bookings_summary"],
    ["وش الشاليهات المتاحة اليوم؟", "find_empty_dates"], // availability, NOT profitability
    ["وش الشاليهات المسجلة عندي؟", "list_chalets"],
    ["من عليه مبالغ متبقية؟", "list_outstanding_balances"],
  ];
  for (const [phrase, tool] of KEEP) {
    it(`«${phrase}» still → ${tool} (model_calls=0)`, async () => {
      const deps = makeDeps();
      const r = await ask(deps, phrase);
      expect(r.model_calls).toBe(0);
      expect(deps._reads[0]?.name).toBe(tool);
    });
  }
});

describe("G2 renders — the deterministic Arabic answer carries the right riyals", () => {
  // Fixtures anchored to TODAY so the this-month default always includes them.
  const chalets = [{ id: "c1", name: "البحر", deleted_at: null }, { id: "c2", name: "الجبل", deleted_at: null }];
  const bookings = [
    { id: "b1", customer_name: "علي", chalet_id: "c1", booking_date: TODAY, total: 900, paid: 400, status: "confirmed", deleted_at: null },
    { id: "b2", customer_name: "علي", chalet_id: "c2", booking_date: TODAY, total: 500, paid: 0, status: "confirmed", deleted_at: null },
    { id: "b3", customer_name: "قديم", chalet_id: "c1", booking_date: LAST_MONTH_DATE, total: 1000, paid: 1000, status: "confirmed", deleted_at: null },
  ];
  const expenses = [
    { id: "e1", date: TODAY, category: "كهرباء", amount: 200, chalet_id: "c1", deleted_at: null },
    { id: "e2", date: TODAY, category: "صيانة", amount: 150, chalet_id: "", deleted_at: null },
    { id: "e3", date: LAST_MONTH_DATE, category: "ماء", amount: 5000, chalet_id: "c1", deleted_at: null },
  ];
  const fx = () => makeDeps({ bookings, expenses, chalets });

  it("expenses: «كم صرفت هذا الشهر؟» → total 350 + categories", async () => {
    const r = await ask(fx(), "كم صرفت هذا الشهر؟");
    expect(r.reply_ar).toContain("350 ريال");
    expect(r.reply_ar).toContain("كهرباء: 200 ريال");
  });
  it("net: «كم صافي الربح؟» → income 1400, expenses 350, net 1050", async () => {
    const r = await ask(fx(), "كم صافي الربح؟");
    expect(r.reply_ar).toContain("1400");
    expect(r.reply_ar).toContain("350");
    expect(r.reply_ar).toContain("1050");
  });
  it("profitability: «أي شاليه أربح؟» → البحر ranked first", async () => {
    const r = await ask(fx(), "أي شاليه أربح؟");
    expect(r.reply_ar).toContain("الأربح: البحر");
    expect(r.reply_ar).toContain("غير منسوبة"); // the 150 unattributed expense surfaced
  });
  it("top customers: «مين أكثر العملاء؟» → علي first, names only (no phone)", async () => {
    const r = await ask(fx(), "مين أكثر العملاء؟");
    expect(r.reply_ar).toContain("علي");
    expect(r.reply_ar).not.toMatch(/05\d|جوال/);
  });
  it("compare: «قارن هذا الشهر بالشهر الماضي» → both months + net delta", async () => {
    const r = await ask(fx(), "قارن هذا الشهر بالشهر الماضي");
    expect(r.reply_ar).toContain(THIS_M);
    expect(r.reply_ar).toContain(PREV_M);
    expect(r.reply_ar).toContain("الفرق في الصافي");
  });
});
