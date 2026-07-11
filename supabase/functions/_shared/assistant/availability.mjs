// availability.mjs — DETERMINISTIC period/time overlap + Asia/Riyadh calendar.
// Pure functions (no I/O, no ambient Date beyond the explicit helpers below) so
// the read tools, the booking executor and the vacancy planner all agree with
// the frontend's real conflict rule instead of a naive exact period-id match.
//
// The overlap rule is copied 1:1 from index.html (intervalFor + findConflict):
//   two CONFIRMED bookings on the SAME chalet conflict when their time
//   intervals overlap; a period whose end <= start wraps past midnight (+1 day).
// A candidate (chalet, date, period) is therefore UNAVAILABLE when any
// confirmed, non-deleted booking of that chalet has an overlapping interval.

// KSA has used a fixed +03:00 offset (no DST) for decades; Asia/Riyadh == UTC+3.
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

// Today's date (YYYY-MM-DD) in Asia/Riyadh for a given epoch-ms "now".
export function riyadhToday(nowMs) {
  const base = typeof nowMs === "number" ? nowMs : Date.now();
  return new Date(base + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

// Add n days to a YYYY-MM-DD string (calendar arithmetic, tz-independent).
export function addDays(dateIso, n) {
  const [y, m, d] = String(dateIso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Epoch-ms interval for a booking's period on a specific date. null when the
// period lacks start/end times (cannot reason about overlap — treated as
// "does not block", mirroring intervalFor returning null).
export function periodInterval(period, dateIso) {
  if (!period || !period.start || !period.end || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) return null;
  const s = new Date(`${dateIso}T${period.start}:00Z`).getTime();
  let e = new Date(`${dateIso}T${period.end}:00Z`).getTime();
  if (!isFinite(s) || !isFinite(e)) return null;
  if (e <= s) e += 86400000; // wraps past midnight
  return { start: s, end: e };
}

export function intervalsOverlap(a, b) {
  return Boolean(a && b && a.start < b.end && a.end > b.start);
}

function activeChalets(doc) { return (doc?.chalets || []).filter((c) => !c.deleted_at); }
function activeBookings(doc) { return (doc?.bookings || []).filter((b) => !b.deleted_at); }

function periodsOf(chalet) {
  const m = new Map();
  for (const p of (chalet?.periods || [])) m.set(String(p.id), p);
  return m;
}

/**
 * Is the (chalet, date, candidatePeriod) slot free of confirmed bookings?
 * Uses time-interval overlap across ALL confirmed bookings of that chalet
 * (so a wrap-past-midnight booking on the prior day is still considered).
 */
export function isSlotAvailable(doc, chaletId, dateIso, candidatePeriod, { excludeBookingId } = {}) {
  const ci = periodInterval(candidatePeriod, dateIso);
  if (!ci) return true; // no times => cannot conflict (matches intervalFor null)
  const chalet = activeChalets(doc).find((c) => String(c.id) === String(chaletId));
  if (!chalet) return true;
  const byId = periodsOf(chalet);
  for (const b of activeBookings(doc)) {
    if (b.status !== "confirmed" || String(b.chalet_id) !== String(chaletId)) continue;
    if (excludeBookingId && String(b.id) === String(excludeBookingId)) continue;
    const bi = periodInterval(byId.get(String(b.period_id)), String(b.booking_date));
    if (intervalsOverlap(ci, bi)) return false;
  }
  return true;
}

/** Available active periods for a chalet on a date (overlap-aware). */
export function availablePeriodsOn(doc, chaletId, dateIso, opts = {}) {
  const chalet = activeChalets(doc).find((c) => String(c.id) === String(chaletId));
  if (!chalet) return { error: "NOT_FOUND" };
  const periods = (chalet.periods || []).filter((p) => p.active);
  const available = periods.filter((p) => isSlotAvailable(doc, chaletId, dateIso, p, opts));
  return { chalet_id: chalet.id, date: dateIso, available };
}

export const _RIYADH_OFFSET_MS = RIYADH_OFFSET_MS;
