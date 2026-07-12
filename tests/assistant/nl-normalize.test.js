// Contract tests for nl-normalize.mjs — Arabic/Persian/Western NL time+date
// normalization. Fixed todayIso everywhere: pure functions, no Date.now().
import { describe, it, expect } from 'vitest';
import {
  foldDigits,
  normalizeTimeHHmm,
  parseTimeExpression,
  parseDateExpression,
  addDaysIso,
  formatDateDisplay,
  extractGuestCount,
  extractAmount,
  isExplicitFree,
  CONFIRM_PHRASES,
  isBareConfirmPhrase,
  classifyMeridiemWord,
} from '../../supabase/functions/_shared/assistant/nl-normalize.mjs';

const TODAY = '2026-07-12'; // a Sunday

describe('foldDigits', () => {
  it('maps Arabic-Indic and Persian digits to ASCII', () => {
    expect(foldDigits('٧:٠٠')).toBe('7:00');
    expect(foldDigits('۷-۵')).toBe('7-5');
    expect(foldDigits('abc ١٢٣ ۴۵۶')).toBe('abc 123 456');
  });
  it('leaves everything else untouched', () => {
    expect(foldDigits('مساءً 7-5')).toBe('مساءً 7-5');
  });
});

describe('normalizeTimeHHmm', () => {
  it('pads and validates', () => {
    expect(normalizeTimeHHmm('7:00')).toBe('07:00');
    expect(normalizeTimeHHmm('07:00')).toBe('07:00');
    expect(normalizeTimeHHmm('٧:٠٠')).toBe('07:00');
    expect(normalizeTimeHHmm('19:5')).toBe('19:05');
  });
  it('rejects malformed/out-of-range input', () => {
    expect(normalizeTimeHHmm('25:00')).toBeNull();
    expect(normalizeTimeHHmm('7')).toBeNull();
    expect(normalizeTimeHHmm('')).toBeNull();
    expect(normalizeTimeHHmm('12:60')).toBeNull();
    expect(normalizeTimeHHmm(undefined)).toBeNull();
  });
});

describe('parseTimeExpression', () => {
  const overnight = { start: '19:00', end: '05:00', wraps_next_day: true };

  it('treats ٧-٥ / ۷-۵ / 7-5 identically (bare overnight, medium)', () => {
    for (const s of ['7-5', '٧-٥', '۷-۵']) {
      expect(parseTimeExpression(s)).toEqual({ ...overnight, confidence: 'medium' });
    }
  });

  it('bare 7:00-5:00 is the overnight slot (medium)', () => {
    expect(parseTimeExpression('7:00-5:00')).toEqual({ ...overnight, confidence: 'medium' });
  });

  it('bare 5-7 stays the naive AM interpretation (low)', () => {
    expect(parseTimeExpression('5-7')).toEqual({
      start: '05:00',
      end: '07:00',
      wraps_next_day: false,
      confidence: 'low',
    });
  });

  it('explicit meridiem markers give high confidence', () => {
    for (const s of [
      '7pm to 5am',
      '7:00 PM–5:00 AM',
      'من ٧ مساء إلى ٥ صباح',
      '٧ مساءً إلى ٥ صباحاً',
      'من 7:00 مساء إلى 5:00 صباح',
    ]) {
      expect(parseTimeExpression(s)).toEqual({ ...overnight, confidence: 'high' });
    }
  });

  it('reads a spoken end hour and never borrows the later guest count', () => {
    const full = 'سجل حجز جديد اليوم المساء من ٧ الى خمس الصباح رقم الجوال 0503666853 اسم الشاليه تولوم عدد الضيوف ١٠ السعر ٣٠٠';
    expect(parseTimeExpression(full)).toEqual({ ...overnight, confidence: 'high' });
    expect(parseTimeExpression('احجز من ٧ الى اسم الشاليه تولوم عدد الضيوف ١٠')).toBeNull();
  });

  it('a conjunction-prefixed field word («وعدد الضيوف ٣») breaks the range, not becomes the end hour', () => {
    // Only a 7 PM START was given — the «٣» guests must never be the end hour.
    expect(parseTimeExpression('سجل حجز اليوم من ٧ مساء وعدد الضيوف ٣')).toBeNull();
    expect(parseTimeExpression('من ٧ مساء لعدد ٣ اشخاص')).toBeNull();
    // The genuine range still parses when a real end hour follows.
    expect(parseTimeExpression('من ٧ مساء الى ٥ صباحا وعدد الضيوف ٣')).toEqual({ ...overnight, confidence: 'high' });
  });

  it('24h pair 19:00 إلى 05:00 is high and wraps', () => {
    expect(parseTimeExpression('19:00 إلى 05:00')).toEqual({
      ...overnight,
      confidence: 'high',
    });
  });

  it('infers the bare side from one marker: «من ٧ مساء إلى ٥»', () => {
    expect(parseTimeExpression('من ٧ مساء إلى ٥')).toEqual({
      ...overnight,
      confidence: 'high',
    });
  });

  it('same-meridiem inference when overnight is incoherent: «من ٥ إلى ٧ مساء»', () => {
    expect(parseTimeExpression('من ٥ إلى ٧ مساء')).toEqual({
      start: '17:00',
      end: '19:00',
      wraps_next_day: false,
      confidence: 'high',
    });
  });

  it('converts ١٢ ص to 00:00 and ١٢ م to 12:00', () => {
    expect(parseTimeExpression('١٢ ص الى ٥ ص')).toEqual({
      start: '00:00',
      end: '05:00',
      wraps_next_day: false,
      confidence: 'high',
    });
    expect(parseTimeExpression('١٢ م الى ٥ م')).toEqual({
      start: '12:00',
      end: '17:00',
      wraps_next_day: false,
      confidence: 'high',
    });
  });

  it('returns null when no range exists', () => {
    expect(parseTimeExpression('الفترة المسائية')).toBeNull();
    expect(parseTimeExpression('الساعة 7 مساء')).toBeNull(); // lone time
    expect(parseTimeExpression('')).toBeNull();
    expect(parseTimeExpression('01-01-2020')).toBeNull(); // date, not a time
    expect(parseTimeExpression('15/08')).toBeNull(); // date pair
  });
});

