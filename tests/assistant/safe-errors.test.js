import { describe, expect, it } from "vitest";
import {
  PUBLIC_CODES,
  applySafeError,
  safeError,
} from "../../supabase/functions/_shared/assistant/safe-errors.mjs";

// Every internal code the assistant stack can emit, including suffixed
// variants that must resolve through their prefix family.
const ALL_CODES = [
  // conflict
  "BOOKING_CONFLICT",
  "BOOKING_CONFLICT:id1:id2",
  // stale
  "STALE_REVISION",
  "PAYLOAD_CHANGED",
  // expired
  "CONFIRMATION_EXPIRED",
  // already_done
  "CONFIRMATION_ALREADY_USED",
  "ACTION_NOT_PENDING",
  // not_found
  "ACTION_NOT_FOUND",
  "BOOKING_NOT_FOUND",
  "CHALET_NOT_FOUND",
  "PERIOD_NOT_FOUND",
  "WORKSPACE_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "BOOKING_ID_MISSING",
  "BOOKING_ID_CONFLICT",
  // invalid_input
  "INVALID_DATE",
  "PAST_DATE",
  "INVALID_GUESTS",
  "GUESTS_EXCEED_CAPACITY",
  "INVALID_TOTAL",
  "CUSTOMER_NAME_REQUIRED",
  "EMPTY_MESSAGE",
  "INVALID_JSON",
  "UNKNOWN_TOOL",
  "INVALID_TOOL_ARGS",
  "UNKNOWN_THREAD_ACTION",
  "CHALET_REQUIRED",
  "PERIOD_REQUIRED",
  "CHALET_AMBIGUOUS",
  "PERIOD_AMBIGUOUS",
  "PERIOD_TIME_INCOMPLETE",
  "INVALID_PHONE",
  "AMOUNT_MUST_BE_POSITIVE",
  "INVALID_DESTINATION",
  "METHOD_NOT_ALLOWED",
  "CONFIRMATION_REQUIRES_OWNER",
  "SENSITIVE_TOOL_REQUIRES_CONFIRMATION",
  // auth
  "AUTH_FAILED",
  "WORKSPACE_NOT_FOUND_OR_PIN_INVALID",
  "CONFIRMATION_TOKEN_MISMATCH",
  // unavailable
  "NETWORK",
  "SAVE_FAILED",
  "SAVE_VERIFICATION_FAILED",
  "READ_FAILED",
  "PREPARE_FAILED",
  "CONSUME_FAILED",
  "APPEND_FAILED",
  "THREAD_CREATE_FAILED",
  "THREAD_ARCHIVE_FAILED",
  "FINALIZE_FAILED",
  "FINALIZE_ROW_MISMATCH",
  "PAYMENT_CHECK_FAILED",
  "PAYMENT_CHECK_FAILED:PGRST202",
  "PAYMENT_FAILED",
  "PAYMENT_LINK_FAILED",
  "PAYMENT_READ_EMPTY",
  "PAYMENT_READ_XYZ",
  "NO_PROVIDER_CONFIGURED",
  "WHATSAPP_NOT_CONFIGURED",
  "WHATSAPP_SEND_FAILED",
  "OFFICIAL_WHATSAPP_NOT_WIRED",
  "TOOL_NOT_IMPLEMENTED",
  "UNHANDLED_TOOL",
  "EXECUTION_ERROR",
  "PREVIOUSLY_FAILED",
  "ASSISTANT_CONFIRM_SECRET_MISSING",
  "MODEL_OUTPUT_INVALID",
  "NO_FETCH",
  "DEEPSEEK_HTTP_503",
];

const INTERNAL_TOKEN_RE = /[A-Z]{2,}_[A-Z]/;
const UUIDISH_RE = /[0-9a-f]{8}-[0-9a-f]{4}/i;
const ARABIC_RE = /[؀-ۿ]/;

