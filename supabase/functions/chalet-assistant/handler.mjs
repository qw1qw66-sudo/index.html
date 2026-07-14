// chalet-assistant — pure request handler (runtime-tested in Node/vitest).
// Enforces: registry-only tools, read vs sensitive classes, two-step
// confirmation, policy/memory hard-blocks, and "never claim success without a
// server result". index.ts is a thin Deno wrapper that injects DeepSeek + a
// Supabase service-role data layer.
//
// deps: {
//   env,
//   auth(wsKey, pin) -> { ok, workspace_key, error_code? },
//   callModel({ systemPrompt, history }) -> { ok, reply, toolCalls, usage, model } | { ok:false, error },
//   activeMemories(wsKey) -> [ { memory_type, enforcement_level, status, content_json } ],
//   runReadTool(wsKey, name, args) -> safeResultObject,
//   prepareSensitive(wsKey, { name, args, actionType, payloadHash, tokenHash, expiresAtMs, expectedRevision }) -> { action_id },
//   getConfirmationContext(wsKey, actionId) -> { action, tool_name, action_type, normalized_payload } | null,
//   consumeConfirmation(wsKey, actionId, tokenHash, payloadHash, currentRevision) -> { ok, error? },
//   executeConfirmed(wsKey, { tool_name, action_type, payload }) -> { ok, result_reference?, safe_result?, error? },
//   finalizeAction(wsKey, actionId, patch) -> void,
//   appendMessages(wsKey, threadId, rows) -> void,
//   getWorkspaceRevision(wsKey) -> string|null,
// }

import { CHALET_SYSTEM_PROMPT, STRICT_JSON_INSTRUCTION } from "../_shared/assistant/system-prompt.mjs";
import { evaluatePolicy } from "../_shared/assistant/policy.mjs";
import { renderMemoriesForPrompt, customerFactFromBooking, memoryDedupeKey, TYPE_LABEL_AR } from "../_shared/assistant/memory.mjs";
import { normalizeToolCall, TOOL_REGISTRY, buildToolCatalogText } from "../_shared/assistant/tools.mjs";
import { prepareConfirmation, reissueConfirmation, hashToken, hashPayload } from "../_shared/assistant/confirmation.mjs";
import { redactText, redactObject, hasUnredactedPhone } from "../_shared/assistant/redact.mjs";
import { riyadhToday, availabilityCheck, availabilityFailureAr } from "../_shared/assistant/availability.mjs";
import { isBareConfirmPhrase, formatDateDisplay, addDaysIso, classifyMeridiemWord, parseTimeExpression, foldDigits } from "../_shared/assistant/nl-normalize.mjs";
import { normalizePeriodLookup, resolveChaletReference } from "../_shared/assistant/booking-resolution.mjs";
import { applySafeError } from "../_shared/assistant/safe-errors.mjs";
import {
  extractFacts,
  mergeDraft,
  missingFields,
  suggestedPrice,
  nextQuestionAr,
  findAlternatives,
  buildCardData,
  maskPhone,
  knownCustomerPhone,
} from "../_shared/assistant/booking-planner.mjs";
import { monthRangeIso } from "../_shared/assistant/booking-reads.mjs";
import { prevMonthKey } from "../_shared/assistant/analytics.mjs";

// The model runs a bounded AGENTIC loop: on each hop it may request read/prepare
// tools, read their (redacted) results, then request MORE tools on the next hop —
// so it can read → reason → read again (multi-step). MAX_MODEL_HOPS bounds the
// model calls; MAX_TOTAL_TOOLS bounds total tool executions across the turn; and
// MAX_TOOLS_PER_TURN bounds a single hop. A no-progress guard (a hop repeating its
// previous tool request) ends the loop so a stuck model can't spin.
const MAX_TOOLS_PER_TURN = 5;
const MAX_MODEL_HOPS = 4;
const MAX_TOTAL_TOOLS = 8;
// Standing guidance for every hop. Multi-step tool use is explicit, and the final
// answer MAY analyze / compare / advise — a deliberate loosening of the old
// "restate the numbers only" flatten, so the assistant can be genuinely insightful.
// The hard safety rails stay: real tool data only (no invented facts), no internal
// tool names / error codes / JSON in the reply, and NEVER a fake "done/paid/booked"
// unless a tool returned a completed action.
const AGENTIC_GUIDANCE =
  "يمكنك استدعاء الأدوات على عدة خطوات: اطلب أداة، اقرأ نتيجتها، ثم اطلب أداة أخرى إن لزم، حتى تكتمل المعلومة. " +
  "حين تكفيك النتائج، أعطِ الإجابة النهائية بالعربية الطبيعية المختصرة — ويمكنك التحليل والمقارنة وتقديم نصيحة أو ملاحظة مفيدة إن دعمتها النتائج. " +
  "للأسئلة المالية والتحليلية (المصاريف، صافي الربح، ربحية كل شاليه، مقارنة الشهور، أكثر العملاء، نظرة عامة) استخدم أدوات القراءة التحليلية المتاحة ثم استدلّ على نتائجها. " +
  "اعتمد فقط على الأرقام والأسماء الواردة من الأدوات؛ لا تخترع بيانات غير موجودة. " +
  "لا تذكر أسماء الأدوات الداخلية ولا أكواد الأخطاء ولا JSON خارج ردّك، " +
  "ولا تدّعِ إتمام حفظ أو دفع أو إجراء ما لم تُعِده الأداة كإجراء مكتمل فعلاً.";
// Backstop when the hop cap is hit while the model still wants tools.
const FORCE_FINAL_INSTRUCTION =
  "توقّف عن طلب الأدوات وأعطِ الآن أفضل إجابة نهائية ممكنة بالعربية من النتائج المتوفرة، دون ادّعاء أي إجراء لم يكتمل.";

// EVERY failed body that leaves this handler carries a safe public_code +
// actionable Arabic reason (never a bare internal code) — enforced at the one
// choke point all responses flow through.
function json(status, body) {
  const out = body && body.ok === false ? applySafeError(body) : body;
  return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
}

// The model may EXTRACT booking wording (never IDs) as a structured object;
// the deterministic resolver/planner binds real workspace ids afterwards.
const BOOKING_FIELDS_INSTRUCTION =
  'إذا كان المستخدم يرتب حجزاً، أضف حقلاً اختيارياً "booking_fields" في ردك JSON يحتوي فقط ما ذكره حرفياً: ' +
  '{"customer_name"?, "chalet_text"? (اسم الشاليه كما قاله), "period_text"? (وصف الفترة/الوقت كما قاله), "notes"?}. ' +
  "لا تضع تاريخاً أو عدد ضيوف أو مبلغاً أبداً — هذه يفهمها النظام من كلام المستخدم مباشرة. " +
  "لا تخترع قيماً ناقصة، ولا تضع معرفات قواعد بيانات أبداً.";

// G3 — a FRESH booking request that DELEGATES the choice to the assistant
// («احجز أي شاليه فاضي بكرة»، «دبّر لي أرخص/أنسب شاليه»، «اختر لي») needs
// judgment the deterministic planner cannot give (it can only ask «أي شاليه؟»).
// The pipeline yields these to the model, which reads availability and proposes
// a full prepare_booking_create (owner still confirms). Requires booking INTENT
// AND a delegation cue; a concrete «احجز تولوم بكرة» has no cue → stays
// deterministic. Mid-draft turns (an active row) never yield.
// Only UNAMBIGUOUS delegation cues: imperatives that hand the choice to the
// assistant, and «أي شاليه» (any chalet). The superlative «أفضل/أنسب/أرخص شاليه»
// are intentionally EXCLUDED — «احجز أفضل شاليه تولوم» names a real, resolvable
// chalet, so those cues would wrongly steal a concrete booking to the model.
// (An imperative like «دبّر لي أرخص شاليه» still yields via «دبّر».)
const DELEGATE_BOOKING_RE =
  /(اقترح|اقترحي|دبّر|دبر|رتّب\s*لي|رتب\s*لي|اختر\s*لي|اختاري\s*لي|نصيحتك|شو\s*تنصح|وش\s*تنصح|أي\s*شاليه|اي\s*شاليه)/;

// Booking-lead guidance for the MODEL loop (delegated bookings only reach it).
// The model proposes; the deterministic layer validates every field; the owner
// confirms. Price stays the CARD price (from find_empty_dates), never invented;
// the customer phone is never invented (the server binds the real one).
const BOOKING_LEAD_INSTRUCTION =
  "إذا طلب صاحب المكان أن ترتّب أو تختار له حجزاً (مثل «احجز أي شاليه فاضي» أو «دبّر لي شاليه مناسب»): " +
  "اقرأ التوفّر عبر find_empty_dates، اختر فتحة مناسبة، ثم جهّز الحجز باستدعاء prepare_booking_create بالشاليه والتاريخ والفترة. " +
  "المبلغ يحدّده النظام تلقائياً من بطاقة أسعار الشاليه — لا تخترع سعراً ولا تحتاج أن تضعه؛ وإن لم يكن للفترة سعر محفوظ فسيطلب منك النظام سؤال صاحب المكان. " +
  "عدد الضيوف اختياري — إن لم يذكره صاحب المكان فلا تسأل عنه وأكمل التجهيز. لا تخترع رقم جوال أبداً. " +
  "أنت تُجهّز فقط ولا تنفّذ — التأكيد النهائي بزرّ صاحب المكان.";

// Transient model failures (timeout, unreachable, rate limit, 5xx, stochastic
// bad output) are retried a bounded number of times before the turn is
// declared assistant_unavailable — a single flaky call must not take the whole
// assistant down (the deploy smoke needed exactly this retry to pass).
// Configuration errors (missing key/model, 4xx auth) fail immediately.
const TRANSIENT_MODEL_ERRORS = new Set([
  "DEEPSEEK_TIMEOUT",
  "DEEPSEEK_UNREACHABLE",
  "DEEPSEEK_READ_FAILED",
  "DEEPSEEK_BAD_JSON",
  "MODEL_OUTPUT_INVALID",
]);
export function isTransientModelError(code) {
  const c = String(code || "");
  return TRANSIENT_MODEL_ERRORS.has(c) || /^DEEPSEEK_HTTP_(429|5\d\d)$/.test(c);
}
async function callModelWithRetry(deps, arg, attempts) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await deps.callModel(arg);
    if (last && (last.ok || !isTransientModelError(last.error))) return last;
    if (i < attempts) await new Promise((r) => setTimeout(r, i * 400));
  }
  return last;
}

// Every sensitive tool (confirm_* and the owner-triggered create_payment_link)
// is blocked from model execution — only the owner, via a direct invoke_tool
// request, can run them.
const SENSITIVE_TOOLS = new Set(
  Object.keys(TOOL_REGISTRY).filter((n) => TOOL_REGISTRY[n].class === "sensitive"),
);
// A "confirm tool" is one whose schema carries a confirmation_token (the
// prepare/confirm pair). Other sensitive tools (create_payment_link) are
// direct owner-triggered actions that still re-authenticate via the PIN.
function isConfirmTool(name) {
  return Boolean(TOOL_REGISTRY[name]?.schema?.confirmation_token);
}

