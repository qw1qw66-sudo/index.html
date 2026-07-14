// CORPUS — SCENARIOS. A broad, deterministic proof that the Booking Agent
// UNDERSTANDS the space of a booking message: dates, times/periods, guest
// counts, money, customer names, chalet references, phone privacy, deposits,
// read-vs-create dispatch, multi-turn corrections, and conflict picks — each
// case a distinct input asserting the SPECIFIC field(s) it should extract (or
// the reply behavior it should produce). Everything runs against the REAL
// handler with the model forced UNREACHABLE, so EVERY say()/post() turn is
// asserted model-free (model_calls === 0, or an empty deps._modelCalls for the
// confirm post, which carries no model_calls field).
import { describe, it, expect } from "vitest";
import { convo, TODAY, addDays, replyProblems } from "./helpers/audit-harness.mjs";

const cardVal = (card, key) => {
  const row = (card || []).find((r) => r.k === key);
  return row ? row.v : undefined;
};
const prepared = (r) => (r.raw.tool_results || []).find((x) => x.kind === "prepared_action");
const maskOf = (phone) => "05" + "••••" + String(phone).slice(-4);

// Next occurrence of a UTC weekday (0=Sun) from todayIso; forceNext bumps a
// same-weekday match to +7 (mirrors nl-normalize's «القادم» rule). Kept in-file
// (the task allows only harness + vitest imports) and mirrors the source math.
function nextDow(todayIso, targetDow, forceNext = false) {
  const [y, m, d] = todayIso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let delta = (targetDow - dow + 7) % 7;
  if (delta === 0 && forceNext) delta = 7;
  return addDays(todayIso, delta);
}
// A day/month with no year -> this year, rolling forward one year only if past.
function dayMonth(day, month) {
  const y = Number(TODAY.slice(0, 4));
  const p2 = (n) => String(n).padStart(2, "0");
  const iso = `${y}-${p2(month)}-${p2(day)}`;
  return iso < TODAY ? `${y + 1}-${p2(month)}-${p2(day)}` : iso;
}
const FIRST_NEXT_MONTH = (() => {
  const [y, mo] = TODAY.split("-").map(Number);
  const ny = mo === 12 ? y + 1 : y;
  const nmo = mo === 12 ? 1 : mo + 1;
  return `${ny}-${String(nmo).padStart(2, "0")}-01`;
})();

// ===========================================================================
// DATES — the phrase is appended to a complete سكاي booking so the pipeline
// runs deterministically; we assert the resolved fields.booking_date.
// ===========================================================================
describe("dates", () => {
  const OPENER = "احجز سكاي مسائي ٤ ضيوف باسم علي بمبلغ ٣٥٠ ";
  const cases = [
    { d: "«بكرة» = +1", phrase: "بكرة", exp: addDays(TODAY, 1) },
    { d: "«بعد بكرة» = +2", phrase: "بعد بكرة", exp: addDays(TODAY, 2) },
    { d: "«بعد يومين» = +2", phrase: "بعد يومين", exp: addDays(TODAY, 2) },
    { d: "«بعد ٣ ايام» = +3", phrase: "بعد ٣ ايام", exp: addDays(TODAY, 3) },
    { d: "«بعد 3 ايام» (ascii) = +3", phrase: "بعد 3 ايام", exp: addDays(TODAY, 3) },
    { d: "«بعد ٤ ايام» = +4", phrase: "بعد ٤ ايام", exp: addDays(TODAY, 4) },
    { d: "«عقب اسبوع» = +7", phrase: "عقب اسبوع", exp: addDays(TODAY, 7) },
    { d: "«بعد اسبوع» = +7", phrase: "بعد اسبوع", exp: addDays(TODAY, 7) },
    { d: "«بعد اسبوعين» = +14", phrase: "بعد اسبوعين", exp: addDays(TODAY, 14) },
    { d: "«بعد ٣ اسابيع» = +21", phrase: "بعد ٣ اسابيع", exp: addDays(TODAY, 21) },
    { d: "«الخميس» = next Thursday", phrase: "الخميس", exp: nextDow(TODAY, 4) },
    { d: "«الجمعة القادمة» = coming Friday", phrase: "الجمعة القادمة", exp: nextDow(TODAY, 5, true) },
    { d: "«الخميس القادم» on non-Thursday = coming Thursday", phrase: "الخميس القادم", exp: nextDow(TODAY, 4, true) },
    { d: "«بعد يوم الجمعة» resolves Friday", phrase: "بعد يوم الجمعة", exp: nextDow(TODAY, 5) },
    { d: "«نهاية الاسبوع» = coming Thursday", phrase: "نهاية الاسبوع", exp: nextDow(TODAY, 4) },
    { d: "«اول الشهر» = 1st of next month", phrase: "اول الشهر", exp: FIRST_NEXT_MONTH },
    { d: "ISO «2026-08-15»", phrase: "2026-08-15", exp: "2026-08-15" },
    { d: "slashed ISO «2026/8/15»", phrase: "2026/8/15", exp: "2026-08-15" },
    { d: "day/month «15/8» rolls to the coming 15 Aug", phrase: "15/8", exp: dayMonth(15, 8) },
  ];
  it.each(cases)("$d", async ({ phrase, exp }) => {
    const c = convo();
    const r = await c.say(OPENER + phrase);
    expect(r.model_calls).toBe(0);
    expect(r.fields.booking_date).toBe(exp);
  });
});

