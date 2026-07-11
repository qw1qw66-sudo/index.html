// staging-smoke.mjs — real HTTP smoke tests against the DEPLOYED staging
// Edge Functions (actual Deno.serve wrappers, actual DeepSeek, actual staging
// Postgres). Run by .github/workflows/deploy-supabase-staging.yml.
//
// Env: SUPABASE_URL (https://<staging-ref>.supabase.co), SUPABASE_ANON_KEY.
//
// SANITIZED OUTPUT ONLY: this script never prints a response body, PIN,
// key, token, or phone — just step names, booleans, and safe error codes.
// The synthetic workspace uses fake data only (no production customer data).

const BASE = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const ANON = String(process.env.SUPABASE_ANON_KEY || "");
const ORIGIN = "https://qw1qw66-sudo.github.io"; // allowlisted app origin
if (!BASE || !ANON) {
  console.error("SMOKE_CONFIG_MISSING: SUPABASE_URL / SUPABASE_ANON_KEY");
  process.exit(1);
}

const WS_KEY = "SMK" + Date.now().toString(36).toUpperCase();
const PIN = String(Math.floor(10_000_000 + Math.random() * 89_999_999)); // 8 digits, synthetic
const RIYADH_TODAY = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const RIYADH_TOMORROW = new Date(Date.now() + 27 * 3600 * 1000).toISOString().slice(0, 10);
const FAKE_PHONE = "0500000000";

