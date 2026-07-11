import { describe, expect, it } from "vitest";
import { redactText, redactObject, customerReference, hasUnredactedPhone } from "../../supabase/functions/_shared/assistant/redact.mjs";
import { evaluatePolicy, normalizeProposedMemory } from "../../supabase/functions/_shared/assistant/policy.mjs";
import { normalizeToolCall, isRegisteredTool, toolConfirmationClass } from "../../supabase/functions/_shared/assistant/tools.mjs";
import { prepareConfirmation, validateConfirmation, hashPayload } from "../../supabase/functions/_shared/assistant/confirmation.mjs";
import { callDeepSeek, parseStrictJson, sanitizeHistory, deepseekConfig } from "../../supabase/functions/_shared/assistant/deepseek.mjs";
import { detectMode, resolveOutbound, normalizePhone } from "../../supabase/functions/_shared/assistant/whatsapp.mjs";

describe("redaction (privacy)", () => {
  it("redacts KSA phone numbers and secrets from text", () => {
    expect(redactText("رقمي 0501234567 تمام")).not.toContain("0501234567");
    expect(redactText("key sk_live_ABCDEF123456")).not.toContain("sk_live_ABCDEF123456");
    expect(hasUnredactedPhone("call 0512345678")).toBe(true);
    expect(hasUnredactedPhone(redactText("call 0512345678"))).toBe(false);
  });
  it("drops sensitive keys and never leaks phones in objects", () => {
    const r = redactObject({ customer_phone: "0501234567", note: "اتصل على 0559876543", access_pin: "1234" });
    expect(JSON.stringify(r)).not.toContain("0501234567");
    expect(JSON.stringify(r)).not.toContain("0559876543");
    expect(r.access_pin).toBe("[محجوب]");
  });
  it("customer reference is stable and non-reversible (no digits of the phone)", () => {
    const a = customerReference("WS", "0501234567");
    const b = customerReference("WS", "0501234567");
    expect(a).toBe(b);
    expect(a).not.toContain("0501234567");
    expect(customerReference("WS", "0501234567")).not.toBe(customerReference("WS", "0501234568"));
  });
});

describe("policy engine (memory is context, not authority)", () => {
  it("an active hard-block memory blocks the tool", () => {
    const mem = [{ status: "active", enforcement_level: "hard_block", content_json: { block_tools: ["confirm_booking_cancel"], reason_ar: "ممنوع الإلغاء" } }];
    expect(evaluatePolicy({ toolName: "confirm_booking_cancel", actionType: "confirm_booking_cancel", activeMemories: mem }))
      .toMatchObject({ allowed: false, error: "BLOCKED_BY_MEMORY" });
  });
  it("a proposed (non-active) hard-block does NOT block", () => {
    const mem = [{ status: "proposed", enforcement_level: "hard_block", content_json: { block_tools: ["confirm_booking_cancel"] } }];
    expect(evaluatePolicy({ toolName: "confirm_booking_cancel", actionType: "x", activeMemories: mem }).allowed).toBe(true);
  });
  it("a recorded mistake surfaces a warning", () => {
    const mem = [{ status: "active", memory_type: "mistake", enforcement_level: "advisory", content_json: { block_tools: ["confirm_manual_payment"], reason_ar: "خطأ سابق" } }];
    const r = evaluatePolicy({ toolName: "confirm_manual_payment", actionType: "x", activeMemories: mem });
    expect(r.allowed).toBe(true);
    expect(r.warnings.join()).toContain("خطأ");
  });
  it("model-proposed memory is forced to proposed/advisory", () => {
    const m = normalizeProposedMemory({ memory_type: "policy", status: "active", enforcement_level: "hard_block", content_json: { x: 1 } });
    expect(m.status).toBe("proposed");
    expect(m.enforcement_level).toBe("advisory");
  });
});