// ===========================================================================
// TIMES & PERIODS
// ===========================================================================
describe("times & periods", () => {
  const periodCases = [
    { d: "«صباحي» binds tulum morning", msg: "احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300", pid: "am" },
    { d: "«مسائي» binds tulum evening", msg: "احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500", pid: "pm" },
    { d: "«فترة5» binds فترة 5", msg: "احجز تولوم بكرة فترة5 4 ضيوف باسم علي بمبلغ 450", pid: "f5" },
    { d: "«الفترة 6» binds الفترة 6", msg: "احجز تولوم بكرة الفترة 6 4 ضيوف باسم علي بمبلغ 400", pid: "f6" },
    { d: "«الفترة خمسة» (spoken number) binds فترة 5", msg: "احجز تولوم بكرة الفترة خمسة 4 ضيوف باسم علي بمبلغ 450", pid: "f5" },
    { d: "«سكاي صباحي» binds sky morning", msg: "احجز سكاي بكرة صباحي 4 ضيوف باسم علي بمبلغ 300", pid: "s-am" },
    { d: "«سكاي مسائي» binds sky evening", msg: "احجز سكاي بكرة مسائي 4 ضيوف باسم علي بمبلغ 350", pid: "s-pm" },
  ];
  it.each(periodCases)("$d", async ({ msg, pid }) => {
    const c = convo();
    const r = await c.say(msg);
    expect(r.model_calls).toBe(0);
    expect(r.fields.period_id).toBe(pid);
  });

  const timeCases = [
    { d: "«من 7 مساء الى 5 صباحا» overnight 19:00→05:00", phrase: "من 7 مساء الى 5 صباحا", start: "19:00", end: "05:00", wrap: true },
    { d: "«من ٧ مساء الى ٥» single-marker overnight", phrase: "من ٧ مساء الى ٥", start: "19:00", end: "05:00", wrap: true },
    { d: "«من 3 عصرا الى 7» same-day 15:00→19:00 (NOT overnight)", phrase: "من 3 عصرا الى 7", start: "15:00", end: "19:00", wrap: false },
    { d: "«من 1 ظهرا الى 5» same-day 13:00→17:00", phrase: "من 1 ظهرا الى 5", start: "13:00", end: "17:00", wrap: false },
  ];
  it.each(timeCases)("$d", async ({ phrase, start, end, wrap }) => {
    const c = convo();
    const r = await c.say(`احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 300 ${phrase}`);
    expect(r.model_calls).toBe(0);
    expect(r.fields.canonical_start).toBe(start);
    expect(r.fields.canonical_end).toBe(end);
    expect(Boolean(r.fields.wraps_next_day)).toBe(wrap);
  });

  it("«بعد المغرب» is a period phrase, not the gibberish fallback", async () => {
    const c = convo();
    const q = await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    expect(q.model_calls).toBe(0);
    expect(q.fields.pending_q.kind).toBe("period");
    const r = await c.say("بعد المغرب");
    expect(r.model_calls).toBe(0);
    expect(r.reply).not.toContain("لم أفهم");
  });

  it("«بعد يومين» while a period is pending stays a DATE (period still open)", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    const r = await c.say("بعد يومين");
    expect(r.model_calls).toBe(0);
    expect(r.fields.booking_date).toBe(addDays(TODAY, 2));
    expect(r.fields.pending_q.kind).toBe("period");
  });
});

