// R11 — NUMBER/DATE/TIME normalization regressions for nl-normalize.mjs.
//
// Thirteen adversarial findings where a phone became a price, a per-person or
// per-night figure was banked as the grand total, a thousands word collapsed,
// a headcount was invented from a time range or a nights count, a dual/ranged
// guest phrase was dropped, a negated "free" read as free, or a date/time
// resolved to the wrong day. Each finding pairs a pure assertion (fixed
// todayIso, no network) with — for the money/guest ones the audit flagged
// end-to-end — a real convo() turn through the deployed handler. Every convo
// turn asserts model_calls === 0 (deterministic planner path, model offline).
import { describe, it, expect } from 'vitest';
import {
  extractAmount,
  extractGuestCount,
  parseDateExpression,
  parseTimeExpression,
  isExplicitFree,
} from '../../supabase/functions/_shared/assistant/nl-normalize.mjs';
import { convo, TOMORROW } from '/tmp/claude-0/-home-user-index-html/b2f2de9e-599a-5acd-b19d-df4e536dbc41/scratchpad/audit-harness.mjs';

// Fixed calendar anchors (pure inputs, independent of the machine clock).
const MON = '2026-07-13'; // a Monday (UTC dow 1)
const THU = '2026-07-16'; // a Thursday (UTC dow 4)

const cardVal = (card, key) => {
  const row = (card || []).find((r) => r.k === key);
  return row ? row.v : undefined;
};

// ---------------------------------------------------------------------------
// extractAmount
// ---------------------------------------------------------------------------

describe('AW-P1-1 — a Saudi mobile is never a price', () => {
  it('a bare phone / phone glued to «ريال» returns null, real prices survive', () => {
    expect(extractAmount('0501234567')).toBeNull(); // whole-message /^\d+$/ path
    expect(extractAmount('0501234567 ريال')).toBeNull(); // currency-adjacent path
    // Other Saudi mobile shapes are phones too, never totals.
    expect(extractAmount('501234567')).toBeNull(); // 9-digit «5…» national form
    expect(extractAmount('00966501234567')).toBeNull(); // 00966 country code
    expect(extractAmount('+966501234567')).toBeNull(); // +966 country code
    // Real prices (including a 4-digit non-phone) still parse.
    expect(extractAmount('500 ريال')).toBe(500);
    expect(extractAmount('1500')).toBe(1500);
    expect(extractAmount('300')).toBe(300);
  });
});

describe('AW-P2-1 — «N الف» is N×1000, not 1000 (or the lone N)', () => {
  it('digit/word thousands, with or without a marker, and the dual «الفين»', () => {
    expect(extractAmount('3 الف')).toBe(3000);
    expect(extractAmount('الاجمالي 3 الف')).toBe(3000); // marker no longer grabs the lone 3
    expect(extractAmount('٣ الف')).toBe(3000);
    expect(extractAmount('ثلاث الاف')).toBe(3000);
    expect(extractAmount('ثلاثة الاف')).toBe(3000);
    expect(extractAmount('بمبلغ الفين')).toBe(2000);
  });
  it('keeps the single-word «الف»→1000 and the compound «الف وخمسمئة»→null', () => {
    expect(extractAmount('الف')).toBe(1000);
    expect(extractAmount('الف ريال')).toBe(1000);
    expect(extractAmount('الف وخمسمئة ريال')).toBeNull(); // truncatable compound re-asks
  });
});

describe('A-P0-3 — a bare NIGHTS count is not a per-unit price', () => {
  it('requires the double-lam «لل» so «7 ليله»/«3 ليالي» are not prices', () => {
    expect(extractAmount('7 ليله')).toBeNull();
    expect(extractAmount('3 ليالي')).toBeNull();
    // Genuine per-unit prices (double-lam) still return the amount.
    expect(extractAmount('450 لليلة')).toBe(450);
    expect(extractAmount('450 للفترة')).toBe(450);
    expect(extractAmount('450 لليوم')).toBe(450);
    expect(extractAmount('450 للحجز')).toBe(450);
  });
});

