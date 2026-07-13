// CORPUS — CONFIRMED BOOKINGS. A large DATA-DRIVEN proof that the deterministic
// Booking Agent understands a booking end-to-end: for ≥110 distinct booking
// specs (varying chalet, period, date, guests, price, optional deposit,
// optional phone, and dialect wording) it drives the REAL handler pipeline
// create → prepare → confirm → saved with the model forced UNREACHABLE. EVERY
// conversational turn is asserted model-free: each say() reports model_calls===0
// and each confirm post leaves deps._modelCalls empty (the confirm response
// carries no model_calls field — the deterministic guarantee is the recorded
// call log). Each spec asserts a prepared_action was produced, the confirm
// returns ok, exactly one booking was executed, and the SAVED args match the
// spec (chalet + period bound to real ids, guests, total, date, name, and the
// deposit `paid` / masked phone when present).
import { describe, it, expect } from "vitest";
import { convo, TODAY, addDays } from "./helpers/audit-harness.mjs";

const cardVal = (card, key) => {
  const row = (card || []).find((r) => r.k === key);
  return row ? row.v : undefined;
};
const prepared = (r) => (r.raw.tool_results || []).find((x) => x.kind === "prepared_action");
const maskOf = (phone) => "05" + "••••" + String(phone).slice(-4);

