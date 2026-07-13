// Resolve human chalet/period names against the authoritative workspace
// document. No model-generated id is trusted: every successful result binds the
// real ids that already exist in this workspace, or fails closed with real
// choices from the document.

import { availabilityCheck, availabilityFailureAr, isPeriodBookable, normalizeTimeHHmm } from "./availability.mjs";
import { foldDigits, parseTimeExpression } from "./nl-normalize.mjs";

const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g;
// «شالية» (taa-marbuta) is how owners actually type it on phones — it must
// strip exactly like «شاليه» so «شالية تولوم» matches the stored name.
const CHALET_WORDS = new Set(["شاليه", "الشاليه", "شالية", "الشالية", "شاليهات", "الشاليهات", "شاليات", "chalet", "chalets"]);
const PERIOD_WORDS = new Set(["فترة", "الفترة", "فترات", "الفترات", "period", "periods"]);

function normalizedTokens(value, ignored) {
  // Fold Arabic-Indic/Persian digits to ASCII first — NFKC does NOT, so
  // «تولوم ٢» (phone keyboard) would otherwise never match the stored
  // «شاليه تولوم 2» and the substring fallback picks the wrong sibling.
  // Letter↔digit boundaries then split into their own tokens so the glued
  // phone spelling «فترة5» tokenizes exactly like the stored «فترة 5» —
  // stripping the period word leaves the same key either way (IMG_6708).
  return foldDigits(String(value ?? ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    // Casual elongation by REPEATING a base letter («تووولوم», «صبااااحي») is
    // as common as tatweel emphasis — collapse any run of 3+ identical letters
    // to one so it matches the stored spelling (tatweel itself is already
    // stripped by ARABIC_MARKS). Genuine doubled letters (2) are preserved.
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((token) => !ignored.has(token));
}

export function normalizeChaletLookup(value) {
  return normalizedTokens(value, CHALET_WORDS).join("");
}

// Morphology folding WITHIN one word family («مسائية»→«مساء», «بالليل»→«ليل»)
// — never across families. This is the strict first matching pass, so a
// chalet that has BOTH a «مسائي» and a «ليلي» period resolves «المسائية» to
// the evening one and «بالليل» to the night one instead of "ambiguous".
const FAMILY_CANON = {
  صباح: "صباح", صباحي: "صباح", صباحية: "صباح", الصبح: "صباح", فجر: "صباح", فجري: "صباح",
  مساء: "مساء", مسائي: "مساء", مسائية: "مساء", مسايي: "مساء", مسايية: "مساء",
  ليل: "ليل", ليلي: "ليل", ليلية: "ليل", بالليل: "ليل", ليلا: "ليل", الليلة: "ليل",
  عشاء: "عشاء", عشائية: "عشاء",
  نهار: "نهار", نهاري: "نهار", نهارية: "نهار",
  ظهر: "ظهر", ظهيرة: "ظهر", عصري: "عصر", عصر: "عصر", ضحى: "ضحى", الضحى: "ضحى",
};
// Owners say «بالليل/ليلاً/عشاء» for the evening-to-morning slot; real chalets
// often label it «مسائي». Cross-family fallback used only when the strict
// pass found nothing.
const CROSS_FAMILY = { ليل: "مساء", عشاء: "مساء" };

// Spoken number words → digits, for PERIOD lookup only («الفترة خمسه» must
// match the stored «فترة 5» exactly like the typed digit does).
const SPOKEN_NUM = {
  واحد: "1", واحدة: "1", واحده: "1",
  اثنين: "2", اثنان: "2", ثنين: "2",
  ثلاثة: "3", ثلاثه: "3", ثلاث: "3",
  اربعة: "4", اربعه: "4", اربع: "4",
  خمسة: "5", خمسه: "5", خمس: "5",
  ستة: "6", سته: "6", ست: "6",
  سبعة: "7", سبعه: "7", سبع: "7",
  ثمانية: "8", ثمانيه: "8", ثمان: "8",
  تسعة: "9", تسعه: "9", تسع: "9",
  عشرة: "10", عشره: "10", عشر: "10",
};

function periodLookupBase(value) {
  const joined = normalizedTokens(value, PERIOD_WORDS)
    .map((token) => SPOKEN_NUM[token] || token)
    .join("");
  return joined.startsWith("ال") ? joined.slice(2) : joined;
}

// Strict pass: same-family morphology only.
export function normalizePeriodNative(value) {
  const base = periodLookupBase(value);
  return FAMILY_CANON[base] || base;
}

// Lenient pass (historical behavior): night/dinner wording folds onto the
// evening family too.
export function normalizePeriodLookup(value) {
  const native = normalizePeriodNative(value);
  return CROSS_FAMILY[native] || native;
}

function activeChalets(doc) {
  return (doc?.chalets || []).filter((c) => c && !c.deleted_at);
}

function activePeriods(chalet) {
  return (chalet?.periods || []).filter((p) => p && p.active !== false);
}

function uniqueNameMatch(items, query, valueOf, normalize) {
  const wanted = normalize(query);
  if (!wanted) return { status: "missing", matches: [] };
  const indexed = items.map((item) => ({ item, key: normalize(valueOf(item)) }));
  const exact = indexed.filter((x) => x.key && x.key === wanted);
  if (exact.length === 1) return { status: "ok", item: exact[0].item };
  if (exact.length > 1) return { status: "ambiguous", matches: exact.map((x) => x.item) };
  // A cautious convenience match handles short owner phrasing and a chalet named
  // INSIDE a longer sentence. It is accepted only when exactly one real record
  // matches. TWO dangerous shapes are excluded so the server never binds the
  // WRONG chalet (A-P1-9):
  //   • a query that STARTS WITH a shorter registered name and then diverges
  //     («نور القمر» over «نور» — the owner named something the record lacks);
  //   • a query that is only a mid-token SUBSTRING of a longer name («شمس»
  //     inside «نور الشمس») — never a real reference.
  // So a partial binds only as a clean LEADING PREFIX of the record
  // («تولوم»→«تولوم 2»), or where the record name appears EMBEDDED past the
  // start of the query (a chalet named mid-sentence, «احجز …تولوم… بكرة»).
  const partial = wanted.length >= 3
    ? indexed.filter((x) => x.key && (
        x.key.startsWith(wanted) ||                            // query is a leading prefix of the record
        (wanted.includes(x.key) && !wanted.startsWith(x.key))  // record embedded past the query's start
      ))
    : [];
  if (partial.length === 1) return { status: "ok", item: partial[0].item };
  if (partial.length > 1) {
    // Prefer the MOST SPECIFIC name the message actually spells out: when the
    // query contains a longer registered name whose shorter sibling is merely a
    // prefix/substring of it («تولوم 2» necessarily also contains «تولوم»), bind
    // the longer one instead of failing ambiguous. Two genuinely distinct names
    // (neither a substring of the other) still stay ambiguous.
    const contained = partial.filter((x) => wanted.includes(x.key) && !wanted.startsWith(x.key));
    if (contained.length) {
      const longest = contained.reduce((a, b) => (b.key.length > a.key.length ? b : a));
      if (contained.every((x) => longest.key.includes(x.key))) {
        return { status: "ok", item: longest.item };
      }
    }
    return { status: "ambiguous", matches: partial.map((x) => x.item) };
  }
  return { status: "not_found", matches: [] };
}

export function chaletCatalog(doc) {
  return {
    chalets: activeChalets(doc).map((c) => {
      // Identical duplicates (same label/times/prices) display as ONE logical
      // option — the owner is never shown five copies of the same slot. The
      // backing ids stay internal; availability is time-overlap anyway.
      const seen = new Set();
      const grouped = [];
      for (const p of activePeriods(c)) {
        const fp = [p.label, p.start, p.end, Number(p.weekday_price) || 0, Number(p.weekend_price) || 0]
          .map((v) => String(v ?? "")).join("|");
        if (seen.has(fp)) continue;
        seen.add(fp);
        grouped.push({
          period_id: String(p.id || ""),
          period_label: String(p.label || ""),
          start: String(p.start || ""),
          end: String(p.end || ""),
          weekday_price: Number(p.weekday_price) || 0,
          weekend_price: Number(p.weekend_price) || 0,
          time_incomplete: !isPeriodBookable(p).ok || undefined,
        });
      }
      return {
        chalet_id: String(c.id || ""),
        chalet_name: String(c.name || ""),
        capacity: Number(c.capacity) || 0,
        periods: grouped,
      };
    }),
  };
}

export function resolveChaletReference(doc, args = {}) {
  const chalets = activeChalets(doc);
  const options = chaletCatalog(doc).chalets;
  const byName = String(args.chalet_name || "");
  if (byName) {
    const match = uniqueNameMatch(chalets, byName, (c) => c.name, normalizeChaletLookup);
    if (match.status === "ok") return { ok: true, chalet: match.item };
    const names = options.map((c) => c.chalet_name).filter(Boolean).join("، ");
    if (match.status === "ambiguous") {
      return { ok: false, error: "CHALET_AMBIGUOUS", reason_ar: "وجدت أكثر من شاليه مطابق؛ اختر الاسم الكامل: " + names, options };
    }
    return {
      ok: false,
      error: "CHALET_NOT_FOUND",
      reason_ar: names ? `لم أجد شاليهاً مطابقاً لهذا الاسم. الشاليهات المسجلة: ${names}.` : "لا توجد شاليهات مسجلة في هذه المساحة.",
      options,
    };
  }
  const byId = String(args.chalet_id || "");
  if (byId) {
    const chalet = chalets.find((c) => String(c.id) === byId);
    return chalet
      ? { ok: true, chalet }
      : { ok: false, error: "CHALET_NOT_FOUND", reason_ar: "معرّف الشاليه غير موجود في مساحتك الحالية.", options };
  }
  return { ok: false, error: "CHALET_REQUIRED", reason_ar: "اذكر اسم الشاليه. سأطابقه تلقائياً مع بياناتك المسجلة.", options };
}

// Duplicate grouping (§ duplicate data): the canonical slot fingerprint. Fully
// identical periods collapse to ONE logical option; the deterministic pick is
// the lowest sort, then the lowest id — never a guess between distinguishable
// records.
function periodFingerprint(p) {
  return [p.label, p.start, p.end, Number(p.weekday_price) || 0, Number(p.weekend_price) || 0]
    .map((v) => String(v ?? "")).join("|");
}
function canonicalOf(matches) {
  return [...matches].sort((a, b) => {
    const s = (Number(a.sort) || 0) - (Number(b.sort) || 0);
    return s !== 0 ? s : String(a.id).localeCompare(String(b.id));
  })[0];
}
function collapseIdentical(matches) {
  const distinct = new Set(matches.map(periodFingerprint));
  return distinct.size === 1 ? canonicalOf(matches) : null;
}
function timedListAr(list) {
  return list
    .map((p) => `«${String(p.label || "—")}» (${String(p.start || "؟")}–${String(p.end || "؟")})`)
    .join("، ");
}

function periodOptions(list) {
  return list.map((p) => ({
    period_id: String(p.id || ""),
    period_label: String(p.label || ""),
    start: String(p.start || ""),
    end: String(p.end || ""),
  }));
}

// The owner often gives BOTH a time and the period's name in one sentence
// («من ٧ الى العصر ٥ … الفترة خمسه» — live IMG_6708). When the time alone is
// ambiguous, that name is the tie-breaker; discarding it was the dead-end.
function hintTieBreak(candidates, hint) {
  if (!hint) return null;
  const native = uniqueNameMatch(candidates, hint, (p) => p.label, normalizePeriodNative);
  if (native.status === "ok") return native.item;
  const lenient = uniqueNameMatch(candidates, hint, (p) => p.label, normalizePeriodLookup);
  return lenient.status === "ok" ? lenient.item : null;
}

function resolvePeriodReference(chalet, args = {}) {
  const all = activePeriods(chalet);
  // Bookable periods only: incomplete times FAIL CLOSED for new bookings.
  const periods = all.filter((p) => isPeriodBookable(p).ok);
  const options = periodOptions(periods);
  const byLabel = String(args.period_label || "");
  const labelHint = String(args.period_label_hint || "");
  if (byLabel) {
    // TIER 1 — exact canonical TIME match: «من ٧ مساء إلى ٥ صباح», «19:00-05:00»,
    // «7-5». The owner never needs the stored label wording.
    const t = parseTimeExpression(byLabel);
    if (t && t.confidence !== "low") {
      const sameBoth = periods.filter(
        (p) => normalizeTimeHHmm(p.start) === t.start && normalizeTimeHHmm(p.end) === t.end,
      );
      if (sameBoth.length) {
        const collapsed = collapseIdentical(sameBoth);
        if (collapsed) return { ok: true, period: collapsed };
        const hinted = hintTieBreak(sameBoth, labelHint);
        if (hinted) return { ok: true, period: hinted };
        return { ok: false, error: "PERIOD_AMBIGUOUS", reason_ar: `توجد عدة فترات بنفس هذا الوقت؛ حدد بالاسم: ${timedListAr(sameBoth)}.`, options: periodOptions(sameBoth) };
      }
      const sameStart = periods.filter((p) => normalizeTimeHHmm(p.start) === t.start);
      if (sameStart.length === 1) return { ok: true, period: sameStart[0] };
      if (sameStart.length > 1) {
        const collapsed = collapseIdentical(sameStart);
        if (collapsed) return { ok: true, period: collapsed };
        const hinted = hintTieBreak(sameStart, labelHint);
        if (hinted) return { ok: true, period: hinted };
        return { ok: false, error: "PERIOD_AMBIGUOUS", reason_ar: `توجد عدة فترات تبدأ بهذا الوقت؛ حدد الفترة: ${timedListAr(sameStart)}.`, options: periodOptions(sameStart) };
      }
      return {
        ok: false,
        error: "PERIOD_NOT_FOUND",
        reason_ar: options.length
          ? `لا توجد فترة بهذا الوقت. الفترات المتاحة: ${timedListAr(periods)}.`
          : "لا توجد فترات مكتملة الوقت لهذا الشاليه.",
        options,
      };
    }
    // TIER 2/3 — label matching in two passes: STRICT same-family first
    // («المسائية» prefers the «مسائي» period, «بالليل» prefers «ليلي» when
    // both exist), then the lenient cross-family alias (ليل→مساء) only when
    // the strict pass found nothing.
    const native = uniqueNameMatch(periods, byLabel, (p) => p.label, normalizePeriodNative);
    const match = native.status === "ok" || native.status === "ambiguous"
      ? native
      : uniqueNameMatch(periods, byLabel, (p) => p.label, normalizePeriodLookup);
    if (match.status === "ok") return { ok: true, period: match.item };
    const labels = options.map((p) => p.period_label).filter(Boolean).join("، ");
    if (match.status === "ambiguous") {
      const collapsed = collapseIdentical(match.matches);
      if (collapsed) return { ok: true, period: collapsed };
      return { ok: false, error: "PERIOD_AMBIGUOUS", reason_ar: `توجد عدة فترات مطابقة لهذا الاسم؛ حدد الفترة بوقتها: ${timedListAr(match.matches)}.`, options: periodOptions(match.matches) };
    }
    // The wording may have matched an UNBOOKABLE (timeless) period — say so
    // precisely instead of a generic not-found.
    const timelessHit = all.filter((p) => !isPeriodBookable(p).ok);
    if (timelessHit.length) {
      const m2 = uniqueNameMatch(timelessHit, byLabel, (p) => p.label, normalizePeriodLookup);
      if (m2.status === "ok" || m2.status === "ambiguous") {
        return { ok: false, error: "PERIOD_TIME_INCOMPLETE", reason_ar: "وقت الفترة غير مكتمل لهذه الفترة، فلا يمكن حجزها. أكمل وقت البداية والنهاية من تبويب الشاليهات ثم أعد المحاولة.", options };
      }
    }
    return { ok: false, error: "PERIOD_NOT_FOUND", reason_ar: labels ? `لم أجد هذه الفترة. الفترات المفعّلة: ${labels}.` : "لا توجد فترات مكتملة الوقت لهذا الشاليه.", options };
  }
  const byId = String(args.period_id || "");
  if (byId) {
    const period = periods.find((p) => String(p.id) === byId);
    if (period) return { ok: true, period };
    const timeless = all.find((p) => String(p.id) === byId);
    if (timeless) return { ok: false, error: "PERIOD_TIME_INCOMPLETE", reason_ar: "وقت الفترة غير مكتمل لهذه الفترة، فلا يمكن حجزها. أكمل وقت البداية والنهاية من تبويب الشاليهات ثم أعد المحاولة.", options };
    return { ok: false, error: "PERIOD_NOT_FOUND", reason_ar: "معرّف الفترة غير موجود أو غير مفعّل لهذا الشاليه.", options };
  }
  // Grouped single-option auto-pick: several identical duplicates still count
  // as ONE logical period.
  if (periods.length >= 1) {
    const collapsed = collapseIdentical(periods);
    if (collapsed) return { ok: true, period: collapsed };
  }
  const labels = options.map((p) => p.period_label).filter(Boolean).join("، ");
  return { ok: false, error: "PERIOD_REQUIRED", reason_ar: labels ? `اختر الفترة: ${timedListAr(periods)}.` : "لا توجد فترات مكتملة الوقت لهذا الشاليه.", options };
}

export function resolveBookingCreateArgs(doc, args = {}) {
  const chaletResult = resolveChaletReference(doc, args);
  if (!chaletResult.ok) return chaletResult;
  const periodResult = resolvePeriodReference(chaletResult.chalet, args);
  if (!periodResult.ok) {
    return { ...periodResult, chalet_name: String(chaletResult.chalet.name || "") };
  }
  const date = String(args.booking_date || "");
  if (date) {
    const check = availabilityCheck(doc, chaletResult.chalet.id, date, periodResult.period);
    if (!check.available) {
      // A real overlap and a legacy-data block get DIFFERENT codes + reasons
      // (the owner can act on «who blocks» vs «fix the period times»).
      const fail = availabilityFailureAr(check, { tail: "لم يتم تجهيز أي حجز." });
      return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
    }
  }
  return {
    ok: true,
    args: {
      ...args,
      chalet_id: String(chaletResult.chalet.id || ""),
      chalet_name: String(chaletResult.chalet.name || ""),
      period_id: String(periodResult.period.id || ""),
      period_label: String(periodResult.period.label || ""),
      // Canonical times travel with the payload so the confirmation card can
      // always render «start → end» without re-reading the document.
      period_start: normalizeTimeHHmm(periodResult.period.start) || "",
      period_end: normalizeTimeHHmm(periodResult.period.end) || "",
    },
  };
}
