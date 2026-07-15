import { describe, expect, it } from "vitest";
import {
  bookingRowsForList,
  nonDeletedBookingRows,
  bookingsSummary,
  monthRangeIso,
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

describe("A3: duplicate booking IDs are collapsed (never listed/counted twice)", () => {
  it("nonDeletedBookingRows keeps the first row per id (the live «حجزان لخالد» dup)", () => {
    const dup = [
      { id: "k1", customer_name: "خالد", booking_date: "2026-07-15", total: 500, paid: 0, status: "confirmed", deleted_at: null },
      { id: "k1", customer_name: "خالد", booking_date: "2026-07-15", total: 500, paid: 0, status: "confirmed", deleted_at: null },
      { id: "k2", customer_name: "سعد", booking_date: "2026-07-16", total: 300, paid: 0, status: "confirmed", deleted_at: null },
    ];
    const rows = nonDeletedBookingRows(dup);
    expect(rows.map((b) => b.id)).toEqual(["k1", "k2"]); // one خالد, not two
  });

  it("income is NOT double-counted when a booking id is duplicated", () => {
    const dup = [
      { id: "k1", booking_date: "2026-07-15", total: 500, paid: 200, status: "confirmed", deleted_at: null },
      { id: "k1", booking_date: "2026-07-15", total: 500, paid: 200, status: "confirmed", deleted_at: null },
    ];
    const s = bookingsSummary(dup, { from: "2026-07-01", to: "2026-07-31" });
    expect(s.count).toBe(1);
    expect(s.total_income).toBe(500); // not 1000
    expect(s.paid_total).toBe(200); // not 400
  });

  it("rows without an id keep their own identity (no accidental collapse)", () => {
    const noId = [
      { customer_name: "أ", status: "confirmed", deleted_at: null },
      { customer_name: "ب", status: "confirmed", deleted_at: null },
    ];
    expect(nonDeletedBookingRows(noId)).toHaveLength(2);
  });
});

describe("monthRangeIso — calendar-month bounds", () => {
  it("returns the first and last day of the month", () => {
    expect(monthRangeIso("2026-07-13")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(monthRangeIso("2026-12-25")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
  it("handles February and leap years", () => {
    expect(monthRangeIso("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRangeIso("2024-02-10")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });
  it("is safe on garbage input", () => {
    expect(monthRangeIso("")).toEqual({ from: "", to: "" });
    expect(monthRangeIso(null)).toEqual({ from: "", to: "" });
  });
});

describe("bookingsSummary — count + income over a date range", () => {
  const rows = [
    { id: "a", customer_name: "أ", booking_date: "2026-07-05", total: 500, paid: 100, status: "confirmed", deleted_at: null },
    { id: "b", customer_name: "ب", booking_date: "2026-07-20", total: 300, paid: 0, status: "pending", deleted_at: null },
    { id: "c", customer_name: "ج", booking_date: "2026-07-25", total: 999, paid: 0, status: "cancelled", deleted_at: null }, // excluded
    { id: "d", customer_name: "د", booking_date: "2026-06-30", total: 400, paid: 50, status: "confirmed", deleted_at: null }, // out of range
    { id: "e", customer_name: "هـ", booking_date: "2026-07-15", total: 200, paid: 0, status: "confirmed", deleted_at: "x" }, // deleted
  ];

  it("counts and sums total (whole riyals) for the range, excluding cancelled/deleted/out-of-range", () => {
    const s = bookingsSummary(rows, { from: "2026-07-01", to: "2026-07-31" });
    expect(s.count).toBe(2);
    expect(s.total_income).toBe(800); // 500 + 300
    expect(s.paid_total).toBe(100);
    expect(s.bookings.map((b) => b.id)).toEqual(["b", "a"]); // newest first
  });

  it("open-ended bounds work (past = everything before a date)", () => {
    const past = bookingsSummary(rows, { from: "", to: "2026-07-10" });
    expect(past.count).toBe(2); // د (06-30) + أ (07-05); cancelled/deleted excluded
    expect(past.total_income).toBe(900); // 400 + 500
    const all = bookingsSummary(rows, {});
    expect(all.count).toBe(3); // أ, ب, د
  });

  it("returns an empty summary safely", () => {
    expect(bookingsSummary([], { from: "2026-07-01", to: "2026-07-31" })).toEqual({
      count: 0, total_income: 0, paid_total: 0, from: "2026-07-01", to: "2026-07-31", bookings: [],
    });
    expect(bookingsSummary(null, {}).count).toBe(0);
  });
});
