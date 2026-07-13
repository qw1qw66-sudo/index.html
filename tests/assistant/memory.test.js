// Memory module: phone-free rendering + proposed-memory shaping.
import { describe, it, expect } from "vitest";
import {
  renderMemoriesForPrompt,
  customerFactFromBooking,
  buildProposedMemory,
  memoryDedupeKey,
} from "../../supabase/functions/_shared/assistant/memory.mjs";

describe("renderMemoriesForPrompt", () => {
  it("renders active memories with an Arabic heading", () => {
    const block = renderMemoriesForPrompt([
      { status: "active", memory_type: "preference", content_json: { summary_ar: "العميل «علي» يفضّل المسائي." } },
      { status: "active", memory_type: "policy", content_json: { summary_ar: "لا حجوزات يوم الجمعة." } },
    ]);
    expect(block).toContain("ذاكرة نشطة");
    expect(block).toContain("العميل «علي» يفضّل المسائي.");
    expect(block).toContain("لا حجوزات يوم الجمعة.");
  });

  it("NEVER leaks a raw phone into the prompt (masks it)", () => {
    const block = renderMemoriesForPrompt([
      { status: "active", memory_type: "fact", content_json: { summary_ar: "جوال العميل 0501234567 مهم." } },
    ]);
    expect(block).not.toContain("0501234567");
    expect(block).toContain("[هاتف محجوب]");
  });

  it("excludes proposed (non-active) memories", () => {
    const block = renderMemoriesForPrompt([
      { status: "proposed", memory_type: "fact", content_json: { summary_ar: "لا تظهر." } },
    ]);
    expect(block).toBe("");
  });

  it("excludes gate-only policy rows that carry no summary", () => {
    const block = renderMemoriesForPrompt([
      { status: "active", memory_type: "policy", content_json: { block_tools: ["send_message"], reason_ar: "ممنوع" } },
    ]);
    expect(block).toBe("");
  });

  it("returns '' when there is nothing injectable", () => {
    expect(renderMemoriesForPrompt([])).toBe("");
    expect(renderMemoriesForPrompt(null)).toBe("");
  });

  it("caps the number of rendered lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      status: "active", memory_type: "fact", content_json: { summary_ar: `معلومة رقم ${i}.` },
    }));
    const lines = renderMemoriesForPrompt(many, { max: 5 }).split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(5);
  });
});

describe("customerFactFromBooking", () => {
  it("proposes a phone-free customer preference (proposed/advisory)", () => {
    const m = customerFactFromBooking({ customer_name: "علي", chalet_name: "شاليه تولوم", period_label: "مسائي", booking_id: "bk-1" });
    expect(m.status).toBe("proposed");
    expect(m.enforcement_level).toBe("advisory");
    expect(m.memory_type).toBe("preference");
    expect(m.content_json.summary_ar).toContain("علي");
    expect(m.content_json.summary_ar).toContain("شاليه تولوم");
    expect(m.content_json.kind).toBe("customer");
    expect(m.source_reference).toBe("bk-1");
  });

  it("returns null without a usable name or chalet", () => {
    expect(customerFactFromBooking({ chalet_name: "تولوم" })).toBeNull();
    expect(customerFactFromBooking({ customer_name: "علي" })).toBeNull();
  });

  it("dedupe key is stable per customer", () => {
    const a = customerFactFromBooking({ customer_name: "علي", chalet_name: "تولوم" });
    const b = customerFactFromBooking({ customer_name: "علي", chalet_name: "سكاي" });
    expect(memoryDedupeKey(a)).toBe(memoryDedupeKey(b));
  });
});

describe("buildProposedMemory", () => {
  it("forces the non-authoritative shape and rejects a phone-only summary", () => {
    expect(buildProposedMemory({ summary_ar: "0501234567" })).toBeNull();
    const m = buildProposedMemory({ memory_type: "lesson", summary_ar: "صحّح المالك اسم العميل مرة." });
    expect(m.status).toBe("proposed");
    expect(m.enforcement_level).toBe("advisory");
  });

  it("a model source can NEVER self-assign a stronger enforcement level", () => {
    const m = buildProposedMemory({ summary_ar: "قاعدة مهمة جداً", source_type: "model", enforcement_level: "hard_block" });
    expect(m.enforcement_level).toBe("advisory");
  });

  it("an owner/pipeline source MAY request a stronger level", () => {
    const m = buildProposedMemory({ summary_ar: "لا حجوزات يوم الجمعة", source_type: "owner", enforcement_level: "hard_block" });
    expect(m.enforcement_level).toBe("hard_block");
  });
});
