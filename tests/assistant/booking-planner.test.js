// Contract tests for booking-planner.mjs — the deterministic Booking Draft
// brain. Pure functions only: fixed todayIso, fixture doc, no Date.now().
import { describe, it, expect } from 'vitest';
import {
  extractFacts,
  mergeDraft,
  missingFields,
  suggestedPrice,
  nextQuestionAr,
  findAlternatives,
  buildCardData,
  maskPhone,
} from '../../supabase/functions/_shared/assistant/booking-planner.mjs';

const TODAY = '2026-07-12'; // a Sunday
const D = '2026-07-20'; // a Monday (weekday pricing)

// Two chalets: سكاي has an overnight «مسائي», a morning slot and a TIMELESS
// period (never bookable/suggestable); تولوم has a single morning slot.
function fixtureDoc() {
  return {
    chalets: [
      {
        id: 'c1', name: 'سكاي', capacity: 12,
        periods: [
          { id: 'p1', label: 'مسائي', start: '19:00', end: '05:00', active: true, weekday_price: 600, weekend_price: 900, sort: 2 },
          { id: 'p2', label: 'صباحي', start: '08:00', end: '14:00', active: true, weekday_price: 300, weekend_price: 450, sort: 1 },
          { id: 'p3', label: 'ملحق', start: '', end: '', active: true, weekday_price: 100, weekend_price: 100, sort: 3 },
        ],
      },
      {
        id: 'c2', name: 'تولوم', capacity: 8,
        periods: [
          { id: 'p4', label: 'صباحي', start: '07:00', end: '12:00', active: true, weekday_price: 250, weekend_price: 400, sort: 1 },
        ],
      },
    ],
    bookings: [
      { id: 'b1', chalet_id: 'c1', period_id: 'p1', booking_date: D, status: 'confirmed' },
    ],
  };
}
const skyEvening = () => fixtureDoc().chalets[0].periods[0];
const isSubset = (a, b) => a.every((k) => b.includes(k));

describe('extractFacts + mergeDraft: multi-turn accumulation', () => {
  it('accumulates facts across turns; missing fields only ever shrink', () => {
    let draft = {};

    // Turn 1: intent only — nothing invented, everything still missing.
    draft = mergeDraft(draft, extractFacts('احجز سكاي', TODAY));
    expect(draft.guests).toBeUndefined();
    expect(draft.total).toBeUndefined();
    // The resolver binds the chalet externally (raw message -> real id).
    draft = { ...draft, chalet_id: 'c1', chalet_name: 'سكاي' };
    let prev = missingFields(draft);
    expect(prev).not.toContain('chalet');
    expect(prev).toEqual(expect.arrayContaining(['booking_date', 'period', 'guests', 'total', 'customer_name']));

    // Turn 2: «بكرة بالليل» -> tomorrow; period bound externally by resolver.
    draft = mergeDraft(draft, extractFacts('بكرة بالليل', TODAY));
    expect(draft.booking_date).toBe('2026-07-13');
    draft = { ...draft, period_id: 'p1', period_label: 'مسائي', canonical_start: '19:00', canonical_end: '05:00', wraps_next_day: true };
    let m = missingFields(draft);
    expect(m).not.toContain('booking_date');
    expect(m).not.toContain('period');
    expect(isSubset(m, prev)).toBe(true);
    expect(m.length).toBeLessThan(prev.length);
    prev = m;

    // Turn 3: bare Arabic number word -> guests only, never a total.
    draft = mergeDraft(draft, extractFacts('أربعة', TODAY));
    expect(draft.guests).toBe(4);
    expect(draft.total).toBeUndefined();
    m = missingFields(draft);
    expect(m).not.toContain('guests');
    expect(isSubset(m, prev)).toBe(true);
    expect(m.length).toBeLessThan(prev.length);

    // Turn 4: explicit amount + customer name in one message.
    draft = mergeDraft(draft, extractFacts('500 ريال، العميل علي تجربة', TODAY));
    expect(draft.total).toBe(500);
    expect(draft.total_source).toBe('explicit');
    expect(draft.customer_name).toBe('علي تجربة');
    expect(missingFields(draft)).toEqual([]);
  });

  it('a later message corrects an earlier guest count', () => {
    let draft = mergeDraft({}, extractFacts('أربعة', TODAY));
    expect(draft.guests).toBe(4);
    draft = mergeDraft(draft, extractFacts('خمسة أشخاص', TODAY));
    expect(draft.guests).toBe(5);
    expect(draft.sources.guests).toBe('parsed');
  });
});

