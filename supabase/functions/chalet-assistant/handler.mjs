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
import { prepareConfirmation, hashToken, hashPayload } from "../_shared/assistant/confirmation.mjs";
import { redactText, redactObject } from "../_shared/assistant/redact.mjs";

// The model gets at most TWO calls per turn (request tools -> ground the reply
// on the tool results) and may request at most this many tools per turn.
const MAX_TOOLS_PER_TURN = 5;
// The grounding (second) call returns the FINAL answer only — never planning
// text, never internal tool names, never error codes.
const SECOND_STAGE_INSTRUCTION =
  "هذه نتائج الأدوات. أعطِ الآن الإجابة النهائية فقط بالعربية الطبيعية المختصرة. " +
  "لا تذكر أسماء الأدوات الداخلية، ولا أكواد الأخطاء، ولا JSON. " +
  "لا تكرّر عبارات مثل «جاري» أو «سأجلب» بعد توفّر النتائج. " +
  "لا تدّعِ إتمام أي حفظ أو إجراء ما لم تُعِده الأداة كإجراء مكتمل.";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

  // ---- Branch B: chat turn (two-stage model loop) ----
  const message = redactText(String(body.message ?? "")).slice(0, 4000);
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

  // The model sees the REAL tool catalog (read + prepare tools only — never a
  // confirmation) so it can only ever name a tool that exists.
  const systemPrompt = CHALET_SYSTEM_PROMPT + "\n\n" + buildToolCatalogText() + "\n\n" + STRICT_JSON_INSTRUCTION;

  // Stage 1: the model may request tools.
  const first = await deps.callModel({ systemPrompt, history });
  if (!first.ok) {
    // Fail closed: no action, clear Arabic error.
    return json(200, {
      ok: false,
      assistant_unavailable: true,
      error: first.error,
      reply_ar: "تعذّر الوصول إلى المساعد الذكي حالياً. لم يتم تنفيذ أي إجراء.",
    });
  }

  // Execute the requested tools (read + prepare only; bounded per turn).
  const requested = Array.isArray(first.toolCalls) ? first.toolCalls.slice(0, MAX_TOOLS_PER_TURN) : [];
  const results = [];
  for (const call of requested) {
    const norm = normalizeToolCall(call);
    if (!norm.ok) {
      results.push({ requested: call?.name ?? null, ok: false, error: norm.error });
      continue; // unknown/invalid tool from the model is NEVER executed
    }
    if (SENSITIVE_TOOLS.has(norm.name)) {
      // The model can never run ANY sensitive action (a confirmation) — only
      // the owner via a direct invoke_tool.
      results.push({ tool: norm.name, ok: false, error: "CONFIRMATION_REQUIRES_OWNER" });
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
    const second = await deps.callModel({ systemPrompt: systemPrompt + "\n\n" + SECOND_STAGE_INSTRUCTION, history: grounded });
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
    if (r.ok === false) { anyFailure = true; continue; } // no tool name, no error code
    if (r.kind === "prepared_action") { lines.push(r.summary_ar || "جهّزت الإجراء — بانتظار تأكيدك."); continue; }
    if (r.kind === "completed_action") { lines.push(r.done_ar || "تم تنفيذ الإجراء وتأكيده من الخادم."); continue; }
    if (r.kind === "read") { const d = describeReadAr(r.result); if (d) lines.push(d); continue; }
  }
  if (!lines.length) {
    return anyFailure
      ? "تعذّر إكمال الطلب حالياً، ولم يتغيّر شيء. حاول مرة أخرى."
      : "تمام.";
  }
  return lines.join("\n").slice(0, 2000);
}

// Natural Arabic description of a read result — no tool name, no raw error code.
function describeReadAr(result) {
  const r = result && typeof result === "object" ? result : {};
  if (Array.isArray(r.bookings)) {
    const n = r.bookings.length;
    if (n === 0) return "لا توجد حجوزات مطابقة.";
    if (n === 1) return "يوجد حجز واحد.";
    if (n === 2) return "يوجد حجزان.";
    return `يوجد ${n} حجوزات.`;
  }
  if (Array.isArray(r.available)) return r.available.length ? `الفترات المتاحة: ${r.available.length}.` : "لا توجد فترات متاحة.";
  if (Array.isArray(r.empty)) return r.empty.length ? `الأيام/الفترات الفاضية: ${r.empty.length}.` : "لا توجد أيام فاضية.";
  if (Array.isArray(r.transactions)) return `عدد الحركات المالية: ${r.transactions.length}.`;
  if (Array.isArray(r.payments)) return `عدد المدفوعات: ${r.payments.length}.`;
  if (Array.isArray(r.rules)) return `عدد قواعد التسويق: ${r.rules.length}.`;
  if (typeof r.draft === "string" && r.draft) return r.draft;
  if (r.error) return "تعذّر جلب هذه المعلومة حالياً.";
  return "";
}

// Execute one normalized tool call. Returns a plain result object (raw=true) or
// a Response (raw=false). Read tools run immediately; prepare tools create a
// confirmation; confirm tools consume + execute the underlying contract.
async function executeTool(deps, { wsKey, pin, norm, activeMemories, secret, raw }) {
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
    return wrap(422, { ok: false, error: "SENSITIVE_TOOL_REQUIRES_CONFIRMATION" });
  }

  // READ tools (and draft_* / prepare_outbound draft) — no confirmation. The
  // PIN is forwarded so ledger-backed reads re-authenticate the RPC contract.
  if (spec.class === "read" && !spec.prepares) {
    const result = await deps.runReadTool(wsKey, name, args, pin);
    return wrap(200, { ok: true, kind: "read", result, warnings: policy.warnings });
  }

  // PREPARE tools — create an action + confirmation token; NO side effect yet.
  if (spec.prepares) {
    // For a NEW booking, generate its id at PREPARE time and bind it into the
    // confirmed payload. On a crash-retry the executor re-uses this exact id, so
    // a confirmed create can never produce two bookings.
    let boundArgs = args;
    if (spec.prepares === "confirm_booking_create" && !boundArgs.booking_id && typeof deps.newId === "function") {
      boundArgs = { ...args, booking_id: deps.newId() };
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
  // Only report completion when the server contract actually succeeded.
  return wrap(exec.ok ? 200 : 422, {
    ok: exec.ok,
    kind: "completed_action",
    result: exec.ok ? exec.safe_result ?? {} : undefined,
    error: exec.ok ? undefined : exec.error,
    ...(recovered ? { recovered: true } : {}),
    done_ar: exec.ok
      ? (recovered ? "تم إكمال إجراء كان متوقفاً، وتأكيده من الخادم." : "تم تنفيذ الإجراء وتأكيده من الخادم.")
      : "لم يكتمل الإجراء. لم يتغيّر شيء بدون تأكيد الخادم.",
  });
}

function buildSummaryAr(confirmTool, args) {
  switch (confirmTool) {
    case "confirm_booking_create":
      return `تجهيز حجز جديد للعميل «${args.customer_name || "—"}» بتاريخ ${args.booking_date || "—"}. اضغط تأكيد للحفظ.`;
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