export async function handleAssistant(req, deps) {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "INVALID_JSON" }); }

  const accessPin = String(body.access_pin ?? "");
  const auth = await deps.auth(String(body.workspace_key ?? ""), accessPin);
  if (!auth || !auth.ok) return json(401, { ok: false, error: auth?.error_code ?? "AUTH_FAILED" });
  const wsKey = String(auth.workspace_key);
  const threadId = body.thread_id ? String(body.thread_id) : null;

  const activeMemories = (await deps.activeMemories(wsKey)) || [];
  // ASSISTANT_CONFIRM_SECRET is MANDATORY for any acting (prepare/confirm)
  // path — there is NO fallback to another secret. Without it the confirmation
  // token would be forgeable, so acting fails CLOSED (reads still work). An
  // empty string here is treated as "absent" downstream (see executeTool).
  const secret = deps.env.ASSISTANT_CONFIRM_SECRET || "";
  // The PIN is used ONLY within this HTTPS request to re-authenticate the
  // underlying contract. It is never stored, logged, returned, or sent to the
  // model.
  const ctxBase = { wsKey, pin: accessPin, activeMemories, secret };

  // ---- Branch A: direct tool invocation (frontend confirm buttons / suggested commands) ----
  if (body.invoke_tool) {
    const norm = normalizeToolCall(body.invoke_tool);
    if (!norm.ok) return json(422, { ok: false, error: norm.error, detail: norm.detail });
    return await executeTool(deps, { ...ctxBase, norm });
  }

  // ---- Branch A2: thread lifecycle (create / list / archive) — workspace-scoped ----
  if (body.thread_action) {
    const action = String(body.thread_action);
    if (action === "create") {
      const t = await deps.createThread?.(wsKey, String(body.title ?? ""));
      if (!t || !t.ok) return json(500, { ok: false, error: t?.error || "THREAD_CREATE_FAILED" });
      return json(200, { ok: true, thread_id: t.thread_id });
    }
    if (action === "list") {
      return json(200, { ok: true, threads: (await deps.listThreads?.(wsKey)) || [] });
    }
    if (action === "archive") {
      const r = await deps.archiveThread?.(wsKey, String(body.thread_id ?? ""));
      if (!r || !r.ok) return json(r?.error === "THREAD_NOT_FOUND" ? 404 : 500, { ok: false, error: r?.error || "THREAD_ARCHIVE_FAILED" });
      return json(200, { ok: true });
    }
    return json(422, { ok: false, error: "UNKNOWN_THREAD_ACTION" });
  }

  // ---- Branch A3: booking-draft lifecycle (تعديل / إلغاء on the card) ----
  if (body.draft_action) {
    const kind = String(body.draft_action);
    const actionId = body.action_id ? String(body.action_id) : "";
    const draftThread = threadId;
    if (kind === "cancel") {
      // Close the draft and reject its prepared action (if any): nothing was
      // ever saved, and the old confirmation token dies with the action row.
      if (draftThread) await deps.closeDraft?.(wsKey, draftThread, "cancelled");
      if (actionId) {
        const ctx = await deps.getConfirmationContext?.(wsKey, actionId);
        if (ctx && ctx.status === "prepared") {
          await deps.finalizeAction?.(wsKey, actionId, { status: "rejected", error_code: "CANCELLED_BY_OWNER" });
        }
      }
      return json(200, { ok: true, draft_cancelled: true, reply_ar: "تم الإلغاء، لم يُحفظ شيء." });
    }
    if (kind === "reopen") {
      // «تعديل»: the prepared action is retired; the draft stays ACTIVE with
      // all its fields so the owner only states the change. We ALSO surface a
      // chip per editable field so the owner can edit BY SELECTION (اختيار) —
      // tapping a chip routes back through draft_action:"edit_field".
      if (actionId) {
        const ctx = await deps.getConfirmationContext?.(wsKey, actionId);
        if (ctx && ctx.status === "prepared") {
          await deps.finalizeAction?.(wsKey, actionId, { status: "rejected", error_code: "REOPENED_FOR_EDIT" });
        }
      }
      const reopenRow = draftThread ? await deps.getActiveDraft?.(wsKey, draftThread) : null;
      return json(200, {
        ok: true,
        reply_ar: "تمام — اختر الحقل الذي تريد تعديله، أو اكتب التغيير مباشرةً (مثلاً: «الضيوف ستة» أو «التاريخ بعد بكرة»).",
        edit_fields: editFieldChips(reopenRow && reopenRow.fields ? reopenRow.fields : {}),
      });
    }
    if (kind === "edit_field") {
      // Owner tapped a field chip: retire any still-prepared action (defensive
      // — «تعديل»/reopen usually already did), mark the chosen field as the
      // pending question, and ask ONLY for its new value. The next typed reply
      // rides the existing single-field parser for that pending_q kind, then
      // the completed draft re-prepares a fresh card.
      const field = String(body.field || "");
      const pendingKind = EDITABLE_FIELDS.has(field) ? PENDING_KIND_BY_MISSING[field] : "";
      if (!pendingKind) return json(422, { ok: false, error: "UNKNOWN_EDIT_FIELD" });
      const row = draftThread ? await deps.getActiveDraft?.(wsKey, draftThread) : null;
      if (!row || !row.fields) {
        return json(200, { ok: true, reply_ar: "لا يوجد حجز قيد التعديل الآن. اطلب «جهّز حجز جديد» للبدء." });
      }
      // Retire any still-prepared action for this draft BEFORE stamping the
      // pending field — both the one the client named AND the draft's OWN
      // linked action. «تعديل»/reopen already rejects the card, but retiring
      // the linked action here too makes edit_field self-sufficient: a client
      // that skips reopen can't leave a live card that a mid-edit «سجل» would
      // save (defense-in-depth, mirrors the re-prepare supersede below).
      for (const rid of new Set([actionId, row.linked_action_id ? String(row.linked_action_id) : ""].filter(Boolean))) {
        const ctx = await deps.getConfirmationContext?.(wsKey, rid);
        if (ctx && ctx.status === "prepared") {
          await deps.finalizeAction?.(wsKey, rid, { status: "rejected", error_code: "REOPENED_FOR_EDIT" });
        }
      }
      const question = nextQuestionAr(row.fields, [field]) || "اكتب القيمة الجديدة.";
      const nextFields = { ...row.fields, pending_q: { kind: pendingKind, q: String(question).slice(0, 220) } };
      // privateFields=null preserves the stored phone; linkedActionId omitted
      // preserves the draft's link — we only stamp the pending question here.
      await deps.upsertDraft?.(wsKey, draftThread, nextFields, null);
      return json(200, { ok: true, reply_ar: question, editing_field: field });
    }
    if (kind === "get") {
      const d = draftThread ? await deps.getActiveDraft?.(wsKey, draftThread) : null;
      return json(200, { ok: true, draft: d ? d.fields : null });
    }
    return json(422, { ok: false, error: "UNKNOWN_THREAD_ACTION" });
  }

  // ---- Branch A4: refresh recovery — the latest pending prepared action ----
  // Tokens NEVER touch client storage: the server rotates the credentials on
  // every recovery, so the previous token is dead the moment this returns.
  if (body.pending_action === "latest") {
    if (!secret) return json(503, { ok: false, error: "ASSISTANT_CONFIRM_SECRET_MISSING" });
    const pending = await rotateLatestPending(deps, ctxBase);
    return json(200, { ok: true, pending: pending || null });
  }

  // ---- Branch A5: owner memory management (list / promote / reject) ----
  // The owner sees what the assistant learned and approves/rejects each item.
  // The list is RE-REDACTED here (listMemories does not redact at read time) and
  // rows whose summary still contains a phone are dropped — the browser, like the
  // model, never receives a raw phone. Workspace-scoped via the resolved wsKey.
  if (body.memory_action) {
    const action = String(body.memory_action);
    if (action === "list") {
      const rows = (typeof deps.listMemories === "function" ? await deps.listMemories(wsKey) : []) || [];
      const memories = [];
      for (const m of rows) {
        const st = String(m.status || "");
        if (st !== "active" && st !== "proposed") continue; // only the manageable states
        const raw = m.content_json && m.content_json.summary_ar ? String(m.content_json.summary_ar) : "";
        const safe = redactText(raw).trim();
        if (!safe || hasUnredactedPhone(safe)) continue; // fail-closed: never surface a phone
        memories.push({
          id: String(m.id || ""),
          memory_type: String(m.memory_type || "fact"),
          type_label: TYPE_LABEL_AR[m.memory_type] || "معلومة",
          status: st,
          enforcement_level: String(m.enforcement_level || "advisory"),
          summary_ar: safe.slice(0, 300),
          created_at: m.created_at || null,
        });
      }
      return json(200, { ok: true, memories });
    }
    const memId = body.memory_id ? String(body.memory_id) : "";
    if (!memId) return json(422, { ok: false, error: "MEMORY_ID_REQUIRED" });
    if (action === "promote") {
      const r = typeof deps.promoteMemory === "function" ? await deps.promoteMemory(wsKey, memId) : { ok: false, error: "UNSUPPORTED" };
      return json(r && r.ok ? 200 : 422, r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "PROMOTE_FAILED" });
    }
    if (action === "reject") {
      const r = typeof deps.rejectMemory === "function" ? await deps.rejectMemory(wsKey, memId) : { ok: false, error: "UNSUPPORTED" };
      return json(r && r.ok ? 200 : 422, r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "REJECT_FAILED" });
    }
    return json(422, { ok: false, error: "UNKNOWN_MEMORY_ACTION" });
  }

  // ---- Branch B: chat turn (two-stage model loop) ----
  const rawMessage = String(body.message ?? "");
  const privateFacts = { customer_phone: extractBookingPhone(rawMessage) };
  const message = redactText(rawMessage).slice(0, 4000);
  if (!message) return json(400, { ok: false, error: "EMPTY_MESSAGE" });

  // Thread must belong to THIS workspace. If none is supplied, open one so the
  // conversation is persisted against a real, workspace-scoped thread row.
  let activeThreadId = threadId;
  if (activeThreadId && deps.threadBelongsToWorkspace) {
    const belongs = await deps.threadBelongsToWorkspace(wsKey, activeThreadId);
    if (!belongs) return json(404, { ok: false, error: "THREAD_NOT_FOUND" });
  } else if (!activeThreadId && deps.createThread) {
    const t = await deps.createThread(wsKey, message.slice(0, 60));
    if (t && t.ok) activeThreadId = t.thread_id;
  }

  const history = (await deps.loadHistory?.(wsKey, activeThreadId)) || [];
  history.push({ role: "user", content: message });

  // Basic read-only owner questions must keep working even if the model is
  // temporarily unavailable. These narrow intents execute only registered
  // read tools against the authenticated workspace; they can never write.
  const todayForIntents = riyadhToday(Date.now());
  const deterministicCall = deterministicReadIntent(message, todayForIntents);
  if (deterministicCall) {
    const norm = normalizeToolCall(deterministicCall);
    const result = norm.ok
      ? await executeTool(deps, { ...ctxBase, norm, raw: true })
      : { ok: false, error: "READ_FAILED", reason_ar: "تعذّر فهم طلب القراءة. لم يتغيّر شيء." };
    const replyAr = renderFallbackAr([result]);
    await deps.appendMessages?.(wsKey, activeThreadId, [
      { role: "user", safe_content: message },
      { role: "assistant", safe_content: redactText(replyAr), tool_name: null },
    ]);
    return json(200, { ok: true, reply_ar: replyAr, tool_results: [result], thread_id: activeThreadId, model_calls: 0, model: "deterministic-read" });
  }

  const today = riyadhToday(Date.now());

  // Typed confirmation words NEVER execute a sensitive action. They re-open
  // the latest pending card (with a rotated token) or, with a complete draft,
  // prepare the card — the final side effect always needs the button tap.
  if (isBareConfirmPhrase(message)) {
    const reminder = await bareConfirmReminder(deps, ctxBase, { threadId: activeThreadId, message, today });
    if (reminder) {
      await deps.appendMessages?.(wsKey, activeThreadId, [
        { role: "user", safe_content: message },
        { role: "assistant", safe_content: redactText(reminder.reply_ar), tool_name: null },
      ]);
      return json(200, { ...reminder, thread_id: activeThreadId, model_calls: 0, model: "booking-planner" });
    }
  }

  // Deterministic Booking Agent pipeline: draft in server storage, facts
  // parsed from the raw message (dates/times/counts/amounts), real ids bound
  // only by the resolver. The model is NOT needed for the happy path.
  const pipeline = await runBookingPipeline(deps, ctxBase, {
    threadId: activeThreadId,
    rawMessage,
    message,
    privateFacts,
    today,
  });
  if (pipeline) {
    await deps.appendMessages?.(wsKey, activeThreadId, [
      { role: "user", safe_content: message },
      { role: "assistant", safe_content: redactText(pipeline.reply_ar || ""), tool_name: null },
    ]);
    return json(200, { ...pipeline, thread_id: activeThreadId, model_calls: 0, model: "booking-planner" });
  }

  // The model sees the REAL tool catalog (read + prepare tools only — never a
  // confirmation) so it can only ever name a tool that exists.
  // Active, owner-promoted memory is injected as CONTEXT (phone-free, never
  // authority — the policy gate still enforces any hard-block separately). Only
  // reaches the MODEL path here; the deterministic pipeline above is untouched.
  const memoryBlock = renderMemoriesForPrompt(activeMemories);
  const systemPrompt = CHALET_SYSTEM_PROMPT + "\n\n" + buildToolCatalogText() + "\n\n" + STRICT_JSON_INSTRUCTION + "\n\n" + BOOKING_FIELDS_INSTRUCTION +
    (memoryBlock ? "\n\n" + memoryBlock : "");

  // Agentic loop: each hop the model may request read/prepare tools; we execute
  // them (sensitive tools NEVER — owner-only), feed the REDACTED results back,
  // and let the model request more on the next hop — read → reason → read again.
  // Bounds: MAX_MODEL_HOPS model calls, MAX_TOTAL_TOOLS tool runs, and a
  // no-progress guard (a hop repeating its last request) end the loop so a stuck
  // model can't spin. The final answer is the reply of the hop that stops asking.
  const loopSystem = systemPrompt + "\n\n" + AGENTIC_GUIDANCE + "\n\n" + BOOKING_LEAD_INSTRUCTION;
  const results = [];        // ALL tool results across hops (returned + fallback)
  let convo = history;       // running conversation, grown with each hop
  let replyAr = "";
  let usage;
  let modelName;
  let modelCalls = 0;
  let toolsUsed = 0;
  let prevSig = null;        // previous hop's requested-tool signature (no-progress)
  const executedSigs = new Set(); // per-TURN set of (name+args) calls already run
  let finalized = false;

  for (let hop = 1; hop <= MAX_MODEL_HOPS; hop++) {
    const resp = await callModelWithRetry(deps, { systemPrompt: loopSystem, history: convo }, hop === 1 ? 3 : 2);
    modelCalls++;
    if (!resp.ok) {
      if (hop === 1) {
        // Fail closed on the FIRST call: no action, clear Arabic error. If this
        // was a DELEGATED booking (yielded here from the pipeline) and the model
        // is down, guide the owner to the deterministic path instead of a
        // dead-end — «احجز <الشاليه> <التاريخ>» is handled with zero model calls.
        const bookingIntent = hasBookingIntent(message);
        return json(200, {
          ok: false,
          assistant_unavailable: true,
          error: resp.error,
          reply_ar: bookingIntent
            ? "تعذّر الوصول إلى المساعد الذكي حالياً، ولم يُنفَّذ شيء. لتجهيز الحجز الآن اذكر الشاليه والتاريخ مباشرة، مثل: «احجز شاليه سكاي بكرة الفترة المسائية»."
            : "تعذّر الوصول إلى المساعد الذكي حالياً. لم يتم تنفيذ أي إجراء.",
        });
      }
      // A later hop failed transiently — ground on whatever results we have.
      replyAr = results.length ? renderFallbackAr(results) : "تعذّر إكمال المعالجة الآن.";
      finalized = true;
      break;
    }
    usage = resp.usage;
    modelName = resp.model;

    // The model may have EXTRACTED booking wording (never ids) — merge it into
    // the server draft (best-effort) so the deterministic resolver can bind ids.
    await mergeModelBookingFields(deps, { wsKey, activeThreadId, bookingFields: resp.bookingFields });

    const wants = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
    const sig = toolSignature(wants);
    const noProgress = sig !== null && sig === prevSig; // model repeated its last ask
    const wantsNewTools = wants.length > 0 && !noProgress;
    if (!wantsNewTools) {
      // The model is done (no tools) or stuck (repeated its last ask): its reply —
      // generated AFTER seeing any prior results — is the final answer.
      replyAr = resp.reply || (results.length ? renderFallbackAr(results) : "");
      finalized = true;
      break;
    }
    if (hop >= MAX_MODEL_HOPS || toolsUsed >= MAX_TOTAL_TOOLS) {
      // The model still wants tools but we're capped — stop and FORCE a clean
      // final answer below rather than surfacing this hop's planning text.
      break; // finalized stays false → the forced-final pass runs
    }

    // Execute this hop's tools (read + prepare only; bounded), feed back, continue.
    prevSig = sig;
    const budget = Math.min(MAX_TOOLS_PER_TURN, MAX_TOTAL_TOOLS - toolsUsed);
    const hopResults = [];
    for (const call of wants.slice(0, budget)) {
      const norm = normalizeToolCall(withPrivateBookingFacts(call, privateFacts));
      if (!norm.ok) {
        // Every failure the owner can see MUST carry a safe Arabic reason.
        hopResults.push({
          requested: call?.name ?? null,
          ok: false,
          error: norm.error,
          reason_ar: "لم أفهم هذا الطلب كأمر مدعوم. جرّب صياغة أوضح، مثل: «جهّز حجز لشاليه سكاي غداً».",
        });
        continue; // unknown/invalid tool from the model is NEVER executed
      }
      if (SENSITIVE_TOOLS.has(norm.name)) {
        // The model can never run ANY sensitive action (a confirmation) — only
        // the owner via a direct invoke_tool.
        hopResults.push({
          tool: norm.name,
          ok: false,
          error: "CONFIRMATION_REQUIRES_OWNER",
          reason_ar: "التنفيذ الحسّاس لا يتم من المحادثة مباشرة: اطلب مني «جهّز الحجز» وسأعرض لك بطاقة تأكيد تضغطها بنفسك، ولن يُحفظ شيء قبلها.",
        });
        continue;
      }
      // Per-turn de-dup on the NORMALIZED (name+args) call: an identical tool
      // request is never executed twice in a turn — whether repeated within a
      // hop, across non-consecutive hops, or in a changed batch. This is what
      // actually prevents a repeated prepare_booking_create from arming a SECOND
      // confirmation card (the no-progress guard only ends the loop; it does not
      // dedup executions). A re-requested read is likewise skipped — its result
      // is already in the conversation from the first run.
      const callSig = toolSignature([{ name: norm.name, arguments: norm.args }]);
      if (callSig !== null && executedSigs.has(callSig)) continue;
      if (callSig !== null) executedSigs.add(callSig);
      // fromModel: a prepare requested BY THE MODEL has its booking total forced
      // to the card price (never a model-supplied number). The deterministic
      // pipeline and the owner's direct invoke_tool do NOT set this flag.
      hopResults.push(await executeTool(deps, { ...ctxBase, norm, raw: true, fromModel: true }));
    }
    toolsUsed += hopResults.length;
    results.push(...hopResults);
    convo = convo.concat([
      { role: "assistant", content: resp.reply || "" },
      { role: "tool", content: JSON.stringify(sanitizeResultsForModel(hopResults)).slice(0, 6000) },
    ]);
  }

  if (!finalized) {
    // Hop cap reached while the model still wanted tools — force a final answer
    // grounded on the accumulated results (no further tool execution).
    const last = await callModelWithRetry(deps, { systemPrompt: loopSystem + "\n\n" + FORCE_FINAL_INSTRUCTION, history: convo }, 2);
    modelCalls++;
    if (last && last.ok && last.reply) {
      replyAr = last.reply;
      usage = last.usage;
      modelName = last.model;
    } else {
      replyAr = results.length ? renderFallbackAr(results) : "تعذّر إكمال المعالجة الآن.";
    }
  }

  await deps.appendMessages?.(wsKey, activeThreadId, [
    { role: "user", safe_content: message },
    { role: "assistant", safe_content: redactText(replyAr), tool_name: null },
  ]);

  return json(200, {
    ok: true,
    reply_ar: replyAr,
    tool_results: results,
    thread_id: activeThreadId,
    usage,
    model: modelName,
    model_calls: modelCalls,
  });
}

// Stable signature of a tool request (name + args, order-independent); null for
// an empty request. Used two ways: (1) the no-progress guard — two CONSECUTIVE
// hops with the same signature mean the model isn't progressing, so the loop
// stops instead of spinning; (2) per-call de-dup (executedSigs) — an identical
// (name+args) call is executed at most once PER TURN, so a repeated prepare can
// never arm a second confirmation card.
function toolSignature(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const norm = calls
    .map((c) => ({ n: String(c?.name || ""), a: c?.arguments ?? {} }))
    .sort((x, y) => (x.n < y.n ? -1 : x.n > y.n ? 1 : 0));
  try { return JSON.stringify(norm); } catch { return null; }
}

// Merge booking WORDING the model extracted (customer_name/notes only, redacted;
// never ids/dates/guests/totals — the resolver binds those) into the server
// draft, best-effort. Factored out of the agentic loop so it can run each hop.
async function mergeModelBookingFields(deps, { wsKey, activeThreadId, bookingFields }) {
  if (!bookingFields || !activeThreadId || typeof deps.getActiveDraft !== "function" || typeof deps.upsertDraft !== "function") return;
  try {
    const bf = bookingFields;
    const row0 = await deps.getActiveDraft(wsKey, activeThreadId);
    // Model output goes in as modelFields ONLY: the planner's merge accepts
    // customer_name/notes at most (length-capped) — never guests, totals, dates
    // or times, which the model must not invent (§5, live bug A). Redact BEFORE
    // merge so a phone echoed into a name/note never enters the draft unmasked.
    const modelIncoming = {
      fields: {},
      modelFields: {
        ...(typeof bf.customer_name === "string" && bf.customer_name ? { customer_name: redactText(bf.customer_name) } : {}),
        ...(typeof bf.notes === "string" && bf.notes ? { notes: redactText(bf.notes) } : {}),
      },
      private: {},
    };
    let merged = mergeDraft(row0 ? row0.fields || {} : {}, modelIncoming);
    if (!merged.chalet_id && typeof bf.chalet_text === "string" && bf.chalet_text) merged.chalet_text = redactText(bf.chalet_text).slice(0, 120);
    if (!merged.period_id && typeof bf.period_text === "string" && bf.period_text) merged.period_text = merged.period_text || redactText(bf.period_text).slice(0, 120);
    if ((row0 && row0.fields) || Object.keys(modelIncoming.modelFields).length || merged.chalet_text || merged.period_text) {
      await deps.upsertDraft(wsKey, activeThreadId, merged, null);
    }
  } catch { /* extraction is best-effort; the chat turn continues */ }
}

// Strip anything the model must never see (confirmation tokens above all) from
// the tool results before they are fed back for the grounding call.
function sanitizeResultsForModel(results) {
  return results.map((r) => {
    const { confirmation_token, ...rest } = r || {};
    void confirmation_token; // never forwarded to the model
    return redactObject(rest);
  });
}

// Deterministic Arabic renderer — the safety net when the grounding model call
// is unavailable. It describes the ACTUAL returned data in natural Arabic and
// NEVER exposes an internal tool name, a raw error code, or the stage-1 seed,
// and NEVER claims an action completed unless the tool said so.
function renderFallbackAr(results) {
  const lines = [];
  let anyFailure = false;
  for (const r of results) {
    if (!r) continue;
    if (r.ok === false) { anyFailure = true; if (r.reason_ar) lines.push(String(r.reason_ar)); continue; } // no tool name, no error code
    if (r.kind === "prepared_action") { lines.push(r.summary_ar || "جهّزت الإجراء — بانتظار تأكيدك."); continue; }
    if (r.kind === "completed_action") { lines.push(r.done_ar || "تم تنفيذ الإجراء وتأكيده من الخادم."); continue; }
    if (r.kind === "read") { const d = describeReadAr(r.result); if (d) lines.push(d); continue; }
  }
  if (!lines.length) {
    if (anyFailure) return "تعذّر إكمال الطلب حالياً، ولم يتغيّر شيء. حاول مرة أخرى.";
    // A read that produced nothing displayable must say so — «تمام.» after a
    // question read as a useless filler (live IMG_6710) and is kept only for
    // action results.
    if (results.some((r) => r && r.kind === "read")) return "لا توجد بيانات مطابقة.";
    return "تمام.";
  }
  return lines.join("\n").slice(0, 2000);
}

// Display-only halalas → whole riyals (owner prices are whole riyals).
function riyalsAr(halalas) {
  return String(Math.round(Number(halalas || 0) / 100));
}

const BOOKING_STATUS_AR = { confirmed: "مؤكد", cancelled: "ملغي", completed: "مكتمل", pending: "معلق" };

