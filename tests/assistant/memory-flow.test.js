// Memory end-to-end through the REAL handler (model forced offline):
// 1) a confirmed booking WRITES a phone-free customer memory;
// 2) an active memory is INJECTED into the model prompt, phone-free;
// 3) proposed memories never reach the prompt.
import { describe, it, expect } from "vitest";
import { convo } from "./helpers/audit-harness.mjs";

async function confirmBooking(c, message) {
  const r = await c.say(message);
  expect(r.model_calls).toBe(0);
  const prep = (r.raw.tool_results || []).find((x) => x.kind === "prepared_action");
  expect(prep).toBeTruthy();
  const okc = await c.post({
    invoke_tool: { name: prep.confirm_tool, arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
  });
  return okc;
}

describe("memory write on confirmed booking", () => {
  it("learns a phone-free customer preference after a confirm", async () => {
    const c = convo();
    const okc = await confirmBooking(c, "احجز تولوم بكرة صباحي 4 ضيوف باسم علي جواله 0501234567 بمبلغ 300");
    expect(okc.ok).toBe(true);
    expect(c.deps._executed).toHaveLength(1);
    const mem = c.deps._memories.find((m) => m.content_json && m.content_json.kind === "customer");
    expect(mem).toBeTruthy();
    expect(mem.status).toBe("active");
    expect(mem.memory_type).toBe("preference");
    expect(mem.content_json.summary_ar).toContain("علي");
    // The phone is NEVER stored in memory (it lives on the booking row only).
    expect(JSON.stringify(mem)).not.toContain("0501234567");
  });

  it("re-booking the same customer supersedes the old memory (no duplicates)", async () => {
    const c = convo();
    await confirmBooking(c, "احجز تولوم بكرة صباحي 4 ضيوف باسم سعد بمبلغ 300");
    await confirmBooking(c, "احجز سكاي بعد بكرة مسائي 3 ضيوف باسم سعد بمبلغ 350");
    const active = c.deps._memories.filter((m) => m.content_json && m.content_json.kind === "customer" && m.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].content_json.summary_ar).toContain("سكاي"); // the latest booking
  });
});

describe("memory injection into the model prompt", () => {
  it("injects active memories phone-free and excludes proposed ones", async () => {
    const c = convo();
    c.deps._memories.push({ id: "m1", status: "active", memory_type: "preference", content_json: { summary_ar: "العميل «علي» يفضّل المسائي." } });
    c.deps._memories.push({ id: "m2", status: "active", memory_type: "fact", content_json: { summary_ar: "جوال العميل 0501234567 مهم." } });
    c.deps._memories.push({ id: "m3", status: "proposed", memory_type: "fact", content_json: { summary_ar: "سرّي لا يظهر إطلاقاً." } });
    await c.say("اقترح علي فكرة عامة"); // falls through to the model path
    const mc = c.deps._modelCalls[0];
    expect(mc).toBeTruthy();
    const sp = mc.systemPrompt;
    expect(sp).toContain("ذاكرة نشطة");
    expect(sp).toContain("العميل «علي» يفضّل المسائي.");
    expect(sp).not.toContain("0501234567"); // phone masked
    expect(sp).not.toContain("سرّي لا يظهر"); // proposed excluded
  });

  it("adds no memory block when there are no active memories", async () => {
    const c = convo();
    await c.say("اقترح علي فكرة عامة");
    const sp = c.deps._modelCalls[0].systemPrompt;
    expect(sp).not.toContain("ذاكرة نشطة");
  });
});
