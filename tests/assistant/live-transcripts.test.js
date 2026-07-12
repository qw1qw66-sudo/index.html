// LIVE TRANSCRIPT CORPUS — every conversation the owner reported broken
// (rounds 1-3 screenshots) replayed against the REAL handler with ZERO model
// calls asserted throughout. Any wording here regressing turns CI red before
// it can reach the owner again. Harness mirrors tests/assistant/draft-flow
// (keep the deps shape in sync when the handler contract grows).
import { describe, expect, it } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { resolveBookingCreateArgs } from "../../supabase/functions/_shared/assistant/booking-resolution.mjs";
import { riyadhToday, addDays, availabilityCheck, availabilityFailureAr } from "../../supabase/functions/_shared/assistant/availability.mjs";

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WST";
const TODAY = riyadhToday(Date.now());
const TOMORROW = addDays(TODAY, 1);

function fixtureDoc() {
  return {
    chalets: [
      {
        id: "tulum", name: "شاليه تولوم", capacity: 15, deleted_at: null,
        periods: [
          { id: "t-am", label: "صباحي", start: "07:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 450 },
          { id: "t-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 400, weekend_price: 600 },
        ],
      },
      {
        id: "sky", name: "شاليه سكاي", capacity: 6, deleted_at: null,
        periods: [{ id: "s-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 1, weekday_price: 350, weekend_price: 500 }],
      },
    ],
    bookings: [],
  };
}

function makeDeps({ doc = fixtureDoc() } = {}) {
  const modelCalls = [];
  const drafts = new Map();
  const actions = new Map();
  let actionSeq = 0;
  const executed = [];
  const deps = {
    env: ENV,
    _modelCalls: modelCalls,
    _drafts: drafts,
    _actions: actions,
    _executed: executed,
    _doc: doc,
    async auth(k, pin) {
      return k === WS && pin === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
    },
    async callModel(arg) {
      modelCalls.push(arg);
      return { ok: false, error: "DEEPSEEK_UNREACHABLE" }; // the corpus must never get here
    },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "rev-1"; },
    async getWorkspaceData() { return { data: doc, updated_at: "rev-1" }; },
    async runReadTool() { return {}; },
    async resolveBookingCreateArgs(_k, args) { return resolveBookingCreateArgs(doc, args); },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    newId: () => "bk-" + (actionSeq + 1),
    async getActiveDraft(_k, threadId) {
      const d = drafts.get(threadId);
      return d && d.status === "active" ? { id: threadId, fields: d.fields, linked_action_id: d.linked || null } : null;
    },
    async getDraftPrivate(_k, threadId) {
      const d = drafts.get(threadId);
      return d && d.status === "active" ? d.private : {};
    },
    async upsertDraft(_k, threadId, fields, privateFields, linked) {
      const prev = drafts.get(threadId) || { private: {}, status: "active" };
      drafts.set(threadId, {
        fields,
        private: privateFields || prev.private || {},
        status: "active",
        linked: linked !== undefined ? linked : prev.linked,
      });
      return { draft_id: threadId };
    },
    async closeDraft(_k, threadId, status) {
      const d = drafts.get(threadId);
      if (d) d.status = status;
    },
    async prepareSensitive(_k, spec) {
      const id = "act-" + ++actionSeq;
      actions.set(id, { id, workspace_key: _k, ...spec, status: "prepared", confirmation_used_at: null });
      return { action_id: id };
    },
    async getConfirmationContext(_k, id) {
      const a = actions.get(id);
      if (!a || a.workspace_key !== _k) return null;
      return {
        action: a, tool_name: a.name, action_type: a.actionType,
        normalized_payload: { tool: a.name, args: a.args },
        thread_id: a.threadId || null, status: a.status,
        confirmation_expires_at: new Date(a.expiresAtMs).toISOString(),
      };
    },
    async getLatestPreparedAction(_k) {
      const rows = [...actions.values()].filter((a) => a.status === "prepared" && !a.confirmation_used_at);
      const row = rows[rows.length - 1];
      if (!row) return null;
      return {
        id: row.id,
        normalized_payload_json: { tool: row.name, args: row.args },
        thread_id: row.threadId || null,
        confirmation_expires_at: new Date(row.expiresAtMs).toISOString(),
        status: row.status,
      };
    },
    async rotateConfirmation(_k, id, patch) {
      const a = actions.get(id);
      if (!a || a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "ROTATE_FAILED" };
      a.tokenHash = patch.tokenHash;
      a.expiresAtMs = patch.expiresAtMs;
      return { ok: true };
    },
    async consumeConfirmation(_k, id, tokenHash) {
      const a = actions.get(id);
      if (!a) return { ok: false, error: "ACTION_NOT_FOUND" };
      if (a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" };
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      a.status = "confirmed";
      a.confirmation_used_at = "now";
      return { ok: true };
    },
    // Executor faithful to the live one: fail closed on the availability twin
    // (so confirm-time conflicts reproduce), succeed otherwise.
    async executeConfirmed(_k, action) {
      executed.push(action);
      const args = action.payload.args;
      const chalet = doc.chalets.find((c) => c.id === args.chalet_id);
      const period = chalet ? (chalet.periods || []).find((p) => p.id === args.period_id) : null;
      const check = availabilityCheck(doc, args.chalet_id, args.booking_date, period);
      if (!check.available) {
        const fail = availabilityFailureAr(check);
        return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
      }
      doc.bookings.push({ id: args.booking_id, customer_name: args.customer_name, chalet_id: args.chalet_id, booking_date: args.booking_date, period_id: args.period_id, guests: args.guests, total: args.total, paid: 0, status: "confirmed", deleted_at: null });
      return { ok: true, result_reference: args.booking_id, safe_result: { booking_id: args.booking_id, action: "booking_created" } };
    },
    async finalizeAction(_k, id, patch) { const a = actions.get(id); if (a) Object.assign(a, patch); },
  };
  return deps;
}

const post = (deps, body) => handleAssistant(
  new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", ...body }) }),
  deps,
).then((r) => r.json());
const chat = (deps, message, threadId) => post(deps, { message, ...(threadId ? { thread_id: threadId } : {}) });

describe("live transcript corpus (owner-reported conversations, zero model calls)", () => {
  it("R1 (IMG_6690): «١٠»→«اعتمد»→card; the confirm-time conflict names the blocker and options; «١» recovers", async () => {
    const deps = makeDeps();
    const replies = [];
    const t1 = await chat(deps, "احجز تولوم بكرة بالليل");
    replies.push(t1.reply_ar);
    expect(t1.reply_ar).toContain("كم عدد الضيوف");
    const t2 = await chat(deps, "١٠", "th-1");
    replies.push(t2.reply_ar);
    expect(t2.reply_ar).toContain("سعر النظام");
    expect(deps._drafts.get("th-1").fields.guests).toBe(10);
    const t3 = await chat(deps, "اعتمد", "th-1");
    replies.push(t3.reply_ar);
    expect(t3.reply_ar).toContain("باسم من");
    const t4 = await chat(deps, "العميل علي تجربة", "th-1");
    replies.push(t4.reply_ar);
    const prep = (t4.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    // The slot is taken between prepare and حفظ (the live race).
    deps._doc.bookings.push({ id: "b-race", customer_name: "منافس تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("completed_action");
    // NEVER the generic head again: the blocker is named, options numbered.
    expect(r.reason_ar).toContain("منافس تجريبي");
    expect(r.reason_ar).toContain("أقرب الخيارات");
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeGreaterThan(0);
    const pick = await chat(deps, "١", "th-1");
    replies.push(pick.reply_ar);
    // The accepted SYSTEM price belonged to the old slot — picking a new slot
    // re-quotes honestly instead of silently keeping the wrong total.
    expect(pick.reply_ar).toContain("سعر النظام");
    const done = await chat(deps, "اعتمد", "th-1");
    replies.push(done.reply_ar);
    expect((done.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
    for (const rep of replies) expect(String(rep || "")).not.toContain("رقم الجوال");
  });

  it("R1b: a legacy conflicting pair blocks with the doc-integrity reason — no trap alternatives", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push({ id: "t-mid", label: "ظهيرة", start: "11:00", end: "13:00", active: true, sort: 9 });
    doc.bookings.push(
      { id: "old1", customer_name: "قديم أول", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-am", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "old2", customer_name: "قديم ثاني", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-mid", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز سكاي بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("تعارض قائم");
    expect(r.reply_ar).toContain("تبويب الحجوزات");
    expect(r.reply_ar).not.toContain("أقرب الخيارات"); // rebooking cannot fix it
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(false);
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R2 (IMG_6689): pasting the option line the bot itself printed selects that option", async () => {
    const doc = fixtureDoc();
    doc.bookings.push({ id: "b-x", customer_name: "سابق", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const optionLine = String(r.reply_ar).split("\n").find((l) => l.startsWith("1. "));
    expect(optionLine).toBeTruthy();
    // The owner pastes the option text back (without the «1. » prefix).
    const pasted = optionLine.slice(3);
    const pick = await chat(deps, pasted, "th-1");
    expect(pick.model_calls).toBe(0);
    expect(pick.reply_ar).not.toContain("الوقت غير واضح");
    expect(pick.reply_ar).not.toContain("لم أفهم");
    expect((pick.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R3: «من 7 الى 12» → «مساء» resolves; nonsense gets the guided fallback; phone is NEVER demanded", async () => {
    const deps = makeDeps();
    const replies = [];
    const t1 = await chat(deps, "احجز تولوم من 7 الى 12");
    replies.push(t1.reply_ar);
    expect(t1.reply_ar).toContain("صباحاً أم مساءً");
    const t2 = await chat(deps, "مساء", "th-1");
    replies.push(t2.reply_ar);
    expect(t2.reply_ar).not.toContain("كأمر مدعوم");
    expect(deps._drafts.get("th-1").fields.period_id).toBe("t-pm"); // real evening period bound
    const t3 = await chat(deps, "كلام غير مفهوم أبداً", "th-1");
    replies.push(t3.reply_ar);
    expect(t3.reply_ar).toContain("لم أفهم ردّك");
    expect(t3.reply_ar).toContain("الغِ الحجز");
    expect(deps._modelCalls).toHaveLength(0);
    for (const rep of replies) expect(String(rep || "")).not.toContain("رقم الجوال");
  });
});