describe('parseDateExpression', () => {
  it('resolves keywords against todayIso', () => {
    expect(parseDateExpression('اليوم', TODAY)).toEqual({ date: '2026-07-12', confidence: 'high' });
    expect(parseDateExpression('بكرة', TODAY)).toEqual({ date: '2026-07-13', confidence: 'high' });
    expect(parseDateExpression('بكرة بالليل', TODAY)).toEqual({ date: '2026-07-13', confidence: 'high' });
    expect(parseDateExpression('بعد بكرة', TODAY)).toEqual({ date: '2026-07-14', confidence: 'high' });
    expect(parseDateExpression('بعد غد', TODAY)).toEqual({ date: '2026-07-14', confidence: 'high' });
  });

  it('explicit minutes on both sides are unambiguous — high confidence, literal reading', () => {
    // The pasted option line case: «07:00–12:00» must never trigger
    // «صباحاً أم مساءً؟» (en-dash folds to '-').
    expect(parseTimeExpression('07:00–12:00')).toEqual({ start: '07:00', end: '12:00', wraps_next_day: false, confidence: 'high' });
    expect(parseTimeExpression('شاليه تولوم — 2026-07-12 — 07:00–12:00 — 300 ريال')).toEqual({ start: '07:00', end: '12:00', wraps_next_day: false, confidence: 'high' });
    expect(parseTimeExpression('٠٧:٠٠-١٢:٠٠')).toEqual({ start: '07:00', end: '12:00', wraps_next_day: false, confidence: 'high' });
    // Bare pairs stay ambiguous; descending with minutes stays the classic
    // medium overnight reading (regressions pinned).
    expect(parseTimeExpression('من 7 الى 12').confidence).toBe('low');
    expect(parseTimeExpression('7:00-5:00')).toEqual({ start: '19:00', end: '05:00', wraps_next_day: true, confidence: 'medium' });
  });

  it('accepts the alif-ending spellings (live bug B: «بعد بكرا»)', () => {
    expect(parseDateExpression('بكرا', TODAY)).toEqual({ date: '2026-07-13', confidence: 'high' });
    expect(parseDateExpression('باكرا', TODAY)).toEqual({ date: '2026-07-13', confidence: 'high' });
    expect(parseDateExpression('بعد بكرا', TODAY)).toEqual({ date: '2026-07-14', confidence: 'high' });
    expect(parseDateExpression('التاريخ بعد بكرا', TODAY)).toEqual({ date: '2026-07-14', confidence: 'high' });
    expect(parseDateExpression('بعد باكرا', TODAY)).toEqual({ date: '2026-07-14', confidence: 'high' });
  });

  it('weekdays resolve to the next occurrence, counting today', () => {
    expect(parseDateExpression('الجمعة', TODAY)).toEqual({ date: '2026-07-17', confidence: 'high' });
    expect(parseDateExpression('احجز يوم الخميس', TODAY)).toEqual({ date: '2026-07-16', confidence: 'high' });
    // Today IS Sunday, so الأحد/sunday stay on today.
    expect(parseDateExpression('الأحد', TODAY)).toEqual({ date: '2026-07-12', confidence: 'high' });
    expect(parseDateExpression('Sunday', TODAY)).toEqual({ date: '2026-07-12', confidence: 'high' });
  });

  it('parses numeric forms with reordering', () => {
    expect(parseDateExpression('2026-08-15', TODAY)).toEqual({ date: '2026-08-15', confidence: 'high' });
    expect(parseDateExpression('15-08-2026', TODAY)).toEqual({ date: '2026-08-15', confidence: 'high' });
    expect(parseDateExpression('15/08/2026', TODAY)).toEqual({ date: '2026-08-15', confidence: 'high' });
  });

  it('rolls no-year DD/MM into next year when already past', () => {
    expect(parseDateExpression('15/08', '2026-12-20')).toEqual({ date: '2027-08-15', confidence: 'medium' });
    expect(parseDateExpression('15/08', TODAY)).toEqual({ date: '2026-08-15', confidence: 'medium' });
    expect(parseDateExpression('15-08', TODAY)).toEqual({ date: '2026-08-15', confidence: 'medium' });
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDateExpression('31/02/2026', TODAY)).toEqual({
      error: 'INVALID_DATE',
      reason_ar: 'التاريخ غير صحيح. تأكد من اليوم والشهر.',
    });
    expect(parseDateExpression('2026-02-31', TODAY).error).toBe('INVALID_DATE');
    expect(parseDateExpression('31/11', TODAY).error).toBe('INVALID_DATE');
  });

  it('rejects past dates', () => {
    expect(parseDateExpression('01-01-2020', TODAY)).toEqual({
      error: 'PAST_DATE',
      reason_ar: 'لا يمكن إنشاء حجز جديد بتاريخ ماضٍ.',
    });
    expect(parseDateExpression('2026-07-11', TODAY).error).toBe('PAST_DATE');
  });

  it('returns null when there is no date reference', () => {
    expect(parseDateExpression('500', TODAY)).toBeNull(); // bare number ≠ date
    expect(parseDateExpression('سجل حجز', TODAY)).toBeNull();
    expect(parseDateExpression('', TODAY)).toBeNull();
  });
});

