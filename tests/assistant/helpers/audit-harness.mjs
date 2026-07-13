// Shared conversation-audit harness: drives the REAL deployed assistant
// pipeline (handler + planner + resolver + availability) with ZERO network,
// the model forced UNREACHABLE so every path exercised is the deterministic
// one the owner actually hits. Import { convo, RICH_DOC } and feed messages.
//
//   import { convo } from ".../audit-harness.mjs";
//   const c = convo();                 // fresh thread on a rich workspace
//   const r1 = await c.say("احجز تولوم بكرة");
//   console.log(r1.reply, r1.model_calls, r1.fields, r1.card, r1.next_actions);
//
// Each turn returns { reply, model_calls, ok, fields, private, card,
// next_actions, executed_count }. `fields`/`private` are the server draft.

import { handleAssistant } from "../../../supabase/functions/chalet-assistant/handler.mjs";
import { resolveBookingCreateArgs } from "../../../supabase/functions/_shared/assistant/booking-resolution.mjs";
import { riyadhToday, addDays } from "../../../supabase/functions/_shared/assistant/availability.mjs";

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WSA";
export const TODAY = riyadhToday(Date.now());
export const TOMORROW = addDays(TODAY, 1);
export { addDays };

// A realistic workspace: a chalet with a night slot + two SAME-TIME day
// periods (فترة 5 / الفترة 6) + a custom-label slot; a numbered-name chalet; a
// second chalet for cross-chalet alternatives; one pre-existing booking today.
export function richDoc({ conflictToday = false } = {}) {
  const doc = {
    schema_version: 3,
    settings: { facility_name: "منشأة تجريبية", holidays: [] },
    chalets: [
      {
        id: "tulum", name: "شاليه تولوم", capacity: 20, deleted_at: null,
        periods: [
          { id: "am", label: "صباحي", start: "07:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 450 },
          { id: "pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 500, weekend_price: 700 },
          { id: "f5", label: "فترة 5", start: "13:00", end: "17:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
          { id: "f6", label: "الفترة 6", start: "13:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 400 },
        ],
      },
      {
        id: "tulum2", name: "شاليه تولوم 2", capacity: 10, deleted_at: null,
        periods: [{ id: "t2pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 1, weekday_price: 350, weekend_price: 500 }],
      },
      {
        id: "sky", name: "شاليه سكاي", capacity: 8, deleted_at: null,
        periods: [
          { id: "s-am", label: "صباحي", start: "08:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 500 },
          { id: "s-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 350, weekend_price: 500 },
        ],
      },
    ],
    bookings: [],
  };
  if (conflictToday) {
    doc.bookings.push({
      id: "bk-existing", customer_name: "حجز قائم", customer_phone: "0500000000",
      chalet_id: "tulum", booking_date: TODAY, period_id: "pm", guests: 5, total: 500,
      paid: 0, status: "confirmed", notes: "", deleted_at: null,
    });
  }
  return doc;
}

function makeDeps(doc) {
  const modelCalls = [];
  const drafts = new Map();
  const actions = new Map();
  let seq = 0;
  const executed = [];
  return {
    env: ENV, _modelCalls: modelCalls, _drafts: drafts, _executed: executed, _doc: doc,
    async auth(k, p) { return k === WS && p === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "X" }; },
    async callModel(a) { modelCalls.push(a); return { ok: false, error: "DEEPSEEK_UNREACHABLE" }; },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "r1"; },
    async getWorkspaceData() { return { data: doc, updated_at: "r1" }; },
    async runReadTool() { return {}; },
    async resolveBookingCreateArgs(_k, a) { return resolveBookingCreateArgs(doc, a); },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    newId: () => "bk-" + (seq + 1),
    async getActiveDraft(_k, t) { const d = drafts.get(t); return d && d.status === "active" ? { id: t, fields: d.fields, linked_action_id: d.linked || null } : null; },
    async getDraftPrivate(_k, t) { const d = drafts.get(t); return d && d.status === "active" ? d.private : {}; },
    async upsertDraft(_k, t, f, p, l) { const pr = drafts.get(t) || { private: {}, status: "active" }; drafts.set(t, { fields: f, private: p || pr.private || {}, status: "active", linked: l !== undefined ? l : pr.linked }); return { draft_id: t }; },
    async closeDraft(_k, t, s) { const d = drafts.get(t); if (d) d.status = s; },
    async prepareSensitive(_k, s) { const id = "act-" + ++seq; actions.set(id, { id, workspace_key: _k, ...s, status: "prepared", confirmation_used_at: null }); return { action_id: id }; },
    async getConfirmationContext(_k, id) { const a = actions.get(id); if (!a || a.workspace_key !== _k) return null; return { action: a, tool_name: a.name, action_type: a.actionType, normalized_payload: { tool: a.name, args: a.args }, thread_id: a.threadId || null, status: a.status, confirmation_expires_at: new Date(a.expiresAtMs).toISOString() }; },
    async getLatestPreparedAction(_k) { const rows = [...actions.values()].filter((a) => a.status === "prepared" && !a.confirmation_used_at); const row = rows[rows.length - 1]; if (!row) return null; return { id: row.id, normalized_payload_json: { tool: row.name, args: row.args }, thread_id: row.threadId || null, confirmation_expires_at: new Date(row.expiresAtMs).toISOString(), status: row.status }; },
    async rotateConfirmation(_k, id, patch) { const a = actions.get(id); if (!a || a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "ROTATE_FAILED" }; a.tokenHash = patch.tokenHash; a.expiresAtMs = patch.expiresAtMs; return { ok: true }; },
    async consumeConfirmation(_k, id, tokenHash) { const a = actions.get(id); if (!a) return { ok: false, error: "ACTION_NOT_FOUND" }; if (a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" }; if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" }; a.status = "confirmed"; a.confirmation_used_at = "now"; return { ok: true }; },
    async executeConfirmed(_k, action) { executed.push(action); const args = action.payload.args; doc.bookings.push({ id: args.booking_id, customer_name: args.customer_name, chalet_id: args.chalet_id, booking_date: args.booking_date, period_id: args.period_id, guests: args.guests, total: args.total, paid: 0, status: "confirmed", deleted_at: null }); return { ok: true, result_reference: args.booking_id, safe_result: { booking_id: args.booking_id, action: "booking_created" } }; },
    async finalizeAction(_k, id, patch) { const a = actions.get(id); if (a) Object.assign(a, patch); },
  };
}

// A conversation object: `.say(msg)` threads automatically and returns a
// normalized view of the turn.
export function convo(docOpts = {}) {
  const doc = richDoc(docOpts);
  const deps = makeDeps(doc);
  let threadId = null;
  return {
    deps, doc,
    async say(message) {
      const body = { workspace_key: WS, access_pin: "123456", message, ...(threadId ? { thread_id: threadId } : {}) };
      const res = await handleAssistant(new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
      const j = await res.json();
      if (j.thread_id) threadId = j.thread_id;
      const d = deps._drafts.get("th-1");
      const prep = (j.tool_results || []).find((x) => x.kind === "prepared_action");
      return {
        reply: String(j.reply_ar || ""),
        ok: j.ok === true,
        model_calls: j.model_calls,
        fields: d ? d.fields : null,
        private: d ? d.private : null,
        card: prep && prep.card ? prep.card.rows : null,
        next_actions: j.next_actions || [],
        executed_count: deps._executed.length,
        raw: j,
      };
    },
    // convenience: pass an invoke_tool / draft_action body directly
    async post(body) {
      const res = await handleAssistant(new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", ...(threadId ? { thread_id: threadId } : {}), ...body }) }), deps);
      return res.json();
    },
    threadId: () => threadId,
  };
}

// Leak/quality scan of a reply string: returns an array of problem tags.
export function replyProblems(reply) {
  const s = String(reply || "");
  const bad = [];
  if (/\b(period_id|chalet_id|booking_id|action_id|prepare_booking|confirm_booking|list_bookings|get_today|tool_results|thread_id)\b/i.test(s)) bad.push("internal_identifier");
  if (/DEEPSEEK|UNREACHABLE|EDGE_CRASH|NOT_FOUND|AMBIGUOUS|UNPROVABLE|error_code|undefined|null|NaN|\[object/i.test(s)) bad.push("raw_code_or_placeholder");
  if (/\bth-1\b|act-\d|\bf5\b|\bf6\b|\bt-pm\b|\bt2pm\b/i.test(s)) bad.push("raw_id_token");
  if (/جاري|جارٍ الجلب|تم جلب البيانات/.test(s)) bad.push("stale_loading");
  return bad;
}
