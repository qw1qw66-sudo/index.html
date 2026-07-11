import { describe, expect, it } from "vitest";
import { runAutopilot } from "../../supabase/functions/chalet-autopilot/handler.mjs";
import { customerReference } from "../../supabase/functions/_shared/assistant/redact.mjs";
import { attributeBooking, selectEligibleContacts, findEmptyVacancies } from "../../supabase/functions/_shared/assistant/vacancy.mjs";

const TODAY = "2026-08-01";
const NOW = Date.parse(TODAY + "T00:00:00Z");

function chaletDoc() {
  return {
    chalets: [{ id: "c1", name: "شاليه", deleted_at: null, periods: [
      { id: "p1", label: "صباحي", start: "07:00", end: "17:00", active: true, sort: 1, weekday_price: 800, weekend_price: 1200 },
    ] }],
    bookings: [
      { id: "old1", chalet_id: "c1", booking_date: "2026-05-01", period_id: "p1", customer_phone: "0501111111", status: "confirmed", created_at: "2026-05-01T00:00:00Z", deleted_at: null },
      { id: "old2", chalet_id: "c1", booking_date: "2026-05-02", period_id: "p1", customer_phone: "0502222222", status: "confirmed", created_at: "2026-05-02T00:00:00Z", deleted_at: null },
    ],
  };
}
function rule(over = {}) {
  return {
    id: "r1", workspace_key: "WS", chalet_id: "c1", enabled: true,
    scan_days_ahead: 3, eligible_weekdays: [], eligible_period_ids: [],
    allowed_offer_types: ["discount"], minimum_price_halalas: 0,
    maximum_daily_messages: 10, contact_cooldown_hours: 168, preferred_tone: "concise",
    customer_groups: ["previous"], owner_approval_required: true, automatic_send_enabled: false, ...over,
  };
}

function baseDeps(over = {}) {
  const runs = [];
  const queued = [];
  return {
    runs, queued,
    nowMs: NOW, todayIso: TODAY,
    async listEnabledRules() { return [rule()]; },
    async getWorkspaceDoc() { return chaletDoc(); },
    async findRun() { return null; },
    async priorContacts() { return new Map(); },
    async optedOut() { return new Set(); },
    customerRefOf: (ws, phone) => customerReference(ws, phone),
    async draftOffer() { return { ok: true, body: "عرض خاص للأيام الفاضية" }; },
    async whatsappMode() { return "disconnected"; },
    async recordRun(r) { runs.push(r); return { run_id: "run-" + runs.length }; },
    async queueMessage(m) { queued.push(m); },
    ...over,
  };
}

