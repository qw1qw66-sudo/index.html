// vacancy.mjs — DETERMINISTIC vacancy detection, contact eligibility, and
// conversion attribution. DeepSeek only drafts wording; this code decides who
// is eligible, price limits, consent, cooldown, duplicate prevention, and
// whether sending is permitted. Pure functions (no I/O, no Date.now — the
// caller passes today's date / now-ms so runs are reproducible and testable).

import { isSlotAvailable, isPeriodBookable } from "./availability.mjs";

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}
function activeChalets(doc) {
  return (doc?.chalets || []).filter((c) => !c.deleted_at);
}
function activeBookings(doc) {
  return (doc?.bookings || []).filter((b) => !b.deleted_at);
}
function periodPriceHalalas(period, iso) {
  // Weekend in KSA: Fri(5)/Sat(6). Prices in the doc are riyals; ×100.
  const wd = weekdayOf(iso);
  const weekend = wd === 5 || wd === 6;
  const riyals = Number(weekend ? period.weekend_price : period.weekday_price) || 0;
  return Math.round(riyals * 100);
}

export function vacancyKey(workspaceKey, chaletId, date, periodId) {
  return `${workspaceKey}|${chaletId}|${date}|${periodId}`;
}

/**
 * Find empty (chalet, date, period) slots for a rule within its scan window.
 * A slot is empty when no confirmed, non-deleted booking occupies it.
 */
export function findEmptyVacancies({ workspaceKey, doc, rule, todayIso }) {
  const chalet = activeChalets(doc).find((c) => c.id === rule.chalet_id);
  if (!chalet) return [];
  const eligiblePeriodIds = (rule.eligible_period_ids && rule.eligible_period_ids.length)
    ? new Set(rule.eligible_period_ids)
    : null;
  const eligibleWeekdays = (rule.eligible_weekdays && rule.eligible_weekdays.length)
    ? new Set(rule.eligible_weekdays)
    : null;
  // Same engine as bookings: time-overlap availability (a cross-period
  // overlapping booking blocks the slot) and FAIL CLOSED on incomplete times —
  // the autopilot must never advertise a slot the booking flow would reject.
  const periods = (chalet.periods || []).filter((p) => p.active && isPeriodBookable(p).ok);

  const out = [];
  const horizon = Math.max(1, Math.min(120, Number(rule.scan_days_ahead) || 14));
  for (let i = 0; i < horizon; i++) {
    const date = addDays(todayIso, i);
    if (eligibleWeekdays && !eligibleWeekdays.has(weekdayOf(date))) continue;
    for (const p of periods) {
      if (eligiblePeriodIds && !eligiblePeriodIds.has(p.id)) continue;
      if (!isSlotAvailable(doc, chalet.id, date, p)) continue;
      const price = periodPriceHalalas(p, date);
      if (price < (Number(rule.minimum_price_halalas) || 0)) continue; // respect minimum price
      out.push({
        vacancy_key: vacancyKey(workspaceKey, chalet.id, date, p.id),
        chalet_id: chalet.id,
        date,
        period_id: p.id,
        price_halalas: price,
      });
    }
  }
  return out;
}

/** Re-check that a specific vacancy is still empty (called before send).
 * Overlap-aware: a cross-period overlapping confirmed booking occupies it. */
export function isVacancyStillEmpty(doc, { chalet_id, date, period_id }) {
  const chalet = activeChalets(doc).find((c) => c.id === chalet_id);
  const period = chalet ? (chalet.periods || []).find((p) => p.id === period_id) : null;
  if (chalet && period) return isSlotAvailable(doc, chalet_id, date, period);
  // Unresolvable chalet/period (deleted, repointed): emptiness cannot be
  // PROVEN — fail closed, never market a slot we can't verify.
  return false;
}

const KSA_PHONE = /^(?:\+?9665\d{8}|00966\d{9}|05\d{8}|5\d{8})$/;

/**
 * Deterministic contact selection. Returns internal customer references only
 * (no phone numbers leave this layer to the model). Applies: previous-customer
 * group, valid phone, opt-out, cooldown, dedupe, and the daily cap.
 *
 * priorContacts: Map customerRef -> lastContactedMs (from outbound_messages)
 * optedOut: Set of customerRef
 * customerRefOf(phone): (phone) => stable non-PII reference
 */
export function selectEligibleContacts({ doc, rule, priorContacts = new Map(), optedOut = new Set(), nowMs, customerRefOf, maxContacts }) {
  // The effective cap is the SMALLER of the rule's per-day maximum and the
  // caller-supplied remaining global daily budget (so cross-run daily totals are
  // respected). maxContacts === 0 => nothing is eligible.
  const ruleCap = Math.max(0, Number(rule.maximum_daily_messages) || 0);
  const cap = maxContacts === undefined ? ruleCap : Math.max(0, Math.min(ruleCap, Number(maxContacts) || 0));
  const cooldownMs = (Number(rule.contact_cooldown_hours) || 0) * 3600_000;
  const seen = new Set();
  const eligible = [];
  const skipped = { invalid_phone: 0, opted_out: 0, cooldown: 0, duplicate: 0 };

  // "previous customers": distinct customers from prior bookings, newest first.
  const bookings = activeBookings(doc)
    .filter((b) => b.customer_phone)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  for (const b of bookings) {
    if (eligible.length >= cap) break; // cap reached (cap 0 => emit nothing)
    const phone = String(b.customer_phone).replace(/[\s\-()+]/g, "");
    if (!KSA_PHONE.test(phone)) { skipped.invalid_phone++; continue; }
    const ref = customerRefOf(phone);
    if (seen.has(ref)) { skipped.duplicate++; continue; }
    seen.add(ref);
    if (optedOut.has(ref)) { skipped.opted_out++; continue; }
    const last = priorContacts.get(ref);
    if (last != null && nowMs - last < cooldownMs) { skipped.cooldown++; continue; }
    eligible.push({ customer_reference: ref, booking_id: b.id });
  }
  return { eligible, skipped, capped: eligible.length >= cap };
}

/**
 * Attribution: a booking is attributable to a campaign when it is for the SAME
 * vacancy, the customer was contacted by the campaign, and it was created
 * within the attribution window. Uncertain matches are marked "محتمل".
 */
export function attributeBooking({ run, contactedRefs = new Set(), booking, bookingCustomerRef, windowMs, runStartedMs, bookingCreatedMs }) {
  if (!booking) return { attributed: false };
  const sameVacancy =
    `${run.chalet_id}` === `${booking.chalet_id}` &&
    `${run.date}` === `${booking.booking_date}` &&
    `${run.period_id}` === `${booking.period_id}`;
  if (!sameVacancy) return { attributed: false };
  const inWindow = bookingCreatedMs >= runStartedMs && bookingCreatedMs - runStartedMs <= windowMs;
  const wasContacted = contactedRefs.has(bookingCustomerRef);
  if (sameVacancy && wasContacted && inWindow) return { attributed: true, confidence: "confirmed" };
  if (sameVacancy && inWindow) return { attributed: true, confidence: "probable" }; // "محتمل"
  return { attributed: false };
}
