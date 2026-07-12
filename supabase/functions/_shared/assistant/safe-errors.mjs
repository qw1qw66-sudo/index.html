// safe-errors.mjs — the ONE central mapper between internal error codes and
// what the owner is allowed to see. Nothing surfaced to a human may contain a
// raw internal code, an ALL_CAPS token, a UUID, or stray English: every failed
// operation becomes { public_code, reason_ar, recoverable, next_actions? }.
//
// Pure module: no I/O, no clocks, no external deps. Internal codes may carry
// diagnostic suffixes ("BOOKING_CONFLICT:id1:id2", "PAYMENT_CHECK_FAILED:PGRST202",
// "DEEPSEEK_HTTP_503", "PAYMENT_READ_XYZ") — those resolve via prefix families.

// Stable public categories the UI is allowed to branch on.
export const PUBLIC_CODES = Object.freeze([
  "conflict",
  "stale",
  "expired",
  "already_done",
  "not_found",
  "invalid_input",
  "auth",
  "unavailable",
]);

// Tiny constructor keeping the mapping table readable.
const e = (publicCode, recoverable, reasonAr) =>
  Object.freeze({ public_code: publicCode, recoverable, reason_ar: reasonAr });

// Entries shared by several codes / prefix families.
const CONFLICT = e("conflict", true, "هذه الفترة محجوزة بالفعل. لم يتم حفظ الحجز.");
const ALREADY_DONE = e("already_done", false, "تم التعامل مع هذا الطلب مسبقاً. لا حاجة لإعادته.");
const AI_UNAVAILABLE = e("unavailable", true, "تعذّر الوصول إلى المساعد الذكي حالياً. لم يتم تنفيذ أي إجراء.");
const PAYMENT_CHECK = e("unavailable", true, "تعذّر التحقق من حالة الدفع حالياً. حاول مرة أخرى بعد قليل.");
const PAYMENT_READ = e("unavailable", true, "تعذّرت قراءة بيانات الدفع حالياً. حاول مرة أخرى بعد قليل.");

// Unknown/unmapped codes fall back to this — WITHOUT appending the code.
const FALLBACK = e("unavailable", true, "تعذّر تنفيذ الطلب حالياً، ولم يتغيّر شيء. حاول مرة أخرى بعد قليل.");

