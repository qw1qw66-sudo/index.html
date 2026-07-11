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
import { normalizeToolCall, TOOL_REGISTRY } from "../_shared/assistant/tools.mjs";
import { prepareConfirmation, hashToken, hashPayload } from "../_shared/assistant/confirmation.mjs";
import { redactText } from "../_shared/assistant/redact.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIRM_TOOLS = new Set(
  Object.keys(TOOL_REGISTRY).filter((n) => TOOL_REGISTRY[n].class === "sensitive"),
);

export async function handleAssistant(req, deps) {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "INVALID_JSON" }); }

  const auth = await deps.auth(String(body.workspace_key ?? ""), String(body.access_pin ?? ""));
  if (!auth || !auth.ok) return json(401, { ok: false, error: auth?.error_code ?? "AUTH_FAILED" });
  const wsKey = String(auth.workspace_key);
  const threadId = body.thread_id ? String(body.thread_id) : null;

  const activeMemories = (await deps.activeMemories(wsKey)) || [];
  const secret = deps.env.ASSISTANT_CONFIRM_SECRET || deps.env.PAYMENT_WEBHOOK_SECRET || "";

  // ---- Branch A: direct tool invocation (frontend confirm buttons / suggested commands) ----
  if (body.invoke_tool) {
    const norm = normalizeToolCall(body.invoke_tool);
    if (!norm.ok) return json(422, { ok: false, error: norm.error, detail: norm.detail });
    return await executeTool(deps, { wsKey, norm, activeMemories, secret });
  }

  // ---- Branch B: chat turn (calls the model) ----
  const message = redactText(String(body.message ?? "")).slice(0, 4000);
  if (!message) return json(400, { ok: false, error: "EMPTY_MESSAGE" });

  const history = (await deps.loadHistory?.(wsKey, threadId)) || [];
  history.push({ role: "user", content: message });

  const model = await deps.callModel({
    systemPrompt: CHALET_SYSTEM_PROMPT + "\n\n" + STRICT_JSON_INSTRUCTION,
    history,
  });
  if (!model.ok) {
    // Fail closed: no action, clear Arabic error.
    return json(200, {
      ok: false,
      assistant_unavailable: true,
      error: model.error,
      reply_ar: "تعذّر الوصول إلى المساعد الذكي حالياً. لم يتم تنفيذ أي إجراء.",
    });
  }

  const results = [];
  for (const call of model.toolCalls) {
    const norm = normalizeToolCall(call);
    if (!norm.ok) {
      results.push({ requested: call?.name ?? null, ok: false, error: norm.error });
      continue; // unknown/invalid tool from the model is NEVER executed
    }
    if (CONFIRM_TOOLS.has(norm.name)) {
      // The model can never self-confirm a sensitive action.
      results.push({ tool: norm.name, ok: false, error: "CONFIRMATION_REQUIRES_OWNER" });
      continue;
    }
    const r = await executeTool(deps, { wsKey, norm, activeMemories, secret, raw: true });
    results.push(r);
  }

  await deps.appendMessages?.(wsKey, threadId, [
    { role: "user", safe_content: message },
    { role: "assistant", safe_content: redactText(model.reply || ""), tool_name: null },
  ]);

  return json(200, {
    ok: true,
    reply_ar: model.reply || "",
    tool_results: results,
    usage: model.usage,
    model: model.model,
  });
}

// Execute one normalized tool call. Returns a plain result object (raw=true) or
// a Response (raw=false). Read tools run immediately; prepare tools create a
// confirmation; confirm tools consume + execute the underlying contract.
async function executeTool(deps, { wsKey, norm, activeMemories, secret, raw }) {
  const { name, args, spec } = norm;
  const wrap = (status, obj) => (raw ? { tool: name, ...obj } : json(status, { ok: obj.ok !== false, tool: name, ...obj }));

  // Policy / memory hard-block check for anything that acts.
  const actionType = spec.prepares || name;
  const policy = evaluatePolicy({ toolName: name, actionType, activeMemories });
  if (!policy.allowed) return wrap(403, { ok: false, error: policy.error, reason_ar: policy.reason_ar });

  // READ tools (and draft_* / prepare_outbound draft) — no confirmation.
  if (spec.class === "read" && !spec.prepares) {
    const result = await deps.runReadTool(wsKey, name, args);
    return wrap(200, { ok: true, kind: "read", result, warnings: policy.warnings });
  }

  // PREPARE tools — create an action + confirmation token; NO side effect yet.
  if (spec.prepares) {
    const normalizedPayload = { tool: spec.prepares, args };
    const expectedRevision = spec.usesContract === "save_shared_workspace_v2"
      ? await deps.getWorkspaceRevision(wsKey)
      : null;
    const conf = prepareConfirmation({ normalizedPayload, secret, nowMs: deps.nowMs });
    const { action_id } = await deps.prepareSensitive(wsKey, {
      name: spec.prepares,
      args,
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
      summary_ar: buildSummaryAr(spec.prepares, args),
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
    if (!consumed.ok) return wrap(409, { ok: false, error: consumed.error });

    await deps.finalizeAction(wsKey, actionId, { status: "running" });
    let exec;
    try {
      exec = await deps.executeConfirmed(wsKey, {
        tool_name: ctx.tool_name,
        action_type: ctx.action_type,
        payload: ctx.normalized_payload,
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
      done_ar: exec.ok ? "تم تنفيذ الإجراء وتأكيده من الخادم." : "لم يكتمل الإجراء. لم يتغيّر شيء بدون تأكيد الخادم.",
    });
  }

  return wrap(422, { ok: false, error: "UNHANDLED_TOOL" });
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
    case "confirm_outbound_message":
      return `تجهيز رسالة للعميل. اضغط تأكيد للإرسال/الجدولة.`;
    default:
      return "إجراء مُجهّز — اضغط تأكيد للمتابعة.";
  }
}
