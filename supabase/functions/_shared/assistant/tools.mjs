// tools.mjs — the SINGLE server-side tool registry. The model may invoke ONLY
// tools listed here; there is no raw SQL, shell, arbitrary HTTP, or RPC-by-name.
// Each tool declares a validated input schema, a confirmation class, and how it
// maps onto EXISTING contracts (booking writes -> save_shared_workspace_v2;
// payments -> the PR #73 RPCs / create-payment-session). No duplicate engines.

// ---- tiny dependency-free schema validator -------------------------------
// schema: { field: { type, required?, enum?, min?, max?, maxLen? } }
export function validateArgs(schema, args) {
  const out = {};
  const errors = [];
  const a = args && typeof args === "object" ? args : {};
  for (const [field, rule] of Object.entries(schema)) {
    const present = a[field] !== undefined && a[field] !== null && a[field] !== "";
    if (!present) {
      if (rule.required) errors.push(`MISSING:${field}`);
      if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }
    let v = a[field];
    if (rule.type === "number") {
      v = Number(v);
      if (!isFinite(v)) { errors.push(`TYPE:${field}`); continue; }
      if (rule.min !== undefined && v < rule.min) errors.push(`MIN:${field}`);
      if (rule.max !== undefined && v > rule.max) errors.push(`MAX:${field}`);
    } else if (rule.type === "integer") {
      v = Number(v);
      if (!Number.isInteger(v)) { errors.push(`TYPE:${field}`); continue; }
      if (rule.min !== undefined && v < rule.min) errors.push(`MIN:${field}`);
    } else if (rule.type === "boolean") {
      v = Boolean(v);
    } else if (rule.type === "string") {
      v = String(v);
      if (rule.maxLen && v.length > rule.maxLen) v = v.slice(0, rule.maxLen);
      if (rule.enum && !rule.enum.includes(v)) errors.push(`ENUM:${field}`);
    } else if (rule.type === "date") {
      v = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`DATE:${field}`);
    }
    out[field] = v;
  }
  return { ok: errors.length === 0, errors, value: out };
}

