import { describe, expect, it } from "vitest";
import { convo } from "./helpers/audit-harness.mjs";

// A1 (the live «غباء» bug): «شنو اقرب حجز متاح و اي شالية» used to be captured as
// a customer-NAME booking search («حجز <name>») → «لم أجد حجوزات مطابقة لبحثك».
// A day-less availability phrasing must instead route to find_empty_dates and
// answer real openings — deterministically (model_calls=0).

const lastRead = (r) => r.reads[r.reads.length - 1] || { name: "", args: {} };

describe("A1: day-less availability phrasings ask for openings, not a booking search", () => {
  it("«شنو اقرب حجز متاح و اي شالية» → find_empty_dates, never «لم أجد حجوزات»", async () => {
    const c = convo();
    const r = await c.say("شنو اقرب حجز متاح و اي شالية");
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).toBe("find_empty_dates");
    expect(r.reply).not.toContain("لم أجد حجوزات"); // the old wrong answer
    // «اقرب» scans further out to actually find the NEAREST opening.
    expect(lastRead(r).args.days_ahead).toBe(45);
  });

  it.each([
    "وش الفاضي عندك",
    "فيه شي متوفّر؟",
    "عرض الفترات الفاضية",
    "اعرض الأيام الفاضية",
    "متى أقرب موعد متاح",
  ])("«%s» routes to find_empty_dates (model_calls=0)", async (msg) => {
    const c = convo();
    const r = await c.say(msg);
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).toBe("find_empty_dates");
    expect(r.reply).not.toContain("لم أجد حجوزات");
  });

  // Regressions: the fix must NOT swallow genuine other intents.
  it("a real name lookup «حجز علي» still routes to find_bookings", async () => {
    const c = convo();
    const r = await c.say("حجز علي");
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).toBe("find_bookings");
    expect(lastRead(r).args.customer_name).toBe("علي");
  });

  it("«كم دخلي هذا الشهر؟» still routes to the summary, not availability", async () => {
    const c = convo();
    const r = await c.say("كم دخلي هذا الشهر؟");
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).toBe("get_bookings_summary");
  });

  it("«اعرض حجوزات اليوم» is NOT treated as availability", async () => {
    const c = convo();
    const r = await c.say("اعرض حجوزات اليوم");
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).not.toBe("find_empty_dates");
  });

  it("a bare «الشاليهات المتاحة عندي» stays the catalog list (no slot/nearest word)", async () => {
    const c = convo();
    const r = await c.say("وش الشاليهات المتاحة عندي؟");
    expect(r.model_calls).toBe(0);
    expect(lastRead(r).name).toBe("list_chalets");
  });

  it("a delegated booking «دبّر لي أرخص شاليه متاح» is NOT grabbed as a read (yields to model, G3)", async () => {
    const c = convo();
    const r = await c.say("دبّر لي أرخص شاليه متاح");
    // Not a deterministic availability read — either the model is reached or the
    // booking pipeline handles it, but never find_empty_dates.
    expect(lastRead(r).name).not.toBe("find_empty_dates");
  });
});
