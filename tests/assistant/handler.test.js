import { describe, expect, it } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { hashPayload, stableStringify } from "../../supabase/functions/_shared/assistant/confirmation.mjs";

// Drives the REAL assistant handler with an injected model + in-memory data
// layer, verifying the deterministic safety rules independent of DeepSeek.

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WSA";

function makeDeps({ model, workspaces = { [WS]: { pin: "123456", revision: "2026-01-01T00:00:00Z" } }, memories = [], executor, resolver } = {}) {
  const actions = new Map();
  const executed = [];
  return {
    env: ENV,
    executed,
    actions,
    async auth(k, pin) {
      const w = workspaces[k];
      return w && w.pin === pin ? { ok: true, workspace_key: k } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
    },
    async callModel() { return model; },
    async activeMemories() { return memories; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision(k) { return workspaces[k]?.revision ?? null; },
    async runReadTool(_k, name, args) { return { name, args, sample: true }; },
    async resolveBookingCreateArgs(_k, args) { return resolver ? resolver(args) : { ok: true, args, suggested_price: Number(args.total) || 500 }; },
    async prepareSensitive(_k, spec) {
      const id = "act-" + (actions.size + 1);
      actions.set(id, { id, ...spec, workspace_key: _k, status: "prepared", confirmation_used_at: null });
      return { action_id: id };
    },
    async getConfirmationContext(_k, id) {
      const a = actions.get(id);
      if (!a || a.workspace_key !== _k) return null;
      return { action: a, tool_name: a.name, action_type: a.actionType, normalized_payload: { tool: a.name, args: a.args } };
    },
    async consumeConfirmation(_k, id, tokenHash, payloadHash) {
      const a = actions.get(id);
      if (!a) return { ok: false, error: "ACTION_NOT_FOUND" };
      if (a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" };
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      if (a.payloadHash !== payloadHash) return { ok: false, error: "PAYLOAD_CHANGED" };
      a.status = "confirmed"; a.confirmation_used_at = "now";
      return { ok: true };
    },
    async executeConfirmed(_k, action) {
      executed.push(action);
      return executor ? executor(action) : { ok: true, result_reference: "ref-1", safe_result: { done: true } };
    },
    async finalizeAction(_k, id, patch) { const a = actions.get(id); if (a) Object.assign(a, patch); },
  };
}

function chat(body) {
  return new Request("https://edge.local/chalet-assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("assistant handler: safety rules", () => {
  it("wrong PIN => 401, no model call", async () => {
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "nope", message: "hi" }), makeDeps({ model: { ok: true, reply: "x", toolCalls: [] } }));
    expect(res.status).toBe(401);
  });

  it("model unavailable => fail closed, no action", async () => {
    const deps = makeDeps({ model: { ok: false, error: "DEEPSEEK_KEY_MISSING" } });
    // A prepare-style request NEEDS the model (deterministic reads don't).
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "جهز حجز جديد لبكرة" }), deps);
    const b = await res.json();
    expect(b.assistant_unavailable).toBe(true);
    expect(deps.executed).toHaveLength(0);
  });

  it("read tool from the model executes without confirmation", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "حجوزات اليوم", toolCalls: [{ name: "get_today_bookings", arguments: {} }] } });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "حجوزات اليوم؟" }), deps);
    const b = await res.json();
    expect(b.tool_results[0]).toMatchObject({ tool: "get_today_bookings", ok: true, kind: "read" });
  });

  it("unknown/arbitrary tool from the model is NEVER executed", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "run_sql", arguments: { q: "drop table bookings" } }, { name: "exec_shell", arguments: {} }] } });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "x" }), deps);
    const b = await res.json();
    expect(b.tool_results.every((r) => r.ok === false)).toBe(true);
    expect(deps.executed).toHaveLength(0);
  });

  it("the model cannot self-confirm a sensitive action", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "confirm_manual_payment", arguments: { action_id: "x", confirmation_token: "y" } }] } });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "سجل دفعة" }), deps);
    const b = await res.json();
    expect(b.tool_results[0]).toMatchObject({ ok: false, error: "CONFIRMATION_REQUIRES_OWNER" });
    expect(deps.executed).toHaveLength(0);
  });

  it("a prepare tool creates an action + token but does NOT execute anything", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "جهزت الحجز", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_id: "c1", booking_date: "2099-06-01", period_id: "p1", guests: 2, total: 400 } }] } });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "جهز حجز" }), deps);
    const b = await res.json();
    const prep = b.tool_results[0];
    expect(prep).toMatchObject({ ok: true, kind: "prepared_action", confirm_tool: "confirm_booking_create" });
    expect(prep.confirmation_token).toBeTruthy();
    expect(deps.executed).toHaveLength(0);
  });

  it("a booking named «تولوم» is bound to authoritative ids before confirmation", async () => {
    const deps = makeDeps({
      model: { ok: true, reply: "أجهّز الحجز", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "تولوم", period_label: "المسائية", booking_date: "2099-06-01", guests: 2, total: 400 } }] },
      resolver: (args) => ({ ok: true, suggested_price: Number(args.total) || 400, args: { ...args, chalet_id: "real-tulum", chalet_name: "شاليه تولوم", period_id: "real-evening", period_label: "مسائي" } }),
    });
    const b = await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "جهز حجز في تولوم" }), deps)).json();
    const prep = b.tool_results[0];
    expect(prep).toMatchObject({ ok: true, kind: "prepared_action" });
    expect(deps.actions.get(prep.action_id).args).toMatchObject({ chalet_id: "real-tulum", period_id: "real-evening" });
    expect(prep.summary_ar).toContain("شاليه تولوم");
    expect(deps.executed).toHaveLength(0);
  });

  it("an unknown chalet fails closed and creates no pending action", async () => {
    const deps = makeDeps({
      model: { ok: true, reply: "", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "غير موجود", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 400 } }] },
      resolver: () => ({ ok: false, error: "CHALET_NOT_FOUND", reason_ar: "الشاليهات المسجلة: شاليه سكاي، شاليه تولوم." }),
    });
    const b = await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "جهز حجز" }), deps)).json();
    expect(b.tool_results[0]).toMatchObject({ ok: false, error: "CHALET_NOT_FOUND" });
    expect(deps.actions.size).toBe(0);
    expect(deps.executed).toHaveLength(0);
  });

  it("confirm (owner) consumes the token and executes the underlying contract", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] } });
    const prep = (await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "جهز دفعة" }), deps)).json()).tool_results[0];

    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", invoke_tool: { name: "confirm_manual_payment", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } }), deps);
    const b = await res.json();
    expect(b.ok).toBe(true);
    expect(b.kind).toBe("completed_action");
    expect(deps.executed).toHaveLength(1);
    expect(deps.executed[0].tool_name).toBe("confirm_manual_payment");
  });

  it("a replayed confirmation is rejected (no second execution)", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] } });
    const prep = (await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "x" }), deps)).json()).tool_results[0];
    const invoke = { name: "confirm_manual_payment", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } };
    await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", invoke_tool: invoke }), deps);
    const res2 = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", invoke_tool: invoke }), deps);
    expect((await res2.json()).error).toBe("CONFIRMATION_ALREADY_USED");
    expect(deps.executed).toHaveLength(1);
  });

  it("confirm with a wrong token is rejected", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] } });
    const prep = (await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "x" }), deps)).json()).tool_results[0];
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", invoke_tool: { name: "confirm_manual_payment", arguments: { action_id: prep.action_id, confirmation_token: "wrong-token" } } }), deps);
    expect((await res.json()).error).toBe("CONFIRMATION_TOKEN_MISMATCH");
    expect(deps.executed).toHaveLength(0);
  });

  it("never claims success when the underlying contract fails", async () => {
    const deps = makeDeps({
      model: { ok: true, reply: "", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] },
      executor: () => ({ ok: false, error: "AMOUNT_EXCEEDS_REMAINING" }),
    });
    const prep = (await (await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "x" }), deps)).json()).tool_results[0];
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", invoke_tool: { name: "confirm_manual_payment", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } }), deps);
    const b = await res.json();
    expect(b.ok).toBe(false);
    expect(b.error).toBe("AMOUNT_EXCEEDS_REMAINING");
    expect(b.done_ar).toContain("لم يكتمل");
  });

  it("an active hard-block memory blocks the prepared action", async () => {
    const deps = makeDeps({
      model: { ok: true, reply: "", toolCalls: [{ name: "prepare_booking_cancel", arguments: { booking_id: "b1" } }] },
      memories: [{ status: "active", enforcement_level: "hard_block", content_json: { block_action_types: ["confirm_booking_cancel"], reason_ar: "ممنوع الإلغاء تلقائياً" } }],
    });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "الغِ الحجز" }), deps);
    const b = await res.json();
    expect(b.tool_results[0]).toMatchObject({ ok: false, error: "BLOCKED_BY_MEMORY" });
  });

  it("does not leak the confirm secret in any response", async () => {
    const deps = makeDeps({ model: { ok: true, reply: "تمام", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] } });
    const res = await handleAssistant(chat({ workspace_key: WS, access_pin: "123456", message: "x" }), deps);
    expect(await res.text()).not.toContain("sec");
  });

  it("cross-workspace: a confirmation prepared in WSA cannot be confirmed as WSB", async () => {
    const workspaces = { WSA: { pin: "111111", revision: "r1" }, WSB: { pin: "222222", revision: "r2" } };
    const deps = makeDeps({ model: { ok: true, reply: "", toolCalls: [{ name: "prepare_manual_payment", arguments: { booking_id: "b1", amount_halalas: 20000, payment_method: "cash" } }] }, workspaces });
    const prep = (await (await handleAssistant(chat({ workspace_key: "WSA", access_pin: "111111", message: "x" }), deps)).json()).tool_results[0];
    const res = await handleAssistant(chat({ workspace_key: "WSB", access_pin: "222222", invoke_tool: { name: "confirm_manual_payment", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } }), deps);
    expect((await res.json()).error).toBe("ACTION_NOT_FOUND");
    expect(deps.executed).toHaveLength(0);
  });
});

describe("confirmation payload binding", () => {
  it("the stored payload hash matches the confirm-time recomputation", () => {
    const payload = { tool: "confirm_manual_payment", args: { booking_id: "b1", amount_halalas: 20000 } };
    expect(hashPayload(payload)).toBe(hashPayload(JSON.parse(stableStringify(payload))));
  });
});