// ===========================================================================
// GUESTS
// ===========================================================================
describe("guests", () => {
  const OPENER = "احجز تولوم بكرة صباحي بمبلغ 300 باسم علي "; // tulum cap 20, no guests
  const cases = [
    { d: "«4 ضيوف» = 4", phrase: "4 ضيوف", exp: 4 },
    { d: "«٤ اشخاص» = 4", phrase: "٤ اشخاص", exp: 4 },
    { d: "«ضيفين» = 2 (dual)", phrase: "ضيفين", exp: 2 },
    { d: "«شخصين» = 2 (dual)", phrase: "شخصين", exp: 2 },
    { d: "«نفرين» = 2 (dual)", phrase: "نفرين", exp: 2 },
    { d: "«عشرة ضيوف» = 10", phrase: "عشرة ضيوف", exp: 10 },
    { d: "«عدد 5» = 5", phrase: "عدد 5", exp: 5 },
    { d: "«عدد 3» (no nights noun) = 3", phrase: "عدد 3", exp: 3 },
    { d: "«3-5 ضيوف» keeps the max = 5", phrase: "3-5 ضيوف", exp: 5 },
    { d: "«لأربعة» = 4", phrase: "لأربعة", exp: 4 },
    { d: "«ثلاثة اشخاص» = 3", phrase: "ثلاثة اشخاص", exp: 3 },
    { d: "«٦ ضيوف» = 6", phrase: "٦ ضيوف", exp: 6 },
  ];
  it.each(cases)("$d", async ({ phrase, exp }) => {
    const c = convo();
    const r = await c.say(OPENER + phrase);
    expect(r.model_calls).toBe(0);
    expect(r.fields.guests).toBe(exp);
  });

  it("«عدد 3 ليالي» is a nights count, NOT guests (never fabricated)", async () => {
    const c = convo();
    const r = await c.say(OPENER + "عدد 3 ليالي");
    expect(r.model_calls).toBe(0);
    // «3 ليالي» is a nights count — it must NEVER be parsed as guests=3. (The
    // rest of the OPENER is complete and guests is optional, so the card is
    // prepared with guests defaulting to 1, never the 3 from «ليالي».)
    expect(r.fields.guests).toBeUndefined();
  });

  it("«من سبعة لخمسة» never fabricates a headcount (explicit 4 survives)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300 من سبعة لخمسة");
    expect(r.model_calls).toBe(0);
    expect(r.fields.guests).toBe(4);
  });
});

