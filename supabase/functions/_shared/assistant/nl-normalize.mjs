// nl-normalize.mjs — deterministic Arabic/Persian/Western natural-language
// TIME and DATE normalization for the booking agent (Asia/Riyadh calendar).
// Pure functions only: no I/O, no Date.now() — callers pass todayIso.
// All date arithmetic is UTC calendar math (same technique as addDays in
// availability.mjs) so results are timezone-independent.

// ---------------------------------------------------------------------------
// Digit folding + text normalization
// ---------------------------------------------------------------------------

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits -> ASCII 0-9. Everything else kept.
export function foldDigits(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

// Diacritics (harakat/tanween/quranic marks) + tatweel.
const MARKS_RE = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

// Fold digits, strip diacritics/tatweel, unify hamza-alef forms, normalize
// dashes, lowercase latin. Keeps standalone hamza (ء) so مساء survives intact.
function normalizeText(s) {
  return foldDigits(s)
    .replace(MARKS_RE, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[–—]/g, '-')
    .toLowerCase();
}

// Replace sentence punctuation with spaces (for token-based matchers).
function scrubPunct(s) {
  return s.replace(/[.,!?؟،؛:"'«»…()]/g, ' ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Time normalization
// ---------------------------------------------------------------------------

// "7:00" / "٧:٠٠" / "19:5" -> zero-padded "HH:mm"; null when missing/malformed.
export function normalizeTimeHHmm(s) {
  if (typeof s !== 'string') return null;
  const m = foldDigits(s).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

// Meridiem marker vocabularies (matched against diacritic-stripped tokens).
const AM_WORDS = new Set(['ص', 'صباحا', 'صباح', 'الصبح']);
const PM_WORDS = new Set([
  'م', 'مساءا', 'مساء', 'المسا', 'بالليل', 'ليل', 'ليلا', 'عشاء',
  'عصر', 'عصرا', 'العصر',
]);
// Noon words imply PM only for hours 1-6 and 12 (e.g. «١ ظهراً» -> 13:00).
const NOON_WORDS = new Set(['ظهر', 'ظهرا', 'الظهر']);

// Scan one side of a range for a meridiem marker (word before OR after the
// number lives in the same slice). Returns { mer:'AM'|'PM'|null, marked:bool }.
function detectMeridiem(side, hour) {
  if (/(?:^|[^a-z])am(?:$|[^a-z])/.test(side)) return { mer: 'AM', marked: true };
  if (/(?:^|[^a-z])pm(?:$|[^a-z])/.test(side)) return { mer: 'PM', marked: true };
  const words = side.match(/[ء-ي]+/g) || [];
  for (const w of words) {
    if (AM_WORDS.has(w)) return { mer: 'AM', marked: true };
    if (PM_WORDS.has(w)) return { mer: 'PM', marked: true };
    if (NOON_WORDS.has(w)) {
      if ((hour >= 1 && hour <= 6) || hour === 12) return { mer: 'PM', marked: true };
      return { mer: null, marked: false };
    }
  }
  return { mer: null, marked: false };
}

// 12h -> 24h conversion; hours 13-23 are already 24h (marker ignored).
function to24(h, mer) {
  if (h >= 13) return h;
  if (mer === 'PM') return h === 12 ? 12 : h + 12;
  if (mer === 'AM') return h === 12 ? 0 : h;
  return h;
}

// Standalone 1-2 digit hour with optional :mm (never a slice of a longer number).
const TIME_TOKEN_RE = /(?<!\d)(\d{1,2})(?::(\d{2}))?(?!\d)/g;
// Numeric date shapes that must never be misread as time ranges. A bare "7-5"
// stays a time; slashed pairs (15/08) and dash triples (01-01-2020) are dates.
const DATE_SPAN_RE = /(?<!\d)(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}\/\d{1,2})(?!\d)/g;
// Range separators tried inside the text BETWEEN the two hour tokens.
const RANGE_SEP_RE = /الى|حتى|(?<![a-z])to(?![a-z])|-/;
// Lone ل separator («من 7 ل 5») — must be standalone so بالليل/ليل survive.
const LAM_SEP_RE = /(?:^|\s)(ل)(?=\s|$)/;

// Parse a TIME RANGE from free text. Range-only: a single lone time -> null.
export function parseTimeExpression(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = normalizeText(text);

  // Collect hour tokens, skipping any that sit inside a date-looking span.
  const spans = [];
  for (const dm of t.matchAll(DATE_SPAN_RE)) {
    spans.push([dm.index, dm.index + dm[0].length]);
  }
  const tokens = [];
  for (const m of t.matchAll(TIME_TOKEN_RE)) {
    const inDate = spans.some(([a, b]) => m.index >= a && m.index < b);
    if (!inDate) tokens.push(m);
  }
  if (tokens.length < 2) return null;
  const first = tokens[0];
  const second = tokens[1];

  // Locate the separator between the two tokens; «من X … Y» allows a bare gap.
  const firstEnd = first.index + first[0].length;
  const between = t.slice(firstEnd, second.index);
  let sep = RANGE_SEP_RE.exec(between);
  let sepStart = sep ? sep.index : -1;
  let sepLen = sep ? sep[0].length : 0;
  if (!sep) {
    const lam = LAM_SEP_RE.exec(between);
    if (lam) {
      sepStart = lam.index + lam[0].indexOf('ل');
      sepLen = 1;
      sep = lam;
    }
  }
  const hasMin = /(?:^|\s)من(?:\s|$)/.test(t.slice(0, first.index));
  if (!sep && !hasMin) return null;

  const cut = sep ? firstEnd + sepStart : second.index;
  const left = t.slice(0, cut);
  const right = t.slice(sep ? cut + sepLen : cut);

  const sh = Number(first[1]);
  const smin = first[2] ? Number(first[2]) : 0;
  const eh = Number(second[1]);
  const emin = second[2] ? Number(second[2]) : 0;
  if (sh > 23 || eh > 23 || smin > 59 || emin > 59) return null;

  const sMark = detectMeridiem(left, sh);
  const eMark = detectMeridiem(right, eh);
  // A side is unambiguous when it carries a marker OR is already 24h (>=13).
  const sExplicit = sMark.marked || sh >= 13;
  const eExplicit = eMark.marked || eh >= 13;

  let startH;
  let endH;
  let confidence;
  const total = (h, min) => h * 60 + min;

  if (sExplicit && eExplicit) {
    startH = to24(sh, sMark.mer);
    endH = to24(eh, eMark.mer);
    confidence = 'high';
  } else if (sExplicit || eExplicit) {
    // One marked side: try the OPPOSITE meridiem on the bare side when that
    // yields a coherent overnight chalet slot (evening start wrapping past
    // midnight), else the SAME meridiem when it gives start<end in one day.
    const startMarked = sExplicit;
    const markedH = startMarked ? to24(sh, sMark.mer) : to24(eh, eMark.mer);
    const markedMer = (startMarked ? sMark.mer : eMark.mer) || (markedH >= 12 ? 'PM' : 'AM');
    const opp = markedMer === 'PM' ? 'AM' : 'PM';
    const same = markedMer;
    const build = (mer) => {
      const bareH = startMarked ? to24(eh, mer) : to24(sh, mer);
      return startMarked ? [markedH, bareH] : [bareH, markedH];
    };
    const [oS, oE] = build(opp);
    const [sS, sE] = build(same);
    const oppWrapsEvening =
      total(oE, emin) <= total(oS, smin) && total(oS, smin) >= 12 * 60;
    if (oppWrapsEvening) {
      [startH, endH] = [oS, oE];
    } else if (total(sS, smin) < total(sE, emin)) {
      [startH, endH] = [sS, sE];
    } else if (total(oS, smin) < total(oE, emin)) {
      [startH, endH] = [oS, oE];
    } else {
      [startH, endH] = build(null);
    }
    confidence = 'high';
  } else if (total(sh, smin) > total(eh, emin)) {
    // Bare pair like "7-5": assume the classic evening-overnight chalet slot.
    startH = to24(sh, 'PM');
    endH = to24(eh, 'AM');
    confidence = 'medium';
  } else {
    // Bare pair like "5-7": naive AM reading; caller must clarify.
    startH = sh;
    endH = eh;
    confidence = 'low';
  }

  const wraps_next_day = total(endH, emin) <= total(startH, smin);
  return {
    start: `${pad2(startH)}:${pad2(smin)}`,
    end: `${pad2(endH)}:${pad2(emin)}`,
    wraps_next_day,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Date normalization
// ---------------------------------------------------------------------------

// Add n days to a YYYY-MM-DD string (UTC calendar math, tz-independent).
export function addDaysIso(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// Calendar validation via UTC round-trip (rejects 2026-02-31, 31/11, …).
function utcValid(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const INVALID_DATE_AR = 'التاريخ غير صحيح. تأكد من اليوم والشهر.';
const PAST_DATE_AR = 'لا يمكن إنشاء حجز جديد بتاريخ ماضٍ.';

function finishDate(y, mo, d, confidence, todayIso) {
  if (!utcValid(y, mo, d)) return { error: 'INVALID_DATE', reason_ar: INVALID_DATE_AR };
  const iso = `${y}-${pad2(mo)}-${pad2(d)}`;
  if (iso < todayIso) return { error: 'PAST_DATE', reason_ar: PAST_DATE_AR };
  return { date: iso, confidence };
}

// Weekday names -> UTC day index (0 = Sunday), hamza-alef pre-normalized.
const WEEKDAYS = {
  'الاحد': 0, 'الاثنين': 1, 'الثلاثاء': 2, 'الاربعاء': 3,
  'الخميس': 4, 'الجمعة': 5, 'الجمعه': 5, 'السبت': 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};
const TODAY_WORDS = new Set(['اليوم', 'الليلة', 'الليله']);
// The alif-ending spellings (بكرا/باكرا — live bug B) are as common on
// phone keyboards as the taa-marbuta ones; matching is exact-token, so every
// accepted spelling must be listed explicitly.
const TOMORROW_WORDS = new Set(['بكرة', 'بكره', 'بكرا', 'باكر', 'باكرا', 'غدا']);
const AFTER_WORDS = new Set(['بكرة', 'بكره', 'بكرا', 'غد', 'غدا', 'باكر', 'باكرا']);

// Resolve a natural-language date reference against the caller's todayIso.
export function parseDateExpression(text, todayIso) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = scrubPunct(normalizeText(text));

  // 1) Full numeric forms (highest specificity).
  let m = t.match(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (m) return finishDate(Number(m[1]), Number(m[2]), Number(m[3]), 'high', todayIso);
  m = t.match(/(?<!\d)(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?!\d)/);
  if (m) return finishDate(Number(m[3]), Number(m[2]), Number(m[1]), 'high', todayIso);

  // 2) Keywords (can never resolve to a past date).
  const tokens = t.split(/[^0-9a-zء-ي]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'بعد' && i + 1 < tokens.length && AFTER_WORDS.has(tokens[i + 1])) {
      return { date: addDaysIso(todayIso, 2), confidence: 'high' };
    }
  }
  // «بكرة بالليل» stays tomorrow — the night word never shifts the date.
  if (tokens.some((w) => TOMORROW_WORDS.has(w))) {
    return { date: addDaysIso(todayIso, 1), confidence: 'high' };
  }
  if (tokens.some((w) => TODAY_WORDS.has(w))) {
    return { date: todayIso, confidence: 'high' };
  }
  for (const w of tokens) {
    if (Object.prototype.hasOwnProperty.call(WEEKDAYS, w)) {
      const [ty, tm, td] = todayIso.split('-').map(Number);
      const todayDow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
      const delta = (WEEKDAYS[w] - todayDow + 7) % 7; // 0 = today counts
      return { date: addDaysIso(todayIso, delta), confidence: 'high' };
    }
  }

  // 3) Day-first pair without a year: current year, rolling forward when past.
  m = t.match(/(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?![\d/-])/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(todayIso.slice(0, 4));
    if (!utcValid(y, mo, d)) return { error: 'INVALID_DATE', reason_ar: INVALID_DATE_AR };
    if (`${y}-${pad2(mo)}-${pad2(d)}` < todayIso) y += 1;
    return finishDate(y, mo, d, 'medium', todayIso);
  }

  return null;
}

// "2026-07-15" -> "15-07-2026"; "" for anything that is not a valid ISO date.
export function formatDateDisplay(iso) {
  if (typeof iso !== 'string') return '';
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !utcValid(Number(m[1]), Number(m[2]), Number(m[3]))) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ---------------------------------------------------------------------------
// Guest count / amount / free / confirmation extraction
// ---------------------------------------------------------------------------

const NUM_WORDS = {
  'واحد': 1, 'واحدة': 1, 'واحده': 1,
  'اثنين': 2, 'اثنان': 2, 'ثنين': 2,
  'ثلاثة': 3, 'ثلاثه': 3, 'ثلاث': 3,
  'اربعة': 4, 'اربعه': 4, 'اربع': 4,
  'خمسة': 5, 'خمسه': 5, 'خمس': 5,
  'ستة': 6, 'سته': 6, 'ست': 6,
  'سبعة': 7, 'سبعه': 7, 'سبع': 7,
  'ثمانية': 8, 'ثمانيه': 8, 'ثماني': 8, 'ثمان': 8,
  'تسعة': 9, 'تسعه': 9, 'تسع': 9,
  'عشرة': 10, 'عشره': 10, 'عشر': 10,
};
const PERSON_WORDS =
  '(?:اشخاص|شخصا|شخص|انفار|نفر|ضيوف|ضيف|افراد|فرد|زوار|زائر|guests?|persons?|people|pax)';
// Longest-first so ثلاثة wins over ثلاث inside the alternation.
const NUM_WORD_ALTS = Object.keys(NUM_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

// Extract a guest headcount; amounts («500 ريال») are never guest counts.
export function extractGuestCount(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = scrubPunct(normalizeText(text));
  const inRange = (n) => (Number.isInteger(n) && n >= 1 && n <= 200 ? n : null);

  // Dual forms: لشخصين / شخصين / نفرين -> 2 ; «شخص واحد» -> 1.
  if (/(?:^|\s)(?:لل?)?(?:شخصين|شخصان|نفرين)(?=\s|$)/.test(t)) return 2;
  if (/(?:^|\s)ل?شخص واحد(?=\s|$)/.test(t)) return 1;

  // Digits next to a person word (either order, e.g. «٤ أشخاص», "guests 4").
  let m = t.match(new RegExp(`(?<!\\d)(\\d{1,3})(?!\\d)\\s*${PERSON_WORDS}`));
  if (!m) m = t.match(new RegExp(`${PERSON_WORDS}\\s*(\\d{1,3})(?!\\d)`));
  if (m) return inRange(Number(m[1]));

  // Arabic number word next to a person word, incl. the attached «لـ» ("for")
  // prefix: «اربعة اشخاص», «لأربعة أشخاص», «لاربعه ضيوف».
  m = t.match(new RegExp(`(?:^|\\s)ل?(${NUM_WORD_ALTS})\\s+${PERSON_WORDS}`));
  if (m) return NUM_WORDS[m[1]];

  // Whole message is just a number word or a small bare number.
  const bare = t.trim();
  if (/^\d{1,3}$/.test(bare)) return inRange(Number(bare));
  if (Object.prototype.hasOwnProperty.call(NUM_WORDS, bare)) return NUM_WORDS[bare];
  return null;
}

// Hundred/thousand money words (hamza/diacritics pre-normalized).
const MONEY_WORDS = {
  'مئة': 100, 'مائة': 100, 'مية': 100, 'ميه': 100,
  'مئتين': 200, 'مئتان': 200, 'مائتين': 200, 'ميتين': 200,
  'ثلاثمئة': 300, 'ثلاثمائة': 300,
  'اربعمئة': 400, 'اربعمائة': 400,
  'خمسمئة': 500, 'خمسمائة': 500,
  'ستمئة': 600, 'ستمائة': 600,
  'سبعمئة': 700, 'سبعمائة': 700,
  'ثمانمئة': 800, 'ثمانمائة': 800, 'ثمنمئة': 800,
  'تسعمئة': 900, 'تسعمائة': 900,
  'الف': 1000,
};
const CURRENCY_RE = '(?:ريالات|ريالا|ريال|ر\\.س|sar(?![a-z])|sr(?![a-z]))';

// Extract a money amount. Bare numbers WITHOUT currency return null unless the
// whole message is just the number. «أربعة» alone is a guest word, not money.
export function extractAmount(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // U+066B is the Arabic decimal separator.
  const t = normalizeText(text).replace(/٫/g, '.');

  // Digits + currency, attached or spaced («٥٠٠ ريال», "500ريال", "500 sar").
  const m = t.match(new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*${CURRENCY_RE}`));
  if (m) return Number(m[1]);

  // Hundred-words with optional و/ب prefixes («بمئة ريال» -> 100, «بخمسمئة» -> 500).
  const words = scrubPunct(t).split(/\s+/).filter(Boolean);
  for (const raw of words) {
    const candidates = [raw];
    if (raw.startsWith('وب')) candidates.push(raw.slice(2));
    if (raw.startsWith('و')) candidates.push(raw.slice(1));
    if (raw.startsWith('ب')) candidates.push(raw.slice(1));
    for (const w of candidates) {
      if (Object.prototype.hasOwnProperty.call(MONEY_WORDS, w)) return MONEY_WORDS[w];
    }
  }
  // Two-token form «خمس مئة» -> 500.
  const pair = t.match(/(?:^|\s)ب?(ثلاث|اربع|خمس|ست|سبع|ثمان|تسع)\s+(مئة|مائة)(?=\s|$)/);
  if (pair) {
    const UNITS = { 'ثلاث': 3, 'اربع': 4, 'خمس': 5, 'ست': 6, 'سبع': 7, 'ثمان': 8, 'تسع': 9 };
    return UNITS[pair[1]] * 100;
  }

  // Whole message is just the number -> accept without a currency word.
  const bare = scrubPunct(t).trim();
  if (/^\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return null;
}

// Explicit "free of charge" phrases only — a MISSING price never implies free.
export function isExplicitFree(text) {
  if (typeof text !== 'string') return false;
  const t = scrubPunct(normalizeText(text));
  if (/(?:^|\s)(?:مجاني|مجانا|مجانية|مجانيه)(?=\s|$)/.test(t)) return true;
  if (/بدون سعر|بلا سعر|صفر ريال|الاجمالي صفر/.test(t)) return true;
  return t.trim() === 'صفر';
}

// ---------------------------------------------------------------------------
// Bare confirmation detection
// ---------------------------------------------------------------------------

export const CONFIRM_PHRASES = [
  'سجل', 'سجّل', 'أكد', 'أكّد', 'نعم', 'تمام', 'نفذ', 'نفّذ',
  'احفظ', 'حفظ', 'اعتمد', 'موافق', 'ok', 'يس', 'ايوه', 'اجل', 'أجل',
];
const CONFIRM_SET = new Set(CONFIRM_PHRASES.map((p) => normalizeText(p)));
// Neutral fillers that may ride along («سجل الحجز», «اعتمد الان»).
const CONFIRM_FILLERS = new Set(['الحجز', 'الان']);

// True when the whole message is a bare confirmation (max 3 tokens, no digits,
// no booking content). «سجل الحجز» -> true; «سجل حجز جديد لعلي بكرة» -> false.
export function isBareConfirmPhrase(text) {
  if (typeof text !== 'string') return false;
  const t = scrubPunct(normalizeText(text)).trim();
  if (!t || /\d/.test(t)) return false;
  const tokens = t.split(/\s+/);
  if (tokens.length > 3) return false;
  let hasConfirm = false;
  for (const w of tokens) {
    if (CONFIRM_SET.has(w)) {
      hasConfirm = true;
    } else if (!CONFIRM_FILLERS.has(w)) {
      return false;
    }
  }
  return hasConfirm;
}
