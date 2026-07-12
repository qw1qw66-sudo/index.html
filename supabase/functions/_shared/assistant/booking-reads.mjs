// Booking rows used by owner-facing operational lists. Cancelled bookings
// remain queryable when the owner explicitly asks for them, but they are not
// active reservations and must never inflate "today" or "upcoming" answers.

export function nonDeletedBookingRows(bookings) {
  return (Array.isArray(bookings) ? bookings : []).filter((b) => b && !b.deleted_at);
}

export function bookingRowsForList(bookings, requestedStatus = "") {
  const status = String(requestedStatus || "").trim();
  const rows = nonDeletedBookingRows(bookings);
  return status
    ? rows.filter((b) => String(b.status || "") === status)
    : rows.filter((b) => String(b.status || "") !== "cancelled");
}
