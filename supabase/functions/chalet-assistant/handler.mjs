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
import { normalizeToolCall, TOOL_REGISTRY, buildToolCatalogText } from "../_shared/assistant/tools.mjs";
import { prepareConfirmation, reissueConfirmation, hashToken, hashPayload } from "../_shared/assistant/confirmation.mjs";
import { redactText, redactObject } from "../_shared/assistant/redact.mjs";
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
} from "../_shared/assistant/booking-planner.mjs";

// The model gets at most TWO calls per turn (request tools -> ground the reply
// on the tool results) and may request at most this many tools per turn.
const MAX_TOOLS_PER_TURN = 5;
// The grounding (second) call returns the FINAL answer only — never planning
// text, never internal tool names, never error codes.
const SECOND_STAGE_INSTRUCTION =
  "هذه نتائج الأدوات. أعطِ الآن الإجابة النهائية فقط بالعربية الطبيعية المختصرة. " +
  "لا تذكر أسماء الأدوات الداخلية، ولا أكواد الأخطاء، ولا JSON. " +
  "لا تكرّر عبارات مثل «جاري» أو «سأجلب» بعد توفّر النتائج. " +
  "أجب بالأرقام والأسماء الواردة في النتائج تحديدًا، ولا تُجب بعبارة عامة مثل «تمام» أبدًا. " +
  "لا تدّعِ إتمام أي حفظ أو إجراء ما لم تُعِده الأداة كإجراء مكتمل.";

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
      // all its fields so the owner only states the change.
      if (actionId) {
        const ctx = await deps.getConfirmationContext?.(wsKey, actionId);
        if (ctx && ctx.status === "prepared") {
          await deps.finalizeAction?.(wsKey, actionId, { status: "rejected", error_code: "REOPENED_FOR_EDIT" });
        }
      }
      return json(200, { ok: true, reply_ar: "تمام — ماذا تريد تعديله؟ اكتب التغيير فقط (مثلاً: «الضيوف ستة» أو «التاريخ بعد بكرة»)." });
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
  const systemPrompt = CHALET_SYSTEM_PROMPT + "\n\n" + buildToolCatalogText() + "\n\n" + STRICT_JSON_INSTRUCTION + "\n\n" + BOOKING_FIELDS_INSTRUCTION;

  // Stage 1: the model may request tools. Transient provider failures are
  // retried (3 attempts) before giving up.
  const first = await callModelWithRetry(deps, { systemPrompt, history }, 3);
  if (!first.ok) {
    // Fail closed: no action, clear Arabic error.
    return json(200, {
      ok: false,
      assistant_unavailable: true,
      error: first.error,
      reply_ar: "تعذّر الوصول إلى المساعد الذكي حالياً. لم يتم تنفيذ أي إجراء.",
    });
  }

  // The model may have EXTRACTED booking wording (never ids). Merge it into
  // the server draft silently so the next deterministic turn knows it — the
  // resolver still does all id binding.
  if (first.bookingFields && activeThreadId && typeof deps.getActiveDraft === "function" && typeof deps.upsertDraft === "function") {
    try {
      const bf = first.bookingFields;
      const row0 = await deps.getActiveDraft(wsKey, activeThreadId);
      // Model output goes in as modelFields ONLY: the planner's merge accepts
      // customer_name/notes at most (length-capped) — never guests, totals,
      // dates or times, which the model must not invent (§5, live bug A).
      const modelIncoming = {
        fields: {},
        modelFields: {
          ...(typeof bf.customer_name === "string" && bf.customer_name ? { customer_name: bf.customer_name } : {}),
          ...(typeof bf.notes === "string" && bf.notes ? { notes: bf.notes } : {}),
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

  // Execute the requested tools (read + prepare only; bounded per turn).
  const requested = Array.isArray(first.toolCalls) ? first.toolCalls.slice(0, MAX_TOOLS_PER_TURN) : [];
  const results = [];
  for (const call of requested) {
    const norm = normalizeToolCall(withPrivateBookingFacts(call, privateFacts));
    if (!norm.ok) {
      // Every failure the owner can see MUST carry a safe Arabic reason —
      // a bare error code renders as a useless generic apology downstream.
      results.push({
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
      results.push({
        tool: norm.name,
        ok: false,
        error: "CONFIRMATION_REQUIRES_OWNER",
        reason_ar: "التنفيذ الحسّاس لا يتم من المحادثة مباشرة: اطلب مني «جهّز الحجز» وسأعرض لك بطاقة تأكيد تضغطها بنفسك، ولن يُحفظ شيء قبلها.",
      });
      continue;
    }
    results.push(await executeTool(deps, { ...ctxBase, norm, raw: true }));
  }

  // Stage 2: if tools ran, ground a final reply on their (token-stripped)
  // results. Never more than two model calls. If the second call fails, a
  // deterministic Arabic renderer still gives the owner grounded output.
  let replyAr = first.reply || "";
  let usage = first.usage;
  let modelName = first.model;
  let modelCalls = 1;
  if (results.length) {
    modelCalls = 2;
    const grounded = history.concat([
      { role: "assistant", content: first.reply || "" },
      { role: "tool", content: JSON.stringify(sanitizeResultsForModel(results)).slice(0, 6000) },
    ]);
    const second = await callModelWithRetry(deps, { systemPrompt: systemPrompt + "\n\n" + SECOND_STAGE_INSTRUCTION, history: grounded }, 2);
    if (second && second.ok && second.reply) {
      replyAr = second.reply;
      usage = second.usage;
      modelName = second.model;
    } else {
      // Deterministic safety net — describes the ACTUAL returned data. It does
      // NOT reuse the stage-1 planning reply (first.reply).
      replyAr = renderFallbackAr(results);
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
async function executeTool(deps, { wsKey, pin, norm, activeMemories, secret, raw, threadId }) {
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
  if (BOOKING_INTENT_RE.test(text)) return null;
  const asksAvailability = /(فتر|موعد)/.test(text) && /(فاضي|فاضية|متاح|متاحة)/.test(text) && /(اليوم|لليوم|هذا اليوم)/.test(text);
  if (asksAvailability) return { name: "find_empty_dates", arguments: { days_ahead: 1 } };
  const asksCatalog = /(شاليه|شاليهات)/.test(text) && /(ما\s*هي|وش|ايش|اعرض|اظهر|قائمة|المسجل|عندي|لديك)/.test(text) && !/(احجز|حجز|جهز|سج[ّل]+\s+حجز)/.test(text);
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
  // The app's OWN suggestion chips (and their natural variants) must never
  // depend on the model (live IMG_6710/6711: «تمام.» / bare counts).
  // Upcoming bookings.
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

function extractBookingPhone(raw) {
  const compact = String(raw || "").replace(/[\s()-]/g, "");
  const match = compact.match(/(?:\+?966|00966)?0?5\d{8}/);
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
const BOOKING_INTENT_RE =
  /(احجز|أحجز|احجزلي|ابي حجز|أبي حجز|ابغى حجز|أبغى حجز|بغيت حجز|جهز حجز|جهّز حجز|جهزلي حجز|حجز جديد|سوي حجز|اعمل حجز|رتب حجز|سجل حجز|سجّل حجز|سجل لي حجز|سجلي حجز)/;

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
    guests: args.guests,
    total: args.total,
    total_source: args.total_is_free ? "free" : "explicit",
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
  const m = t.match(/^[\s.)-]*(?:رقم\s*)?(١|1|الاول|الأول|٢|2|الثاني|٣|3|الثالث)[\s.!؟)-]*$/);
  let alt = null;
  if (m) {
    const idx = { "١": 0, 1: 0, الاول: 0, الأول: 0, "٢": 1, 2: 1, الثاني: 1, "٣": 2, 3: 2, الثالث: 2 }[m[1]];
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
  };
}

// Short period wording (اسم فترة أو وصفها) worth handing to the resolver.
// The bare «مساء» forms are listed explicitly: the «مسائي» stem uses ئ
// (U+0626) while «مساء» ends in the standalone hamza ء (U+0621) — without
// them a PM answer never registered and fell to the model (live bug).
function extractPeriodText(message) {
  // «فترة5» glued (no space) is how the owner actually types the digit labels
  // the app itself suggests — the glued alternative must come first.
  const m = String(message || "").match(
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
// it must always work (diacritics stripped before matching).
const CANCEL_DRAFT_RE =
  /^\s*(?:الغ|ألغ|الغي|ألغي|إلغاء|الغاء|كنسل|cancel)\s*(?:الحجز|الطلب|المسودة)?\s*[.!؟]*\s*$/;

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
// word; digits are rejected so bare numerals keep answering guests/total.
const CHALET_ANSWER_BLOCK_RE =
  /(?:^|\s)(?:حجز|احجز|سجل|فترة|ضيف|ضيوف|شخص|عدد|سعر|المبلغ|جوال|هاتف|رقم|اليوم|بكرة|غدا|تاريخ|صباح|مساء|ليل|ظهر|عصر|من|الى|حتى)(?=\s|$)/;
function contextualChaletAnswer(raw) {
  const s = String(raw || "").trim().replace(/[.!؟،,;؛:]+$/g, "").trim();
  if (!s || s.length > 60 || s.split(/\s+/).length > 5) return "";
  if (/\d/.test(foldDigits(s))) return "";
  if (!/^[\p{L}\s'’-]+$/u.test(s)) return "";
  if (isBareConfirmPhrase(s) || CANCEL_DRAFT_RE.test(s) || CHALET_ANSWER_BLOCK_RE.test(s)) return "";
  return s;
}

// And for «أي فترة تريد؟»: a short bare label («دوام») rides the resolver's
// period_text tiers («فترة 3» is already caught by extractPeriodText).
function contextualPeriodAnswer(raw) {
  const s = String(raw || "").trim().replace(/[.!؟،,;؛:]+$/g, "").trim();
  if (!s || s.length > 30 || s.split(/\s+/).length > 3) return "";
  // Digits are ALLOWED: real period labels are «فترة 5»/«الفترة 6» — the old
  // letters-only guard rejected the exact answers the bot itself suggested
  // (live IMG_6708 «فترة5»).
  if (!/^[\p{L}\p{N}\s'’-]+$/u.test(s)) return "";
  if (isBareConfirmPhrase(s) || CANCEL_DRAFT_RE.test(s)) return "";
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
  const intent = BOOKING_INTENT_RE.test(message);
  if (!row && !intent) return null;

  // The question the server asked LAST turn (server-owned dialogue state).
  const pendingQ = row && row.fields && row.fields.pending_q ? row.fields.pending_q : null;

  // Typed cancellation always works mid-draft (the guided fallback offers it).
  if (row && CANCEL_DRAFT_RE.test(String(message || "").replace(/[\u064b-\u065f\u0670]/g, ""))) {
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
    const folded = foldDigits(String(rawMessage || "")).trim();
    if (/^\d{1,3}$/.test(folded)) {
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
  const periodWord = meridiemAnswered
    ? ""
    : extractPeriodText(message) ||
      (row && pendingQ && pendingQ.kind === "period" ? contextualPeriodAnswer(rawMessage) : "");
  // A bare digit answering the PERIOD question is a label pick («٥» = «فترة
  // 5»), never a guest count — mirror the pick guard above.
  if (row && pendingQ && pendingQ.kind === "period" && periodWord) {
    const folded = foldDigits(String(rawMessage || "")).trim();
    if (/^\d{1,3}$/.test(folded)) {
      delete facts.fields.guests;
      delete facts.fields.total;
    }
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
      chaletAnswer,
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

  // The authoritative document is needed both for corrections (chalet swap)
  // and for binding/availability below — load it once per turn.
  const snap0 = typeof deps.getWorkspaceData === "function" ? await deps.getWorkspaceData(ctx.wsKey) : null;
  const doc0 = snap0 && snap0.data ? snap0.data : null;

  // ---- merge this turn's facts into the server draft ----
  let fields = mergeDraft(row ? row.fields || {} : {}, facts);
  // The stored pending question was for LAST turn; whichever branch asks
  // something this turn re-records its own via ask().
  delete fields.pending_q;
  // The chalet hint the resolver sees is a REDACTED copy of the message —
  // fields jsonb is model-visible by design and must never carry a raw phone.
  const safeMessage = redactText(rawMessage || "").slice(0, 200);
  // The chalet hint comes from a NEW booking sentence — or from the owner's
  // ANSWER to our own chalet question (live IMG_6703: «تولوم» must bind).
  if (!fields.chalet_id && (intent || !row || chaletAnswer) && safeMessage) {
    fields.chalet_text = chaletAnswer ? redactText(chaletAnswer).slice(0, 200) : safeMessage;
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
  // A chalet correction by name rebinds too (and its periods with it).
  if (fields.chalet_id && /شاليه/.test(message) && doc0) {
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
  // the weekday/weekend suggestion belongs to ONE specific date + period.
  if ((dateChanged || timeText || periodWord || pick) && fields.total_suggested) {
    if (fields.total_source === "suggested" || fields.total_source === "accepted_suggestion") {
      delete fields.total;
      delete fields.total_source;
    }
    delete fields.total_suggested;
  }

  const priv = (typeof deps.getDraftPrivate === "function" ? await deps.getDraftPrivate(ctx.wsKey, threadId) : {}) || {};
  const newPhone = (privateFacts && privateFacts.customer_phone) || (facts.private && facts.private.customer_phone) || "";
  const privMerged = newPhone ? { ...priv, customer_phone: newPhone } : priv;

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
    } else if (cres.error === "CHALET_NOT_FOUND" && chaletAnswer) {
      // The owner ANSWERED our chalet question with a name we cannot match —
      // re-ask listing the REAL registered names (never the generic fallback).
      return ask(cres.reason_ar, { pending_q: { kind: "chalet" } });
    }
    // NOT_FOUND on a generic sentence just means "chalet still unknown".
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

  // ---- missing fields: ONE question, never re-asking what is known ----
  const missing = missingFields(fields);
  if (missing.length) {
    return ask(nextQuestionAr(fields, missing), {
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
    guests: fields.guests,
    total: fields.total,
    total_is_free: fields.total_source === "free" ? true : undefined,
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
      reply_ar: "جهّزت الحجز — راجع البطاقة ثم اضغط حفظ الحجز. لن يُحفظ شيء قبل تأكيدك.",
      tool_results: [prepared],
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
