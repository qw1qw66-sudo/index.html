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
});