// ===========================================================================
// MONEY
// ===========================================================================
describe("money", () => {
  const OPENER = "احجز تولوم بكرة صباحي 4 ضيوف باسم علي "; // no total
  const amountCases = [
    { d: "«300 ريال» = 300", phrase: "300 ريال", exp: 300 },
    { d: "«بمبلغ 450» = 450", phrase: "بمبلغ 450", exp: 450 },
    { d: "«٣ الف» = 3000", phrase: "٣ الف", exp: 3000 },
    { d: "«الاجمالي 3 الف» = 3000 (marker doesn't grab the lone 3)", phrase: "الاجمالي 3 الف", exp: 3000 },
    { d: "«خمس مئة» = 500 (two-token hundreds)", phrase: "خمس مئة", exp: 500 },
    { d: "«خمسمئة» = 500 (one word)", phrase: "خمسمئة", exp: 500 },
    { d: "«الفين» = 2000 (dual thousand)", phrase: "الفين", exp: 2000 },
    { d: "«ثلاثة الاف» = 3000", phrase: "ثلاثة الاف", exp: 3000 },
    { d: "«مئتين» = 200", phrase: "مئتين", exp: 200 },
    { d: "«بمبلغ ٣٥٠٠» = 3500", phrase: "بمبلغ ٣٥٠٠", exp: 3500 },
    { d: "«الاجمالي ٦٠٠» = 600", phrase: "الاجمالي ٦٠٠", exp: 600 },
  ];
  it.each(amountCases)("$d", async ({ phrase, exp }) => {
    const c = convo();
    const r = await c.say(OPENER + phrase);
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBe(exp);
    expect(r.fields.total_source).toBe("explicit");
  });

  it("«مجاني» = a real free zero (total 0, source free)", async () => {
    const c = convo();
    const r = await c.say(OPENER + "مجاني");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBe(0);
    expect(r.fields.total_source).toBe("free");
  });

  it("«مو ببلاش» is NOT free (total stays asked)", async () => {
    const c = convo();
    const r = await c.say(OPENER + "مو ببلاش");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined();
    expect(r.fields.total_source).not.toBe("free");
  });

  it("«7 ليله» is a nights count, never a price", async () => {
    const c = convo();
    const r = await c.say(OPENER + "7 ليله");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined();
  });

  it("«500 ريال للفرد» is per-person, never the grand total", async () => {
    const c = convo();
    const r = await c.say(OPENER + "500 ريال للفرد");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined();
  });

  it("a bare mobile «0501234567» is never a total (phone captured instead)", async () => {
    const c = convo();
    const r = await c.say(OPENER + "0501234567");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined();
    expect(r.private.customer_phone).toBe("0501234567");
  });

  it("«0501234567 ريال» (phone glued to currency) is never a total", async () => {
    const c = convo();
    const r = await c.say(OPENER + "0501234567 ريال");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined();
    expect(r.private.customer_phone).toBe("0501234567");
  });
});

