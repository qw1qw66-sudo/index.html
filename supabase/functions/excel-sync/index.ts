// Supabase Edge Function: excel-sync (FOUNDATION / not auto-deployed)
//
// Purpose: receive a minimal trigger from the web app, authenticate it using the
// workspace key + PIN (the SAME credentials the app already uses for the public
// get_shared_workspace RPC), fetch the current workspace from Supabase, and
// forward it to a server-side webhook (Power Automate) that runs an Office Script
// to update the OneDrive Excel workbook. The real write secret lives ONLY in this
// function's environment (POWER_AUTOMATE_EXCEL_WEBHOOK_URL) — never in the frontend.
//
// Security:
// - No secret is returned to the caller.
// - The webhook URL is read from an env var; it is never logged or returned.
// - The caller is validated by attempting the workspace read with their creds;
//   wrong key/PIN => the RPC fails => we return ok:false without calling the webhook.
//
// Deploy (the user runs these; we DO NOT deploy automatically):
//   supabase functions deploy excel-sync
//   supabase secrets set POWER_AUTOMATE_EXCEL_WEBHOOK_URL="https://...logic.azure.com/..."
//   # SUPABASE_URL and SUPABASE_ANON_KEY are injected by the platform automatically.
//
// The deployed URL (e.g. https://<project>.supabase.co/functions/v1/excel-sync) is
// NOT a secret; paste it into the app's "رابط خدمة المزامنة" field.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const WEBHOOK_URL = Deno.env.get("POWER_AUTOMATE_EXCEL_WEBHOOK_URL") ?? "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  if (!WEBHOOK_URL) {
    // Sync target not wired up yet. Report safely; do not crash.
    return json({ ok: false, error: "sync_target_not_configured" }, 503);
  }

  let payload: { p_workspace_key?: string; p_access_pin?: string };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const key = String(payload?.p_workspace_key ?? "").trim();
  const pin = String(payload?.p_access_pin ?? "").trim();
  if (!key || !pin) return json({ ok: false, error: "missing_credentials" }, 400);

  // 1) Authenticate + fetch the current workspace from Supabase (cloud is the
  //    source of truth for the export, matching the GitHub Action exporter).
  let workspace: unknown;
  try {
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_shared_workspace`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_workspace_key: key, p_access_pin: pin }),
    });
    const body = await rpc.json().catch(() => null);
    if (!rpc.ok || !body || body.ok !== true) {
      return json({ ok: false, error: "auth_or_fetch_failed" }, 401);
    }
    workspace = body.data ?? body;
  } catch (_) {
    return json({ ok: false, error: "supabase_unreachable" }, 502);
  }

  // 2) Forward the current workspace to the Power Automate webhook, which runs the
  //    Office Script that rebuilds the booking slots in the OneDrive workbook.
  //    Mapping rules (chalets شاليه تولوم / شاليه سكاي, first 4 active periods,
  //    confirmed-only, 2026) live in the Office Script — see docs/LIVE_EXCEL_SYNC.md.
  try {
    const hook = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "excel-sync", workspace }),
    });
    if (!hook.ok) return json({ ok: false, error: "sync_failed" }, 502);
  } catch (_) {
    return json({ ok: false, error: "sync_unreachable" }, 502);
  }

  return json({ ok: true });
});