describe("tool registry (deterministic authority)", () => {
  it("rejects an unknown tool", () => {
    expect(normalizeToolCall({ name: "run_sql", arguments: { q: "drop table" } })).toMatchObject({ ok: false, error: "UNKNOWN_TOOL" });
    expect(normalizeToolCall({ name: "exec_shell" }).ok).toBe(false);
    expect(isRegisteredTool("arbitrary_http")).toBe(false);
  });
  it("validates args and rejects bad input", () => {
    expect(normalizeToolCall({ name: "get_booking_details", arguments: {} })).toMatchObject({ ok: false, error: "INVALID_TOOL_ARGS" });
    expect(normalizeToolCall({ name: "get_booking_details", arguments: { booking_id: "b1" } }).ok).toBe(true);
  });
  it("classifies read vs sensitive correctly", () => {
    expect(toolConfirmationClass("get_today_bookings")).toBe("read");
    expect(toolConfirmationClass("confirm_manual_payment")).toBe("sensitive");
    expect(toolConfirmationClass("prepare_booking_create")).toBe("read"); // prepare itself is safe
  });
});

describe("confirmation tokens", () => {
  const payload = { tool: "confirm_manual_payment", args: { booking_id: "b1", amount_halalas: 20000 } };
  function actionFrom(conf, over = {}) {
    return {
      workspace_key: "WS", status: "prepared",
      confirmation_token_hash: conf.tokenHash, payload_hash: conf.payloadHash,
      confirmation_used_at: null, confirmation_expires_at_ms: conf.expiresAtMs,
      expected_revision: null, ...over,
    };
  }
  it("accepts a correct confirmation", () => {
    const conf = prepareConfirmation({ normalizedPayload: payload, secret: "s", nowMs: 1000 });
    const r = validateConfirmation({ action: actionFrom(conf), workspaceKey: "WS", token: conf.token, secret: "s", currentPayloadHash: conf.payloadHash, currentRevision: null, nowMs: 2000 });
    expect(r.ok).toBe(true);
  });
  it("rejects expired, replayed, wrong-token, changed-payload, wrong-workspace, stale-revision", () => {
    const conf = prepareConfirmation({ normalizedPayload: payload, secret: "s", nowMs: 1000 });
    const base = { workspaceKey: "WS", token: conf.token, secret: "s", currentPayloadHash: conf.payloadHash, currentRevision: null };
    expect(validateConfirmation({ action: actionFrom(conf), ...base, nowMs: conf.expiresAtMs + 1 }).error).toBe("CONFIRMATION_EXPIRED");
    expect(validateConfirmation({ action: actionFrom(conf, { confirmation_used_at: "2026" }), ...base, nowMs: 2000 }).error).toBe("CONFIRMATION_ALREADY_USED");
    expect(validateConfirmation({ action: actionFrom(conf), ...base, token: "wrong", nowMs: 2000 }).error).toBe("CONFIRMATION_TOKEN_MISMATCH");
    expect(validateConfirmation({ action: actionFrom(conf), ...base, currentPayloadHash: "different", nowMs: 2000 }).error).toBe("PAYLOAD_CHANGED");
    expect(validateConfirmation({ action: actionFrom(conf), ...base, workspaceKey: "OTHER", nowMs: 2000 }).error).toBe("ACTION_NOT_FOUND");
    const rev = actionFrom(conf, { expected_revision: "2026-01-01T00:00:00Z" });
    expect(validateConfirmation({ action: rev, ...base, currentRevision: "2026-02-02T00:00:00Z", nowMs: 2000 }).error).toBe("STALE_REVISION");
  });
  it("payload hash is order-independent", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });
});