// ===========================================================================
// NAMES
// ===========================================================================
describe("customer names", () => {
  const cases = [
    { d: "«باسم علي» = علي", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم علي", exp: "علي" },
    { d: "«العميل احمد» = احمد", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 العميل احمد", exp: "احمد" },
    { d: "«باسم صباح» (name after explicit marker) = صباح", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم صباح", exp: "صباح" },
    { d: "«باسم عبدالله مسائي» stops at the period adjective = عبدالله", msg: "احجز تولوم بكرة 4 ضيوف بمبلغ 300 باسم عبدالله مسائي", exp: "عبدالله" },
    { d: "«باسم الاستاذة فاطمة» strips the honorific = فاطمة", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم الاستاذة فاطمة", exp: "فاطمة" },
    { d: "«باسم الدكتورة نورة» strips the honorific = نورة", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم الدكتورة نورة", exp: "نورة" },
    { d: "«باسم الاستاذ محمد» strips the honorific = محمد", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم الاستاذ محمد", exp: "محمد" },
    { d: "«باسم محمد لاربعة اشخاص» stops before the guest phrase = محمد", msg: "احجز تولوم بكرة صباحي بمبلغ 300 باسم محمد لاربعة اشخاص", exp: "محمد" },
    { d: "«باسم محمد ضيفين» stops before the dual = محمد", msg: "احجز تولوم بكرة صباحي بمبلغ 300 باسم محمد ضيفين", exp: "محمد" },
    { d: "«باسم ابو محمد» keeps the kunya = ابو محمد", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم ابو محمد", exp: "ابو محمد" },
    { d: "«باسم عبدالله» (control) = عبدالله", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 باسم عبدالله", exp: "عبدالله" },
    { d: "chalet «اسمه سكاي» is skipped; «والعميل احمد» wins = احمد", msg: "احجز الشاليه اسمه سكاي والعميل احمد بكرة صباحي 4 ضيوف بمبلغ 300", exp: "احمد" },
    { d: "«العميل احمد وجواله …» stops at the phone = احمد", msg: "احجز تولوم بكرة صباحي 4 ضيوف بمبلغ 300 العميل احمد وجواله 0501234567", exp: "احمد" },
  ];
  it.each(cases)("$d", async ({ msg, exp }) => {
    const c = convo();
    const r = await c.say(msg);
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe(exp);
  });
});

// ===========================================================================
// CHALETS
// ===========================================================================
describe("chalet references", () => {
  const binds = [
    { d: "«تولوم» binds شاليه تولوم", phrase: "تولوم", cid: "tulum" },
    { d: "«شالية تولوم» (taa-marbuta) binds tulum", phrase: "شالية تولوم", cid: "tulum" },
    { d: "«تولوم 2» binds شاليه تولوم 2", phrase: "تولوم 2", cid: "tulum2" },
    { d: "«شاليه تولوم 2» binds tulum2", phrase: "شاليه تولوم 2", cid: "tulum2" },
    { d: "«سكاي» binds شاليه سكاي", phrase: "سكاي", cid: "sky" },
    { d: "«شاليه سكاي» binds sky", phrase: "شاليه سكاي", cid: "sky" },
  ];
  it.each(binds)("$d", async ({ phrase, cid }) => {
    const c = convo();
    const r = await c.say(`احجز ${phrase} بكرة مسائي 4 ضيوف باسم علي بمبلغ 400`);
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_id).toBe(cid);
  });

  it("a passing READ question «كم سعر شاليه سكاي؟» mid-tulum-draft does NOT swap the chalet", async () => {
    const c = convo();
    const r0 = await c.say("احجز تولوم بكرة 4 ضيوف باسم علي بمبلغ 500");
    expect(r0.model_calls).toBe(0);
    expect(r0.fields.chalet_name).toBe("شاليه تولوم");
    const r1 = await c.say("كم سعر شاليه سكاي؟");
    expect(r1.model_calls).toBe(0);
    expect(r1.fields.chalet_name).toBe("شاليه تولوم");
  });

  it("an unknown chalet «قصر الأحلام» re-asks with the registered names", async () => {
    const c = convo();
    const r = await c.say("احجز قصر الأحلام بكرة مسائي 4 ضيوف باسم علي بمبلغ 400");
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_id).toBeUndefined();
    expect(r.fields.pending_q.kind).toBe("chalet");
    expect(r.reply).toContain("المسجلة");
  });

  it("a second unknown name «شاليه المها» also re-asks (never binds a wrong chalet)", async () => {
    const c = convo();
    const r = await c.say("احجز شاليه المها بكرة مسائي 4 ضيوف باسم علي بمبلغ 400");
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_id).toBeUndefined();
    expect(r.fields.pending_q.kind).toBe("chalet");
  });
});

// ===========================================================================
// PHONES (privacy): masked on the card «الجوال», raw digits absent from reply
// ===========================================================================
describe("phone privacy", () => {
  const cases = [
    { d: "«جواله 0501234567» masked 05••••4567", phone: "0501234567" },
    { d: "«جواله 0559876543» masked 05••••6543", phone: "0559876543" },
    { d: "«جواله 0533334444» masked 05••••4444", phone: "0533334444" },
    { d: "«جواله 0512345678» masked 05••••5678", phone: "0512345678" },
    { d: "«جواله 0567654321» masked 05••••4321", phone: "0567654321" },
    { d: "«جواله 0581112222» masked 05••••2222", phone: "0581112222" },
  ];
  it.each(cases)("$d", async ({ phone }) => {
    const c = convo();
    const r = await c.say(`احجز تولوم بكرة صباحي 4 ضيوف باسم علي جواله ${phone} بمبلغ 300`);
    expect(r.model_calls).toBe(0);
    expect(cardVal(r.card, "الجوال")).toBe(maskOf(phone));
    expect(r.reply).not.toContain(phone);
    expect(r.private.customer_phone).toBe(phone);
    expect(replyProblems(r.reply)).toEqual([]);
  });

  it("Arabic-digit «جواله ٠٥١٢٣٤٥٦٧٨» masks and never leaks either digit form", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي جواله ٠٥١٢٣٤٥٦٧٨ بمبلغ 300");
    expect(r.model_calls).toBe(0);
    expect(cardVal(r.card, "الجوال")).toBe("05••••5678");
    expect(r.private.customer_phone).toBe("0512345678");
    expect(r.reply).not.toContain("0512345678");
    expect(r.reply).not.toContain("٠٥١٢٣٤٥٦٧٨");
  });
});

// ===========================================================================
// DEPOSIT — «عربون/مقدم/دفع N» → fields.paid, never the total; card «المدفوع».
// ===========================================================================
describe("deposit", () => {
  it("«الاجمالي 500 عربون 200» → paid 200, total 500, card «المدفوع»", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 500 عربون 200");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(200);
    expect(r.fields.total).toBe(500);
    expect(r.card).toContainEqual({ k: "المدفوع", v: "200 ريال", ltr: true });
    expect(r.card).toContainEqual({ k: "الإجمالي", v: "500 ريال", ltr: true });
  });

  it("«الاجمالي 800 عربون 300» → paid 300, total untouched at 800", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 800 عربون 300");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(300);
    expect(r.fields.total).toBe(800);
  });

  it("«عربون 200» alone banks paid but leaves the total OPEN (never becomes 200)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي عربون 200");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(200);
    expect(r.fields.total).toBeUndefined();
  });

  it("«مقدم 150» (deposit synonym) → paid 150", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي مقدم 150");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(150);
  });

  it("«الاجمالي 600 دفع 250» (دفع synonym) → paid 250, total 600", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 600 دفع 250");
    expect(r.model_calls).toBe(0);
    expect(r.fields.paid).toBe(250);
    expect(r.fields.total).toBe(600);
  });

  it("«عربون» never erases a stated total (card carries both rows)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 700 عربون 350");
    expect(r.model_calls).toBe(0);
    expect(r.card).toContainEqual({ k: "الإجمالي", v: "700 ريال", ltr: true });
    expect(r.card).toContainEqual({ k: "المدفوع", v: "350 ريال", ltr: true });
  });

  it("a deposit survives all the way to the SAVED booking", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي الاجمالي 500 عربون 200");
    expect(r.model_calls).toBe(0);
    const prep = prepared(r);
    const okc = await c.post({ invoke_tool: { name: prep.confirm_tool, arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(okc.ok).toBe(true);
    expect(c.deps._modelCalls).toHaveLength(0);
    expect(c.deps._executed[0].payload.args.paid).toBe(200);
    expect(c.deps._executed[0].payload.args.total).toBe(500);
  });
});

