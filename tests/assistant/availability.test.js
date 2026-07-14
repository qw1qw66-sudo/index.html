import { describe, expect, it } from "vitest";
import {
  NIGHT_ANCHOR_HOUR,
  applyNightAnchor,
  availabilityCheck,
  availablePeriodsOn,
  findDocConflictPair,
  findDocConflictPairs,
  findNewDocConflictPair,
  isPeriodBookable,
  isSlotAvailable,
  periodInterval,
  validatePeriodTimes,
} from "../../supabase/functions/_shared/assistant/availability.mjs";
import { isVacancyStillEmpty } from "../../supabase/functions/_shared/assistant/vacancy.mjs";

// Night-anchoring (IMG_6706 «سالفة التوقيت»): a booking's slot is ONE physical
// night — a non-wrapping period that starts before 06:00 belongs to the night
// of its booking_date, so the middle hours of an occupied night can never
// read «متاحة» again. Same rule in availability.mjs, index.html intervalFor
// and SQL migration 0008.

const D = "2099-07-12";
const D1 = "2099-07-13";

const PERIODS = [
  { id: "night", label: "ليلة كاملة", start: "19:00", end: "05:00", active: true, sort: 1 }, // wraps
  { id: "mid", label: "منتصف الليل", start: "00:00", end: "05:00", active: true, sort: 2 }, // post-midnight
  { id: "late", label: "سهرة متأخرة", start: "04:00", end: "06:00", active: true, sort: 3 },
  { id: "dawn", label: "فجر", start: "05:00", end: "07:00", active: true, sort: 4 },
  { id: "day", label: "دوام", start: "07:00", end: "17:00", active: true, sort: 5 },
  { id: "eve", label: "سهرة", start: "19:00", end: "00:00", active: true, sort: 6 }, // wraps (ends midnight)
  { id: "wrapnight", label: "ليلي", start: "22:00", end: "02:00", active: true, sort: 7 }, // wraps
  { id: "onedigit", label: "صباح مختصر", start: "7:00", end: "9:00", active: true, sort: 8 }, // 1-digit hours
];

function doc(bookings = []) {
  return {
    chalets: [{ id: "c1", name: "شاليه تولوم", capacity: 10, deleted_at: null, periods: PERIODS.map((p) => ({ ...p })) }],
    bookings,
  };
}
function bk(id, periodId, date) {
  return {
    id, customer_name: "عميل " + id, chalet_id: "c1", booking_date: date,
    period_id: periodId, guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null,
  };
}
const period = (id) => PERIODS.find((p) => p.id === id);

