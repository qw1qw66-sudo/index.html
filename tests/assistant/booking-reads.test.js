import { describe, expect, it } from "vitest";
import {
  bookingRowsForList,
  nonDeletedBookingRows,
} from "../../supabase/functions/_shared/assistant/booking-reads.mjs";

describe("owner-facing booking read filters", () => {
  const rows = [
    { id: "confirmed", status: "confirmed", deleted_at: null },
    { id: "pending", status: "pending", deleted_at: null },
    { id: "completed", status: "completed", deleted_at: null },
    { id: "cancelled", status: "cancelled", deleted_at: null },
    { id: "deleted", status: "confirmed", deleted_at: "2026-07-13T00:00:00Z" },
  ];

  it("excludes cancelled and deleted rows from normal today/upcoming lists", () => {
    expect(bookingRowsForList(rows).map((b) => b.id)).toEqual([
      "confirmed",
      "pending",
      "completed",
    ]);
  });

  it("still returns cancelled rows when the owner explicitly filters for them", () => {
    expect(bookingRowsForList(rows, "cancelled").map((b) => b.id)).toEqual([
      "cancelled",
    ]);
  });

  it("keeps cancelled rows available for exact detail/name searches", () => {
    expect(nonDeletedBookingRows(rows).map((b) => b.id)).toContain("cancelled");
    expect(nonDeletedBookingRows(rows).map((b) => b.id)).not.toContain("deleted");
  });
});