// ===========================================================================
// DISPATCH — read/edit questions must NOT open a create draft; create does.
// ===========================================================================
describe("dispatch: read vs create", () => {
  const reads = [
    { d: "«ابغى اعرف كم حجز عندي اليوم» is a READ, no draft", msg: "ابغى اعرف كم حجز عندي اليوم" },
    { d: "«بغيت اعدل حجز احمد» is an EDIT, no draft", msg: "بغيت اعدل حجز احمد" },
    { d: "«كم عدد الحجوزات اليوم» is a READ, no draft", msg: "كم عدد الحجوزات اليوم" },
    { d: "«كم حجز اليوم» is a READ, no draft", msg: "كم حجز اليوم" },
  ];
  it.each(reads)("$d", async ({ msg }) => {
    const c = convo();
    const r = await c.say(msg);
    expect(r.model_calls).toBe(0);
    expect(r.fields).toBeNull();
    expect(r.reply).not.toContain("باقي فقط");
  });

  it("«ابغى حجز جديد لعلي بكرة» opens a create draft", async () => {
    const c = convo();
    const r = await c.say("ابغى حجز جديد لعلي بكرة");
    expect(r.model_calls).toBe(0);
    expect(r.fields).not.toBeNull();
    expect(r.fields.pending_q).toBeTruthy();
  });

  it("«ابغى منك حجز تولوم» (loose stem) creates and binds tulum", async () => {
    const c = convo();
    const r = await c.say("ابغى منك حجز تولوم");
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_id).toBe("tulum");
  });

  it("«سجل حجز جديد … في تولوم» opens the deterministic pipeline (never the model)", async () => {
    const c = convo();
    const r = await c.say("سجل حجز جديد لعلي تجربة بكرة مسائي في تولوم");
    expect(r.model_calls).toBe(0);
    expect(r.fields).not.toBeNull();
    expect(r.fields.chalet_id).toBe("tulum");
  });

  it("«احجز تولوم بكرة» opens a create draft", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة");
    expect(r.model_calls).toBe(0);
    expect(r.fields).not.toBeNull();
    expect(r.fields.chalet_id).toBe("tulum");
  });
});

