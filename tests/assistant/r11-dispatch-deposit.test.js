// R11 — DISPATCH + DEPOSIT regressions for the chalet-assistant handler and the
// booking resolver/executor. Seven adversarial findings, each proven against the
// REAL deployed pipeline (handler + planner + resolver + executor) with the model
// forced UNREACHABLE — every convo turn asserts model_calls === 0 so nothing here
// silently rode the LLM.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { convo } from "/tmp/claude-0/-home-user-index-html/b2f2de9e-599a-5acd-b19d-df4e536dbc41/scratchpad/audit-harness.mjs";
import { resolveChaletReference } from "../../supabase/functions/_shared/assistant/booking-resolution.mjs";
import { redactText } from "../../supabase/functions/_shared/assistant/redact.mjs";

const prepared = (r) => (r.raw.tool_results || []).find((x) => x.kind === "prepared_action");

// A minimal 2-chalet workspace whose names SHARE a prefix — the shape that made
// a non-exact partial silently bind the wrong chalet (A-P1-9).
function prefixDoc() {
  const period = { id: "p", label: "مسائي", start: "19:00", end: "05:00", active: true, weekday_price: 100, weekend_price: 100 };
  return {
    schema_version: 3,
    settings: { facility_name: "x", holidays: [] },
    chalets: [
      { id: "noor", name: "نور", capacity: 10, deleted_at: null, periods: [period] },
      { id: "noorshams", name: "نور الشمس", capacity: 10, deleted_at: null, periods: [period] },
    ],
    bookings: [],
  };
}

describe("R11 — deposit wiring (A-P0-1 + B-P0-1): «عربون N» reaches the card AND the saved booking", () => {
  it("captures paid, renders «المدفوع», and persists paid on the CONFIRMED booking (never 0)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 500 ريال عربون 200");
    expect(r.model_calls).toBe(0);
    // Deposit captured into the draft; the total is NOT overwritten by it.
    expect(r.fields.paid).toBe(200);
    expect(r.fields.total).toBe(500);
    // The confirmation card shows BOTH the deposit and the grand total.
    expect(r.card).toContainEqual({ k: "المدفوع", v: "200 ريال", ltr: true });
    expect(r.card).toContainEqual({ k: "الإجمالي", v: "500 ريال", ltr: true });

    // Drive the real confirm — the SAVED booking must carry paid = 200, not 0.
    const prep = prepared(r);
    expect(prep).toBeTruthy();
    const conf = await c.post({ invoke_tool: { name: "confirm_booking_create", arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(conf.ok).toBe(true);
    expect(c.deps._executed).toHaveLength(1);
    expect(c.deps._executed[0].payload.args.paid).toBe(200);
    expect(c.deps._executed[0].payload.args.total).toBe(500);
    // The entire flow (prepare + confirm) never touched the model.
    expect(c.deps._modelCalls).toHaveLength(0);
  });

  it("a deposit-only «عربون 500 ريال» sets paid but must NOT become the total", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي عربون 500 ريال");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(500);
    // The total stays OPEN (asked for) — the deposit never masqueraded as 500.
    expect(r.fields.total == null).toBe(true);
    expect(r.fields.pending_q && r.fields.pending_q.kind).toBe("total");
  });
});

describe("R11 — A-P0-4: the loose «ابي/ابغى … حجز» stem no longer hijacks READ/EDIT questions", () => {
  it("a READ count question does NOT open a create draft (and stays model-free)", async () => {
    const c = convo();
    const r = await c.say("ابغى اعرف كم حجز عندي اليوم");
    expect(r.model_calls).toBe(0);
    expect(r.fields).toBeNull(); // no create draft opened
    expect(r.reply).not.toContain("باقي فقط"); // not the create remaining-fields prompt
  });

  it("an EDIT request does NOT open a create draft (routes to a booking lookup)", async () => {
    const c = convo();
    const r = await c.say("بغيت اعدل حجز احمد");
    expect(r.model_calls).toBe(0);
    expect(r.fields).toBeNull();
    expect(r.reply).not.toContain("باقي فقط");
  });

  it("a genuine create intent STILL opens the draft", async () => {
    const c1 = convo();
    const r1 = await c1.say("ابغى حجز جديد لعلي بكرة");
    expect(r1.model_calls).toBe(0);
    expect(r1.fields).not.toBeNull();
    expect(r1.fields.pending_q).toBeTruthy(); // a draft is being filled

    const c2 = convo();
    const r2 = await c2.say("ابغى منك حجز تولوم");
    expect(r2.model_calls).toBe(0);
    expect(r2.fields.chalet_id).toBe("tulum"); // the loose stem still creates + binds
  });
});

