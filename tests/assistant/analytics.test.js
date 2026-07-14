// G2 — pure unit tests for the analytics "business brain" module. Every value
// is derived from the workspace document in WHOLE RIYALS, so net === the
// browser runReport basis (booking total − expenses); cancelled/deleted/
// out-of-range rows are excluded; customer ranking is by NAME only (no phone).
import { describe, it, expect } from "vitest";
import {
  activeExpenseRows,
  prevMonthKey,
  expenseSummary,
  netProfit,
  chaletProfitability,
  compareMonths,
  topCustomers,
  businessOverview,
} from "../../supabase/functions/_shared/assistant/analytics.mjs";

const CHALETS = [
  { id: "c1", name: "البحر", deleted_at: null },
  { id: "c2", name: "الجبل", deleted_at: null },
];
const BOOKINGS = [
  { id: "b1", customer_name: "علي", chalet_id: "c1", booking_date: "2026-07-05", total: 900, paid: 900, status: "confirmed", deleted_at: null },
  { id: "b2", customer_name: "علي", chalet_id: "c1", booking_date: "2026-07-12", total: 800, paid: 400, status: "confirmed", deleted_at: null },
  { id: "b3", customer_name: "سارة", chalet_id: "c2", booking_date: "2026-07-20", total: 500, paid: 0, status: "confirmed", deleted_at: null },
  { id: "b4", customer_name: "ملغي", chalet_id: "c1", booking_date: "2026-07-09", total: 9999, paid: 0, status: "cancelled", deleted_at: null },
  { id: "b5", customer_name: "قديم", chalet_id: "c1", booking_date: "2026-06-15", total: 1000, paid: 1000, status: "confirmed", deleted_at: null },
  { id: "b6", customer_name: "محذوف", chalet_id: "c1", booking_date: "2026-07-01", total: 4444, paid: 0, status: "confirmed", deleted_at: "2026-07-02" },
];
const EXPENSES = [
  { id: "e1", date: "2026-07-03", category: "كهرباء", amount: 200, chalet_id: "c1", deleted_at: null },
  { id: "e2", date: "2026-07-10", category: "صيانة", amount: 150, chalet_id: "", deleted_at: null },
  { id: "e3", date: "2026-07-15", category: "كهرباء", amount: 100, chalet_id: "c2", deleted_at: null },
  { id: "e4", date: "2026-06-01", category: "ماء", amount: 5000, chalet_id: "c1", deleted_at: null },
  { id: "e5", date: "2026-07-01", category: "محذوف", amount: 777, chalet_id: "c1", deleted_at: "2026-07-02" },
];
const JULY = { from: "2026-07-01", to: "2026-07-31" };

describe("analytics helpers", () => {
  it("activeExpenseRows drops soft-deleted rows", () => {
    expect(activeExpenseRows(EXPENSES)).toHaveLength(4);
    expect(activeExpenseRows(null)).toEqual([]);
  });
  it("prevMonthKey wraps the year boundary", () => {
    expect(prevMonthKey("2026-01")).toBe("2025-12");
    expect(prevMonthKey("2026-07")).toBe("2026-06");
    expect(prevMonthKey("bad")).toBe("");
  });
});

describe("expenseSummary", () => {
  it("totals + groups by category within range, newest categories largest first", () => {
    const s = expenseSummary(EXPENSES, JULY);
    expect(s.total).toBe(450); // 200 + 150 + 100 (June 5000 out of range; 777 deleted)
    expect(s.count).toBe(3);
    expect(s.by_category).toEqual([
      { category: "كهرباء", amount: 300 },
      { category: "صيانة", amount: 150 },
    ]);
  });
  it("empty when no expenses in range", () => {
    const s = expenseSummary(EXPENSES, { from: "2099-01-01", to: "2099-12-31" });
    expect(s.total).toBe(0);
    expect(s.count).toBe(0);
  });
});

describe("netProfit", () => {
  it("income (non-cancelled, non-deleted totals) − expenses, matching runReport basis", () => {
    const n = netProfit(BOOKINGS, EXPENSES, JULY);
    expect(n.income).toBe(2200); // 900 + 800 + 500 (cancelled 9999 & deleted 4444 excluded)
    expect(n.expenses).toBe(450);
    expect(n.net_profit).toBe(1750);
  });
  it("scopes to one chalet on both income and expenses", () => {
    const n = netProfit(BOOKINGS, EXPENSES, { ...JULY, chalet_id: "c1" });
    expect(n.income).toBe(1700); // c1 only
    expect(n.expenses).toBe(200); // e1 (c1); e2 has no chalet, e3 is c2
    expect(n.net_profit).toBe(1500);
  });
});

describe("chaletProfitability", () => {
  it("ranks by net, attributes expenses by chalet, isolates unattributed", () => {
    const p = chaletProfitability(CHALETS, BOOKINGS, EXPENSES, JULY);
    expect(p.chalets.map((c) => c.chalet_id)).toEqual(["c1", "c2"]); // net desc
    expect(p.chalets[0]).toMatchObject({ chalet_id: "c1", income: 1700, expenses: 200, net_profit: 1500 });
    expect(p.chalets[1]).toMatchObject({ chalet_id: "c2", income: 500, expenses: 100, net_profit: 400 });
    expect(p.unattributed_expenses).toBe(150); // e2 (no chalet)
  });
});

describe("compareMonths", () => {
  it("computes each month + A−B deltas and tolerates a big one-off expense", () => {
    const c = compareMonths(BOOKINGS, EXPENSES, "2026-07", "2026-06");
    expect(c.a).toMatchObject({ month: "2026-07", income: 2200, expenses: 450, net_profit: 1750, count: 3 });
    expect(c.b).toMatchObject({ month: "2026-06", income: 1000, expenses: 5000, net_profit: -4000, count: 1 });
    expect(c.delta).toMatchObject({ income: 1200, expenses: -4550, net_profit: 5750, count: 2 });
  });
  it("invalid month degrades to zeros (never all-time)", () => {
    const c = compareMonths(BOOKINGS, EXPENSES, "nope", "2026-06");
    expect(c.a).toMatchObject({ income: 0, expenses: 0, net_profit: 0, count: 0 });
  });
});

describe("topCustomers", () => {
  it("ranks by count then spend, names only, excludes cancelled", () => {
    const t = topCustomers(BOOKINGS, {});
    expect(t.customers).toEqual([
      { customer_name: "علي", count: 2, total: 1700 },
      { customer_name: "قديم", count: 1, total: 1000 },
      { customer_name: "سارة", count: 1, total: 500 },
    ]);
    // never a phone field anywhere in the payload
    expect(JSON.stringify(t)).not.toMatch(/phone|جوال|05\d/);
  });
  it("respects the limit", () => {
    expect(topCustomers(BOOKINGS, { limit: 1 }).customers).toHaveLength(1);
  });
});

describe("businessOverview", () => {
  it("this-month snapshot: income/expenses/net, upcoming, outstanding, top chalet", () => {
    const o = businessOverview({ chalets: CHALETS, bookings: BOOKINGS, expenses: EXPENSES }, "2026-07-13");
    expect(o).toMatchObject({
      month: "2026-07",
      chalet_count: 2,
      booking_count_total: 4, // b1,b2,b3,b5 (cancelled b4 & deleted b6 excluded)
      upcoming_count: 1, // only b3 (07-20) is >= 07-13
      month_income: 2200,
      month_expenses: 450,
      month_net: 1750,
      outstanding_total: 900, // b2 remaining 400 + b3 remaining 500
    });
    expect(o.top_chalet).toMatchObject({ chalet_name: "البحر", net_profit: 1500 });
  });
});