describe('phone handling', () => {
  it('extracts a valid Saudi mobile into private only — never into fields', () => {
    const f = extractFacts('جوال العميل 0501234567', TODAY);
    expect(f.private.customer_phone).toBe('0501234567');
    expect(f.fields.customer_phone).toBeUndefined();
    expect(f.fields.phone_warning).toBeUndefined();
    expect(f.fields.customer_name).toBeUndefined(); // digits stop the capture
    const merged = mergeDraft({}, f);
    expect(JSON.stringify(merged)).not.toContain('0501234567');
  });

  it('maskPhone keeps the first 2 and last 4 digits', () => {
    expect(maskPhone('0501234567')).toBe('05••••4567');
    expect(maskPhone('')).toBe('');
  });

  it('flags malformed phone-ish input without storing anything', () => {
    const f = extractFacts('جوال العميل 05012', TODAY);
    expect(f.fields.phone_warning).toBe(true);
    expect(f.private.customer_phone).toBeUndefined();
    const merged = mergeDraft({}, f);
    expect(merged.phone_warning).toBeUndefined(); // becomes a warning string
    expect(merged.warnings.length).toBe(1);
    // Money is never phone-ish garbage.
    expect(extractFacts('500 ريال', TODAY).fields.phone_warning).toBeUndefined();
  });
});

describe('missingFields never defaults', () => {
  it('an empty draft is missing everything, including guests and total', () => {
    const m = missingFields({});
    expect(m).toContain('guests');
    expect(m).toContain('total');
    expect(m).toContain('chalet');
    expect(m).toContain('booking_date');
    expect(m).toContain('period');
    expect(m).toContain('customer_name');
    expect(m.length).toBe(6);
  });

  it('a merely SUGGESTED price still counts as a missing total', () => {
    expect(missingFields({ total_suggested: 600, total_source: 'suggested' })).toContain('total');
    expect(missingFields({ total: 600, total_suggested: 600, total_source: 'suggested' })).toContain('total');
    // Zero without an explicit free is missing; a period without canonical
    // times is missing even when an id is bound.
    expect(missingFields({ total: 0, total_source: 'explicit' })).toContain('total');
    expect(missingFields({ period_id: 'p1' })).toContain('period');
  });
});