// Exact-match table. Keys are the internal codes emitted by the assistant
// stack (executors, confirmation flow, payments, threads, transport).
const ERROR_MAP = {
  // --- conflict ---------------------------------------------------------
  BOOKING_CONFLICT: CONFLICT,
  // Fail-closed data-quality block: a legacy booking without period times
  // makes availability unprovable — actionable via «جودة البيانات».
  AVAILABILITY_UNPROVABLE: e(
    "conflict",
    true,
    "لا يمكن التأكد من توفر هذه الفترة: يوجد حجز قديم بوقت فترة غير مكتمل لهذا الشاليه. أكمل وقت الفترة من «جودة البيانات» في الإعدادات ثم أعد المحاولة.",
  ),
  // Defensive whole-document fallback when a newly returned conflict token
  // cannot be tied to the booking currently being written. Migration 0007
  // grandfathers untouched legacy pairs, so existing alone never triggers it.
  WORKSPACE_DATA_CONFLICT: e(
    "conflict",
    false,
    "لا يمكن حفظ أي حجز الآن: يوجد تعارض قائم بين حجزين مؤكّدين في بياناتك. أصلح التعارض من تبويب الحجوزات (عدّل أو ألغِ أحدهما) ثم أعد المحاولة.",
  ),

  // --- stale ------------------------------------------------------------
  STALE_REVISION: e("stale", true, "تغيّرت بيانات الحجوزات بعد تجهيز الطلب. تحققت منها من جديد."),
  PAYLOAD_CHANGED: e("stale", true, "تغيّرت تفاصيل الطلب بعد تجهيزه. جهّزه من جديد للتأكد."),

  // --- expired ----------------------------------------------------------
  CONFIRMATION_EXPIRED: e("expired", true, "انتهت صلاحية التأكيد. أعدت تجهيز الطلب بأحدث البيانات."),

  // --- already_done -----------------------------------------------------
  CONFIRMATION_ALREADY_USED: ALREADY_DONE,
  ACTION_NOT_PENDING: ALREADY_DONE,

  // --- not_found --------------------------------------------------------
  ACTION_NOT_FOUND: e("not_found", false, "لم أجد هذا الطلب. ربما حُذف أو انتهت صلاحيته."),
  BOOKING_NOT_FOUND: e("not_found", false, "لم أجد هذا الحجز. تحقق من قائمة الحجوزات ثم أعد المحاولة."),
  CHALET_NOT_FOUND: e("not_found", false, "لم أجد شاليهاً بهذا الاسم. تحقق من الاسم في تبويب الشاليهات."),
  PERIOD_NOT_FOUND: e("not_found", false, "لم أجد هذه الفترة. تحقق من فترات الشاليه في تبويب الشاليهات."),
  WORKSPACE_NOT_FOUND: e("not_found", false, "لم أجد مساحة العمل. أعد تسجيل الدخول ثم حاول من جديد."),
  THREAD_NOT_FOUND: e("not_found", false, "لم أجد هذه المحادثة. افتح محادثة جديدة وأعد طلبك."),
  BOOKING_ID_MISSING: e("not_found", false, "لم يتضح أي حجز تقصد. حدده باسم العميل أو التاريخ."),

  // --- invalid_input ----------------------------------------------------
  INVALID_DATE: e("invalid_input", false, "التاريخ غير صالح. اذكر اليوم والشهر بوضوح ثم أعد المحاولة."),
  PAST_DATE: e("invalid_input", false, "هذا التاريخ في الماضي. اختر تاريخاً قادماً."),
  INVALID_GUESTS: e("invalid_input", false, "حدد عدد الضيوف — رقم صحيح واحد على الأقل."),
  GUESTS_EXCEED_CAPACITY: e("invalid_input", false, "عدد الضيوف يتجاوز سعة الشاليه. قلّل العدد أو اختر شاليهاً أكبر."),
  INVALID_TOTAL: e("invalid_input", false, "حدد الإجمالي بالريال، أو قل «الحجز مجاني» إذا كان بلا سعر."),
  CUSTOMER_NAME_REQUIRED: e("invalid_input", false, "اسم العميل مطلوب لإتمام الطلب. اذكر اسم العميل."),
  EMPTY_MESSAGE: e("invalid_input", false, "الرسالة فارغة. اكتب طلبك ثم أرسله."),
  INVALID_JSON: e("invalid_input", false, "تعذّر فهم صيغة الطلب. أعد صياغته بجملة أوضح."),
  UNKNOWN_TOOL: e("invalid_input", false, "هذا الإجراء غير معروف. صف ما تريده بكلمات أخرى."),
  INVALID_TOOL_ARGS: e("invalid_input", false, "تفاصيل الطلب غير مكتملة. أعد صياغته بوضوح أكثر."),
  UNKNOWN_THREAD_ACTION: e("invalid_input", false, "هذا الإجراء غير متاح على المحادثات."),
  CHALET_REQUIRED: e("invalid_input", false, "حدد الشاليه المطلوب أولاً."),
  PERIOD_REQUIRED: e("invalid_input", false, "حدد الفترة المطلوبة أولاً — صباحية أو مسائية مثلاً."),
  CHALET_AMBIGUOUS: e("invalid_input", false, "يوجد أكثر من شاليه مطابق. حدد الشاليه باسمه الكامل."),
  PERIOD_AMBIGUOUS: e("invalid_input", false, "توجد أكثر من فترة مطابقة. حدد الفترة بدقة."),
  PERIOD_TIME_INCOMPLETE: e("invalid_input", false, "وقت الفترة غير مكتمل. أكمل وقت البداية والنهاية من تبويب الشاليهات ثم أعد المحاولة."),
  INVALID_PHONE: e("invalid_input", false, "رقم الجوال غير صالح. تأكد من الرقم ثم أعد المحاولة."),
  AMOUNT_MUST_BE_POSITIVE: e("invalid_input", false, "المبلغ يجب أن يكون أكبر من صفر."),
  INVALID_DESTINATION: e("invalid_input", false, "وجهة الإرسال غير صالحة. تأكد من رقم الجوال المستهدف."),
  METHOD_NOT_ALLOWED: e("invalid_input", false, "طريقة الطلب غير مدعومة."),

  // Flow guidance: sensitive actions only run through the confirmation card.
  CONFIRMATION_REQUIRES_OWNER: e("invalid_input", false, "التنفيذ الحسّاس لا يتم من المحادثة مباشرة: اطلب مني «جهّز الحجز» وسأعرض لك بطاقة تأكيد تضغطها بنفسك، ولن يُحفظ شيء قبلها."),
  SENSITIVE_TOOL_REQUIRES_CONFIRMATION: e("invalid_input", false, "هذا الإجراء يحتاج بطاقة تأكيد: اطلب تجهيزه أولاً ثم أكّده بنفسك. لم يتغيّر شيء."),

  // --- auth ---------------------------------------------------------------
  AUTH_FAILED: e("auth", false, "فشل التحقق من الدخول. أعد تسجيل الدخول ثم حاول من جديد."),
  WORKSPACE_NOT_FOUND_OR_PIN_INVALID: e("auth", false, "بيانات الدخول غير صحيحة. تأكد من اسم مساحة العمل والرقم السري."),
  CONFIRMATION_TOKEN_MISMATCH: e("auth", false, "فشل التحقق من التأكيد. أعد تجهيز الطلب من جديد."),

  // --- unavailable --------------------------------------------------------
  // Synthetic frontend code for fetch/network failures.
  NETWORK: e("unavailable", true, "تعذّر الاتصال بالخادم مؤقتاً. لم يتغيّر شيء."),
  SAVE_FAILED: e("unavailable", true, "تعذّر حفظ التغييرات. لم يتغيّر شيء. حاول مرة أخرى."),
  READ_FAILED: e("unavailable", true, "تعذّرت قراءة البيانات حالياً. حاول مرة أخرى بعد قليل."),
  PREPARE_FAILED: e("unavailable", true, "تعذّر تجهيز الطلب. لم يتغيّر شيء. حاول مرة أخرى."),
  CONSUME_FAILED: e("unavailable", true, "تعذّر إتمام التأكيد. حاول مرة أخرى."),
  APPEND_FAILED: e("unavailable", true, "تعذّر حفظ الرسالة في المحادثة. حاول مرة أخرى."),
  THREAD_CREATE_FAILED: e("unavailable", true, "تعذّر فتح محادثة جديدة. حاول مرة أخرى."),
  THREAD_ARCHIVE_FAILED: e("unavailable", true, "تعذّرت أرشفة المحادثة. حاول مرة أخرى."),
  FINALIZE_FAILED: e("unavailable", true, "تعذّر إتمام العملية. تحقق من الحالة ثم أعد المحاولة."),
  FINALIZE_ROW_MISMATCH: e("unavailable", true, "لم تكتمل العملية كما هو متوقع. تحقق من الحالة الحالية قبل إعادة المحاولة."),
  PAYMENT_CHECK_FAILED: PAYMENT_CHECK,
  PAYMENT_FAILED: e("unavailable", true, "تعذّرت عملية الدفع. حاول مرة أخرى بعد قليل."),
  PAYMENT_LINK_FAILED: e("unavailable", true, "تعذّر إنشاء رابط الدفع. حاول مرة أخرى بعد قليل."),
  PAYMENT_READ_EMPTY: e("unavailable", true, "لم تصل بيانات الدفع بعد. حاول مرة أخرى بعد قليل."),
  NO_PROVIDER_CONFIGURED: e("unavailable", false, "مزوّد الدفع غير مفعّل."),
  WHATSAPP_NOT_CONFIGURED: e("unavailable", false, "خدمة واتساب غير مفعّلة بعد."),
  WHATSAPP_SEND_FAILED: e("unavailable", true, "تعذّر إرسال رسالة واتساب. حاول مرة أخرى."),
  OFFICIAL_WHATSAPP_NOT_WIRED: e("unavailable", false, "قناة واتساب الرسمية غير مربوطة بعد."),
  TOOL_NOT_IMPLEMENTED: e("unavailable", false, "هذا الإجراء غير متاح حالياً."),
  UNHANDLED_TOOL: e("unavailable", false, "هذا الإجراء غير مدعوم حالياً."),
  EXECUTION_ERROR: e("unavailable", true, "حدث خلل أثناء التنفيذ. تحقق من النتيجة قبل إعادة المحاولة."),
  PREVIOUSLY_FAILED: e("unavailable", false, "لم ينجح هذا الإجراء سابقاً. جهّزه من جديد إذا أردت."),
  ASSISTANT_CONFIRM_SECRET_MISSING: e("unavailable", false, "إعداد التأكيد غير مكتمل في الخادم. تواصل مع الدعم الفني."),
  MODEL_OUTPUT_INVALID: AI_UNAVAILABLE,
  NO_FETCH: AI_UNAVAILABLE,
};

