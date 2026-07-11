import { describe, expect, it } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";

// The chat turn must return ONE natural Arabic answer. The final reply and the
// deterministic fallback must never leak internal tool names, raw error codes,
// the stage-1 planning seed, or confirmation tokens.

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WSX";

function makeDeps({ modelSeq, readResult } = {}) {
  let call = 0;
  const modelCalls = [];
  const appended = [];
  const actions = new Map();
  return {
    env: ENV,
    _modelCalls: modelCalls,
    _appended: appended,
    _actions: actions,
    async auth(k, pin) {
      return k === WS && pin === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
    },
    async callModel(arg) {
      modelCalls.push(arg);
      const r = modelSeq[Math.min(call, modelSeq.length - 1)];
      call++;
      return r;
    },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages(_k, _t, rows) { appended.push(...rows); },
    async getWorkspaceRevision() { return "r1"; },
    async runReadTool(_k, name) { return readResult ? readResult(name) : { bookings: [] }; },
    async resolveBookingCreateArgs(_k, args) { return { ok: true, args: { ...args, chalet_id: args.chalet_id || "c1", period_id: args.period_id || "p1" } }; },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    async prepareSensitive(_k, spec) { const id = "act-" + (actions.size + 1); actions.set(id, spec); return { action_id: id }; },
    async getConfirmationContext() { return null; },
    async consumeConfirmation() { return { ok: false, error: "X" }; },
    async executeConfirmed() { return { ok: true, safe_result: {} }; },
    async finalizeAction() {},
  };
}

const chat = (deps, message) => handleAssistant(
  new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", message }) }),
  deps,
).then((r) => r.json());