describe('AW-P5-1 — a per-person figure is never the grand total', () => {
  it('«500 ريال للفرد»/«٥٠٠ للشخص» return null (re-ask the total)', () => {
    expect(extractAmount('500 ريال للفرد')).toBeNull();
    expect(extractAmount('500 ريال للشخص')).toBeNull();
    expect(extractAmount('٥٠٠ للشخص')).toBeNull();
    expect(extractAmount('500 ريال للنفر')).toBeNull();
    // A plain total is unaffected.
    expect(extractAmount('500 ريال')).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// extractGuestCount
// ---------------------------------------------------------------------------

describe('A-P0-2 — «لـN» in a «من … لـ …» range is not a headcount', () => {
  it('a time/price range tail is not guests, but a lone «لـN» still is', () => {
    expect(extractGuestCount('الوقت من سبعة لخمسة')).toBeNull();
    expect(extractGuestCount('لأربعة')).toBe(4);
    expect(extractGuestCount('لعشرة')).toBe(10);
  });
});

describe('A-P1-4 — «عدد <digit> <nights noun>» is a nights count, not guests', () => {
  it('a trailing nights/period noun disqualifies the headcount reading', () => {
    expect(extractGuestCount('عدد 3 ليالي')).toBeNull();
    expect(extractGuestCount('عدد 3 ايام')).toBeNull();
    expect(extractGuestCount('عدد 5')).toBe(5); // no nights noun -> still a headcount
  });
});

describe('AW-P4-1 — the dual «ضيفين»/«ضيفان» is 2 guests', () => {
  it('recognizes the dual of ضيف', () => {
    expect(extractGuestCount('ضيفين')).toBe(2);
    expect(extractGuestCount('ضيفان')).toBe(2);
  });
});

describe('A-P2-3 — a guest RANGE «3-5 ضيوف» keeps the MAX', () => {
  it('returns the larger bound so the capacity check stays conservative', () => {
    expect(extractGuestCount('3-5 ضيوف')).toBe(5);
    expect(extractGuestCount('٣-٥ ضيوف')).toBe(5);
    // A negative count stays invalid (the hyphen guard is not weakened).
    expect(extractGuestCount('-2 ضيوف')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isExplicitFree
// ---------------------------------------------------------------------------

describe('A-P1-6 — a NEGATED free phrase is not free', () => {
  it('«مو ببلاش»/«مب ببلاش»/«مش مجاني» are false; the bare words stay true', () => {
    expect(isExplicitFree('مو ببلاش')).toBe(false);
    expect(isExplicitFree('مب ببلاش')).toBe(false);
    expect(isExplicitFree('مش مجاني')).toBe(false);
    expect(isExplicitFree('ببلاش')).toBe(true);
    expect(isExplicitFree('مجاني')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseDateExpression
// ---------------------------------------------------------------------------

describe('A-P1-5 — «بعد يوم <weekday>» resolves the weekday, not tomorrow', () => {
  it('«بعد يوم الجمعة» on a Monday is that week\'s Friday', () => {
    expect(parseDateExpression('بعد يوم الجمعة', MON)).toEqual({ date: '2026-07-17', confidence: 'high' });
    expect(parseDateExpression('عقب يوم الجمعة', MON)).toEqual({ date: '2026-07-17', confidence: 'high' });
    // «بعد يوم» with no weekday still means +1 day (unchanged).
    expect(parseDateExpression('بعد يوم', MON)).toEqual({ date: '2026-07-14', confidence: 'high' });
  });
});

describe('AW-P7-1 — «الخميس القادم/الجاي» is strictly the NEXT occurrence', () => {
  it('on a Thursday it is +7, not today', () => {
    expect(parseDateExpression('الخميس القادم', THU)).toEqual({ date: '2026-07-23', confidence: 'high' });
    expect(parseDateExpression('الخميس الجاي', THU)).toEqual({ date: '2026-07-23', confidence: 'high' });
    // A bare weekday (no qualifier) on that same weekday still stays on today.
    expect(parseDateExpression('الخميس', THU)).toEqual({ date: '2026-07-16', confidence: 'high' });
    // From another day the qualifier does NOT force +7 — still the coming one.
    expect(parseDateExpression('الخميس القادم', MON)).toEqual({ date: '2026-07-16', confidence: 'high' });
  });
});

// ---------------------------------------------------------------------------
// parseTimeExpression
// ---------------------------------------------------------------------------

describe('AW-P6-1 — an afternoon start + bare small end is a SAME-DAY slot', () => {
  it('«من 3 عصرا الى 7» = 15:00→19:00; a real overnight is untouched', () => {
    expect(parseTimeExpression('من 3 عصرا الى 7')).toEqual({
      start: '15:00', end: '19:00', wraps_next_day: false, confidence: 'high',
    });
    expect(parseTimeExpression('من 1 ظهرا الى 5')).toEqual({
      start: '13:00', end: '17:00', wraps_next_day: false, confidence: 'high',
    });
    // A genuine overnight keeps its wrap (end carries an AM marker).
    expect(parseTimeExpression('من 7 مساء الى 5 صباحا')).toEqual({
      start: '19:00', end: '05:00', wraps_next_day: true, confidence: 'high',
    });
    // The one-evening-marker overnight «من ٧ مساء إلى ٥» is preserved.
    expect(parseTimeExpression('من ٧ مساء الى ٥')).toEqual({
      start: '19:00', end: '05:00', wraps_next_day: true, confidence: 'high',
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the deployed handler (model forced offline)
// ---------------------------------------------------------------------------

describe('A-P2-5 / AW-P5-1 / AW-P4-1 — end-to-end via convo()', () => {
  it('A-P2-5: «... باسم علي 0501234567 ريال» never banks the phone as total; phone masked', async () => {
    const c = convo();
    const r1 = await c.say(`احجز تولوم ${TOMORROW} مسائي عدد الضيوف 4 باسم علي 0501234567 ريال`);
    expect(r1.model_calls).toBe(0);
    expect(r1.fields.total).toBeUndefined(); // NOT 501234567
    expect(r1.private.customer_phone).toBe('0501234567'); // still captured
    expect(r1.reply).toMatch(/سعر/); // the planner re-asks the total

    // Accepting the SYSTEM price confirms the phone was never the amount.
    const r2 = await c.say('اعتمد');
    expect(r2.model_calls).toBe(0);
    expect(r2.fields.total).toBe(350); // the suggested price, not the phone
    expect(cardVal(r2.card, 'الجوال')).toBe('05••••4567'); // masked on the card
  });

  it('AW-P5-1: a per-person amount does not become the total — the planner re-asks', async () => {
    const c = convo();
    const r = await c.say(`احجز تولوم ${TOMORROW} مسائي عدد الضيوف 4 باسم علي جوال 0501234567 500 ريال للفرد`);
    expect(r.model_calls).toBe(0);
    expect(r.fields.total).toBeUndefined(); // 500 للفرد is per-person, not the grand total
    expect(r.reply).toMatch(/سعر/); // asks for the total
  });

  it('AW-P4-1: «ضيفين» is read as 2 guests end-to-end', async () => {
    const c = convo();
    const r = await c.say(`احجز تولوم ${TOMORROW} مسائي ضيفين باسم علي جوال 0501234567 400 ريال`);
    expect(r.model_calls).toBe(0);
    expect(r.fields.guests).toBe(2);
    expect(cardVal(r.card, 'الجوال')).toBe('05••••4567'); // phone captured & masked
  });
});