// confirmationClass: "read" (auto), "sensitive" (two-step confirm required).
// writes: which existing contract the tool ultimately uses (documented + tested).
export const TOOL_REGISTRY = {
  // ---------------- READ ----------------
  get_today_bookings: { class: "read", schema: {}, desc: "حجوزات اليوم" },
  list_bookings: { class: "read", schema: { from: { type: "date" }, to: { type: "date" }, status: { type: "string", maxLen: 20 } }, desc: "قائمة الحجوزات" },
  get_booking_details: { class: "read", schema: { booking_id: { type: "string", required: true, maxLen: 64 } }, desc: "تفاصيل حجز" },
  get_chalet_details: { class: "read", schema: { chalet_id: { type: "string", required: true, maxLen: 64 } }, desc: "تفاصيل شاليه" },
  find_available_periods: { class: "read", schema: { chalet_id: { type: "string", maxLen: 64 }, date: { type: "date" } }, desc: "الفترات المتاحة" },
  find_empty_dates: { class: "read", schema: { chalet_id: { type: "string", maxLen: 64 }, days_ahead: { type: "integer", min: 1, max: 120, default: 14 } }, desc: "الأيام الفاضية" },
  list_outstanding_balances: { class: "read", schema: {}, desc: "المبالغ المتبقية" },
  get_booking_payment_history: { class: "read", schema: { booking_id: { type: "string", required: true, maxLen: 64 } }, desc: "سجل مدفوعات الحجز", usesContract: "get_booking_payments" },
  list_recent_payments: { class: "read", schema: { limit: { type: "integer", min: 1, max: 50, default: 10 } }, desc: "أحدث المدفوعات" },
  get_automation_status: { class: "read", schema: {}, desc: "حالة التسويق التلقائي" },
  get_campaign_results: { class: "read", schema: { limit: { type: "integer", min: 1, max: 50, default: 5 } }, desc: "نتائج الحملات" },
  get_attributed_revenue: { class: "read", schema: {}, desc: "الدخل المنسوب للمساعد" },

  // ---------------- BOOKING WRITES (via save_shared_workspace_v2 only) ----------------
  prepare_booking_create: { class: "read", schema: bookingSchema(true), desc: "تجهيز حجز جديد", usesContract: "save_shared_workspace_v2", prepares: "confirm_booking_create" },
  confirm_booking_create: { class: "sensitive", schema: confSchema(), desc: "تأكيد إنشاء حجز", usesContract: "save_shared_workspace_v2" },
  prepare_booking_update: { class: "read", schema: bookingSchema(false, true), desc: "تجهيز تعديل حجز", usesContract: "save_shared_workspace_v2", prepares: "confirm_booking_update" },
  confirm_booking_update: { class: "sensitive", schema: confSchema(), desc: "تأكيد تعديل حجز", usesContract: "save_shared_workspace_v2" },
  prepare_booking_cancel: { class: "read", schema: { booking_id: reqStr() }, desc: "تجهيز إلغاء حجز", usesContract: "save_shared_workspace_v2", prepares: "confirm_booking_cancel" },
  confirm_booking_cancel: { class: "sensitive", schema: confSchema(), desc: "تأكيد إلغاء حجز", usesContract: "save_shared_workspace_v2" },

  // ---------------- PAYMENTS (existing PR #73 contracts only) ----------------
  prepare_manual_payment: { class: "read", schema: { booking_id: reqStr(), amount_halalas: { type: "integer", required: true, min: 1 }, payment_method: { type: "string", required: true, enum: ["cash", "bank_transfer", "pos", "worker", "other"] }, reason: { type: "string", maxLen: 500 }, actor_label: { type: "string", maxLen: 120 } }, desc: "تجهيز دفعة يدوية", usesContract: "record_manual_payment", prepares: "confirm_manual_payment" },
  confirm_manual_payment: { class: "sensitive", schema: confSchema(), desc: "تأكيد دفعة يدوية", usesContract: "record_manual_payment" },
  create_payment_link: { class: "sensitive", schema: { booking_id: reqStr(), amount_halalas: { type: "integer", min: 1 } }, desc: "إنشاء رابط دفع", usesContract: "create-payment-session" },
  get_payment_link_status: { class: "read", schema: { booking_id: reqStr() }, desc: "حالة رابط الدفع", usesContract: "get_booking_payments" },

  // ---------------- COMMUNICATION ----------------
  draft_booking_confirmation: { class: "read", schema: { booking_id: reqStr() }, desc: "صياغة تأكيد حجز" },
  draft_customer_message: { class: "read", schema: { booking_id: reqStr(), intent: { type: "string", maxLen: 200 } }, desc: "صياغة رسالة عميل" },
  draft_payment_reminder: { class: "read", schema: { booking_id: reqStr() }, desc: "صياغة تذكير دفع" },
  draft_vacancy_offer: { class: "read", schema: { chalet_id: reqStr(), date: { type: "date" } }, desc: "صياغة عرض للأيام الفاضية" },
  prepare_outbound_message: { class: "read", schema: { booking_id: { type: "string", maxLen: 64 }, body: reqStr(2000) }, desc: "تجهيز رسالة للإرسال", prepares: "confirm_outbound_message" },
  confirm_outbound_message: { class: "sensitive", schema: confSchema(), desc: "تأكيد إرسال/جدولة رسالة" },
  open_manual_whatsapp: { class: "read", schema: { booking_id: reqStr() }, desc: "فتح واتساب يدوياً (لا يُعدّ إرسالاً)" },
  get_outbound_message_status: { class: "read", schema: { message_id: reqStr() }, desc: "حالة رسالة صادرة" },
};

function reqStr(maxLen = 64) { return { type: "string", required: true, maxLen }; }
// Confirmation args: the token is a two-UUID string (~73 chars), so it needs a
// larger maxLen than the default — otherwise it would be silently truncated
// and every confirmation would fail with a token mismatch.
function confSchema() {
  return {
    action_id: { type: "string", required: true, maxLen: 64 },
    confirmation_token: { type: "string", required: true, maxLen: 128 },
  };
}
function bookingSchema(create, update) {
  const s = {
    customer_name: { type: "string", required: !!create, maxLen: 120 },
    chalet_id: { type: "string", required: !!create, maxLen: 64 },
    booking_date: { type: "date", required: !!create },
    period_id: { type: "string", required: !!create, maxLen: 64 },
    guests: { type: "integer", min: 1, default: 1 },
    total: { type: "number", min: 0 },
    notes: { type: "string", maxLen: 1000 },
  };
  if (update) s.booking_id = reqStr();
  return s;
}

export function isRegisteredTool(name) {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);
}

export function toolConfirmationClass(name) {
  return TOOL_REGISTRY[name]?.class ?? null;
}

/**
 * Validate a model-requested tool call against the registry.
 * @returns {{ ok:true, name, args } | { ok:false, error, detail? }}
 */
export function normalizeToolCall(call) {
  const name = String(call?.name ?? "");
  if (!isRegisteredTool(name)) return { ok: false, error: "UNKNOWN_TOOL", detail: name };
  const spec = TOOL_REGISTRY[name];
  const { ok, errors, value } = validateArgs(spec.schema, call?.arguments ?? call?.args ?? {});
  if (!ok) return { ok: false, error: "INVALID_TOOL_ARGS", detail: errors.join(",") };
  return { ok: true, name, args: value, spec };
}

// The set of tool names exposed to the model (for the JSON contract / prompt).
export function toolCatalogForModel() {
  return Object.entries(TOOL_REGISTRY).map(([name, s]) => ({ name, description: s.desc }));
}