describe("safeError", () => {
  it("never leaks internal tokens, UUIDs, or the raw code for any known code", () => {
    for (const code of ALL_CODES) {
      const r = safeError(code);
      expect(PUBLIC_CODES, code).toContain(r.public_code);
      expect(typeof r.recoverable, code).toBe("boolean");
      expect(typeof r.reason_ar, code).toBe("string");
      expect(r.reason_ar.length, code).toBeGreaterThan(0);
      expect(r.reason_ar, code).not.toMatch(INTERNAL_TOKEN_RE);
      expect(r.reason_ar, code).not.toMatch(UUIDISH_RE);
      expect(r.reason_ar.includes(code), code).toBe(false);
      // The owner reads Arabic, not transliterated internals.
      expect(r.reason_ar, code).toMatch(ARABIC_RE);
    }
  });

  it("returns the four canonical owner texts exactly", () => {
    expect(safeError("BOOKING_CONFLICT")).toEqual({
      public_code: "conflict",
      recoverable: true,
      reason_ar: "هذه الفترة محجوزة بالفعل. لم يتم حفظ الحجز.",
    });
    expect(safeError("STALE_REVISION")).toEqual({
      public_code: "stale",
      recoverable: true,
      reason_ar: "تغيّرت بيانات الحجوزات بعد تجهيز الطلب. تحققت منها من جديد.",
    });
    expect(safeError("CONFIRMATION_EXPIRED")).toEqual({
      public_code: "expired",
      recoverable: true,
      reason_ar: "انتهت صلاحية التأكيد. أعدت تجهيز الطلب بأحدث البيانات.",
    });
    expect(safeError("NETWORK")).toEqual({
      public_code: "unavailable",
      recoverable: true,
      reason_ar: "تعذّر الاتصال بالخادم مؤقتاً. لم يتغيّر شيء.",
    });
  });

  it("maps unknown codes to a clean generic fallback without echoing them", () => {
    const r = safeError("XYZZY_WEIRD_404");
    expect(r.public_code).toBe("unavailable");
    expect(r.recoverable).toBe(true);
    expect(r.reason_ar).toBe("تعذّر تنفيذ الطلب حالياً، ولم يتغيّر شيء. حاول مرة أخرى بعد قليل.");
    expect(r.reason_ar.includes("XYZZY")).toBe(false);
    expect("next_actions" in r).toBe(false);
    // Non-string codes are treated as unknown too, never throw.
    expect(safeError(undefined).public_code).toBe("unavailable");
    expect(safeError(null).reason_ar).toBe(r.reason_ar);
  });

  it("lets contextual Arabic from the resolution layer win over the map text", () => {
    const r = safeError("PERIOD_AMBIGUOUS", { reason_ar: "نص مخصص" });
    expect(r.reason_ar).toBe("نص مخصص");
    // Category and recoverability still come from the map.
    expect(r.public_code).toBe("invalid_input");
    expect(r.recoverable).toBe(false);
  });

  it("resolves suffixed and prefixed code families to their mapped entries", () => {
    const ai = safeError("DEEPSEEK_HTTP_503");
    expect(ai.public_code).toBe("unavailable");
    expect(ai.recoverable).toBe(true);
    expect(ai.reason_ar).toBe(safeError("MODEL_OUTPUT_INVALID").reason_ar);

    const payRead = safeError("PAYMENT_READ_PGRST202");
    expect(payRead.public_code).toBe("unavailable");
    expect(payRead.reason_ar).toBe(safeError("PAYMENT_READ_OTHER_THING").reason_ar);
    expect(payRead.reason_ar).not.toBe(safeError("XYZZY_WEIRD_404").reason_ar);

    expect(safeError("PAYMENT_CHECK_FAILED:PGRST202")).toEqual(safeError("PAYMENT_CHECK_FAILED"));

    const conflict = safeError("BOOKING_CONFLICT:a:b");
    expect(conflict.public_code).toBe("conflict");
    expect(conflict.reason_ar).toBe("هذه الفترة محجوزة بالفعل. لم يتم حفظ الحجز.");
  });

  it("passes next_actions through verbatim only when provided", () => {
    const alternatives = [{ label: "الفترة الصباحية بديلاً", period_id: "p1" }];
    const r = safeError("BOOKING_CONFLICT", { next_actions: alternatives });
    expect(r.next_actions).toBe(alternatives);
    expect("next_actions" in safeError("BOOKING_CONFLICT")).toBe(false);
  });
});

describe("applySafeError", () => {
  it("passes ok results through untouched", () => {
    const okResult = { ok: true, booking_id: "b1" };
    expect(applySafeError(okResult)).toBe(okResult);
    const noOkField = { status: "idle" };
    expect(applySafeError(noOkField)).toBe(noOkField);
  });

  it("merges safe fields onto failures while keeping the internal error", () => {
    const alternatives = [{ chalet: "تولوم", period: "مسائي" }];
    const failed = {
      ok: false,
      error: "BOOKING_CONFLICT:11111111-2222:33",
      next_actions: alternatives,
    };
    const out = applySafeError(failed);
    expect(out).not.toBe(failed);
    expect(out.ok).toBe(false);
    // Internal code kept for hidden server-side diagnostics.
    expect(out.error).toBe("BOOKING_CONFLICT:11111111-2222:33");
    expect(out.public_code).toBe("conflict");
    expect(out.recoverable).toBe(true);
    expect(out.reason_ar).toBe("هذه الفترة محجوزة بالفعل. لم يتم حفظ الحجز.");
    expect(out.next_actions).toBe(alternatives);

    // Contextual reason from the resolution layer survives the merge.
    const withReason = applySafeError({
      ok: false,
      error: "STALE_REVISION",
      reason_ar: "نص من طبقة الحل",
    });
    expect(withReason.reason_ar).toBe("نص من طبقة الحل");
    expect(withReason.public_code).toBe("stale");
    expect(withReason.error).toBe("STALE_REVISION");
  });
});