// Natural Arabic description of a read result — no tool name, no raw error code.
function describeReadAr(result) {
  const r = result && typeof result === "object" ? result : {};
  // Outstanding balances (ledger view): the owner asked WHO owes — name every
  // debtor with the amount. A bare count here was the live «يوجد 10 حجوزات»
  // uselessness (IMG_6711). MUST precede the generic bookings branch.
  if (r.source === "ledger" && Array.isArray(r.bookings)) {
    if (!r.bookings.length) return "لا توجد مبالغ متبقية — كل الحجوزات مسددة.";
    const shown = r.bookings.slice(0, 10);
    const lines = shown.map(
      (b) =>
        `• ${b.customer_name || "بدون اسم"} — ${formatDateDisplay(b.booking_date || "") || b.booking_date || ""} — المتبقي ${riyalsAr(b.remaining_halalas)} ريال`,
    );
    const total = r.bookings.reduce((s, b) => s + Number(b.remaining_halalas || 0), 0);
    const more = r.bookings.length > shown.length ? `\n…و${r.bookings.length - shown.length} حجوزات أخرى.` : "";
    return `المبالغ المتبقية:\n${lines.join("\n")}${more}\nإجمالي المتبقي: ${riyalsAr(total)} ريال (${r.bookings.length} حجز).`;
  }
  // Marketing attributed revenue — a real number, never filler.
  if (typeof r.attributed_revenue_halalas === "number") {
    const conv = Number(r.conversions || 0);
    if (!conv) return "لا يوجد دخل منسوب للتسويق بعد — لا توجد تحويلات مسجلة.";
    return `دخل التسويق المنسوب: ${riyalsAr(r.attributed_revenue_halalas)} ريال من ${conv} حجز محوّل، عبر ${Number(r.messages_sent || 0)} رسالة مرسلة.`;
  }
  // Campaign runs — the latest few, spelled out.
  if (Array.isArray(r.runs)) {
    if (!r.runs.length) return "لا توجد حملات تسويق بعد.";
    const STATUS_AR = { started: "بدأت", queued: "في الانتظار", awaiting_approval: "بانتظار موافقتك", completed: "مكتملة", failed: "فشلت", sending: "قيد الإرسال" };
    const lines = r.runs.slice(0, 3).map(
      (x) =>
        `• حملة ${STATUS_AR[x.status] || x.status || "—"} — مؤهلون ${Number(x.eligible_contacts || 0)}، أُرسلت ${Number(x.sent_messages || 0)}، تحويلات ${x.converted_booking_id ? 1 : 0}، دخل ${riyalsAr(x.attributed_revenue_halalas)} ريال`,
    );
    return `آخر الحملات:\n${lines.join("\n")}`;
  }
  // Period summary (count + income over a date range): «كم حجز عندي هالأسبوع؟»،
  // «الحجوزات القادمة/السابقة»، «كم دخلي هالشهر؟». MUST precede the generic
  // bookings branch. Booking totals are WHOLE RIYALS (not halalas) → no /100.
  if (r.summary === true) {
    const n = Number(r.count || 0);
    if (!n) return "لا توجد حجوزات في هذه المدة.";
    const income = Math.round(Number(r.total_income) || 0);
    const shown = Array.isArray(r.bookings) ? r.bookings.slice(0, 10) : [];
    const lines = shown.map((b) => {
      const t = Math.round(Number(b.total) || 0);
      return `• ${b.customer_name || "بدون اسم"} — ${formatDateDisplay(b.booking_date || "") || b.booking_date || ""}${t > 0 ? ` — ${t} ريال` : ""}`;
    });
    const head = n === 1 ? "حجز واحد" : n === 2 ? "حجزان" : `${n} حجوزات`;
    const more = n > shown.length ? `\n…و${n - shown.length} حجوزات أخرى.` : "";
    return `عندك ${head}، إجمالي الدخل ${income} ريال.\n${lines.join("\n")}${more}`;
  }
  // ---- G2 analytics renders (whole riyals — booking/expense amounts, no /100) ----
  if (r.expense_summary === true) {
    if (!Number(r.count)) return "لا توجد مصاريف في هذه الفترة.";
    const cats = (Array.isArray(r.by_category) ? r.by_category : []).slice(0, 8)
      .map((c) => `• ${c.category}: ${Math.round(Number(c.amount) || 0)} ريال`);
    return `إجمالي المصاريف ${Math.round(Number(r.total) || 0)} ريال (${Number(r.count)} بند):\n${cats.join("\n")}`;
  }
  if (r.net === true) {
    const income = Math.round(Number(r.income) || 0);
    const exp = Math.round(Number(r.expenses) || 0);
    const net = Math.round(Number(r.net_profit) || 0);
    return `الدخل ${income} ريال، والمصاريف ${exp} ريال، فالصافي ${net} ريال.`;
  }
  if (r.profitability === true) {
    const rows = Array.isArray(r.chalets) ? r.chalets : [];
    if (!rows.length) return "لا توجد بيانات كافية لحساب ربحية الشاليهات بعد.";
    const lines = rows.slice(0, 10).map(
      (c) => `• ${c.chalet_name}: صافي ${Math.round(Number(c.net_profit) || 0)} ريال (دخل ${Math.round(Number(c.income) || 0)} − مصاريف ${Math.round(Number(c.expenses) || 0)})`,
    );
    const un = Math.round(Number(r.unattributed_expenses) || 0);
    const tail = un > 0 ? `\nمصاريف غير منسوبة لشاليه معيّن: ${un} ريال.` : "";
    return `الأربح: ${rows[0].chalet_name} (صافي ${Math.round(Number(rows[0].net_profit) || 0)} ريال).\n${lines.join("\n")}${tail}`;
  }
  if (r.comparison === true) {
    const fmt = (x) => `${x.month}: دخل ${Math.round(Number(x.income) || 0)}، مصاريف ${Math.round(Number(x.expenses) || 0)}، صافي ${Math.round(Number(x.net_profit) || 0)} ريال (${Number(x.count) || 0} حجز)`;
    const netD = Math.round(Number(r.delta && r.delta.net_profit) || 0);
    const dir = netD > 0 ? "أعلى" : netD < 0 ? "أقل" : "مساوٍ";
    return `${fmt(r.a)}\n${fmt(r.b)}\nالفرق في الصافي: ${Math.abs(netD)} ريال (${dir}).`;
  }
  if (r.top_customers === true) {
    const rows = Array.isArray(r.customers) ? r.customers : [];
    if (!rows.length) return "لا توجد حجوزات لعرض ترتيب العملاء.";
    const lines = rows.map((c, i) => `${i + 1}. ${c.customer_name} — ${Number(c.count) || 0} حجز، إجمالي ${Math.round(Number(c.total) || 0)} ريال`);
    return `أكثر العملاء حجزاً:\n${lines.join("\n")}`;
  }
  if (r.overview === true) {
    const parts = [
      `نظرة عامة (${r.month}):`,
      `• الشاليهات: ${Number(r.chalet_count) || 0}`,
      `• الحجوزات النشطة: ${Number(r.booking_count_total) || 0} (منها قادمة ${Number(r.upcoming_count) || 0})`,
      `• دخل الشهر: ${Math.round(Number(r.month_income) || 0)} ريال`,
      `• مصاريف الشهر: ${Math.round(Number(r.month_expenses) || 0)} ريال`,
      `• صافي الشهر: ${Math.round(Number(r.month_net) || 0)} ريال`,
      `• متبقٍّ على العملاء (إجمالي، كل الفترات): ${Math.round(Number(r.outstanding_total) || 0)} ريال`,
    ];
    if (r.top_chalet) parts.push(`• أربح شاليه: ${r.top_chalet.chalet_name} (صافي ${Math.round(Number(r.top_chalet.net_profit) || 0)} ريال)`);
    return parts.join("\n");
  }
  if (Array.isArray(r.chalets)) {
    if (!r.chalets.length) return "لا توجد شاليهات مسجلة في هذه المساحة.";
    const lines = r.chalets.map((c) => {
      const periods = Array.isArray(c.periods) ? c.periods.map((p) => p.period_label).filter(Boolean).join("، ") : "";
      return `• ${c.chalet_name || "شاليه بدون اسم"}${periods ? ` — الفترات: ${periods}` : " — لا توجد فترات مفعّلة"}`;
    });
    return "الشاليهات المسجلة فعلياً:\n" + lines.join("\n");
  }
  if (Array.isArray(r.bookings)) {
    // find_bookings lookup: name the matches (masked phones only).
    if (r.masked) {
      if (!r.bookings.length) return "لم أجد حجوزات مطابقة لبحثك.";
      const lines = r.bookings.map(
        (b) =>
          `• ${b.customer_name || "بدون اسم"} — ${formatDateDisplay(b.booking_date || "")}` +
          (b.phone_masked ? ` — ${b.phone_masked}` : "") +
          (b.status ? ` — ${b.status === "confirmed" ? "مؤكد" : b.status === "cancelled" ? "ملغي" : b.status === "completed" ? "مكتمل" : "معلق"}` : ""),
      );
      return "النتائج:\n" + lines.join("\n");
    }
    // Itemize with names — a bare count answers nothing the owner asked.
    const n = r.bookings.length;
    if (n === 0) return "لا توجد حجوزات مطابقة.";
    const shown = r.bookings.slice(0, 10);
    const lines = shown.map(
      (b) =>
        `• ${b.customer_name || "بدون اسم"} — ${formatDateDisplay(b.booking_date || "") || b.booking_date || ""}` +
        (b.status ? ` — ${BOOKING_STATUS_AR[b.status] || b.status}` : ""),
    );
    const more = n > shown.length ? `\n…و${n - shown.length} حجوزات أخرى.` : "";
    const head = n === 1 ? "يوجد حجز واحد:" : n === 2 ? "يوجد حجزان:" : `يوجد ${n} حجوزات:`;
    return `${head}\n${lines.join("\n")}${more}`;
  }
  if (Array.isArray(r.available)) return r.available.length ? `الفترات المتاحة: ${r.available.length}.` : "لا توجد فترات متاحة.";
  if (Array.isArray(r.empty)) {
    if (!r.empty.length) return "لا توجد فترات فاضية مطابقة.";
    const lines = r.empty.slice(0, 20).map((x) => `• ${x.chalet_name || "الشاليه"} — ${x.period_label || "الفترة"} — ${x.date || ""}`);
    return "الفترات الفاضية:\n" + lines.join("\n");
  }
  if (Array.isArray(r.transactions)) return `عدد الحركات المالية: ${r.transactions.length}.`;
  if (Array.isArray(r.payments)) {
    if (!r.payments.length) return "لا توجد مدفوعات مسجلة.";
    const lines = r.payments.slice(0, 10).map(
      (p) => `• ${riyalsAr(p.amount_halalas)} ريال — ${formatDateDisplay(String(p.created_at || "").slice(0, 10)) || String(p.created_at || "").slice(0, 10)}`,
    );
    return `آخر المدفوعات (${r.payments.length}):\n${lines.join("\n")}`;
  }
  if (Array.isArray(r.rules)) {
    if (!r.rules.length) return "التسويق التلقائي غير مفعّل — لا توجد قواعد.";
    const lines = r.rules.slice(0, 5).map(
      (x) =>
        `• قاعدة ${x.enabled ? "مفعلة" : "معطلة"} — حد يومي ${Number(x.maximum_daily_messages || 0)} رسالة، موافقة المالك ${x.owner_approval_required === false ? "غير مطلوبة" : "مطلوبة"}`,
    );
    return `قواعد التسويق (${r.rules.length}):\n${lines.join("\n")}`;
  }
  if (typeof r.draft === "string" && r.draft) return r.draft;
  if (r.error) return "تعذّر جلب هذه المعلومة حالياً.";
  return "";
}

// Execute one normalized tool call. Returns a plain result object (raw=true) or
// a Response (raw=false). Read tools run immediately; prepare tools create a
// confirmation; confirm tools consume + execute the underlying contract.
async function executeTool(deps, { wsKey, pin, norm, activeMemories, secret, raw, threadId, fromModel }) {
  const { name, args, spec } = norm;
  const wrap = (status, obj) => (raw ? { tool: name, ...obj } : json(status, { ok: obj.ok !== false, tool: name, ...obj }));

  // Policy / memory hard-block check for anything that acts.
  const actionType = spec.prepares || name;
  const policy = evaluatePolicy({ toolName: name, actionType, activeMemories });
  if (!policy.allowed) return wrap(403, { ok: false, error: policy.error, reason_ar: policy.reason_ar });

  // Any acting path (prepare a confirmation, or confirm one) REQUIRES the
  // mandatory confirm secret. Without it the token is forgeable, so fail closed
  // — no confirmation is minted and nothing is executed. Reads are unaffected.
  const isActing = Boolean(spec.prepares) || spec.class === "sensitive";
  if (isActing && !secret) {
    return wrap(503, { ok: false, error: "ASSISTANT_CONFIRM_SECRET_MISSING", reason_ar: "إعداد التأكيد غير مكتمل على الخادم؛ لا يمكن تنفيذ إجراءات حسّاسة. لم يتغيّر شيء." });
  }

  // A sensitive tool is ALWAYS a confirmation (prepare/confirm pair). There is
  // no direct-execute sensitive tool: reject any non-confirm sensitive request.
  if (spec.class === "sensitive" && !isConfirmTool(name)) {
    return wrap(422, {
      ok: false,
      error: "SENSITIVE_TOOL_REQUIRES_CONFIRMATION",
      reason_ar: "هذا الإجراء يحتاج بطاقة تأكيد: اطلب تجهيزه أولاً ثم أكّده بنفسك. لم يتغيّر شيء.",
    });
  }

  // READ tools (and draft_* / prepare_outbound draft) — no confirmation. The
  // PIN is forwarded so ledger-backed reads re-authenticate the RPC contract.
  if (spec.class === "read" && !spec.prepares) {
    try {
      const result = await deps.runReadTool(wsKey, name, args, pin);
      return wrap(200, { ok: true, kind: "read", result, warnings: policy.warnings });
    } catch {
      return wrap(503, { ok: false, error: "READ_FAILED", reason_ar: "تعذّر قراءة البيانات حالياً. لم يتغيّر شيء." });
    }
  }

  // PREPARE tools — create an action + confirmation token; NO side effect yet.
  if (spec.prepares) {
    // For a NEW booking, generate its id at PREPARE time and bind it into the
    // confirmed payload. On a crash-retry the executor re-uses this exact id, so
    // a confirmed create can never produce two bookings.
    let boundArgs = args;
    if (spec.prepares === "confirm_booking_create") {
      const resolved = typeof deps.resolveBookingCreateArgs === "function"
        ? await deps.resolveBookingCreateArgs(wsKey, boundArgs, pin)
        : (boundArgs.chalet_id && boundArgs.period_id ? { ok: true, args: boundArgs } : null);
      if (!resolved || resolved.ok !== true) {
        return wrap(422, {
          ok: false,
          error: resolved?.error || "BOOKING_REFERENCE_FAILED",
          reason_ar: resolved?.reason_ar || "تعذّر مطابقة الشاليه أو الفترة مع بياناتك. لم يتم تجهيز أي حجز.",
          options: resolved?.options || [],
        });
      }
      boundArgs = resolved.args;
      // G3 price enforcement: a MODEL-led booking prepare NEVER sets its own
      // price — the total is FORCED to the chalet's card price (weekday/weekend)
      // for the resolved period+date, so a hallucinated total can't reach the
      // confirmation card. If the period has no card price, refuse and make the
      // model ASK the owner (never invent). The deterministic pipeline (no
      // fromModel) keeps its own owner-accepted total untouched.
      if (fromModel) {
        const cardPrice = Number(resolved.suggested_price);
        if (cardPrice > 0) {
          boundArgs = { ...boundArgs, total: cardPrice, total_is_free: false, total_source: "card" };
        } else {
          return wrap(422, {
            ok: false,
            error: "PRICE_NOT_ON_CARD",
            reason_ar: "لا يوجد سعر محفوظ لهذه الفترة على بطاقة الشاليه، فلا أحدّد المبلغ من عندي. اسأل صاحب المكان عن سعر الحجز، أو اضبط سعر الفترة في تبويب الشاليهات.",
          });
        }
      }
    }
    if (spec.prepares === "confirm_booking_create" && !boundArgs.booking_id && typeof deps.newId === "function") {
      boundArgs = { ...boundArgs, booking_id: deps.newId() };
    }
    const normalizedPayload = { tool: spec.prepares, args: boundArgs };
    const expectedRevision = spec.usesContract === "save_shared_workspace_v2"
      ? await deps.getWorkspaceRevision(wsKey)
      : null;
    const conf = prepareConfirmation({ normalizedPayload, secret, nowMs: deps.nowMs });
    // Persist the SAME boundArgs that were hashed, so the confirm-time payload
    // hash recomputed from storage matches (id binding included).
    const { action_id } = await deps.prepareSensitive(wsKey, {
      name: spec.prepares,
      args: boundArgs,
      actionType: spec.prepares,
      payloadHash: conf.payloadHash,
      tokenHash: conf.tokenHash,
      expiresAtMs: conf.expiresAtMs,
      expectedRevision,
      threadId: threadId ?? null,
    });
    return wrap(200, {
      ok: true,
      kind: "prepared_action",
      action_id,
      confirm_tool: spec.prepares,
      // The owner receives the token to echo back on confirm; the model does not
      // (this response goes to the frontend confirm card, not into model context).
      confirmation_token: conf.token,
      summary_ar: buildSummaryAr(spec.prepares, boundArgs),
      card: bookingCardFromArgs(spec.prepares, boundArgs),
      warnings: policy.warnings,
    });
  }

  // CONFIRM tools — deterministic, owner-driven.
  if (spec.class === "sensitive") {
    const actionId = String(args.action_id);
    const token = String(args.confirmation_token);
    const ctx = await deps.getConfirmationContext(wsKey, actionId);
    if (!ctx) return wrap(404, { ok: false, error: "ACTION_NOT_FOUND" });

    const currentRevision = ctx.action_type && String(ctx.action_type).startsWith("confirm_booking")
      ? await deps.getWorkspaceRevision(wsKey)
      : null;
    const payloadHash = hashPayload(ctx.normalized_payload);
    const consumed = await deps.consumeConfirmation(wsKey, actionId, hashToken(token, secret), payloadHash, currentRevision);
    if (!consumed.ok) {
      // Idempotent confirm: a second confirm of an action that already ran
      // returns its STORED result and never re-executes. A prepared->? race
      // and every other failure returns the safe error code.
      if (consumed.error === "ACTION_NOT_PENDING" || consumed.error === "CONFIRMATION_ALREADY_USED") {
        const outcome = (await deps.getActionOutcome?.(wsKey, actionId)) || {};
        if (outcome.status === "succeeded") {
          return wrap(200, { ok: true, kind: "completed_action", result: outcome.safe_result ?? {}, done_ar: "تم تنفيذ الإجراء مسبقاً.", replayed: true });
        }
        if (outcome.status === "failed") {
          return wrap(422, { ok: false, kind: "completed_action", error: outcome.error_code || "PREVIOUSLY_FAILED", done_ar: "لم يكتمل الإجراء سابقاً. لم يتغيّر شيء." });
        }
        // A card whose action was retired by «تعديل» or «إلغاء» must explain
        // itself — not masquerade as "already handled". action_retired tells
        // the frontend the card is DEAD (remove it, don't re-arm حفظ).
        if (outcome.status === "rejected" || outcome.status === "expired") {
          return wrap(409, {
            ok: false,
            error: outcome.error_code || "ACTION_NOT_PENDING",
            action_retired: true,
            reason_ar: "أُعيد فتح هذا الطلب للتعديل أو أُلغي، فبطاقته القديمة لم تعد صالحة. أكمل المحادثة وستظهر بطاقة جديدة.",
          });
        }
        // Crash recovery: an action left "running" (a crash between confirm and
        // finalize) is completed by RE-DISPATCHING the stored payload. Every
        // underlying contract is idempotent (action-scoped idempotency key,
        // prepare-bound booking id, revision-atomic save), so a re-run causes at
        // most one effect and can never double-charge or double-book.
        if (outcome.status === "running") {
          const recovered = await runConfirmedExecution(deps, { wsKey, pin, actionId, ctx, raw, recovered: true });
          if (recovered) return recovered;
        }
      }
      // Friendly recovery: when the data moved (stale revision) or the token
      // aged out, revalidate against FRESH data and hand back a NEW card in
      // the same response. Never auto-executes — the owner confirms again.
      if (consumed.error === "STALE_REVISION" || consumed.error === "CONFIRMATION_EXPIRED") {
        const payload = ctx.normalized_payload || {};
        const freshPrep = await reprepareAction(deps, { wsKey, pin, activeMemories, secret, threadId: ctx.thread_id || null }, String(payload.tool || name), payload.args || {});
        await deps.finalizeAction?.(wsKey, actionId, {
          status: consumed.error === "CONFIRMATION_EXPIRED" ? "expired" : "rejected",
          error_code: consumed.error,
        });
        if (freshPrep && freshPrep.ok) {
          return wrap(409, { ok: false, error: consumed.error, fresh_action: freshPrep.prepared });
        }
        // Re-validation failed (e.g. the slot got taken meanwhile): surface
        // ITS precise safe reason instead of the stale/expired one. This is
        // the OTHER confirm-time conflict path (a competing save bumps the
        // revision first), so it gets the same alternatives + terminal
        // card signal as an executor conflict (live bug C).
        if (freshPrep && freshPrep.failure) {
          const fb = String(freshPrep.failure.error || "").split(":", 1)[0];
          const extra =
            (fb === "BOOKING_CONFLICT" || fb === "AVAILABILITY_UNPROVABLE") &&
            String(payload.tool || "") === "confirm_booking_create"
              ? await confirmConflictRecovery(deps, wsKey, ctx, { reason_ar: freshPrep.failure.reason_ar })
              : null;
          return wrap(409, { ...freshPrep.failure, ...(extra || {}), action_retired: true });
        }
      }
      return wrap(409, { ok: false, error: consumed.error });
    }

    await deps.finalizeAction(wsKey, actionId, { status: "running" });
    return await runConfirmedExecution(deps, { wsKey, pin, actionId, ctx, raw });
  }

  return wrap(422, { ok: false, error: "UNHANDLED_TOOL" });
}

