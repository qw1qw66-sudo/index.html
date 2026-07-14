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
    async resolveBookingCreateArgs(_k, args) { return { ok: true, suggested_price: Number(args.total) || 500, args: { ...args, chalet_id: args.chalet_id || "c1", period_id: args.period_id || "p1" } }; },
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

  it("«من عليه مبالغ متبقية؟» answers with NAMES and amounts, zero model calls (live IMG_6711)", async () => {
    const deps = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({
        source: "ledger",
        bookings: [
          { booking_id: "b1", customer_name: "أبو فهد", booking_date: "2099-07-11", remaining_halalas: 50000 },
          { booking_id: "b2", customer_name: "أم سلمان", booking_date: "2099-07-12", remaining_halalas: 30000 },
        ],
      }),
    });
    const b = await chat(deps, "من عليه مبالغ متبقية؟");
    expect(b.ok).toBe(true);
    expect(b.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    // The owner asked WHO — the reply must name every debtor with the amount.
    expect(b.reply_ar).toContain("أبو فهد");
    expect(b.reply_ar).toContain("أم سلمان");
    expect(b.reply_ar).toContain("المتبقي 500 ريال");
    expect(b.reply_ar).toContain("إجمالي المتبقي: 800 ريال");
    // Never the useless bare count of the live incident.
    expect(b.reply_ar).not.toMatch(/يوجد \d+ حجوزات\.$/);
    expect(b.reply_ar).not.toContain("سأجلب");
    expect(b.reply_ar).not.toContain("list_outstanding_balances");
    expect(b.reply_ar).not.toMatch(/PGRST|42\d{3}|_[A-Z]{3,}/);
  });

  it("«كم دخل جابه التسويق؟» answers with the real number, never «تمام.» (live IMG_6710)", async () => {
    const deps = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ attributed_revenue_halalas: 90000, conversions: 2, messages_sent: 5 }),
    });
    const b = await chat(deps, "كم دخل جابه التسويق؟");
    expect(b.model_calls).toBe(0);
    expect(b.reply_ar).toContain("900 ريال");
    expect(b.reply_ar).toContain("2");
    expect(b.reply_ar).not.toBe("تمام.");

    const zero = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ attributed_revenue_halalas: 0, conversions: 0, messages_sent: 0 }),
    });
    const z = await chat(zero, "كم دخل جابه التسويق؟");
    expect(z.model_calls).toBe(0);
    expect(z.reply_ar).toContain("لا يوجد دخل منسوب");
  });

  it("campaign results and automation status answer deterministically and spelled out", async () => {
    const runs = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ runs: [{ id: "r1", status: "completed", eligible_contacts: 4, sent_messages: 3, converted_booking_id: "bk9", attributed_revenue_halalas: 45000 }] }),
    });
    const cr = await chat(runs, "اعرض نتيجة آخر حملة");
    expect(cr.model_calls).toBe(0);
    expect(cr.reply_ar).toContain("مكتملة");
    expect(cr.reply_ar).toContain("450 ريال");

    const rules = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ rules: [{ id: "x", enabled: true, maximum_daily_messages: 10, owner_approval_required: true }] }),
    });
    const st = await chat(rules, "اعرض حالة التسويق");
    expect(st.model_calls).toBe(0);
    expect(st.reply_ar).toContain("مفعلة");
    expect(st.reply_ar).toContain("موافقة المالك مطلوبة");

    const noRules = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ rules: [] }),
    });
    const nr = await chat(noRules, "اعرض حالة التسويق");
    expect(nr.reply_ar).toContain("التسويق التلقائي غير مفعّل");
  });

  it("upcoming bookings and this-week empty days answer deterministically with items", async () => {
    const upcoming = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ bookings: [
        { customer_name: "علي تجربة", booking_date: "2099-07-13", status: "confirmed" },
        { customer_name: "فهد تجربة", booking_date: "2099-07-14", status: "pending" },
      ] }),
    });
    const up = await chat(upcoming, "اعرض الحجوزات القادمة");
    expect(up.model_calls).toBe(0);
    expect(up.reply_ar).toContain("علي تجربة");
    expect(up.reply_ar).toContain("مؤكد");
    expect(up.reply_ar).not.toMatch(/^يوجد \d+ حجوزات\.$/);

    const week = makeDeps({
      modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }],
      readResult: () => ({ empty: [{ chalet_name: "شاليه تولوم", period_label: "مسائي", date: "2099-07-13" }] }),
    });
    const wk = await chat(week, "اعرض الأيام الفاضية هذا الأسبوع");
    expect(wk.model_calls).toBe(0);
    expect(wk.reply_ar).toContain("شاليه تولوم");
  });

  it("second-stage failure => deterministic Arabic fallback: no seed, no tool name, no error code", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "سأجلب لك الحجوزات الآن...", toolCalls: [{ name: "get_booking_details", arguments: { booking_id: "b1" } }] },
        { ok: false, error: "DEEPSEEK_TIMEOUT" },
      ],
      readResult: () => ({ booking: { id: "b1" } }),
    });
    const b = await chat(deps, "وش تفاصيل حجز العميل الأخير؟");
    expect(b.ok).toBe(true);
    expect(b.reply_ar.length).toBeGreaterThan(0);
    // ... WITHOUT the stage-1 seed, the tool name, or the raw error code.
    expect(b.reply_ar).not.toContain("سأجلب");
    expect(b.reply_ar).not.toContain("get_booking_details");
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
        { ok: true, reply: "أجهّز الحجز...", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_id: "c1", booking_date: "2099-06-01", period_id: "p1", guests: 2, total: 500 } }] },
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
        { ok: true, reply: "أجهّز الحجز...", toolCalls: [{ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 500 } }] },
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
