// R11 phone-redaction hardening — regression tests for two privacy gaps the
// R10 mobile-only matcher left open. redact.mjs must NEVER let a raw customer
// number reach the DeepSeek prompt or the appended thread history.
//
//   C-P6-1  landline / international numbers passed through UNMASKED.
//   C-P8-2  a price+mobile FUSION («4500501234567») hid a raw 05XXXXXXXX.
//
// Pure-function assertions only, on redactText / hasUnredactedPhone.
import { describe, it, expect } from "vitest";
import {
  redactText,
  hasUnredactedPhone,
} from "../../supabase/functions/_shared/assistant/redact.mjs";

// Fold Arabic-Indic digits so an assertion can prove the LATIN form of an
// embedded mobile is gone even from an Arabic-typed input.
const fold = (s) =>
  String(s).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));

describe("R11 C-P6-1 — landline & international numbers are masked", () => {
  it("masks a KSA landline (011 Riyadh) that the mobile matcher missed", () => {
    const out = redactText("هاتفه 0112345678");
    expect(out).not.toContain("0112345678");
    expect(out).toContain("[هاتف محجوب]");
    expect(hasUnredactedPhone("هاتفه 0112345678")).toBe(true);
    expect(hasUnredactedPhone(out)).toBe(false);
  });

  it("masks other KSA area codes (012 Jeddah)", () => {
    const out = redactText("رقم المكتب 0122345678");
    expect(out).not.toContain("0122345678");
    expect(hasUnredactedPhone(out)).toBe(false);
  });

  it("masks an international 00-prefixed number", () => {
    const out = redactText("جواله 00201002003004");
    expect(out).not.toContain("00201002003004");
    expect(out).not.toContain("201002003004");
    expect(hasUnredactedPhone("جواله 00201002003004")).toBe(true);
    expect(hasUnredactedPhone(out)).toBe(false);
  });

  it("masks an international +-prefixed number", () => {
    const out = redactText("جواله +201002003004");
    expect(out).not.toContain("201002003004");
    expect(hasUnredactedPhone("جواله +201002003004")).toBe(true);
    expect(hasUnredactedPhone(out)).toBe(false);
  });
});

describe("R11 C-P8-2 — a fused price+mobile no longer leaks the mobile", () => {
  it("masks a Latin-digit price+mobile fusion, breaking the 05 sub-run", () => {
    const out = redactText("بمبلغ 4500501234567");
    expect(out).not.toContain("0501234567");
    expect(out).toContain("[هاتف محجوب]");
    expect(hasUnredactedPhone("بمبلغ 4500501234567")).toBe(true);
    expect(hasUnredactedPhone(out)).toBe(false);
  });

  it("masks the fusion regardless of the leading marker word", () => {
    const out = redactText("الاجمالي 4500501234567");
    expect(out).not.toContain("0501234567");
  });

  it("masks an Arabic-Indic-digit fusion (folded and raw forms both gone)", () => {
    const input = "٤٥٠٠٥٠١٢٣٤٥٦٧";
    const out = redactText(input);
    expect(out).not.toContain("٠٥٠١٢٣٤٥٦٧"); // raw Arabic-Indic mobile
    expect(fold(out)).not.toContain("0501234567"); // and its Latin fold
    expect(hasUnredactedPhone(input)).toBe(true);
    expect(hasUnredactedPhone(out)).toBe(false);
  });
});

describe("R11 guards — prices, dates and counts are NOT over-masked", () => {
  it("leaves a price with currency untouched", () => {
    expect(redactText("المبلغ 500 ريال")).toBe("المبلغ 500 ريال");
    expect(redactText("السعر 450 ريال")).toBe("السعر 450 ريال");
    expect(hasUnredactedPhone("المبلغ 500 ريال")).toBe(false);
  });

  it("leaves a bare 4-digit amount (4500) untouched", () => {
    expect(redactText("الاجمالي 4500")).toBe("الاجمالي 4500");
    expect(hasUnredactedPhone("الاجمالي 4500")).toBe(false);
  });

  it("leaves an ISO date untouched", () => {
    expect(redactText("الوصول 2026-08-15")).toBe("الوصول 2026-08-15");
    expect(hasUnredactedPhone("الوصول 2026-08-15")).toBe(false);
  });

  it("leaves a small guest count untouched (Latin and Arabic-Indic)", () => {
    expect(redactText("عدد الضيوف 4")).toBe("عدد الضيوف 4");
    expect(redactText("عدد الضيوف ٣ بسعر ٥٠٠")).toBe("عدد الضيوف ٣ بسعر ٥٠٠");
    expect(hasUnredactedPhone("عدد الضيوف 4")).toBe(false);
  });
});

describe("R11 regression — R10 mobile masking still holds", () => {
  it("still masks a plain KSA mobile", () => {
    const out = redactText("رقمي 0501234567 تمام");
    expect(out).not.toContain("0501234567");
    expect(hasUnredactedPhone(out)).toBe(false);
  });

  it("still masks a spaced/dashed mobile and a +966 mobile", () => {
    expect(redactText("جواله 050 123 4567 تمام")).not.toContain("4567");
    expect(redactText("رقمه 050-123-4567")).not.toContain("4567");
    expect(redactText("رقم +966 50 123 4567")).not.toContain("4567");
  });

  it("still masks an Arabic-Indic mobile", () => {
    expect(redactText("اتصل ٠٥٠١٢٣٤٥٦٧ اليوم")).not.toContain("٤٥٦٧");
    expect(hasUnredactedPhone("٠٥٠١٢٣٤٥٦٧")).toBe(true);
  });
});