// ===========================================================================
// CORRECTIONS & MULTI-TURN
// ===========================================================================
describe("corrections & multi-turn", () => {
  it("a complete booking arrives in ONE turn (card, nothing saved)", async () => {
    const c = convo();
    const r = await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    expect(r.model_calls).toBe(0);
    expect(prepared(r)).toBeTruthy();
    expect(c.deps._executed).toHaveLength(0);
  });

  it("«لا اقصد ٥ ضيوف» corrects the headcount to 5", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("لا اقصد ٥ ضيوف");
    expect(r.model_calls).toBe(0);
    expect(r.fields.guests).toBe(5);
  });

  it("«خلها بعد بكرة» pushes the date +2", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("خلها بعد بكرة");
    expect(r.model_calls).toBe(0);
    expect(r.fields.booking_date).toBe(addDays(TODAY, 2));
  });

  it("«خل التاريخ 2026-09-20» corrects to the ISO date", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("خل التاريخ 2026-09-20");
    expect(r.model_calls).toBe(0);
    expect(r.fields.booking_date).toBe("2026-09-20");
  });

  it("«لا الشاليه سكاي» swaps the chalet to sky", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("لا الشاليه سكاي");
    expect(r.model_calls).toBe(0);
    expect(r.fields.chalet_name).toBe("شاليه سكاي");
  });

  it("«خلها صباحي» corrects the period back to morning", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة مسائي 4 ضيوف باسم علي بمبلغ 500");
    const r = await c.say("خلها صباحي");
    expect(r.model_calls).toBe(0);
    expect(r.fields.period_id).toBe("am");
  });

  it("«غيّر الاسم الى فهد» corrects the customer name", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("غيّر الاسم الى فهد");
    expect(r.model_calls).toBe(0);
    expect(r.fields.customer_name).toBe("فهد");
  });

  it("«خلي الاجمالي 700» corrects the total and the SAVED booking carries it", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("خلي الاجمالي 700");
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBe(700);
    const prep = prepared(r);
    const okc = await c.post({ invoke_tool: { name: prep.confirm_tool, arguments: { action_id: prep.action_id, confirmation_token: prep.confirmation_token } } });
    expect(okc.ok).toBe(true);
    expect(c.deps._modelCalls).toHaveLength(0);
    expect(c.deps._executed[0].payload.args.total).toBe(700);
  });

  it("adding a phone in a later turn masks it on the refreshed card", async () => {
    const c = convo();
    await c.say("احجز تولوم بكرة صباحي 4 ضيوف باسم علي بمبلغ 300");
    const r = await c.say("جواله 0501234567");
    expect(r.model_calls).toBe(0);
    expect(cardVal(r.card, "الجوال")).toBe("05••••4567");
    expect(r.reply).not.toContain("0501234567");
  });

  it("a combined answer fills EVERY missing field in one message", async () => {
    const c = convo();
    const q = await c.say("احجز تولوم بكرة");
    expect(q.model_calls).toBe(0);
    const r = await c.say("مسائي 4 ضيوف باسم علي بمبلغ 500");
    expect(r.model_calls).toBe(0);
    expect(prepared(r)).toBeTruthy();
    expect(r.fields.period_id).toBe("pm");
    expect(r.fields.guests).toBe(4);
    expect(r.fields.total).toBe(500);
    expect(r.fields.customer_name).toBe("علي");
  });

  it("a step-by-step build across five turns reaches the card, all model-free", async () => {
    const c = convo();
    const turns = ["احجز تولوم", "بكرة", "مسائي", "4 ضيوف", "بمبلغ 500 باسم علي"];
    let last;
    for (const t of turns) {
      last = await c.say(t);
      expect(last.model_calls).toBe(0);
    }
    expect(prepared(last)).toBeTruthy();
  });
});