// Build ≥110 booking specs. Guests are always clamped to the chalet capacity so
// the capacity guard never rejects one; periods only ever name a slot that
// actually exists on that chalet (richDoc): tulum → صباحي/مسائي/فترة5/الفترة 6,
// تولوم 2 → مسائي only, سكاي → صباحي/مسائي. ISO dates ride «بتاريخ …» at the end
// of the sentence so their leading digits never fuse onto the chalet name.
function buildSpecs() {
  const CHALETS = {
    tulum: { word: "تولوم", cap: 20, periods: [["صباحي", "am"], ["مسائي", "pm"], ["فترة5", "f5"], ["الفترة 6", "f6"]] },
    tulum2: { word: "تولوم 2", cap: 10, periods: [["مسائي", "t2pm"]] },
    sky: { word: "سكاي", cap: 8, periods: [["صباحي", "s-am"], ["مسائي", "s-pm"]] },
  };
  const DATES = [
    { expr: "بكرة", iso: addDays(TODAY, 1) },
    { expr: "بعد بكرة", iso: addDays(TODAY, 2) },
    { expr: "بعد يومين", iso: addDays(TODAY, 2) },
    { expr: "بعد ٣ ايام", iso: addDays(TODAY, 3) },
    { expr: "بعد ٤ ايام", iso: addDays(TODAY, 4) },
    { expr: "عقب اسبوع", iso: addDays(TODAY, 7) },
  ];
  const NAMES = ["علي", "سعد", "فهد", "منى", "ريم", "خالد", "نورة", "محمد", "عبدالله", "سلمان", "منيرة", "ابو محمد"];
  const PRICES = [300, 350, 400, 450, 500, 600, 700, 250];
  const specs = [];
  let i = 0;

  // (A) base matrix — every (chalet, period) crossed with rotating date / guests
  // / price / name variations.
  for (const [cid, ch] of Object.entries(CHALETS)) {
    for (const [pWord, pid] of ch.periods) {
      for (let v = 0; v < 13; v += 1) {
        const date = DATES[(i + v) % DATES.length];
        const guests = ((i + v) % ch.cap) + 1; // 1..cap
        const total = PRICES[(i + v) % PRICES.length];
        const name = NAMES[(i + v) % NAMES.length];
        specs.push({
          kind: "base",
          chaletId: cid, periodId: pid, guests, total, name, bookingDate: date.iso,
          msg: `احجز ${ch.word} ${date.expr} ${pWord} ${guests} ضيوف باسم ${name} بمبلغ ${total}`,
        });
        i += 1;
      }
    }
  }

  // (B) ISO-dated specs — «بتاريخ YYYY-MM-DD» at the very end.
  const ISO = [addDays(TODAY, 30), addDays(TODAY, 40), addDays(TODAY, 55), addDays(TODAY, 60), addDays(TODAY, 25), addDays(TODAY, 33), addDays(TODAY, 48), addDays(TODAY, 70)];
  const isoCombos = [
    ["tulum", "تولوم", "مسائي", "pm"], ["sky", "سكاي", "صباحي", "s-am"],
    ["tulum2", "تولوم 2", "مسائي", "t2pm"], ["tulum", "تولوم", "فترة5", "f5"],
    ["tulum", "تولوم", "صباحي", "am"], ["sky", "سكاي", "مسائي", "s-pm"],
    ["tulum", "تولوم", "الفترة 6", "f6"], ["tulum2", "تولوم 2", "مسائي", "t2pm"],
  ];
  isoCombos.forEach((combo, k) => {
    const [cid, word, pWord, pid] = combo;
    const iso = ISO[k % ISO.length];
    const guests = (k % 5) + 2;
    specs.push({
      kind: "iso",
      chaletId: cid, periodId: pid, guests, total: 500, name: "علي", bookingDate: iso,
      msg: `احجز ${word} ${pWord} ${guests} ضيوف باسم علي بمبلغ 500 بتاريخ ${iso}`,
    });
  });

  // (C) deposit specs (≥15) — «الاجمالي N عربون M»: saved paid must be > 0 and
  // the deposit must never masquerade as (or erase) the total.
  const depositBase = [
    ["tulum", "تولوم", "صباحي", "am"], ["tulum", "تولوم", "مسائي", "pm"],
    ["tulum", "تولوم", "فترة5", "f5"], ["tulum", "تولوم", "الفترة 6", "f6"],
    ["tulum2", "تولوم 2", "مسائي", "t2pm"], ["sky", "سكاي", "صباحي", "s-am"], ["sky", "سكاي", "مسائي", "s-pm"],
  ];
  const depPairs = [[500, 200], [600, 250], [800, 300], [450, 150], [700, 350], [400, 100], [900, 450], [550, 250], [650, 300], [750, 200], [300, 100], [1000, 500], [480, 240], [520, 260], [860, 430], [420, 120]];
  depPairs.forEach((pair, k) => {
    const [cid, word, pWord, pid] = depositBase[k % depositBase.length];
    const date = DATES[k % DATES.length];
    const [total, paid] = pair;
    const guests = (k % 6) + 2;
    specs.push({
      kind: "deposit",
      chaletId: cid, periodId: pid, guests, total, paid, name: "علي", bookingDate: date.iso,
      msg: `احجز ${word} ${date.expr} ${pWord} ${guests} ضيوف باسم علي الاجمالي ${total} عربون ${paid}`,
    });
  });

  // (D) phone specs (≥10) — a stated Saudi mobile must appear MASKED on the card
  // «الجوال», never leak raw into the reply, and be bound onto the saved booking.
  const phones = ["0501234567", "0559876543", "0533334444", "0512345678", "0567654321", "0581112222", "0544445555", "0522223333", "0509998888", "0538887777", "0571113333"];
  phones.forEach((phone, k) => {
    const [cid, word, pWord, pid] = depositBase[k % depositBase.length];
    const date = DATES[(k + 2) % DATES.length];
    const guests = (k % 6) + 2;
    const total = PRICES[k % PRICES.length];
    specs.push({
      kind: "phone",
      chaletId: cid, periodId: pid, guests, total, name: "علي", bookingDate: date.iso, phone,
      msg: `احجز ${word} ${date.expr} ${pWord} ${guests} ضيوف باسم علي جواله ${phone} بمبلغ ${total}`,
    });
  });

  // (E) dialect / wording-variety specs.
  specs.push({ kind: "dialect", chaletId: "tulum", periodId: "am", guests: 4, total: 300, name: "ابو محمد", bookingDate: addDays(TODAY, 1), msg: "ابغى احجز شالية تولوم بكره الصباحية لأربعة اشخاص باسم ابو محمد والسعر ٣٠٠" });
  specs.push({ kind: "dialect", chaletId: "sky", periodId: "s-pm", guests: 3, total: 400, name: "منيرة", bookingDate: addDays(TODAY, 2), msg: "سجل حجز جديد في سكاي بعد بكرة بالليل عدد ٣ باسم منيرة بمبلغ ٤٠٠" });
  specs.push({ kind: "dialect", chaletId: "tulum", periodId: "pm", guests: 5, total: 500, name: "علي", bookingDate: addDays(TODAY, 1), msg: "احجز تولوم بكرة مسائي ٥ ضيوف باسم علي بمبلغ ٥٠٠" });

  // Stamp a stable, unique label onto every spec (index + intent + slot).
  return specs.map((s, n) => ({
    ...s,
    label: `#${String(n + 1).padStart(3, "0")} ${s.kind} ${s.chaletId}/${s.periodId} ${s.bookingDate} g${s.guests}${s.paid ? ` عربون${s.paid}` : ""}${s.phone ? " +جوال" : ""}`,
  }));
}

