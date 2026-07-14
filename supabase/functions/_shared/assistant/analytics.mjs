// Analytical "business insight" reads for the assistant — the G2 brain.
//
// Every function is PURE and derives from the workspace document (the same
// jsonb the server already fetches), so no new data source and no migration.
//
// MONEY UNITS: booking `total`/`paid` and expense `amount` are all stored as
// WHOLE RIYALS in the document (NOT halalas — the payment ledger is the only
// halalas surface). Everything here sums doc amounts as-is, so `net_profit`
// equals the browser's runReport net (booking total − expenses) exactly and
// never mixes the two unit systems.
//
// PRIVACY: nothing here emits a phone number. topCustomers ranks by NAME only
// (names already appear in ordinary booking lists); results still pass through
// the caller's redactObject.

import { bookingRowsForList, monthRangeIso } from "./booking-reads.mjs";

// Active (non-deleted) expense rows — mirrors the browser's activeExpenses().
export function activeExpenseRows(expenses) {
  return (Array.isArray(expenses) ? expenses : []).filter((e) => e && !e.deleted_at);
}

// A date string is within [lo,hi] (each bound optional → open on that side).
function inRange(dateStr, lo, hi) {
  const d = String(dateStr || "");
  if (!d) return false;
  if (lo && d < lo) return false;
  if (hi && d > hi) return false;
  return true;
}

