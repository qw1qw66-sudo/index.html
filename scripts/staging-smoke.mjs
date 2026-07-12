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

// Origin is a BROWSER header: send it only to the browser-facing Edge
// Functions (to exercise their CORS), never to the server-side REST API —
// the deployed gateway 404s REST calls that carry a foreign Origin, which is
// exactly how the live app behaves (browsers on the allowed origin only).
async function http(method, path, { body, headers = {}, origin, timeoutMs = 45000 } = {}) {
  const useOrigin = origin === undefined ? (path.startsWith("/functions/") ? ORIGIN : null) : origin;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        apikey: ANON,
        authorization: "Bearer " + ANON,
        "content-type": "application/json",
        ...(useOrigin ? { origin: useOrigin } : {}),
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
      chalets: [
        {
          id: "c1", name: "شاليه تولوم", capacity: 15, deleted_at: null,
          periods: [
            { id: "p1", label: "صباحي", start: "07:00", end: "10:00", active: true, sort: 1, weekday_price: 400, weekend_price: 600 },
            { id: "p2", label: "ضحى", start: "10:00", end: "12:00", active: true, sort: 2, weekday_price: 400, weekend_price: 600 },
            { id: "p3", label: "ظهيرة", start: "12:00", end: "15:00", active: true, sort: 3, weekday_price: 400, weekend_price: 600 },
            { id: "p4", label: "عصري", start: "15:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 600 },
            { id: "p5", label: "مسائي", start: "17:00", end: "22:00", active: true, sort: 5, weekday_price: 400, weekend_price: 600 },
            { id: "p6", label: "ليلي", start: "22:00", end: "02:00", active: true, sort: 6, weekday_price: 400, weekend_price: 600 },
          ],
        },
        {
          id: "c2", name: "شاليه سكاي", capacity: 6, deleted_at: null,
          periods: [{ id: "s1", label: "صباحي", start: "07:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 500 }],
        },
        {
          // Deliberately broken data: a period with NO end time. New bookings
          // on it must FAIL CLOSED (availability cannot be proven).
          id: "c3", name: "شاليه بلا وقت", capacity: 4, deleted_at: null,
          periods: [{ id: "x1", label: "ناقصة", start: "10:00", end: "", active: true, sort: 1, weekday_price: 200, weekend_price: 300 }],
        },
      ],
      bookings: [{
        id: "b1", customer_name: "عميل تجريبي", customer_phone: FAKE_PHONE,
        chalet_id: "c1", booking_date: RIYADH_TODAY, period_id: "p1",
        guests: 2, total: 500, paid: 0, status: "confirmed",
        notes: "", remaining_status: "", remaining_note: "", remaining_updated_at: "",
        deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    };
    // PostgREST's schema cache can lag the just-applied migrations; retry the
    // first RPC briefly (the workflow already forces a reload).
    let r = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      r = await http("POST", "/rest/v1/rpc/create_shared_workspace", {
        body: { p_workspace_key: WS_KEY, p_access_pin: PIN, p_data: doc },
      });
      if (r.status !== 404) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    const detail = r.status + (r.json && (r.json.error || r.json.code) ? ":" + (r.json.error || r.json.code) : "") +
      (r.status !== 200 && r.json && r.json.message ? ":" + String(r.json.message).slice(0, 60) : "");
    record("synthetic_workspace_created", r.status === 200 && r.json && r.json.ok === true, detail);
  }

  // 6b. A safe catalog read is deterministic and returns the real names/ids
  // from this authenticated workspace even if the model provider is down.
  {
    const r = await assistant({ message: "ما هي الشاليهات المسجلة لديك؟" });
    const b = r.json || {};
    const tool = (b.tool_results || []).find((x) => x.tool === "list_chalets" && x.ok);
    const names = tool && tool.result && Array.isArray(tool.result.chalets) ? tool.result.chalets.map((x) => x.chalet_name) : [];
    record("real_chalet_catalog_read", r.status === 200 && b.ok === true && b.model_calls === 0 && names.includes("شاليه تولوم") && names.includes("شاليه سكاي"), r.status);
  }

  // 6c. «شنو حجوزات اليوم؟» answers DETERMINISTICALLY (zero model calls): one
  // natural Arabic reply, no internal tool name, no filler bubble text — this
  // basic owner question must survive any model-provider outage.
  {
    const r = await assistant({ message: "شنو حجوزات اليوم؟" });
    const b = r.json || {};
    const clean = typeof b.reply_ar === "string" && b.reply_ar.length > 0 &&
      !b.reply_ar.includes("get_today_bookings") && !b.reply_ar.includes("تم جلب البيانات") && !b.reply_ar.includes("جاري");
    record("deterministic_today_read", r.status === 200 && b.ok === true && b.model_calls === 0 && clean, r.status + ":model_calls=" + b.model_calls);
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
    const prep = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "حجز تجريبي", chalet_name: "تولوم", booking_date: RIYADH_TOMORROW, period_label: "المسائية", total: 400, guests: 2 } } });
    const p = prep.json || {};
    const prepared = prep.status === 200 && p.kind === "prepared_action" && p.action_id && p.confirmation_token && String(p.summary_ar || "").includes("شاليه تولوم") && String(p.summary_ar || "").includes("مسائي");
    record("booking_prepared", Boolean(prepared), prep.status + (p.error ? ":" + p.error : ""));
    if (prepared) {
      const conf = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const c = conf.json || {};
      newBookingId = c.result && c.result.booking_id;
      record("booking_confirmed_created", conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_created", conf.status + (c.error ? ":" + c.error : ""));
      const listB = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW } } });
      const n = listB.json && listB.json.result && Array.isArray(listB.json.result.bookings) ? listB.json.result.bookings.length : -1;
      record("booking_exactly_one", n === 1, "count=" + n);

      // 9b. REPLAY the exact same confirmation (double-tap / retry): the server
      // must return the stored outcome (replayed) and NEVER create a second
      // booking — the single-use token is the last line of defence.
      const replay = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const rp = replay.json || {};
      const again = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW } } });
      const n2 = again.json && again.json.result && Array.isArray(again.json.result.bookings) ? again.json.result.bookings.length : -1;
      record("booking_replay_blocked", replay.status === 200 && rp.replayed === true && n2 === 1, replay.status + ":replayed=" + rp.replayed + ",count=" + n2);
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

  // 10b. BOOKING AGENT conversation (§ live acceptance A) — the deterministic
  // draft pipeline collects fields ACROSS turns with ZERO model calls, never
  // re-asks known data, and ends in a structured confirmation card.
  let agentThread = null, agentBookingId = null;
  let agentAction, agentToken;
  {
    const turn = async (msg) => {
      const r = await assistant({ message: msg, ...(agentThread ? { thread_id: agentThread } : {}) });
      const b = r.json || {};
      if (b.thread_id) agentThread = b.thread_id;
      return { r, b };
    };
    const t1 = await turn("احجز تولوم");
    const t2 = await turn("بكرة بالليل");
    const t3 = await turn("أربعة");
    const t4 = await turn("500 ريال، العميل علي تجربة");
    const prepared = (t4.b.tool_results || []).find((x) => x.kind === "prepared_action" && x.ok);
    agentAction = prepared && prepared.action_id;
    agentToken = prepared && prepared.confirmation_token;
    const zeroModel = [t1, t2, t3, t4].every((t) => t.b.model_calls === 0);
    const askedOnce = [t1, t2, t3].every((t) => t.r.status === 200 && t.b.ok === true && typeof t.b.reply_ar === "string" && t.b.reply_ar.length > 0);
    const cardOk = Boolean(prepared && prepared.card && Array.isArray(prepared.card.rows) && prepared.card.rows.length >= 6);
    // Never re-asks: the final turn must NOT ask about date/guests again.
    const noReask = !/(أي يوم|كم عدد الضيوف)/.test(String(t4.b.reply_ar || ""));
    record("agent_draft_conversation", zeroModel && askedOnce && cardOk && noReask && Boolean(agentToken), "card_rows=" + (prepared && prepared.card ? prepared.card.rows.length : 0));
  }

  // 10c. Typed «سجل» NEVER executes — it re-displays the card (rotated token).
  if (agentThread && agentAction) {
    const r = await assistant({ message: "سجل", thread_id: agentThread });
    const b = r.json || {};
    const again = (b.tool_results || []).find((x) => x.kind === "prepared_action");
    const noExec = !(b.tool_results || []).some((x) => x.kind === "completed_action");
    const listB = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW, status: "confirmed" } } });
    const n = listB.json && listB.json.result && Array.isArray(listB.json.result.bookings) ? listB.json.result.bookings.length : -1;
    if (again && again.confirmation_token) agentToken = again.confirmation_token; // rotated
    record("sajil_never_executes", r.status === 200 && b.model_calls === 0 && Boolean(again) && noExec && n === 0, "confirmed_tomorrow=" + n);
  } else {
    record("sajil_never_executes", false, "NO_PREPARED_CARD");
  }

  // 10d. Refresh recovery rotates the token: the OLD token dies, the NEW works.
  if (agentAction) {
    const oldToken = agentToken;
    const rec = await assistant({ pending_action: "latest" });
    const pending = rec.json && rec.json.pending;
    const rotated = pending && pending.action_id === agentAction && pending.confirmation_token && pending.confirmation_token !== oldToken;
    let oldDead = false;
    if (rotated) {
      const tryOld = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: agentAction, confirmation_token: oldToken } } });
      const ob = tryOld.json || {};
      oldDead = ob.ok !== true && !(ob.kind === "completed_action" && ob.ok);
      agentToken = pending.confirmation_token;
    }
    record("pending_recovery_rotates_token", Boolean(rotated) && oldDead, rotated ? "old_token_rejected=" + oldDead : "NO_PENDING");
  }

  // 10e. Confirm with the ROTATED token -> exactly one booking; then conflict
  // on the SAME slot returns Arabic alternatives (numbered, max 3).
  if (agentAction && agentToken) {
    // A COMPETING action on the same slot, prepared while it is still free —
    // its confirm (after the agent's booking lands) is the confirm-time
    // conflict probe of step 10e2.
    // Same slot the agent conversation binds: «بكرة بالليل» resolves to the
    // native night period («ليلي») on the seeded chalet.
    const racePrep = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "سباق تجريبي", chalet_name: "تولوم", booking_date: RIYADH_TOMORROW, period_label: "ليلي", total: 100, guests: 2 } } });
    const race = racePrep.json || {};

    const conf = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: agentAction, confirmation_token: agentToken } } });
    const c = conf.json || {};
    agentBookingId = c.result && c.result.booking_id;
    const one = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW, status: "confirmed" } } });
    const n = one.json && one.json.result ? (one.json.result.bookings || []).length : -1;
    record("agent_booking_confirmed_once", conf.status === 200 && c.ok === true && n === 1, "count=" + n);

    const conflict = await assistant({ message: "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة ثانية" });
    const cb = conflict.json || {};
    const noCard = !(cb.tool_results || []).some((x) => x.kind === "prepared_action");
    const talksAlternatives = /محجوزة/.test(String(cb.reply_ar || "")) && /1\./.test(String(cb.reply_ar || ""));
    const cleanText = !/BOOKING_CONFLICT|[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(cb.reply_ar || ""));
    record("conflict_returns_alternatives", conflict.status === 200 && cb.model_calls === 0 && noCard && talksAlternatives && cleanText, leaks(conflict.text) || "clean");

    // 10e2. CONFIRM-TIME conflict is not a dead end (§12/§13 at confirm): the
    // competing card's confirm fails closed with a terminal card signal +
    // numbered alternatives — never a bare «محجوزة» with a re-armed button.
    if (racePrep.status === 200 && race.action_id && race.confirmation_token) {
      const rc = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: race.action_id, confirmation_token: race.confirmation_token } } });
      const rb = rc.json || {};
      const failedClosed = rb.ok !== true;
      const terminal = rb.kind === "completed_action" || rb.action_retired === true;
      const conflictCode = rb.public_code === "conflict";
      const options = Array.isArray(rb.next_actions) && rb.next_actions.length > 0;
      const wordsOk = /محجوزة|جودة البيانات/.test(String(rb.reason_ar || "")) && /الخيارات|1\./.test(String(rb.reason_ar || ""));
      const still1 = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW, status: "confirmed" } } });
      const n2 = still1.json && still1.json.result ? (still1.json.result.bookings || []).length : -1;
      record(
        "confirm_conflict_recovers",
        failedClosed && terminal && conflictCode && options && wordsOk && n2 === 1 && !leaks(rc.text),
        `terminal=${terminal},options=${options ? rb.next_actions.length : 0},count=${n2}`,
      );
    } else {
      record("confirm_conflict_recovers", false, racePrep.status + ":" + (race.error || "RACE_PREPARE_FAILED"));
    }
  } else {
    record("agent_booking_confirmed_once", false, "NO_TOKEN");
    record("conflict_returns_alternatives", false, "NO_TOKEN");
    record("confirm_conflict_recovers", false, "NO_TOKEN");
  }

  // 10f. A period with incomplete times FAILS CLOSED with a safe Arabic reason.
  {
    const r = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "تجربة وقت", chalet_name: "بلا وقت", period_label: "ناقصة", booking_date: RIYADH_TOMORROW, guests: 1, total: 100 } } });
    const b = r.json || {};
    const blocked = b.ok !== true;
    const safeText = typeof b.reason_ar === "string" && b.reason_ar.length > 0 && !/[A-Z]{2,}_[A-Z]/.test(b.reason_ar);
    record("timeless_period_fails_closed", blocked && safeText, String(b.public_code || b.error || r.status).slice(0, 40));
  }

  // 10g. Cleanup: cancel the agent's synthetic booking (nothing real remains).
  if (agentBookingId) {
    const prep = await assistant({ invoke_tool: { name: "prepare_booking_cancel", arguments: { booking_id: agentBookingId } } });
    const p = prep.json || {};
    let done = false;
    if (prep.status === 200 && p.action_id) {
      const conf = await assistant({ invoke_tool: { name: "confirm_booking_cancel", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const c = conf.json || {};
      done = conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_cancelled";
    }
    record("agent_booking_cleanup", done, done ? "cancelled" : "CLEANUP_FAILED");
  } else {
    record("agent_booking_cleanup", false, "NO_BOOKING");
  }

  // 11. No automation rule exists/enabled on staging.
  {
    const r = await assistant({ invoke_tool: { name: "get_automation_status", arguments: {} } });
    const rules = r.json && r.json.result && Array.isArray(r.json.result.rules) ? r.json.result.rules : null;
    record("automation_rules_all_disabled", Array.isArray(rules) && rules.every((x) => !x.enabled) , rules ? "rules=" + rules.length : "NO_RESULT");
  }

  // 12. payment-webhook fails closed without a signature (no charge possible).
  // 4xx = rejected; 503 = provider/secret not configured (fail-closed too).
  {
    const r = await http("POST", "/functions/v1/payment-webhook", { body: { probe: true } });
    record("payment_webhook_fails_closed", r.status >= 400 && r.status <= 503, r.status);
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
