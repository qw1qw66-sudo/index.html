// deepseek.mjs — server-side DeepSeek client. The browser NEVER calls DeepSeek
// directly; only this module (running inside the Edge Function) does, using
// server-side secrets. It fails CLOSED, redacts customer data before the call,
// enforces size/timeout limits, and validates the model output as strict JSON
// (no action ever results from invalid output).
//
// Model note (verified 2026-07-11 against DeepSeek docs): deepseek-chat /
// deepseek-reasoner are DEPRECATED 2026-07-24; current models are
// deepseek-v4-flash / deepseek-v4-pro; base_url https://api.deepseek.com;
// OpenAI-compatible chat completions. Model + base URL are env-configurable so
// this does not hardcode an obsolete name; default is deepseek-v4-flash.

import { redactText } from "./redact.mjs";

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const MAX_RESPONSE_BYTES = 200 * 1024;
const REQUEST_TIMEOUT_MS = 20000;

export function deepseekConfig(env) {
  const apiKey = env?.DEEPSEEK_API_KEY;
  const model = env?.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const baseUrl = (env?.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!apiKey) return { ok: false, error: "DEEPSEEK_KEY_MISSING" };
  if (!model) return { ok: false, error: "DEEPSEEK_MODEL_MISSING" }; // no silent substitution
  return { ok: true, apiKey, model, baseUrl };
}

// Clamp + redact history before it leaves the server.
export function sanitizeHistory(messages) {
  const trimmed = (messages || []).slice(-MAX_HISTORY_MESSAGES);
  return trimmed.map((m) => ({
    role: ["user", "assistant", "system", "tool"].includes(m.role) ? m.role : "user",
    content: redactText(String(m.content ?? "")).slice(0, MAX_MESSAGE_CHARS),
  }));
}

// Extract a strict-JSON object from the model text. Invalid -> null (no action).
export function parseStrictJson(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  // tolerate a ```json fence
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Call DeepSeek chat completions. `fetchImpl` is injectable for tests (default
 * global fetch). Returns { ok, reply, toolCalls, usage } or { ok:false, error }.
 * NEVER throws to the caller; NEVER includes the API key in the result.
 */
export async function callDeepSeek({ env, systemPrompt, history, fetchImpl }) {
  const cfg = deepseekConfig(env);
  if (!cfg.ok) return cfg; // fail closed

  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) return { ok: false, error: "NO_FETCH" };

  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: systemPrompt }, ...sanitizeHistory(history)],
    temperature: 0.4,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    stream: false,
  };

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  let res;
  try {
    res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: e && e.name === "AbortError" ? "DEEPSEEK_TIMEOUT" : "DEEPSEEK_UNREACHABLE" };
  }
  if (timer) clearTimeout(timer);

  if (!res.ok) {
    // Never surface provider body (may echo the request); sanitized code only.
    return { ok: false, error: "DEEPSEEK_HTTP_" + res.status };
  }

  let text;
  try {
    text = await res.text();
  } catch {
    return { ok: false, error: "DEEPSEEK_READ_FAILED" };
  }
  if (text.length > MAX_RESPONSE_BYTES) return { ok: false, error: "DEEPSEEK_RESPONSE_TOO_LARGE" };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: "DEEPSEEK_BAD_JSON" };
  }
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseStrictJson(content);
  if (!parsed) return { ok: false, error: "MODEL_OUTPUT_INVALID" };

  const usage = payload?.usage || {};
  return {
    ok: true,
    reply: typeof parsed.reply === "string" ? parsed.reply : "",
    toolCalls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
    // Optional structured extraction of booking WORDING (never ids) — the
    // deterministic planner merges it into the server-side draft.
    bookingFields:
      parsed.booking_fields && typeof parsed.booking_fields === "object" && !Array.isArray(parsed.booking_fields)
        ? parsed.booking_fields
        : null,
    usage: { prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null },
    model: cfg.model,
  };
}