// ===========================================================================
// CANCEL & PICK
// ===========================================================================
describe("cancel & pick", () => {
  const OPENER = "احجز تولوم اليوم مسائي 4 ضيوف باسم علي بمبلغ 500";

  it("a conflict answers with numbered alternatives (names the blocker)", async () => {
    const c = convo({ conflictToday: true });
    const r = await c.say(OPENER);
    expect(r.model_calls).toBe(0);
    expect(r.fields.pending_q.kind).toBe("pick");
    expect(r.reply).toContain("محجوزة");
    expect(r.reply).toContain("1.");
    expect(r.next_actions.length).toBeGreaterThan(0);
    expect(prepared(r)).toBeFalsy();
  });

  it("«١» binds the first alternative and produces a card", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("١");
    expect(r.model_calls).toBe(0);
    expect(prepared(r)).toBeTruthy();
    expect(r.fields.period_id).toBeTruthy();
  });

  it("«٢» binds the SECOND alternative", async () => {
    const c = convo({ conflictToday: true });
    const q = await c.say(OPENER);
    const alts = q.fields.alternatives || [];
    expect(alts.length).toBeGreaterThanOrEqual(2);
    const r = await c.say("٢");
    expect(r.model_calls).toBe(0);
    expect(prepared(r)).toBeTruthy();
    expect(r.fields.period_id).toBe(alts[1].period_id);
  });

  it("«الخيار الاول» (ordinal words) also binds option 1", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("الخيار الاول");
    expect(r.model_calls).toBe(0);
    expect(prepared(r)).toBeTruthy();
  });

  it("a pick never overwrites the stated guest count", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("١");
    expect(r.model_calls).toBe(0);
    expect(r.fields.guests).toBe(4);
  });

  it("a soft «ما ابي» mid-pick keeps the draft alive and re-offers the options", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("ما ابي");
    expect(r.model_calls).toBe(0);
    expect(r.reply).not.toContain("تم الإلغاء");
    expect(r.next_actions.length).toBeGreaterThan(0);
    expect(c.deps._drafts.get("th-1").status).toBe("active");
  });

  it("«عطني خيارات» re-sends the stored numbered options", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("عطني خيارات وانا اضغط عليها");
    expect(r.model_calls).toBe(0);
    expect(r.reply).toContain("1.");
    expect(r.reply).not.toContain("لم أفهم");
    expect(r.next_actions.length).toBeGreaterThan(0);
  });

  it("«الغِ الحجز» cancels the draft", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("الغِ الحجز");
    expect(r.model_calls).toBe(0);
    expect(r.reply).toContain("تم الإلغاء");
    expect(c.deps._drafts.get("th-1").status).toBe("cancelled");
  });

  it("«الغاء الحجز» (variant) also cancels", async () => {
    const c = convo({ conflictToday: true });
    await c.say(OPENER);
    const r = await c.say("الغاء الحجز");
    expect(r.model_calls).toBe(0);
    expect(r.reply).toContain("تم الإلغاء");
    expect(c.deps._drafts.get("th-1").status).toBe("cancelled");
  });
});
