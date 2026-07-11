// Resolve human chalet/period names against the authoritative workspace
// document. No model-generated id is trusted: every successful result binds the
// real ids that already exist in this workspace, or fails closed with real
// choices from the document.

import { isSlotAvailable } from "./availability.mjs";

const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g;
const CHALET_WORDS = new Set(["شاليه", "الشاليه", "شاليهات", "الشاليهات", "chalet", "chalets"]);
const PERIOD_WORDS = new Set(["فترة", "الفترة", "فترات", "الفترات", "period", "periods"]);

function normalizedTokens(value, ignored) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((token) => !ignored.has(token));
}

export function normalizeChaletLookup(value) {
  return normalizedTokens(value, CHALET_WORDS).join("");
}

export function normalizePeriodLookup(value) {
  const joined = normalizedTokens(value, PERIOD_WORDS).join("");
  const withoutArticle = joined.startsWith("ال") ? joined.slice(2) : joined;
  const aliases = {
    صباح: "صباح", صباحي: "صباح", صباحية: "صباح",
    مساء: "مساء", مسائي: "مساء", مسائية: "مساء", مسايي: "مساء", مسايية: "مساء",
    ليل: "ليل", ليلي: "ليل", ليلية: "ليل",
    نهار: "نهار", نهاري: "نهار", نهارية: "نهار",
    ظهر: "ظهر", ظهيرة: "ظهر", عصري: "عصر", عصر: "عصر",
  };
  return aliases[withoutArticle] || withoutArticle;
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
  // A cautious convenience match handles short owner phrasing such as
  // "تولوم" vs "منتجع تولوم". It is accepted only when exactly one real
  // record matches, so the server never guesses between two chalets/periods.
  const partial = wanted.length >= 3
    ? indexed.filter((x) => x.key && (x.key.includes(wanted) || wanted.includes(x.key)))
    : [];
  if (partial.length === 1) return { status: "ok", item: partial[0].item };
  if (partial.length > 1) return { status: "ambiguous", matches: partial.map((x) => x.item) };
  return { status: "not_found", matches: [] };
}

export function chaletCatalog(doc) {
  return {
    chalets: activeChalets(doc).map((c) => ({
      chalet_id: String(c.id || ""),
      chalet_name: String(c.name || ""),
      capacity: Number(c.capacity) || 0,
      periods: activePeriods(c).map((p) => ({
        period_id: String(p.id || ""),
        period_label: String(p.label || ""),
        start: String(p.start || ""),
        end: String(p.end || ""),
        weekday_price: Number(p.weekday_price) || 0,
        weekend_price: Number(p.weekend_price) || 0,
      })),
    })),
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

function resolvePeriodReference(chalet, args = {}) {
  const periods = activePeriods(chalet);
  const options = periods.map((p) => ({
    period_id: String(p.id || ""),
    period_label: String(p.label || ""),
    start: String(p.start || ""),
    end: String(p.end || ""),
  }));
  const byLabel = String(args.period_label || "");
  if (byLabel) {
    const match = uniqueNameMatch(periods, byLabel, (p) => p.label, normalizePeriodLookup);
    if (match.status === "ok") return { ok: true, period: match.item };
    const labels = options.map((p) => p.period_label).filter(Boolean).join("، ");
    if (match.status === "ambiguous") {
      return { ok: false, error: "PERIOD_AMBIGUOUS", reason_ar: `وجدت أكثر من فترة مطابقة؛ اختر الاسم الكامل: ${labels}.`, options };
    }
    return { ok: false, error: "PERIOD_NOT_FOUND", reason_ar: labels ? `لم أجد هذه الفترة. الفترات المفعّلة: ${labels}.` : "لا توجد فترات مفعّلة لهذا الشاليه.", options };
  }
  const byId = String(args.period_id || "");
  if (byId) {
    const period = periods.find((p) => String(p.id) === byId);
    return period
      ? { ok: true, period }
      : { ok: false, error: "PERIOD_NOT_FOUND", reason_ar: "معرّف الفترة غير موجود أو غير مفعّل لهذا الشاليه.", options };
  }
  if (periods.length === 1) return { ok: true, period: periods[0] };
  const labels = options.map((p) => p.period_label).filter(Boolean).join("، ");
  return { ok: false, error: "PERIOD_REQUIRED", reason_ar: labels ? `اختر الفترة: ${labels}.` : "لا توجد فترات مفعّلة لهذا الشاليه.", options };
}

export function resolveBookingCreateArgs(doc, args = {}) {
  const chaletResult = resolveChaletReference(doc, args);
  if (!chaletResult.ok) return chaletResult;
  const periodResult = resolvePeriodReference(chaletResult.chalet, args);
  if (!periodResult.ok) {
    return { ...periodResult, chalet_name: String(chaletResult.chalet.name || "") };
  }
  const date = String(args.booking_date || "");
  if (date && !isSlotAvailable(doc, chaletResult.chalet.id, date, periodResult.period)) {
    return {
      ok: false,
      error: "BOOKING_CONFLICT",
      reason_ar: `الفترة «${periodResult.period.label || "—"}» في «${chaletResult.chalet.name || "—"}» محجوزة بهذا التاريخ. لم يتم تجهيز أي حجز.`,
    };
  }
  return {
    ok: true,
    args: {
      ...args,
      chalet_id: String(chaletResult.chalet.id || ""),
      chalet_name: String(chaletResult.chalet.name || ""),
      period_id: String(periodResult.period.id || ""),
      period_label: String(periodResult.period.label || ""),
    },
  };
}