// Dispatch a confirmed action through the executor and finalize its outcome.
// Shared by the normal confirm path and the crash-recovery path.
async function runConfirmedExecution(deps, { wsKey, pin, actionId, ctx, raw, recovered }) {
  const name = ctx.tool_name;
  const wrap = (status, obj) => (raw ? { tool: name, ...obj } : json(status, { ok: obj.ok !== false, tool: name, ...obj }));
  let exec;
  try {
    exec = await deps.executeConfirmed(wsKey, {
      tool_name: ctx.tool_name,
      action_type: ctx.action_type,
      payload: ctx.normalized_payload,
      action_id: actionId,
      pin,
    });
  } catch (e) {
    exec = { ok: false, error: "EXECUTION_ERROR" };
    void e;
  }
  await deps.finalizeAction(wsKey, actionId, {
    status: exec.ok ? "succeeded" : "failed",
    result_reference: exec.result_reference ?? null,
    safe_result_json: exec.safe_result ?? {},
    error_code: exec.ok ? null : exec.error ?? "UNKNOWN",
  });
  // The booking's draft is DONE the moment its create succeeds — otherwise the
  // stale complete draft (with the customer's data) keeps hijacking later
  // turns and re-prepares a conflict against the owner's own new booking.
  if (exec.ok && name === "confirm_booking_create" && ctx.thread_id) {
    try { await deps.closeDraft?.(wsKey, ctx.thread_id, "completed"); } catch { /* non-fatal */ }
  }
  // Learn from a confirmed booking: propose a PHONE-FREE customer preference
  // («العميل X — آخر حجز …») so the assistant remembers repeat customers. The
  // fact is keyed per-customer so a re-booking supersedes the old one rather
  // than piling duplicates. Non-fatal and guarded: memory never blocks a save,
  // and a deps without proposeMemory (older wiring) simply skips it. The phone
  // is NEVER stored here — it already lives on the booking row.
  if (exec.ok && name === "confirm_booking_create" && typeof deps.proposeMemory === "function") {
    try {
      const args = (ctx.normalized_payload && ctx.normalized_payload.args) || {};
      const fact = customerFactFromBooking({ ...args, booking_id: exec.result_reference || "" });
      if (fact) {
        // Pipeline-sourced fact from an owner-confirmed booking is safe to
        // activate directly (it is phone-free context, not authority).
        fact.status = "active";
        fact.content_json = { ...(fact.content_json || {}), key: memoryDedupeKey(fact) };
        await deps.proposeMemory(wsKey, fact);
      }
    } catch { /* memory is best-effort; never affects the booking result */ }
  }
  // A confirm-time availability failure (the slot got taken between prepare
  // and confirm, or a data-quality block) must NOT dead-end: attach the
  // precise reason + numbered alternatives, and remember them on the still-
  // active draft so «١» picks work on the very next turn (live bug C).
  const failBase = String(exec.ok ? "" : exec.error || "").split(":", 1)[0];
  const failExtra =
    !exec.ok && name === "confirm_booking_create" &&
    (failBase === "BOOKING_CONFLICT" || failBase === "AVAILABILITY_UNPROVABLE" || failBase === "PERIOD_TIME_INCOMPLETE")
      ? await confirmConflictRecovery(deps, wsKey, ctx, exec)
      : null;
  // Only report completion when the server contract actually succeeded.
  return wrap(exec.ok ? 200 : 422, {
    ok: exec.ok,
    kind: "completed_action",
    result: exec.ok ? exec.safe_result ?? {} : undefined,
    error: exec.ok ? undefined : exec.error,
    ...(recovered ? { recovered: true } : {}),
    // Executor-provided reason passes through; the recovery payload (reason +
    // numbered alternatives) supersedes it when built.
    ...(!exec.ok && !failExtra && typeof exec.reason_ar === "string" && exec.reason_ar ? { reason_ar: exec.reason_ar } : {}),
    ...(failExtra || {}),
    done_ar: exec.ok
      ? (recovered ? "تم إكمال إجراء كان متوقفاً، وتأكيده من الخادم." : "تم تنفيذ الإجراء وتأكيده من الخادم.")
      : "لم يكتمل الإجراء. لم يتغيّر شيء بدون تأكيد الخادم.",
  });
}

// Build the recovery payload for a failed confirm_booking_create: numbered
// REAL alternatives (reusing findAlternatives) + the stored-draft update that
// makes a subsequent numeric pick resolvable. Never throws — a failed
// recovery just leaves the plain safe error.
async function confirmConflictRecovery(deps, wsKey, ctx, exec) {
  try {
    const payload = ctx.normalized_payload || {};
    const args = payload.args || {};
    if (!args.chalet_id || !args.booking_date) return null;
    const snap = typeof deps.getWorkspaceData === "function" ? await deps.getWorkspaceData(wsKey) : null;
    const doc = snap && snap.data ? snap.data : null;
    if (!doc) return null;
    const chalet = (doc.chalets || []).find((c) => String(c.id) === String(args.chalet_id));
    const period =
      (chalet ? (chalet.periods || []).find((p) => String(p.id) === String(args.period_id)) : null) ||
      (args.period_start
        ? { label: args.period_label || "", start: args.period_start, end: args.period_end }
        : null);
    let alts = [];
    try {
      alts = findAlternatives(doc, args.chalet_id, args.booking_date, period, { max: 3, todayIso: riyadhToday(Date.now()) }) || [];
    } catch {
      alts = [];
    }
    if (ctx.thread_id && typeof deps.getActiveDraft === "function" && typeof deps.upsertDraft === "function") {
      try {
        const row = await deps.getActiveDraft(wsKey, ctx.thread_id);
        if (row) {
          await deps.upsertDraft(wsKey, ctx.thread_id, { ...(row.fields || {}), alternatives: alts }, null);
        }
      } catch { /* the reply still lists the options */ }
    }
    return {
      reason_ar: alternativesReplyAr(alts, typeof exec.reason_ar === "string" ? exec.reason_ar : ""),
      next_actions: alts.map((a, i) => ({
        pick: i + 1,
        chalet_name: a.chalet_name,
        date: a.date,
        start: a.start,
        end: a.end,
        price: a.price ?? null,
      })),
    };
  } catch {
    return null;
  }
}

function buildSummaryAr(confirmTool, args) {
  switch (confirmTool) {
    case "confirm_booking_create":
      // NO invented values: a missing guests renders as «—», never as 1.
      return `تجهيز حجز جديد: العميل «${args.customer_name || "—"}»، الشاليه «${args.chalet_name || args.chalet_id || "—"}»، الفترة «${args.period_label || args.period_id || "—"}»، التاريخ ${formatDateDisplay(args.booking_date || "") || "—"}، الضيوف ${args.guests ?? "—"}${args.total !== undefined ? `، الإجمالي ${args.total_is_free ? "مجاني" : Number(args.total).toFixed(2) + " ر.س"}` : ""}. اضغط تأكيد للحفظ.`;
    case "confirm_booking_update":
      return `تجهيز تعديل الحجز ${args.booking_id || "—"}. اضغط تأكيد للحفظ.`;
    case "confirm_booking_cancel":
      return `تجهيز إلغاء الحجز ${args.booking_id || "—"}. اضغط تأكيد للإلغاء.`;
    case "confirm_manual_payment":
      return `تجهيز دفعة يدوية ${(Number(args.amount_halalas) / 100).toFixed(2)} ر.س للحجز ${args.booking_id || "—"}. اضغط تأكيد للتسجيل.`;
    case "confirm_payment_link":
      return `تجهيز رابط دفع للحجز ${args.booking_id || "—"}${args.amount_halalas ? ` بمبلغ ${(Number(args.amount_halalas) / 100).toFixed(2)} ر.س` : ""}. اضغط تأكيد لإنشاء الرابط.`;
    case "confirm_outbound_message":
      return `تجهيز رسالة للعميل. اضغط تأكيد للإرسال/الجدولة.`;
    default:
      return "إجراء مُجهّز — اضغط تأكيد للمتابعة.";
  }
}

function deterministicReadIntent(message, todayIso) {
  const text = String(message || "");
  // Booking COMMANDS are never read intents — «ابي حجز تولوم» must reach the
  // booking pipeline, not a lookup. This guard runs before everything.
  if (hasBookingIntent(text)) return null;
  // «فاضي/متاح اليوم» — availability. Also fires when the AVAILABLE subject is a
  // «شاليه» («وش الشاليهات المتاحة اليوم؟»), which otherwise fell to the static
  // catalog below. Still requires an availability word AND «اليوم».
  const asksAvailability = /(فتر|موعد|شاليه|شالية|شاليهات)/.test(text) && /(فاضي|فاضية|فاضيه|متاح|متاحة|متاحه|فراغ)/.test(text) && /(اليوم|لليوم|هذا اليوم)/.test(text);
  if (asksAvailability) return { name: "find_empty_dates", arguments: { days_ahead: 1 } };
  // The static catalog covers «ما هي الشاليهات المسجلة». A TODAY availability
  // question already returned above (asksAvailability fires first on «...اليوم»),
  // so we must NOT also exclude متاح/فاضي here: a دون-يوم availability phrasing
  // like «وش الشاليهات المتاحة عندي؟» (no «اليوم») has no other deterministic
  // home — excluding it here dropped it to the model (regression). Let it list
  // the chalets deterministically, exactly as it did before this round.
  // A profitability/expenses question about a «شاليه» («وش الشاليه الأكثر دخل؟»)
  // is analytical, not a catalog list — exclude analytical words so it falls
  // through to the G2 profitability/expense intents below.
  const asksCatalog = /(شاليه|شاليهات)/.test(text) && /(ما\s*هي|وش|ايش|اعرض|اظهر|قائمة|المسجل|عندي|لديك)/.test(text) && !/(احجز|حجز|جهز|سج[ّل]+\s+حجز)/.test(text) && !/(أربح|اربح|أرباح|ارباح|ربح|صافي|مصاريف|المصاريف|تكاليف|أكثر\s*دخل|اكثر\s*دخل|أعلى\s*دخل|اعلى\s*دخل)/.test(text);
  if (asksCatalog) return { name: "list_chalets", arguments: {} };
  // «شنو/وش/ايش/اعرض حجوزات اليوم؟» answers from the workspace even when the
  // model provider is down. Deliberately narrow: «ما هي حجوزات اليوم؟» stays on
  // the model path (the deploy smoke uses it to prove a REAL two-stage
  // DeepSeek round-trip), and any wording that smells like a write is excluded.
  // Write words match at WORD STARTS only: the bare «الغ» substring lives
  // inside «مبالغ», which silently sent «من عليه مبالغ متبقية؟» to the model
  // (the live «يوجد 10 حجوزات.» uselessness rode that path).
  const WRITEISH_RE = /(?:^|\s)(?:احجز|جهز|سج[ّل]|أضف|اضف|الغ|ألغ|امسح|احذف|عدل|عدّل)/;
  const asksTodayBookings =
    /(شنو|وش|ايش|اعرض|اظهر)/.test(text) &&
    /(حجوزات|الحجوزات)/.test(text) &&
    /(اليوم|لليوم|هذا اليوم)/.test(text) &&
    !WRITEISH_RE.test(text);
  if (asksTodayBookings) return { name: "get_today_bookings", arguments: {} };
  // «كم/عدد حجز/حجوزات … اليوم؟» — a COUNT of today's bookings, answered from the
  // workspace so it never opens a create draft or needs the model (A-P0-4).
  // Genuine booking COMMANDS already returned above via the hasBookingIntent
  // guard; «ما هي حجوزات اليوم؟» (no كم/عدد) still rides the model smoke path.
  const asksCountToday =
    /(?:كم|عدد)/.test(text) && /(?:حجز|حجوزات|الحجوزات)/.test(text) &&
    /(?:اليوم|لليوم|هذا اليوم)/.test(text) && !WRITEISH_RE.test(text);
  if (asksCountToday) return { name: "get_today_bookings", arguments: {} };
  const writeish = WRITEISH_RE.test(text);
  if (writeish) return null;
  // Tomorrow's bookings / availability — same zero-model guarantee (§15).
  const tomorrowWord = /(بكرة|بكره|باكر|غدا|غداً)/.test(text);
  if (tomorrowWord && /(حجوزات|الحجوزات)/.test(text) && todayIso) {
    const t = addDaysIso(todayIso, 1);
    return { name: "list_bookings", arguments: { from: t, to: t } };
  }
  if (tomorrowWord && /(فاضي|فاضية|متاح|متاحة|فراغ)/.test(text)) {
    return { name: "find_empty_dates", arguments: { days_ahead: 2 } };
  }
  // Outstanding balances in common owner phrasings.
  if (/(المتبقي|متبقية|متبقيه|الباقي|باقي فلوس|مديون|مطلوب من|عليه مبالغ|المبالغ المتبقية)/.test(text)) {
    return { name: "list_outstanding_balances", arguments: {} };
  }
  // Recent payments.
  if (/(آخر|اخر|أحدث|احدث)/.test(text) && /(مدفوعات|دفعات|المدفوعات)/.test(text)) {
    return { name: "list_recent_payments", arguments: {} };
  }
  // ---- G2 analytical intents (expenses / net / profitability / compare /
  // top customers). These MUST precede the count+income summary block below,
  // whose loose «حجز|دخل» guard would otherwise capture analytical phrasings
  // like «صافي دخلي» or «قارن دخل الشهر بالماضي». Each answers deterministically
  // (model_calls=0) from the document. Range: this month, or last month when a
  // «الماضي/الفائت» word is present; the model handles arbitrary ranges/months.
  if (todayIso) {
    const pastMonth = /(الماضي|الماضيه|الماضية|الفائت|الفائتة|الفايت|المنصرم|اللي\s*فات|اللي\s*راح)/.test(text);
    const analyticsRange = () => {
      if (pastMonth) return monthRangeIso(`${prevMonthKey(todayIso.slice(0, 7))}-01`);
      return monthRangeIso(todayIso);
    };
    // Compare two months (this vs last by default). «قارن» + a month word.
    if (/(قارن|قارِن|مقارنة|قارنّ|الفرق\s*بين)/.test(text) && /(شهر|الشهر|شهور|الشهرين|بالماضي)/.test(text)) {
      return { name: "compare_months", arguments: {} };
    }
    // A message is a booking/customer LOOKUP or a MARKETING-revenue question —
    // both have their own intents further below. «حجوزات صافي» (a customer named
    // Safi) and «كم أرباح التسويق؟» must NOT be captured by the net matcher, whose
    // «صافي/ربح/أرباح» tokens are also ordinary names and the marketing keyword.
    const marketingCtx = /(تسويق|التسويق|حملة|حملات|جابه)/.test(text);
    const nameLookupShape =
      /(?:رقمه|جواله|رقم\s*جواله|الرقم)\s*(?:ينتهي|اخره|آخره)/.test(text) ||
      /(?:^|\s)(?:حجز|حجوزات)\s+(?:العميل\s+)?[\p{L}][\p{L}\s]{1,30}$/u.test(text);
    // Most-profitable chalet — «أي شاليه أربح؟». Needs a chalet word AND a profit
    // word; checked before the net matcher so «أربح» doesn't read as net. «الأفضل»
    // is intentionally NOT a trigger — «الشاليه الأفضل للعوائل» is a recommendation.
    if (/(شاليه|شاليهات|شالية)/.test(text) && /(أربح|اربح|ربح|أرباح|ارباح|أعلى\s*دخل|اعلى\s*دخل|أكثر\s*دخل|اكثر\s*دخل)/.test(text)) {
      return { name: "get_chalet_profitability", arguments: analyticsRange() };
    }
    // Net profit — «الصافي»، «صافي الربح»، «كم ربحت؟». Anchored to a net/profit
    // QUESTION shape (not a bare «صافي/ربحي» customer name), never on a name
    // lookup or a marketing question, and distinct from gross income («كم دخلي؟»
    // stays a bookings summary — it has no net/profit word).
    if (!marketingCtx && !nameLookupShape && (
      /الصافي/.test(text) ||
      /صافي\s*(?:ال)?(?:ربح|دخل|أرباح|ارباح)/.test(text) ||
      /(?:كم|وش|كام|ايش|اعرف|أعرف|احسب)\s*(?:هو\s*)?(?:صافي|ربح|أرباح|ارباح|ربحت|ربحنا|كسبت|كسبنا)/.test(text)
    )) {
      return { name: "get_net_profit", arguments: analyticsRange() };
    }
    // Expenses — «كم صرفت؟»، «مصاريفي»، «تكاليف هذا الشهر».
    if (/(صرفت|مصاريف|المصاريف|مصروف|مصاريفي|تكاليف|التكاليف|انفقت|أنفقت|صرفنا|صرفتها)/.test(text)) {
      return { name: "get_expense_summary", arguments: analyticsRange() };
    }
    // Top customers by bookings — «أكثر العملاء»، «أفضل الزبائن» (names only).
    if (/(أكثر|اكثر|أفضل|افضل)\s*(العملاء|عملاء|الزباين|الزبائن|زبائن)/.test(text) || /(العملاء|الزبائن)\s*(الأكثر|الاكثر|الدائمين)/.test(text)) {
      return { name: "get_top_customers", arguments: {} };
    }
  }
  // The app's OWN suggestion chips (and their natural variants) must never
  // depend on the model (live IMG_6710/6711: «تمام.» / bare counts).
  // ---- Count + income SUMMARIES (get_bookings_summary) ----
  // «الحجوزات السابقة»، «كم حجز عندي هالأسبوع؟»، «كم دخلي هالشهر؟». A SHOW/list
  // request («اعرض الحجوزات القادمة») carries no كم/عدد/دخل and falls through to
  // the upcoming LIST below. Marketing/vacancy have their own intents; excluded.
  if (
    todayIso && /(حجز|حجوزات|الحجوزات|دخل|دخلي|الدخل)/.test(text) &&
    !/(تسويق|التسويق|حملة|حملات)/.test(text) &&
    !/(فاضي|فاضية|فاضيه|متاح|متاحة|فراغ)/.test(text)
  ) {
    // Anchor «كم/عدد» to حجز/حجوزات (or a bare دخل income word) so a mid-draft
    // field answer that merely contains «عدد الضيوف» (guests count) is NEVER
    // read as a bookings summary — R9: «...شالية تولوم عدد الضيوف ٥» must bind
    // to the draft, not hijack to get_bookings_summary. BOOKING_READ_QUESTION_RE
    // still matches «كم حجز بكرة؟»/«كم حجوزاتي؟»; the دخل clause keeps «كم دخلي؟».
    const asksSummary = BOOKING_READ_QUESTION_RE.test(text) || /(دخل|دخلي|الدخل)/.test(text);
    // Past — everything before today (count + income). Any past question.
    if (/(السابقة|السابقه|سابقة|الماضية|الماضيه|الفائتة|الفايتة|المنتهية|القديمة|القديمه|اللي راحت|اللي فات)/.test(text)) {
      return { name: "get_bookings_summary", arguments: { from: "2000-01-01", to: addDaysIso(todayIso, -1) } };
    }
    // Single-day income/count — «كم دخلي اليوم؟» / «كم حجز بكرة؟». Must precede
    // the week/month/income fallbacks so the stated day is not widened to a month.
    if (asksSummary && /(اليوم|لليوم|هذا اليوم)/.test(text)) {
      return { name: "get_bookings_summary", arguments: { from: todayIso, to: todayIso } };
    }
    if (asksSummary && /(بكرة|بكره|باكر|غدا|غداً|الغد)/.test(text)) {
      const t = addDaysIso(todayIso, 1);
      return { name: "get_bookings_summary", arguments: { from: t, to: t } };
    }
    if (asksSummary && /(اسبوع|الاسبوع|الأسبوع|أسبوع)/.test(text)) {
      return { name: "get_bookings_summary", arguments: { from: todayIso, to: addDaysIso(todayIso, 6) } };
    }
    if (asksSummary && /(شهر|الشهر|هالشهر)/.test(text)) {
      const mr = monthRangeIso(todayIso);
      return { name: "get_bookings_summary", arguments: { from: mr.from, to: mr.to } };
    }
    if (asksSummary && /(القادمة|القادمه|قادمة|قادمه|الجاية|الجايه)/.test(text)) {
      return { name: "get_bookings_summary", arguments: { from: todayIso, to: addDaysIso(todayIso, 60) } };
    }
    // «كم دخلي؟» with no explicit period → this calendar month's income.
    if (asksSummary && /(دخل|دخلي|الدخل)/.test(text)) {
      const mr = monthRangeIso(todayIso);
      return { name: "get_bookings_summary", arguments: { from: mr.from, to: mr.to } };
    }
    // Bare count question with no explicit period («كم حجوزاتي؟») → the upcoming
    // set (the actionable default) — never fall through to the model for this.
    if (asksSummary && /(حجز|حجوزات|الحجوزات)/.test(text)) {
      return { name: "get_bookings_summary", arguments: { from: todayIso, to: addDaysIso(todayIso, 60) } };
    }
  }
  // Upcoming bookings (SHOW/list).
  if (/(القادمة|القادمه|قادمة|قادمه|الجاية|الجايه)/.test(text) && /(حجوزات|الحجوزات)/.test(text) && todayIso) {
    return { name: "list_bookings", arguments: { from: todayIso, to: addDaysIso(todayIso, 60) } };
  }
  // Empty days this week.
  if (/(فاضي|فاضية|فاضيه|متاح|متاحة|فراغ)/.test(text) && /(اسبوع|الاسبوع|الأسبوع)/.test(text)) {
    return { name: "find_empty_dates", arguments: { days_ahead: 7 } };
  }
  // Marketing: attributed revenue («كم دخل جابه التسويق؟») — must precede the
  // generic status match («دخل» questions are about money, not settings).
  if (/(دخل|ايراد|إيراد|عائد|ارباح|أرباح)/.test(text) && /(تسويق|التسويق|حملة|حملات|جابه)/.test(text)) {
    return { name: "get_attributed_revenue", arguments: {} };
  }
  // Marketing: last campaign result.
  if (/(حملة|حملات|الحملة|الحملات)/.test(text) && /(نتيجة|نتايج|نتائج|آخر|اخر)/.test(text)) {
    return { name: "get_campaign_results", arguments: {} };
  }
  // Marketing: automation status/rules.
  if (/(تسويق|التسويق)/.test(text) && /(حالة|وضع|قواعد|حاله)/.test(text)) {
    return { name: "get_automation_status", arguments: {} };
  }
  // Booking lookup by phone suffix: «رقمه ينتهي 1234».
  const suffix = text.match(/(?:رقمه|جواله|رقم جواله|الرقم)\s*(?:ينتهي|اخره|آخره)\s*(?:بـ|ب)?\s*(\d{3,6})/);
  if (suffix) return { name: "find_bookings", arguments: { phone_suffix: suffix[1] } };
  // Booking lookup by customer name: «حجز علي», «ابحث عن حجز محمد». The word
  // must stand alone («الحجز مجاني» is a free-price statement, not a lookup),
  // and generic words are never treated as a customer name.
  const byName = text.match(/(?:^|\s)(?:حجز|حجوزات)\s+(?:العميل\s+)?([\p{L}][\p{L}\s]{1,30})$/u);
  if (byName && !/(اليوم|بكرة|غدا|القادمة|الفاضية|مجاني|مجانا|جديد|صفر)/.test(byName[1])) {
    return { name: "find_bookings", arguments: { customer_name: byName[1].trim() } };
  }
  return null;
}

