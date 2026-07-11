// chalet-autopilot — pure vacancy-marketing planner (runtime-tested).
// DeepSeek drafts wording only; THIS code decides eligibility, price limits,
// consent, cooldown, duplicate prevention, and whether sending is permitted.
// Automation is OFF by default; automatic sending requires an explicitly
// enabled rule AND a healthy official WhatsApp connection — and even then this
// planner only QUEUES: a message becomes "sent" solely on a Cloud API
// acknowledgement handled elsewhere. Nothing here reports "sent".
//
// Safety invariants enforced here:
//   - the automation_run is created ATOMICALLY first (DB uniqueness on
//     (workspace_key, idempotency_key) is authoritative); a duplicate is
//     skipped BEFORE any outbound message is written;
//   - every outbound message is linked to that real run id (never null);
//   - the authoritative workspace is reloaded before creating a run and again
//     before queueing (a vacancy booked meanwhile is stopped_booked);
//   - a GLOBAL per-rule, per-Saudi-day cap bounds messages (max 0 => zero);
//   - cooldown advances only after a REAL send (never here).
//
// deps: {
//   nowMs, todayIso (Asia/Riyadh),
//   listEnabledRules() -> [rule],
//   getWorkspaceDoc(wsKey) -> { chalets, bookings },
//   messagesSentToday(wsKey, ruleId, todayIso) -> number,     // Saudi-day count
//   createRun(row) -> { ok, run_id } | { duplicate:true } | { ok:false },
//   updateRun(runId, patch) -> void,
//   priorContacts(wsKey) -> Map(customerRef -> lastMs),
//   optedOut(wsKey) -> Set(customerRef),
//   customerRefOf(wsKey, phone) -> string,
//   draftOffer(ctx) -> { ok, body } | { ok:false, error },
//   whatsappMode(wsKey) -> "disconnected"|"open_manual_whatsapp"|"official_cloud_api",
//   queueMessage(row) -> void,
// }

import { findEmptyVacancies, selectEligibleContacts, isVacancyStillEmpty } from "../_shared/assistant/vacancy.mjs";