describe("two-stage chat reply", () => {
  it("lists real chalets without calling the model, so a provider outage cannot block this safe read", async () => {
    const deps = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: (name) => name === "list_chalets" ? { chalets: [
        { chalet_id: "sky-real", chalet_name: "شاليه سكاي", periods: [{ period_id: "s1", period_label: "صباحي" }] },
        { chalet_id: "tulum-real", chalet_name: "شاليه تولوم", periods: [{ period_id: "t1", period_label: "مسائي" }] },
      ] } : {},
    });
    const b = await chat(deps, "ما هي الشاليهات المسجلة لديك؟");
    expect(b.ok).toBe(true);
    expect(b.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(b.reply_ar).toContain("شاليه سكاي");
    expect(b.reply_ar).toContain("شاليه تولوم");
    expect(b.reply_ar).not.toContain("list_chalets");
  });

  it("lists today's real free periods without asking the owner for ids", async () => {
    const deps = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: (name) => name === "find_empty_dates" ? { empty: [
        { chalet_id: "tulum-real", chalet_name: "شاليه تولوم", period_id: "t1", period_label: "مسائي", date: "2026-07-11" },
      ] } : {},
    });
    const b = await chat(deps, "اعرض جميع الفترات الفاضية لليوم في كل الشاليهات");
    expect(b.model_calls).toBe(0);
    expect(b.reply_ar).toContain("شاليه تولوم");
    expect(b.reply_ar).toContain("مسائي");
    expect(b.reply_ar).not.toContain("chalet_id");
    expect(b.reply_ar).not.toContain("period_id");
  });

  it("returns ONLY the second-stage grounded answer (not the stage-1 planning text)", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "جاري جلب حجوزات اليوم...", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: true, reply: "لا توجد حجوزات اليوم.", toolCalls: [] },
      ],
      readResult: () => ({ date: "2026-07-11", bookings: [] }),
    });
    // «ما هي …» is deliberately the MODEL-path phrasing (the deploy smoke uses
    // it to prove a real two-stage round-trip).
    const b = await chat(deps, "ما هي حجوزات اليوم؟");
    expect(b.model_calls).toBe(2);
    expect(b.reply_ar).toBe("لا توجد حجوزات اليوم.");
    expect(b.reply_ar).not.toContain("جاري");
    expect(b.reply_ar).not.toContain("get_today_bookings");
  });

  it("«شنو حجوزات اليوم؟» answers deterministically even when the model is down", async () => {
    const deps = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ date: "2026-07-11", bookings: [{ booking_id: "b1" }] }),
    });
    const b = await chat(deps, "شنو حجوزات اليوم؟");
    expect(b.ok).toBe(true);
    expect(b.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(b.reply_ar).toContain("حجز");
    expect(b.reply_ar).not.toContain("get_today_bookings");
  });

  it("retries a transient stage-1 failure and succeeds without surfacing assistant_unavailable", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: false, error: "DEEPSEEK_TIMEOUT" },
        { ok: false, error: "DEEPSEEK_HTTP_503" },
        { ok: true, reply: "أهلاً! كيف أقدر أساعدك؟", toolCalls: [] },
      ],
    });
    const b = await chat(deps, "مرحبا");
    expect(b.ok).toBe(true);
    expect(b.assistant_unavailable).toBeUndefined();
    expect(deps._modelCalls).toHaveLength(3); // two transient failures + success
    expect(b.reply_ar).toBe("أهلاً! كيف أقدر أساعدك؟");
  });

  it("a configuration error is NOT retried and fails closed immediately", async () => {
    const deps = makeDeps({ modelSeq: [{ ok: false, error: "DEEPSEEK_KEY_MISSING" }] });
    const b = await chat(deps, "مرحبا");
    expect(b.assistant_unavailable).toBe(true);
    expect(deps._modelCalls).toHaveLength(1); // no retry on a missing key
  });

  it("a model-requested CONFIRM is blocked with actionable Arabic guidance, not a dead-end apology", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "سأسجل الحجز الآن", toolCalls: [{ name: "confirm_booking_create", arguments: { action_id: "a", confirmation_token: "t" } }] },
        { ok: false, error: "X" }, // grounding down too -> deterministic fallback must still guide
      ],
    });
    const b = await chat(deps, "شاليه سكاي — الفترات: ٧ مساءً إلى ٥ صباح سجل");
    expect(b.ok).toBe(true);
    // The block itself: nothing executed, and the reply tells the owner HOW to
    // proceed (prepare + confirmation card) instead of a generic apology.
    expect(b.tool_results[0]).toMatchObject({ ok: false, error: "CONFIRMATION_REQUIRES_OWNER" });
    expect(b.reply_ar).toContain("بطاقة تأكيد");
    expect(b.reply_ar).not.toContain("تعذّر إكمال الطلب حالياً");
    expect(b.reply_ar).not.toContain("CONFIRMATION_REQUIRES_OWNER");
    expect(b.reply_ar).not.toContain("confirm_booking_create");
  });

  it("retries a transient grounding (stage-2) failure once and returns the grounded reply", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "لحظة...", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: false, error: "DEEPSEEK_TIMEOUT" },
        { ok: true, reply: "لا توجد حجوزات اليوم.", toolCalls: [] },
      ],
      readResult: () => ({ bookings: [] }),
    });
    const b = await chat(deps, "حجوزات اليوم؟");
    expect(b.ok).toBe(true);
    expect(deps._modelCalls).toHaveLength(3); // stage1 + failed stage2 + retried stage2
    expect(b.reply_ar).toBe("لا توجد حجوزات اليوم.");
  });

  it("second-stage failure => deterministic Arabic fallback: no seed, no tool name, no error code", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "سأجلب لك المتبقيات الآن...", toolCalls: [{ name: "list_outstanding_balances", arguments: {} }] },
        { ok: false, error: "DEEPSEEK_TIMEOUT" },
      ],
      readResult: () => ({ source: "ledger", bookings: [{ booking_id: "b1" }, { booking_id: "b2" }] }),
    });
    const b = await chat(deps, "من عليه مبالغ متبقية؟");
    expect(b.ok).toBe(true);
    // Grounded on the real data (2 rows) ...
    expect(b.reply_ar.length).toBeGreaterThan(0);
    // ... but WITHOUT the stage-1 seed, the tool name, or the raw error code.
    expect(b.reply_ar).not.toContain("سأجلب");
    expect(b.reply_ar).not.toContain("list_outstanding_balances");
    expect(b.reply_ar).not.toContain("DEEPSEEK_TIMEOUT");
    expect(b.reply_ar).not.toMatch(/PGRST|42\d{3}|_[A-Z]{3,}/); // no error-code shapes
  });

  it("a failed read in fallback shows a safe message, never the tool name or code", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "لحظة...", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: false, error: "X" },
      ],
    });
    // Make the single read fail.
    deps.runReadTool = async () => { throw new Error("boom"); };
    // executeTool catches read errors? No — runReadTool throwing propagates; the
    // handler's tool loop calls executeTool which awaits runReadTool. Simulate a
    // returned error instead:
    deps.runReadTool = async () => ({ error: "PGRST202" });
    const b = await chat(deps, "حجوزات اليوم؟");
    expect(b.reply_ar).not.toContain("PGRST");
    expect(b.reply_ar).not.toContain("get_today_bookings");
  });

  it("confirmation tokens never reach model context or the stored transcript", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أجهّز الحجز...", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_id: "c1", booking_date: "2099-06-01", period_id: "p1" } }] },
        { ok: true, reply: "جهّزت الحجز، بانتظار تأكيدك.", toolCalls: [] },
      ],
    });
    const b = await chat(deps, "جهز حجز");
    const token = b.tool_results.find((r) => r.kind === "prepared_action")?.confirmation_token;
    expect(token).toBeTruthy(); // the frontend receives it...
    // ...but the SECOND model call's history must not contain it.
    const secondCall = deps._modelCalls[1];
    expect(JSON.stringify(secondCall.history)).not.toContain(token);
    // ...and it is never written to the stored transcript.
    expect(JSON.stringify(deps._appended)).not.toContain(token);
  });

  it("keeps a supplied customer phone out of model context but binds it server-side", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أجهّز الحجز...", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01" } }] },
        { ok: true, reply: "جهّزت الحجز، بانتظار تأكيدك.", toolCalls: [] },
      ],
    });
    const b = await chat(deps, "جهز حجز لعلي في تولوم مساء ورقمه 0501234567");
    const prep = b.tool_results.find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(JSON.stringify(deps._modelCalls)).not.toContain("0501234567");
    expect(JSON.stringify(deps._appended)).not.toContain("0501234567");
    expect(deps._actions.get(prep.action_id).args.customer_phone).toBe("0501234567");
  });
});
