import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The DeepSeek key, WhatsApp Cloud token, and confirm secret must never appear
// in committed AI sources or in index.html. Env-var NAMES are fine; assigned
// literal VALUES are not.
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

  it("the browser never calls DeepSeek directly (no api.deepseek.com in index.html)", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).not.toContain("api.deepseek.com");
    expect(html).not.toContain("DEEPSEEK_API_KEY");
  });

  it("env var names are referenced (server-side) but only as names", () => {
    const client = readFileSync("supabase/functions/_shared/assistant/deepseek.mjs", "utf8");
    expect(NAME_ONLY_OK.test(client)).toBe(true);
  });
});
