// G1 (very-smart assistant) — the MODEL path is now a bounded AGENTIC loop:
// the model may request read/prepare tools, read their redacted results, and
// request MORE tools on the next hop (read → reason → read again), up to
// MAX_MODEL_HOPS (4) / MAX_TOTAL_TOOLS (8). A no-progress guard (a hop repeating
// its previous request) ends the loop so a stuck model can't spin or double-arm
// a prepared action. Sensitive tools remain owner-only; results stay redacted.
import { describe, it, expect } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WSG";

// modelSeq is dequeued one response per model call; the LAST entry repeats when
// the sequence is exhausted (mirrors the production mocks). _reads counts every
// read-tool execution; _actions counts prepared sensitive actions.
function makeDeps({ modelSeq, readResult } = {}) {
  let call = 0;
  const modelCalls = [];
  const reads = [];
  const actions = new Map();
  return {
    env: ENV,
    _modelCalls: modelCalls,
    _reads: reads,
    _actions: actions,
    async auth(k, pin) { return k === WS && pin === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "X" }; },
    async callModel(arg) { modelCalls.push(arg); const r = modelSeq[Math.min(call, modelSeq.length - 1)]; call++; return r; },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "r1"; },
    async runReadTool(_k, name, args) { reads.push({ name, args }); return readResult ? readResult(name, args) : { bookings: [] }; },
    async resolveBookingCreateArgs(_k, args) { return { ok: true, args: { ...args, chalet_id: args.chalet_id || "c1", period_id: args.period_id || "p1" } }; },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    async getActiveDraft() { return null; },
    async getDraftPrivate() { return {}; },
    async upsertDraft() { return { draft_id: "th-1" }; },
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

// «ما هي …؟» deliberately routes to the MODEL path (not a deterministic read).
const MODEL_Q = "ما هي أفضل نصيحة لأعمالي هذا الشهر؟";

describe("G1 agentic loop — multi-step reasoning", () => {
  it("chains TWO different tools across hops, then gives an analytical final answer", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أتحقق من حجوزات اليوم", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: true, reply: "أتحقق من ملخص الشهر", toolCalls: [{ name: "get_bookings_summary", arguments: { from: "2026-07-01", to: "2026-07-31" } }] },
        { ok: true, reply: "عندك حجز اليوم و٥ هذا الشهر بإجمالي ٢٥٠٠ ريال — ركّز التسويق على نهايات الأسبوع القادمة.", toolCalls: [] },
      ],
      readResult: (name) => name === "get_today_bookings" ? { date: "2026-07-14", bookings: [{ id: "b1" }] } : { summary: true, count: 5, total_income: 2500, bookings: [] },
    });
    const b = await chat(deps, MODEL_Q);
    expect(b.ok).toBe(true);
    expect(b.model_calls).toBe(3); // read → read → answer
    expect(deps._reads.map((r) => r.name)).toEqual(["get_today_bookings", "get_bookings_summary"]);
    // The final analytical reply passes through (loosened — not flattened to a number).
    expect(b.reply_ar).toContain("ركّز التسويق");
    expect(b.reply_ar).not.toContain("get_today_bookings"); // no internal tool names
  });
});

