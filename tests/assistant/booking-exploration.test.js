import { describe, expect, it } from "vitest";
import { executeConfirmedAction } from "../../supabase/functions/_shared/assistant/executors.mjs";
import { isSlotAvailable } from "../../supabase/functions/_shared/assistant/availability.mjs";

// «اصنع ٣٠ حجز تستكشف فيه الأخطاء من الحجوزات» — an exploratory sweep that pushes
// 30 diverse bookings through the REAL confirmed-booking executor + validators
// over an in-memory document, and asserts each behaves correctly: accept/reject,
// time-range conflict (incl. 24h + post-midnight night-anchor), capacity, past
// date, zero/free total, guests-optional (F2), and cancel. Any regression here
// is a real booking bug. Dates below are pinned (2099) so they never go stale.

const WEEKDAY = "2099-08-04"; // Tuesday
const WEEKEND = "2099-08-07"; // Friday (KSA weekend)
const PAST = "2000-01-01";

function makeDoc() {
  return {
    chalets: [
      {
        id: "c1", name: "شاليه أ", capacity: 6, deleted_at: null,
        periods: [
          { id: "p-day", label: "صباحي", start: "07:00", end: "17:00", active: true, weekday_price: 300, weekend_price: 450 },
          { id: "p-night", label: "ليلي", start: "19:00", end: "05:00", active: true, weekday_price: 400, weekend_price: 600 }, // wraps
          { id: "p-mid", label: "بعد منتصف الليل", start: "00:00", end: "05:00", active: true, weekday_price: 200, weekend_price: 300 }, // post-midnight
          { id: "p-full", label: "يوم كامل", start: "12:00", end: "12:00", active: true, weekday_price: 900, weekend_price: 1200 }, // 24h (F4b)
        ],
      },
      { id: "c2", name: "شاليه ب", capacity: 20, deleted_at: null, periods: [{ id: "q-day", label: "صباحي", start: "08:00", end: "14:00", active: true, weekday_price: 250, weekend_price: 400 }] },
    ],
    bookings: [],
    expenses: [],
  };
}

function makeDeps(doc) {
  let rev = 1;
  let seq = 0;
  return {
    newId: () => "gen-" + (++seq),
    async getWorkspaceDoc() { return { data: doc, updated_at: "r" + rev }; },
    async saveWorkspaceV2(_k, _p, dataObj, expected) {
      if ("r" + rev !== expected) return { ok: false, error: "WORKSPACE_DATA_CONFLICT" };
      if (Array.isArray(dataObj.bookings)) doc.bookings = dataObj.bookings;
      if (Array.isArray(dataObj.expenses)) doc.expenses = dataObj.expenses;
      rev += 1;
      return { ok: true, updated_at: "r" + rev, data: doc };
    },
  };
}

let actionSeq = 0;
async function book(deps, args) {
  actionSeq += 1;
  return executeConfirmedAction(
    {
      wsKey: "WS", pin: "123456", toolName: "confirm_booking_create", actionId: "act-" + actionSeq,
      payload: { args: { booking_id: "b-" + actionSeq, customer_name: "عميل " + actionSeq, chalet_id: "c1", booking_date: WEEKDAY, period_id: "p-day", guests: 2, total: 300, ...args } },
    },
    deps,
  );
}