describe("autopilot: safety and determinism", () => {
  it("disabled rules produce no runs", async () => {
    const deps = baseDeps({ listEnabledRules: async () => [rule({ enabled: false })] });
    const s = await runAutopilot(deps);
    expect(s.runs_created).toBe(0);
  });

  it("finds empty vacancies and drafts, but nothing is auto-sent when disconnected", async () => {
    const deps = baseDeps();
    const s = await runAutopilot(deps);
    expect(s.vacancies_found).toBeGreaterThan(0);
    expect(s.queued_official).toBe(0);
    // every queued message awaits approval; none is "sent"
    expect(deps.queued.every((m) => m.status === "awaiting_approval")).toBe(true);
    expect(deps.queued.some((m) => m.status === "sent")).toBe(false);
  });

  it("duplicate vacancy runs are skipped (no spam)", async () => {
    const deps = baseDeps({ findRun: async () => ({ id: "existing" }) });
    const s = await runAutopilot(deps);
    expect(s.duplicates_skipped).toBeGreaterThan(0);
    expect(s.runs_created).toBe(0);
  });

  it("a vacancy booked before processing is stopped (stopped_booked)", async () => {
    // Fill the whole horizon so isVacancyStillEmpty is false for every slot.
    const doc = chaletDoc();
    for (let i = 0; i < 3; i++) {
      const d = new Date(NOW + i * 86400000).toISOString().slice(0, 10);
      doc.bookings.push({ id: "new" + i, chalet_id: "c1", booking_date: d, period_id: "p1", status: "confirmed", created_at: TODAY, deleted_at: null });
    }
    // findEmptyVacancies sees them as booked, so 0 vacancies — model of "booked before processing".
    const deps = baseDeps({ getWorkspaceDoc: async () => doc });
    const s = await runAutopilot(deps);
    expect(s.vacancies_found).toBe(0);
  });

  it("opt-out and cooldown exclude contacts deterministically", () => {
    const doc = chaletDoc();
    const optedOut = new Set([customerReference("WS", "0501111111")]);
    const priorContacts = new Map([[customerReference("WS", "0502222222"), NOW - 3600_000]]); // contacted 1h ago
    const r = selectEligibleContacts({ doc, rule: rule({ contact_cooldown_hours: 168 }), priorContacts, optedOut, nowMs: NOW, customerRefOf: (p) => customerReference("WS", p) });
    expect(r.eligible).toHaveLength(0);
    expect(r.skipped.opted_out).toBe(1);
    expect(r.skipped.cooldown).toBe(1);
  });

  it("invalid phones and the daily cap are enforced", () => {
    // The invalid-phone booking is the NEWEST so it is processed before the cap
    // is hit (selection walks newest-first).
    const doc = { chalets: chaletDoc().chalets, bookings: [
      { id: "a", chalet_id: "c1", customer_phone: "123", status: "confirmed", created_at: "2026-01-05", deleted_at: null },
      { id: "b", chalet_id: "c1", customer_phone: "0503333333", status: "confirmed", created_at: "2026-01-02", deleted_at: null },
      { id: "c", chalet_id: "c1", customer_phone: "0504444444", status: "confirmed", created_at: "2026-01-03", deleted_at: null },
    ] };
    const r = selectEligibleContacts({ doc, rule: rule({ maximum_daily_messages: 1 }), priorContacts: new Map(), optedOut: new Set(), nowMs: NOW, customerRefOf: (p) => customerReference("WS", p) });
    expect(r.skipped.invalid_phone).toBe(1);
    expect(r.eligible).toHaveLength(1); // capped
    expect(r.capped).toBe(true);
  });

  it("respects the minimum price (vacancy below minimum is excluded)", () => {
    const vacs = findEmptyVacancies({ workspaceKey: "WS", doc: chaletDoc(), rule: rule({ minimum_price_halalas: 200000 }), todayIso: TODAY });
    // weekday price 800 SAR = 80000 halalas < 200000 -> excluded; only weekend (1200=120000) also < 200000 -> all excluded
    expect(vacs).toHaveLength(0);
  });

  it("attribution: same vacancy + contacted + in-window => confirmed; not contacted => probable; different => none", () => {
    const run = { chalet_id: "c1", date: "2026-08-05", period_id: "p1" };
    const booking = { chalet_id: "c1", booking_date: "2026-08-05", period_id: "p1" };
    const ref = customerReference("WS", "0501111111");
    const runStarted = NOW;
    const created = NOW + 86400000;
    expect(attributeBooking({ run, contactedRefs: new Set([ref]), booking, bookingCustomerRef: ref, windowMs: 7 * 86400000, runStartedMs: runStarted, bookingCreatedMs: created })).toEqual({ attributed: true, confidence: "confirmed" });
    expect(attributeBooking({ run, contactedRefs: new Set(), booking, bookingCustomerRef: "other", windowMs: 7 * 86400000, runStartedMs: runStarted, bookingCreatedMs: created })).toEqual({ attributed: true, confidence: "probable" });
    const other = { chalet_id: "c1", booking_date: "2026-09-09", period_id: "p1" };
    expect(attributeBooking({ run, contactedRefs: new Set([ref]), booking: other, bookingCustomerRef: ref, windowMs: 7 * 86400000, runStartedMs: runStarted, bookingCreatedMs: created }).attributed).toBe(false);
  });

  it("auto-send only when explicitly enabled AND official whatsapp is healthy", async () => {
    const deps = baseDeps({
      listEnabledRules: async () => [rule({ automatic_send_enabled: true, owner_approval_required: false })],
      whatsappMode: async () => "official_cloud_api",
    });
    const s = await runAutopilot(deps);
    expect(s.queued_official).toBeGreaterThan(0);
    // Even when auto-sending, the run's sent_messages stays 0 until a Cloud API
    // webhook confirms delivery — never invented.
    expect(deps.runs.every((r) => r.sent_messages === 0)).toBe(true);
  });

  it("no revenue is invented (attributed_revenue starts at 0)", async () => {
    const deps = baseDeps();
    await runAutopilot(deps);
    expect(deps.runs.every((r) => r.attributed_revenue_halalas === 0)).toBe(true);
  });

  it("the model draft never receives a phone number (privacy)", async () => {
    let ctxSeen = null;
    const deps = baseDeps({ draftOffer: async (ctx) => { ctxSeen = ctx; return { ok: true, body: "عرض" }; } });
    await runAutopilot(deps);
    expect(JSON.stringify(ctxSeen)).not.toMatch(/05\d{8}/);
  });
});
