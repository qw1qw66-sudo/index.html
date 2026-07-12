import { describe, expect, it } from "vitest";
import {
  chaletCatalog,
  normalizeChaletLookup,
  normalizePeriodLookup,
  resolveBookingCreateArgs,
} from "../../supabase/functions/_shared/assistant/booking-resolution.mjs";

function workspaceDoc() {
  return {
    chalets: [
      {
        id: "sky-real-id",
        name: "شاليه سكاي",
        capacity: 6,
        deleted_at: null,
        periods: [{ id: "sky-am", label: "صباحي", start: "07:00", end: "12:00", active: true }],
      },
      {
        id: "tulum-real-id",
        name: "شاليه تولوم",
        capacity: 15,
        deleted_at: null,
        periods: [
          { id: "tulum-am", label: "صباحي", start: "07:00", end: "12:00", active: true },
          { id: "tulum-pm", label: "مسائي", start: "17:00", end: "23:00", active: true },
          { id: "tulum-off", label: "موقوف", start: "12:00", end: "14:00", active: false },
        ],
      },
    ],
    bookings: [],
  };
}

describe("authoritative chalet/period name resolution", () => {
  it("normalizes the owner's short Arabic name and common period wording", () => {
    expect(normalizeChaletLookup("تولوم")).toBe(normalizeChaletLookup("شاليه تولوم"));
    expect(normalizePeriodLookup("المسائية")).toBe(normalizePeriodLookup("مسائي"));
  });

  it("binds the real existing ids; it never invents an id", () => {
    const result = resolveBookingCreateArgs(workspaceDoc(), {
      customer_name: "عميل تجربة",
      chalet_name: "تولوم",
      period_label: "المسائية",
      booking_date: "2099-07-11",
      guests: 4,
      total: 500,
    });
    expect(result).toMatchObject({
      ok: true,
      args: {
        chalet_id: "tulum-real-id",
        chalet_name: "شاليه تولوم",
        period_id: "tulum-pm",
        period_label: "مسائي",
      },
    });
  });

  it("fails closed and returns only real choices when the name is unknown", () => {
    const result = resolveBookingCreateArgs(workspaceDoc(), {
      customer_name: "عميل تجربة",
      chalet_name: "اسم غير موجود",
      period_label: "مسائي",
      booking_date: "2099-07-11",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("CHALET_NOT_FOUND");
    expect(result.options.map((x) => x.chalet_name)).toEqual(["شاليه سكاي", "شاليه تولوم"]);
    expect(JSON.stringify(result)).not.toContain("fake-id");
  });

  it("never resolves an inactive period", () => {
    const result = resolveBookingCreateArgs(workspaceDoc(), {
      customer_name: "عميل تجربة",
      chalet_name: "تولوم",
      period_label: "موقوف",
      booking_date: "2099-07-11",
    });
    expect(result).toMatchObject({ ok: false, error: "PERIOD_NOT_FOUND" });
  });

  it("lists the actual chalet names, capacities and active periods", () => {
    const result = chaletCatalog(workspaceDoc());
    expect(result.chalets).toHaveLength(2);
    expect(result.chalets[1]).toMatchObject({ chalet_id: "tulum-real-id", chalet_name: "شاليه تولوم", capacity: 15 });
    expect(result.chalets[1].periods.map((x) => x.period_id)).toEqual(["tulum-am", "tulum-pm"]);
  });

  // Real owner data: several periods carry the IDENTICAL label (a data-entry
  // quirk seen live). Identical-in-every-attribute duplicates collapse
  // deterministically to the first; distinguishable ones stay ambiguous and
  // the reason lists TIMES (equal names alone would be a dead end).
  it("collapses fully-identical duplicate periods instead of dead-ending", () => {
    const doc = workspaceDoc();
    doc.chalets[0].periods = [1, 2, 3, 4, 5].map((n) => ({
      id: "dup-" + n, label: "٧ مساءً إلى ٥ صباح", start: "19:00", end: "05:00",
      weekday_price: 400, weekend_price: 600, active: true,
    }));
    const result = resolveBookingCreateArgs(doc, {
      customer_name: "عميل تجربة", chalet_name: "سكاي",
      period_label: "٧ مساءً إلى ٥ صباح", booking_date: "2099-07-11",
    });
    expect(result.ok).toBe(true);
    expect(result.args.period_id).toBe("dup-1");
  });

  it("keeps genuinely different same-name periods ambiguous, listing their times", () => {
    const doc = workspaceDoc();
    doc.chalets[0].periods = [
      { id: "d-am", label: "دوام", start: "07:00", end: "12:00", weekday_price: 300, weekend_price: 500, active: true },
      { id: "d-pm", label: "دوام", start: "17:00", end: "23:00", weekday_price: 400, weekend_price: 600, active: true },
    ];
    const result = resolveBookingCreateArgs(doc, {
      customer_name: "عميل تجربة", chalet_name: "سكاي",
      period_label: "دوام", booking_date: "2099-07-11",
    });
    expect(result).toMatchObject({ ok: false, error: "PERIOD_AMBIGUOUS" });
    expect(result.reason_ar).toContain("07:00");
    expect(result.reason_ar).toContain("17:00");
  });

  // A chalet with BOTH an evening «مسائي» and a night «ليلي» period (the
  // staging seed, and common live data): the STRICT same-family pass must
  // bind each wording to its own family — never «PERIOD_AMBIGUOUS», never
  // the wrong slot. The cross-family alias (بالليل→مسائي) still applies when
  // the chalet has no native night period.
  it("«المسائية» picks مسائي and «بالليل» picks ليلي when a chalet has both", () => {
    const doc = workspaceDoc();
    doc.chalets[1].periods.push({ id: "tulum-night", label: "ليلي", start: "23:00", end: "02:00", active: true });
    const evening = resolveBookingCreateArgs(doc, {
      customer_name: "عميل تجربة", chalet_name: "تولوم",
      period_label: "المسائية", booking_date: "2099-07-11",
    });
    expect(evening).toMatchObject({ ok: true, args: { period_id: "tulum-pm", period_label: "مسائي" } });
    const night = resolveBookingCreateArgs(doc, {
      customer_name: "عميل تجربة", chalet_name: "تولوم",
      period_label: "بالليل", booking_date: "2099-07-11",
    });
    expect(night).toMatchObject({ ok: true, args: { period_id: "tulum-night", period_label: "ليلي" } });
  });

  it("«بالليل» still falls back to the evening period when no night period exists", () => {
    const result = resolveBookingCreateArgs(workspaceDoc(), {
      customer_name: "عميل تجربة", chalet_name: "تولوم",
      period_label: "بالليل", booking_date: "2099-07-11",
    });
    expect(result).toMatchObject({ ok: true, args: { period_id: "tulum-pm", period_label: "مسائي" } });
  });

  it("«شالية تولوم» (taa-marbuta spelling) resolves to the stored «شاليه تولوم»", () => {
    const result = resolveBookingCreateArgs(workspaceDoc(), {
      customer_name: "عميل تجربة", chalet_name: "شالية تولوم",
      period_label: "مسائي", booking_date: "2099-07-11",
    });
    expect(result).toMatchObject({ ok: true, args: { chalet_id: "tulum-real-id" } });
  });
});