// Prefix families, checked after exact matches. Order matters: the most
// specific prefix must come first so "PAYMENT_READ_EMPTY" (exact) still wins
// and "PAYMENT_CHECK_FAILED_X" does not land in the read family.
const PREFIX_FAMILIES = [
  ["PAYMENT_CHECK_FAILED", PAYMENT_CHECK],
  ["PAYMENT_READ_", PAYMENT_READ],
  ["BOOKING_CONFLICT", CONFLICT],
  ["DEEPSEEK_", AI_UNAVAILABLE],
];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Resolve an internal code to a frozen map entry, never throwing.
function lookup(code) {
  if (typeof code !== "string" || code === "") return FALLBACK;
  if (has(ERROR_MAP, code)) return ERROR_MAP[code];
  // Codes may carry colon-separated diagnostic suffixes; match on the base.
  const base = code.split(":", 1)[0];
  if (has(ERROR_MAP, base)) return ERROR_MAP[base];
  for (const [prefix, entry] of PREFIX_FAMILIES) {
    if (base.startsWith(prefix)) return entry;
  }
  return FALLBACK;
}

// Map an internal code to the owner-safe shape.
// ctx.reason_ar: richer contextual Arabic from the resolution layer — wins
// over the generic map text when provided.
// ctx.next_actions: passed through verbatim when provided (conflict alternatives).
export function safeError(code, ctx = {}) {
  const c = ctx || {};
  const entry = lookup(code);
  const out = {
    public_code: entry.public_code,
    reason_ar:
      typeof c.reason_ar === "string" && c.reason_ar.trim() !== ""
        ? c.reason_ar
        : entry.reason_ar,
    recoverable: entry.recoverable,
  };
  if (Array.isArray(c.next_actions)) out.next_actions = c.next_actions;
  return out;
}

// Decorate a failed result object with the owner-safe fields. The internal
// .error field is KEPT (server-side callers decide whether to strip it for
// transport or keep it for hidden diagnostics); the merge never deletes
// fields. Anything with ok !== false passes through unchanged.
export function applySafeError(resultObj) {
  if (!resultObj || typeof resultObj !== "object" || resultObj.ok !== false) {
    return resultObj;
  }
  const safe = safeError(resultObj.error, {
    reason_ar: resultObj.reason_ar,
    next_actions: resultObj.next_actions,
  });
  return { ...resultObj, ...safe };
}
