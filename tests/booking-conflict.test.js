import { describe, expect, it } from 'vitest';

function overlaps(a, b) {
  return a.check_in < b.check_out && a.check_out > b.check_in;
}

function sameBooking(a, b) {
  if (!a || !b) return false;
  if (String(a.id) === String(b.id)) return true;
  if (a.booking_no && b.booking_no && String(a.booking_no) === String(b.booking_no)) return true;
  return false;
}

function localConflict(bookings, booking) {
  if (booking.status !== 'confirmed') return false;
  return bookings
    .filter((b) => !b.deleted_at)
    .some((b) => !sameBooking(b, booking)
      && b.chalet_id === booking.chalet_id
      && b.status === 'confirmed'
      && overlaps(b, booking));
}

describe('booking conflict logic', () => {
  const existing = {
    id: 'booking-1',
    booking_no: '2026-0001',
    chalet_id: 'tulum',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    status: 'confirmed'
  };

  it('allows editing the same booking by id without false conflict', () => {
    const edited = { ...existing, customer_name: 'Ali Updated' };
    expect(localConflict([existing], edited)).toBe(false);
  });

  it('allows editing duplicated same booking identity by booking_no', () => {
    const cloudDuplicate = { ...existing, id: 'different-local-id' };
    const edited = { ...existing, id: 'local-id-after-import' };
    expect(localConflict([cloudDuplicate], edited)).toBe(false);
  });

  it('blocks a true overlapping confirmed booking in the same chalet', () => {
    const newBooking = {
      id: 'booking-2',
      booking_no: '2026-0002',
      chalet_id: 'tulum',
      check_in: '2026-06-02',
      check_out: '2026-06-04',
      status: 'confirmed'
    };
    expect(localConflict([existing], newBooking)).toBe(true);
  });

  it('does not block different chalets on same dates', () => {
    const newBooking = {
      id: 'booking-2',
      booking_no: '2026-0002',
      chalet_id: 'sky',
      check_in: '2026-06-02',
      check_out: '2026-06-04',
      status: 'confirmed'
    };
    expect(localConflict([existing], newBooking)).toBe(false);
  });

  it('does not block adjacent checkout/checkin dates', () => {
    const newBooking = {
      id: 'booking-2',
      booking_no: '2026-0002',
      chalet_id: 'tulum',
      check_in: '2026-06-03',
      check_out: '2026-06-04',
      status: 'confirmed'
    };
    expect(localConflict([existing], newBooking)).toBe(false);
  });

  it('ignores cancelled bookings for conflict checks', () => {
    const cancelled = { ...existing, status: 'cancelled' };
    const newBooking = {
      id: 'booking-2',
      booking_no: '2026-0002',
      chalet_id: 'tulum',
      check_in: '2026-06-02',
      check_out: '2026-06-04',
      status: 'confirmed'
    };
    expect(localConflict([cancelled], newBooking)).toBe(false);
  });
});
