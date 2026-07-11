// chalet-setup-status — pure request handler (runtime-tested in Node/vitest).
//
// Returns ONLY booleans (plus a safe app_env label) describing which server
// secrets are configured, so the mobile setup page can show "مربوط / غير مربوط"
// without ever handling a secret. It is protected by the existing workspace
// authentication (PIN).
//
// HARD RULES (enforced + tested):
//   - never return a secret, part of a secret, its length, or a hash/fingerprint;
//   - never return service-role credentials or any raw env value except the
//     app_env label (which is a non-secret deployment tier, sanitized to an
//     allowlist);
//   - require a valid workspace PIN before returning anything.

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Presence only — never the value, never its length.
function present(env, key) {
  const v = env ? env[key] : undefined;
  return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
}

// app_env is a deployment tier label, not a secret. Sanitize to a fixed
// allowlist so an unexpected value can never echo arbitrary env content.
function safeAppEnv(env) {
  const raw = String((env && env.APP_ENV) || "").toLowerCase();
  return ["staging", "production", "test", "development"].includes(raw) ? raw : "unknown";
}

export async function handleSetupStatus(req, deps) {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "INVALID_JSON" }); }

  // Gate on the existing workspace auth — no status without a valid PIN.
  const auth = await deps.auth(String(body.workspace_key ?? ""), String(body.access_pin ?? ""));
  if (!auth || !auth.ok) return json(401, { ok: false, error: auth?.error_code ?? "AUTH_FAILED" });

  const env = deps.env || {};
  // The function is responding, so its server functions are deployed.
  return json(200, {
    ok: true,
    assistant_function_deployed: true,
    deepseek_configured: present(env, "DEEPSEEK_API_KEY"),
    assistant_confirm_secret_configured: present(env, "ASSISTANT_CONFIRM_SECRET"),
    autopilot_secret_configured: present(env, "AUTOPILOT_CRON_SECRET"),
    whatsapp_configured: present(env, "WHATSAPP_CLOUD_TOKEN") && present(env, "WHATSAPP_PHONE_ID"),
    app_env: safeAppEnv(env),
  });
}