describe("R11 — A-P1-9: a non-exact partial no longer binds the WRONG chalet", () => {
  it("«نور القمر» (unregistered) does NOT bind «نور»", () => {
    const r = resolveChaletReference(prefixDoc(), { chalet_name: "نور القمر" });
    expect(r.ok).toBe(false);
    expect(["CHALET_NOT_FOUND", "CHALET_AMBIGUOUS"]).toContain(r.error);
  });

  it("«شمس» (mid-token substring) does NOT bind «نور الشمس»", () => {
    const r = resolveChaletReference(prefixDoc(), { chalet_name: "شمس" });
    expect(r.ok).toBe(false);
    expect(["CHALET_NOT_FOUND", "CHALET_AMBIGUOUS"]).toContain(r.error);
  });

  it("exact names still bind, and a unique embedded name is unaffected", () => {
    expect(resolveChaletReference(prefixDoc(), { chalet_name: "نور" })).toMatchObject({ ok: true, chalet: { name: "نور" } });
    expect(resolveChaletReference(prefixDoc(), { chalet_name: "نور الشمس" })).toMatchObject({ ok: true, chalet: { name: "نور الشمس" } });
  });

  it("does NOT regress the rich workspace: «تولوم» still binds «شاليه تولوم» end-to-end", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_id).toBe("tulum");
    expect(r.fields.chalet_name).toBe("شاليه تولوم");
  });
});

describe("R11 — A-P2-4: a READ question that names a chalet must not swap the drafted chalet", () => {
  it("«كم سعر شاليه سكاي؟» leaves the tulum draft's chalet unchanged", async () => {
    const c = convo();
    const r0 = await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    expect(r0.model_calls).toBe(0);
    expect(r0.fields.chalet_name).toBe("شاليه تولوم");
    const r1 = await c.say("كم سعر شاليه سكاي؟");
    expect(r1.model_calls).toBe(0);
    expect(r1.fields.chalet_name).toBe("شاليه تولوم"); // NOT swapped to sky
  });

  it("a genuine correction «لا الشاليه سكاي» STILL swaps to sky (R9 behavior kept)", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    const r1 = await c.say("لا الشاليه سكاي");
    expect(r1.model_calls).toBe(0);
    expect(r1.fields.chalet_name).toBe("شاليه سكاي");
  });
});

describe("R11 — A-P1-2: a SOFT cancel mid-PICK re-offers the options instead of tearing down the draft", () => {
  async function openPick() {
    const c = convo({ conflictToday: true });
    const r = await c.say("احجز تولوم اليوم مسائي 4 ضيوف باسم علي بمبلغ 500");
    expect(r.model_calls).toBe(0);
    expect(r.fields.pending_q && r.fields.pending_q.kind).toBe("pick"); // options offered
    return c;
  }

  it("«ما ابي» during a pick keeps the draft alive and re-offers the choices", async () => {
    const c = await openPick();
    const r = await c.say("ما ابي");
    expect(r.model_calls).toBe(0);
    expect(r.reply).not.toContain("تم الإلغاء"); // NOT cancelled
    expect(r.next_actions.length).toBeGreaterThan(0); // options re-offered
    expect(c.deps._drafts.get("th-1").status).toBe("active"); // draft survived
  });

  it("«الغِ الحجز» during a pick STILL cancels", async () => {
    const c = await openPick();
    const r = await c.say("الغِ الحجز");
    expect(r.model_calls).toBe(0);
    expect(r.reply).toContain("تم الإلغاء");
    expect(c.deps._drafts.get("th-1").status).toBe("cancelled");
  });
});

describe("R11 — A-P1-3: «بعد المغرب» is a period phrase, not a blocked date opener", () => {
  async function openPeriodPending() {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    expect(r.model_calls).toBe(0);
    expect(r.fields.pending_q && r.fields.pending_q.kind).toBe("period");
    return c;
  }

  it("«بعد المغرب» is treated as a period phrase (never «لم أفهم ردّك»)", async () => {
    const c = await openPeriodPending();
    const r = await c.say("بعد المغرب");
    expect(r.model_calls).toBe(0);
    expect(r.reply).not.toContain("لم أفهم"); // reached the period resolver, not the gibberish fallback
  });

  it("«بعد يومين» stays blocked as a date (still asks for the period)", async () => {
    const c = await openPeriodPending();
    const r = await c.say("بعد يومين");
    expect(r.model_calls).toBe(0);
    expect(r.fields.pending_q && r.fields.pending_q.kind).toBe("period"); // date consumed, period still open
  });
});

describe("R11 — C-P9-3: model-supplied customer_name/notes are redacted before entering the draft", () => {
  it("the handler wraps the model's customer_name AND notes in redactText (static guard)", () => {
    const src = readFileSync(new URL("../../supabase/functions/chalet-assistant/handler.mjs", import.meta.url), "utf8");
    expect(src).toContain("customer_name: redactText(bf.customer_name)");
    expect(src).toContain("notes: redactText(bf.notes)");
  });

  it("redactText masks a phone a model might echo into a name/notes field", () => {
    const masked = redactText("علي 0501234567");
    expect(masked).not.toContain("0501234567"); // the raw phone can never enter the draft/card
  });
});
