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
import { executeConfirmedAction } from "../../../supabase/functions/_shared/assistant/executors.mjs";
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
  const threads = new Map();
  let seq = 0;
  let rev = 1; // workspace revision — bumped by every successful save (revision-atomic)
  const executed = [];
  const memories = [];
  let memSeq = 0;
  const revId = () => "r" + rev;
  // execDeps drives the REAL executeConfirmedAction over the in-memory doc, so
  // the write path exercises production validation + field mapping (stores
  // customer_phone, honors paid + total_is_free) instead of a rubber stamp.
  const execDeps = {
    env: ENV,
    newId: () => "bk-exec-" + (++seq),
    async getWorkspaceDoc() { return { data: doc, updated_at: revId() }; },
    async saveWorkspaceV2(_k, _pin, dataObj, expectedRevision) {
      if (revId() !== expectedRevision) return { ok: false, error: "WORKSPACE_DATA_CONFLICT" };
      doc.bookings = dataObj.bookings; // persist the reconstructed document
      rev += 1;
      return { ok: true, updated_at: revId(), data: doc };
    },
    async recordManualPayment() { return { ok: true, transaction_id: "tx-1", duplicate: false }; },
    async createPaymentSession() { return { ok: false, error: "NO_PROVIDER_CONFIGURED" }; },
    async getBookingPayments() { return { ok: true, net_paid_halalas: 0 }; },
    async resolveCustomerPhone(_k, _pin, bookingId) { const b = (doc.bookings || []).find((x) => x.id === bookingId); return b ? String(b.customer_phone || "") : ""; },
    async sendOfficialWhatsApp() { return { ok: false, error: "OFFICIAL_WHATSAPP_NOT_WIRED" }; },
    async recordOutbound() {},
  };
  return {
    env: ENV, _modelCalls: modelCalls, _drafts: drafts, _executed: executed, _doc: doc, _memories: memories, _actions: actions, _threads: threads,
    async auth(k, p) { return k === WS && p === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "X" }; },
    async callModel(a) { modelCalls.push(a); return { ok: false, error: "DEEPSEEK_UNREACHABLE" }; },
    async activeMemories() { return memories.filter((m) => m.status === "active"); },
    async proposeMemory(_k, row) {
      const key = row && row.content_json && row.content_json.key;
      if (key) for (const m of memories) if (m.status === "active" && m.content_json && m.content_json.key === key) m.status = "superseded";
      const id = "mem-" + (++memSeq);
      memories.push({ id, memory_type: row.memory_type || "fact", status: row.status || "proposed", content_json: row.content_json || {}, enforcement_level: row.enforcement_level || "advisory", source_type: row.source_type || "model", source_reference: row.source_reference || null });
      return { ok: true, id };
    },
    async listMemories(_k, opts) { return memories.filter((m) => !opts || !opts.status || m.status === opts.status); },
    async promoteMemory(_k, id) { const m = memories.find((x) => x.id === id); if (!m) return { ok: false, error: "MEMORY_NOT_FOUND" }; if (m.status !== "proposed") return { ok: false, error: "MEMORY_NOT_PROPOSED" }; m.status = "active"; return { ok: true }; },
    // Mirror the real UPDATE ... in ('proposed','active'): a superseded/rejected
    // memory is NOT re-rejectable and reads back as MEMORY_NOT_FOUND.
    async rejectMemory(_k, id) { const m = memories.find((x) => x.id === id); if (!m || (m.status !== "proposed" && m.status !== "active")) return { ok: false, error: "MEMORY_NOT_FOUND" }; m.status = "rejected"; return { ok: true }; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return revId(); },
    async getWorkspaceData() { return { data: doc, updated_at: revId() }; },
    async runReadTool() { return {}; },
    async resolveBookingCreateArgs(_k, a) { return resolveBookingCreateArgs(doc, a); },
    async createThread(_k, title) { const id = "th-1"; threads.set(id, { id, title: String(title || "").slice(0, 120), status: "active", updated_at: "t1" }); return { ok: true, thread_id: id }; },
    // Thread lifecycle (workspace-scoped): list newest-first, archive one row.
    async listThreads() { return [...threads.values()].map((t) => ({ id: t.id, title: t.title, status: t.status, updated_at: t.updated_at })); },
    async archiveThread(_k, id) { const t = threads.get(id); if (!t) return { ok: false, error: "THREAD_NOT_FOUND" }; t.status = "archived"; t.updated_at = "t2"; return { ok: true }; },
    async threadBelongsToWorkspace() { return true; },
    newId: () => "bk-" + (seq + 1),
    async getActiveDraft(_k, t) { const d = drafts.get(t); return d && d.status === "active" ? { id: t, fields: d.fields, linked_action_id: d.linked || null } : null; },
    async getDraftPrivate(_k, t) { const d = drafts.get(t); return d && d.status === "active" ? d.private : {}; },
    async upsertDraft(_k, t, f, p, l) { const pr = drafts.get(t) || { private: {}, status: "active" }; drafts.set(t, { fields: f, private: p || pr.private || {}, status: "active", linked: l !== undefined ? l : pr.linked }); return { draft_id: t }; },
    // active-only, mirroring the real .eq("status","active"): a completed/cancelled
    // draft cannot be re-closed into a different terminal status.
    async closeDraft(_k, t, s) { const d = drafts.get(t); if (d && d.status === "active") d.status = s; },
    async prepareSensitive(_k, s) { const id = "act-" + ++seq; actions.set(id, { id, workspace_key: _k, ...s, status: "prepared", confirmation_used_at: null }); return { action_id: id }; },
    async getConfirmationContext(_k, id) { const a = actions.get(id); if (!a || a.workspace_key !== _k) return null; return { action: a, tool_name: a.name, action_type: a.actionType, normalized_payload: { tool: a.name, args: a.args }, thread_id: a.threadId || null, status: a.status, confirmation_expires_at: new Date(a.expiresAtMs).toISOString() }; },
    async getLatestPreparedAction(_k) { const rows = [...actions.values()].filter((a) => a.status === "prepared" && !a.confirmation_used_at); const row = rows[rows.length - 1]; if (!row) return null; return { id: row.id, normalized_payload_json: { tool: row.name, args: row.args }, thread_id: row.threadId || null, confirmation_expires_at: new Date(row.expiresAtMs).toISOString(), status: row.status }; },
    async rotateConfirmation(_k, id, patch) { const a = actions.get(id); if (!a || a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "ROTATE_FAILED" }; a.tokenHash = patch.tokenHash; a.expiresAtMs = patch.expiresAtMs; return { ok: true }; },
    // 5-arg mirror of assistant_consume_confirmation: enforces the SAME ordered
    // gate as the SQL — not-found, not-pending, already-used, EXPIRED, token,
    // PAYLOAD_CHANGED, STALE_REVISION — so those guarantees are actually tested.
    async consumeConfirmation(_k, id, tokenHash, payloadHash, currentRevision) {
      const a = actions.get(id);
      if (!a || a.workspace_key !== _k) return { ok: false, error: "ACTION_NOT_FOUND" };
      if (a.status !== "prepared") return { ok: false, error: "ACTION_NOT_PENDING" };
      if (a.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" };
      if (a.expiresAtMs == null || a.expiresAtMs < Date.now()) { a.status = "expired"; return { ok: false, error: "CONFIRMATION_EXPIRED" }; }
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      if (a.payloadHash !== payloadHash) return { ok: false, error: "PAYLOAD_CHANGED" };
      if (a.expectedRevision != null && currentRevision != null && a.expectedRevision !== currentRevision) return { ok: false, error: "STALE_REVISION" };
      a.status = "confirmed"; a.confirmation_used_at = "now";
      return { ok: true, action_type: a.actionType, tool_name: a.name };
    },
    // Read a finalized action's stored outcome — powers idempotent replay (a
    // second confirm returns the stored result) and crash recovery (a "running"
    // action is re-dispatched). Was entirely absent before, leaving both dead.
    async getActionOutcome(_k, id) { const a = actions.get(id); if (!a || a.workspace_key !== _k) return {}; return { status: a.status, safe_result: a.safe_result_json, error_code: a.error_code }; },
    async executeConfirmed(_k, action) {
      const res = await executeConfirmedAction(
        { wsKey: _k, pin: "123456", toolName: action.tool_name, payload: action.payload, actionId: action.action_id },
        execDeps,
      );
      if (res && res.ok) executed.push(action);
      return res;
    },
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