// Previous "YYYY-MM" for a "YYYY-MM" key (e.g. "2026-01" → "2025-12").
export function prevMonthKey(ym) {
  const m = String(ym || "").slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return "";
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12 : mo - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

// Expense total + breakdown by category over [from,to]. Categories sorted by
// spend, largest first. Uncategorized expenses fold into «أخرى».
export function expenseSummary(expenses, { from = "", to = "" } = {}) {
  const lo = String(from || "");
  const hi = String(to || "");
  const rows = activeExpenseRows(expenses).filter((e) => inRange(e.date, lo, hi));
  const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const byCat = new Map();
  for (const e of rows) {
    const cat = String(e.category || "").trim() || "أخرى";
    byCat.set(cat, (byCat.get(cat) || 0) + (Number(e.amount) || 0));
  }
  const by_category = [...byCat.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  return { expense_summary: true, total, count: rows.length, by_category, from: lo, to: hi };
}

// Net profit = booking income − expenses over [from,to], optionally scoped to
// one chalet. Income is the AGREED booking value (`total`) of ACTIVE bookings
// (non-deleted, non-cancelled) — identical to the browser report's basis.
export function netProfit(bookings, expenses, { from = "", to = "", chalet_id = "" } = {}) {
  const lo = String(from || "");
  const hi = String(to || "");
  const cid = String(chalet_id || "");
  const bRows = bookingRowsForList(bookings).filter(
    (b) => inRange(b.booking_date, lo, hi) && (!cid || String(b.chalet_id || "") === cid),
  );
  const income = bRows.reduce((s, b) => s + (Number(b.total) || 0), 0);
  const eRows = activeExpenseRows(expenses).filter(
    (e) => inRange(e.date, lo, hi) && (!cid || String(e.chalet_id || "") === cid),
  );
  const expenses_total = eRows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    net: true,
    income,
    expenses: expenses_total,
    net_profit: income - expenses_total,
    from: lo,
    to: hi,
    chalet_id: cid,
  };
}

// Per-chalet income − attributed expenses, ranked most-profitable first.
// Expenses are attributed by `expense.chalet_id`; expenses with no (or an
// unknown) chalet are reported separately as `unattributed_expenses` so they
// are never silently dropped from the owner's mental total.
export function chaletProfitability(chalets, bookings, expenses, { from = "", to = "" } = {}) {
  const lo = String(from || "");
  const hi = String(to || "");
  const activeC = (Array.isArray(chalets) ? chalets : []).filter((c) => c && !c.deleted_at);
  const nameById = new Map(activeC.map((c) => [String(c.id || ""), String(c.name || "")]));
  const acc = new Map(); // chalet_id -> { income, expenses }
  const bump = (id, key, amt) => {
    const k = String(id || "");
    if (!acc.has(k)) acc.set(k, { income: 0, expenses: 0 });
    acc.get(k)[key] += amt;
  };
  for (const b of bookingRowsForList(bookings).filter((b) => inRange(b.booking_date, lo, hi))) {
    bump(b.chalet_id, "income", Number(b.total) || 0);
  }
  let unattributed_expenses = 0;
  for (const e of activeExpenseRows(expenses).filter((e) => inRange(e.date, lo, hi))) {
    const cid = String(e.chalet_id || "");
    if (cid && (nameById.has(cid) || acc.has(cid))) bump(cid, "expenses", Number(e.amount) || 0);
    else unattributed_expenses += Number(e.amount) || 0;
  }
  const chaletsOut = [...acc.entries()]
    .map(([id, v]) => ({
      chalet_id: id,
      chalet_name: nameById.get(id) || id || "غير معروف",
      income: v.income,
      expenses: v.expenses,
      net_profit: v.income - v.expenses,
    }))
    .sort((a, b) => b.net_profit - a.net_profit);
  return { profitability: true, chalets: chaletsOut, unattributed_expenses, from: lo, to: hi };
}

// Compare two calendar months (each "YYYY-MM"): income, expenses, net, count,
// and A−B deltas. Invalid month strings degrade to zeros (never all-time).
export function compareMonths(bookings, expenses, monthA, monthB) {
  const mk = (m) => {
    const mm = String(m || "").slice(0, 7);
    const [yy, mo] = mm.split("-").map(Number);
    // Validate VALUE, not just shape: "2026-00"/"0000-07" are digit-shaped but
    // make monthRangeIso return empty (open) bounds, which would sum all-time.
    if (!/^\d{4}-\d{2}$/.test(mm) || !yy || !(mo >= 1 && mo <= 12)) {
      return { month: mm, income: 0, expenses: 0, net_profit: 0, count: 0 };
    }
    const np = netProfit(bookings, expenses, monthRangeIso(`${mm}-01`));
    const count = bookingRowsForList(bookings).filter((b) => String(b.booking_date || "").slice(0, 7) === mm).length;
    return { month: mm, income: np.income, expenses: np.expenses, net_profit: np.net_profit, count };
  };
  const a = mk(monthA);
  const b = mk(monthB);
  return {
    comparison: true,
    a,
    b,
    delta: {
      income: a.income - b.income,
      expenses: a.expenses - b.expenses,
      net_profit: a.net_profit - b.net_profit,
      count: a.count - b.count,
    },
  };
}

// Rank customers by booking count (then total spend) over [from,to]. NAMES
// ONLY — never a phone. Empty range = all time (overall best customers).
export function topCustomers(bookings, { from = "", to = "", limit = 5 } = {}) {
  const lo = String(from || "");
  const hi = String(to || "");
  const lim = Math.max(1, Math.min(50, Number(limit) || 5));
  const rows = bookingRowsForList(bookings).filter((b) => inRange(b.booking_date, lo, hi));
  const acc = new Map(); // name -> { count, total }
  for (const b of rows) {
    const name = String(b.customer_name || "").trim() || "بدون اسم";
    if (!acc.has(name)) acc.set(name, { count: 0, total: 0 });
    const rec = acc.get(name);
    rec.count += 1;
    rec.total += Number(b.total) || 0;
  }
  const customers = [...acc.entries()]
    .map(([customer_name, v]) => ({ customer_name, count: v.count, total: v.total }))
    .sort((a, b) => b.count - a.count || b.total - a.total)
    .slice(0, lim);
  return { top_customers: true, customers, from: lo, to: hi };
}

// A compact snapshot the model can reason over in one read: this-month income,
// expenses and net, plus counts, upcoming, outstanding, and the top chalet.
export function businessOverview(doc, todayIso) {
  const bookings = Array.isArray(doc?.bookings) ? doc.bookings : [];
  const expenses = Array.isArray(doc?.expenses) ? doc.expenses : [];
  const chalets = Array.isArray(doc?.chalets) ? doc.chalets : [];
  const today = String(todayIso || "");
  const range = monthRangeIso(today);
  const np = netProfit(bookings, expenses, range);
  const active = bookingRowsForList(bookings);
  const upcoming = active.filter((b) => String(b.booking_date || "") >= today).length;
  const outstanding = active.reduce((s, b) => s + Math.max(0, (Number(b.total) || 0) - (Number(b.paid) || 0)), 0);
  const prof = chaletProfitability(chalets, bookings, expenses, range);
  const top = prof.chalets[0];
  return {
    overview: true,
    month: today.slice(0, 7),
    chalet_count: chalets.filter((c) => c && !c.deleted_at).length,
    booking_count_total: active.length,
    upcoming_count: upcoming,
    month_income: np.income,
    month_expenses: np.expenses,
    month_net: np.net_profit,
    outstanding_total: outstanding,
    top_chalet: top ? { chalet_name: top.chalet_name, net_profit: top.net_profit } : null,
  };
}
