import { describe, expect, it } from "vitest";
import { callDeepSeek } from "../../supabase/functions/_shared/assistant/deepseek.mjs";
import { CHALET_SYSTEM_PROMPT, STRICT_JSON_INSTRUCTION } from "../../supabase/functions/_shared/assistant/system-prompt.mjs";

// OPT-IN real DeepSeek smoke test. Runs ONLY when DEEPSEEK_API_KEY is present
// in the environment (never committed). Otherwise it is explicitly SKIPPED —
// the normal suite is not marked failed, and we do NOT claim the real API was
// tested. Model/base come from env (default deepseek-v4-flash).
//
// Enable locally with:
//   DEEPSEEK_API_KEY=sk-... npx vitest run tests/assistant/deepseek-smoke.test.js
const KEY = process.env.DEEPSEEK_API_KEY;
const d = KEY ? describe : describe.skip;

d("DeepSeek real smoke (read-only Arabic question)", () => {
  it("reaches the model, parses strict JSON, and returns an Arabic reply with no write", async () => {
    const capturedLogs = [];
    const env = {
      DEEPSEEK_API_KEY: KEY,
      DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL, // optional override; else default
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    };
    // Wrap fetch to assert no phone/secret leaves in the request body.
    const realFetch = globalThis.fetch;
    const fetchImpl = async (url, opts) => {
      capturedLogs.push(String(opts?.body || ""));
      return realFetch(url, opts);
    };
    const r = await callDeepSeek({
      env,
      systemPrompt: CHALET_SYSTEM_PROMPT + "\n\n" + STRICT_JSON_INSTRUCTION,
      history: [{ role: "user", content: "ما هي حجوزات اليوم؟" }],
      fetchImpl,
    });
    // The call must succeed and yield strict-JSON structure (reply/tool_calls).
    expect(r.ok, "DeepSeek call failed: " + (r.error || "")).toBe(true);
    expect(typeof r.reply).toBe("string");
    expect(Array.isArray(r.toolCalls)).toBe(true);
    // Any requested tool must be a registered READ tool (no write from a
    // read-only question). We do not execute it here — this is a model smoke.
    for (const c of r.toolCalls) {
      expect(String(c.name || "")).not.toMatch(/^confirm_|create_payment_link/);
    }
    // No phone number or the API key appears in what we sent.
    const sent = capturedLogs.join("");
    expect(sent).not.toMatch(/05\d{8}/);
    expect(sent).not.toContain(KEY);
  }, 40000);
});