const steps = [];
function record(name, ok, code) {
  steps.push({ name, ok, ...(code ? { code: String(code).slice(0, 80) } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${code ? `  (${code})` : ""}`);
}

async function http(method, path, { body, headers = {}, origin = ORIGIN, timeoutMs = 45000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        apikey: ANON,
        authorization: "Bearer " + ANON,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, headers: res.headers, text, json };
  } finally {
    clearTimeout(t);
  }
}

// The response must never carry these (checked on RAW text, never printed).
function leaks(text) {
  if (text.includes(PIN)) return "PIN";
  if (text.includes(ANON)) return "ANON_KEY";
  if (text.includes(FAKE_PHONE)) return "PHONE";
  if (/sk-[A-Za-z0-9]{16,}/.test(text)) return "API_KEY_SHAPE";
  if (/service_?role/i.test(text)) return "SERVICE_ROLE";
  return null;
}

const assistant = (body) => http("POST", "/functions/v1/chalet-assistant", { body: { workspace_key: WS_KEY, access_pin: PIN, ...body } });

async function main() {
  // 1-3. CORS preflights prove the real Deno.serve wrappers are executing.
  {
    const r = await http("OPTIONS", "/functions/v1/chalet-assistant", {});
    record("cors_assistant_preflight_allowed", r.status === 204 && r.headers.get("access-control-allow-origin") === ORIGIN, r.status);
    const evil = await http("OPTIONS", "/functions/v1/chalet-assistant", { origin: "https://evil.example.net" });
    record("cors_assistant_preflight_denied", evil.status === 403 && !evil.headers.get("access-control-allow-origin"), evil.status);
    const pay = await http("OPTIONS", "/functions/v1/create-payment-session", {});
    record("cors_payment_preflight_allowed", pay.status === 204 && pay.headers.get("access-control-allow-origin") === ORIGIN, pay.status);
  }

  // 4. setup-status refuses a wrong workspace/PIN.
  {
    const r = await http("POST", "/functions/v1/chalet-setup-status", { body: { workspace_key: "NOSUCHWS", access_pin: "00000000" } });
    record("setup_status_rejects_bad_auth", r.status === 401, r.status);
  }

  // 5. Create the synthetic staging workspace (existing safe contract).
  {
    const doc = {
      schema_version: 3,
      settings: { facility_name: "منشأة تجريبية", tag: "staging-smoke", holidays: [] },
      chalets: [{
        id: "c1", name: "شاليه تجريبي", capacity: 6, deleted_at: null,
        periods: [{ id: "p1", label: "صباحي", start: "07:00", end: "17:00", active: true, sort: 1, weekday_price: 400, weekend_price: 600 }],
      }],
      bookings: [{
        id: "b1", customer_name: "عميل تجريبي", customer_phone: FAKE_PHONE,
        chalet_id: "c1", booking_date: RIYADH_TODAY, period_id: "p1",
        guests: 2, total: 500, paid: 0, status: "confirmed",
        notes: "", remaining_status: "", remaining_note: "", remaining_updated_at: "",
        deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    };
    const r = await http("POST", "/rest/v1/rpc/create_shared_workspace", {
      body: { p_workspace_key: WS_KEY, p_access_pin: PIN, p_data: doc },
    });
    record("synthetic_workspace_created", r.status === 200 && r.json && r.json.ok === true, r.status + (r.json && r.json.error ? ":" + r.json.error : ""));
  }

  // 6. setup-status with valid auth: booleans only, staging env, DeepSeek ready.
  {
    const r = await http("POST", "/functions/v1/chalet-setup-status", { body: { workspace_key: WS_KEY, access_pin: PIN } });
    const b = r.json || {};
    const shapeOk = r.status === 200 && b.ok === true &&
      typeof b.deepseek_configured === "boolean" &&
      typeof b.assistant_confirm_secret_configured === "boolean" &&
      typeof b.autopilot_secret_configured === "boolean" &&
      typeof b.whatsapp_configured === "boolean";
    record("setup_status_booleans", shapeOk, r.status);
    record("setup_status_app_env_staging", b.app_env === "staging", b.app_env);
    record("setup_status_deepseek_configured", b.deepseek_configured === true);
    record("setup_status_confirm_secret_configured", b.assistant_confirm_secret_configured === true);
    record("setup_status_autopilot_secret_configured", b.autopilot_secret_configured === true);
    const leak = leaks(r.text);
    record("setup_status_no_secret_leak", !leak, leak || "clean");
  }

  // 7. REAL DeepSeek smoke: two-stage grounded read of staging data.
  let threadId = null;
  {
    let ok = false, detail = "", grounded, redactionOk;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const r = await assistant({ message: "ما هي حجوزات اليوم؟" });
      const b = r.json || {};
      if (r.status !== 200 || b.ok !== true) { detail = r.status + ":" + (b.error || "NO_OK"); continue; }
      threadId = b.thread_id || threadId;
      const today = (b.tool_results || []).find((t) => t.tool === "get_today_bookings" && t.ok);
      const count = today && today.result && Array.isArray(today.result.bookings) ? today.result.bookings.length : -1;
      grounded = Boolean(today) && b.model_calls === 2 && typeof b.reply_ar === "string" && b.reply_ar.length > 0;
      redactionOk = !leaks(r.text);
      if (grounded && count === 1 && redactionOk) { ok = true; detail = "model_calls=2, bookings=1"; }
      else detail = `grounded=${grounded},bookings=${count},clean=${redactionOk}`;
    }
    record("deepseek_real_grounded_read", ok, detail);
  }

  // 8. Server-side thread persistence (message insert already gates the 200).
  {
    const list = await assistant({ thread_action: "list" });
    const found = (list.json && list.json.threads || []).some((t) => t.id === threadId);
    record("assistant_thread_persisted", list.status === 200 && Boolean(threadId) && found, list.status);
    const second = await assistant({ thread_id: threadId, message: "شكراً" });
    record("assistant_thread_second_message", second.status === 200 && second.json && second.json.ok === true, second.status);
  }

  // 9. Confirmed booking create through the real contracts (staging only).
  let newBookingId = null;
  {
    const prep = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "حجز تجريبي", chalet_id: "c1", booking_date: RIYADH_TOMORROW, period_id: "p1", total: 400, guests: 2 } } });
    const p = prep.json || {};
    const prepared = prep.status === 200 && p.kind === "prepared_action" && p.action_id && p.confirmation_token;
    record("booking_prepared", Boolean(prepared), prep.status + (p.error ? ":" + p.error : ""));
    if (prepared) {
      const conf = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const c = conf.json || {};
      newBookingId = c.result && c.result.booking_id;
      record("booking_confirmed_created", conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_created", conf.status + (c.error ? ":" + c.error : ""));
      const listB = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW } } });
      const n = listB.json && listB.json.result && Array.isArray(listB.json.result.bookings) ? listB.json.result.bookings.length : -1;
      record("booking_exactly_one", n === 1, "count=" + n);
    }
  }

  // 10. Cancel the synthetic booking (fail-closed ledger check runs for real).
  if (newBookingId) {
    const prep = await assistant({ invoke_tool: { name: "prepare_booking_cancel", arguments: { booking_id: newBookingId } } });
    const p = prep.json || {};
    if (prep.status === 200 && p.action_id) {
      const conf = await assistant({ invoke_tool: { name: "confirm_booking_cancel", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const c = conf.json || {};
      record("booking_cancelled", conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_cancelled", conf.status + (c.error ? ":" + c.error : ""));
    } else {
      record("booking_cancelled", false, prep.status + ":" + (p.error || "PREPARE_FAILED"));
    }
  } else {
    record("booking_cancelled", false, "NO_BOOKING_ID");
  }

  // 11. No automation rule exists/enabled on staging.
  {
    const r = await assistant({ invoke_tool: { name: "get_automation_status", arguments: {} } });
    const rules = r.json && r.json.result && Array.isArray(r.json.result.rules) ? r.json.result.rules : null;
    record("automation_rules_all_disabled", Array.isArray(rules) && rules.every((x) => !x.enabled) , rules ? "rules=" + rules.length : "NO_RESULT");
  }

  // 12. payment-webhook fails closed without a signature (no charge possible).
  {
    const r = await http("POST", "/functions/v1/payment-webhook", { body: { probe: true } });
    record("payment_webhook_fails_closed", r.status >= 400 && r.status < 500, r.status);
  }

  // 13. chalet-autopilot is gated by the cron secret (403 without it).
  {
    const r = await http("POST", "/functions/v1/chalet-autopilot", { body: {} });
    record("autopilot_gated", r.status === 403, r.status);
  }

  const failed = steps.filter((s) => !s.ok);
  const report = {
    generated_at: new Date().toISOString(),
    target: "staging",
    riyadh_today: RIYADH_TODAY,
    total: steps.length,
    passed: steps.length - failed.length,
    failed: failed.length,
    steps,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync("staging-smoke-report.json", JSON.stringify(report, null, 2));
  console.log(`\nSMOKE ${failed.length === 0 ? "GREEN" : "RED"}: ${report.passed}/${report.total} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  // Safe code only — never a body or secret.
  console.error("SMOKE_CRASH:", e && e.name ? e.name : "ERROR");
  process.exit(1);
});