// Numeric shapes that must never FUSE into a phone: full dates, and a price
// glued right before/after the number. Mirrors extractSaudiMobile in the planner
// but ALSO strips price shapes — «بمبلغ ٤٥٠ ٠٥٠١٢٣٤٥٦٧» otherwise glued 450 onto
// the mobile and forged a wrong number, while the Arabic-digit form was dropped
// entirely (\d never matched ٠-٩). Digits are folded FIRST, then the match is
// anchored on digit boundaries so an adjacent price/date can neither seed nor
// truncate the number — the stored phone is the REAL one or nothing.
const PHONE_DATE_SHAPE_RE =
  /(?<!\d)(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}\/\d{1,2})(?!\d)/g;
const PHONE_PRICE_SHAPE_RE =
  /(?:و?ب?(?:ال)?(?:سعر|مبلغ)|و?(?:ال)?اجمالي)(?:\s+وقدره)?\s*[:=]?\s*\d+|(?<!\d)\d+(?:\.\d+)?\s*(?:ريالات|ريالا|ريال|ر\.س|sar|sr)/g;
function extractBookingPhone(raw) {
  const folded = foldDigits(String(raw || ""));
  const compact = folded
    .replace(PHONE_DATE_SHAPE_RE, " ")
    .replace(PHONE_PRICE_SHAPE_RE, " ")
    .replace(/[\s()-]/g, "");
  const match = compact.match(/(?<!\d)(?:\+?966|00966)?0?5\d{8}(?!\d)/);
  if (!match) return "";
  let digits = match[0].replace(/\D/g, "");
  if (digits.startsWith("00966")) digits = digits.slice(5);
  else if (digits.startsWith("966")) digits = digits.slice(3);
  if (digits.startsWith("5") && digits.length === 9) digits = "0" + digits;
  return /^05\d{8}$/.test(digits) ? digits : "";
}

function withPrivateBookingFacts(call, facts) {
  if (!call || call.name !== "prepare_booking_create") return call;
  const inputArgs = call.arguments ?? call.args ?? {};
  // A phone is private and was redacted before the model call. Never trust a
  // model-supplied replacement; bind only the value extracted server-side from
  // the owner's original HTTPS request.
  const { customer_phone: _modelPhone, ...safeArgs } = inputArgs;
  void _modelPhone;
  return {
    ...call,
    arguments: facts?.customer_phone ? { ...safeArgs, customer_phone: facts.customer_phone } : safeArgs,
  };
}

// ---------------------------------------------------------------------------
// Booking Agent pipeline — deterministic draft brain wiring (§ Booking Agent).
// The model may phrase questions, but IDs, dates, availability, prices and
// confirmation all come from this deterministic path.
// ---------------------------------------------------------------------------

// «سجل حجز …» (with content) is the owner's most natural opener — it must
// enter the deterministic pipeline. Bare «سجل الحجز» stays a confirm word:
// bareConfirmReminder runs BEFORE this test and only on bare phrases.
// Tested via hasBookingIntent() against a diacritic-folded copy, so harakat,
// tatweel and hamza-alef spellings all collapse onto these bare stems. Includes
// polite 2nd-person/dative verbs («تحجزلي»، «سجلي»، «جهزلي»، «ثبتلي») and a
// loosened «ابي/ابغى/بغيت … حجز» that tolerates a couple of inserted words
// («ابغى منك حجز») so the pair no longer has to be strictly adjacent.
// STRONG create stems — always a create («احجز»، «حجز جديد»، «سجل حجز» …).
const BOOKING_INTENT_STRONG_RE =
  /(احجز|احجزلي|تحجزلي|تحجز لي|سجلي|جهزلي|ثبتلي|جهز حجز|جهزلي حجز|حجز جديد|سوي حجز|اعمل حجز|رتب حجز|سجل حجز|سجل لي حجز|ثبت لي حجز|ثبت حجز|جهز لي حجز|رتب لي حجز)/;
// LOOSE stem — «ابي/ابغى/بغيت/ابغا … حجز» (up to two words may sit between). It
// is a create ONLY when the turn is not actually a READ or an EDIT question;
// otherwise «ابغى اعرف كم حجز عندي» and «بغيت اعدل حجز احمد» were hijacked into a
// brand-new create draft (A-P0-4).
const BOOKING_INTENT_LOOSE_RE = /(?:ابي|ابغى|بغيت|ابغا)\s+(?:\S+\s+){0,2}حجز/;
// A READ question ABOUT bookings — «كم/عدد … حجز/حجوزات» or a see/know verb
// paired with a count word. Anchored to «حجز/حجوزات» as the counted object so a
// create sentence's «عدد الضيوف» is never misread as a count-of-bookings query.
const BOOKING_READ_QUESTION_RE =
  /(?:كم|عدد)\s+(?:\S+\s+){0,2}(?:ال)?حجوزات|كم\s+(?:\S+\s+){0,1}(?:ال)?حجز(?![ء-ي])|(?:اعرف|اعلم|اشوف|اعطني|اعطيني|ورني|وريني)\s+(?:كم|عدد)/;
// An EDIT request for an EXISTING booking — «عدّل/غيّر/حدّث/تعديل … حجز».
const BOOKING_EDIT_INTENT_RE =
  /(?:^|\s)(?:اعدل|عدل|عدّل|تعديل|حدّث|حدث)(?:\s|$)|(?:غير|غيّر|تغيير)\s+(?:\S+\s+){0,2}(?:ال)?حجز/;

// Diacritics/tatweel + hamza-alef folding for INTENT and period-label matching.
// redactText only masks phones; a fully-voweled «اَحجُز» or a tatweel «مسـاء»
// must still read like its bare form (the resolver already folds these, so the
// handler's own regexes must match it — otherwise the two disagree).
function stripTashkeelTatweel(s) {
  return String(s || "").replace(/[ً-ْٰـ]/g, "");
}
// A READ or EDIT phrasing about bookings — used to keep the loose create stem
// from swallowing a lookup/change question, and by deterministicReadIntent.
function isBookingReadOrEditQuestion(folded) {
  return BOOKING_READ_QUESTION_RE.test(folded) || BOOKING_EDIT_INTENT_RE.test(folded);
}
function hasBookingIntent(message) {
  const folded = stripTashkeelTatweel(message).replace(/[أإآٱ]/g, "ا");
  if (BOOKING_INTENT_STRONG_RE.test(folded)) return true;
  if (!BOOKING_INTENT_LOOSE_RE.test(folded)) return false;
  // A loose «ابي/ابغى … حجز» that is really a READ/EDIT question is NOT a create.
  if (isBookingReadOrEditQuestion(folded)) return false;
  return true;
}

// Wording that clearly TRIES to state a date (tomorrow-family words, weekday
// names, «تاريخ», «يوم …»). Consulted ONLY when the deterministic parser
// extracted nothing from an active-draft turn: instead of falling through to
// the model (whose bogus tool call reads «لم أفهم هذا الطلب كأمر مدعوم» — live
// bug B), the pipeline asks ONE precise date question.
const DATEISH_RE =
  /(?:^|[^ء-ي])(?:بكر[ةهىا]|بكر|باكرا?|غدا?|تاريخ|يوم|الجمع[ةه]|السبت|الاحد|الأحد|الاثنين|الإثنين|الثلاثاء|الاربعاء|الأربعاء|الخميس)(?![ء-ي])/;
const DATE_CLARIFY_AR =
  "لم أفهم التاريخ. اكتب مثل: بكرة، بعد بكرة، الجمعة، أو 15-08-2026.";

// The structured card for a booking prepare — rendered verbatim by the
// frontend. No ids, no tokens; phone only masked.
function bookingCardFromArgs(confirmTool, args) {
  if (confirmTool !== "confirm_booking_create") return undefined;
  const draftLike = {
    customer_name: args.customer_name,
    chalet_name: args.chalet_name || args.chalet_id,
    booking_date: args.booking_date,
    period_label: args.period_label,
    canonical_start: args.period_start,
    canonical_end: args.period_end,
    // Guests is optional: a card built from args that never stated it (e.g. a
    // model-led prepare) still shows 1, matching the saved booking's default.
    guests: Number.isInteger(args.guests) && args.guests > 0 ? args.guests : 1,
    total: args.total,
    total_source: args.total_is_free ? "free" : "explicit",
    // Render «المدفوع» on the card when a deposit is present (buildCardData
    // shows the row only for paid > 0).
    paid: args.paid,
    notes: args.notes,
  };
  try {
    return buildCardData(draftLike, {
      masked_phone: args.customer_phone ? maskPhone(args.customer_phone) : "",
    });
  } catch {
    return undefined;
  }
}

// Map a confirm tool back to its prepare tool (the registry is the source of
// truth; nothing is hardcoded).
function prepareToolFor(confirmName) {
  return Object.keys(TOOL_REGISTRY).find((k) => TOOL_REGISTRY[k].prepares === confirmName) || null;
}

// Re-prepare a fresh action from a stored normalized payload (stale/expired
// recovery + expired pending recovery). Runs the FULL prepare path again:
// resolver re-check, fresh revision binding, fresh token.
async function reprepareAction(deps, ctx, confirmToolName, args) {
  const prepareName = prepareToolFor(confirmToolName);
  if (!prepareName) return { ok: false };
  const norm = normalizeToolCall({ name: prepareName, arguments: args });
  if (!norm.ok) return { ok: false };
  const r = await executeTool(deps, { ...ctx, norm, raw: true });
  if (r && r.ok && r.kind === "prepared_action") return { ok: true, prepared: r };
  return { ok: false, failure: r };
}

// Latest pending prepared action, with ROTATED credentials (old token dies).
// Expired rows are re-prepared from their stored payload instead.
async function rotateLatestPending(deps, ctx, opts = {}) {
  if (typeof deps.getLatestPreparedAction !== "function") return null;
  const row = await deps.getLatestPreparedAction(ctx.wsKey, opts.threadId || undefined);
  if (!row) return null;
  const payload = row.normalized_payload_json || {};
  const confirmTool = String(payload.tool || "");
  if (!prepareToolFor(confirmTool)) return null;
  const nowMs = Date.now();
  const expired = row.confirmation_expires_at && new Date(row.confirmation_expires_at).getTime() <= nowMs;
  if (expired) {
    await deps.finalizeAction?.(ctx.wsKey, row.id, { status: "expired", error_code: "CONFIRMATION_EXPIRED" });
    const fresh = await reprepareAction(deps, { ...ctx, threadId: row.thread_id || null }, confirmTool, payload.args || {});
    if (!fresh.ok) return null;
    return { ...fresh.prepared, thread_id: row.thread_id || null };
  }
  const re = reissueConfirmation({ secret: ctx.secret, nowMs });
  const rot = await deps.rotateConfirmation?.(ctx.wsKey, row.id, { tokenHash: re.tokenHash, expiresAtMs: re.expiresAtMs });
  if (!rot || !rot.ok) return null;
  return {
    kind: "prepared_action",
    ok: true,
    action_id: row.id,
    confirm_tool: confirmTool,
    confirmation_token: re.token,
    summary_ar: buildSummaryAr(confirmTool, payload.args || {}),
    card: bookingCardFromArgs(confirmTool, payload.args || {}),
    thread_id: row.thread_id || null,
  };
}

