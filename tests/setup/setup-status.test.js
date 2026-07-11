import { describe, expect, it } from "vitest";
import { handleSetupStatus } from "../../supabase/functions/chalet-setup-status/handler.mjs";

// The setup-status endpoint must gate on workspace auth and return ONLY
// booleans (+ a sanitized app_env label) — never a secret, its length, or a
// fingerprint.

const AUTH_OK = async (k, pin) => (k === "WS" && pin === "123456" ? { ok: true, workspace_key: "WS" } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" });

function req(body) {
  return new Request("https://edge.local/chalet-setup-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const FAKE_KEY = "sk-deadbeefdeadbeefdeadbeefdeadbeef1234";
const FAKE_CONFIRM = "super-secret-confirm-value-9f8e7d6c5b4a";

describe("chalet-setup-status", () => {
  it("requires a valid workspace PIN (401 otherwise)", async () => {
    const res = await handleSetupStatus(req({ workspace_key: "WS", access_pin: "wrong" }), { env: {}, auth: AUTH_OK });
    expect(res.status).toBe(401);
  });

  it("returns booleans only + a safe app_env label", async () => {
    const env = { DEEPSEEK_API_KEY: FAKE_KEY, ASSISTANT_CONFIRM_SECRET: FAKE_CONFIRM, APP_ENV: "staging" };
    const res = await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env, auth: AUTH_OK });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toEqual({
      ok: true,
      assistant_function_deployed: true,
      deepseek_configured: true,
      assistant_confirm_secret_configured: true,
      autopilot_secret_configured: false,
      whatsapp_configured: false,
      app_env: "staging",
    });
    // Every configuration field is a strict boolean.
    for (const k of ["deepseek_configured", "assistant_confirm_secret_configured", "autopilot_secret_configured", "whatsapp_configured", "assistant_function_deployed"]) {
      expect(typeof b[k]).toBe("boolean");
    }
  });

  it("NEVER exposes a secret value, its length, or a fingerprint", async () => {
    const env = { DEEPSEEK_API_KEY: FAKE_KEY, ASSISTANT_CONFIRM_SECRET: FAKE_CONFIRM, AUTOPILOT_CRON_SECRET: "auto-xyz", WHATSAPP_CLOUD_TOKEN: "wa-tok-abc", WHATSAPP_PHONE_ID: "123456789", APP_ENV: "production" };
    const res = await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env, auth: AUTH_OK });
    const text = await res.text();
    // No secret value or any distinctive substring of one leaks.
    for (const secret of [FAKE_KEY, FAKE_CONFIRM, "auto-xyz", "wa-tok-abc", FAKE_KEY.slice(0, 8), FAKE_CONFIRM.slice(0, 8)]) {
      expect(text).not.toContain(secret);
    }
    // No length is disclosed for any secret.
    for (const n of [FAKE_KEY.length, FAKE_CONFIRM.length, 8, 9]) {
      expect(text).not.toContain(`"length":${n}`);
      expect(text).not.toContain(`_len`);
    }
    const b = JSON.parse(text);
    // Response keys are exactly the allowed set — nothing extra could carry a value.
    expect(Object.keys(b).sort()).toEqual([
      "app_env", "assistant_confirm_secret_configured", "assistant_function_deployed",
      "autopilot_secret_configured", "deepseek_configured", "ok", "whatsapp_configured",
    ]);
  });

  it("whatsapp_configured requires BOTH token and phone id", async () => {
    const only = await (await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env: { WHATSAPP_CLOUD_TOKEN: "t" }, auth: AUTH_OK })).json();
    expect(only.whatsapp_configured).toBe(false);
    const both = await (await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env: { WHATSAPP_CLOUD_TOKEN: "t", WHATSAPP_PHONE_ID: "p" }, auth: AUTH_OK })).json();
    expect(both.whatsapp_configured).toBe(true);
  });

  it("app_env is sanitized to a known allowlist (unknown otherwise)", async () => {
    const weird = await (await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env: { APP_ENV: "s3cr3t-leak-attempt" }, auth: AUTH_OK })).json();
    expect(weird.app_env).toBe("unknown");
    const staging = await (await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env: { APP_ENV: "STAGING" }, auth: AUTH_OK })).json();
    expect(staging.app_env).toBe("staging");
  });

  it("empty-string secrets read as not configured (no false positive)", async () => {
    const b = await (await handleSetupStatus(req({ workspace_key: "WS", access_pin: "123456" }), { env: { DEEPSEEK_API_KEY: "   " }, auth: AUTH_OK })).json();
    expect(b.deepseek_configured).toBe(false);
  });
});
