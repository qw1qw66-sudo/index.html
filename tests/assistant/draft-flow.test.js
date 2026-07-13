import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleAssistant, PENDING_ANSWER_KINDS } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { resolveBookingCreateArgs } from "../../supabase/functions/_shared/assistant/booking-resolution.mjs";
import { riyadhToday, addDays, availabilityCheck, availabilityFailureAr } from "../../supabase/functions/_shared/assistant/availability.mjs";

// The deterministic Booking Agent: a server-owned per-thread draft collects
// fields ACROSS messages with ZERO model calls, never re-asks known data,
// never invents guests/total, survives refresh via token rotation, recovers
// from stale revisions with a FRESH card, and answers conflicts with real
// alternatives. Typed confirmation words never execute anything.

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WSD";
const TODAY = riyadhToday(Date.now());
const TOMORROW = addDays(TODAY, 1);

function fixtureDoc() {
  return {
    chalets: [
      {
        id: "tulum", name: "شاليه تولوم", capacity: 15, deleted_at: null,
        periods: [
          { id: "t-am", label: "صباحي", start: "07:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 450 },
          { id: "t-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 400, weekend_price: 600 },
        ],
      },
      {
        id: "sky", name: "شاليه سكاي", capacity: 6, deleted_at: null,
        periods: [{ id: "s-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 1, weekday_price: 350, weekend_price: 500 }],
      },
    ],
    bookings: [],
  };
}

function makeDeps({ doc = fixtureDoc(), modelSeq = [{ ok: false, error: "DEEPSEEK_UNREACHABLE" }] } = {}) {
  let call = 0;
  const modelCalls = [];
  const drafts = new Map(); // threadId -> { fields, private, status, linked }
  const actions = new Map();
  let actionSeq = 0;
  const executed = [];
  const deps = {
    env: ENV,
    _modelCalls: modelCalls,
    _drafts: drafts,
    _actions: actions,
    _executed: executed,
    _doc: doc,
    async auth(k, pin) {
      return k === WS && pin === "123456" ? { ok: true, workspace_key: WS } : { ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" };
    },
    async callModel(arg) {
      modelCalls.push(arg);
      const r = modelSeq[Math.min(call, modelSeq.length - 1)];
      call++;
      return r;
    },
    async activeMemories() { return []; },
    async loadHistory() { return []; },
    async appendMessages() {},
    async getWorkspaceRevision() { return "rev-1"; },
    async getWorkspaceData() { return { data: doc, updated_at: "rev-1" }; },
    async runReadTool() { return {}; },
    async resolveBookingCreateArgs(_k, args) { return resolveBookingCreateArgs(doc, args); },
    async createThread() { return { ok: true, thread_id: "th-1" }; },
    async threadBelongsToWorkspace() { return true; },
    newId: () => "bk-" + (actionSeq + 1),
    async getActiveDraft(_k, threadId) {
      const d = drafts.get(threadId);
      return d && d.status === "active" ? { id: threadId, fields: d.fields, linked_action_id: d.linked || null } : null;
    },
    async getDraftPrivate(_k, threadId) {
      const d = drafts.get(threadId);
      return d && d.status === "active" ? d.private : {};
    },
    async upsertDraft(_k, threadId, fields, privateFields, linked) {
      const prev = drafts.get(threadId) || { private: {}, status: "active" };
      drafts.set(threadId, {
        fields,
        private: privateFields || prev.private || {},
        status: "active",
        linked: linked !== undefined ? linked : prev.linked,
      });
      return { draft_id: threadId };
    },
    async closeDraft(_k, threadId, status) {
      const d = drafts.get(threadId);
      if (d) d.status = status;
    },
    async prepareSensitive(_k, spec) {
      const id = "act-" + ++actionSeq;
      actions.set(id, { id, workspace_key: _k, ...spec, status: "prepared", confirmation_used_at: null });
      return { action_id: id };
    },
    async getConfirmationContext(_k, id) {
      const a = actions.get(id);
      if (!a || a.workspace_key !== _k) return null;
      return {
        action: a, tool_name: a.name, action_type: a.actionType,
        normalized_payload: { tool: a.name, args: a.args },
        thread_id: a.threadId || null, status: a.status,
        confirmation_expires_at: new Date(a.expiresAtMs).toISOString(),
      };
    },
    async getLatestPreparedAction(_k) {
      const rows = [...actions.values()].filter((a) => a.status === "prepared" && !a.confirmation_used_at);
      const row = rows[rows.length - 1];
      if (!row) return null;
      return {
        id: row.id,
        normalized_payload_json: { tool: row.name, args: row.args },
        thread_id: row.threadId || null,
        confirmation_expires_at: new Date(row.expiresAtMs).toISOString(),
        status: row.status,
      };
    },
    async rotateConfirmation(_k, id, patch) {
      const a = actions.get(id);
      if (!a || a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "ROTATE_FAILED" };
      a.tokenHash = patch.tokenHash;
      a.expiresAtMs = patch.expiresAtMs;
      return { ok: true };
    },
    async consumeConfirmation(_k, id, tokenHash) {
      const a = actions.get(id);
      if (!a) return { ok: false, error: "ACTION_NOT_FOUND" };
      if (a.status !== "prepared" || a.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" };
      if (a.forceStale) return { ok: false, error: "STALE_REVISION" };
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      a.status = "confirmed";
      a.confirmation_used_at = "now";
      return { ok: true };
    },
    async executeConfirmed(_k, action) {
      executed.push(action);
      // Reflect the write in the doc so counts stay truthful.
      const args = action.payload.args;
      doc.bookings.push({ id: args.booking_id, customer_name: args.customer_name, chalet_id: args.chalet_id, booking_date: args.booking_date, period_id: args.period_id, guests: args.guests, total: args.total, paid: 0, status: "confirmed", deleted_at: null });
      return { ok: true, result_reference: args.booking_id, safe_result: { booking_id: args.booking_id, action: "booking_created" } };
    },
    async finalizeAction(_k, id, patch) { const a = actions.get(id); if (a) Object.assign(a, patch); },
  };
  return deps;
}

const post = (deps, body) => handleAssistant(
  new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_key: WS, access_pin: "123456", ...body }) }),
  deps,
).then((r) => r.json());
const chat = (deps, message, threadId) => post(deps, { message, ...(threadId ? { thread_id: threadId } : {}) });

describe("booking agent draft flow (deterministic, zero model calls)", () => {
  it("collects fields across four messages and never re-asks known data", async () => {
    const deps = makeDeps();
    const t1 = await chat(deps, "احجز تولوم");
    expect(t1.ok).toBe(true);
    expect(t1.model_calls).toBe(0);
    expect(t1.reply_ar.length).toBeGreaterThan(0);
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");

    const t2 = await chat(deps, "بكرة بالليل", "th-1");
    expect(t2.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.booking_date).toBe(TOMORROW);
    expect(deps._drafts.get("th-1").fields.period_id).toBe("t-pm"); // «بالليل» -> مسائي

    const t3 = await chat(deps, "أربعة", "th-1");
    expect(deps._drafts.get("th-1").fields.guests).toBe(4);
    // Suggested price question mentions the system price and needs acceptance.
    expect(t3.reply_ar).toContain("سعر النظام");

    const t4 = await chat(deps, "500 ريال، العميل علي تجربة", "th-1");
    expect(t4.model_calls).toBe(0);
    const prep = (t4.tool_results || []).find((r) => r.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(prep.card && Array.isArray(prep.card.rows)).toBe(true);
    // Never re-asks: no date/guest question in the final turn.
    expect(t4.reply_ar).not.toContain("أي يوم");
    expect(t4.reply_ar).not.toContain("كم عدد الضيوف");
    // Nothing executed before the button tap.
    expect(deps._executed).toHaveLength(0);
  });

  it("accepting the suggested system price completes the draft without inventing a total", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز سكاي باسم فهد تجربة");
    await chat(deps, "بكرة بالليل", "th-1");
    const q = await chat(deps, "شخصين", "th-1");
    expect(q.reply_ar).toContain("سعر النظام");
    const done = await chat(deps, "اعتمده", "th-1");
    const prep = (done.tool_results || []).find((r) => r.kind === "prepared_action");
    expect(prep).toBeTruthy();
    // Weekday/weekend price of s-pm — a REAL system price, explicitly accepted.
    const total = deps._actions.get(prep.action_id).args.total;
    expect([350, 500]).toContain(total);
  });

  it("typed «سجل» re-displays the card with a ROTATED token and executes nothing", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز تولوم بكرة بالليل لأربعة أشخاص بخمسمئة ريال، العميل علي تجربة");
    const first = [...deps._actions.values()][0];
    expect(first).toBeTruthy();
    const oldHash = first.tokenHash;
    const r = await chat(deps, "سجل", "th-1");
    expect(r.model_calls).toBe(0);
    const again = (r.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(again.action_id).toBe(first.id);
    expect(r.reply_ar).toContain("راجع البطاقة");
    expect(deps._actions.get(first.id).tokenHash).not.toBe(oldHash); // rotated
    expect(deps._executed).toHaveLength(0);
  });

  it("pending_action:latest rotates the token; the OLD token then fails to confirm", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    const oldToken = prep.confirmation_token;
    const rec = await post(deps, { pending_action: "latest" });
    expect(rec.pending.action_id).toBe(prep.action_id);
    expect(rec.pending.confirmation_token).not.toBe(oldToken);
    // Old token is dead.
    const dead = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: oldToken } } });
    expect(dead.ok).toBe(false);
    expect(deps._executed).toHaveLength(0);
    // New token works — exactly one execution.
    const okc = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: rec.pending.confirmation_token } } });
    expect(okc.ok).toBe(true);
    expect(deps._executed).toHaveLength(1);
  });

  it("an EXPIRED pending action is re-prepared as a FRESH card, not an error", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    deps._actions.get(prep.action_id).expiresAtMs = Date.now() - 1000;
    const rec = await post(deps, { pending_action: "latest" });
    expect(rec.pending).toBeTruthy();
    expect(rec.pending.action_id).not.toBe(prep.action_id); // fresh action
    expect(deps._actions.get(prep.action_id).status).toBe("expired");
    expect(deps._executed).toHaveLength(0);
  });

  it("a STALE_REVISION confirm returns a FRESH card in the same response and never auto-executes", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    deps._actions.get(prep.action_id).forceStale = true;
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.fresh_action && r.fresh_action.action_id).toBeTruthy();
    expect(r.fresh_action.action_id).not.toBe(prep.action_id);
    expect(r.reason_ar).toContain("تغيّرت بيانات");
    expect(r.reason_ar).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    expect(deps._executed).toHaveLength(0);
  });

  it("إلغاء closes the draft and rejects the pending action; nothing was saved", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    const r = await post(deps, { draft_action: "cancel", action_id: prep.action_id, thread_id: "th-1" });
    expect(r.ok).toBe(true);
    expect(deps._drafts.get("th-1").status).toBe("cancelled");
    expect(deps._actions.get(prep.action_id).status).toBe("rejected");
    expect(deps._executed).toHaveLength(0);
    expect(deps._doc.bookings).toHaveLength(0);
  });

  it("a conflict answers with REAL numbered alternatives and a pick binds one", async () => {
    const doc = fixtureDoc();
    // Occupy تولوم's evening slot tomorrow.
    doc.bookings.push({ id: "b-x", customer_name: "سابق", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("محجوزة");
    expect(r.reply_ar).toContain("1.");
    expect(r.reply_ar).not.toMatch(/BOOKING_CONFLICT|[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeLessThanOrEqual(3);
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(false);
    // Picking option 1 binds it and moves the draft forward (a card appears —
    // all other fields were already provided).
    const pick = await chat(deps, "١", "th-1");
    const prep = (pick.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(deps._executed).toHaveLength(0);
  });

  it("«نعم» accepts a pending suggested price (bare-confirm passes the message through)", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز سكاي باسم فهد تجربة");
    await chat(deps, "بكرة بالليل", "th-1");
    const q = await chat(deps, "شخصين", "th-1");
    expect(q.reply_ar).toContain("سعر النظام");
    // «نعم» is a bare confirm word — it must ACCEPT the suggestion, not loop.
    const done = await chat(deps, "نعم", "th-1");
    const prep = (done.tool_results || []).find((r) => r.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(done.reply_ar).not.toContain("سعر النظام"); // question not re-asked
  });

  it("«الحجز مجاني» flows end-to-end: prepared with total 0 + explicit free flag, executor accepts", async () => {
    const deps = makeDeps();
    const q = await chat(deps, "احجز تولوم بكرة بالليل لشخصين، العميل سعيد تجربة");
    expect(q.reply_ar).toContain("سعر"); // total still missing -> asked
    const done = await chat(deps, "الحجز مجاني", "th-1");
    const prep = (done.tool_results || []).find((r) => r.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const args = deps._actions.get(prep.action_id).args;
    expect(args.total).toBe(0);
    expect(args.total_is_free).toBe(true);
    const okc = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(okc.ok).toBe(true);
    expect(deps._doc.bookings[0].total).toBe(0);
  });

  it("an EXPIRED token at CONFIRM time returns a fresh card in the 409 (never a dead end)", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    const a = deps._actions.get(prep.action_id);
    a.expiresAtMs = Date.now() - 1000;
    // Make the mock enforce expiry like the SQL RPC does.
    const origConsume = deps.consumeConfirmation;
    deps.consumeConfirmation = async (k, id, tokenHash) => {
      const row = deps._actions.get(id);
      if (row && row.status === "prepared" && Date.now() > row.expiresAtMs) return { ok: false, error: "CONFIRMATION_EXPIRED" };
      return origConsume(k, id, tokenHash);
    };
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.fresh_action && r.fresh_action.action_id).toBeTruthy();
    expect(r.fresh_action.action_id).not.toBe(prep.action_id);
    expect(deps._actions.get(prep.action_id).status).toBe("expired");
    expect(deps._executed).toHaveLength(0);
  });

  it("a later correction re-binds: new date recomputes the suggested price; a bare numeral answers guests (not a stale pick)", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز تولوم بكرة بالليل", "th-1");
    await chat(deps, "احجز تولوم بكرة بالليل"); // ensure thread th-1 opened
    const f0 = deps._drafts.get("th-1").fields;
    expect(f0.period_id).toBe("t-pm");
    // Correction: push the date two days out — the draft must follow.
    await chat(deps, "خله بعد بكرة", "th-1");
    const f1 = deps._drafts.get("th-1").fields;
    expect(f1.booking_date).toBe(addDays(TODAY, 2));
    // A bare numeral now answers the guests question — it must NOT be
    // swallowed as a conflict-alternative pick (none are pending).
    await chat(deps, "٢", "th-1");
    expect(deps._drafts.get("th-1").fields.guests).toBe(2);
  });

  it("Persian digits and DD-MM-YYYY answers parse through a real chat turn", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز تولوم بالليل");
    const target = addDays(TODAY, 20);
    const ddmm = target.split("-").reverse().join("-"); // DD-MM-YYYY
    await chat(deps, ddmm, "th-1");
    expect(deps._drafts.get("th-1").fields.booking_date).toBe(target);
    await chat(deps, "۴ اشخاص", "th-1"); // Persian four
    expect(deps._drafts.get("th-1").fields.guests).toBe(4);
  });

  it("mid-draft «بعد بكرا» applies; garbled date wording gets ONE deterministic clarify, zero model calls", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز تولوم بالليل");
    // The alif spelling the owner actually typed on the iPhone (live bug B).
    const r1 = await chat(deps, "التاريخ بعد بكرا", "th-1");
    expect(r1.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.booking_date).toBe(addDays(TODAY, 2));
    // Date-ish wording the parser cannot read: a precise clarify question —
    // never the model's «لم أفهم هذا الطلب كأمر مدعوم» dead end.
    const r2 = await chat(deps, "يوم الفلاني", "th-1");
    expect(r2.model_calls).toBe(0);
    expect(r2.reply_ar).toContain("لم أفهم التاريخ");
    expect(r2.reply_ar).not.toContain("كأمر مدعوم");
    expect(deps._modelCalls).toHaveLength(0);
    // The draft was not corrupted by the clarify turn.
    expect(deps._drafts.get("th-1").fields.booking_date).toBe(addDays(TODAY, 2));
  });

  it("a confirm-time conflict is NOT a dead end: names the blocker, returns numbered alternatives, draft stays active, a pick re-prepares", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    // Another channel takes the slot BETWEEN prepare and confirm, and the
    // executor (like the real one) fails closed on the overlap.
    deps._doc.bookings.push({ id: "b-race", customer_name: "منافس تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    deps.executeConfirmed = async (_k, action) => {
      const args = action.payload.args;
      const chalet = deps._doc.chalets.find((c) => c.id === args.chalet_id);
      const period = (chalet.periods || []).find((p) => p.id === args.period_id);
      const check = availabilityCheck(deps._doc, args.chalet_id, args.booking_date, period);
      if (!check.available) {
        const fail = availabilityFailureAr(check);
        return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
      }
      return { ok: true, result_reference: "x", safe_result: { booking_id: "x", action: "booking_created" } };
    };
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("completed_action");
    expect(r.public_code).toBe("conflict");
    expect(r.reason_ar).toContain("محجوزة");
    expect(r.reason_ar).toContain("منافس تجريبي"); // WHICH booking blocks
    expect(r.reason_ar).toContain("1."); // numbered alternatives inline
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeGreaterThan(0);
    expect(r.reason_ar).not.toMatch(/[A-Z]{2,}_[A-Z]|[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(deps._doc.bookings.filter((b) => b.id !== "b-race")).toHaveLength(0); // nothing saved
    // The draft survived (it closes ONLY on success) and remembers the options.
    expect(deps._drafts.get("th-1").status).toBe("active");
    expect((deps._drafts.get("th-1").fields.alternatives || []).length).toBeGreaterThan(0);
    // «١» on the next turn binds option 1 and produces a NEW card.
    const pick = await chat(deps, "١", "th-1");
    const again = (pick.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(again).toBeTruthy();
    expect(again.action_id).not.toBe(prep.action_id);
  });

  it("stale-at-confirm WITH a real conflict retires the card and still returns alternatives", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    // A competing booking lands first, so the revision moved (forceStale
    // mimics the RPC) AND revalidation finds the slot taken.
    deps._doc.bookings.push({ id: "b-race", customer_name: "منافس تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    deps._actions.get(prep.action_id).forceStale = true;
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.fresh_action).toBeFalsy(); // revalidation cannot hand back a card
    expect(r.action_retired).toBe(true); // the frontend removes the dead card
    expect(r.public_code).toBe("conflict");
    expect(r.reason_ar).toContain("منافس تجريبي");
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeGreaterThan(0);
    expect(deps._executed).toHaveLength(0); // nothing was executed
    // The draft survived with the remembered options; «١» re-prepares.
    expect(deps._drafts.get("th-1").status).toBe("active");
    const pick = await chat(deps, "١", "th-1");
    expect((pick.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("a confirm-time DATA-QUALITY block says so («جودة البيانات»), not a plain conflict", async () => {
    const doc = fixtureDoc();
    // A legacy booking whose period has NO times: availability is unprovable.
    doc.chalets[0].periods.push({ id: "t-old", label: "قديمة", start: "", end: "", active: false, sort: 9 });
    const deps = makeDeps({ doc });
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    doc.bookings.push({ id: "b-legacy", customer_name: "قديم تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-old", guests: 2, total: 0, paid: 0, status: "confirmed", deleted_at: null });
    deps.executeConfirmed = async (_k, action) => {
      const args = action.payload.args;
      const chalet = deps._doc.chalets.find((c) => c.id === args.chalet_id);
      const period = (chalet.periods || []).find((p) => p.id === args.period_id);
      const check = availabilityCheck(deps._doc, args.chalet_id, args.booking_date, period);
      if (!check.available) {
        const fail = availabilityFailureAr(check);
        return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
      }
      return { ok: true, result_reference: "x", safe_result: { booking_id: "x", action: "booking_created" } };
    };
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.reason_ar).toContain("جودة البيانات");
    expect(r.reason_ar).toContain("قديم تجريبي");
    expect(r.reason_ar).not.toMatch(/AVAILABILITY_UNPROVABLE/);
  });

  it("CLOSED GUIDED MODE: mid-draft nonsense gets the pending question back — the model is never called", async () => {
    const deps = makeDeps();
    const t1 = await chat(deps, "احجز تولوم");
    expect(t1.reply_ar).toContain("تاريخ"); // pending question = the date
    const r = await chat(deps, "هلا والله شخبارك", "th-1");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(r.reply_ar).toContain("لم أفهم ردّك");
    expect(r.reply_ar).toContain("تاريخ"); // repeats the SAME pending question
    expect(r.reply_ar).toContain("الغِ الحجز");
    // Nothing merged on the fallback turn — the draft is unchanged.
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("date");
  });

  it("«مساء» answers the AM/PM clarify deterministically (and «صباح» keeps the morning)", async () => {
    const deps = makeDeps();
    const q = await chat(deps, "احجز تولوم من 7 الى 12");
    expect(q.reply_ar).toContain("صباحاً أم مساءً");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("time_ampm");
    const r = await chat(deps, "مساء", "th-1");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    const f = deps._drafts.get("th-1").fields;
    // The PM reading (19:00→…) then binds the REAL evening period by its
    // start time — real workspace periods always win over free-text times.
    expect(f.canonical_start).toBe("19:00");
    expect(f.canonical_end).toBe("05:00");
    expect(f.period_id).toBe("t-pm");
    expect(r.reply_ar).not.toContain("صباحاً أم مساءً"); // question not re-asked

    const deps2 = makeDeps();
    await chat(deps2, "احجز تولوم من 7 الى 12");
    await chat(deps2, "صباح", "th-1");
    const f2 = deps2._drafts.get("th-1").fields;
    expect(f2.canonical_start).toBe("07:00");
    expect(f2.canonical_end).toBe("12:00");
    expect(deps2._modelCalls).toHaveLength(0);
  });

  it("pasting the option's own line selects it (times + dashes folded), producing a card", async () => {
    const doc = fixtureDoc();
    doc.bookings.push({ id: "b-x", customer_name: "سابق", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    expect(r.reply_ar).toContain("1.");
    // The owner pastes option 1's printed line back (en/em dashes included).
    const alt = deps._drafts.get("th-1").fields.alternatives[0];
    const pasted = `${alt.chalet_name} — ${alt.date} — ${alt.start}–${alt.end} — ${alt.price || 300} ريال`;
    const pick = await chat(deps, pasted, "th-1");
    expect(pick.model_calls).toBe(0);
    const prep = (pick.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(pick.reply_ar).not.toContain("الوقت غير واضح"); // never re-ambiguous
    const f = deps._drafts.get("th-1").fields;
    expect(f.period_id).toBe(alt.period_id);
    expect(f.time_low_confidence).toBeUndefined();
  });

  it("typed «الغِ الحجز» cancels the draft and retires its prepared action", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const r = await chat(deps, "الغِ الحجز", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.draft_cancelled).toBe(true);
    expect(r.reply_ar).toContain("تم الإلغاء");
    expect(deps._drafts.get("th-1").status).toBe("cancelled");
    expect(deps._actions.get(prep.action_id).status).toBe("rejected");
    expect(deps._executed).toHaveLength(0);
  });

  it("a slot gone stale surfaces on the NEXT answer turn — before any card exists", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز تولوم بكرة بالليل باسم تجربة بمئة ريال"); // guests still missing
    expect(deps._drafts.get("th-1").fields.period_id).toBe("t-pm");
    // A competing booking lands from another device.
    deps._doc.bookings.push({ id: "b-race", customer_name: "منافس تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const r = await chat(deps, "شخصين", "th-1"); // a guests-only answer turn
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("محجوزة");
    expect(r.reply_ar).toContain("منافس تجريبي"); // names the blocker
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(false); // NO card
  });

  it("an unrelated pre-existing conflicting pair does not block a safe card", async () => {
    const doc = fixtureDoc();
    // Two overlapping legacy bookings on تولوم (07-12 vs 11-13). Migration
    // 0007 leaves them untouched but no longer blocks a safe سكاي booking.
    doc.chalets[0].periods.push({ id: "t-mid", label: "ظهيرة", start: "11:00", end: "13:00", active: true, sort: 9 });
    doc.bookings.push(
      { id: "old1", customer_name: "قديم أول", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-am", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "old2", customer_name: "قديم ثاني", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-mid", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    const deps = makeDeps({ doc });
    // A COMPLETE booking on the other chalet — its own slot is free.
    const r = await chat(deps, "احجز سكاي بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    expect(r.model_calls).toBe(0);
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(r.reply_ar).not.toContain("تعارض قائم");
    expect(deps._executed).toHaveLength(0);
  });

  it("drafts are thread-scoped: a new thread starts clean and general chat falls to the model", async () => {
    const deps = makeDeps({ modelSeq: [{ ok: true, reply: "أهلاً!", toolCalls: [] }] });
    await chat(deps, "احجز تولوم"); // creates draft on th-1
    expect(deps._drafts.get("th-1")).toBeTruthy();
    // A general message on ANOTHER thread must not touch th-1's draft and
    // must reach the model (no draft on th-2, no booking intent).
    const r = await chat(deps, "مرحبا كيف الحال", "th-2");
    expect(r.reply_ar).toBe("أهلاً!");
    expect(deps._modelCalls.length).toBeGreaterThan(0);
    expect(deps._drafts.get("th-2")).toBeFalsy();
  });

  it("«سجل حجز …» with content opens the deterministic pipeline (never the model)", async () => {
    const deps = makeDeps();
    const r = await chat(deps, "سجل حجز جديد لعلي تجربة بكرة بالليل في تولوم");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(deps._drafts.get("th-1")).toBeTruthy();
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
  });
});

// R5 «كل سؤال له جواب»: every question the pipeline asks accepts the natural
// bare answer (live IMG_6703: «تولوم» answered our own chalet question and
// got «لم أفهم ردّك» — twice). Zero model calls throughout.
describe("answer matrix: every pending question accepts its bare answer", () => {
  const OPENER_NO_CHALET = "احجز بكرة بالليل لشخصين بمئة ريال باسم علي تجربة";

  it("«تولوم» answers the chalet question — binds and goes straight to the card", async () => {
    const deps = makeDeps();
    const q = await chat(deps, OPENER_NO_CHALET);
    expect(q.reply_ar).toContain("لأي شاليه");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("chalet");
    const r = await chat(deps, "تولوم", "th-1");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum");
    expect(f.period_id).toBe("t-pm"); // stored «بالليل» resolves once bound
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._executed).toHaveLength(0);
  });

  it("«شالية تولوم» (taa-marbuta) answers the chalet question too", async () => {
    const deps = makeDeps();
    await chat(deps, OPENER_NO_CHALET);
    const r = await chat(deps, "شالية تولوم", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("a numbered chalet name answers the chalet question; a bare number still cannot", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].name = "شاليه تولوم 91";
    const deps = makeDeps({ doc });
    await chat(deps, OPENER_NO_CHALET);
    const numeral = await chat(deps, "10", "th-1");
    expect(numeral.reply_ar).toContain("لأي شاليه");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBeUndefined();
    const r = await chat(deps, "شاليه تولوم ٩١", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("an unknown chalet ANSWER re-asks listing the REAL registered names, then recovers", async () => {
    const deps = makeDeps();
    await chat(deps, OPENER_NO_CHALET);
    const miss = await chat(deps, "قصر غير موجود", "th-1");
    expect(miss.model_calls).toBe(0);
    expect(miss.reply_ar).not.toContain("لم أفهم ردّك");
    expect(miss.reply_ar).toContain("الشاليهات المسجلة");
    expect(miss.reply_ar).toContain("شاليه تولوم");
    expect(miss.reply_ar).toContain("شاليه سكاي");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("chalet");
    const r = await chat(deps, "تولوم", "th-1");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("a bare CUSTOM period label («دوام») answers the period question; unknown labels list the real ones", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push({ id: "t-dawam", label: "دوام", start: "13:00", end: "17:00", active: true, sort: 3, weekday_price: 200, weekend_price: 250 });
    const deps = makeDeps({ doc });
    const q = await chat(deps, "احجز تولوم بكرة لشخصين بمئة ريال باسم علي تجربة");
    expect(q.reply_ar).toContain("أي فترة");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("period");
    // Unknown bare label: deterministic re-ask with the REAL active labels.
    const miss = await chat(deps, "سهرة", "th-1");
    expect(miss.model_calls).toBe(0);
    expect(miss.reply_ar).not.toContain("لم أفهم ردّك");
    expect(miss.reply_ar).toContain("الفترات المفعّلة");
    expect(miss.reply_ar).toContain("دوام");
    // The real custom label then binds.
    const r = await chat(deps, "دوام", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.period_id).toBe("t-dawam");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("«٥٠» answers the TOTAL question as money — guests stay untouched (live: it was filed as guests)", async () => {
    const deps = makeDeps();
    const q = await chat(deps, "احجز تولوم بكرة بالليل لشخصين باسم علي تجربة");
    expect(q.reply_ar).toContain("سعر النظام");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("total");
    const r = await chat(deps, "٥٠", "th-1");
    expect(r.model_calls).toBe(0);
    const prep = (r.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const args = deps._actions.get(prep.action_id).args;
    expect(args.total).toBe(50);
    expect(args.guests).toBe(2); // NOT overwritten by the numeral
    expect(deps._drafts.get("th-1").fields.total_source).toBe("explicit");
  });

  it("«١٠» answers the GUESTS question (numeral routing never breaks the guests path)", async () => {
    const deps = makeDeps();
    const q = await chat(deps, "احجز تولوم بكرة بالليل بمئة ريال باسم علي تجربة");
    expect(q.reply_ar).toContain("كم عدد الضيوف");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("guests");
    const r = await chat(deps, "١٠", "th-1");
    expect(r.model_calls).toBe(0);
    const prep = (r.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(deps._actions.get(prep.action_id).args.guests).toBe(10);
    expect(deps._actions.get(prep.action_id).args.total).toBe(100);
  });

  it("a numeral while the CHALET question is pending keeps the guests status quo and re-asks the chalet", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز بكرة بالليل بمئة ريال باسم علي تجربة"); // no chalet, no guests
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("chalet");
    const r = await chat(deps, "١٠", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.guests).toBe(10); // filed as guests (pinned status quo)
    expect(f.chalet_id).toBeUndefined();
    expect(r.reply_ar).toContain("شاليه"); // the chalet question comes back
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(false);
  });

  it("a bare-digit conflict pick does NOT overwrite the stated guest count", async () => {
    const doc = fixtureDoc();
    doc.bookings.push({ id: "b-x", customer_name: "سابق", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    // Four guests explicitly; the slot is taken -> numbered alternatives.
    const r = await chat(deps, "احجز تولوم بكرة بالليل لأربعة أشخاص بمئة ريال، العميل تجربة");
    expect(r.reply_ar).toContain("1.");
    expect(deps._drafts.get("th-1").fields.guests).toBe(4);
    // Pick option 1 with a bare «١» — guests must STAY 4, not become 1.
    const pick = await chat(deps, "١", "th-1");
    expect(pick.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.guests).toBe(4);
  });

  it("a typed correction retires the previous prepared card (no stale double-book)", async () => {
    const deps = makeDeps();
    const t = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const first = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(first).toBeTruthy();
    expect(deps._actions.get(first.action_id).status).toBe("prepared");
    // Correct the date: a NEW card is prepared and the OLD one is retired.
    const t2 = await chat(deps, "خلها بعد بكرة", "th-1");
    const second = (t2.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(second).toBeTruthy();
    expect(second.action_id).not.toBe(first.action_id);
    expect(deps._actions.get(first.action_id).status).toBe("rejected");
    expect(deps._actions.get(second.action_id).status).toBe("prepared");
  });

  it("«نعم» never reverts an explicit total to a stale price suggestion", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز سكاي باسم فهد تجربة");
    await chat(deps, "بكرة بالليل", "th-1"); // draft gets total_suggested + asks guests/price
    await chat(deps, "شخصين", "th-1"); // -> price question (system price pending)
    await chat(deps, "٨٠٠ ريال", "th-1"); // explicit total 800
    expect(deps._drafts.get("th-1").fields.total).toBe(800);
    const done = await chat(deps, "نعم", "th-1"); // bare confirm — must NOT revert to 350
    const prep = (done.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(deps._actions.get(prep.action_id).args.total).toBe(800);
  });

  // R7 (IMG_6708/6709): digit-labelled same-time periods — the exact live shape.
  function sameTimeDoc() {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push(
      { id: "f5", label: "فترة 5", start: "07:00", end: "17:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
      { id: "f6", label: "الفترة 6", start: "07:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 400 },
    );
    return doc;
  }
  const SAME_TIME_OPENER = "احجز تولوم بكرة من ٧ صباحا الى ٥ مساء لشخصين بمئة ريال باسم علي تجربة";

  it("an explicit «الفترة خمسه» hint binds «فترة 5» directly — no ambiguity question", async () => {
    const deps = makeDeps({ doc: sameTimeDoc() });
    const r = await chat(deps, SAME_TIME_OPENER + " الفترة خمسه");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.period_id).toBe("f5");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
  });

  it("same-time ambiguity is a NUMBERED pick with chips; «فترة5», «الفترة 6» and «٢» all bind", async () => {
    const cases = [
      { answer: "فترة5", expect_id: "f5" },
      { answer: "الفترة 6", expect_id: "f6" },
      { answer: "٢", expect_id: "f6" }, // options keep period order: 1=فترة 5, 2=الفترة 6
    ];
    for (const c of cases) {
      const deps = makeDeps({ doc: sameTimeDoc() });
      const q = await chat(deps, SAME_TIME_OPENER);
      expect(q.model_calls).toBe(0);
      expect(q.reply_ar).toContain("1.");
      expect(Array.isArray(q.next_actions)).toBe(true);
      expect(q.next_actions).toHaveLength(2);
      expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("pick");
      const r = await chat(deps, c.answer, "th-1");
      expect(r.model_calls).toBe(0);
      expect(r.reply_ar).not.toContain("لم أفهم ردّك");
      const f = deps._drafts.get("th-1").fields;
      expect(f.period_id).toBe(c.expect_id);
      expect(f.guests).toBe(2); // a digit answer never overwrites the headcount
      expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    }
  });

  it("when EVERY same-time candidate is occupied, the reply names the blocker with alternatives — never «حدد بالاسم»", async () => {
    const doc = sameTimeDoc();
    doc.bookings.push(
      { id: "bz5", customer_name: "حاجز خمسة", chalet_id: "tulum", booking_date: TOMORROW, period_id: "f5", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "bz6", customer_name: "حاجز ستة", chalet_id: "tulum", booking_date: TOMORROW, period_id: "f6", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    const deps = makeDeps({ doc });
    const r = await chat(deps, SAME_TIME_OPENER);
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("حدد بالاسم");
    expect(r.reply_ar).toContain("محجوزة");
    expect(r.reply_ar).toContain("حاجز خمسة"); // names WHO blocks
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeGreaterThan(0);
  });

  it("«عطني خيارات وانا اضغط عليها» re-sends the stored numbered options with chips", async () => {
    const deps = makeDeps({ doc: sameTimeDoc() });
    await chat(deps, SAME_TIME_OPENER); // -> pick question, alternatives stored
    const r = await chat(deps, "عطني خيارات وانا اضغط عليها", "th-1");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    expect(r.reply_ar).toContain("1.");
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions).toHaveLength(2);
  });

  it("pending period + bare «٥» binds «فترة 5» and keeps the stated guests", async () => {
    // Reach a pending «period» question: no time given, several labels exist.
    const deps = makeDeps({ doc: sameTimeDoc() });
    const q = await chat(deps, "احجز تولوم بكرة لشخصين بمئة ريال باسم علي تجربة");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("period");
    expect(q.model_calls).toBe(0);
    const r = await chat(deps, "٥", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.period_id).toBe("f5");
    expect(f.guests).toBe(2);
  });

  it("ENUMERATION GUARD: every pending_q kind the handler can emit has a registered answer path", () => {
    const src = readFileSync(
      new URL("../../supabase/functions/chalet-assistant/handler.mjs", import.meta.url),
      "utf8",
    );
    const kinds = new Set();
    // Literal ask() sites: pending_q: { kind: "…" }  and the ask() default
    // assignment: fields.pending_q = { kind: "fix", … }.
    for (const m of src.matchAll(/pending_q(?::| =)\s*\{\s*kind:\s*"([a-z_]+)"/g)) kinds.add(m[1]);
    // The missing-field mapping emits kinds indirectly.
    const map = src.match(/PENDING_KIND_BY_MISSING = \{([\s\S]*?)\};/);
    expect(map).toBeTruthy();
    for (const m of map[1].matchAll(/:\s*"([a-z_]+)"/g)) kinds.add(m[1]);
    // The regexes really matched the source (guards against silent drift).
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    for (const k of kinds) expect(PENDING_ANSWER_KINDS.has(k)).toBe(true);
  });
});

// «التعديل بالاختيار»: after «تعديل» the owner picks a FIELD by chip; the
// assistant asks only for that field's new value, the answer rides the same
// single-field parser the collection flow uses, and the completed draft
// re-prepares a fresh card — all with ZERO model calls, phone kept private.
describe("edit-by-field selection (التعديل بالاختيار, zero model calls)", () => {
  const COMPLETE = "احجز تولوم بكرة صباحي 4 ضيوف باسم تجربة جواله 0501234567 بمبلغ 300";

  async function prepared(deps) {
    const t = await chat(deps, COMPLETE);
    expect(t.model_calls).toBe(0);
    const prep = (t.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    return prep;
  }

  it("reopen surfaces one chip per editable field, each with its current value, phone-free", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    const r = await post(deps, { draft_action: "reopen", action_id: prep.action_id, thread_id: "th-1" });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.edit_fields)).toBe(true);
    expect(r.edit_fields.map((c) => c.field)).toEqual(["booking_date", "period", "guests", "total", "customer_name"]);
    const byField = Object.fromEntries(r.edit_fields.map((c) => [c.field, c]));
    expect(byField.guests.value).toBe("4");
    expect(byField.total.value).toBe("300");
    expect(byField.customer_name.value).toBe("تجربة");
    expect(byField.period.value).toContain("صباحي");
    // reopen retires the prepared action — nothing was ever saved.
    expect(deps._actions.get(prep.action_id).status).toBe("rejected");
    // The customer phone NEVER appears in the chips (privacy).
    expect(JSON.stringify(r.edit_fields)).not.toContain("0501234567");
  });

  it("edit_field(guests) asks only for guests, sets a registered pending kind, keeps the phone, and a bare numeral updates it", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    await post(deps, { draft_action: "reopen", action_id: prep.action_id, thread_id: "th-1" });
    const q = await post(deps, { draft_action: "edit_field", field: "guests", action_id: prep.action_id, thread_id: "th-1" });
    expect(q.ok).toBe(true);
    expect(q.editing_field).toBe("guests");
    expect(q.reply_ar).toContain("الضيوف");
    const pq = deps._drafts.get("th-1").fields.pending_q;
    expect(pq.kind).toBe("guests");
    expect(PENDING_ANSWER_KINDS.has(pq.kind)).toBe(true);
    // Setting the pending question must NOT wipe the stored phone.
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0501234567");
    // The owner types just the new value; a fresh card re-prepares.
    const r = await chat(deps, "٦", "th-1");
    expect(r.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.guests).toBe(6);
    const prep2 = (r.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep2).toBeTruthy();
    expect(prep2.action_id).not.toBe(prep.action_id);
  });

  it("edit_field(total) routes a bare numeral to the PRICE, never the guest count", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    await post(deps, { draft_action: "edit_field", field: "total", action_id: prep.action_id, thread_id: "th-1" });
    await chat(deps, "٥٠٠", "th-1");
    const f = deps._drafts.get("th-1").fields;
    expect(f.total).toBe(500);
    expect(f.guests).toBe(4); // unchanged by the price edit
  });

  it("edit_field(customer_name) replaces just the name", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    await post(deps, { draft_action: "edit_field", field: "customer_name", action_id: prep.action_id, thread_id: "th-1" });
    await chat(deps, "خالد", "th-1");
    expect(deps._drafts.get("th-1").fields.customer_name).toBe("خالد");
  });

  it("edit_field(booking_date) replaces just the date", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    await post(deps, { draft_action: "edit_field", field: "booking_date", action_id: prep.action_id, thread_id: "th-1" });
    await chat(deps, "بعد بكرة", "th-1");
    expect(deps._drafts.get("th-1").fields.booking_date).toBe(addDays(TODAY, 2));
  });

  it("an edited field flows end-to-end: edit → answer → confirm → saved (guests 4→6, phone carried through)", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    await post(deps, { draft_action: "edit_field", field: "guests", action_id: prep.action_id, thread_id: "th-1" });
    const r = await chat(deps, "٦", "th-1");
    const prep2 = (r.tool_results || []).find((x) => x.kind === "prepared_action");
    const okc = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep2.action_id, confirmation_token: prep2.confirmation_token } } });
    expect(okc.ok).toBe(true);
    expect(deps._executed).toHaveLength(1);
    expect(deps._doc.bookings[0].guests).toBe(6);
    expect(deps._executed[0].payload.args.customer_phone).toBe("0501234567");
  });

  it("edit_field retires the draft's OWN linked action even when the client omits action_id (defense-in-depth)", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    expect(deps._actions.get(prep.action_id).status).toBe("prepared");
    // The field chip sends NO action_id — the server must still retire the
    // draft's linked prepared action so a stale «سجل» can't save the pre-edit
    // slot while the owner is mid-edit.
    const q = await post(deps, { draft_action: "edit_field", field: "guests", thread_id: "th-1" });
    expect(q.ok).toBe(true);
    expect(deps._actions.get(prep.action_id).status).toBe("rejected");
  });

  it("a non-editable field (chalet) or an unknown field is rejected and leaves the draft untouched", async () => {
    const deps = makeDeps();
    const prep = await prepared(deps);
    const before = JSON.stringify(deps._drafts.get("th-1").fields);
    const r1 = await post(deps, { draft_action: "edit_field", field: "chalet", action_id: prep.action_id, thread_id: "th-1" });
    expect(r1.ok).toBe(false);
    const r2 = await post(deps, { draft_action: "edit_field", field: "bogus", action_id: prep.action_id, thread_id: "th-1" });
    expect(r2.ok).toBe(false);
    // The prepared action and the draft are unchanged (rejected before any write).
    expect(deps._actions.get(prep.action_id).status).toBe("prepared");
    expect(JSON.stringify(deps._drafts.get("th-1").fields)).toBe(before);
  });
});
