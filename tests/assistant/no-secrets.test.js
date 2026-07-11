import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The DeepSeek key, WhatsApp Cloud token, and confirm secret must never appear
// in committed AI sources or in index.html. Env-var NAMES are fine (incl. the
// mobile setup page's copy-paste key template); assigned literal VALUES are not,
// and the browser must never call the DeepSeek API directly.
const NAME_ONLY_OK = /(DEEPSEEK_API_KEY|WHATSAPP_CLOUD_TOKEN|ASSISTANT_CONFIRM_SECRET|WHATSAPP_PHONE_ID)/;
const ASSIGNED_SECRET = /(DEEPSEEK_API_KEY|WHATSAPP_CLOUD_TOKEN|ASSISTANT_CONFIRM_SECRET)\s*[=:]\s*["'][A-Za-z0-9+/_-]{12,}["']/;
const KEYISH = /\b(sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{12,})\b/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("AI feature: no secrets committed", () => {
  const files = [
    ...walk("supabase/functions/_shared/assistant"),
    ...walk("supabase/functions/chalet-assistant"),
    ...walk("supabase/functions/chalet-autopilot"),
    "index.html",
    "database/migrations/0003_chalet_assistant.sql",
  ];

  it("no assigned secret value in any AI source or index.html", () => {
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect(ASSIGNED_SECRET.test(t), `${f} assigns a secret value`).toBe(false);
      expect(KEYISH.test(t), `${f} contains an API-key-shaped value`).toBe(false);
    }
  });

  it("the browser never calls DeepSeek directly (no client-side DeepSeek request)", () => {
    const html = readFileSync("index.html", "utf8");
    // No client-side fetch/XHR to DeepSeek, and no DeepSeek completions endpoint.
    expect(html).not.toMatch(/fetch\s*\([^)]*deepseek/i);
    expect(html).not.toMatch(/https?:\/\/[^"'`) ]*deepseek[^"'`) ]*\/(chat|completions|v\d)/i);
    // No DeepSeek Authorization header is ever built in the browser.
    expect(html).not.toMatch(/Bearer[^"'`\n]*DEEPSEEK/i);
    // The DeepSeek key NAME / base URL may appear ONLY inside the setup copy
    // template (names to paste into Supabase) — never assigned a value (the
    // assigned-secret test above enforces that).
    const occurrences = html.split("api.deepseek.com").length - 1;
    if (occurrences > 0) {
      const start = html.indexOf("JS: mobile setup");
      const end = html.indexOf("function normalizeWorkspaceKey", start);
      const setupJs = html.slice(start, end);
      expect(setupJs.split("api.deepseek.com").length - 1, "api.deepseek.com only in the setup template").toBe(occurrences);
    }
  });

  it("env var names are referenced (server-side) but only as names", () => {
    const client = readFileSync("supabase/functions/_shared/assistant/deepseek.mjs", "utf8");
    expect(NAME_ONLY_OK.test(client)).toBe(true);
  });
});
