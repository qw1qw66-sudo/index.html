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

  // 3b. EDGE ENVELOPE: even syntactically-broken input from a browser origin
  // must come back as JSON WITH the allow-origin header — never CORS-less
  // air, which a phone can only render as «تعذّر الاتصال» (live incident).
  {
    const res = await fetch(BASE + "/functions/v1/chalet-assistant", {
      method: "POST",
      headers: { apikey: ANON, authorization: "Bearer " + ANON, "content-type": "application/json", origin: ORIGIN },
      body: "{",
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* must not happen */ }
    const corsOk = res.headers.get("access-control-allow-origin") === ORIGIN;
    const jsonFail = Boolean(j) && j.ok === false && typeof (j.reason_ar || j.error) === "string";
    record("edge_alive_with_cors", corsOk && jsonFail, res.status + ":cors=" + corsOk);
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
            // Owner-reported shape: two periods share 19:00, but only one is
            // the requested 19:00→05:00 slot.
            { id: "p7", label: "فترة 3", start: "19:00", end: "00:00", active: true, sort: 7, weekday_price: 450, weekend_price: 450 },
            { id: "p8", label: "فترة 4", start: "19:00", end: "05:00", active: true, sort: 8, weekday_price: 450, weekend_price: 450 },
            // Post-midnight slot: under the night-anchor convention it is the
            // TAIL of its booking_date's night — the 10f3 probe proves the
            // deployed engine blocks it while the 19:00→05:00 night is taken.
            { id: "p9", label: "منتصف الليل", start: "00:00", end: "05:00", active: true, sort: 9, weekday_price: 200, weekend_price: 200 },
            // R8 §9: two SAME-TIME day periods (identical 07:00–17:00) named
            // «فترة 5» / «الفترة 6» — the live shape behind Scenario A/D. The
            // deployed assistant must offer these as a one-tap pick (never a
            // «حدد بالاسم» dead-end), and a bare digit / «فترة خمسه» must bind.
            { id: "p10", label: "فترة 5", start: "07:00", end: "17:00", active: true, sort: 10, weekday_price: 450, weekend_price: 450 },
            { id: "p11", label: "الفترة 6", start: "07:00", end: "17:00", active: true, sort: 11, weekday_price: 400, weekend_price: 400 },
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

  // 6d. R8 Scenario A (LIVE): a COMPLETE booking message never becomes an
  // interrogation. The deployed endpoint must extract every stated field with
  // ZERO model calls and re-ask NOTHING already given; the only open point is
  // the same-time period pick, offered as one-tap options. Prepare-only — no
  // booking is created, so nothing to clean up.
  {
    const complete = "اعمل حجز جديد بعد يومين شاليه تولوم من 7 الصباح إلى 5 العصر عدد الضيوف 4 رقم الجوال 0503559373 باسم خالد السعر 450";
    const r1 = await assistant({ message: complete });
    const b1 = r1.json || {};
    const th = b1.thread_id;
    const reply1 = String(b1.reply_ar || "");
    const noReask =
      !/لأي شاليه/.test(reply1) && !/كم عدد الضيوف/.test(reply1) &&
      !/كم الإجمالي/.test(reply1) && !/باسم من/.test(reply1) && !/ما تاريخ/.test(reply1);
    const offeredPick = Array.isArray(b1.next_actions) && b1.next_actions.length >= 1;
    const zero1 = b1.model_calls === 0;
    // Tap option 1 -> straight to a card that PRESERVES every stated field.
    const r2 = th ? await assistant({ message: "1", thread_id: th }) : { json: {} };
    const b2 = r2.json || {};
    const prepared = (b2.tool_results || []).find((x) => x.kind === "prepared_action" && x.ok);
    const rows = prepared && prepared.card && Array.isArray(prepared.card.rows)
      ? Object.fromEntries(prepared.card.rows.map((x) => [x.k, x.v])) : {};
    const preserved = rows["الضيوف"] === "4" && String(rows["الإجمالي"] || "").includes("450") && rows["العميل"] === "خالد";
    const zero2 = b2.model_calls === 0;
    const leak = leaks(r1.text) || leaks(r2.text);
    record(
      "complete_message_no_interrogation",
      zero1 && zero2 && noReask && offeredPick && Boolean(prepared) && preserved && !leak,
      `zero=${zero1 && zero2},noReask=${noReask},pick=${offeredPick},preserved=${preserved}` + (leak ? ",LEAK" : ""),
    );
  }

  // 6e. R8 Scenario D (LIVE): several missing fields become ONE combined
  // question, and ONE combined reply completes the draft — never a field-by
  // -field interrogation. Prepare-only.
  {
    const r1 = await assistant({ message: "احجز تولوم بكرة فترة 5" });
    const b1 = r1.json || {};
    const th = b1.thread_id;
    const reply1 = String(b1.reply_ar || "");
    const combined = /باقي فقط:/.test(reply1) && /عدد الضيوف/.test(reply1) && /اسم العميل/.test(reply1) && /رسالة واحدة/.test(reply1);
    const zero1 = b1.model_calls === 0;
    const r2 = th ? await assistant({ message: "٤ ضيوف باسم سالم جوال 0500000012 والسعر 450", thread_id: th }) : { json: {} };
    const b2 = r2.json || {};
    const prepared = (b2.tool_results || []).find((x) => x.kind === "prepared_action" && x.ok);
    const rows = prepared && prepared.card && Array.isArray(prepared.card.rows)
      ? Object.fromEntries(prepared.card.rows.map((x) => [x.k, x.v])) : {};
    const completed = rows["الضيوف"] === "4" && rows["العميل"] === "سالم" && String(rows["الإجمالي"] || "").includes("450");
    const zero2 = b2.model_calls === 0;
    const leak = leaks(r1.text) || leaks(r2.text);
    record(
      "combined_missing_fields_once",
      zero1 && zero2 && combined && Boolean(prepared) && completed && !leak,
      `combined=${combined},completed=${completed},zero=${zero1 && zero2}` + (leak ? ",LEAK" : ""),
    );
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
      // The agentic loop makes ≥2 model calls (request tool → ground/answer); a
      // smarter model may chain one extra hop, so assert ≥2 (was exactly 2).
      grounded = Boolean(today) && b.model_calls >= 2 && typeof b.reply_ar === "string" && b.reply_ar.length > 0;
      redactionOk = !leaks(r.text);
      if (grounded && count === 1 && redactionOk) { ok = true; detail = "model_calls=" + b.model_calls + ", bookings=1"; }
      else detail = `grounded=${grounded},bookings=${count},clean=${redactionOk}`;
    }
    record("deepseek_real_grounded_read", ok, detail);
  }

  // 7b. G1 — the AGENTIC model path answers a free-form analytical question live
  // on DeepSeek (the stronger default tier). A generic ask reaches the model
  // (no deterministic intent), runs ≥1 model call, returns a non-empty grounded
  // Arabic reply, and leaks nothing. Proves the loop + model upgrade end-to-end.
  {
    let ok = false, detail = "";
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const r = await assistant({ message: "أعطني نظرة سريعة على وضع حجوزاتي ونصيحة مختصرة." });
      const b = r.json || {};
      if (r.status !== 200 || b.ok !== true) { detail = r.status + ":" + (b.error || "NO_OK"); continue; }
      const answered = typeof b.reply_ar === "string" && b.reply_ar.length > 0 && b.model_calls >= 1;
      if (answered && !leaks(r.text)) { ok = true; detail = "model_calls=" + b.model_calls; }
      else detail = `answered=${answered},clean=${!leaks(r.text)},mc=${b.model_calls}`;
    }
    record("assistant_agentic_analytical_answer", ok, detail);
  }

  // 8. Server-side thread persistence (message insert already gates the 200).
  {
    const list = await assistant({ thread_action: "list" });
    const found = (list.json && list.json.threads || []).some((t) => t.id === threadId);
    record("assistant_thread_persisted", list.status === 200 && Boolean(threadId) && found, list.status);
    const second = await assistant({ thread_id: threadId, message: "شكراً" });
    record("assistant_thread_second_message", second.status === 200 && second.json && second.json.ok === true, second.status);
  }

  // 8b. Deterministic period summary read (count + income) — «كم دخلي هالشهر؟»
  // dispatches to get_bookings_summary, renders count + إجمالي الدخل (or a clear
  // empty answer), with ZERO model calls and no phone leak. Proves the new read
  // tool's live wiring on the real Deno runtime.
  {
    const r = await assistant({ message: "كم دخلي هالشهر؟" });
    const j = r.json || {};
    const rendered = typeof j.reply_ar === "string" && /(إجمالي الدخل|لا توجد حجوزات في هذه المدة)/.test(j.reply_ar);
    const ok = r.status === 200 && j.ok === true && j.model_calls === 0 && rendered && !leaks(j.reply_ar);
    record("assistant_period_summary_read", ok, r.status + ":mc=" + (j.model_calls) + ":" + String(j.reply_ar || "").slice(0, 32));
  }

  // 8c. R12 reverse-audit routing: a bare/tomorrow count question «كم حجز بكرة؟»
  // used to FALL TO THE MODEL (model_calls>0). It must now dispatch to
  // get_bookings_summary deterministically (model_calls===0) live on Deno —
  // proving the deterministic guarantee holds for this phrasing in production.
  {
    const r = await assistant({ message: "كم حجز بكرة؟" });
    const j = r.json || {};
    const rendered = typeof j.reply_ar === "string" && /(عدد الحجوزات|حجز|حجوزات|لا توجد حجوزات في هذه المدة)/.test(j.reply_ar);
    const ok = r.status === 200 && j.ok === true && j.model_calls === 0 && rendered && !leaks(j.reply_ar);
    record("assistant_tomorrow_count_read_model_free", ok, r.status + ":mc=" + (j.model_calls) + ":" + String(j.reply_ar || "").slice(0, 32));
  }

  // 9. Confirmed booking create through the real contracts (staging only).
  let newBookingId = null;
  {
    const prep = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "مهره اختبار", chalet_name: "تولوم", booking_date: RIYADH_TOMORROW, period_label: "المسائية", total: 400, guests: 2 } } });
    const p = prep.json || {};
    const prepared = prep.status === 200 && p.kind === "prepared_action" && p.action_id && p.confirmation_token && String(p.summary_ar || "").includes("شاليه تولوم") && String(p.summary_ar || "").includes("مسائي");
    record("booking_prepared", Boolean(prepared), prep.status + (p.error ? ":" + p.error : ""));
    if (prepared) {
      const conf = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
      const c = conf.json || {};
      newBookingId = c.result && c.result.booking_id;
      record("booking_confirmed_created", conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_created", conf.status + (c.error ? ":" + c.error : ""));
      const projection = c.result && c.result.booking;
      const projectionOk = projection && projection.id === newBookingId &&
        projection.customer_name === "مهره اختبار" &&
        projection.booking_date === RIYADH_TOMORROW &&
        projection.status === "confirmed" &&
        projection.total === 400 && projection.paid === 0;
      record("booking_save_echo_verified", Boolean(projectionOk), "projection=" + Boolean(projection));
      const listB = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TOMORROW, to: RIYADH_TOMORROW } } });
      const listed = listB.json && listB.json.result && Array.isArray(listB.json.result.bookings) ? listB.json.result.bookings : null;
      const n = listed ? listed.length : -1;
      const visible = listed && listed.some((b) => String(b.id) === String(newBookingId) && b.customer_name === "مهره اختبار" && b.booking_date === RIYADH_TOMORROW && b.status === "confirmed");
      record("booking_exactly_one", n === 1 && visible, "count=" + n + ",visible=" + Boolean(visible));

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
      const cancelProjection = c.result && c.result.booking;
      record("booking_cancelled", conf.status === 200 && c.ok === true && c.result && c.result.action === "booking_cancelled" && cancelProjection && cancelProjection.id === newBookingId && cancelProjection.status === "cancelled", conf.status + (c.error ? ":" + c.error : ""));
    } else {
      record("booking_cancelled", false, prep.status + ":" + (p.error || "PREPARE_FAILED"));
    }
  } else {
    record("booking_cancelled", false, "NO_BOOKING_ID");
  }

  // 10c. Owner memory-management endpoint: the confirmed booking above wrote a
  // customer memory; LIST it (must be phone-free) then REJECT it (cleanup). This
  // is the first live exercise of listMemories/rejectMemory + the memory_action
  // branch. A zero-memory list still passes the shape/phone-free assertions.
  {
    const list = await assistant({ memory_action: "list" });
    const lj = list.json || {};
    const mems = Array.isArray(lj.memories) ? lj.memories : [];
    const clean = mems.every((m) => !leaks(String(m.summary_ar || "")));
    record("assistant_memory_list", list.status === 200 && lj.ok === true && Array.isArray(lj.memories) && clean, list.status + ":n=" + mems.length);
    const mine = mems.find((m) => String(m.summary_ar || "").includes("مهره اختبار"));
    if (mine && mine.id) {
      const rej = await assistant({ memory_action: "reject", memory_id: mine.id });
      record("assistant_memory_reject", rej.status === 200 && rej.json && rej.json.ok === true, rej.status + (rej.json && rej.json.error ? ":" + rej.json.error : ""));
    }
  }

  // 10b. Exact owner-reported conversation — spoken end hour, later guest
  // count, marker-only price and a bare customer-name answer must all survive
  // into one exact card with ZERO model calls.
  let agentThread = null, agentBookingId = null;
  let agentAction, agentToken;
  {
    const turn = async (msg) => {
      const r = await assistant({ message: msg, ...(agentThread ? { thread_id: agentThread } : {}) });
      const b = r.json || {};
      if (b.thread_id) agentThread = b.thread_id;
      return { r, b };
    };
    const t1 = await turn(`سجل حجز جديد اليوم المساء من ٧ الى خمس الصباح رقم الجوال ${FAKE_PHONE} اسم الشاليه تولوم عدد الضيوف ١٠ السعر ٣٠٠`);
    const t2 = await turn("علي");
    const prepared = (t2.b.tool_results || []).find((x) => x.kind === "prepared_action" && x.ok);
    agentAction = prepared && prepared.action_id;
    agentToken = prepared && prepared.confirmation_token;
    const zeroModel = [t1, t2].every((t) => t.b.model_calls === 0);
    const askedNameOnly = t1.r.status === 200 && t1.b.ok === true && /باسم من/.test(String(t1.b.reply_ar || "")) && !/حدد الفترة|كم عدد الضيوف|سعر النظام/.test(String(t1.b.reply_ar || ""));
    const cardOk = Boolean(prepared && prepared.card && Array.isArray(prepared.card.rows) && prepared.card.rows.length >= 6);
    const rows = cardOk ? Object.fromEntries(prepared.card.rows.map((r) => [r.k, r.v])) : {};
    const exact = rows["العميل"] === "علي" && rows["الفترة"] === "19:00 → 05:00" && rows["الضيوف"] === "10" && rows["الإجمالي"] === "300 ريال" && rows["الجوال"] === "05••••0000";
    const noReask = !/لم أفهم|أي يوم|كم عدد الضيوف|سعر النظام/.test(String(t2.b.reply_ar || ""));
    record("agent_draft_conversation", zeroModel && askedNameOnly && cardOk && exact && noReask && Boolean(agentToken), "card_rows=" + (prepared && prepared.card ? prepared.card.rows.length : 0));
    record("agent_reported_transcript_exact", zeroModel && exact && askedNameOnly && noReask, exact ? "exact" : "CARD_MISMATCH");
  }

  // 10c. Typed «سجل» NEVER executes — it re-displays the card (rotated token).
  if (agentThread && agentAction) {
    const r = await assistant({ message: "سجل", thread_id: agentThread });
    const b = r.json || {};
    const again = (b.tool_results || []).find((x) => x.kind === "prepared_action");
    const noExec = !(b.tool_results || []).some((x) => x.kind === "completed_action");
    const listB = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TODAY, to: RIYADH_TODAY, status: "confirmed" } } });
    const n = listB.json && listB.json.result && Array.isArray(listB.json.result.bookings) ? listB.json.result.bookings.length : -1;
    if (again && again.confirmation_token) agentToken = again.confirmation_token; // rotated
    record("sajil_never_executes", r.status === 200 && b.model_calls === 0 && Boolean(again) && noExec && n === 1, "confirmed_today=" + n);
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
    const racePrep = await assistant({ invoke_tool: { name: "prepare_booking_create", arguments: { customer_name: "سباق تجريبي", chalet_name: "تولوم", booking_date: RIYADH_TODAY, period_label: "فترة 4", total: 100, guests: 2 } } });
    const race = racePrep.json || {};

    const conf = await assistant({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: agentAction, confirmation_token: agentToken } } });
    const c = conf.json || {};
    agentBookingId = c.result && c.result.booking_id;
    const one = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TODAY, to: RIYADH_TODAY, status: "confirmed" } } });
    const n = one.json && one.json.result ? (one.json.result.bookings || []).filter((x) => x.customer_name === "علي").length : -1;
    record("agent_booking_confirmed_once", conf.status === 200 && c.ok === true && n === 1, "count=" + n);

    const conflict = await assistant({ message: "احجز تولوم اليوم من ٧ مساء الى خمس الصباح لشخصين بمئة ريال، العميل تجربة ثانية" });
    const cb = conflict.json || {};
    const noCard = !(cb.tool_results || []).some((x) => x.kind === "prepared_action");
    const talksAlternatives = /محجوزة/.test(String(cb.reply_ar || "")) && /1\./.test(String(cb.reply_ar || ""));
    const cleanText = !/BOOKING_CONFLICT|[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(cb.reply_ar || ""));
    record("conflict_returns_alternatives", conflict.status === 200 && cb.model_calls === 0 && noCard && talksAlternatives && cleanText, leaks(conflict.text) || "clean");

    // 10e1a. CLOSED GUIDED MODE (§ never a model turn mid-draft): nonsense on
    // the conflict thread gets the pending question back, zero model calls.
    if (cb.thread_id) {
      const g = await assistant({ message: "كلام غير مفهوم تماماً", thread_id: cb.thread_id });
      const gb = g.json || {};
      const guided = /لم أفهم ردّك/.test(String(gb.reply_ar || "")) && /الغِ الحجز/.test(String(gb.reply_ar || ""));
      const gNoCard = !(gb.tool_results || []).some((x) => x.kind === "prepared_action");
      record("guided_reprompt_zero_model", g.status === 200 && gb.model_calls === 0 && guided && gNoCard, "model_calls=" + gb.model_calls);

      // 10e1b. Pasting the option line the bot itself printed SELECTS it.
      const optionLine = String(cb.reply_ar || "").split("\n").find((l) => l.startsWith("1. "));
      if (optionLine) {
        const p = await assistant({ message: optionLine.slice(3), thread_id: cb.thread_id });
        const pb = p.json || {};
        const gotCard = (pb.tool_results || []).some((x) => x.kind === "prepared_action");
        const noAmbig = !/الوقت غير واضح|لم أفهم/.test(String(pb.reply_ar || ""));
        record("paste_option_line_selects", p.status === 200 && pb.model_calls === 0 && gotCard && noAmbig, "model_calls=" + pb.model_calls);
      } else {
        record("paste_option_line_selects", false, "NO_OPTION_LINE");
      }
    } else {
      record("guided_reprompt_zero_model", false, "NO_THREAD");
      record("paste_option_line_selects", false, "NO_THREAD");
    }

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
      const still1 = await assistant({ invoke_tool: { name: "list_bookings", arguments: { from: RIYADH_TODAY, to: RIYADH_TODAY, status: "confirmed" } } });
      const n2 = still1.json && still1.json.result ? (still1.json.result.bookings || []).filter((x) => x.customer_name === "علي").length : -1;
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
    record("guided_reprompt_zero_model", false, "NO_TOKEN");
    record("paste_option_line_selects", false, "NO_TOKEN");
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

  // 10f2. TAB-TRUTH INVARIANT (IMG_6705 «لا توجد حجوزات»): while the agent's
  // booking exists, the SAME document read the app's «تحديث»/auto-refresh
  // uses (get_shared_workspace) must already contain it, dated Riyadh-today.
  // No leak scan here: the authenticated owner doc legitimately carries the
  // synthetic phone; nothing from the body is printed.
  if (agentBookingId) {
    const r = await http("POST", "/rest/v1/rpc/get_shared_workspace", {
      body: { p_workspace_key: WS_KEY, p_access_pin: PIN },
    });
    const b = r.json || {};
    const bookings = b && b.data && Array.isArray(b.data.bookings) ? b.data.bookings : [];
    const mine = bookings.find((x) => String(x.id) === String(agentBookingId));
    const consistent = Boolean(mine) && mine.booking_date === RIYADH_TODAY && mine.status === "confirmed";
    record(
      "today_bookings_read_consistent",
      r.status === 200 && b.ok === true && consistent && Boolean(b.updated_at),
      "found=" + Boolean(mine) + ",date_ok=" + (mine ? String(mine.booking_date === RIYADH_TODAY) : "-"),
    );
  } else {
    record("today_bookings_read_consistent", false, "NO_BOOKING");
  }

  // 10f3. NIGHT ANCHOR (IMG_6706 «سالفة التوقيت»): while the agent's
  // 19:00→05:00 booking occupies tonight, the 00:00–05:00 «منتصف الليل» slot
  // (p9) on the SAME date is the middle of that occupied night. The deployed
  // availability engine must EXCLUDE it from today's available periods —
  // before the night-anchor fix it read «متاحة». A read is deterministic and
  // needs no cleanup; daytime slots stay free so the list is non-empty.
  if (agentBookingId) {
    const r = await assistant({ invoke_tool: { name: "find_available_periods", arguments: { chalet_name: "تولوم", date: RIYADH_TODAY } } });
    const res = r.json && r.json.result ? r.json.result : {};
    const avail = Array.isArray(res.available) ? res.available : null;
    const starts = avail ? avail.map((p) => String(p.start || "")) : [];
    const midnightOffered = starts.includes("00:00"); // p9's post-midnight slot
    record(
      "night_containment_blocked",
      r.status === 200 && Array.isArray(avail) && avail.length > 0 && !midnightOffered && !leaks(r.text),
      "avail=" + starts.length + ",midnight_offered=" + midnightOffered,
    );
  } else {
    record("night_containment_blocked", false, "NO_BOOKING");
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

  // 10h. OWNER-VERBATIM (IMG_6702): the exact live message that appeared to
  // "disconnect" the assistant must be answered deterministically on a fresh
  // thread — a card or ONE Arabic question, zero model calls, no crash class.
  {
    const r = await http("POST", "/functions/v1/chalet-assistant", {
      body: {
        workspace_key: WS_KEY, access_pin: PIN,
        message: "سجل حجز اليوم باسم علي تجريبي شالية تولوم الوقت ٧ المسا الى ٥ الصباح عدد الضيوف ١٠ و الرقم 0503666853 شالية تولوم",
      },
    });
    const b = r.json || {};
    const card = (b.tool_results || []).some((x) => x.kind === "prepared_action");
    const asksOne = typeof b.reply_ar === "string" && b.reply_ar.length > 0 && !/تعذّر|خلل/.test(b.reply_ar);
    const phoneHidden = !r.text.includes("0503666853"); // masked or absent only
    record(
      "owner_message_verbatim",
      r.status === 200 && b.ok === true && b.model_calls === 0 && (card || asksOne) && phoneHidden && !leaks(r.text),
      "model_calls=" + b.model_calls + ",card=" + card,
    );
  }

  // 10i. ANSWER MATRIX (IMG_6703): the assistant's own chalet question must
  // accept the bare answer «تولوم» — the live reply was «لم أفهم ردّك» twice.
  // Since R8 the ask is COMBINED when several fields are missing («باقي فقط:
  // اسم الشاليه، والسعر…»), so the chalet may be requested as «اسم الشاليه»
  // OR the single «لأي شاليه» — either counts. Fresh thread; stops at the
  // price question, so no booking and no cleanup.
  {
    const t1 = await assistant({ message: "احجز فترة اليوم مساء من ٧ الى ٥ عدد الضيوف ١٠ باسم علي تجربة" });
    const b1 = t1.json || {};
    const t1Thread = b1.thread_id || null;
    const askedChalet = t1.status === 200 && b1.ok === true && b1.model_calls === 0 && /لأي شاليه|اسم الشاليه/.test(String(b1.reply_ar || ""));
    let advanced = false, detail = "NO_THREAD";
    if (t1Thread) {
      const t2 = await assistant({ message: "تولوم", thread_id: t1Thread });
      const b2 = t2.json || {};
      const notFallback = !/لم أفهم ردّك/.test(String(b2.reply_ar || ""));
      const nextQuestion = /سعر|فترة|بطاقة/.test(String(b2.reply_ar || ""));
      advanced = t2.status === 200 && b2.ok === true && b2.model_calls === 0 && notFallback && nextQuestion && !leaks(t2.text);
      detail = "asked=" + askedChalet + ",advanced=" + advanced + ",model_calls=" + b2.model_calls;
    }
    record("chalet_answer_binds", askedChalet && advanced, detail);
  }

  // 10i2. R9 (IMG_6721): a chalet named INSIDE a long combined-answer sentence
  // must bind — the live dead-end re-asked «اسم الشاليه» because the hint
  // stayed frozen on the first (chalet-less) message, and the name over
  // -captured «محمد التاريخ». Fresh thread; stops at the period/price question
  // (no booking, no cleanup).
  {
    const a1 = await assistant({ message: "ابغى احجز" });
    const th = (a1.json || {}).thread_id || null;
    let ok = false, detail = "NO_THREAD";
    if (th) {
      const a2 = await assistant({ message: "الحجز باسم محمد التاريخ بعد ٣ ايام شالية تولوم عدد الضيوف ٥", thread_id: th });
      const b2 = a2.json || {};
      const reply = String(b2.reply_ar || "");
      // The chalet is bound (never re-asked) and the flow advanced to period.
      const chaletNotReasked = !/لأي شاليه|اسم الشاليه/.test(reply);
      const advancedToPeriod = /الفترة|فترة/.test(reply);
      ok = a2.status === 200 && b2.ok === true && b2.model_calls === 0 && chaletNotReasked && advancedToPeriod && !leaks(a2.text);
      detail = "chaletNotReasked=" + chaletNotReasked + ",advanced=" + advancedToPeriod + ",model_calls=" + b2.model_calls;
    }
    record("chalet_in_long_answer_binds", ok, detail);
  }

  // 10i3. R10 (30-hunter audit): a single message exercises three high-value
  // comprehension fixes at once — «لأربعة» (لـ + number-word) → 4 guests,
  // «مؤكد» must NOT be swallowed into the name, and «خمس مية» → 500 ريال (the
  // silent «100 ريال» money bug). One-turn card, zero model calls, no leaks.
  {
    const r = await assistant({ message: "احجز شاليه تولوم بكرة صباحي لأربعة باسم سعد مؤكد خمس مية" });
    const b = r.json || {};
    const prepared = (b.tool_results || []).find((x) => x.kind === "prepared_action" && x.ok);
    const rows = prepared && prepared.card && Array.isArray(prepared.card.rows)
      ? Object.fromEntries(prepared.card.rows.map((x) => [x.k, x.v])) : {};
    const ok = r.status === 200 && b.ok === true && b.model_calls === 0 && Boolean(prepared) &&
      rows["الضيوف"] === "4" && rows["العميل"] === "سعد" && String(rows["الإجمالي"] || "").includes("500") && !leaks(r.text);
    record("audit_guests_name_money_fixed", ok, `guests=${rows["الضيوف"]},name=${rows["العميل"]},total=${rows["الإجمالي"]}`);
  }

  // 10j. R7 CHIP TRUTH (IMG_6711): «من عليه مبالغ متبقية؟» must answer with
  // the debtor NAMES + amounts, deterministically — never the bare count
  // («يوجد N حجوزات») and never a model turn. The seeded «عميل تجريبي» has
  // total 500 / paid 0, so the ledger view owes 500.
  {
    const r = await assistant({ message: "من عليه مبالغ متبقية؟" });
    const b = r.json || {};
    const named = /عميل تجريبي/.test(String(b.reply_ar || ""));
    const amounts = /المتبقي/.test(String(b.reply_ar || "")) && /ريال/.test(String(b.reply_ar || ""));
    const notBareCount = !/^يوجد \d+ حجوزات\.$/.test(String(b.reply_ar || "").trim());
    record(
      "balances_names_listed",
      r.status === 200 && b.ok === true && b.model_calls === 0 && named && amounts && notBareCount && !leaks(r.text),
      "model_calls=" + b.model_calls + ",named=" + named,
    );
  }

  // 10k. R7 CHIP TRUTH (IMG_6710): «كم دخل جابه التسويق؟» answers with a real
  // number or an honest zero — never the «تمام.» filler, never a model turn.
  {
    const r = await assistant({ message: "كم دخل جابه التسويق؟" });
    const b = r.json || {};
    const reply = String(b.reply_ar || "").trim();
    const meaningful = reply !== "تمام." && (/ريال/.test(reply) || /لا يوجد دخل/.test(reply));
    record(
      "marketing_revenue_deterministic",
      r.status === 200 && b.ok === true && b.model_calls === 0 && meaningful && !leaks(r.text),
      "model_calls=" + b.model_calls,
    );
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
