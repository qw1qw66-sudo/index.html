import { describe, expect, it } from "vitest";
import { convo, replyProblems } from "./helpers/audit-harness.mjs";

// F3 — the assistant records EXPENSES itself: «سجّل مصروف كهرباء ٣٠٠» prepares a
// confirmation card deterministically (model_calls=0); the owner confirms with
// the token; the expense is appended to doc.expenses in the exact browser shape.
// Reads («كم صرفت؟») and bookings («احجز…») are never mistaken for a write.

function preparedExpense(res) {
  return (res.raw.tool_results || []).find(
    (x) => x.kind === "prepared_action" && x.confirm_tool === "confirm_add_expense",
  );
}

describe("F3: assistant records expenses (deterministic write)", () => {
  it("«سجّل مصروف كهرباء ٣٠٠» prepares (model_calls=0), and confirming saves it", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف كهرباء ٣٠٠");
    expect(r.model_calls).toBe(0);
    expect(replyProblems(r.reply)).toEqual([]);
    const prep = preparedExpense(r);
    expect(prep).toBeTruthy();
    // The card shows the category + amount in whole riyals (no PII).
    const rows = Object.fromEntries((r.card || []).map((x) => [x.k, x.v]));
    expect(rows["النوع"]).toBe("كهرباء");
    expect(String(rows["المبلغ"])).toContain("300");

    // Owner confirms with the token → the expense is saved to the document.
    const saved = await c.post({
      invoke_tool: { name: "confirm_add_expense", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
    });
    expect(saved.ok).toBe(true);
    const expenses = c.doc.expenses || [];
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ category: "كهرباء", amount: 300, chalet_id: "", deleted_at: null });
    expect(expenses[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(expenses[0].id).toBeTruthy();
  });

  it("«سجّل مصروف ٥٠٠» with no category defaults to «أخرى»", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف ٥٠٠");
    expect(r.model_calls).toBe(0);
    const prep = preparedExpense(r);
    expect(prep).toBeTruthy();
    const saved = await c.post({
      invoke_tool: { name: "confirm_add_expense", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
    });
    expect(saved.ok).toBe(true);
    expect((c.doc.expenses || [])[0]).toMatchObject({ category: "أخرى", amount: 500 });
  });

  it("an expense line with NO amount asks for the amount (never a booking misfire)", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف كهرباء");
    expect(r.model_calls).toBe(0);
    expect(preparedExpense(r)).toBeFalsy();
    expect(r.reply).toContain("مبلغ"); // asks «كم مبلغ المصروف؟»
    expect(r.reply).not.toContain("شاليه"); // NOT routed to the booking pipeline
    expect(c.doc.expenses || []).toHaveLength(0);
  });

  it("does NOT hijack an expense READ («كم صرفت هذا الشهر؟»)", async () => {
    const c = convo();
    const r = await c.say("كم صرفت هذا الشهر؟");
    expect(r.model_calls).toBe(0);
    expect(preparedExpense(r)).toBeFalsy(); // a read, never a write
    expect(c.doc.expenses || []).toHaveLength(0);
  });

  it("an expense-record VERB inside a QUESTION stays a read, not an amount prompt", async () => {
    // «سجّلت/سجّلتها» is a record-verb, but the message is a QUESTION about
    // recorded expenses — it must not be answered with «كم مبلغ المصروف؟».
    for (const q of ["كم مصروف سجّلت هذا الشهر؟", "وش المصاريف اللي سجّلتها؟"]) {
      const c = convo();
      const r = await c.say(q);
      expect(preparedExpense(r)).toBeFalsy();
      expect(r.reply).not.toContain("كم مبلغ المصروف");
      expect(c.doc.expenses || []).toHaveLength(0);
    }
  });

  it("does NOT catch a booking command («احجز تولوم بكرة المسائية»)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة المسائية");
    expect(preparedExpense(r)).toBeFalsy(); // goes to the booking pipeline
    expect(c.doc.expenses || []).toHaveLength(0);
  });

  it("a stated chalet name links the expense to that chalet", async () => {
    const c = convo();
    // richDoc has «شاليه تولوم 2»; a direct invoke_tool prepare passes the exact
    // name (its response IS the prepared_action, not a tool_results wrapper).
    const p = await c.post({
      invoke_tool: { name: "prepare_add_expense", arguments: { amount: 250, category: "صيانة", chalet_name: "شاليه تولوم 2" } },
    });
    expect(p.kind).toBe("prepared_action");
    expect(p.confirm_tool).toBe("confirm_add_expense");
    const saved = await c.post({
      invoke_tool: { name: "confirm_add_expense", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } },
    });
    expect(saved.ok).toBe(true);
    expect((c.doc.expenses || [])[0]).toMatchObject({ category: "صيانة", amount: 250, chalet_id: "tulum2" });
  });

  it("records the MONEY-marked amount, not a chalet ordinal («صيانة شاليه ٢ مبلغ ٥٠٠» → ٥٠٠)", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف صيانة شاليه ٢ مبلغ ٥٠٠");
    expect(r.model_calls).toBe(0);
    const prep = preparedExpense(r);
    expect(prep).toBeTruthy();
    const rows = Object.fromEntries((r.card || []).map((x) => [x.k, x.v]));
    expect(String(rows["المبلغ"])).toContain("500"); // NOT «2»
    expect(String(rows["المبلغ"])).not.toMatch(/(^|[^\d])2([^\d]|$)/);
    const saved = await c.post({
      invoke_tool: { name: "confirm_add_expense", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
    });
    expect(saved.ok).toBe(true);
    expect((c.doc.expenses || [])[0]).toMatchObject({ category: "صيانة", amount: 500 });
  });

  it("reads an amount that TRAILS a currency word («٥٠٠ ريال» → ٥٠٠)", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف كهرباء ٥٠٠ ريال");
    const prep = preparedExpense(r);
    expect(prep).toBeTruthy();
    const saved = await c.post({
      invoke_tool: { name: "confirm_add_expense", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
    });
    expect(saved.ok).toBe(true);
    expect((c.doc.expenses || [])[0]).toMatchObject({ category: "كهرباء", amount: 500 });
  });

  it("a chalet ordinal ALONE (no real amount) asks for the amount, never banks the unit number", async () => {
    const c = convo();
    const r = await c.say("سجّل مصروف صيانة شاليه ٢");
    expect(r.model_calls).toBe(0);
    expect(preparedExpense(r)).toBeFalsy(); // «٢» is a chalet ordinal, not a cost
    expect(r.reply).toContain("مبلغ"); // asks «كم مبلغ المصروف؟»
    expect(c.doc.expenses || []).toHaveLength(0);
  });
});
