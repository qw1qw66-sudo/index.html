// availability.mjs — DETERMINISTIC period/time overlap + Asia/Riyadh calendar.
// Pure functions (no I/O, no ambient Date beyond the explicit helpers below) so
// the read tools, the booking executor and the vacancy planner all agree with
// the frontend's real conflict rule instead of a naive exact period-id match.
//
// The overlap rule is copied 1:1 from index.html (intervalFor + findConflict):
//   two CONFIRMED bookings on the SAME chalet conflict when their time
//   intervals overlap; a period whose end <= start wraps past midnight (+1 day);
//   a NON-wrapping period that starts before 06:00 belongs to the NIGHT of the
//   chosen date (both ends shift +1 day) — «الفترة التي تبدأ قبل ٦ صباحًا
//   تُحسب على ليلة التاريخ المحدد». Without that anchor, a 00:00–05:00 slot on
//   date D lands in D's PAST early morning and never collides with a D-dated
//   19:00–05:00 booking — the live «١٢ ساعة تحتوي ٥ ساعات» hole (IMG_6706).
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

// Night-anchor convention: a non-wrapping period that STARTS before this hour
// is the tail of the chosen date's NIGHT, not its past early morning.
export const NIGHT_ANCHOR_HOUR = 6;

// Shared date→interval anchoring (the ONLY place slot semantics live):
// wrapped periods extend into the next day; fully post-midnight periods shift
// whole into the next day so «ليلة التاريخ المحدد» always means one physical
// night. Mirrored 1:1 in index.html intervalFor and SQL migration 0008.
export function applyNightAnchor(start, end, startHour) {
  let s = start, e = end;
  if (e <= s) {
    e += 86400000; // wraps past midnight
  } else if (startHour < NIGHT_ANCHOR_HOUR) {
    s += 86400000; // post-midnight slot: belongs to the night of the date
    e += 86400000;
  }
  return { start: s, end: e };
}

// Epoch-ms interval for a booking's period on a specific date. null when the
// period's times are missing/malformed — callers must FAIL CLOSED on null
// (unknown time can never prove availability).
export function periodInterval(period, dateIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) return null;
  const t = validatePeriodTimes(period);
  if (!t.ok) return null;
  const s = new Date(`${dateIso}T${t.start}:00Z`).getTime();
  const e = new Date(`${dateIso}T${t.end}:00Z`).getTime();
  if (!isFinite(s) || !isFinite(e)) return null;
  return applyNightAnchor(s, e, Number(t.start.slice(0, 2)));
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

/**
 * EXACT JS twin of the SQL save guard `workspace_doc_booking_conflict`
 * (migrations/20260701000001): scans the WHOLE document for any overlapping
 * pair of confirmed bookings. The SQL guard rejects EVERY save while such a
 * pair exists — even when the new booking's own slot is free — so callers use
 * this to explain the block BEFORE attempting a save, instead of surfacing a
 * bare «BOOKING_CONFLICT:id:id». Parity notes (mirrors SQL, NOT the stricter
 * fail-closed rules above): chalets are looked up regardless of deleted_at
 * (first match by id), periods first-match by id (active or not), bookings
 * with unparseable dates/times are SKIPPED, end<=start wraps +24h.
 * Returns every { a, b } pair with owner-visible facts (scan order identical
 * to SQL). `findDocConflictPair` below preserves the original first-pair API.
 */
export function findDocConflictPairs(doc) {
  const bookings = Array.isArray(doc?.bookings) ? doc.bookings : [];
  const chalets = Array.isArray(doc?.chalets) ? doc.chalets : [];
  const rows = [];
  for (const b of bookings) {
    if (!b || b.status !== "confirmed") continue;
    const del = b.deleted_at;
    if (del !== null && del !== undefined && String(del) !== "") continue;
    const date = String(b.booking_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const chalet = chalets.find((c) => String(c?.id ?? "") === String(b.chalet_id ?? ""));
    if (!chalet) continue;
    const period = (chalet.periods || []).find((p) => String(p?.id ?? "") === String(b.period_id ?? ""));
    if (!period) continue;
    const sm = /^(\d{1,2}):(\d{2})$/.exec(String(period.start ?? ""));
    const em = /^(\d{1,2}):(\d{2})$/.exec(String(period.end ?? ""));
    if (!sm || !em) continue;
    const sh = Number(sm[1]), smin = Number(sm[2]), eh = Number(em[1]), emin = Number(em[2]);
    if (sh > 23 || smin > 59 || eh > 23 || emin > 59) continue; // SQL would error; treat as unparseable
    const base = new Date(`${date}T00:00:00Z`).getTime();
    if (!isFinite(base)) continue;
    const anchored = applyNightAnchor(
      base + (sh * 60 + smin) * 60000,
      base + (eh * 60 + emin) * 60000,
      sh,
    );
    const start = anchored.start;
    const end = anchored.end;
    rows.push({
      start, end,
      chalet_id: String(b.chalet_id ?? ""),
      facts: {
        id: String(b.id ?? ""),
        customer_name: String(b.customer_name || ""),
        booking_date: date,
        start: `${String(sh).padStart(2, "0")}:${sm[2]}`,
        end: `${String(eh).padStart(2, "0")}:${em[2]}`,
        chalet_name: String(chalet.name || ""),
      },
    });
  }
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (
        rows[i].chalet_id === rows[j].chalet_id &&
        rows[i].facts.id !== rows[j].facts.id &&
        rows[i].start < rows[j].end &&
        rows[i].end > rows[j].start
      ) {
        pairs.push({ a: rows[i].facts, b: rows[j].facts });
      }
    }
  }
  return pairs;
}

export function findDocConflictPair(doc) {
  return findDocConflictPairs(doc)[0] || null;
}

function docConflictPairKey(pair) {
  const ids = [String(pair?.a?.id || ""), String(pair?.b?.id || "")].sort();
  return `${ids[0]}\u0000${ids[1]}`;
}

// Migration 0007 grandfathers only conflict PAIRS that already existed in the
// stored document. This is its JS twin for executors/tests: unrelated legacy
// corruption may remain untouched, while any newly introduced pair is still
// rejected fail-closed.
export function findNewDocConflictPair(oldDoc, nextDoc) {
  const oldKeys = new Set(findDocConflictPairs(oldDoc).map(docConflictPairKey));
  return findDocConflictPairs(nextDoc).find((pair) => !oldKeys.has(docConflictPairKey(pair))) || null;
}

// Owner-safe wording for a whole-document conflict pair: names both bookings
// and sends the owner to the bookings tab — rebooking another slot can NEVER
// fix this (the SQL guard rejects every save until the pair is resolved).
export function docConflictReasonAr(pair, { tail } = {}) {
  const end = typeof tail === "string" && tail ? tail : "لم يتم حفظ أي تغيير.";
  const one = (f) =>
    `«${f.customer_name || "بدون اسم"}» بتاريخ ${displayDate(f.booking_date)} (${f.start}–${f.end})`;
  return (
    `لا يمكن حفظ أي حجز الآن: يوجد تعارض قائم في بياناتك بين حجز ${one(pair.a)} ` +
    `وحجز ${one(pair.b)} على «${pair.a.chalet_name || "نفس الشاليه"}». ` +
    `أصلح هذا التعارض من تبويب الحجوزات (عدّل أو ألغِ أحدهما) ثم أعد المحاولة. ${end}`
  );
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