describe("G1 agentic loop — no-progress guard", () => {
  it("a hop repeating its previous tool ends the loop; the tool runs ONCE", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "لحظة", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: true, reply: "عندك حجزان اليوم.", toolCalls: [{ name: "get_today_bookings", arguments: {} }] }, // same ask
      ],
      readResult: () => ({ date: "2026-07-14", bookings: [{ id: "b1" }, { id: "b2" }] }),
    });
    const b = await chat(deps, MODEL_Q);
    expect(b.model_calls).toBe(2);
    expect(deps._reads).toHaveLength(1); // NOT re-executed on the repeat hop
    expect(b.reply_ar).toBe("عندك حجزان اليوم."); // the repeat hop's reply is final
  });

  it("a repeated prepare_booking_create arms exactly ONE action (no double-arm)", async () => {
    const args = { customer_name: "علي", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 500 };
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أجهّز الحجز", toolCalls: [{ name: "prepare_booking_create", arguments: args }] },
        { ok: true, reply: "جهّزت الحجز، بانتظار تأكيدك.", toolCalls: [{ name: "prepare_booking_create", arguments: args }] },
      ],
    });
    // Reach the MODEL path (a full «جهّز حجز …» message would be handled by the
    // deterministic pipeline instead); the model then drives the prepare tool.
    const b = await chat(deps, MODEL_Q);
    expect(b.model_calls).toBe(2);
    expect(deps._actions.size).toBe(1); // armed once, not twice
  });

  it("two identical prepares in ONE hop arm exactly ONE action (within-hop dedup)", async () => {
    const args = { customer_name: "علي", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 500 };
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أجهّز", toolCalls: [{ name: "prepare_booking_create", arguments: args }, { name: "prepare_booking_create", arguments: args }] },
        { ok: true, reply: "جهّزت الحجز.", toolCalls: [] },
      ],
    });
    await chat(deps, MODEL_Q);
    expect(deps._actions.size).toBe(1); // the duplicate in the same batch is skipped
  });

  it("an identical prepare across NON-consecutive hops arms exactly ONE action", async () => {
    const args = { customer_name: "علي", chalet_name: "تولوم", period_label: "مسائي", booking_date: "2099-06-01", guests: 2, total: 500 };
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "أجهّز", toolCalls: [{ name: "prepare_booking_create", arguments: args }] }, // hop1: arm
        { ok: true, reply: "ألقي نظرة", toolCalls: [{ name: "list_bookings", arguments: { from: "2026-07-01", to: "2026-07-31" } }] }, // hop2: different
        { ok: true, reply: "أعيد التجهيز", toolCalls: [{ name: "prepare_booking_create", arguments: args }] }, // hop3: same as hop1 → skipped
        { ok: true, reply: "جهّزت الحجز.", toolCalls: [] },
      ],
    });
    const b = await chat(deps, MODEL_Q);
    expect(deps._actions.size).toBe(1); // re-arm across hops is deduped, not doubled
    expect(b.ok).toBe(true);
  });
});

describe("G1 agentic loop — bounds + safety", () => {
  it("caps at MAX_MODEL_HOPS and still forces a clean final answer", async () => {
    // Four DISTINCT tool asks (no-progress never triggers) → hop cap hit → one
    // forced-final model call. model_calls = 4 hops + 1 forced = 5.
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "1", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: true, reply: "2", toolCalls: [{ name: "list_bookings", arguments: { from: "2026-07-01", to: "2026-07-31" } }] },
        { ok: true, reply: "3", toolCalls: [{ name: "list_chalets", arguments: {} }] },
        { ok: true, reply: "4", toolCalls: [{ name: "find_empty_dates", arguments: { days_ahead: 7 } }] },
        { ok: true, reply: "هذه خلاصتك النهائية.", toolCalls: [] }, // the forced-final answer
      ],
    });
    const b = await chat(deps, MODEL_Q);
    expect(b.model_calls).toBe(5);
    expect(deps._reads.length).toBeLessThanOrEqual(8); // total-tool budget respected
    expect(b.reply_ar).toBe("هذه خلاصتك النهائية.");
  });

  it("a sensitive tool requested mid-loop is NEVER executed (owner-only)", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "", toolCalls: [{ name: "confirm_booking_create", arguments: { action_id: "x", confirmation_token: "y" } }] },
        { ok: true, reply: "لا يمكنني تنفيذ ذلك مباشرة.", toolCalls: [] },
      ],
    });
    const b = await chat(deps, MODEL_Q);
    const blocked = (b.tool_results || []).some((r) => r.error === "CONFIRMATION_REQUIRES_OWNER");
    expect(blocked).toBe(true);
    expect(deps._reads).toHaveLength(0); // nothing executed
  });

  it("a later-hop model outage falls back to a grounded answer (never a crash)", async () => {
    const deps = makeDeps({
      modelSeq: [
        { ok: true, reply: "لحظة", toolCalls: [{ name: "get_today_bookings", arguments: {} }] },
        { ok: false, error: "DEEPSEEK_UNREACHABLE" }, // hop 2 dies
      ],
      readResult: () => ({ date: "2026-07-14", bookings: [] }),
    });
    const b = await chat(deps, MODEL_Q);
    expect(b.ok).toBe(true); // grounded fallback, not a 5xx/crash
    expect(typeof b.reply_ar).toBe("string");
    expect(b.reply_ar.length).toBeGreaterThan(0);
  });

  it("a FIRST-call outage still fails closed with a clear Arabic message", async () => {
    const deps = makeDeps({ modelSeq: [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }] });
    const b = await chat(deps, MODEL_Q);
    expect(b.ok).toBe(false);
    expect(b.assistant_unavailable).toBe(true);
    expect(b.reply_ar).toContain("تعذّر");
  });
});