// Typed «سجل/أكد/نعم…»: re-display the pending card (rotated token) or, with
// a complete draft, prepare the card now. NEVER executes the side effect.
async function bareConfirmReminder(deps, ctx, { threadId, message, today }) {
  // Scoped to THIS conversation: «سجل» must never resurface another thread's
  // (or another feature's) pending action with a working token.
  const pending = await rotateLatestPending(deps, ctx, { threadId });
  if (pending) {
    const isBooking = pending.confirm_tool === "confirm_booking_create";
    return {
      ok: true,
      reply_ar: isBooking
        ? "الحجز جاهز. راجع البطاقة واضغط حفظ الحجز."
        : "الطلب جاهز. راجع البطاقة ثم اضغط زر التأكيد بنفسك.",
      tool_results: [pending],
    };
  }
  if (threadId && typeof deps.getActiveDraft === "function") {
    const row = await deps.getActiveDraft(ctx.wsKey, threadId);
    if (row) {
      // The REAL message flows through: «نعم/اعتمد/تمام» while a suggested
      // price is pending is an ACCEPTANCE the planner must see — an empty
      // message would re-ask the same question forever.
      const cont = await runBookingPipeline(deps, ctx, {
        threadId,
        rawMessage: message || "",
        message: message || "",
        privateFacts: {},
        today,
        forced: true,
      });
      if (cont) return cont;
    }
  }
  return { ok: true, reply_ar: "لا يوجد إجراء بانتظار التأكيد حالياً.", tool_results: [] };
}

// «١ / الأول …» picks one of the stored conflict alternatives — and so does
// PASTING the option's own line back («شاليه تولوم — 2026-07-12 — 07:00–12:00
// — 300 ريال»): owners answer with the text they can copy, not an index.
const ARABIC_DIGIT_MAP = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
function foldDigitsAndDashes(s) {
  return String(s || "")
    .replace(/[٠-٩]/g, (d) => ARABIC_DIGIT_MAP[d] || d)
    .replace(/[–—‒−]/g, "-");
}
function parseAlternativePick(message, fields) {
  const alts = fields && Array.isArray(fields.alternatives) ? fields.alternatives : [];
  if (!alts.length) return null;
  const t = String(message || "").trim();
  // «١/٢/٣»، «رقم ٢»، and the natural ordinal «الخيار الثاني» (with optional
  // «رقم»): «الخيار …» is what owners actually type, and it must bind the option.
  const m = t.match(
    /^[\s.)-]*(?:الخيار\s*)?(?:رقم\s*)?(١|1|الاول|الأول|الاولى|الأولى|٢|2|الثاني|الثانية|٣|3|الثالث|الثالثة)[\s.!؟)-]*$/,
  );
  let alt = null;
  if (m) {
    const idx = {
      "١": 0, 1: 0, الاول: 0, الأول: 0, الاولى: 0, الأولى: 0,
      "٢": 1, 2: 1, الثاني: 1, الثانية: 1,
      "٣": 2, 3: 2, الثالث: 2, الثالثة: 2,
    }[m[1]];
    alt = alts[idx] || null;
  } else if (t.length >= 8) {
    // Text match against the stored options: the option's OWN time pair, or
    // its date together with its chalet name. UNIQUE hit only — never guess.
    const fold = foldDigitsAndDashes(t);
    const hits = alts.filter((a) => {
      const times = a.start && a.end && fold.includes(String(a.start)) && fold.includes(String(a.end));
      const dateHit = a.date && (fold.includes(String(a.date)) || fold.includes(formatDateDisplay(String(a.date))));
      const nameHit = a.chalet_name && t.includes(String(a.chalet_name));
      return times || (dateHit && nameHit);
    });
    if (hits.length === 1) alt = hits[0];
  }
  if (!alt) {
    // Typing the option's NAME («فترة5», «الفترة 6») instead of its number
    // must also pick it — the bot itself asked «حدد بالاسم» (live IMG_6708).
    // UNIQUE normalized-label hit only.
    const wanted = normalizePeriodLookup(t);
    if (wanted) {
      const byLabel = alts.filter(
        (a) => a.period_label && normalizePeriodLookup(a.period_label) === wanted,
      );
      if (byLabel.length === 1) alt = byLabel[0];
    }
  }
  if (!alt) return null;
  return {
    chalet_id: String(alt.chalet_id || ""),
    chalet_name: String(alt.chalet_name || ""),
    booking_date: String(alt.date || ""),
    period_id: String(alt.period_id || ""),
    period_label: String(alt.period_label || ""),
    canonical_start: String(alt.start || ""),
    canonical_end: String(alt.end || ""),
    // The price PRINTED on the tapped option. Consumed (and removed) by the
    // pick branch: choosing an option that displays a price IS accepting that
    // price — unless the owner already stated an explicit total, which wins.
    pick_price: Number.isFinite(Number(alt.price)) && Number(alt.price) > 0 ? Number(alt.price) : null,
  };
}

// Spoken-number words (واحد..عشرة) used as a numbered PICK must not double as a
// guest count: «خمسه» picks فترة 5, but the owner never stated 5 guests.
const SPOKEN_NUM_PICK = new Set([
  "واحد", "واحدة", "واحده", "اثنين", "اثنان", "ثنين", "ثلاثة", "ثلاثه", "ثلاث",
  "اربعة", "اربعه", "اربع", "خمسة", "خمسه", "خمس", "ستة", "سته", "ست",
  "سبعة", "سبعه", "سبع", "ثمانية", "ثمانيه", "ثمان", "تسعة", "تسعه", "تسع",
  "عشرة", "عشره", "عشر",
]);
// A message that is JUST a pick token — a 1-3 digit numeral OR a lone spoken
// number — being used to select an option/period. Such a token must never leave
// a fabricated guests/total on the draft.
function isBarePickToken(rawMessage) {
  const folded = foldDigits(stripTashkeelTatweel(String(rawMessage || ""))).trim();
  if (/^\d{1,3}$/.test(folded)) return true;
  return SPOKEN_NUM_PICK.has(folded);
}

// The chalet hint fed to the resolver from a whole sentence. A digit run glued
// to a guest word («٢ ضيوف»/«ضيوف ٢») is a HEADCOUNT, not part of the chalet
// name — dropping it stops «شالية تولوم ٢ ضيوف» from fusing into the ambiguous
// «تولوم٢» and losing the chalet (the number is still read as guests elsewhere).
const HINT_PERSON_SRC = "(?:اشخاص|شخصا|شخص|انفار|نفر|ضيوف|ضيف|افراد|فرد|زوار|زائر)";
function chaletHintFromMessage(text) {
  return String(text || "")
    .replace(new RegExp(`[0-9٠-٩]+\\s*(${HINT_PERSON_SRC})`, "gu"), " $1 ")
    .replace(new RegExp(`(${HINT_PERSON_SRC})\\s*[0-9٠-٩]+`, "gu"), " $1 ");
}

// A «من … الى/لـ …» TIME clause is present: a prayer/meridiem word inside it is
// a CLOCK endpoint, not the period label. «من المغرب للفجر» must let the time
// drive resolution (evening slot) rather than extractPeriodText grabbing «الفجر»
// and canon-folding فجر→صباح onto the MORNING slot.
const TIME_RANGE_CLAUSE_RE = /(?:^|\s)من\s+\S+\s+(?:الى|إلى|حتى|لل?\S)/u;
const PRAYER_PERIOD_RE = /^(?:ال)?(?:فجر|مغرب|عشاء|عصر|ظهر|ضحى)/u;

// The owner NAMED a chalet in the sentence (a chalet-designator word is present).
// Used so an unknown name inside a booking command is answered with the real
// registered list instead of the generic «لأي شاليه تريد الحجز؟».
const CHALET_NAMED_RE = /(?:^|\s)(?:شاليه|شالية|الشاليه|الشالية|شاليهات|قصر|منتجع|منتجعات|استراحة)/u;

// A READ question that merely NAMES a chalet («كم سعر شاليه سكاي؟»، «هل سكاي
// متاح؟») must never be read as a chalet-swap correction on the open draft
// (A-P2-4). A leading question word, or a trailing «؟» alongside a
// price/availability word, marks the turn as a question — a real swap uses a
// correction context instead («لا الشاليه سكاي»، «بدل تولوم سكاي»).
const CHALET_READ_Q_LEAD_RE = /^\s*(?:كم|ما|هل|وش|شنو|شو|كيف|متى|ايش|أيش|وين|اين)(?:\s|$)/;
const CHALET_READ_Q_PRICEISH_RE = /(?:سعر|السعر|بكم|متاح|متاحة|متوفر|متوفرة|فاضي|فاضية)/;
function isChaletReadQuestion(message) {
  const s = stripTashkeelTatweel(String(message || "")).replace(/[أإآٱ]/g, "ا").trim();
  if (CHALET_READ_Q_LEAD_RE.test(s)) return true;
  if (/؟\s*$/.test(s) && CHALET_READ_Q_PRICEISH_RE.test(s)) return true;
  return false;
}

// Short period wording (اسم فترة أو وصفها) worth handing to the resolver.
// The bare «مساء» forms are listed explicitly: the «مسائي» stem uses ئ
// (U+0626) while «مساء» ends in the standalone hamza ء (U+0621) — without
// them a PM answer never registered and fell to the model (live bug).
function extractPeriodText(message) {
  // Fold tatweel/harakat FIRST (consistent with the chalet resolver): «مسـاء»
  // with an embedded tatweel must match «مساء», not fall through and re-ask an
  // already-answered field.
  // «فترة5» glued (no space) is how the owner actually types the digit labels
  // the app itself suggests — the glued alternative must come first.
  const m = stripTashkeelTatweel(String(message || "")).match(
    /((?:ال)?فترة\s*[0-9٠-٩]+|الفترة\s+\S+|فترة\s+\S+|(?:ال)?(?:صباحي?ة?|مسائي?ة?|ليلي?ة?|نهاري?ة?)|مساءً|مساءا|المساء|مساء|عشاء|بالليل|ليلاً|ليلا|الليلة|ظهراً|ظهرا|الظهر|عصراً|عصرا|العصر|الضحى|ضحى|الفجر|فجر)/u,
  );
  return m ? m[0] : "";
}

// A LABEL hint for same-time tie-breaking must be an explicit «فترة …»
// phrase — never a bare meridiem word (that word usually fed the time parse
// itself). The LAST phrase wins: owners append the clarification at the end
// («فترة النهار … من ٧ الى ٥ … الفترة خمسه» — live IMG_6708).
function extractPeriodLabelHint(message) {
  const matches = [...String(message || "").matchAll(/(?:ال)?فترة\s*([^\s،,.!؟;؛:]+)/gu)];
  return matches.length ? matches[matches.length - 1][0] : "";
}

// Typed draft cancellation — the guided fallback advertises «الغِ الحجز», so
// it must always work (diacritics stripped before matching). Also covers the
// natural colloquial closes: «ما ابي/أبي/أبغى»، «خلاص الغيه»، «خلاص خلاص»،
// «توقف»، «بطّل/بطل». A leading «خلاص» must be followed by a real cancel word
// (bare «خلاص» alone is ambiguous with «done, save it» and is NOT a cancel).
const CANCEL_DRAFT_RE =
  /^\s*(?:الغ|ألغ|الغي|ألغي|الغيه|ألغيه|إلغاء|الغاء|كنسل|cancel|توقف|بطل|بطّل|ما\s*اب(?:ي|غى|غا)|ما\s*أب(?:ي|غى|غا)|خلاص\s+(?:خلاص|الغ|ألغ|الغي|ألغي|الغيه|ألغيه|كنسل|cancel|بطل|بطّل|توقف))\s*(?:الحجز|الطلب|المسودة|بسير|الان|عنك)?\s*[.!؟]*\s*$/;

// A short answer to our own «باسم من؟» question is a customer name even when
// the owner naturally replies with just «علي». Keep this contextual and
// fail-closed: digits, commands, confirmations, dates, times and booking-field
// wording are never accepted as a name.
const BARE_NAME_BLOCK_RE =
  /(?:^|\s)(?:حجز|احجز|سجل|شاليه|فترة|ضيف|ضيوف|شخص|عدد|سعر|المبلغ|جوال|هاتف|رقم|اليوم|بكرة|غدا|تاريخ|صباح|مساء|ليل|ظهر|عصر|من|الى|حتى)(?=\s|$)/;
