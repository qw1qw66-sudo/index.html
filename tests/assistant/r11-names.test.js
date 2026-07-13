// R11 — NAME-capture regressions for booking-planner.mjs.
//
// Four adversarial findings where extractCustomerName either DROPPED a real
// name, RAN ON past it, or swallowed a title/guest phrase. Each finding mixes a
// pure assertion (extractFacts → fields.customer_name, no network) with a real
// end-to-end convo() turn driven through the deployed handler; every convo turn
// asserts model_calls === 0 (the deterministic planner path, model unreachable).
import { describe, it, expect } from "vitest";
import { extractFacts } from "../../supabase/functions/_shared/assistant/booking-planner.mjs";
import { convo, TODAY } from "/tmp/claude-0/-home-user-index-html/b2f2de9e-599a-5acd-b19d-df4e536dbc41/scratchpad/audit-harness.mjs";

// extractCustomerName is not exported; read the captured name through extractFacts.
const name = (msg) => extractFacts(msg, TODAY).fields.customer_name;

describe("R11 — name capture regressions", () => {
  it("A-P1-8: «صباح»/«مساء» are names after an explicit marker, still stops otherwise", async () => {
    // PRE: «صباح» is a NAME_STOP time word, so «باسم صباح» dropped the name.
    expect(name("باسم صباح")).toBe("صباح");
    // Adjective forms stay hard stops: «باسم عبدالله مسائي» → «عبدالله».
    expect(name("باسم عبدالله مسائي")).toBe("عبدالله");
    // A bare «صباح» with NO marker is still not a name.
    expect(name("صباح")).toBeUndefined();
    // End-to-end: the marker-introduced «صباح» is captured, zero model calls.
    const r = await convo().say("احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم صباح");
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe("صباح");
  });

  it("A-P1-7: chalet «اسمه سكاي» is skipped and a glued «والعميل» ends the run-on", async () => {
    // PRE: customer_name ran on to «سكاي والعميل احمد» and grabbed the chalet.
    const r = await convo().say(
      "احجز الشاليه اسمه سكاي والعميل احمد بكرة صباحي 4 ضيوف بمبلغ 300",
    );
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe("احمد");
    // Control: a plain «العميل احمد وجواله …» still stops cleanly at the phone.
    expect(name("العميل احمد وجواله 0501234567")).toBe("احمد");
  });

  it("AW-P3-1: a trailing guest phrase (number-words / duals) no longer pollutes the name", async () => {
    // PRE: «محمد لاربعة», «محمد ضيفين», «محمد لخمسة».
    expect(name("باسم محمد لاربعة اشخاص")).toBe("محمد");
    expect(name("باسم محمد ضيفين")).toBe("محمد");
    expect(name("باسم محمد لخمسة")).toBe("محمد");
    // Controls: a legitimate name is never over-stopped.
    expect(name("باسم محمد")).toBe("محمد");
    expect(name("باسم عبدالله")).toBe("عبدالله");
    // End-to-end, zero model calls.
    const r = await convo().say("احجز تولوم بكرة صباحي باسم محمد لاربعة اشخاص بمبلغ 300");
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe("محمد");
  });

  it("A-P2-6: a leading honorific (fem/other) is stripped from the captured name", async () => {
    // PRE: «الاستاذة فاطمة», «الدكتورة نورة» (fem honorific not stripped).
    expect(name("باسم الاستاذة فاطمة")).toBe("فاطمة");
    expect(name("باسم الدكتورة نورة")).toBe("نورة");
    // Masc «الاستاذ» after «باسم» is also stripped now.
    expect(name("باسم الاستاذ محمد")).toBe("محمد");
    // End-to-end, zero model calls.
    const r = await convo().say("احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم الاستاذة فاطمة");
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe("فاطمة");
  });
});