describe("30-booking exploration: the real executor accepts/rejects correctly", () => {
  // ---- Phase 1: 20 INDEPENDENT bookings (fresh doc each) — the validation matrix.
  const matrix = [
    // valid across every period type + both chalets + weekday/weekend
    { d: "1 صباحي يوم أسبوع", a: { period_id: "p-day", booking_date: WEEKDAY }, ok: true },
    { d: "2 ليلي (يلتف)", a: { period_id: "p-night", total: 400 }, ok: true },
    { d: "3 بعد منتصف الليل", a: { period_id: "p-mid", total: 200 }, ok: true },
    { d: "4 يوم كامل ٢٤ ساعة (F4b)", a: { period_id: "p-full", total: 900 }, ok: true },
    { d: "5 نهاية الأسبوع", a: { period_id: "p-day", booking_date: WEEKEND }, ok: true },
    { d: "6 شاليه آخر", a: { chalet_id: "c2", period_id: "q-day", total: 250 }, ok: true },
    { d: "7 بلا عدد ضيوف (F2 → 1)", a: { guests: undefined }, ok: true, guests1: true },
    { d: "8 ضيوف = السعة تماماً", a: { guests: 6 }, ok: true },
    { d: "9 حجز مجاني صريح", a: { total: 0, total_is_free: true }, ok: true },
    { d: "10 عربون جزئي", a: { paid: 100 }, ok: true },
    // rejections
    { d: "11 تاريخ ماضٍ", a: { booking_date: PAST }, error: "PAST_DATE" },
    { d: "12 ضيوف يتجاوز السعة", a: { guests: 9 }, error: "GUESTS_EXCEED_CAPACITY" },
    { d: "13 إجمالي صفر بلا مجاني", a: { total: 0 }, error: "INVALID_TOTAL" },
    { d: "14 بلا اسم عميل", a: { customer_name: "" }, error: "CUSTOMER_NAME_REQUIRED" },
    { d: "15 شاليه غير موجود", a: { chalet_id: "nope" }, error: "CHALET_NOT_FOUND" },
    { d: "16 فترة غير موجودة", a: { period_id: "nope" }, error: "PERIOD_NOT_FOUND" },
    { d: "17 تاريخ غير صحيح", a: { booking_date: "2099-13-40" }, error: "INVALID_DATE" },
    { d: "18 جوال غير صحيح", a: { customer_phone: "12", }, error: "INVALID_PHONE" },
    { d: "19 ضيوف = صفر (F2 → 1)", a: { guests: 0 }, ok: true, guests1: true },
    { d: "20 يوم كامل نهاية الأسبوع", a: { period_id: "p-full", booking_date: WEEKEND, total: 1200 }, ok: true },
  ];

  it.each(matrix)("$d", async ({ a, ok, error, guests1 }) => {
    const doc = makeDoc();
    const deps = makeDeps(doc);
    const r = await book(deps, a);
    if (ok) {
      expect(r.ok).toBe(true);
      expect(doc.bookings).toHaveLength(1);
      if (guests1) expect(doc.bookings[0].guests).toBe(1);
    } else {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(error);
      expect(doc.bookings).toHaveLength(0);
    }
  });

  // ---- Phase 2: 10 STATEFUL bookings on ONE accumulating doc — conflict/availability/cancel.
  it("10 stateful bookings: conflicts detected, free slots accepted, cancel frees the day", async () => {
    const doc = makeDoc();
    const deps = makeDeps(doc);

    // 21: day booked.
    expect((await book(deps, { period_id: "p-day", booking_date: WEEKDAY })).ok).toBe(true);
    // 22: night the SAME date is a different interval → accepted (07-17 vs 19-05).
    expect((await book(deps, { period_id: "p-night", booking_date: WEEKDAY, total: 400 })).ok).toBe(true);
    // 23: post-midnight the same date OVERLAPS the night tail → conflict.
    let r = await book(deps, { period_id: "p-mid", booking_date: WEEKDAY, total: 200 });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/CONFLICT|OVERLAP|NOT_AVAILABLE|AVAILABILITY/i);
    // 24: same day is bookable at c2 (a different chalet).
    expect((await book(deps, { chalet_id: "c2", period_id: "q-day", booking_date: WEEKDAY, total: 250 })).ok).toBe(true);
    // 25: a 24h booking on a FREE date.
    expect((await book(deps, { period_id: "p-full", booking_date: WEEKEND, total: 900 })).ok).toBe(true);
    // 26: ANY other period that same date now conflicts with the 24h slot.
    r = await book(deps, { period_id: "p-day", booking_date: WEEKEND });
    expect(r.ok).toBe(false);
    // 27: a «١٢→١٢» period is NOON→NOON (24h), so it bleeds into the next
    // morning — a p-day (07:00-17:00) booking the NEXT day conflicts on
    // 07:00-12:00 — while two days out is fully clear of the noon→noon window.
    expect((await book(deps, { period_id: "p-day", booking_date: "2099-08-08" })).ok).toBe(false);
    expect((await book(deps, { period_id: "p-day", booking_date: "2099-08-09" })).ok).toBe(true);
    // 28: a duplicate confirmed create (same booking_id) is idempotent — no 2nd row.
    const before = doc.bookings.length;
    const dup = await executeConfirmedAction(
      { wsKey: "WS", pin: "123456", toolName: "confirm_booking_create", actionId: "act-dup", payload: { args: { booking_id: doc.bookings[0].id, customer_name: doc.bookings[0].customer_name, chalet_id: "c1", booking_date: WEEKDAY, period_id: "p-day", guests: 2, total: 300 } } },
      deps,
    );
    expect(dup.ok).toBe(true);
    expect(doc.bookings.length).toBe(before);
    // 29: cancelling the 24h WEEKEND booking (status → cancelled) frees that date.
    const full = doc.bookings.find((b) => b.period_id === "p-full");
    full.status = "cancelled";
    expect(isSlotAvailable(doc, "c1", WEEKEND, doc.chalets[0].periods[0])).toBe(true);
    // 30: re-booking the freed WEEKEND day now succeeds.
    expect((await book(deps, { period_id: "p-day", booking_date: WEEKEND })).ok).toBe(true);
  });
});
