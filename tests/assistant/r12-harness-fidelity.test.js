// R12 (reverse audit 360°) — HARNESS FIDELITY. The biggest blind spot the audit
// surfaced was in the tests themselves: the SHARED convo() harness (which backs
// the 130 end-to-end confirmed-booking specs) used a rubber-stamp executeConfirmed
// that DROPPED customer_phone, hardcoded paid=0, and skipped all validation, and
// a 3-arg consumeConfirmation that ignored expiry / payload-hash / revision. The
// corpus only asserted the INPUT args (deps._executed[0].payload.args), never the
// STORED booking row — so the wrong-shaped write went uncaught. The harness now
// routes executeConfirmed through the REAL executeConfirmedAction over the
// in-memory doc and mirrors the SQL consume gate; these tests lock that in by
// asserting the persisted row + the gate outcomes through the same convo() path.
import { describe, it, expect } from "vitest";
import { convo } from "./helpers/audit-harness.mjs";

const prepared = (r) => (r.raw.tool_results || []).find((x) => x.kind === "prepared_action");
const confirm = (c, prep) =>
  c.post({ invoke_tool: { name: prep.confirm_tool, arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
const savedByName = (c, name) => (c.doc.bookings || []).find((b) => b.customer_name === name && !b.deleted_at);

describe("R12 harness fidelity — the STORED booking row matches production", () => {
  it("a stated phone is PERSISTED on the saved row (the rubber stamp dropped it)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي جواله 0501234567 بمبلغ 500");
    const prep = prepared(r);
    expect(prep).toBeTruthy();
    const okc = await confirm(c, prep);
    expect(okc.ok).toBe(true);
    const saved = savedByName(c, "علي");
    expect(saved).toBeTruthy();
    expect(saved.customer_phone).toBe("0501234567"); // stored, not dropped
    // The raw phone still never leaked into the model or the reply.
    expect(c.deps._modelCalls).toHaveLength(0);
    expect(JSON.stringify(okc)).not.toContain("0501234567");
  });

  it("a stated deposit «عربون» is PERSISTED as paid (the rubber stamp forced paid=0)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي الاجمالي 500 عربون 200");
    const prep = prepared(r);
    expect(prep).toBeTruthy();
    const okc = await confirm(c, prep);
    expect(okc.ok).toBe(true);
    const saved = savedByName(c, "علي");
    expect(saved.paid).toBe(200); // honored, not zeroed
    expect(saved.total).toBe(500); // deposit never erases the total
  });

  it("exactly ONE booking is written per confirm (the real executor + save path)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const before = c.doc.bookings.length;
    const okc = await confirm(c, prepared(r));
    expect(okc.ok).toBe(true);
    expect(c.doc.bookings.length).toBe(before + 1);
    expect(c.deps._executed).toHaveLength(1);
  });
});

describe("R12 harness fidelity — idempotent replay + crash recovery (getActionOutcome)", () => {
  it("a double-tapped confirm replays the stored result — never a second booking", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const prep = prepared(r);
    const first = await confirm(c, prep);
    expect(first.ok).toBe(true);
    const afterFirst = c.doc.bookings.length;
    // Same action_id + token again (a retry / double-tap).
    const second = await confirm(c, prep);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true); // stored outcome, not a re-execution
    expect(c.doc.bookings.length).toBe(afterFirst); // no second write
    expect(c.deps._executed).toHaveLength(1);
  });

  it("an action left «running» by a crash is RECOVERED (re-dispatched) without double-booking", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const prep = prepared(r);
    // Simulate a crash AFTER consume+finalize(running) but BEFORE execute: the
    // action is used + running, and nothing was written yet.
    const a = c.deps._actions.get(prep.action_id);
    a.status = "running";
    a.confirmation_used_at = "now";
    const rec = await confirm(c, prep);
    expect(rec.ok).toBe(true); // recovered by re-dispatch (idempotent underneath)
    expect(c.deps._executed).toHaveLength(1);
    expect(savedByName(c, "علي")).toBeTruthy();
  });
});

describe("R12 harness fidelity — the confirm gate actually rejects (expiry / payload / revision)", () => {
  it("an EXPIRED confirmation never executes and hands back a fresh card", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const prep = prepared(r);
    c.deps._actions.get(prep.action_id).expiresAtMs = Date.now() - 1000; // aged out
    const res = await confirm(c, prep);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("CONFIRMATION_EXPIRED");
    expect(res.fresh_action).toBeTruthy(); // re-prepared, not a dead end
    expect(c.deps._executed).toHaveLength(0); // nothing written
  });

  it("a TAMPERED payload hash is rejected (PAYLOAD_CHANGED), never executed", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const prep = prepared(r);
    c.deps._actions.get(prep.action_id).payloadHash = "TAMPERED";
    const res = await confirm(c, prep);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("PAYLOAD_CHANGED");
    expect(c.deps._executed).toHaveLength(0);
  });

  it("a STALE revision (a competing save moved the data) never executes; a fresh card is offered", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const prep = prepared(r);
    // Simulate a concurrent save that bumped the workspace revision after prepare.
    c.deps._actions.get(prep.action_id).expectedRevision = "r-STALE";
    const res = await confirm(c, prep);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("STALE_REVISION");
    expect(c.deps._executed).toHaveLength(0);
  });
});

describe("R12 harness fidelity — rejectMemory honors the status condition", () => {
  it("rejecting a SUPERSEDED memory reads back MEMORY_NOT_FOUND (proposed/active only)", async () => {
    const c = convo();
    // A superseded memory is terminal — the real UPDATE ... in ('proposed','active')
    // touches zero rows, so the endpoint must report it as not-found, not ok.
    c.deps._memories.push({ id: "sup1", memory_type: "fact", status: "superseded", content_json: { summary_ar: "قديمة." } });
    const res = await c.post({ memory_action: "reject", memory_id: "sup1" });
    expect(res.ok).toBe(false);
    expect(c.deps._memories.find((m) => m.id === "sup1").status).toBe("superseded"); // unchanged
  });
});