describe('suggested price acceptance', () => {
  it('acceptance phrases set the flag; ordinary messages do not', () => {
    expect(extractFacts('اعتمده', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('نعم اعتمد', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('موافق على السعر', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('تمام السعر', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('ok', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('نعم', TODAY).accept_suggestion).toBe(true);
    expect(extractFacts('احجز سكاي', TODAY).accept_suggestion).toBeUndefined();
  });

  it('acceptance applies the pending suggestion', () => {
    const existing = {
      chalet_id: 'c1', booking_date: '2026-07-13',
      period_id: 'p1', canonical_start: '19:00', canonical_end: '05:00',
      guests: 4, customer_name: 'علي', total_suggested: 600, total_source: 'suggested',
    };
    const merged = mergeDraft(existing, extractFacts('اعتمده', TODAY));
    expect(merged.total).toBe(600);
    expect(merged.total_source).toBe('accepted_suggestion');
    expect(missingFields(merged)).not.toContain('total');
  });

  it('acceptance without a pending suggestion changes nothing', () => {
    const merged = mergeDraft({}, extractFacts('نعم', TODAY));
    expect(merged.total).toBeUndefined();
    expect(missingFields(merged)).toContain('total');
  });
});

describe('explicit free', () => {
  it('«الحجز مجاني» -> total 0 with source free, no longer missing', () => {
    const f = extractFacts('الحجز مجاني', TODAY);
    expect(f.free).toBe(true);
    const merged = mergeDraft({}, f);
    expect(merged.total).toBe(0);
    expect(merged.total_source).toBe('free');
    expect(missingFields(merged)).not.toContain('total');
  });

  it('a bare missing price is NEVER free', () => {
    const merged = mergeDraft({}, extractFacts('احجز سكاي بكرة', TODAY));
    expect(merged.total).toBeUndefined();
    expect(merged.total_source).toBeUndefined();
    expect(missingFields(merged)).toContain('total');
  });
});

describe('suggestedPrice', () => {
  it('picks weekend price on Friday/Saturday and weekday price otherwise', () => {
    const p = skyEvening();
    expect(suggestedPrice(p, '2026-07-17')).toBe(900); // Friday
    expect(suggestedPrice(p, '2026-07-18')).toBe(900); // Saturday
    expect(suggestedPrice(p, '2026-07-14')).toBe(600); // Tuesday
  });

  it('returns null when the period lacks a positive price for that day', () => {
    const p = { label: 'x', start: '10:00', end: '12:00', weekday_price: 0, weekend_price: 900 };
    expect(suggestedPrice(p, '2026-07-14')).toBeNull(); // weekday price is 0
    expect(suggestedPrice(p, '2026-07-17')).toBe(900);
    expect(suggestedPrice(null, '2026-07-14')).toBeNull();
    expect(suggestedPrice(p, 'not-a-date')).toBeNull();
  });
});

describe('nextQuestionAr', () => {
  it('asks ONE question in strict priority order', () => {
    const q = (d) => nextQuestionAr(d, missingFields(d));
    expect(q({})).toContain('شاليه');
    const d1 = { chalet_id: 'c1' };
    expect(q(d1)).toContain('تاريخ');
    const d2 = { ...d1, booking_date: '2026-07-13' };
    expect(q(d2)).toContain('فترة');
    const d3 = { ...d2, period_id: 'p1', canonical_start: '19:00', canonical_end: '05:00' };
    expect(q(d3)).toContain('الضيوف');
    const d4 = { ...d3, guests: 4, total: 500, total_source: 'explicit' };
    expect(q(d4)).toContain('باسم من');
    const done = { ...d4, customer_name: 'علي' };
    expect(nextQuestionAr(done, missingFields(done))).toBe('');
  });

  it('the pending-suggestion question quotes the number and «سعر النظام»', () => {
    const d = {
      chalet_id: 'c1', booking_date: '2026-07-13',
      period_id: 'p1', canonical_start: '19:00', canonical_end: '05:00',
      guests: 4, total_suggested: 600, total_source: 'suggested',
    };
    const question = nextQuestionAr(d, missingFields(d));
    expect(question).toContain('600');
    expect(question).toContain('سعر النظام');
    expect(question).toContain('أعتمده');
  });

  it('lists up to 3 numbered period options with their times', () => {
    const d = {
      chalet_id: 'c1', booking_date: '2026-07-13',
      period_options: [
        { label: 'صباحي', start: '08:00', end: '14:00' },
        { label: 'مسائي', start: '19:00', end: '05:00' },
      ],
    };
    const question = nextQuestionAr(d, missingFields(d));
    expect(question).toContain('1. صباحي');
    expect(question).toContain('08:00');
    expect(question).toContain('2. مسائي');
  });
});

describe('findAlternatives', () => {
  it('strict order: same-day other period, same fingerprint next day, other chalet', () => {
    const doc = fixtureDoc();
    const alts = findAlternatives(doc, 'c1', D, skyEvening(), { max: 3, todayIso: TODAY });
    expect(alts.length).toBe(3);
    // (1) same chalet, same date, non-overlapping morning slot.
    expect(alts[0]).toMatchObject({ chalet_id: 'c1', period_id: 'p2', date: D, start: '08:00', end: '14:00', capacity: 12, price: 300 });
    // (2) same logical period on the nearest free next day.
    expect(alts[1]).toMatchObject({ chalet_id: 'c1', period_id: 'p1', date: '2026-07-21', price: 600 });
    // (3) the other chalet on the same date.
    expect(alts[2]).toMatchObject({ chalet_id: 'c2', chalet_name: 'تولوم', period_id: 'p4', date: D, capacity: 8, price: 250 });
  });

  it('never suggests occupied slots or timeless periods, and respects max', () => {
    const doc = fixtureDoc();
    const alts = findAlternatives(doc, 'c1', D, skyEvening(), { max: 3, todayIso: TODAY });
    for (const a of alts) {
      expect(a.start).toMatch(/^\d{2}:\d{2}$/);
      expect(a.end).toMatch(/^\d{2}:\d{2}$/);
      expect(a.period_id).not.toBe('p3'); // the timeless period
      // Never the occupied requested slot itself.
      expect(`${a.chalet_id}|${a.period_id}|${a.date}`).not.toBe(`c1|p1|${D}`);
    }
    expect(findAlternatives(doc, 'c1', D, skyEvening(), { max: 1, todayIso: TODAY }).length).toBe(1);
    // With تولوم also booked that day, the cross-chalet tier disappears.
    const busy = fixtureDoc();
    busy.bookings.push({ id: 'b2', chalet_id: 'c2', period_id: 'p4', booking_date: D, status: 'confirmed' });
    const alts2 = findAlternatives(busy, 'c1', D, skyEvening(), { max: 3, todayIso: TODAY });
    expect(alts2.length).toBe(2);
    expect(alts2.every((a) => a.chalet_id === 'c1')).toBe(true);
  });

  it('skips occupied days when searching the same fingerprint forward', () => {
    const doc = fixtureDoc();
    doc.bookings.push({ id: 'b3', chalet_id: 'c1', period_id: 'p1', booking_date: '2026-07-21', status: 'confirmed' });
    const alts = findAlternatives(doc, 'c1', D, skyEvening(), { max: 3, todayIso: TODAY });
    expect(alts[1]).toMatchObject({ chalet_id: 'c1', period_id: 'p1', date: '2026-07-22' });
  });
});

describe('buildCardData', () => {
  const completeDraft = {
    customer_name: 'علي تجربة',
    chalet_id: 'c1',
    chalet_name: 'سكاي',
    booking_date: '2026-07-13',
    period_id: 'p1',
    period_label: 'مسائي',
    canonical_start: '19:00',
    canonical_end: '05:00',
    wraps_next_day: true,
    guests: 4,
    total: 500,
    total_source: 'explicit',
    notes: '',
  };

  it('renders the rows in exact order with the specified ltr flags', () => {
    const card = buildCardData(completeDraft, { masked_phone: maskPhone('0501234567') });
    expect(card.title).toBe('حجز جديد');
    expect(card.rows.map((r) => r.k)).toEqual([
      'العميل', 'الجوال', 'الشاليه', 'التاريخ', 'الفترة', 'الضيوف', 'الإجمالي', 'الملاحظات',
    ]);
    expect(card.rows[0].v).toBe('علي تجربة');
    expect(card.rows[1]).toMatchObject({ v: '05••••4567', ltr: true });
    expect(card.rows[2].v).toBe('سكاي');
    expect(card.rows[3]).toMatchObject({ v: '13-07-2026', ltr: true });
    expect(card.rows[4]).toMatchObject({ v: '19:00 → 05:00', ltr: true });
    expect(card.rows[5].v).toBe('4');
    expect(card.rows[6]).toMatchObject({ v: '500 ريال', ltr: true });
    expect(card.rows[7].v).toBe('لا توجد'); // notes fallback
    expect(card.guests).toBe(4);
    expect(card.total_label).toBe('500 ريال');
  });

  it('shows «غير مضاف» without a phone and «مجاني» for free bookings', () => {
    const card = buildCardData({ ...completeDraft, total: 0, total_source: 'free', notes: 'بدون زينة' });
    expect(card.rows[1]).toMatchObject({ v: 'غير مضاف', ltr: false });
    expect(card.rows[6]).toMatchObject({ v: 'مجاني', ltr: false });
    expect(card.total_label).toBe('مجاني');
    expect(card.rows[7].v).toBe('بدون زينة');
  });
});

describe('date errors and model merging', () => {
  it('propagates parseDateExpression errors as fields.date_error', () => {
    const f = extractFacts('31/02/2026', TODAY);
    expect(f.fields.date_error.error).toBe('INVALID_DATE');
    expect(f.fields.booking_date).toBeUndefined();
    // A later valid date clears the stale error inside the draft.
    let draft = mergeDraft({}, f);
    expect(draft.date_error.error).toBe('INVALID_DATE');
    draft = mergeDraft(draft, extractFacts('15-08-2026', TODAY));
    expect(draft.booking_date).toBe('2026-08-15');
    expect(draft.date_error).toBeUndefined();
  });

  it('a deterministic parsed date beats a modelFields date', () => {
    const merged = mergeDraft({}, {
      fields: { booking_date: '2026-07-13' },
      modelFields: { booking_date: '2026-08-01' },
    });
    expect(merged.booking_date).toBe('2026-07-13');
    expect(merged.sources.booking_date).toBe('parsed');
  });

  it('the model fills name/notes gaps only and never overrides parsed values', () => {
    let draft = mergeDraft({}, { fields: {}, modelFields: { customer_name: 'محمد', notes: 'زينة' } });
    expect(draft.customer_name).toBe('محمد');
    expect(draft.sources.customer_name).toBe('model');
    expect(draft.notes).toBe('زينة');
    // A parsed correction replaces the model value…
    draft = mergeDraft(draft, { fields: { customer_name: 'علي تجربة' } });
    expect(draft.customer_name).toBe('علي تجربة');
    expect(draft.sources.customer_name).toBe('parsed');
    // …and the model can never take it back.
    draft = mergeDraft(draft, { fields: {}, modelFields: { customer_name: 'سالم' } });
    expect(draft.customer_name).toBe('علي تجربة');
  });

  it('model guests/total/date/times are IGNORED — empty slots stay missing (§5)', () => {
    // The live bug: DeepSeek volunteered guests=10 / total=300 the owner never
    // typed and the card showed them. Model values may fill name/notes ONLY.
    const draft = mergeDraft({}, {
      fields: {},
      modelFields: {
        guests: 10,
        total: 300,
        booking_date: '2026-08-01',
        canonical_start: '13:00',
        canonical_end: '18:00',
        customer_name: 'علي',
      },
    });
    expect(draft.customer_name).toBe('علي');
    expect(draft.guests).toBeUndefined();
    expect(draft.total).toBeUndefined();
    expect(draft.total_source).toBeUndefined();
    expect(draft.booking_date).toBeUndefined();
    expect(draft.canonical_start).toBeUndefined();
    expect(draft.canonical_end).toBeUndefined();
    const missing = missingFields(draft);
    expect(missing).toContain('guests');
    expect(missing).toContain('total');
    expect(missing).toContain('booking_date');
  });

  it('a parsed time range replaces canonical times and unbinds the period', () => {
    const existing = { period_id: 'p1', period_label: 'مسائي', canonical_start: '19:00', canonical_end: '05:00', wraps_next_day: true };
    const merged = mergeDraft(existing, extractFacts('من 8 صباحاً الى 2 ظهراً', TODAY));
    expect(merged.canonical_start).toBe('08:00');
    expect(merged.canonical_end).toBe('14:00');
    expect(merged.wraps_next_day).toBe(false);
    expect(merged.period_id).toBeUndefined();
    expect(merged.period_label).toBeUndefined();
  });
});