const SPECS = buildSpecs();
const DEPOSIT_SPECS = SPECS.filter((s) => s.paid);
const PHONE_SPECS = SPECS.filter((s) => s.phone);

describe("corpus — confirmed bookings (create → confirm → saved, model offline)", () => {
  it(`builds a large corpus: ≥110 specs, ≥15 deposits, ≥10 phones`, () => {
    expect(SPECS.length).toBeGreaterThanOrEqual(110);
    expect(DEPOSIT_SPECS.length).toBeGreaterThanOrEqual(15);
    expect(PHONE_SPECS.length).toBeGreaterThanOrEqual(10);
    // Labels are unique so each it.each row is a distinct, addressable test.
    expect(new Set(SPECS.map((s) => s.label)).size).toBe(SPECS.length);
  });

  it.each(SPECS)("$label", async (spec) => {
    const c = convo();
    const r = await c.say(spec.msg);
    // The whole understanding is deterministic — the create turn never touched
    // the model.
    expect(r.model_calls).toBe(0);

    // A confirmation card was prepared (nothing saved yet).
    const prep = prepared(r);
    expect(prep).toBeTruthy();
    expect(c.deps._executed).toHaveLength(0);

    // A stated phone is masked on the card and never leaks raw into the reply.
    if (spec.phone) {
      expect(cardVal(r.card, "الجوال")).toBe(maskOf(spec.phone));
      expect(r.reply).not.toContain(spec.phone);
    }
    // A deposit renders «المدفوع» alongside the untouched «الإجمالي».
    if (spec.paid) {
      expect(r.card).toContainEqual({ k: "المدفوع", v: `${spec.paid} ريال`, ltr: true });
      expect(r.card).toContainEqual({ k: "الإجمالي", v: `${spec.total} ريال`, ltr: true });
    }

    // Drive the REAL confirm on the same thread.
    const okc = await c.post({
      invoke_tool: { name: prep.confirm_tool, arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } },
    });
    expect(okc.ok).toBe(true);
    // The confirm post is deterministic too: no model call was ever recorded
    // across the whole conversation.
    expect(c.deps._modelCalls).toHaveLength(0);

    // Exactly ONE booking was saved, with the args the owner actually stated.
    expect(c.deps._executed).toHaveLength(1);
    const saved = c.deps._executed[0].payload.args;
    expect(saved.chalet_id).toBe(spec.chaletId);
    expect(saved.period_id).toBe(spec.periodId);
    expect(saved.booking_date).toBe(spec.bookingDate);
    expect(saved.guests).toBe(spec.guests);
    expect(saved.total).toBe(spec.total);
    expect(saved.customer_name).toBe(spec.name);
    if (spec.paid) expect(saved.paid).toBe(spec.paid);
    if (spec.phone) expect(saved.customer_phone).toBe(spec.phone);
  });
});