function contextualCustomerNameAnswer(raw, today) {
  const s = String(raw || "").trim().replace(/[.!؟،,;؛:]+$/g, "").trim();
  if (!s || s.length > 60 || s.split(/\s+/).length > 5) return "";
  if (!/^[\p{L}\s'’-]+$/u.test(s)) return "";
  if (isBareConfirmPhrase(s) || CANCEL_DRAFT_RE.test(s) || BARE_NAME_BLOCK_RE.test(s)) return "";
  const named = extractFacts(`العميل ${s}`, today);
  return String(named.fields && named.fields.customer_name || "").trim();
}

// Same contract for «لأي شاليه تريد الحجز؟» — a short bare reply IS the
// chalet name («تولوم», «شالية تولوم» — live IMG_6703). The block-list drops
// «شاليه» (it may legitimately open the answer) but keeps every other-field
// word. Numbered chalet names are valid («تولوم 2»); only an all-numeric
// answer is rejected so a bare guest/price numeral never becomes a chalet.
const CHALET_ANSWER_BLOCK_RE =
  /(?:^|\s)(?:حجز|احجز|سجل|فترة|ضيف|ضيوف|شخص|عدد|سعر|المبلغ|جوال|هاتف|رقم|اليوم|بكرة|غدا|تاريخ|صباح|مساء|ليل|ظهر|عصر|من|الى|حتى)(?=\s|$)/;
function contextualChaletAnswer(raw) {
  const s = String(raw || "").trim().replace(/[.!؟،,;؛:]+$/g, "").trim();
  if (!s || s.length > 60 || s.split(/\s+/).length > 5) return "";
  if (/^\d+$/.test(foldDigits(s))) return "";
  if (!/^[\p{L}\p{N}\s'’-]+$/u.test(s)) return "";
  if (isBareConfirmPhrase(s) || CANCEL_DRAFT_RE.test(s) || CHALET_ANSWER_BLOCK_RE.test(s)) return "";
  return s;
}

// And for «أي فترة تريد؟»: a short bare label («دوام») rides the resolver's
// period_text tiers («فترة 3» is already caught by extractPeriodText).
// Wording that clearly belongs to ANOTHER field (dates, phones, prices,
// guests) is never a period label — «بعد يومين» must stay a date answer.
// «بعد» is a DATE opener («بعد يومين»/«بعد بكرة») EXCEPT when a prayer/time word
// follows it — «بعد المغرب»/«بعد العشاء»/«بعد الظهر» are period phrases and must
// pass through to contextualPeriodAnswer (A-P1-3).
const PERIOD_ANSWER_BLOCK_RE =
  /(?:^|\s)(?:اليوم|بكرة|بكره|باكر|باكرا|غدا|غد|بعد(?!\s+(?:ال)?(?:مغرب|عشاء|فجر|ظهر|عصر))|تاريخ|بتاريخ|يوم|يومين|اسبوع|أسبوع|جوال|هاتف|رقم|سعر|السعر|بسعر|مبلغ|بمبلغ|المبلغ|باسم|العميل|ضيوف|ضيف|شخص|اشخاص|عدد)(?=\s|$)/;
function contextualPeriodAnswer(raw) {
  const s = String(raw || "").trim().replace(/[.!؟،,;؛:]+$/g, "").trim();
  if (!s || s.length > 30 || s.split(/\s+/).length > 3) return "";
  // Digits are ALLOWED: real period labels are «فترة 5»/«الفترة 6» — the old
  // letters-only guard rejected the exact answers the bot itself suggested
  // (live IMG_6708 «فترة5»).
  if (!/^[\p{L}\p{N}\s'’-]+$/u.test(s)) return "";
  if (isBareConfirmPhrase(s) || CANCEL_DRAFT_RE.test(s)) return "";
  if (PERIOD_ANSWER_BLOCK_RE.test(s)) return "";
  return s;
}

// EVERY question kind the pipeline can ask MUST have an answer path in
// runBookingPipeline («fix» and «date» ride extractFacts + the DATEISH
// clarify; the rest have explicit branches). The enumeration test pins this:
// a new ask() kind without a registered parser fails CI by construction.
export const PENDING_ANSWER_KINDS = new Set([
  "fix", "date", "time_ampm", "chalet", "pick", "period", "guests", "total", "customer_name",
]);

// pending_q kind for the FIRST missing field (missingFields returns them in
// question-priority order already).
const PENDING_KIND_BY_MISSING = {
  chalet: "chalet",
  booking_date: "date",
  period: "period",
  guests: "guests",
  total: "total",
  customer_name: "customer_name",
};

// «التعديل بالاختيار»: fields the owner can change by TAPPING a chip on the
// prepared card's «تعديل», instead of typing the whole correction. Each maps
// to an EXISTING pending_q kind (via PENDING_KIND_BY_MISSING), so the owner's
// next reply is answered by the very same single-field parser the collection
// flow already uses — no new answer path, PENDING_ANSWER_KINDS untouched.
// «chalet» is intentionally excluded: changing it re-resolves period+price, so
// it stays a free-form edit (the owner just types the new chalet).
const EDIT_FIELD_LABELS_AR = {
  booking_date: "التاريخ",
  period: "الفترة",
  guests: "الضيوف",
  total: "السعر",
  customer_name: "العميل",
};
const EDIT_FIELD_ORDER = ["booking_date", "period", "guests", "total", "customer_name"];
const EDITABLE_FIELDS = new Set(EDIT_FIELD_ORDER);

// The «أضف الجوال المحفوظ» chip (known returning customer) sends this fixed
// POSITIVE imperative; close manual variants also match. Verbs are boundary
// -anchored and must be followed by whitespace, so they never fire inside an
// inflected word («تضيف»/«أضفت»), and there is NO bare-noun alternative — a mere
// «الرقم المحفوظ» inside a question must not trigger.
const WANTS_SAVED_PHONE_RE = /(?:^|\s)(?:أضف|اضف|ضيّف|حط|استخدم)\s+.*?(?:الجوال|الرقم|الهاتف)\s+.*?(?:المحفوظ|السابق)/;
// …and a NEGATED request («لا تضيف الرقم المحفوظ») must attach nothing.
const NEGATED_SAVED_PHONE_RE = /(?:^|\s)(?:لا|ما|مو|مب|بدون|بلا)\s+(?:تضيف|نضيف|أضف|اضف|ضيف|حط|استخدم)/;

// One chip per editable field, each carrying the CURRENT value as a hint (the
// prepared card leaves the screen on «تعديل», so the chip is the only place the
// owner still sees what a field holds). Read-only — never mutates the draft.
function editFieldChips(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  return EDIT_FIELD_ORDER.map((field) => {
    let value = null;
    if (field === "booking_date" && f.booking_date) {
      value = formatDateDisplay(String(f.booking_date)) || String(f.booking_date);
    } else if (field === "period" && f.period_label) {
      value = String(f.period_label);
    } else if (field === "guests" && Number.isInteger(f.guests)) {
      value = String(f.guests);
    } else if (field === "total") {
      if (f.total_source === "free") value = "مجاني";
      else if (Number.isFinite(Number(f.total)) && Number(f.total) > 0) value = String(f.total);
    } else if (field === "customer_name" && f.customer_name) {
      value = String(f.customer_name);
    }
    return { field, label: EDIT_FIELD_LABELS_AR[field], value };
  });
}

const CONFLICT_HEAD_AR = "هذه الفترة محجوزة بالفعل. لم يتم حفظ الحجز.";
// head: a richer first line when the caller has one (e.g. WHICH booking
// blocks, from availabilityFailureAr) — falls back to the generic conflict.
function alternativesReplyAr(alts, head) {
  const h = typeof head === "string" && head.trim() ? head.trim() : CONFLICT_HEAD_AR;
  if (!alts.length) return h + " جرّب تاريخاً أو فترة أخرى.";
  const lines = alts.map(
    (a, i) =>
      `${i + 1}. ${a.chalet_name} — ${formatDateDisplay(a.date)} — ${a.start}–${a.end}` +
      (a.price ? ` — ${a.price} ريال` : ""),
  );
  return h + "\nأقرب الخيارات المتاحة:\n" + lines.join("\n") + "\nاكتب رقم الخيار، أو عدّل التاريخ/الفترة.";
}

// Turn a resolver ambiguity into the same stored, one-tap selection contract
// used by conflict recovery. Every option is a real, currently available
// period from the authoritative document; no id is exposed in the chat.
function periodChoiceAlternatives(doc, fields, options) {
  if (!doc || !fields.booking_date || !fields.chalet_id || !Array.isArray(options)) return [];
  const chalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
  if (!chalet) return [];
  const out = [];
  for (const opt of options) {
    const period = (chalet.periods || []).find((p) => String(p.id) === String(opt.period_id));
    if (!period) continue;
    const check = availabilityCheck(doc, fields.chalet_id, fields.booking_date, period);
    if (!check.available) continue;
    out.push({
      chalet_id: String(chalet.id || ""),
      chalet_name: String(chalet.name || ""),
      date: String(fields.booking_date),
      period_id: String(period.id || ""),
      period_label: String(period.label || ""),
      start: String(period.start || ""),
      end: String(period.end || ""),
      price: suggestedPrice(period, fields.booking_date),
    });
    if (out.length === 3) break;
  }
  return out;
}

function periodChoiceReplyAr(reason, alts) {
  const lines = alts.map(
    (a, i) => `${i + 1}. ${a.period_label || "فترة"} (${a.start}–${a.end})` + (a.price ? ` — ${a.price} ريال` : ""),
  );
  return `${reason || "حدد الفترة بالاسم أو بالوقت."}\n${lines.join("\n")}\nاضغط أحد الخيارات أو اكتب رقمه.`;
}

// The deterministic Booking Agent turn. Returns a full response body (without
// thread_id) or null to fall through to the model.
async function runBookingPipeline(deps, ctx, { threadId, rawMessage, message, privateFacts, today, forced }) {
  if (!threadId) return null;
  if (typeof deps.getActiveDraft !== "function" || typeof deps.upsertDraft !== "function") return null;

  const row = await deps.getActiveDraft(ctx.wsKey, threadId);
  const intent = hasBookingIntent(message);
  if (!row && !intent) return null;

  // G3: a FRESH booking request (no active draft) that DELEGATES the choice to
  // the assistant needs judgment the deterministic parser can't provide — yield
  // to the model, which reads availability/analytics and proposes a full prepare
  // (all validators + the owner-token confirm gate still apply). A concrete
  // «احجز تولوم بكرة» carries no delegation cue → stays deterministic here.
  if (!row && intent && !forced && DELEGATE_BOOKING_RE.test(message)) return null;

  // The question the server asked LAST turn (server-owned dialogue state).
  const pendingQ = row && row.fields && row.fields.pending_q ? row.fields.pending_q : null;

  // Typed cancellation always works mid-draft (the guided fallback offers it).
  if (row && CANCEL_DRAFT_RE.test(String(message || "").replace(/[\u064b-\u065f\u0670]/g, ""))) {
    const cancelClean = String(message || "").replace(/[\u064b-\u065f\u0670]/g, "").replace(/[أإآٱ]/g, "ا");
    // While a numbered PICK is pending, a SOFT close («ما ابي»/«توقف»/«بطل»
    // WITHOUT «الحجز/الطلب/المسودة» and WITHOUT an explicit إلغاء/كنسل stem) is
    // hesitation about the OPTIONS, not a teardown of the whole booking —
    // re-offer the list / re-ask rather than destroy the draft (A-P1-2). An
    // explicit «الغِ الحجز»/«كنسل»/«الغاء الحجز» still cancels.
    const isExplicitCancel = /(?:الغ|كنسل|cancel|الحجز|الطلب|المسودة)/.test(cancelClean);
    if (pendingQ && pendingQ.kind === "pick" && !isExplicitCancel) {
      const alts = row.fields && Array.isArray(row.fields.alternatives) ? row.fields.alternatives : [];
      if (alts.length) {
        return {
          ok: true,
          reply_ar: alternativesReplyAr(alts, "لم ألغِ الحجز. اختر رقماً من الخيارات، أو اكتب «الغِ الحجز» لإلغائه:"),
          tool_results: [],
          next_actions: alts.map((a, i) => ({ pick: i + 1, chalet_name: a.chalet_name, date: a.date, start: a.start, end: a.end, price: a.price ?? null })),
        };
      }
      const missing0 = missingFields(row.fields || {});
      const pendingText = (pendingQ && pendingQ.q) || (missing0.length ? nextQuestionAr(row.fields || {}, missing0) : "");
      return {
        ok: true,
        reply_ar: pendingText
          ? `ما زلت أنتظر اختيارك:\n${pendingText}\nاكتب «الغِ الحجز» لإلغاء هذا الحجز.`
          : "اختر رقماً من الخيارات المعروضة، أو اكتب «الغِ الحجز» لإلغائه.",
        tool_results: [],
      };
    }
    try { await deps.closeDraft?.(ctx.wsKey, threadId, "cancelled"); } catch { /* non-fatal */ }
    if (row.linked_action_id) {
      try {
        const actx = await deps.getConfirmationContext?.(ctx.wsKey, String(row.linked_action_id));
        if (actx && actx.status === "prepared") {
          await deps.finalizeAction?.(ctx.wsKey, String(row.linked_action_id), { status: "rejected", error_code: "CANCELLED_BY_OWNER" });
        }
      } catch { /* non-fatal */ }
    }
    return { ok: true, draft_cancelled: true, reply_ar: "تم الإلغاء، لم يُحفظ شيء. اطلب «جهّز حجز جديد» متى ما احتجت.", tool_results: [] };
  }

  const facts = extractFacts(rawMessage || "", today);
  // A bare «مساء/صباح» is the ANSWER to our own AM/PM clarify question —
  // resolve the stored ambiguous candidate into a concrete range.
  let meridiemAnswered = false;
  if (
    row && pendingQ && pendingQ.kind === "time_ampm" && !facts.time &&
    pendingQ.data && pendingQ.data.start && pendingQ.data.end
  ) {
    const mer = classifyMeridiemWord(message);
    if (mer) {
      const resolved = parseTimeExpression(
        `من ${pendingQ.data.start} ${mer === "PM" ? "مساء" : "صباحا"} الى ${pendingQ.data.end}`,
      );
      if (resolved) {
        facts.time = resolved;
        meridiemAnswered = true;
      }
    }
  }
  if (row && pendingQ && pendingQ.kind === "customer_name" && !facts.fields.customer_name) {
    const contextualName = contextualCustomerNameAnswer(rawMessage, today);
    if (contextualName) facts.fields.customer_name = contextualName;
  }
  // Bare-numeral routing by the PENDING question: «٥٠» answering the TOTAL
  // question is money — without this, the guests whole-message rule (1-200)
  // claimed it and the total stayed missing forever.
  if (row && pendingQ && pendingQ.kind === "total" && facts.fields.total === undefined) {
    const folded = foldDigits(String(rawMessage || "")).trim();
    if (/^\d{1,6}$/.test(folded)) {
      const n = Number(folded);
      if (n >= 0 && n <= 100000) {
        facts.fields.total = n;
        facts.fields.total_source = "explicit";
        delete facts.fields.guests;
      }
    }
  }
  const pick = row ? parseAlternativePick(message, row.fields || {}) : null;
  // A bare digit that SELECTS a conflict option («١»/«٢»/«٣») must not ALSO
  // be filed as the guest count: extractFacts' whole-message rule read «١» as
  // guests=1 and would silently overwrite the owner's stated headcount. When
  // we are picking (or the pending question is the pick list and the message
  // is a bare 1-3-digit numeral), drop the numeral's guests/total reading.
  if (pick || (pendingQ && pendingQ.kind === "pick")) {
    // A spoken-number pick («خمسه» → فترة 5) is ALSO a valid guest word to
    // extractGuestCount; a digit pick («٢») is ALSO the whole-message guest
    // rule. Either way, a token used to SELECT must never fabricate a headcount.
    if (isBarePickToken(rawMessage)) {
      delete facts.fields.guests;
      delete facts.fields.total;
    }
  }
  // A bare reply while WE asked for the chalet is the chalet name.
  const chaletAnswer =
    row && pendingQ && pendingQ.kind === "chalet" ? contextualChaletAnswer(rawMessage) : "";
  const timeText = facts.time ? `${facts.time.start}-${facts.time.end}` : "";
  // The meridiem word answered the time question — it must not double as a
  // period-name correction this turn. A bare label while WE asked for the
  // period rides the same periodWord plumbing as known period words.
  // A DATE answer to the period question is a date, not a period label —
  // «بعد يومين» was filed as period_text and answered with «لم أجد هذه
  // الفترة» (live Scenario A). Any parsed date this turn wins the reading.
  // A meridiem answer (or the pending AM/PM question itself) must not be read as
  // a period label — «ظهراً»/«مساء» answers the time question, not «أي فترة».
  let periodWord = (meridiemAnswered || (pendingQ && pendingQ.kind === "time_ampm"))
    ? ""
    : extractPeriodText(message) ||
      (row && pendingQ && pendingQ.kind === "period" &&
       !facts.fields.booking_date && !facts.fields.date_error
        ? contextualPeriodAnswer(rawMessage)
        : "");
  // A prayer/meridiem word INSIDE a «من … الى/لـ …» time clause is a CLOCK
  // endpoint («من المغرب للفجر»), not the period label — suppress it so the
  // parsed time drives resolution instead of فجر→صباح booking the morning slot.
  if (periodWord && PRAYER_PERIOD_RE.test(periodWord) && TIME_RANGE_CLAUSE_RE.test(stripTashkeelTatweel(message))) {
    periodWord = "";
  }
  // A bare digit or spoken number answering the PERIOD question is a label pick
  // («٥»/«خمسه» = «فترة 5»), never a guest count — mirror the pick guard above.
  if (row && pendingQ && pendingQ.kind === "period" && periodWord && isBarePickToken(rawMessage)) {
    delete facts.fields.guests;
    delete facts.fields.total;
  }
  // The authoritative document is needed for the chalet-swap correction signal
  // below and for binding/availability further down — load it once per turn.
  const snap0 = typeof deps.getWorkspaceData === "function" ? await deps.getWorkspaceData(ctx.wsKey) : null;
  const doc0 = snap0 && snap0.data ? snap0.data : null;
  // A PURE chalet correction on an active draft («لا الشاليه سكاي») carries no
  // date/guests/total/name/time/phone signal, so the closed-guided gate below
  // would swallow it and never reach the swap code. Count it as a fact signal —
  // but ONLY when the turn names a DIFFERENT resolvable chalet, so a chalet-less
  // answer still cannot clobber a good earlier hint (R9).
  // (Not while a numbered PICK is pending: there «شاليه سكاي» means "that option
  // isn't in the list", handled by the pick-fallback — not a chalet swap.)
  // A READ question that merely NAMES another chalet («كم سعر شاليه سكاي؟») is
  // not a swap correction — it must not silently re-point the open draft to that
  // chalet (A-P2-4). A genuine swap carries a correction context («لا الشاليه
  // سكاي»، «بدل تولوم سكاي»), never a leading question word or a price/availability «؟».
  const curChaletId = row && row.fields ? String(row.fields.chalet_id || "") : "";
  let chaletSwapSignal = false;
  if (row && curChaletId && doc0 && !(pendingQ && pendingQ.kind === "pick") && !isChaletReadQuestion(message) && /شاليه|شالية/.test(message)) {
    const swap = resolveChaletReference(doc0, { chalet_name: redactText(rawMessage || "").slice(0, 200) });
    if (swap.ok && String(swap.chalet.id) !== curChaletId) chaletSwapSignal = true;
  }
  // «أضف الجوال المحفوظ» (returning-customer chip): inject this named customer's
  // UNIQUE saved phone into facts.private BEFORE the fact-signal check, so the
  // closed-guided-mode no-op guard treats it as a real turn instead of swallowing
  // it. Collision-safe; the raw number stays server-side (masked to the owner,
  // never to the model). Absent if the owner already gave a phone this turn.
  const msgStr = String(message || "");
  const wantsSavedPhone = WANTS_SAVED_PHONE_RE.test(msgStr) && !NEGATED_SAVED_PHONE_RE.test(msgStr);
  // Use THIS turn's name when the same message also renames the customer, so we
  // never attach the previous customer's phone under a new name.
  const nameForPhone = (facts.fields && facts.fields.customer_name) || (row && row.fields && row.fields.customer_name) || "";
  if (row && wantsSavedPhone && nameForPhone && !(facts.private && facts.private.customer_phone)) {
    const savedPhone = knownCustomerPhone(doc0, nameForPhone);
    if (savedPhone) facts.private = { ...(facts.private || {}), customer_phone: savedPhone };
  }
  const factSignal = Boolean(
    (facts.fields &&
      (facts.fields.booking_date ||
        facts.fields.date_error ||
        facts.fields.guests !== undefined ||
        facts.fields.total !== undefined ||
        facts.fields.customer_name)) ||
      facts.time ||
      facts.free ||
      facts.accept_suggestion ||
      (facts.private && facts.private.customer_phone) ||
      periodWord ||
      chaletAnswer ||
      chaletSwapSignal,
  );
  if (row && !intent && !factSignal && !pick && !forced) {
    // CLOSED GUIDED MODE: an active-draft turn NEVER falls through to the
    // model (that path produced «لم أفهم هذا الطلب كأمر مدعوم» and invented
    // requirements mid-booking). Date-ish wording gets the date clarify;
    // anything else re-asks the PENDING question. Nothing is merged or
    // saved, so the stored pending_q survives for the next turn.
    if (DATEISH_RE.test(message)) {
      return { ok: true, reply_ar: DATE_CLARIFY_AR, tool_results: [] };
    }
    // «عطني خيارات وانا اضغط عليها» (live IMG_6709): an OPTIONS request while
    // a numbered list is stored re-sends it with the one-tap chips — never
    // the «لم أفهم ردّك» fallback.
    const storedAlts = row.fields && Array.isArray(row.fields.alternatives) ? row.fields.alternatives : [];
    if (storedAlts.length && /(خيار|خيارات|اختيار|بدائل|ازرار|أزرار|اضغط|الاختيارات)/.test(message)) {
      return {
        ok: true,
        reply_ar: alternativesReplyAr(storedAlts, "هذه الخيارات المتاحة — اضغط أحدها أو اكتب رقمه:"),
        tool_results: [],
        next_actions: storedAlts.map((a, i) => ({
          pick: i + 1,
          chalet_name: a.chalet_name,
          date: a.date,
          start: a.start,
          end: a.end,
          price: a.price ?? null,
        })),
      };
    }
    // While a numbered PICK is pending, a reply that NAMES an option the list
    // doesn't contain (a real chalet not shown, a re-typed conflicted name, an
    // explicit «شاليه/فترة» reference) re-emits the FULL options — never «لم
    // أفهم», and never the 220-char-truncated pending echo that dropped option
    // 3. Pure gibberish is NOT an option attempt, so it still gets the guided
    // «لم أفهم ردّك» fallback below (which always advertises «الغِ الحجز»).
    const looksLikeOption =
      /(?:^|\s)(?:شاليه|شالية|الشاليه|فترة|الفترة)(?=\s|$)/.test(message) ||
      /(صباحي|صباحية|مسائي|مسائية|ليلي|ليلية|نهاري|نهارية)(?=\s|$)/.test(message) ||
      storedAlts.some((a) =>
        (a.chalet_name && message.includes(String(a.chalet_name))) ||
        (a.period_label && message.includes(String(a.period_label)))
      );
    if (pendingQ && pendingQ.kind === "pick" && storedAlts.length && looksLikeOption) {
      return {
        ok: true,
        reply_ar: alternativesReplyAr(storedAlts, "هذا الخيار ليس ضمن القائمة المعروضة. اختر رقماً من الخيارات:"),
        tool_results: [],
        next_actions: storedAlts.map((a, i) => ({
          pick: i + 1,
          chalet_name: a.chalet_name,
          date: a.date,
          start: a.start,
          end: a.end,
          price: a.price ?? null,
        })),
      };
    }
    const missing0 = missingFields(row.fields || {});
    const pendingText =
      (pendingQ && pendingQ.q) ||
      (missing0.length ? nextQuestionAr(row.fields || {}, missing0) : "");
    return {
      ok: true,
      reply_ar: pendingText
        ? `لم أفهم ردّك، وما زلت أنتظر إجابة السؤال الحالي:\n${pendingText}\nاكتب «الغِ الحجز» لإلغاء هذا الحجز.`
        : "بيانات الحجز مكتملة — اكتب «سجل» لعرض بطاقة الحفظ، أو «الغِ الحجز» للإلغاء.",
      tool_results: [],
    };
  }

  // ---- merge this turn's facts into the server draft ----
  let fields = mergeDraft(row ? row.fields || {} : {}, facts);
  // The stored pending question was for LAST turn; whichever branch asks
  // something this turn re-records its own via ask().
  delete fields.pending_q;
  // The chalet hint the resolver sees is a REDACTED copy of the message —
  // fields jsonb is model-visible by design and must never carry a raw phone.
  const safeMessage = redactText(rawMessage || "").slice(0, 200);
  // The chalet hint the resolver scans. A NEW booking sentence or the owner's
  // direct ANSWER to our chalet question (live IMG_6703: «تولوم» must bind)
  // always sets it. A substantive ANSWER turn that carries other facts may
  // ALSO name the chalet in passing — «الحجز باسم محمد التاريخ بعد ٣ ايام
  // شالية تولوم عدد الضيوف ٥» is too long for the short-answer path yet clearly
  // names it (live IMG_6721). But such a turn refreshes the hint ONLY when it
  // actually resolves to a chalet — otherwise a chalet-less answer («مساء» to
  // the AM/PM question) would clobber a good earlier hint and strand the draft.
  if (!fields.chalet_id && safeMessage) {
    const thisHint = chaletAnswer ? redactText(chaletAnswer).slice(0, 200) : chaletHintFromMessage(safeMessage);
    if (intent || !row || chaletAnswer) {
      fields.chalet_text = thisHint;
    } else if (factSignal && doc0 && resolveChaletReference(doc0, { chalet_name: thisHint }).ok) {
      fields.chalet_text = thisHint;
    }
  }
  const dateChanged = Boolean(facts.fields && facts.fields.booking_date);
  if (timeText) {
    fields.period_text = timeText;
    // The owner often names the period IN THE SAME sentence as the time
    // («من ٧ الى العصر ٥ … الفترة خمسه»). The time drives resolution, but an
    // explicit «فترة …» NAME is kept as a tie-breaker for same-time periods —
    // discarding it was the live IMG_6708 dead-end.
    const labelHint = extractPeriodLabelHint(rawMessage);
    if (labelHint) fields.period_label_hint = labelHint;
    else delete fields.period_label_hint;
    fields.canonical_start = facts.time.start;
    fields.canonical_end = facts.time.end;
    fields.wraps_next_day = facts.time.wraps_next_day;
    fields.time_low_confidence = facts.time.confidence === "low";
    // Time changed => any previously bound period must re-resolve.
    delete fields.period_id;
    delete fields.period_label;
  } else if (periodWord && !fields.period_id) {
    fields.period_text = periodWord;
    delete fields.period_label_hint;
  } else if (periodWord && fields.period_id) {
    // A period CORRECTION by name («خلها الصباحية») unbinds and re-resolves —
    // otherwise the old slot silently survives the edit.
    fields.period_text = periodWord;
    delete fields.period_id;
    delete fields.period_label;
    delete fields.period_label_hint;
  }
  // A chalet correction by name rebinds too (and its periods with it) — but a
  // READ question that names a chalet is never a correction (A-P2-4).
  if (fields.chalet_id && /شاليه/.test(message) && doc0 && !isChaletReadQuestion(message)) {
    const swap = resolveChaletReference(doc0, { chalet_name: safeMessage });
    if (swap.ok && String(swap.chalet.id) !== String(fields.chalet_id)) {
      fields.chalet_id = String(swap.chalet.id);
      fields.chalet_name = String(swap.chalet.name || "");
      delete fields.period_id;
      delete fields.period_label;
      delete fields.alternatives;
    }
  }
  if (pick) {
    fields = { ...fields, ...pick };
    delete fields.alternatives;
    delete fields.period_text;
    delete fields.period_options;
    // A pasted option line may itself parse as a LOW-confidence bare time —
    // the explicit pick overrides that ambiguity completely.
    delete fields.time_low_confidence;
    fields.wraps_next_day = Boolean(
      pick.canonical_start && pick.canonical_end && pick.canonical_end <= pick.canonical_start,
    );
  } else if (fields.alternatives && (dateChanged || timeText || periodWord)) {
    // The owner answered the conflict another way — the stale numbered list
    // must not swallow a later bare numeral (e.g. a guests answer).
    delete fields.alternatives;
  }
  // Any change to the slot invalidates a previously quoted "system price":
  // the weekday/weekend suggestion belongs to ONE specific date + period —
  // and so does a price adopted from a previously tapped option.
  if (dateChanged || timeText || periodWord || pick) {
    if (
      fields.total_source === "suggested" ||
      fields.total_source === "accepted_suggestion" ||
      fields.total_source === "alternative_price"
    ) {
      delete fields.total;
      delete fields.total_source;
    }
    delete fields.total_suggested;
  }
  // Tapping an option that shows a price accepts that price (§ the owner's
  // spec) — but an explicit owner-stated total always wins over it.
  if (pick) {
    const pickPrice = Number(fields.pick_price);
    delete fields.pick_price;
    if (Number.isFinite(pickPrice) && pickPrice > 0 && fields.total === undefined) {
      fields.total = pickPrice;
      fields.total_source = "alternative_price";
      fields.sources = { ...(fields.sources || {}), total: "selection" };
    }
  }

  const priv = (typeof deps.getDraftPrivate === "function" ? await deps.getDraftPrivate(ctx.wsKey, threadId) : {}) || {};
  // facts.private.customer_phone carries either the owner's typed phone OR the
  // returning-customer saved phone injected above (the «أضف الجوال المحفوظ» chip).
  const newPhone = (privateFacts && privateFacts.customer_phone) || (facts.private && facts.private.customer_phone) || "";
  const privMerged = newPhone ? { ...priv, customer_phone: newPhone } : priv;
  // Offer the saved phone (MASKED) when a known returning customer's booking is
  // otherwise ready without one — a suggestion the owner opts into via a chip
  // (never auto-applied). The chip's «أضف الجوال المحفوظ» is handled above.
  const savedPhoneOffer = !privMerged.customer_phone && fields.customer_name
    ? knownCustomerPhone(doc0, fields.customer_name)
    : "";

  const saveDraft = async (linkedActionId) => {
    await deps.upsertDraft(ctx.wsKey, threadId, fields, privMerged, linkedActionId);
  };
  const ask = async (question, extra) => {
    // Server-owned dialogue state: record WHICH question is now pending so
    // the next turn can answer it and the guided fallback can repeat it.
    // Callers pass a specific pending_q kind; everything else records 'fix'.
    const { pending_q: pq, ...rest } = extra || {};
    fields.pending_q = { kind: "fix", ...(pq || {}), q: String(question).slice(0, 220) };
    await saveDraft();
    return { ok: true, reply_ar: question, tool_results: [], ...rest };
  };

  // ---- hard input problems first ----
  if (fields.date_error) {
    const q = fields.date_error.reason_ar || "التاريخ غير صحيح. اكتب التاريخ مثل: بكرة أو 15-08-2026.";
    delete fields.date_error;
    return ask(q, { pending_q: { kind: "date" } });
  }
  if (fields.time_low_confidence) {
    delete fields.time_low_confidence;
    // The naive-AM candidate stays on the draft; a bare «مساء/صباح» next turn
    // resolves it via pending_q.data (see the meridiem branch above).
    return ask("الوقت غير واضح: صباحاً أم مساءً؟ اكتب مثلاً «من ٧ مساءً إلى ٥ صباحاً».", {
      pending_q: { kind: "time_ampm", data: { start: fields.canonical_start, end: fields.canonical_end } },
    });
  }

  // ---- bind chalet / period / availability against the REAL document ----
  const doc = doc0;

  if (doc && !fields.chalet_id && fields.chalet_text) {
    const cres = resolveChaletReference(doc, { chalet_name: fields.chalet_text });
    if (cres.ok) {
      fields.chalet_id = String(cres.chalet.id || "");
      fields.chalet_name = String(cres.chalet.name || "");
      delete fields.chalet_text;
    } else if (cres.error === "CHALET_AMBIGUOUS") {
      return ask(cres.reason_ar, { pending_q: { kind: "chalet" } });
    } else if (cres.error === "CHALET_NOT_FOUND" && (chaletAnswer || (intent && CHALET_NAMED_RE.test(message)))) {
      // The owner NAMED a chalet we cannot match — either as a direct answer to
      // our chalet question, or inside a booking command («احجز قصر الياسمين…»).
      // Say it's unknown and LIST the real registered names, never the generic
      // «لأي شاليه تريد الحجز؟» that hides that the given name is unregistered.
      return ask(cres.reason_ar, { pending_q: { kind: "chalet" } });
    }
    // NOT_FOUND on a sentence that named NO chalet just means "chalet still
    // unknown" — the planner's combined question asks for it.
  }

  if (fields.chalet_id && !fields.period_id && typeof deps.resolveBookingCreateArgs === "function") {
    const pres = await deps.resolveBookingCreateArgs(
      ctx.wsKey,
      {
        chalet_id: fields.chalet_id,
        period_label: fields.period_text || undefined,
        period_label_hint: fields.period_label_hint || undefined,
        booking_date: fields.booking_date || undefined,
      },
      ctx.pin,
    );
    if (pres && pres.ok) {
      fields.period_id = String(pres.args.period_id || "");
      fields.period_label = String(pres.args.period_label || "");
      if (pres.args.period_start) fields.canonical_start = String(pres.args.period_start);
      if (pres.args.period_end) fields.canonical_end = String(pres.args.period_end);
      delete fields.period_text;
      delete fields.period_label_hint;
      delete fields.period_options;
    } else if (pres && (pres.error === "BOOKING_CONFLICT" || pres.error === "AVAILABILITY_UNPROVABLE")) {
      return conflictWithAlternatives(deps, ctx, { fields, doc, today, ask, saveDraft, head: pres.reason_ar });
    } else if (pres && (pres.error === "PERIOD_AMBIGUOUS" || pres.error === "PERIOD_TIME_INCOMPLETE")) {
      const choices = periodChoiceAlternatives(doc, fields, pres.options);
      if (pres.error === "PERIOD_AMBIGUOUS" && choices.length) {
        fields.alternatives = choices;
        return ask(periodChoiceReplyAr(pres.reason_ar, choices), {
          pending_q: { kind: "pick" },
          next_actions: choices.map((a, i) => ({
            pick: i + 1,
            chalet_name: a.chalet_name,
            date: a.date,
            start: a.start,
            end: a.end,
            price: a.price ?? null,
          })),
        });
      }
      if (pres.error === "PERIOD_AMBIGUOUS" && doc && fields.booking_date) {
        // EVERY same-time candidate is unavailable that date: asking the owner
        // to pick between occupied slots was the live dead-end («حدد بالاسم»,
        // IMG_6708). Say WHO occupies it and offer REAL alternatives instead.
        const firstOpt = Array.isArray(pres.options) && pres.options[0] ? pres.options[0] : null;
        const chalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
        const period = chalet && firstOpt
          ? (chalet.periods || []).find((p) => String(p.id) === String(firstOpt.period_id))
          : null;
        if (period) {
          const check = availabilityCheck(doc, fields.chalet_id, fields.booking_date, period);
          if (!check.available) {
            const fail = availabilityFailureAr(check, { tail: "لم يتم تجهيز أي حجز." });
            return conflictWithAlternatives(deps, ctx, { fields, doc, today, ask, saveDraft, head: fail.reason_ar });
          }
        }
      }
      if (
        pres.error === "PERIOD_AMBIGUOUS" && !fields.booking_date &&
        Array.isArray(pres.options) && pres.options.length
      ) {
        // No date yet, so the options cannot be availability-checked into
        // one-tap picks. Ask for BOTH remaining answers in ONE message
        // (§ never one-by-one) and keep the real options listed; either
        // answer — or both together («بعد يومين فترة 5») — merges next turn.
        const opts = pres.options.slice(0, 3).map((o) => ({
          label: String(o.period_label || ""),
          start: String(o.start || ""),
          end: String(o.end || ""),
        }));
        fields.period_options = opts;
        const optLines = opts.map((o, i) => `${i + 1}. ${o.label || "فترة"} (${o.start}–${o.end})`);
        return ask(
          `توجد عدة فترات بنفس هذا الوقت. باقي: التاريخ (مثل: بكرة أو 15-08-2026)، والفترة:\n${optLines.join("\n")}\nأرسلهما في رسالة واحدة، مثل: «بعد يومين ${opts[0].label || "فترة 1"}».`,
          { pending_q: { kind: "period" } },
        );
      }
      return ask(pres.reason_ar || "حدد الفترة بالاسم أو بالوقت.", { pending_q: { kind: "period" } });
    } else if (pres && pres.error === "PERIOD_NOT_FOUND" && fields.period_text) {
      return ask(pres.reason_ar || "لم أجد هذه الفترة. اكتب اسمها أو وقتها كما هو مسجل.", { pending_q: { kind: "period" } });
    }
    // PERIOD_REQUIRED with no period text => stays missing; the planner asks.
  } else if (doc && fields.chalet_id && fields.period_id && fields.booking_date) {
    // The slot can go stale on ANY turn (a competing booking from another
    // device, a guests-only answer minutes later) — re-verify in memory on
    // EVERY bound turn so conflicts surface at the earliest answer, never
    // first at the card or at حفظ (live bug A).
    const chalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
    const period = chalet ? (chalet.periods || []).find((p) => String(p.id) === String(fields.period_id)) : null;
    const check = availabilityCheck(doc, fields.chalet_id, fields.booking_date, period);
    if (!check.available) {
      const fail = availabilityFailureAr(check, { tail: "لم يتم تجهيز أي حجز." });
      return conflictWithAlternatives(deps, ctx, { fields, doc, today, ask, saveDraft, head: fail.reason_ar });
    }
  }

  // ---- suggested price (needs explicit acceptance; never silently applied) --
  if (doc && fields.chalet_id && fields.period_id && fields.booking_date && fields.total === undefined && !fields.total_suggested) {
    const chalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
    const period = chalet ? (chalet.periods || []).find((p) => String(p.id) === String(fields.period_id)) : null;
    const sp = period ? suggestedPrice(period, fields.booking_date) : null;
    if (sp && sp > 0) {
      fields.total_suggested = sp;
      fields.total_source = "suggested";
    }
  }

  // ---- capacity guard: an over-capacity headcount must NEVER silently reach
  // the card. Caught here at the draft/prepare stage (the executor's own guard
  // is only the last line). Negative/zero counts are handled by the parser; this
  // enforces the upper bound against the resolved chalet's capacity.
  if (doc && fields.chalet_id && Number.isInteger(fields.guests) && fields.guests > 0) {
    const capChalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
    const capacity = capChalet ? Number(capChalet.capacity) || 0 : 0;
    if (capacity > 0 && fields.guests > capacity) {
      return ask(
        `عدد الضيوف (${fields.guests}) يتجاوز سعة الشاليه (${capacity}). قلّل العدد أو اختر شاليهاً أكبر.`,
        { pending_q: { kind: "guests" } },
      );
    }
  }

  // ---- missing fields: ONE COMBINED question for everything still open ----
  // (§ never one-by-one). The pending kind stays the FIRST missing field so
  // bare-numeral routing keeps working; a combined reply merges every fact.
  const missing = missingFields(fields);
  if (missing.length) {
    return ask(nextQuestionAr(fields, missing, { hasPhone: Boolean(privMerged.customer_phone) }), {
      pending_q: { kind: PENDING_KIND_BY_MISSING[missing[0]] || "fix" },
    });
  }

  // ---- complete: prepare the confirmation card (still nothing saved) ----
  const args = {
    customer_name: fields.customer_name,
    customer_phone: privMerged.customer_phone || undefined,
    chalet_id: fields.chalet_id,
    booking_date: fields.booking_date,
    period_id: fields.period_id,
    // Guests is OPTIONAL by owner preference: when the owner never stated it,
    // the card and the saved booking default to 1 (never 0 / undefined).
    guests:
      Number.isInteger(fields.guests) && fields.guests > 0 ? fields.guests : 1,
    total: fields.total,
    total_is_free: fields.total_source === "free" ? true : undefined,
    // The owner's stated deposit («عربون N») was captured by the planner into
    // fields.paid — carry it through to the confirmation args (and thus the
    // saved booking). A deposit NEVER substitutes for the total.
    ...(Number(fields.paid) > 0 ? { paid: Number(fields.paid) } : {}),
    notes: fields.notes || undefined,
  };
  const norm = normalizeToolCall({ name: "prepare_booking_create", arguments: args });
  if (!norm.ok) {
    return ask("بعض البيانات ناقصة أو غير صحيحة. راجعها ثم أعد المحاولة.");
  }
  const prepared = await executeTool(deps, { ...ctx, norm, raw: true, threadId });
  if (prepared && prepared.ok && prepared.kind === "prepared_action") {
    // Retire the PREVIOUS card for this draft: a typed correction just
    // produced a new one, and leaving the old action still 'prepared' would
    // let a stale tap (or a bare «نعم/سجل» recovering the latest pending)
    // save the pre-correction slot — a silent double-book against the new card.
    const prevActionId = row && row.linked_action_id ? String(row.linked_action_id) : "";
    if (prevActionId && prevActionId !== String(prepared.action_id)) {
      try {
        const prevCtx = await deps.getConfirmationContext?.(ctx.wsKey, prevActionId);
        if (prevCtx && prevCtx.status === "prepared") {
          await deps.finalizeAction?.(ctx.wsKey, prevActionId, { status: "rejected", error_code: "SUPERSEDED_BY_CORRECTION" });
        }
      } catch { /* non-fatal: at worst the old card lingers, as before */ }
    }
    delete fields.pending_q; // no open question — the card is the next step
    await saveDraft(prepared.action_id);
    return {
      ok: true,
      reply_ar: savedPhoneOffer
        ? `جهّزت الحجز — راجع البطاقة ثم اضغط حفظ الحجز. «${fields.customer_name}» عميل سابق؛ تقدر تضيف جواله المحفوظ بضغطة.`
        : "جهّزت الحجز — راجع البطاقة ثم اضغط حفظ الحجز. لن يُحفظ شيء قبل تأكيدك.",
      tool_results: [prepared],
      // A suggestion the owner OPTS INTO (masked; the raw phone never leaves the
      // server). Absent when a phone was given or the customer isn't known.
      ...(savedPhoneOffer
        ? { customer_phone_suggestion: { name: fields.customer_name, masked_phone: maskPhone(savedPhoneOffer) } }
        : {}),
    };
  }
  if (prepared && (prepared.error === "BOOKING_CONFLICT" || prepared.error === "AVAILABILITY_UNPROVABLE")) {
    return conflictWithAlternatives(deps, ctx, { fields, doc, today, ask, saveDraft, head: prepared.reason_ar });
  }
  // Any other prepare failure: keep the draft, surface the SAFE reason.
  const safe = applySafeError(prepared || { ok: false, error: "PREPARE_FAILED" });
  return ask(safe.reason_ar || "تعذّر تجهيز الحجز حالياً، ولم يتغيّر شيء.");
}

// Conflict → up to three REAL alternatives, numbered, selectable by reply.
async function conflictWithAlternatives(deps, ctx, { fields, doc, today, ask, head }) {
  let alts = [];
  if (doc && fields.chalet_id && fields.booking_date) {
    const chalet = (doc.chalets || []).find((c) => String(c.id) === String(fields.chalet_id));
    const period = chalet
      ? (chalet.periods || []).find((p) => String(p.id) === String(fields.period_id)) ||
        (fields.canonical_start
          ? { label: fields.period_label || "", start: fields.canonical_start, end: fields.canonical_end }
          : null)
      : null;
    try {
      alts = findAlternatives(doc, fields.chalet_id, fields.booking_date, period, { max: 3, todayIso: today }) || [];
    } catch {
      alts = [];
    }
  }
  fields.alternatives = alts;
  return ask(alternativesReplyAr(alts, head), {
    pending_q: { kind: "pick" },
    next_actions: alts.map((a, i) => ({
      pick: i + 1,
      chalet_name: a.chalet_name,
      date: a.date,
      start: a.start,
      end: a.end,
      price: a.price ?? null,
    })),
  });
}
