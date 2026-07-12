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

// Canonical HH:mm validation (accepts a 1-digit hour and pads it, fixing the
// old mjs-vs-SQL "7:00" inconsistency). Times a Date can't parse are invalid.
export function normalizeTimeHHmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return String(h).padStart(2, "0") + ":" + m[2];
}

// FAIL-CLOSED gate for anything that books: a period is bookable only when
// both times are valid HH:mm and the interval is not zero-length. Missing or
// malformed times mean availability CANNOT be proven — «وقت الفترة غير مكتمل».
export function validatePeriodTimes(period) {
  const start = normalizeTimeHHmm(period?.start);
  const end = normalizeTimeHHmm(period?.end);
  if (!start || !end) return { ok: false, error: "PERIOD_TIME_INCOMPLETE" };
  if (start === end) return { ok: false, error: "PERIOD_TIME_INCOMPLETE" };
  return { ok: true, start, end };
}
export function isPeriodBookable(period) {
  return validatePeriodTimes(period);
}

// Epoch-ms interval for a booking's period on a specific date. null when the
// period's times are missing/malformed — callers must FAIL CLOSED on null
// (unknown time can never prove availability).
export function periodInterval(period, dateIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) return null;
  const t = validatePeriodTimes(period);
  if (!t.ok) return null;
  const s = new Date(`${dateIso}T${t.start}:00Z`).getTime();
  let e = new Date(`${dateIso}T${t.end}:00Z`).getTime();
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

// Owner-visible facts of a blocking booking (their OWN workspace data — the
// names here are the owner's customers, never another tenant's; no ids).
function conflictFacts(b, period) {
  const t = validatePeriodTimes(period || {});
  return {
    customer_name: String(b.customer_name || ""),
    booking_date: String(b.booking_date || ""),
    period_label: String(period?.label || ""),
    start: t.ok ? t.start : "",
    end: t.ok ? t.end : "",
  };
}

/**
 * Detailed availability verdict for a (chalet, date, candidatePeriod) slot.
 * { available: true } or { available: false, cause, conflict? } where cause:
 *  - "bad_candidate":    the candidate's own times are incomplete (unbookable);
 *  - "overlap":          a confirmed booking really overlaps (conflict carries
 *                        its owner-visible facts);
 *  - "unknown_interval": a confirmed booking's interval cannot be computed
 *                        (legacy data quality) so availability cannot be
 *                        PROVEN — fail closed, but the caller can now say WHY.
 * A real overlap wins over an unknown interval when both exist: the concrete
 * conflict is the actionable one. The boolean outcome is identical to the old
 * isSlotAvailable (available === no overlap AND no unknown interval).
 */
export function availabilityCheck(doc, chaletId, dateIso, candidatePeriod, { excludeBookingId } = {}) {
  const ci = periodInterval(candidatePeriod, dateIso);
  if (!ci) return { available: false, cause: "bad_candidate" };
  const chalet = activeChalets(doc).find((c) => String(c.id) === String(chaletId));
  if (!chalet) return { available: true };
  const byId = periodsOf(chalet);
  let unknown = null;
  for (const b of activeBookings(doc)) {
    if (b.status !== "confirmed" || String(b.chalet_id) !== String(chaletId)) continue;
    if (excludeBookingId && String(b.id) === String(excludeBookingId)) continue;
    const period = byId.get(String(b.period_id));
    const bi = periodInterval(period, String(b.booking_date));
    if (!bi) {
      // Cannot prove free — but keep scanning: a REAL overlap elsewhere is
      // the more actionable cause to report.
      if (!unknown) unknown = conflictFacts(b, period);
      continue;
    }
    if (intervalsOverlap(ci, bi)) {
      return { available: false, cause: "overlap", conflict: conflictFacts(b, period) };
    }
  }
  if (unknown) return { available: false, cause: "unknown_interval", conflict: unknown };
  return { available: true };
}

// "2026-07-15" -> "15-07-2026" (display order); input echoed when not ISO.
function displayDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || "")) ? String(iso).split("-").reverse().join("-") : String(iso || "");
}

/**
 * Owner-safe {error, reason_ar} for a failed availabilityCheck — the ONE
 * place that words the difference between a real overlap and a data-quality
 * block, reused by executors and the resolver. null for an available slot.
 * opts.tail: closing sentence («لم يتم حفظ أي تغيير.» by default; the resolver
 * passes «لم يتم تجهيز أي حجز.» because nothing was prepared yet).
 */
export function availabilityFailureAr(check, { tail } = {}) {
  if (!check || check.available) return null;
  const end = typeof tail === "string" && tail ? tail : "لم يتم حفظ أي تغيير.";
  const c = check.conflict || {};
  const who = c.customer_name ? `«${c.customer_name}»` : "";
  const when = c.booking_date ? ` بتاريخ ${displayDate(c.booking_date)}` : "";
  const at = c.start && c.end ? ` (${c.start}–${c.end})` : "";
  if (check.cause === "overlap") {
    return {
      error: "BOOKING_CONFLICT",
      reason_ar: `هذه الفترة محجوزة بالفعل — تتعارض مع حجز ${who || "قائم"}${when}${at}. ${end}`,
    };
  }
  if (check.cause === "unknown_interval") {
    return {
      error: "AVAILABILITY_UNPROVABLE",
      reason_ar:
        `لا يمكن التأكد من توفر هذه الفترة: يوجد حجز${who ? ` باسم ${who}` : " قديم"}${when} بوقت فترة غير مكتمل لهذا الشاليه. ` +
        `أكمل وقت الفترة من «جودة البيانات» في الإعدادات ثم أعد المحاولة. ${end}`,
    };
  }
  return { error: "PERIOD_TIME_INCOMPLETE", reason_ar: "وقت الفترة غير مكتمل. أكمل وقت البداية والنهاية من تبويب الشاليهات ثم أعد المحاولة." };
}

/**
 * Boolean wrapper kept for every call site that only needs yes/no — the
 * FAIL-CLOSED contract is unchanged (see availabilityCheck).
 */
export function isSlotAvailable(doc, chaletId, dateIso, candidatePeriod, opts = {}) {
  return availabilityCheck(doc, chaletId, dateIso, candidatePeriod, opts).available;
}

/** Available active periods for a chalet on a date (overlap-aware). Periods
 * with incomplete times are excluded up front (they are not bookable). */
export function availablePeriodsOn(doc, chaletId, dateIso, opts = {}) {
  const chalet = activeChalets(doc).find((c) => String(c.id) === String(chaletId));
  if (!chalet) return { error: "NOT_FOUND" };
  const periods = (chalet.periods || []).filter((p) => p.active && isPeriodBookable(p).ok);
  const available = periods.filter((p) => isSlotAvailable(doc, chaletId, dateIso, p, opts));
  return { chalet_id: chalet.id, date: dateIso, available };
}

export const _RIYADH_OFFSET_MS = RIYADH_OFFSET_MS;