describe("night-anchored intervals", () => {
  it("shifts a non-wrapping pre-06:00 period into the night of its date; wrap rule unchanged", () => {
    expect(NIGHT_ANCHOR_HOUR).toBe(6);
    const base = new Date(`${D}T00:00:00Z`).getTime();
    const dayIv = periodInterval(period("day"), D);
    expect(dayIv.start).toBe(base + 7 * 3600000); // same day
    const midIv = periodInterval(period("mid"), D);
    expect(midIv.start).toBe(base + 24 * 3600000); // next-day 00:00 = night of D
    expect(midIv.end).toBe(base + 29 * 3600000);
    const nightIv = periodInterval(period("night"), D);
    expect(nightIv.end).toBe(base + 29 * 3600000); // wraps to D+1 05:00
    // Helper is pure and reused by every engine twin.
    expect(applyNightAnchor(10, 5, 19)).toEqual({ start: 10, end: 5 + 86400000 });
  });

  it("THE LIVE BUG: the 5 hours inside a booked 12-hour night now read محجوزة", () => {
    const d = doc([bk("b-night", "night", D)]);
    const check = availabilityCheck(d, "c1", D, period("mid"));
    expect(check).toMatchObject({ available: false, cause: "overlap" });
    expect(check.conflict.customer_name).toBe("عميل b-night");
    // And symmetrically: a stored post-midnight booking blocks the long night.
    const d2 = doc([bk("b-mid", "mid", D)]);
    expect(isSlotAvailable(d2, "c1", D, period("night"))).toBe(false);
  });

  it("the SAME slot on the NEXT date is the next night — free (convention pin)", () => {
    const d = doc([bk("b-night", "night", D)]);
    expect(isSlotAvailable(d, "c1", D1, period("mid"))).toBe(true);
    expect(isSlotAvailable(d, "c1", D1, period("day"))).toBe(true); // tail ends 05:00 < 07:00
  });

  it("04:00–06:00 overlaps the night's tail; dawn 05:00–07:00 is adjacent (half-open)", () => {
    const d = doc([bk("b-night", "night", D)]);
    expect(isSlotAvailable(d, "c1", D, period("late"))).toBe(false); // 04:00 < 05:00 tail
    expect(isSlotAvailable(d, "c1", D, period("dawn"))).toBe(true); // starts exactly at 05:00
    // Documented: «فجر» dated D is the morning that ENDS the night of D.
    const late = doc([bk("b-late", "late", D)]);
    expect(isSlotAvailable(late, "c1", D, period("dawn"))).toBe(false); // 05:00–06:00 overlap
  });

  it("adjacency stays bookable: سهرة حتى منتصف الليل + منتصف الليل حتى الفجر, same date", () => {
    const d = doc([bk("b-eve", "eve", D)]); // [D 19:00, D+1 00:00)
    expect(isSlotAvailable(d, "c1", D, period("mid"))).toBe(true); // [D+1 00:00, D+1 05:00)
  });

  it("wrapped periods still conflict as before (ليلي 22:00–02:00 vs الليلة الكاملة)", () => {
    const d = doc([bk("b-night", "night", D)]);
    expect(isSlotAvailable(d, "c1", D, period("wrapnight"))).toBe(false);
  });

  it("1-digit times («7:00») participate in conflicts exactly like padded times", () => {
    const d = doc([bk("b-7", "onedigit", D)]);
    expect(isSlotAvailable(d, "c1", D, period("day"))).toBe(false); // 07-09 inside 07-17
  });

  it("availablePeriodsOn drops every slot of the occupied night, keeps the free day", () => {
    const d = doc([bk("b-night", "night", D)]);
    const ids = availablePeriodsOn(d, "c1", D).available.map((p) => p.id);
    expect(ids).toContain("day");
    expect(ids).toContain("dawn");
    expect(ids).not.toContain("mid");
    expect(ids).not.toContain("late");
    expect(ids).not.toContain("night");
    expect(ids).not.toContain("eve");
    expect(ids).not.toContain("wrapnight");
  });

  it("doc guard sees the containment pair; a pre-existing (shift-revealed) pair stays grandfathered", () => {
    const conflicted = doc([bk("old-night", "night", D), bk("old-mid", "mid", D)]);
    const pair = findDocConflictPair(conflicted);
    expect(pair).toBeTruthy();
    // An unrelated safe edit to a doc that ALREADY held the revealed pair
    // must not be blocked (same contract as SQL new_booking_conflict).
    const next = doc([bk("old-night", "night", D), bk("old-mid", "mid", D), bk("new-safe", "day", D1)]);
    expect(findNewDocConflictPair(conflicted, next)).toBeNull();
    // A NEWLY introduced containment pair is still rejected.
    const clean = doc([bk("old-night", "night", D)]);
    const bad = doc([bk("old-night", "night", D), bk("new-mid", "mid", D)]);
    const fresh = findNewDocConflictPair(clean, bad);
    expect(fresh).toBeTruthy();
    expect(findDocConflictPairs(bad)).toHaveLength(1);
  });

  it("vacancy re-check fails CLOSED when the chalet/period can no longer be resolved", () => {
    const d = doc([]);
    expect(isVacancyStillEmpty(d, { chalet_id: "c1", date: D, period_id: "day" })).toBe(true);
    expect(isVacancyStillEmpty(d, { chalet_id: "c1", date: D, period_id: "gone" })).toBe(false);
    expect(isVacancyStillEmpty(d, { chalet_id: "no-such", date: D, period_id: "day" })).toBe(false);
  });
});

// F4b — a FULL-DAY (24h) period whose start EQUALS its end («١٢ إلى ١٢»). The
// interval math already folds it into a 24h wrap; F4b lifts the validity gate so
// it becomes bookable across every layer (browser + availability.mjs + SQL).
describe("F4b: a full-day 24h period (start === end)", () => {
  const full = { id: "full", label: "يوم كامل", start: "12:00", end: "12:00", active: true, sort: 9 };
  const noon = new Date(`${D}T12:00:00Z`).getTime();

  it("is bookable — validatePeriodTimes / isPeriodBookable accept it", () => {
    expect(validatePeriodTimes(full).ok).toBe(true);
    expect(isPeriodBookable(full).ok).toBe(true);
    // A period with a MISSING time is still rejected (fail-closed unchanged).
    expect(validatePeriodTimes({ start: "", end: "12:00" }).ok).toBe(false);
  });

  it("has exactly a 24-hour interval [T .. T+1day]", () => {
    const iv = periodInterval(full, D);
    expect(iv.start).toBe(noon);
    expect(iv.end).toBe(noon + 24 * 3600000);
    // Matches the browser intervalFor / SQL e<=s wrap rule bit-for-bit.
    expect(applyNightAnchor(noon, noon, 12)).toEqual({ start: noon, end: noon + 86400000 });
  });

  it("occupies its whole date but frees the next date", () => {
    const d = doc([bk("f1", "full", D)]);
    d.chalets[0].periods.push({ ...full });
    // Every other slot on this chalet/date now conflicts with the 24h booking…
    expect(isSlotAvailable(d, "c1", D, period("day"))).toBe(false);
    expect(isSlotAvailable(d, "c1", D, period("night"))).toBe(false);
    // …but the SAME 24h period on the NEXT date is a different night → free.
    expect(isSlotAvailable(d, "c1", D1, full)).toBe(true);
  });

  it("a second 24h booking on the same date conflicts; availablePeriodsOn drops all slots", () => {
    const d = doc([bk("f1", "full", D)]);
    d.chalets[0].periods.push({ ...full });
    expect(isSlotAvailable(d, "c1", D, full)).toBe(false); // day already fully taken
    expect(availablePeriodsOn(d, "c1", D).available.map((p) => p.id)).not.toContain("day");
  });
});
