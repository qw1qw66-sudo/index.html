// chalet-autopilot — pure vacancy-marketing planner (runtime-tested).
// DeepSeek drafts wording only; THIS code decides eligibility, price limits,
// consent, cooldown, duplicate prevention, and whether sending is permitted.
// Automation is OFF by default; automatic sending requires an explicitly
// enabled rule AND a healthy official WhatsApp connection.
//
// deps: {
//   nowMs, todayIso,
//   listEnabledRules() -> [rule],                       // only enabled ones
//   getWorkspaceDoc(wsKey) -> { chalets, bookings },
//   findRun(wsKey, idempotencyKey) -> run | null,
//   priorContacts(wsKey) -> Map(customerRef -> lastMs),
//   optedOut(wsKey) -> Set(customerRef),
//   customerRefOf(wsKey, phone) -> string,
//   draftOffer(ctx) -> { ok, body } | { ok:false, error },   // wraps DeepSeek
//   whatsappMode(wsKey) -> "disconnected"|"open_manual_whatsapp"|"official_cloud_api",
//   recordRun(row) -> { run_id },
//   queueMessage(row) -> void,
// }

import { findEmptyVacancies, selectEligibleContacts, isVacancyStillEmpty } from "../_shared/assistant/vacancy.mjs";

export async function runAutopilot(deps) {
  const rules = (await deps.listEnabledRules()) || [];
  const summary = { rules_processed: 0, vacancies_found: 0, runs_created: 0, drafted: 0, queued_official: 0, blocked_no_whatsapp: 0, stopped_booked: 0, duplicates_skipped: 0, details: [] };

  for (const rule of rules) {
    if (!rule.enabled) continue; // disabled by default; defensive
    summary.rules_processed++;
    const wsKey = rule.workspace_key;
    const doc = await deps.getWorkspaceDoc(wsKey);
    if (!doc) continue;

    const vacancies = findEmptyVacancies({ workspaceKey: wsKey, doc, rule, todayIso: deps.todayIso });
    summary.vacancies_found += vacancies.length;

    for (const vac of vacancies) {
      // Idempotency: one run per (rule, vacancy) — never spam the same vacancy.
      const idempotencyKey = `autopilot:${rule.id}:${vac.vacancy_key}`;
      const existing = await deps.findRun(wsKey, idempotencyKey);
      if (existing) { summary.duplicates_skipped++; continue; }

      // Re-check the vacancy is still empty (may have been booked since scan).
      if (!isVacancyStillEmpty(doc, vac)) { summary.stopped_booked++; continue; }

      const contacts = selectEligibleContacts({
        doc, rule,
        priorContacts: await deps.priorContacts(wsKey),
        optedOut: await deps.optedOut(wsKey),
        nowMs: deps.nowMs,
        customerRefOf: (phone) => deps.customerRefOf(wsKey, phone),
      });

      const run = {
        workspace_key: wsKey,
        rule_id: rule.id,
        vacancy_key: vac.vacancy_key,
        idempotency_key: idempotencyKey,
        status: "started",
        eligible_contacts: contacts.eligible.length,
        drafted_messages: 0,
        approved_messages: 0,
        sent_messages: 0,
        attributed_revenue_halalas: 0,
        safe_summary_json: { vacancy: { chalet_id: vac.chalet_id, date: vac.date, period_id: vac.period_id }, price_halalas: vac.price_halalas, skipped: contacts.skipped },
      };

      if (contacts.eligible.length === 0) {
        run.status = "completed";
        await deps.recordRun(run);
        summary.runs_created++;
        summary.details.push({ vacancy_key: vac.vacancy_key, outcome: "no_eligible_contacts" });
        continue;
      }

      // Draft ONE offer wording (redacted context — no phone numbers).
      const draft = await deps.draftOffer({
        chalet_id: vac.chalet_id, date: vac.date, price_halalas: vac.price_halalas,
        tone: rule.preferred_tone, allowed_offer_types: rule.allowed_offer_types,
      });
      if (!draft.ok) {
        run.status = "failed";
        run.safe_summary_json.draft_error = draft.error;
        await deps.recordRun(run);
        summary.runs_created++;
        continue;
      }
      run.drafted_messages = contacts.eligible.length;
      summary.drafted += contacts.eligible.length;

      const mode = await deps.whatsappMode(wsKey);
      const canAutoSend = rule.automatic_send_enabled === true && mode === "official_cloud_api";

      // Queue a message per contact. The PLANNER never has the phone number
      // (privacy) — the delivery layer resolves it server-side later via the
      // WhatsApp adapter (whatsapp.mjs resolveOutbound). NOTHING is auto-sent
      // unless explicitly enabled AND official API is healthy; otherwise it
      // awaits owner action.
      for (const c of contacts.eligible) {
        let status;
        if (canAutoSend) { status = "queued"; summary.queued_official++; }
        else { status = "awaiting_approval"; if (mode === "disconnected") summary.blocked_no_whatsapp++; }
        await deps.queueMessage({
          workspace_key: wsKey,
          automation_run_id: null, // linked by recordRun in real deps
          booking_id: c.booking_id,
          customer_reference: c.customer_reference,
          channel: "whatsapp",
          mode,
          safe_message_body: draft.body,
          destination_ref: c.customer_reference, // server resolves the real number later
          status,
        });
      }
      run.status = canAutoSend ? "sent" : "awaiting_approval";
      run.approved_messages = 0;
      run.sent_messages = 0; // "sent" is only confirmed by a Cloud API webhook, never here
      await deps.recordRun(run);
      summary.runs_created++;
      summary.details.push({ vacancy_key: vac.vacancy_key, outcome: run.status, eligible: contacts.eligible.length });
    }
  }
  return summary;
}
