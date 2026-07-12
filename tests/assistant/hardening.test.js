import { describe, expect, it } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { executeConfirmedAction } from "../../supabase/functions/_shared/assistant/executors.mjs";
import { toolCatalogForModel, buildToolCatalogText, TOOL_REGISTRY, normalizeToolCall } from "../../supabase/functions/_shared/assistant/tools.mjs";
import { corsWrap } from "../../supabase/functions/_shared/cors.mjs";

// Covers the FINAL PRE-MERGE hardening: mandatory confirm secret, real tool
// catalog (no sensitive tools), two-stage model loop, prepare-time booking id
// binding + crash-retry idempotency, post-patch update validation, fail-closed
// cancellation, the payment-link prepare/confirm pair, and thread lifecycle.

const SECRET = "hard-secret";

function docWith(bookings = [], chaletOver = {}) {
  return {
    schema_version: 3, settings: {},
    chalets: [{ id: "c1", name: "شاليه", capacity: 4, deleted_at: null, periods: [
      { id: "p1", label: "صباحي", start: "07:00", end: "17:00", active: true, sort: 1 },
      { id: "p2", label: "مسائي", start: "19:00", end: "23:00", active: true, sort: 2 },
    ], ...chaletOver }],
    bookings,
  };
}

function makeHarness({ env = { ASSISTANT_CONFIRM_SECRET: SECRET }, model, workspaces, ledgerFail = false, provider = false } = {}) {
  const ws = workspaces || { WSA: { pin: "123456", doc: docWith(), revision: 1 } };
  const actions = new Map();
  const threads = new Map();
  const ledger = new Map();
  let seq = 0, threadSeq = 0;

  const execDeps = {
    env: provider ? { PAYMENT_PROVIDER: "test", APP_ENV: "test", PAYMENTS_ALLOW_TEST_PROVIDER: "true", PAYMENT_WEBHOOK_SECRET: "x" } : {},
    newId: () => "bk-" + (++seq),
    async getWorkspaceDoc(k) { const w = ws[k]; return w ? { data: w.doc, updated_at: String(w.revision) } : null; },
    async saveWorkspaceV2(k, pin, data, expectedRevision) {
      const w = ws[k];
      if (!w || w.pin !== pin) return { ok: false, error: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
      if (String(w.revision) !== String(expectedRevision)) return { ok: false, error: "STALE_REVISION" };
      w.doc = data; w.revision += 1;
      return { ok: true, updated_at: String(w.revision), data: w.doc };
    },
    async recordManualPayment() { return { ok: true, transaction_id: "tx-1" }; },
    async createPaymentSession(k, pin, p) {
      if (!provider) return { ok: false, error: "NO_PROVIDER_CONFIGURED" };
      return { ok: true, order: { id: "ord-" + p.idempotency_key, payment_url: "https://pay.test.invalid/x", status: "pending" } };
    },
    async getBookingPayments(k, pin, bookingId) {
      if (ledgerFail) throw new Error("ledger down");
      return { ok: true, net_paid_halalas: ledger.get(k + "|" + bookingId) || 0 };
    },
    async resolveCustomerPhone() { return ""; },
    async sendOfficialWhatsApp() { return { ok: false, error: "OFFICIAL_WHATSAPP_NOT_WIRED" }; },
    async recordOutbound() {},
  };

  const deps = {
    env,
    _ws: ws, _actions: actions, _threads: threads, _ledger: ledger,
    newId: () => "bk-prep-" + (++seq),
    async auth(k, pin) { const w = ws[k]; return w && w.pin === pin ? { ok: true, workspace_key: k } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" }; },
    async callModel(arg) { return typeof model === "function" ? model(arg) : model; },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision(k) { return ws[k] ? String(ws[k].revision) : null; },
    async runReadTool(_k, name, args) { return { tool: name, args, ok: true }; },
    async createThread(k, title) { const id = "th-" + (++threadSeq); threads.set(id, { id, workspace_key: k, title, status: "active" }); return { ok: true, thread_id: id }; },
    async listThreads(k) { return Array.from(threads.values()).filter((t) => t.workspace_key === k); },
    async archiveThread(k, id) { const t = threads.get(id); if (!t || t.workspace_key !== k) return { ok: false, error: "THREAD_NOT_FOUND" }; t.status = "archived"; return { ok: true }; },
    async threadBelongsToWorkspace(k, id) { const t = threads.get(id); return Boolean(t && t.workspace_key === k); },
    async prepareSensitive(k, spec) {
      const id = "act-" + (actions.size + 1);
      actions.set(id, { id, workspace_key: k, ...spec, status: "prepared", confirmation_used_at: null, safe_result: null, error_code: null });
      return { action_id: id };
    },
    async getConfirmationContext(k, id) { const a = actions.get(id); if (!a || a.workspace_key !== k) return null; return { action: a, tool_name: a.name, action_type: a.actionType, normalized_payload: { tool: a.name, args: a.args } }; },
    async consumeConfirmation(k, id, tokenHash, payloadHash, currentRevision) {
      const a = actions.get(id);
      if (!a || a.workspace_key !== k) return { ok: false, error: "ACTION_NOT_FOUND" };
      if (a.status !== "prepared") return { ok: false, error: "ACTION_NOT_PENDING" };
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      if (a.payloadHash !== payloadHash) return { ok: false, error: "PAYLOAD_CHANGED" };
      if (a.expectedRevision != null && currentRevision != null && String(a.expectedRevision) !== String(currentRevision)) return { ok: false, error: "STALE_REVISION" };
      a.status = "confirmed"; a.confirmation_used_at = "now";
      return { ok: true };
    },
    async getActionOutcome(k, id) { const a = actions.get(id); return a ? { status: a.status, safe_result: a.safe_result, error_code: a.error_code } : {}; },
    async executeConfirmed(k, action) { return await executeConfirmedAction({ wsKey: k, pin: action.pin, toolName: action.tool_name, payload: action.payload, actionId: action.action_id }, execDeps); },
    async finalizeAction(k, id, patch) { const a = actions.get(id); if (a) Object.assign(a, { status: patch.status, safe_result: patch.safe_result_json ?? a.safe_result, error_code: patch.error_code ?? a.error_code }); },
  };
  return { deps, ws, actions, threads };
}

function req(body) { return new Request("https://edge.local/chalet-assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
const call = (deps, body) => handleAssistant(req(body), deps).then((r) => r.json().then((b) => ({ status: r.status, body: b })));
const prepare = (deps, k, pin, name, args) => call(deps, { workspace_key: k, access_pin: pin, invoke_tool: { name, arguments: args } });
const confirm = (deps, k, pin, tool, action_id, token) => call(deps, { workspace_key: k, access_pin: pin, invoke_tool: { name: tool, arguments: { action_id, confirmation_token: token } } });

describe("model tool catalog (Stage 2)", () => {
  it("exposes read + prepare tools ONLY — never a confirmation / sensitive tool", () => {
    const names = toolCatalogForModel().map((t) => t.name);
    const sensitive = Object.keys(TOOL_REGISTRY).filter((n) => TOOL_REGISTRY[n].class === "sensitive");
    for (const s of sensitive) expect(names).not.toContain(s);
    expect(names).toContain("prepare_payment_link");
    expect(names).toContain("get_today_bookings");
    expect(names).not.toContain("confirm_payment_link");
    // The prompt catalog text also omits every confirmation.
    const text = buildToolCatalogText();
    expect(text).toContain("prepare_payment_link");
    expect(text).not.toContain("confirm_payment_link");
    expect(text).not.toContain("confirm_manual_payment");
  });
});

describe("boolean arg validation (strict parse)", () => {
  it("the string \"false\" parses to false (a PAID booking), never coerced to true/«مجاني»", () => {
    const norm = normalizeToolCall({
      name: "prepare_booking_create",
      arguments: { customer_name: "علي", chalet_name: "شاليه", booking_date: "2099-06-01", period_label: "صباحي", guests: 2, total: 500, total_is_free: "false" },
    });
    // The old Boolean("false") === true forged «مجاني» on a 500-riyal booking.
    expect(norm.ok).toBe(true);
    expect(norm.args.total_is_free).toBe(false);
  });
  it("a non-boolean garbage string is rejected, not silently coerced", () => {
    const norm = normalizeToolCall({
      name: "prepare_booking_create",
      arguments: { customer_name: "علي", chalet_name: "شاليه", booking_date: "2099-06-01", period_label: "صباحي", guests: 2, total: 0, total_is_free: "نعم" },
    });
    expect(norm.ok).toBe(false);
    expect(String(norm.detail)).toContain("TYPE:total_is_free");
  });
  it("real booleans and the exact strings true/false parse correctly", () => {
    const t = normalizeToolCall({ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "ش", booking_date: "2099-06-01", period_label: "صباحي", guests: 2, total: 0, total_is_free: true } });
    expect(t.ok).toBe(true);
    expect(t.args.total_is_free).toBe(true);
    const s = normalizeToolCall({ name: "prepare_booking_create", arguments: { customer_name: "علي", chalet_name: "ش", booking_date: "2099-06-01", period_label: "صباحي", guests: 2, total: 0, total_is_free: "true" } });
    expect(s.ok).toBe(true);
    expect(s.args.total_is_free).toBe(true);
  });
});

describe("mandatory ASSISTANT_CONFIRM_SECRET (Stage 6)", () => {
  it("without the secret, a prepare fails CLOSED but a read still works", async () => {
    const { deps } = makeHarness({ env: {} });
    const prep = await prepare(deps, "WSA", "123456", "prepare_booking_cancel", { booking_id: "b1" });
    expect(prep.body.error).toBe("ASSISTANT_CONFIRM_SECRET_MISSING");
    const read = await prepare(deps, "WSA", "123456", "get_today_bookings", {});
    expect(read.body.ok).toBe(true);
    expect(read.body.kind).toBe("read");
  });
  it("without the secret, a confirm fails CLOSED (no execution)", async () => {
    const { deps } = makeHarness({ env: {} });
    const res = await confirm(deps, "WSA", "123456", "confirm_manual_payment", "x", "y");
    expect(res.body.error).toBe("ASSISTANT_CONFIRM_SECRET_MISSING");
  });
});

describe("two-stage model loop (Stage 3)", () => {
  it("calls the model twice: request tools, then a grounded reply", async () => {
    let n = 0;
    const model = () => { n++; return n === 1
      ? { ok: true, reply: "لحظة أتحقق", toolCalls: [{ name: "get_today_bookings", arguments: {} }] }
      : { ok: true, reply: "لا يوجد حجوزات اليوم.", toolCalls: [] }; };
    const { deps } = makeHarness({ model });
    const res = await call(deps, { workspace_key: "WSA", access_pin: "123456", message: "حجوزات اليوم؟" });
    expect(n).toBe(2);
    expect(res.body.model_calls).toBe(2);
    expect(res.body.reply_ar).toBe("لا يوجد حجوزات اليوم."); // the grounded (second) reply
    expect(res.body.tool_results[0].tool).toBe("get_today_bookings");
  });
  it("falls back to a deterministic Arabic render when the grounding call fails", async () => {
    let n = 0;
    const model = () => { n++; return n === 1
      ? { ok: true, reply: "", toolCalls: [{ name: "get_today_bookings", arguments: {} }] }
      : { ok: false, error: "DEEPSEEK_TIMEOUT" }; };
    const { deps } = makeHarness({ model });
    const res = await call(deps, { workspace_key: "WSA", access_pin: "123456", message: "حجوزات؟" });
    expect(res.body.ok).toBe(true);
    expect(res.body.reply_ar.length).toBeGreaterThan(0); // still produced grounded text
  });
});

describe("prepare-time booking id binding + crash-retry idempotency (Stage 6)", () => {
  it("re-executing the SAME confirmed create (bound id) makes exactly one booking", async () => {
    const { ws } = makeHarness();
    const execDeps = {
      newId: () => "should-not-be-used",
      async getWorkspaceDoc(k) { const w = ws[k]; return { data: w.doc, updated_at: String(w.revision) }; },
      async saveWorkspaceV2(k, pin, data) { ws[k].doc = data; ws[k].revision += 1; return { ok: true, updated_at: String(ws[k].revision), data: ws[k].doc }; },
    };
    const payload = { args: { booking_id: "bound-1", customer_name: "علي", chalet_id: "c1", period_id: "p1", booking_date: "2099-06-01", total: 900, guests: 2 } };
    const first = await executeConfirmedAction({ wsKey: "WSA", pin: "123456", toolName: "confirm_booking_create", payload, actionId: "a1" }, execDeps);
    const second = await executeConfirmedAction({ wsKey: "WSA", pin: "123456", toolName: "confirm_booking_create", payload, actionId: "a1" }, execDeps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.safe_result.duplicate).toBe(true);
    expect(ws.WSA.doc.bookings.filter((b) => b.id === "bound-1")).toHaveLength(1);
  });

  it("an existing id is idempotent only when it is the SAME booking", async () => {
    const existing = { id: "bound-1", customer_name: "سجل مختلف", chalet_id: "c1", period_id: "p2", booking_date: "2099-06-02", total: 100, paid: 0, guests: 1, status: "confirmed", deleted_at: null };
    const ws = { WSA: { doc: docWith([existing]), revision: 1 } };
    const deps = {
      async getWorkspaceDoc(k) { return { data: ws[k].doc, updated_at: String(ws[k].revision) }; },
      async saveWorkspaceV2() { throw new Error("a collision must never write"); },
    };
    const result = await executeConfirmedAction({
      wsKey: "WSA", pin: "123456", toolName: "confirm_booking_create", actionId: "a-collision",
      payload: { args: { booking_id: "bound-1", customer_name: "مهره", chalet_id: "c1", period_id: "p1", booking_date: "2099-06-01", total: 450, guests: 2 } },
    }, deps);
    expect(result).toMatchObject({ ok: false, error: "BOOKING_ID_CONFLICT" });
  });

  it("the executor rejects impossible and past dates even if prepare validation was bypassed", async () => {
    const ws = { WSA: { doc: docWith(), revision: 1 } };
    const deps = {
      async getWorkspaceDoc(k) { return { data: ws[k].doc, updated_at: String(ws[k].revision) }; },
      async saveWorkspaceV2() { throw new Error("invalid dates must never reach save"); },
    };
    for (const [booking_date, error] of [["2026-02-31", "INVALID_DATE"], ["2025-04-07", "PAST_DATE"]]) {
      const result = await executeConfirmedAction({
        wsKey: "WSA", pin: "123456", toolName: "confirm_booking_create", actionId: "a-" + booking_date,
        payload: { args: { booking_id: "bk-" + booking_date, customer_name: "مهره", chalet_id: "c1", period_id: "p1", booking_date, total: 450, guests: 2 } },
      }, deps);
      expect(result).toMatchObject({ ok: false, error });
    }
  });

  it("never reports created when the atomic save echo does not contain the exact booking", async () => {
    const ws = { WSA: { doc: docWith(), revision: 1 } };
    const deps = {
      async getWorkspaceDoc(k) { return { data: ws[k].doc, updated_at: String(ws[k].revision) }; },
      async saveWorkspaceV2() {
        return { ok: true, updated_at: "2", data: docWith() };
      },
    };
    const result = await executeConfirmedAction({
      wsKey: "WSA", pin: "123456", toolName: "confirm_booking_create", actionId: "a-verify",
      payload: { args: { booking_id: "bk-verify", customer_name: "مهره", chalet_id: "c1", period_id: "p1", booking_date: "2099-06-01", total: 450, guests: 2 } },
    }, deps);
    expect(result).toMatchObject({ ok: false, error: "SAVE_VERIFICATION_FAILED" });
  });
});

describe("post-patch update validation (Stage 7)", () => {
  const withBooking = () => ({ WSA: { pin: "123456", doc: docWith([{ id: "b1", customer_name: "س", chalet_id: "c1", booking_date: "2099-07-01", period_id: "p1", total: 500, paid: 100, guests: 2, status: "confirmed", deleted_at: null }]), revision: 1 } });
  it("updating onto a non-existent chalet is rejected", async () => {
    const { deps } = makeHarness({ workspaces: withBooking() });
    const prep = await prepare(deps, "WSA", "123456", "prepare_booking_update", { booking_id: "b1", chalet_id: "ghost" });
    const res = await confirm(deps, "WSA", "123456", "confirm_booking_update", prep.body.action_id, prep.body.confirmation_token);
    expect(res.body.error).toBe("CHALET_NOT_FOUND");
  });
  it("updating guests beyond capacity is rejected", async () => {
    const { deps } = makeHarness({ workspaces: withBooking() });
    const prep = await prepare(deps, "WSA", "123456", "prepare_booking_update", { booking_id: "b1", guests: 99 });
    const res = await confirm(deps, "WSA", "123456", "confirm_booking_update", prep.body.action_id, prep.body.confirmation_token);
    expect(res.body.error).toBe("GUESTS_EXCEED_CAPACITY");
  });
});

describe("fail-closed cancellation (Stage 7)", () => {
  const withBooking = (paidHalalas = 0) => {
    const h = makeHarness({ workspaces: { WSA: { pin: "123456", doc: docWith([{ id: "b1", customer_name: "س", chalet_id: "c1", booking_date: "2099-07-01", period_id: "p1", total: 500, paid: 0, guests: 1, status: "confirmed", deleted_at: null }]), revision: 1 } } });
    if (paidHalalas) h.deps._ledger.set("WSA|b1", paidHalalas);
    return h;
  };
  it("a payment-check failure aborts the cancel (no silent continue)", async () => {
    const h = makeHarness({ ledgerFail: true, workspaces: { WSA: { pin: "123456", doc: docWith([{ id: "b1", customer_name: "س", chalet_id: "c1", booking_date: "2099-07-01", period_id: "p1", total: 500, paid: 0, guests: 1, status: "confirmed", deleted_at: null }]), revision: 1 } } });
    const prep = await prepare(h.deps, "WSA", "123456", "prepare_booking_cancel", { booking_id: "b1" });
    const res = await confirm(h.deps, "WSA", "123456", "confirm_booking_cancel", prep.body.action_id, prep.body.confirmation_token);
    expect(res.body.error).toBe("PAYMENT_CHECK_FAILED");
    expect(h.ws.WSA.doc.bookings[0].status).toBe("confirmed"); // NOT cancelled
  });
  it("a paid booking cancels WITH a no-auto-refund warning + paid amount", async () => {
    const h = withBooking(20000);
    const prep = await prepare(h.deps, "WSA", "123456", "prepare_booking_cancel", { booking_id: "b1" });
    const res = await confirm(h.deps, "WSA", "123456", "confirm_booking_cancel", prep.body.action_id, prep.body.confirmation_token);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.warning).toBe("HAS_RECORDED_PAYMENTS_NO_AUTO_REFUND");
    expect(res.body.result.paid_halalas).toBe(20000);
    expect(h.ws.WSA.doc.bookings[0].status).toBe("cancelled");
  });
});

describe("payment-link prepare/confirm pair (Stage 6)", () => {
  it("prepare then confirm creates a real order when a provider is configured", async () => {
    const { deps } = makeHarness({ provider: true, workspaces: { WSA: { pin: "123456", doc: docWith([{ id: "b1", customer_name: "س", chalet_id: "c1", booking_date: "2099-07-01", period_id: "p1", total: 500, paid: 0, guests: 1, status: "confirmed", deleted_at: null }]), revision: 1 } } });
    const prep = await prepare(deps, "WSA", "123456", "prepare_payment_link", { booking_id: "b1", amount_halalas: 50000 });
    expect(prep.body.confirm_tool).toBe("confirm_payment_link");
    const res = await confirm(deps, "WSA", "123456", "confirm_payment_link", prep.body.action_id, prep.body.confirmation_token);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.order_id).toBeTruthy();
    expect(res.body.result.payment_url).toContain("https://");
  });
});

describe("thread lifecycle (Stage 5)", () => {
  it("create returns a thread id; a foreign thread on chat is rejected; missing thread auto-creates", async () => {
    const { deps } = makeHarness({ model: { ok: true, reply: "أهلاً", toolCalls: [] } });
    const created = await call(deps, { workspace_key: "WSA", access_pin: "123456", thread_action: "create", title: "محادثة" });
    expect(created.body.thread_id).toBeTruthy();
    // a thread id that does not belong to the workspace => 404
    const foreign = await call(deps, { workspace_key: "WSA", access_pin: "123456", thread_id: "th-does-not-exist", message: "مرحبا" });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe("THREAD_NOT_FOUND");
    // no thread id => the handler opens one and returns it
    const auto = await call(deps, { workspace_key: "WSA", access_pin: "123456", message: "مرحبا" });
    expect(auto.body.thread_id).toBeTruthy();
  });
  it("archive validates workspace ownership", async () => {
    const { deps } = makeHarness();
    const created = await call(deps, { workspace_key: "WSA", access_pin: "123456", thread_action: "create" });
    const ok = await call(deps, { workspace_key: "WSA", access_pin: "123456", thread_action: "archive", thread_id: created.body.thread_id });
    expect(ok.body.ok).toBe(true);
    const missing = await call(deps, { workspace_key: "WSA", access_pin: "123456", thread_action: "archive", thread_id: "nope" });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Edge envelope: an uncaught handler crash must STILL answer as JSON with the
// CORS allow-origin header — a bare 500 without it renders as «تعذّر الاتصال»
// on the phone (live incident IMG_6702) and hides the real fault.
// ---------------------------------------------------------------------------

describe("edge envelope (corsWrap)", () => {
  const APP_ORIGIN = "https://qw1qw66-sudo.github.io";

  it("a throwing handler returns JSON 500 WITH allow-origin and a clean Arabic reason", async () => {
    const req = new Request("https://edge.local/fn", { method: "POST", headers: { origin: APP_ORIGIN } });
    const res = await corsWrap(req, {}, () => {
      throw new Error("boom sk-SECRETSECRETSECRET details");
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "EDGE_CRASH", public_code: "unavailable", recoverable: true });
    expect(body.reason_ar).toContain("لم يتغيّر شيء");
    // The crash detail (and anything secret-shaped in it) never reaches the body.
    expect(JSON.stringify(body)).not.toMatch(/boom|sk-/);
  });

  it("a rejecting async handler is caught the same way", async () => {
    const req = new Request("https://edge.local/fn", { method: "POST", headers: { origin: APP_ORIGIN } });
    const res = await corsWrap(req, {}, async () => Promise.reject(new TypeError("cannot read x of undefined")));
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect((await res.json()).error).toBe("EDGE_CRASH");
  });

  it("successful responses and preflights are unchanged", async () => {
    const pre = await corsWrap(new Request("https://edge.local/fn", { method: "OPTIONS", headers: { origin: APP_ORIGIN } }), {}, () => {
      throw new Error("handler must not run on preflight");
    });
    expect(pre.status).toBe(204);
    const okRes = await corsWrap(new Request("https://edge.local/fn", { method: "POST", headers: { origin: APP_ORIGIN } }), {}, async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });
});
