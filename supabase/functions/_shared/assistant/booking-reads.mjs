// Booking rows used by owner-facing operational lists. Cancelled bookings
// remain queryable when the owner explicitly asks for them, but they are not
// active reservations and must never inflate "today" or "upcoming" answers.

export function nonDeletedBookingRows(bookings) {
  const rows = (Array.isArray(bookings) ? bookings : []).filter((b) => b && !b.deleted_at);
  // Collapse accidental duplicate booking IDs (data corruption that was possible
  // before the structural save guard) so a single booking is never listed OR
  // counted/summed twice — the live «حجزان لخالد» duplicate and its inflated
  // income. Rows without an id keep their own identity (no dedup).
  const seen = new Set();
  const out = [];
  for (const b of rows) {
    const id = b.id != null ? String(b.id) : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(b);
  }
  return out;
}

export function bookingRowsForList(bookings, requestedStatus = "") {
  const status = String(requestedStatus || "").trim();
  const rows = nonDeletedBookingRows(bookings);
  return status
    ? rows.filter((b) => String(b.status || "") === status)
    : rows.filter((b) => String(b.status || "") !== "cancelled");
}

// A calendar-month inclusive [from,to] range for «هذا الشهر» queries, from a
// Riyadh-local ISO date. "2026-07-13" → { from: "2026-07-01", to: "2026-07-31" }.
export function monthRangeIso(todayIso) {
  const [y, m] = String(todayIso || "").split("-").map(Number);
  if (!y || !m) return { from: "", to: "" };
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  // Day 0 of the next month is the last day of this month (Date normalizes it).
  const end = new Date(Date.UTC(y, m, 0));
  const to = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
  return { from, to };
}

// Count + income summary of ACTIVE bookings (non-deleted, non-cancelled) whose
// booking_date is within [from,to] (each bound optional → open on that side).
// `total` is the agreed booking value (the owner's «دخل»); `paid` is collected.
// Booking totals are stored in WHOLE RIYALS, so they are summed as-is (no /100).
// Rows come back newest-first; the caller/render caps how many are itemized.
export function bookingsSummary(bookings, { from = "", to = "" } = {}) {
  const lo = String(from || "");
  const hi = String(to || "");
  const rows = bookingRowsForList(bookings)
    .filter((b) => {
      const d = String(b.booking_date || "");
      if (!d) return false;
      if (lo && d < lo) return false;
      if (hi && d > hi) return false;
      return true;
    })
    .slice()
    .sort((a, b) => String(b.booking_date).localeCompare(String(a.booking_date)));
  const total_income = rows.reduce((s, b) => s + (Number(b.total) || 0), 0);
  const paid_total = rows.reduce((s, b) => s + (Number(b.paid) || 0), 0);
  return { count: rows.length, total_income, paid_total, from: lo, to: hi, bookings: rows };
}
