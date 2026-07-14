// LIVE TRANSCRIPT CORPUS — every conversation the owner reported broken
// (rounds 1-3 screenshots) replayed against the REAL handler with ZERO model
// calls asserted throughout. Any wording here regressing turns CI red before
// it can reach the owner again. Harness mirrors tests/assistant/draft-flow
// (keep the deps shape in sync when the handler contract grows).
import { describe, expect, it } from "vitest";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { resolveBookingCreateArgs } from "../../supabase/functions/_shared/assistant/booking-resolution.mjs";
import { riyadhToday, addDays, availabilityCheck, availabilityFailureAr } from "../../supabase/functions/_shared/assistant/availability.mjs";

const ENV = { ASSISTANT_CONFIRM_SECRET: "sec", DEEPSEEK_API_KEY: "k" };
const WS = "WST";
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

function makeDeps({ doc = fixtureDoc() } = {}) {
  const modelCalls = [];
  const drafts = new Map();
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
      return { ok: false, error: "DEEPSEEK_UNREACHABLE" }; // the corpus must never get here
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
      if (a.tokenHash !== tokenHash) return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
      a.status = "confirmed";
      a.confirmation_used_at = "now";
      return { ok: true };
    },
    // Executor faithful to the live one: fail closed on the availability twin
    // (so confirm-time conflicts reproduce), succeed otherwise.
    async executeConfirmed(_k, action) {
      executed.push(action);
      const args = action.payload.args;
      const chalet = doc.chalets.find((c) => c.id === args.chalet_id);
      const period = chalet ? (chalet.periods || []).find((p) => p.id === args.period_id) : null;
      const check = availabilityCheck(doc, args.chalet_id, args.booking_date, period);
      if (!check.available) {
        const fail = availabilityFailureAr(check);
        return { ok: false, error: fail.error, reason_ar: fail.reason_ar };
      }
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

describe("live transcript corpus (owner-reported conversations, zero model calls)", () => {
  it("R0 (latest screenshots): full sentence → bare «علي» → exact card/save despite unrelated legacy conflicts", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push(
      { id: "t-short", label: "فترة 3", start: "19:00", end: "00:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
      { id: "t-mid", label: "قديمة متداخلة", start: "11:00", end: "17:00", active: true, sort: 9 },
    );
    doc.bookings.push(
      { id: "old1", customer_name: "زهراء", chalet_id: "tulum", booking_date: "2026-05-12", period_id: "t-am", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "old2", customer_name: "فقد الاحبه", chalet_id: "tulum", booking_date: "2026-05-12", period_id: "t-mid", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    const legacyBefore = JSON.stringify(doc.bookings);
    const deps = makeDeps({ doc });
    const first = await chat(
      deps,
      "سجل حجز جديد اليوم المساء من ٧ الى خمس الصباح رقم الجوال 0503666853 اسم الشاليه تولوم عدد الضيوف ١٠ السعر ٣٠٠",
    );
    expect(first.model_calls).toBe(0);
    expect(first.reply_ar).toContain("باسم من");
    expect(first.reply_ar).not.toMatch(/حدد الفترة|كم عدد الضيوف|سعر النظام/);
    expect(deps._drafts.get("th-1").fields).toMatchObject({
      booking_date: TODAY,
      chalet_id: "tulum",
      period_id: "t-pm",
      canonical_start: "19:00",
      canonical_end: "05:00",
      guests: 10,
      total: 300,
      total_source: "explicit",
    });
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0503666853");

    const named = await chat(deps, "علي", "th-1");
    const prep = (named.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    expect(named.reply_ar).not.toContain("لم أفهم");
    const rows = Object.fromEntries(prep.card.rows.map((r) => [r.k, r.v]));
    expect(rows).toMatchObject({
      "العميل": "علي",
      "الجوال": "05••••6853",
      "الشاليه": "شاليه تولوم",
      "الفترة": "19:00 → 05:00",
      "الضيوف": "10",
      "الإجمالي": "300 ريال",
    });

    const saved = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(saved.ok).toBe(true);
    expect(deps._doc.bookings).toHaveLength(3);
    expect(JSON.stringify(deps._doc.bookings.slice(0, 2))).toBe(legacyBefore);
    expect(deps._doc.bookings[2]).toMatchObject({ customer_name: "علي", booking_date: TODAY, period_id: "t-pm", guests: 10, total: 300 });
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R1 (IMG_6690): «١٠»→«اعتمد»→card; the confirm-time conflict names the blocker and options; «١» recovers", async () => {
    const deps = makeDeps();
    const replies = [];
    const t1 = await chat(deps, "احجز تولوم بكرة بالليل ١٠ ضيوف");
    replies.push(t1.reply_ar);
    // guests stated explicitly (١٠ ضيوف) and never re-asked; ONE combined
    // question covers the rest (price + customer) — never one-by-one.
    expect(t1.reply_ar).not.toContain("عدد الضيوف");
    expect(t1.reply_ar).toContain("سعر النظام");
    expect(t1.reply_ar).toContain("اسم العميل");
    expect(t1.reply_ar).toContain("رسالة واحدة");
    expect(deps._drafts.get("th-1").fields.guests).toBe(10);
    const t2 = await chat(deps, "اعتمد", "th-1");
    replies.push(t2.reply_ar);
    expect(t2.reply_ar).toContain("اسم العميل");
    const t3 = await chat(deps, "العميل علي تجربة", "th-1");
    replies.push(t3.reply_ar);
    const prep = (t3.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    // The slot is taken between prepare and حفظ (the live race).
    deps._doc.bookings.push({ id: "b-race", customer_name: "منافس تجريبي", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const r = await post(deps, { invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("completed_action");
    // NEVER the generic head again: the blocker is named, options numbered.
    expect(r.reason_ar).toContain("منافس تجريبي");
    expect(r.reason_ar).toContain("أقرب الخيارات");
    expect(Array.isArray(r.next_actions)).toBe(true);
    expect(r.next_actions.length).toBeGreaterThan(0);
    const pick = await chat(deps, "١", "th-1");
    replies.push(pick.reply_ar);
    // R8 (§5): tapping an option that PRINTS a price accepts that price — the
    // card comes straight back, no second price question. The stale accepted
    // system price of the OLD slot was invalidated, and the tapped option's
    // own displayed price took its place.
    const repick = (pick.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(repick).toBeTruthy();
    const fAfterPick = deps._drafts.get("th-1").fields;
    expect(fAfterPick.total_source).toBe("alternative_price");
    expect(fAfterPick.total).toBeGreaterThan(0);
    expect(fAfterPick.guests).toBe(10); // the pick never erases known answers
    expect(fAfterPick.customer_name).toBe("علي تجربة");
    expect(deps._modelCalls).toHaveLength(0);
    // The phone is never DEMANDED: it may only ever appear as the optional
    // item inside the combined ask.
    for (const rep of replies) {
      expect(String(rep || "")).not.toMatch(/رقم الجوال(?!\s*\(اختياري\))/u);
    }
  });

  it("R1b: an unrelated legacy conflicting pair no longer blocks a safe new booking", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push({ id: "t-mid", label: "ظهيرة", start: "11:00", end: "13:00", active: true, sort: 9 });
    doc.bookings.push(
      { id: "old1", customer_name: "قديم أول", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-am", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "old2", customer_name: "قديم ثاني", chalet_id: "tulum", booking_date: "2099-03-01", period_id: "t-mid", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز سكاي بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("تعارض قائم");
    expect((r.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R2 (IMG_6689): pasting the option line the bot itself printed selects that option", async () => {
    const doc = fixtureDoc();
    doc.bookings.push({ id: "b-x", customer_name: "سابق", chalet_id: "tulum", booking_date: TOMORROW, period_id: "t-pm", guests: 2, total: 400, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز تولوم بكرة بالليل لشخصين بمئة ريال، العميل تجربة");
    const optionLine = String(r.reply_ar).split("\n").find((l) => l.startsWith("1. "));
    expect(optionLine).toBeTruthy();
    // The owner pastes the option text back (without the «1. » prefix).
    const pasted = optionLine.slice(3);
    const pick = await chat(deps, pasted, "th-1");
    expect(pick.model_calls).toBe(0);
    expect(pick.reply_ar).not.toContain("الوقت غير واضح");
    expect(pick.reply_ar).not.toContain("لم أفهم");
    expect((pick.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("period ambiguity is rendered as real one-tap actions and a tap selects it", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push({ id: "t-short", label: "فترة 3", start: "19:00", end: "00:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 });
    const deps = makeDeps({ doc });
    const r = await chat(deps, "احجز تولوم بكرة من ٧ مساء الى ١٠ مساء لشخصين بمئة ريال، العميل تجربة");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("اضغط أحد الخيارات");
    expect(r.next_actions).toHaveLength(2);
    expect(deps._drafts.get("th-1").fields.alternatives).toHaveLength(2);
    const picked = await chat(deps, "٢", "th-1");
    expect(picked.model_calls).toBe(0);
    expect((picked.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R3: «من 7 الى 12» → «مساء» resolves; nonsense gets the guided fallback; phone is NEVER demanded", async () => {
    const deps = makeDeps();
    const replies = [];
    const t1 = await chat(deps, "احجز تولوم من 7 الى 12");
    replies.push(t1.reply_ar);
    expect(t1.reply_ar).toContain("صباحاً أم مساءً");
    const t2 = await chat(deps, "مساء", "th-1");
    replies.push(t2.reply_ar);
    expect(t2.reply_ar).not.toContain("كأمر مدعوم");
    expect(deps._drafts.get("th-1").fields.period_id).toBe("t-pm"); // real evening period bound
    const t3 = await chat(deps, "كلام غير مفهوم أبداً", "th-1");
    replies.push(t3.reply_ar);
    expect(t3.reply_ar).toContain("لم أفهم ردّك");
    expect(t3.reply_ar).toContain("الغِ الحجز");
    expect(deps._modelCalls).toHaveLength(0);
    // Never DEMANDED — only the optional combined-ask mention is allowed.
    for (const rep of replies) {
      expect(String(rep || "")).not.toMatch(/رقم الجوال(?!\s*\(اختياري\))/u);
    }
  });

  it("R4 (IMG_6702): the exact «سجل حجز…شالية…٧ المسا الى ٥ الصباح» message is fully deterministic", async () => {
    const deps = makeDeps();
    const replies = [];
    const t1 = await chat(deps, "سجل حجز اليوم باسم علي تجريبي شالية تولوم الوقت ٧ المسا الى ٥ الصباح عدد الضيوف ١٠ و الرقم 0503666853 شالية تولوم");
    replies.push(t1.reply_ar);
    expect(t1.ok).toBe(true);
    expect(t1.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum"); // «شالية» (taa-marbuta) resolves
    expect(f.booking_date).toBe(TODAY);
    expect(f.canonical_start).toBe("19:00");
    expect(f.canonical_end).toBe("05:00");
    expect(f.period_id).toBe("t-pm");
    expect(f.guests).toBe(10);
    expect(f.customer_name).toBe("علي تجريبي");
    expect(t1.reply_ar).toContain("سعر"); // total is the ONLY missing field
    const done = await chat(deps, "اعتمد", "th-1");
    replies.push(done.reply_ar);
    expect((done.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
    // The raw phone never appears in any reply (masked only on the card).
    for (const rep of replies) expect(String(rep || "")).not.toContain("0503666853");
  });

  it("R5 (IMG_6703): the bot's own «لأي شاليه؟» question accepts «تولوم» — never «لم أفهم ردّك»", async () => {
    const deps = makeDeps();
    const t1 = await chat(deps, "احجز فترة اليوم مساء من ٧ الى ٥ عدد الضيوف ١٠ باسم علي تجربة");
    expect(t1.model_calls).toBe(0);
    // R8: the ask is combined, but the GIVEN period/time is never re-asked.
    expect(t1.reply_ar).toContain("اسم الشاليه");
    expect(t1.reply_ar).not.toContain("الفترة (اسمها أو وقتها)");
    expect(t1.reply_ar).not.toContain("عدد الضيوف");
    expect(deps._drafts.get("th-1").fields.pending_q.kind).toBe("chalet");
    // Live failure: this exact answer got «لم أفهم ردّك» twice.
    const t2 = await chat(deps, "تولوم", "th-1");
    expect(t2.model_calls).toBe(0);
    expect(t2.reply_ar).not.toContain("لم أفهم ردّك");
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum");
    expect(f.period_id).toBe("t-pm"); // 19:00–05:00 answer binds the real slot
    expect(f.guests).toBe(10);
    expect(t2.reply_ar).toContain("سعر"); // the flow ADVANCES to the price
    const t3 = await chat(deps, "اعتمد", "th-1");
    expect((t3.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
    expect(deps._executed).toHaveLength(0);
  });

  it("R5 (IMG_6703, 2nd attempt): «شالية تولوم» also answers the chalet question", async () => {
    const deps = makeDeps();
    await chat(deps, "احجز فترة اليوم مساء من ٧ الى ٥ عدد الضيوف ١٠ باسم علي تجربة");
    const r = await chat(deps, "شالية تولوم", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R7 (IMG_6708): the verbatim opener with «الفترة خمسه» binds «فترة 5» — no dead-end, phone never echoed", async () => {
    const doc = fixtureDoc();
    // The owner's real shape: two digit-labelled periods with IDENTICAL times.
    doc.chalets[0].periods.push(
      { id: "f5", label: "فترة 5", start: "07:00", end: "17:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
      { id: "f6", label: "الفترة 6", start: "07:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 400 },
    );
    const deps = makeDeps({ doc });
    const replies = [];
    const t1 = await chat(deps, "عدد الضيوف ١٠ احجز الشاليه تولوم ٤٥٠ فترة النهار بكرا من ٧ الى العصر ٥ رقم الجوال 0503666853 الفترة خمسه");
    replies.push(t1.reply_ar);
    expect(t1.ok).toBe(true);
    expect(t1.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum");
    expect(f.period_id).toBe("f5"); // «الفترة خمسه» broke the same-time tie
    expect(f.guests).toBe(10);
    expect(t1.reply_ar).not.toContain("توجد عدة فترات"); // no ambiguity question
    expect(t1.reply_ar).not.toContain("لم أفهم ردّك");
    // A bare «٤٥٠» with no currency word is never silently banked — the flow
    // advances to the PRICE question (system price = the same 450).
    expect(t1.reply_ar).toContain("سعر النظام");
    const t2 = await chat(deps, "اعتمد", "th-1");
    replies.push(t2.reply_ar);
    expect(t2.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.total).toBe(450);
    const t3 = await chat(deps, "علي", "th-1");
    replies.push(t3.reply_ar);
    expect((t3.tool_results || []).some((x) => x.kind === "prepared_action")).toBe(true);
    expect(deps._modelCalls).toHaveLength(0);
    for (const rep of replies) expect(String(rep || "")).not.toContain("0503666853");
  });

  it("R7 (IMG_6708, fallback path): without the hint, the question is a numbered pick and «فترة5» answers it", async () => {
    const doc = fixtureDoc();
    doc.chalets[0].periods.push(
      { id: "f5", label: "فترة 5", start: "07:00", end: "17:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
      { id: "f6", label: "الفترة 6", start: "07:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 400 },
    );
    const deps = makeDeps({ doc });
    const q = await chat(deps, "احجز تولوم بكرا من ٧ صباحا الى ٥ مساء عدد الضيوف ١٠ باسم علي تجربة بمئة ريال");
    expect(q.model_calls).toBe(0);
    expect(q.reply_ar).toContain("1."); // numbered, tappable — not «حدد بالاسم» free text
    expect(Array.isArray(q.next_actions)).toBe(true);
    const r = await chat(deps, "فترة5", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("لم أفهم ردّك");
    expect(deps._drafts.get("th-1").fields.period_id).toBe("f5");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R7 (IMG_6710/6711): the balances and marketing chips answer with real names/numbers, zero model calls", async () => {
    const deps = makeDeps();
    deps.runReadTool = async (_k, name) => {
      if (name === "list_outstanding_balances") {
        return { source: "ledger", bookings: [{ booking_id: "b1", customer_name: "أبو فهد", booking_date: "2099-07-11", remaining_halalas: 50000 }] };
      }
      if (name === "get_attributed_revenue") return { attributed_revenue_halalas: 90000, conversions: 2, messages_sent: 5 };
      return {};
    };
    const balances = await chat(deps, "من عليه مبالغ متبقية؟");
    expect(balances.model_calls).toBe(0);
    expect(balances.reply_ar).toContain("أبو فهد");
    expect(balances.reply_ar).toContain("المتبقي 500 ريال");
    const revenue = await chat(deps, "كم دخل جابه التسويق؟");
    expect(revenue.model_calls).toBe(0);
    expect(revenue.reply_ar).toContain("900 ريال");
    expect(revenue.reply_ar).not.toBe("تمام.");
    expect(deps._modelCalls).toHaveLength(0);
  });

  // --- R8 (spec §8): the FULL booking conversation, end to end. A complete
  // message must NEVER become a field-by-field interrogation, and choosing a
  // conflict alternative must NEVER lose the fields stated before the conflict.
  function r8Doc({ conflictToday = false } = {}) {
    // Two same-time day periods (فترة 5 / الفترة 6) + a second chalet, exactly
    // the shape the live staging workspace has.
    const doc = {
      chalets: [
        {
          id: "tulum", name: "شاليه تولوم", capacity: 20, deleted_at: null,
          periods: [
            { id: "f5", label: "فترة 5", start: "07:00", end: "17:00", active: true, sort: 1, weekday_price: 450, weekend_price: 450 },
            { id: "f6", label: "الفترة 6", start: "07:00", end: "17:00", active: true, sort: 2, weekday_price: 400, weekend_price: 400 },
            { id: "t-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 3, weekday_price: 500, weekend_price: 700 },
          ],
        },
        {
          id: "sky", name: "شاليه سكاي", capacity: 8, deleted_at: null,
          periods: [{ id: "s-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 1, weekday_price: 350, weekend_price: 500 }],
        },
      ],
      bookings: [],
    };
    if (conflictToday) {
      doc.bookings.push({ id: "bk-existing", customer_name: "حجز قائم", chalet_id: "tulum", booking_date: TODAY, period_id: "t-pm", guests: 5, total: 500, paid: 0, status: "confirmed", deleted_at: null });
    }
    return doc;
  }

  it("R8 Scenario A: a COMPLETE message never becomes an interrogation (chalet/guests/price/name never re-asked)", async () => {
    const deps = makeDeps({ doc: r8Doc() });
    const t1 = await chat(
      deps,
      "اعمل حجز جديد بعد يومين شاليه تولوم من 7 الصباح إلى 5 العصر عدد الضيوف 4 رقم الجوال 0503559373 باسم خالد السعر 450",
    );
    expect(t1.model_calls).toBe(0);
    // The ONLY thing genuinely ambiguous is which same-time period — so the
    // reply is the period pick, never a re-ask of anything already given.
    expect(t1.reply_ar).not.toContain("لأي شاليه");
    expect(t1.reply_ar).not.toContain("كم عدد الضيوف");
    expect(t1.reply_ar).not.toContain("كم الإجمالي");
    expect(t1.reply_ar).not.toContain("باسم من");
    expect(t1.reply_ar).not.toContain("ما تاريخ");
    const f1 = deps._drafts.get("th-1").fields;
    expect(f1.chalet_id).toBe("tulum");
    expect(f1.booking_date).toBe(addDays(TODAY, 2));
    expect(f1.guests).toBe(4);
    expect(f1.total).toBe(450);
    expect(f1.customer_name).toBe("خالد");
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0503559373");
    // The period pick is offered as tappable numbered options.
    expect(Array.isArray(t1.next_actions)).toBe(true);
    expect(t1.next_actions.length).toBe(2);
    // Tapping «1» goes STRAIGHT to the card — no more questions.
    const t2 = await chat(deps, "1", "th-1");
    expect(t2.model_calls).toBe(0);
    const prep = (t2.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const f2 = deps._drafts.get("th-1").fields;
    expect(f2.guests).toBe(4);
    expect(f2.total).toBe(450);
    expect(f2.customer_name).toBe("خالد");
    expect(f2.period_id).toBe("f5");
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0503559373");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R8 Scenario A (unique period): a complete message with ONE possible period reaches the card in one turn", async () => {
    const doc = r8Doc();
    // Collapse to a single day period so the time is unambiguous.
    doc.chalets[0].periods = [doc.chalets[0].periods[0], doc.chalets[0].periods[2]];
    const deps = makeDeps({ doc });
    const t1 = await chat(
      deps,
      "اعمل حجز جديد بعد يومين شاليه تولوم من 7 الصباح إلى 5 العصر عدد الضيوف 4 رقم الجوال 0503559373 باسم خالد السعر 450",
    );
    expect(t1.model_calls).toBe(0);
    const prep = (t1.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy(); // straight to the confirmation card
    expect(prep.card.rows.find((r) => r.k === "الضيوف").v).toBe("4");
    expect(prep.card.rows.find((r) => r.k === "الإجمالي").v).toContain("450");
    expect(prep.card.rows.find((r) => r.k === "العميل").v).toBe("خالد");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R8 Scenario B: after a conflict, picking «1» keeps guests/total/customer/phone and goes to the card", async () => {
    const deps = makeDeps({ doc: r8Doc({ conflictToday: true }) });
    const t1 = await chat(
      deps,
      "سجل حجز جديد اليوم من 7 مساء إلى 5 صباح رقم الجوال 0503666853 اسم الشاليه تولوم عدد الضيوف 10 السعر 300 باسم علي",
    );
    expect(t1.model_calls).toBe(0);
    // Real conflict UX: blocker named + numbered real alternatives + chips.
    expect(t1.reply_ar).toContain("حجز قائم");
    expect(Array.isArray(t1.next_actions)).toBe(true);
    expect(t1.next_actions.length).toBeGreaterThan(0);
    const t2 = await chat(deps, "1", "th-1");
    expect(t2.model_calls).toBe(0);
    const prep = (t2.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy(); // straight to the card
    const f = deps._drafts.get("th-1").fields;
    expect(f.guests).toBe(10); // NOT lost
    expect(f.total).toBe(300); // explicit price preserved (never the option's)
    expect(f.customer_name).toBe("علي");
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0503666853");
    // The card shows the same preserved values.
    expect(prep.card.rows.find((r) => r.k === "الضيوف").v).toBe("10");
    expect(prep.card.rows.find((r) => r.k === "الإجمالي").v).toContain("300");
    expect(prep.card.rows.find((r) => r.k === "العميل").v).toBe("علي");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R8 Scenario C: «احجز تولوم بكرة الفترة خمسه لـ 10 ضيوف باسم مهره جوال 0500000091 بمبلغ 450» binds the real period id in one turn", async () => {
    const deps = makeDeps({ doc: r8Doc() });
    const t1 = await chat(deps, "احجز تولوم بكرة الفترة خمسه لـ 10 ضيوف باسم مهره جوال 0500000091 بمبلغ 450");
    expect(t1.model_calls).toBe(0);
    const prep = (t1.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum"); // real chalet id
    expect(f.period_id).toBe("f5"); // «الفترة خمسه» -> real period id, no guess
    expect(f.booking_date).toBe(TOMORROW);
    expect(f.guests).toBe(10);
    expect(f.total).toBe(450);
    expect(f.customer_name).toBe("مهره");
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0500000091");
    // period_id/chalet_id never leak into the reply.
    expect(t1.reply_ar).not.toContain("f5");
    expect(t1.reply_ar).not.toContain("tulum");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R8 Scenario D: several missing fields → ONE combined question → ONE combined reply completes the draft", async () => {
    const doc = r8Doc();
    doc.chalets[0].periods = [doc.chalets[0].periods[0], doc.chalets[0].periods[2]]; // unique day period
    const deps = makeDeps({ doc });
    const t1 = await chat(deps, "احجز تولوم بكرة فترة 5");
    expect(t1.model_calls).toBe(0);
    // ONE combined question, not sequential. guests is optional so it is NOT
    // one of the asked items.
    expect(t1.reply_ar).toContain("باقي فقط:");
    expect(t1.reply_ar).not.toContain("عدد الضيوف");
    expect(t1.reply_ar).toContain("اسم العميل");
    expect(t1.reply_ar).toContain("رسالة واحدة");
    // ONE combined reply carries everything and reaches the card.
    const t2 = await chat(deps, "٤ ضيوف باسم سالم جوال 0500000012 والسعر 450", "th-1");
    expect(t2.model_calls).toBe(0);
    const prep = (t2.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy();
    const f = deps._drafts.get("th-1").fields;
    expect(f.guests).toBe(4);
    expect(f.customer_name).toBe("سالم");
    expect(f.total).toBe(450);
    expect(deps._drafts.get("th-1").private.customer_phone).toBe("0500000012");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R8 §5: choosing an option that DISPLAYS a price (no explicit total) adopts that price — one card, no price question", async () => {
    const deps = makeDeps({ doc: r8Doc({ conflictToday: true }) });
    // No price stated by the owner this time.
    const t1 = await chat(
      deps,
      "سجل حجز جديد اليوم من 7 مساء إلى 5 صباح اسم الشاليه تولوم عدد الضيوف 10 باسم علي جوال 0503666853",
    );
    expect(t1.model_calls).toBe(0);
    expect(Array.isArray(t1.next_actions)).toBe(true);
    // Option 2 (الفترة 6) displays 400 ريال — tapping it accepts that price.
    const t2 = await chat(deps, "2", "th-1");
    expect(t2.model_calls).toBe(0);
    const prep = (t2.tool_results || []).find((x) => x.kind === "prepared_action");
    expect(prep).toBeTruthy(); // straight to the card, no separate price question
    const f = deps._drafts.get("th-1").fields;
    expect(f.total).toBe(400);
    expect(f.total_source).toBe("alternative_price");
    expect(f.guests).toBe(10);
    expect(f.customer_name).toBe("علي");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R9 (IMG_6721): a chalet named INSIDE a long combined-answer sentence binds — never re-asked", async () => {
    const deps = makeDeps();
    // The draft starts empty (bare intent), so the first reply is the full
    // combined question.
    const t0 = await chat(deps, "ابغى احجز");
    expect(t0.model_calls).toBe(0);
    expect(t0.reply_ar).toContain("اسم الشاليه");
    // The owner answers with a long multi-field sentence that names the chalet
    // «شالية تولوم» among the other fields — the live dead-end was re-asking
    // «اسم الشاليه» because the hint stayed frozen on the first message.
    const t1 = await chat(deps, "الحجز باسم محمد التاريخ بعد ٣ ايام شالية تولوم عدد الضيوف ٥", "th-1");
    expect(t1.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum"); // bound from inside the sentence
    expect(f.customer_name).toBe("محمد"); // NOT «محمد التاريخ» — label stops it
    expect(f.guests).toBe(5);
    expect(f.booking_date).toBe(addDays(TODAY, 3));
    // The chalet is never re-asked once bound.
    expect(t1.reply_ar).not.toContain("اسم الشاليه");
    expect(t1.reply_ar).not.toContain("عدد الضيوف");
    expect(t1.reply_ar).not.toContain("اسم العميل");
    expect(deps._modelCalls).toHaveLength(0);
  });

  it("R9: a chalet-less answer («مساء») never clobbers a chalet named on an EARLIER turn", async () => {
    const deps = makeDeps();
    // «تولوم» is named up front, but the turn returns at the AM/PM clarify
    // before the chalet binds — the hint must survive the «مساء» answer.
    const t1 = await chat(deps, "احجز تولوم من 7 الى 12");
    expect(t1.reply_ar).toContain("صباحاً أم مساءً");
    const t2 = await chat(deps, "مساء", "th-1");
    expect(t2.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum"); // the earlier hint was NOT clobbered
    expect(f.period_id).toBe("t-pm");
    expect(f.canonical_end).toBe("05:00");
    expect(deps._modelCalls).toHaveLength(0);
  });
});

// Workspace mirroring the audit harness: a numbered-sibling chalet + two
// SAME-TIME day periods, so the ambiguity / numbered-pick / capacity fixes are
// exercised against real records (never the flat fixtureDoc).
function richFixtureDoc() {
  return {
    chalets: [
      {
        id: "tulum", name: "شاليه تولوم", capacity: 20, deleted_at: null,
        periods: [
          { id: "am", label: "صباحي", start: "07:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 450 },
          { id: "pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 500, weekend_price: 700 },
          { id: "f5", label: "فترة 5", start: "13:00", end: "17:00", active: true, sort: 3, weekday_price: 450, weekend_price: 450 },
          { id: "f6", label: "الفترة 6", start: "13:00", end: "17:00", active: true, sort: 4, weekday_price: 400, weekend_price: 400 },
        ],
      },
      {
        id: "tulum2", name: "شاليه تولوم 2", capacity: 10, deleted_at: null,
        periods: [{ id: "t2pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 1, weekday_price: 350, weekend_price: 500 }],
      },
      {
        id: "sky", name: "شاليه سكاي", capacity: 8, deleted_at: null,
        periods: [
          { id: "s-am", label: "صباحي", start: "08:00", end: "12:00", active: true, sort: 1, weekday_price: 300, weekend_price: 500 },
          { id: "s-pm", label: "مسائي", start: "19:00", end: "05:00", active: true, sort: 2, weekday_price: 350, weekend_price: 500 },
        ],
      },
    ],
    bookings: [],
  };
}
const cardOf = (res) => (res.tool_results || []).find((x) => x.kind === "prepared_action");

describe("batch-B dispatch/resolution/reply fixes (owner-reported, zero model calls)", () => {
  it("tashkeel on the booking verb «اَحجُز تُولوم بُكرة» reaches the pipeline (not the model)", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    const r = await chat(deps, "اَحجُز تُولوم بُكرة");
    expect(r.model_calls).toBe(0);
    expect(deps._modelCalls).toHaveLength(0);
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
  });

  it("polite «ممكن تحجزلي تولوم» and «ابغى منك حجز تولوم» open the pipeline and bind the chalet", async () => {
    for (const msg of ["ممكن تحجزلي تولوم", "ابغى منك حجز تولوم"]) {
      const deps = makeDeps({ doc: richFixtureDoc() });
      const r = await chat(deps, msg);
      expect(r.model_calls).toBe(0);
      expect(r.reply_ar).not.toContain("لا توجد بيانات"); // was misrouted to a lookup
      expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    }
  });

  it("phone glued to the price (latin AND arabic-indic) stores the REAL number, never a fabrication", async () => {
    for (const msg of [
      "احجز تولوم بكرة فترة 5 لأربعة أشخاص باسم سعد بمبلغ 450 0501234567",
      "احجز تولوم بكرة فترة 5 لأربعة أشخاص باسم سعد بمبلغ ٤٥٠ ٠٥٠١٢٣٤٥٦٧",
      "احجز تولوم بكرة فترة 5 لأربعة أشخاص باسم سعد بمبلغ 450 00966501234567",
    ]) {
      const deps = makeDeps({ doc: richFixtureDoc() });
      const r = await chat(deps, msg);
      expect(r.model_calls).toBe(0);
      expect(deps._drafts.get("th-1").private.customer_phone).toBe("0501234567");
      const card = cardOf(r);
      expect(card.card.rows.find((x) => x.k === "الجوال").v).toBe("05••••4567");
    }
  });

  it("«تولوم 2» named mid-sentence binds شاليه تولوم 2 (longest unique match), not CHALET_AMBIGUOUS", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    const r = await chat(deps, "احجز تولوم 2 بكرة مسائي لشخصين بمبلغ 350 باسم سعد");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("أكثر من شاليه");
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum2");
    expect(cardOf(r).card.rows.find((x) => x.k === "الشاليه").v).toBe("شاليه تولوم 2");
  });

  it("letter-repeat elongation «تووولوم» collapses and binds the chalet", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    const r = await chat(deps, "احجز تووولوم بكرة");
    expect(r.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum");
    expect(r.reply_ar).not.toContain("اسم الشاليه");
  });

  it("a guest digit glued to the name «شالية تولوم ٢ ضيوف» binds تولوم (not تولوم 2) with guests=2", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    await chat(deps, "ابغى احجز");
    const r = await chat(deps, "باسم محمد بعد يومين شالية تولوم ٢ ضيوف مسائي ٤٠٠ ريال", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("tulum");
    expect(f.guests).toBe(2);
    expect(r.reply_ar).not.toContain("لأي شاليه");
  });

  it("an unknown chalet inside a booking command lists the REAL registered names", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    const r = await chat(deps, "احجز قصر الياسمين بكرة مسائي لشخصين بمبلغ 350 باسم سعد");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("الشاليهات المسجلة");
    expect(r.reply_ar).toContain("شاليه تولوم");
    expect(r.reply_ar).not.toBe("لأي شاليه تريد الحجز؟");
  });

  it("«الخيار الثاني/الأول/الثالث» ordinal picks bind the numbered option and card", async () => {
    const doc = richFixtureDoc();
    doc.bookings.push({ id: "bk-x", customer_name: "قائم", chalet_id: "tulum", booking_date: TODAY, period_id: "pm", guests: 5, total: 500, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    await chat(deps, "احجز شاليه تولوم اليوم من ٧ مساء الى ٥ صباحا باسم محمد جوال ٠٥٥١٢٣٤٥٦٧ عدد الضيوف ٨ بسعر ٦٠٠");
    const r = await chat(deps, "الخيار الثاني", "th-1");
    expect(r.model_calls).toBe(0);
    expect(cardOf(r)).toBeTruthy(); // an option was bound → card, not a re-list
    expect(deps._drafts.get("th-1").fields.guests).toBe(8); // explicit headcount kept
  });

  it("picking a chalet NOT in the conflict list re-emits the FULL options (no «لم أفهم», option 3 present)", async () => {
    const doc = richFixtureDoc();
    doc.bookings.push({ id: "bk-x", customer_name: "قائم", chalet_id: "tulum", booking_date: TODAY, period_id: "pm", guests: 5, total: 500, paid: 0, status: "confirmed", deleted_at: null });
    const deps = makeDeps({ doc });
    await chat(deps, "احجز شاليه تولوم اليوم من ٧ مساء الى ٥ صباحا باسم محمد جوال ٠٥٥١٢٣٤٥٦٧ عدد الضيوف ٨ بسعر ٦٠٠");
    const r = await chat(deps, "شاليه سكاي", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).not.toContain("لم أفهم");
    expect(r.reply_ar).toMatch(/\n3\. /); // the full list, option 3 not truncated away
    expect(cardOf(r)).toBeFalsy(); // nothing bound
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("tulum"); // NOT swapped to sky
  });

  it("a same-time period picked by the SPOKEN number «خمسه» never fabricates guests", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    await chat(deps, "احجز تولوم بكرة من ١ الى ٥ العصر"); // 13:00–17:00 matches فترة 5 AND الفترة 6
    const r = await chat(deps, "خمسه", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.period_label).toBe("فترة 5");
    expect(f.guests).toBeUndefined(); // «خمسه» selected the period, it is NOT 5 guests
  });

  it("a PURE chalet correction «لا الشاليه سكاي» swaps the chalet and re-asks the period", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    await chat(deps, `احجز تولوم بتاريخ ${addDays(TODAY, 3)} فترة 5 لأربعة أشخاص باسم سعد بمبلغ 450 جوال 0501234567`);
    const r = await chat(deps, "لا الشاليه سكاي", "th-1");
    expect(r.model_calls).toBe(0);
    const f = deps._drafts.get("th-1").fields;
    expect(f.chalet_id).toBe("sky");
    expect(f.period_id).toBeUndefined(); // the tulum-only فترة 5 was unbound
    expect(f.customer_name).toBe("سعد"); // the rest survives
    expect(r.reply_ar).not.toContain("بيانات الحجز مكتملة");
  });

  it("colloquial cancel «خلاص الغيه» closes the draft; the next «احجز …» starts fresh", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    await chat(deps, "احجز تولوم بكرة");
    const r = await chat(deps, "خلاص الغيه", "th-1");
    expect(r.reply_ar).toContain("تم الإلغاء");
    expect(r.reply_ar).not.toContain("لم أجد هذه الفترة");
    const r3 = await chat(deps, "احجز سكاي بكرة", "th-1");
    expect(deps._drafts.get("th-1").fields.chalet_id).toBe("sky"); // NOT the abandoned tulum
    expect(r3.model_calls).toBe(0);
  });

  it("over-capacity guests are caught before the card with a clear capacity message", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    await chat(deps, "احجز تولوم بكرة صباحي باسم علي بمبلغ 300");
    const r = await chat(deps, "٥٠ ضيف", "th-1");
    expect(r.model_calls).toBe(0);
    expect(r.reply_ar).toContain("يتجاوز سعة الشاليه");
    expect(cardOf(r)).toBeFalsy(); // never carded
  });

  it("tatweel inside a period word «مسـاء» still resolves the period", async () => {
    const deps = makeDeps({ doc: richFixtureDoc() });
    const r = await chat(deps, "احجز تولوم بكرة مسـاء لاربعة اشخاص باسم سعد بمبلغ 450");
    expect(r.model_calls).toBe(0);
    expect(deps._drafts.get("th-1").fields.period_id).toBe("pm");
    expect(cardOf(r)).toBeTruthy();
  });
});