describe('addDaysIso / formatDateDisplay', () => {
  it('does UTC calendar math across month/year edges', () => {
    expect(addDaysIso('2026-07-12', 2)).toBe('2026-07-14');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('formats DD-MM-YYYY and blanks invalid input', () => {
    expect(formatDateDisplay('2026-07-15')).toBe('15-07-2026');
    expect(formatDateDisplay('2026-02-31')).toBe('');
    expect(formatDateDisplay('not-a-date')).toBe('');
    expect(formatDateDisplay(undefined)).toBe('');
  });
});

describe('extractGuestCount', () => {
  it('reads digits + person words in either order', () => {
    expect(extractGuestCount('٤ أشخاص')).toBe(4);
    expect(extractGuestCount('4 اشخاص')).toBe(4);
    expect(extractGuestCount('guests 4')).toBe(4);
  });
  it('understands dual and number-word forms', () => {
    expect(extractGuestCount('لشخصين')).toBe(2);
    expect(extractGuestCount('شخص واحد')).toBe(1);
    expect(extractGuestCount('اربعة اشخاص')).toBe(4);
    expect(extractGuestCount('أربعة')).toBe(4); // whole message is a number word
    expect(extractGuestCount('٤')).toBe(4); // whole message is a small digit
  });
  it('never confuses money for guests', () => {
    expect(extractGuestCount('500 ريال')).toBeNull();
    expect(extractGuestCount('500')).toBeNull(); // > 200 cap
    expect(extractGuestCount('')).toBeNull();
  });
});

describe('extractAmount', () => {
  it('parses digits with a currency word', () => {
    expect(extractAmount('500 ريال')).toBe(500);
    expect(extractAmount('٥٠٠ ريال')).toBe(500);
    expect(extractAmount('500ريال')).toBe(500);
    expect(extractAmount('٥٠٫٥ ريال')).toBe(50.5);
  });
  it('parses a marked price without requiring a currency word', () => {
    expect(extractAmount('السعر ٣٠٠')).toBe(300);
    expect(extractAmount('عدد الضيوف ١٠ السعر: ٣٠٠')).toBe(300);
    expect(extractAmount('رقم الجوال 0503666853 عدد الضيوف ١٠')).toBeNull();
  });
  it('parses hundred-words', () => {
    expect(extractAmount('بمئة ريال')).toBe(100);
    expect(extractAmount('بخمسمئة')).toBe(500);
    expect(extractAmount('خمسمائة')).toBe(500);
    expect(extractAmount('ألف ريال')).toBe(1000);
  });
  it('bare numbers only count when they are the whole message', () => {
    expect(extractAmount('500')).toBe(500);
    expect(extractAmount('التأمين 500')).toBeNull(); // no currency, not bare
    expect(extractAmount('أربعة')).toBeNull(); // guest word, not money
    expect(extractAmount('')).toBeNull();
  });
  it('reads a thousands-separated amount in full, not just the trailing group', () => {
    expect(extractAmount('1,500 ريال')).toBe(1500);
    expect(extractAmount('١٬٥٠٠ ريال')).toBe(1500);
    expect(extractAmount('السعر 15,000')).toBe(15000);
    expect(extractAmount('2,500,000 ريال')).toBe(2500000);
  });
  it('re-asks (returns null) for a truncatable compound spoken amount', () => {
    // «الف وخمسمئة» = 1500; recording only 1000 silently understates it.
    expect(extractAmount('الف وخمسمئة ريال')).toBeNull();
    expect(extractAmount('مئة وخمسين ريال')).toBeNull();
    // A plain hundred-word with no continuation is still fine.
    expect(extractAmount('بخمسمئة ريال')).toBe(500);
  });
});

describe('isExplicitFree', () => {
  it('detects explicit free phrases only', () => {
    expect(isExplicitFree('الحجز مجاني')).toBe(true);
    expect(isExplicitFree('مجاناً')).toBe(true);
    expect(isExplicitFree('بدون سعر')).toBe(true);
    expect(isExplicitFree('الإجمالي صفر')).toBe(true);
    expect(isExplicitFree('صفر ريال')).toBe(true);
    expect(isExplicitFree('صفر')).toBe(true);
  });
  it('missing price never implies free', () => {
    expect(isExplicitFree('')).toBe(false);
    expect(isExplicitFree('سجل الحجز')).toBe(false);
    expect(isExplicitFree('السعر 500')).toBe(false);
  });
});

describe('isBareConfirmPhrase', () => {
  it('accepts bare confirmations up to 3 tokens', () => {
    expect(isBareConfirmPhrase('سجل')).toBe(true);
    expect(isBareConfirmPhrase('نعم سجل')).toBe(true);
    expect(isBareConfirmPhrase('سجل الحجز')).toBe(true);
    expect(isBareConfirmPhrase('تمام نفذ')).toBe(true);
    expect(isBareConfirmPhrase('أكّد')).toBe(true);
    expect(isBareConfirmPhrase('موافق')).toBe(true);
    expect(isBareConfirmPhrase('OK')).toBe(true);
    expect(isBareConfirmPhrase('ايوه')).toBe(true);
  });
  it('rejects messages carrying booking content', () => {
    expect(isBareConfirmPhrase('سجل حجز جديد لعلي بكرة')).toBe(false);
    expect(isBareConfirmPhrase('سجل حجز لعلي بكرة')).toBe(false);
    expect(isBareConfirmPhrase('سجل 15/08')).toBe(false); // digits
    expect(isBareConfirmPhrase('شكرا')).toBe(false);
    expect(isBareConfirmPhrase('')).toBe(false);
  });
  it('exports the phrase list', () => {
    expect(Array.isArray(CONFIRM_PHRASES)).toBe(true);
    expect(CONFIRM_PHRASES).toContain('سجل');
    expect(CONFIRM_PHRASES).toContain('نعم');
  });
});

describe('classifyMeridiemWord (AM/PM clarify answers)', () => {
  it('classifies pure meridiem answers', () => {
    expect(classifyMeridiemWord('مساء')).toBe('PM');
    expect(classifyMeridiemWord('مساءً')).toBe('PM');
    expect(classifyMeridiemWord('المساء')).toBe('PM');
    expect(classifyMeridiemWord('بالليل')).toBe('PM');
    expect(classifyMeridiemWord('عشاء')).toBe('PM');
    expect(classifyMeridiemWord('صباح')).toBe('AM');
    expect(classifyMeridiemWord('صباحاً')).toBe('AM');
    expect(classifyMeridiemWord('الصبح')).toBe('AM');
  });
  it('refuses digits, contradictions and unrelated text', () => {
    expect(classifyMeridiemWord('من 7 مساء')).toBeNull(); // real time re-parses
    expect(classifyMeridiemWord('صباح مساء')).toBeNull();
    expect(classifyMeridiemWord('تمام')).toBeNull();
    expect(classifyMeridiemWord('')).toBeNull();
  });
});