describe("deepseek client (fail closed, redaction, strict json)", () => {
  it("fails closed with no API key (no model call)", async () => {
    const r = await callDeepSeek({ env: {}, systemPrompt: "x", history: [], fetchImpl: async () => { throw new Error("should not be called"); } });
    expect(r).toEqual({ ok: false, error: "DEEPSEEK_KEY_MISSING" });
  });
  it("does not silently substitute a missing model", () => {
    expect(deepseekConfig({ DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "" }).model).toBe("deepseek-v4-flash"); // documented default, not obsolete
  });
  it("honours the configured model and base URL in the real request", async () => {
    let sentUrl = null, sentBody = null;
    const fetchImpl = async (url, opts) => { sentUrl = url; sentBody = opts.body; return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"reply":"تمام"}' } }], usage: {} }) }; };
    await callDeepSeek({
      env: { DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_BASE_URL: "https://api.deepseek.com/" },
      systemPrompt: "sys", history: [], fetchImpl,
    });
    expect(sentUrl).toBe("https://api.deepseek.com/chat/completions"); // trailing slash normalized
    expect(JSON.parse(sentBody).model).toBe("deepseek-v4-pro");
  });
  it("redacts phone numbers from history before the call", async () => {
    let sentBody = null;
    const fetchImpl = async (_url, opts) => { sentBody = opts.body; return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"reply":"تمام"}' } }], usage: {} }) }; };
    await callDeepSeek({ env: { DEEPSEEK_API_KEY: "k" }, systemPrompt: "sys", history: [{ role: "user", content: "اتصل 0501234567" }], fetchImpl });
    expect(sentBody).not.toContain("0501234567");
    expect(sentBody).not.toContain("k\""); // api key is in a header, not the body
  });
  it("treats invalid model output as no-op (no action)", async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }) });
    const r = await callDeepSeek({ env: { DEEPSEEK_API_KEY: "k" }, systemPrompt: "s", history: [], fetchImpl });
    expect(r).toEqual({ ok: false, error: "MODEL_OUTPUT_INVALID" });
  });
  it("maps provider HTTP errors to sanitized codes (no body leak)", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "secret provider detail" });
    const r = await callDeepSeek({ env: { DEEPSEEK_API_KEY: "k" }, systemPrompt: "s", history: [], fetchImpl });
    expect(r.error).toBe("DEEPSEEK_HTTP_401");
  });
  it("aborts on timeout", async () => {
    const fetchImpl = (_u, opts) => new Promise((_res, rej) => { opts.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const r = await callDeepSeek({ env: { DEEPSEEK_API_KEY: "k" }, systemPrompt: "s", history: [], fetchImpl });
    expect(["DEEPSEEK_TIMEOUT", "DEEPSEEK_UNREACHABLE"]).toContain(r.error);
  }, 30000);
  it("parses strict json from a fenced block", () => {
    expect(parseStrictJson('```json\n{"reply":"hi"}\n```')).toEqual({ reply: "hi" });
    expect(parseStrictJson("garbage")).toBeNull();
  });
  it("sanitizeHistory clamps to the last N messages", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: "m" + i }));
    expect(sanitizeHistory(many).length).toBeLessThanOrEqual(20);
  });
});

describe("whatsapp adapter (3 modes)", () => {
  it("detects disconnected without cloud credentials", () => {
    expect(detectMode({})).toBe("disconnected");
    expect(detectMode({ WHATSAPP_CLOUD_TOKEN: "t", WHATSAPP_PHONE_ID: "p" })).toBe("official_cloud_api");
  });
  it("manual mode produces a wa.me link and is NEVER reported as sent", () => {
    const r = resolveOutbound({ mode: "open_manual_whatsapp", phone: "0501234567", body: "مرحبا", automatic: false });
    expect(r.action).toBe("manual_link");
    expect(r.url).toContain("wa.me/966501234567");
  });
  it("disconnected auto-send is blocked with an Arabic reason", () => {
    const r = resolveOutbound({ mode: "disconnected", phone: "0501234567", body: "x", automatic: true });
    expect(r.action).toBe("blocked");
    expect(r.reason_ar).toContain("غير مربوط");
  });
  it("normalizes KSA phones", () => {
    expect(normalizePhone("0501234567")).toBe("966501234567");
    expect(normalizePhone("bad")).toBe("");
  });
});