export async function runAutopilot(deps) {
  const rules = (await deps.listEnabledRules()) || [];
  const summary = {
    rules_processed: 0, vacancies_found: 0, runs_created: 0, drafted: 0,
    queued: 0, awaiting_approval: 0, blocked_no_whatsapp: 0, stopped_booked: 0,
    duplicates_skipped: 0, capped: 0, details: [],
  };

  for (const rule of rules) {
    if (!rule.enabled) continue; // disabled by default; defensive
    summary.rules_processed++;
    const wsKey = rule.workspace_key;

    // GLOBAL daily budget for THIS rule on the current Saudi day. cap 0 => zero.
    const dailyCap = Math.max(0, Number(rule.maximum_daily_messages) || 0);
    let remainingCap = dailyCap - (await deps.messagesSentToday(wsKey, rule.id, deps.todayIso));
    if (remainingCap <= 0) { summary.capped++; summary.details.push({ rule_id: rule.id, outcome: "daily_cap_reached" }); continue; }

    const doc = await deps.getWorkspaceDoc(wsKey);
    if (!doc) continue;

    const vacancies = findEmptyVacancies({ workspaceKey: wsKey, doc, rule, todayIso: deps.todayIso });
    summary.vacancies_found += vacancies.length;

    for (const vac of vacancies) {
      if (remainingCap <= 0) { summary.capped++; break; }

      // Reload the authoritative doc and re-check the vacancy is still empty
      // BEFORE creating a run or any message.
      const freshDoc = (await deps.getWorkspaceDoc(wsKey)) || doc;
      if (!isVacancyStillEmpty(freshDoc, vac)) { summary.stopped_booked++; continue; }

      // ATOMIC run creation — the DB unique(workspace_key, idempotency_key) is
      // the authoritative duplicate guard. A violation means another run already
      // owns this vacancy: skip BEFORE writing any outbound message.
      const idempotencyKey = `autopilot:${rule.id}:${vac.vacancy_key}`;
      const created = await deps.createRun({
        workspace_key: wsKey, rule_id: rule.id, vacancy_key: vac.vacancy_key,
        idempotency_key: idempotencyKey, status: "started",
        eligible_contacts: 0, drafted_messages: 0, approved_messages: 0, sent_messages: 0,
        attributed_revenue_halalas: 0,
        safe_summary_json: { vacancy: { chalet_id: vac.chalet_id, date: vac.date, period_id: vac.period_id }, price_halalas: vac.price_halalas },
      });
      if (!created || created.duplicate) { summary.duplicates_skipped++; continue; }
      if (!created.ok || !created.run_id) { summary.details.push({ vacancy_key: vac.vacancy_key, outcome: "run_create_failed" }); continue; }
      const runId = created.run_id;
      summary.runs_created++;

      // Eligible contacts bounded by the GLOBAL remaining daily budget.
      const contacts = selectEligibleContacts({
        doc: freshDoc, rule,
        priorContacts: await deps.priorContacts(wsKey),
        optedOut: await deps.optedOut(wsKey),
        nowMs: deps.nowMs,
        customerRefOf: (phone) => deps.customerRefOf(wsKey, phone),
        maxContacts: remainingCap,
      });

      if (contacts.eligible.length === 0) {
        await deps.updateRun(runId, { status: "completed", eligible_contacts: 0, safe_summary_patch: { skipped: contacts.skipped } });
        summary.details.push({ vacancy_key: vac.vacancy_key, outcome: "no_eligible_contacts" });
        continue;
      }

      // Draft ONE offer wording (redacted context — never a phone number).
      const draft = await deps.draftOffer({
        chalet_id: vac.chalet_id, date: vac.date, price_halalas: vac.price_halalas,
        tone: rule.preferred_tone, allowed_offer_types: rule.allowed_offer_types,
      });
      if (!draft.ok) {
        await deps.updateRun(runId, { status: "failed", safe_summary_patch: { draft_error: draft.error } });
        summary.details.push({ vacancy_key: vac.vacancy_key, outcome: "draft_failed" });
        continue;
      }

      const mode = await deps.whatsappMode(wsKey);
      // Official AUTOMATIC sending is intentionally kept DISABLED: even in
      // official mode we only QUEUE. A message is "sent" solely on a Cloud API
      // acknowledgement (a separate delivery path), never invented here.
      const wantsAuto = rule.automatic_send_enabled === true && mode === "official_cloud_api";
      let queued = 0, awaiting = 0;
      for (const c of contacts.eligible) {
        if (remainingCap <= 0) break;
        let status;
        if (wantsAuto) { status = "queued"; queued++; summary.queued++; }
        else { status = "awaiting_approval"; awaiting++; summary.awaiting_approval++; if (mode === "disconnected") summary.blocked_no_whatsapp++; }
        await deps.queueMessage({
          workspace_key: wsKey,
          automation_run_id: runId, // real run id — never null
          booking_id: c.booking_id,
          customer_reference: c.customer_reference,
          channel: "whatsapp",
          mode,
          safe_message_body: draft.body,
          destination_ref: c.customer_reference, // server resolves the real number later
          status,
        });
        remainingCap--;
      }
      const emitted = queued + awaiting;
      summary.drafted += emitted;
      await deps.updateRun(runId, {
        status: queued > 0 ? "queued" : "awaiting_approval",
        eligible_contacts: contacts.eligible.length,
        drafted_messages: emitted,
        approved_messages: 0,
        sent_messages: 0, // "sent" only via a Cloud API webhook, never here
        safe_summary_patch: { skipped: contacts.skipped },
      });
      summary.details.push({ vacancy_key: vac.vacancy_key, outcome: queued > 0 ? "queued" : "awaiting_approval", eligible: contacts.eligible.length });
    }
  }
  return summary;
}
