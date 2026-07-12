// booking-planner.mjs — the deterministic Booking Draft brain (§ Booking Agent).
// Pure functions only: no fetch, no Date.now() — callers pass todayIso and the
// workspace doc. Responsibilities: merge facts across chat turns, report the
// still-missing fields (NEVER inventing guests or a total), compute the
// weekday/weekend price suggestion (which always needs explicit acceptance),
// produce exactly ONE next Arabic question, find real conflict alternatives,
// and build the structured confirmation-card data rendered by the frontend.
//
// DRAFT SHAPE (server-stored draft; the customer phone is NEVER part of this
// object — extractFacts returns it separately as { customer_phone } so it can
// live in the private store only):
// {
//   customer_name, chalet_id, chalet_name, booking_date,
//   period_id, period_label, canonical_start, canonical_end, wraps_next_day,
//   guests, total, total_suggested,
//   total_source: "explicit" | "accepted_suggestion" | "free" | "suggested" | "model",
//   notes,
//   sources:  { field -> "parsed" | "model" | "selection" },
//   warnings: [ ...Arabic warning strings ],
// }

import {
  foldDigits,
  parseTimeExpression,
  parseDateExpression,
  formatDateDisplay,
  extractGuestCount,
  extractAmount,
  isExplicitFree,
  isBareConfirmPhrase,
} from "./nl-normalize.mjs";
import {
  isSlotAvailable,
  periodInterval,
  intervalsOverlap,
  validatePeriodTimes,
  normalizeTimeHHmm,
  addDays,
} from "./availability.mjs";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Diacritics/tanween/quranic marks + tatweel (same family nl-normalize strips).
const AR_MARKS_RE = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Fold digits, strip diacritics, unify hamza-alef, drop punctuation to spaces,
// lowercase — a loose normal form for keyword matching (never for names).
function normalizeLoose(s) {
  return foldDigits(String(s ?? ""))
    .replace(AR_MARKS_RE, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/[.,!?؟،؛:"'«»…()\-–—]/g, " ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Customer name extraction (deterministic, marker-based)
// ---------------------------------------------------------------------------

// Markers that introduce the customer name; «لـ» must keep its tatweel so a
// bare preposition ل never triggers a capture.
const NAME_MARKER_RE =
  /(?:^|[\s،,.;:؛])(?:و|ف)?(?:العميل|الاسم|باسم|بإسم|بأسم|لـ)[\s:،]*([^\n]*)/u;

const CURRENCY_TOKEN_RE = /^(?:ريال|ريالا|ريالات|ر\.س|sar|sr)$/;

// Tokens that can never be part of a captured name (dates, times, phone
// words, counts, booking vocabulary). Compared against the loose normal form.
const NAME_STOP = new Set([
  // date words + weekdays
  "اليوم", "الليلة", "الليله", "بكرة", "بكره", "باكر", "غدا", "غد", "بعد", "يوم", "بتاريخ", "تاريخ",
  "الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعة", "الجمعه", "السبت",
  // time words
  "مساء", "مساءا", "صباحا", "صباح", "الصبح", "ظهرا", "الظهر", "عصرا", "العصر", "بالليل", "ليلا", "ليل",
  // phone words
  "جوال", "جواله", "الجوال", "رقم", "رقمه", "هاتف", "هاتفه", "تلفون", "تليفون", "موبايل", "واتس", "واتساب", "phone", "mobile",
  // counts / money
  "شخص", "شخصين", "اشخاص", "ضيف", "ضيوف", "نفر", "انفار", "فرد", "افراد", "عدد",
  "سعر", "السعر", "بسعر", "المبلغ", "الاجمالي", "مجانا", "مجاني",
  // booking vocabulary / connectors («شالية» is the common taa-marbuta
  // spelling; «الوقت/الساعة» open a time clause — live IMG_6702 wording)
  "حجز", "الحجز", "احجز", "فترة", "الفترة", "شاليه", "الشاليه", "شالية", "الشالية", "شاليات",
  "الوقت", "وقت", "الساعة", "ساعة",
  "في", "من", "الى", "الي", "حتى", "عند", "و",
]);

// "العميل علي تجربة" -> "علي تجربة". Capture after a marker until a digit,
// a currency word, a stop word, sentence punctuation or end (trim ، / و).
function extractCustomerName(folded) {
  const m = NAME_MARKER_RE.exec(folded);
  if (!m) return "";
  // Sentence punctuation ends the name outright.
  const segment = m[1].split(/[،,.;؛!؟?]/)[0];
  const collected = [];
  for (const tok of segment.split(/\s+/).filter(Boolean)) {
    if (/\d/.test(tok)) break;
    const norm = normalizeLoose(tok).trim();
    if (!norm) break;
    // A leading و glued to a stop word («وجواله») also ends the capture.
    const bare = norm.length > 1 && norm.startsWith("و") ? norm.slice(1) : norm;
    if (CURRENCY_TOKEN_RE.test(bare) || NAME_STOP.has(norm) || NAME_STOP.has(bare)) break;
    collected.push(tok);
    if (collected.length >= 5) break; // names are short; never swallow a sentence
  }
  return collected.join(" ").trim().slice(0, 60).trim();
}

// ---------------------------------------------------------------------------
// Saudi mobile extraction (same shape as extractBookingPhone in the handler)
// ---------------------------------------------------------------------------

// Numeric shapes that are DATES, never phones (mirrors nl-normalize's spans).
const DATE_SHAPE_RE =
  /(?<!\d)(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}\/\d{1,2})(?!\d)/g;
const PHONE_CONTEXT_RE = /جوال|هاتف|تلفون|تليفون|موبايل|واتس|phone|mobile|رقمه|رقم/;
const CURRENCY_AFTER_RE = /^(?:ريال|ر\.س|sar|sr)/i;

// Normalize a bare digit run to canonical 05XXXXXXXX, or "" when impossible.
function normalizeSaudiMobileDigits(run) {
  let digits = String(run || "");
  if (digits.startsWith("00966")) digits = digits.slice(5);
  else if (digits.startsWith("966")) digits = digits.slice(3);
  if (/^5\d{8}$/.test(digits)) digits = "0" + digits;
  return /^05\d{8}$/.test(digits) ? digits : "";
}

function extractSaudiMobile(folded) {
  // Remove date shapes BEFORE compacting: «... بتاريخ 15-08-2026 500 ريال»
  // otherwise glues into 15082026500 and the unanchored regex forges the
  // ghost phone 0508202650 from the date+price digits. Anchoring with digit
  // boundaries also rejects a too-long typo instead of silently truncating.
  const compact = folded.replace(DATE_SHAPE_RE, " ").replace(/[\s()-]/g, "");
  const m = compact.match(/(?<!\d)(?:\+?966|00966)?0?5\d{8}(?!\d)/);
  if (!m) return "";
  return normalizeSaudiMobileDigits(m[0].replace(/\D/g, ""));
}

// Phone-ish garbage detector: digit runs that LOOK like a mobile but fail
// normalization. Context-free rule: 7-14 digits starting 0/5/9. With a phone
// marker word in the message the net widens to 5+ digits («جواله 05012»).
// Date shapes and currency-adjacent amounts are never phone-ish.
function hasPhoneLikeGarbage(folded) {
  const hasContext = PHONE_CONTEXT_RE.test(normalizeLoose(folded));
  const compact = folded.replace(DATE_SHAPE_RE, " ").replace(/[\s()-]/g, "");
  const minLen = hasContext ? 5 : 7;
  for (const m of compact.matchAll(/\d+/g)) {
    const run = m[0];
    if (run[0] !== "0" && run[0] !== "5" && run[0] !== "9") continue;
    if (run.length < minLen || run.length > 14) continue;
    // A run that contains a normalizable mobile is the phone, not garbage.
    const inner = run.match(/(?:00966|966)?0?5\d{8}/);
    if (inner && normalizeSaudiMobileDigits(inner[0])) continue;
    // Amounts glued to a currency word («5000000ريال») are money, not phones.
    if (CURRENCY_AFTER_RE.test(compact.slice(m.index + run.length))) continue;
    return true;
  }
  return false;
}

// "0501234567" -> "05••••4567" (keep first 2 + last 4). Frontend-safe form.
export function maskPhone(phone) {
  const s = String(phone ?? "").trim();
  if (!s) return "";
  if (s.length < 7) return "•".repeat(s.length);
  return s.slice(0, 2) + "•".repeat(s.length - 6) + s.slice(-4);
}

// ---------------------------------------------------------------------------
// Suggested-price acceptance detection
// ---------------------------------------------------------------------------

// Acceptance of a PENDING suggested price. Bare confirmations (نعم/تمام/ok…)
// count only through this flag — the caller applies it exclusively when a
// suggestion is actually pending, so a stray «نعم» can never set a price.
function detectPriceAcceptance(raw) {
  if (isBareConfirmPhrase(raw)) return true;
  const t = normalizeLoose(raw);
  if (/(?:^|\s)اعتمد/.test(t)) return true; // اعتمد / اعتمده / نعم اعتمد السعر
  if (/السعر/.test(t) && /(?:^|\s)(?:موافق|موافقة|اوافق|تمام|ماشي|اوكي|اوك|ok)(?=\s|$)/.test(t)) {
    return true; // موافق على السعر / تمام السعر
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1) extractFacts — deterministic per-message fact extraction
// ---------------------------------------------------------------------------

// Parse ONE chat message into draft facts. Chalet/period wording is NOT
// resolved here (the resolver binds real ids from the raw message); this stays
// focused on dates, times, counts, amounts, the name and the private phone.
export function extractFacts(message, todayIso) {
  const out = { fields: {}, private: {} };
  const raw = typeof message === "string" ? message : "";
  if (!raw.trim()) return out;
  const folded = foldDigits(raw);

  // Date: ignore null; propagate {error} so the caller can ask precisely.
  const d = parseDateExpression(raw, todayIso);
  if (d && d.date) out.fields.booking_date = d.date;
  else if (d && d.error) out.fields.date_error = { error: d.error, reason_ar: d.reason_ar || "" };

  // Time RANGE (a lone hour is never a range — nl-normalize returns null).
  const t = parseTimeExpression(raw);
  if (t) out.time = t;

  // Guests / amount. A bare small number without a currency word is a guest
  // count answer, never a total — the planner NEVER invents money.
  const guests = extractGuestCount(raw);
  const amount = extractAmount(raw);
  const hasCurrency = /ريال|ر\.س|(?:^|[^a-z])sar(?:$|[^a-z])|(?:^|[^a-z])sr(?:$|[^a-z])/.test(
    normalizeLoose(raw),
  );
  if (guests !== null) out.fields.guests = guests;
  if (amount !== null && (hasCurrency || amount !== guests)) {
    out.fields.total = amount;
    out.fields.total_source = "explicit";
  }

  // An explicitly FREE booking (a missing price never implies free).
  if (isExplicitFree(raw)) out.free = true;

  // Acceptance of a pending suggested price (applied by mergeDraft only when
  // existing.total_suggested is present).
  if (detectPriceAcceptance(raw)) out.accept_suggestion = true;

  const name = extractCustomerName(folded);
  if (name) out.fields.customer_name = name;

  // Phone is PRIVATE: never placed into fields (the draft object).
  const phone = extractSaudiMobile(folded);
  if (phone) out.private.customer_phone = phone;
  else if (hasPhoneLikeGarbage(folded)) out.fields.phone_warning = true;

  return out;
}

// ---------------------------------------------------------------------------
// 2) mergeDraft — accumulate facts across turns
// ---------------------------------------------------------------------------

const PHONE_WARNING_AR =
  "رقم الجوال يبدو غير مكتمل أو غير صحيح — اكتبه بصيغة 05XXXXXXXX حتى أحفظه.";

// Fields whose provenance is tracked in draft.sources.
const TRACKED_FIELDS = new Set([
  "customer_name", "chalet_id", "chalet_name", "booking_date",
  "period_id", "period_label", "canonical_start", "canonical_end",
  "guests", "total", "notes",
]);
// The model may only ever touch these — and it always loses to parsed values.
// NOTHING ELSE: dates come from parseDateExpression/selection, times from
// period resolution, guests/total from the owner's own words (or an accepted
// system price). An LLM-guessed «10 ضيوف / 300 ريال» must never reach a card.
const MODEL_FILLABLE = new Set(["customer_name", "notes"]);
// Keys that must never enter the draft through a merge: private data, merge
// bookkeeping, and SERVER-owned dialogue state (pending_q, alternatives are
// written only by the pipeline, never by a parsed/model turn).
const MERGE_BLOCKLIST = new Set(["customer_phone", "sources", "warnings", "phone_warning", "pending_q", "alternatives"]);

// Fail-closed validation of LLM-extracted values (never trusted blindly).
function sanitizeModelValue(key, value) {
  if (key === "customer_name" || key === "notes") {
    const s = typeof value === "string" ? value.trim() : "";
    return s ? s.slice(0, 200) : undefined;
  }
  return undefined;
}

// Merge one turn into the draft. incoming is an extractFacts() result, plus an
// optional modelFields object (produced by the LLM). Rules:
//  - the model may fill customer_name/notes ONLY, and only where the parser
//    found none — every other field is deterministic-source-only (§5);
//  - later messages REPLACE earlier values (corrections);
//  - free:true  -> total=0, total_source "free";
//  - accept_suggestion:true + existing.total_suggested -> total=total_suggested.
// Never mutates `existing`; incoming.private is intentionally ignored (the
// phone never enters the draft object).
export function mergeDraft(existing, incoming) {
  const base = isObj(existing) ? existing : {};
  const inc = isObj(incoming) ? incoming : {};
  const parsed = isObj(inc.fields) ? inc.fields : {};
  const model = isObj(inc.modelFields) ? inc.modelFields : {};

  const draft = { ...base };
  const sources = { ...(isObj(base.sources) ? base.sources : {}) };
  const warnings = Array.isArray(base.warnings) ? [...base.warnings] : [];

  // Model values first (so parsed values below overwrite them): applied only
  // when the parser found nothing this turn AND the field is not already
  // owned by a deterministic source.
  for (const [k, v] of Object.entries(model)) {
    if (!MODEL_FILLABLE.has(k) || parsed[k] !== undefined) continue;
    if (sources[k] === "parsed" || sources[k] === "selection") continue;
    const val = sanitizeModelValue(k, v);
    if (val === undefined) continue;
    draft[k] = val;
    sources[k] = "model";
  }

  // Parsed values REPLACE (corrections are later messages winning).
  for (const [k, v] of Object.entries(parsed)) {
    if (v === undefined || MERGE_BLOCKLIST.has(k)) continue;
    draft[k] = v;
    if (TRACKED_FIELDS.has(k)) sources[k] = "parsed";
  }
  if (parsed.phone_warning === true && !warnings.includes(PHONE_WARNING_AR)) {
    warnings.push(PHONE_WARNING_AR);
  }
  // A freshly parsed valid date supersedes any stale date error.
  if (parsed.booking_date) delete draft.date_error;

  // A parsed time range binds canonical times; changed times unbind the
  // previously resolved period (it must re-resolve against the document).
  if (isObj(inc.time) && inc.time.start && inc.time.end) {
    const changed =
      draft.canonical_start !== inc.time.start || draft.canonical_end !== inc.time.end;
    draft.canonical_start = inc.time.start;
    draft.canonical_end = inc.time.end;
    draft.wraps_next_day = Boolean(inc.time.wraps_next_day);
    sources.canonical_start = "parsed";
    sources.canonical_end = "parsed";
    if (changed) {
      delete draft.period_id;
      delete draft.period_label;
    }
  }

  // Explicitly free: total is a REAL zero, not a missing value.
  if (inc.free === true) {
    draft.total = 0;
    draft.total_source = "free";
    sources.total = "parsed";
  }

  // Accepting the pending suggestion — only when one is actually PENDING
  // (total_source still "suggested"). A bare «نعم» after the owner already
  // set an explicit price or «مجاني» must never revert the total to a stale
  // suggestion that lingered on the draft.
  if (
    inc.accept_suggestion === true && inc.free !== true && parsed.total === undefined &&
    draft.total_source === "suggested"
  ) {
    const s = Number(draft.total_suggested);
    if (Number.isFinite(s) && s > 0) {
      draft.total = s;
      draft.total_source = "accepted_suggestion";
      sources.total = "selection";
    }
  }

  draft.sources = sources;
  draft.warnings = warnings;
  return draft;
}

// ---------------------------------------------------------------------------
// 3) missingFields — what still blocks the booking (NO defaults, ever)
// ---------------------------------------------------------------------------

// Returned in question-priority order. total counts as MISSING when null, or
// zero without an explicit free, or still equal to a merely-SUGGESTED price
// (a suggestion is never applied silently). period needs a bound id AND
// canonical HH:mm times.
export function missingFields(draft) {
  const d = isObj(draft) ? draft : {};
  const missing = [];
  if (!isNonEmptyString(d.chalet_id)) missing.push("chalet");
  if (typeof d.booking_date !== "string" || !ISO_DATE_RE.test(d.booking_date)) {
    missing.push("booking_date");
  }
  const hasPeriod =
    isNonEmptyString(d.period_id) &&
    Boolean(normalizeTimeHHmm(d.canonical_start)) &&
    Boolean(normalizeTimeHHmm(d.canonical_end));
  if (!hasPeriod) missing.push("period");
  if (!Number.isInteger(d.guests) || d.guests < 1) missing.push("guests");
  const t = d.total;
  const totalMissing =
    t === null || t === undefined ||
    (t === 0 && d.total_source !== "free") ||
    (t === d.total_suggested && d.total_source === "suggested");
  if (totalMissing) missing.push("total");
  if (!isNonEmptyString(d.customer_name)) missing.push("customer_name");
  return missing;
}

// ---------------------------------------------------------------------------
// 4) suggestedPrice — weekday/weekend system price for a period on a date
// ---------------------------------------------------------------------------

// Weekend in KSA = Friday(5) / Saturday(6) by UTC weekday of the ISO date.
// null when the period has no strictly positive price for that day.
export function suggestedPrice(period, dateIso) {
  if (!isObj(period) || typeof dateIso !== "string" || !ISO_DATE_RE.test(dateIso)) return null;
  const [y, mo, day] = dateIso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, day)).getUTCDay();
  const weekend = dow === 5 || dow === 6;
  const price = Number(weekend ? period.weekend_price : period.weekday_price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

// ---------------------------------------------------------------------------
// 5) nextQuestionAr — exactly ONE short question for the FIRST missing item
// ---------------------------------------------------------------------------

const QUESTION_PRIORITY = ["chalet", "booking_date", "period", "guests", "total", "customer_name"];

export function nextQuestionAr(draft, missing) {
  const d = isObj(draft) ? draft : {};
  const set = new Set(Array.isArray(missing) ? missing : []);
  const first = QUESTION_PRIORITY.find((k) => set.has(k));
  switch (first) {
    case "chalet":
      return "لأي شاليه تريد الحجز؟";
    case "booking_date":
      return "ما تاريخ الحجز؟ اكتب مثلاً: بكرة أو 15-08-2026.";
    case "period": {
      const opts = Array.isArray(d.period_options)
        ? d.period_options.filter((o) => isObj(o)).slice(0, 3)
        : [];
      if (opts.length) {
        const lines = opts.map(
          (o, i) => `${i + 1}. ${String(o.label || "—")} (${String(o.start || "؟")}–${String(o.end || "؟")})`,
        );
        return "أي فترة تريد؟\n" + lines.join("\n");
      }
      return "أي فترة تريد؟ اكتب اسم الفترة أو وقتها، مثل: من 7 مساءً إلى 5 صباحاً.";
    }
    case "guests":
      return "كم عدد الضيوف؟";
    case "total": {
      const n = Number(d.total_suggested);
      if (Number.isFinite(n) && n > 0) {
        return `السعر المقترح لهذه الفترة ${n} ريال (سعر النظام). أعتمده أم تحدد سعراً آخر؟`;
      }
      return "كم الإجمالي بالريال؟ اكتب «مجاني» إذا كان الحجز بدون سعر.";
    }
    case "customer_name":
      return "باسم من أسجل الحجز؟";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 6) findAlternatives — real, available options after a conflict
// ---------------------------------------------------------------------------

function activeChaletsOf(doc) {
  return (doc?.chalets || []).filter((c) => c && !c.deleted_at);
}
function activePeriodsOf(chalet) {
  return (chalet?.periods || []).filter((p) => p && p.active !== false);
}
// Logical-slot fingerprint (label|start|end) — the § duplicate-data idea from
// booking-resolution: identical rows are ONE option.
function slotFingerprint(p) {
  return [p?.label, p?.start, p?.end].map((v) => String(v ?? "")).join("|");
}
function bySortThenId(a, b) {
  const s = (Number(a.sort) || 0) - (Number(b.sort) || 0);
  return s !== 0 ? s : String(a.id).localeCompare(String(b.id));
}

function altEntry(chalet, period, dateIso) {
  const t = validatePeriodTimes(period);
  const entry = {
    chalet_id: String(chalet.id ?? ""),
    chalet_name: String(chalet.name ?? ""),
    date: dateIso,
    period_id: String(period.id ?? ""),
    period_label: String(period.label ?? ""),
    start: t.ok ? t.start : "",
    end: t.ok ? t.end : "",
    capacity: Number(chalet.capacity) || 0,
  };
  const price = suggestedPrice(period, dateIso);
  if (price !== null) entry.price = price; // omit rather than lie with null
  return entry;
}

// STRICT search order:
//  (1) same chalet + same date: other active, timed, available periods that do
//      NOT overlap the requested interval;
//  (2) same chalet, the SAME logical period (label|start|end fingerprint) on
//      the nearest free day within dateIso+1..dateIso+14 (one hit, so the
//      cross-chalet tier still fits into the list);
//  (3) other active chalets on the same date — identical start/end preferred,
//      else any bookable available period.
// Never a slot that fails isSlotAvailable, never a period without valid times.
export function findAlternatives(doc, chaletId, dateIso, period, opts = {}) {
  const out = [];
  if (!isObj(doc) || typeof dateIso !== "string" || !ISO_DATE_RE.test(dateIso)) return out;
  const max = Number.isInteger(opts.max) && opts.max > 0 ? Math.min(opts.max, 10) : 3;
  const todayIso = typeof opts.todayIso === "string" && ISO_DATE_RE.test(opts.todayIso)
    ? opts.todayIso
    : null;
  const dateOk = (d) => !todayIso || d >= todayIso; // never suggest the past

  const chalets = activeChaletsOf(doc);
  const chalet = chalets.find((c) => String(c.id) === String(chaletId));
  const wantedInterval = periodInterval(period, dateIso); // null when timeless
  const wantedStart = normalizeTimeHHmm(period?.start);
  const wantedEnd = normalizeTimeHHmm(period?.end);

  // (1) same chalet, same date, non-overlapping other periods.
  if (chalet && dateOk(dateIso)) {
    for (const p of [...activePeriodsOf(chalet)].sort(bySortThenId)) {
      if (out.length >= max) break;
      if (period && p.id !== undefined && String(p.id) === String(period.id)) continue;
      if (!validatePeriodTimes(p).ok) continue;
      const ci = periodInterval(p, dateIso);
      if (wantedInterval && intervalsOverlap(ci, wantedInterval)) continue;
      if (!isSlotAvailable(doc, chalet.id, dateIso, p)) continue;
      out.push(altEntry(chalet, p, dateIso));
    }
  }

  // (2) same logical period on the nearest free later day (first hit only).
  if (chalet && period && out.length < max) {
    const wantedFp = slotFingerprint(period);
    const sames = activePeriodsOf(chalet)
      .filter((p) => slotFingerprint(p) === wantedFp && validatePeriodTimes(p).ok)
      .sort(bySortThenId);
    if (sames.length) {
      outer: for (let i = 1; i <= 14; i += 1) {
        const day = addDays(dateIso, i);
        if (!dateOk(day)) continue;
        for (const p of sames) {
          if (isSlotAvailable(doc, chalet.id, day, p)) {
            out.push(altEntry(chalet, p, day));
            break outer;
          }
        }
      }
    }
  }

  // (3) other active chalets, same date: identical times preferred.
  if (out.length < max && dateOk(dateIso)) {
    for (const c of chalets) {
      if (out.length >= max) break;
      if (String(c.id) === String(chaletId)) continue;
      const timed = [...activePeriodsOf(c)]
        .filter((p) => validatePeriodTimes(p).ok)
        .sort(bySortThenId);
      const exact = timed.find(
        (p) =>
          wantedStart && wantedEnd &&
          normalizeTimeHHmm(p.start) === wantedStart &&
          normalizeTimeHHmm(p.end) === wantedEnd &&
          isSlotAvailable(doc, c.id, dateIso, p),
      );
      const pick = exact || timed.find((p) => isSlotAvailable(doc, c.id, dateIso, p));
      if (pick) out.push(altEntry(c, pick, dateIso));
    }
  }

  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// 7) buildCardData — the structured confirmation card (frontend renders it)
// ---------------------------------------------------------------------------

// Rows in fixed order; the frontend renders k/v verbatim and applies LTR
// bidi-isolation where ltr:true (dates, times, numeric totals, masked phones).
// The draft never contains a phone: pass the masked form via opts.masked_phone.
export function buildCardData(draft, opts = {}) {
  const d = isObj(draft) ? draft : {};
  const o = isObj(opts) ? opts : {};
  const masked = typeof o.masked_phone === "string" ? o.masked_phone.trim() : "";
  const start = normalizeTimeHHmm(d.canonical_start);
  const end = normalizeTimeHHmm(d.canonical_end);
  const free = d.total_source === "free";
  const totalNum = Number(d.total);
  const totalLabel = free ? "مجاني" : `${Number.isFinite(totalNum) ? totalNum : 0} ريال`;
  const guests = Number.isInteger(d.guests) ? d.guests : 0;
  const notes = typeof d.notes === "string" && d.notes.trim() ? d.notes.trim() : "لا توجد";
  const rows = [
    { k: "العميل", v: isNonEmptyString(d.customer_name) ? d.customer_name.trim() : "—", ltr: false },
    { k: "الجوال", v: masked || "غير مضاف", ltr: Boolean(masked) },
    { k: "الشاليه", v: isNonEmptyString(d.chalet_name) ? d.chalet_name.trim() : "—", ltr: false },
    { k: "التاريخ", v: formatDateDisplay(String(d.booking_date || "")), ltr: true },
    {
      k: "الفترة",
      v: start && end ? `${start} → ${end}` : String(d.period_label || "—"),
      ltr: Boolean(start && end),
    },
    { k: "الضيوف", v: String(guests), ltr: false },
    { k: "الإجمالي", v: totalLabel, ltr: !free },
    { k: "الملاحظات", v: notes, ltr: false },
  ];
  return { title: "حجز جديد", rows, guests, total_label: totalLabel };
}
