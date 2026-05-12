import { describe, expect, it } from 'vitest';

function riyadhTs(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm);
}

function range(booking, period) {
  let start = riyadhTs(booking.booking_date, period.start);
  let end = riyadhTs(booking.booking_date, period.end);
  if (end <= start) end += 24 * 60 * 60 * 1000;
  return { start, end };
}

function conflicts(bookings, next, periodsById) {
  if (next.status !== 'confirmed') return null;
  const nextRange = range(next, periodsById[next.period_id]);
  return bookings.find((b) => {
    if (b.id === next.id) return false;
    if (b.chalet_id !== next.chalet_id) return false;
    if (b.status !== 'confirmed') return false;
    if (b.deleted_at !== null) return false;
    const existingRange = range(b, periodsById[b.period_id]);
    return existingRange.start < nextRange.end && existingRange.end > nextRange.start;
  }) || null;
}

describe('period-based booking conflict logic', () => {
  const periods = {
    morning: { id: 'morning', start: '07:00', end: '17:00' },
    evening: { id: 'evening', start: '19:00', end: '05:00' }
  };

  const existing = {
    id: 'booking-1',
    chalet_id: 'tulum',
    booking_date: '2026-06-01',
    period_id: 'morning',
    status: 'confirmed',
    deleted_at: null
  };

  it('blocks overlapping confirmed bookings in same chalet and period', () => {
    const next = { ...existing, id: 'booking-2' };
    expect(conflicts([existing], next, periods)?.id).toBe('booking-1');
  });

  it('allows non-overlapping periods on the same date', () => {
    const next = { ...existing, id: 'booking-2', period_id: 'evening' };
    expect(conflicts([existing], next, periods)).toBe(null);
  });

  it('allows the same interval in a different chalet', () => {
    const next = { ...existing, id: 'booking-2', chalet_id: 'sky' };
    expect(conflicts([existing], next, periods)).toBe(null);
  });

  it('does not block pending bookings', () => {
    const next = { ...existing, id: 'booking-2', status: 'pending' };
    expect(conflicts([existing], next, periods)).toBe(null);
  });

  it('ignores cancelled and completed existing bookings', () => {
    expect(conflicts([{ ...existing, status: 'cancelled' }], { ...existing, id: 'booking-2' }, periods)).toBe(null);
    expect(conflicts([{ ...existing, status: 'completed' }], { ...existing, id: 'booking-2' }, periods)).toBe(null);
  });

  it('handles overnight periods by rolling end to next day', () => {
    const r = range({ booking_date: '2026-06-01', period_id: 'evening' }, periods.evening);
    expect(r.end).toBeGreaterThan(r.start);
  });
});
