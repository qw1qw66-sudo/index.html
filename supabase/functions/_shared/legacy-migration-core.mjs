// legacy-migration-core.mjs — pure planner for migrating legacy booking.paid
// values into legacy_opening_balance ledger transactions.
//
// The planner never touches a database or network: it takes the workspace
// document (as exported/fetched from Supabase) and returns a deterministic
// plan + report. Idempotency is guaranteed by the deterministic key
//   legacy:<workspace_key>:<booking_id>
// combined with the unique idempotency_key constraint on
// payment_transactions and ON CONFLICT DO NOTHING in the emitted SQL:
// running the migration any number of times cannot duplicate a transaction.

import { riyalsNumberToHalalas, bookingIsDeleted, bookingIsCancelled } from "./ledger-core.mjs";

export function legacyIdempotencyKey(workspaceKey, bookingId) {
  return `legacy:${workspaceKey}:${bookingId}`;
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceKey
 * @param {object} opts.workspaceDoc  the JSON document ({ bookings: [...] });
 *   the RPC wrapper shape ({ ok, data: {...} }) is also accepted.
 * @param {Set<string>} [opts.existingIdempotencyKeys]  keys already present
 *   in payment_transactions (for dry-runs against a live ledger snapshot).
 * @param {boolean} [opts.includeDeleted=false]  also migrate soft-deleted
 *   bookings that carry a paid amount (default: report them, skip them).
 * @returns {{ plan: object[], report: object }}
 */
export function planLegacyMigration({
  workspaceKey,
  workspaceDoc,
  existingIdempotencyKeys = new Set(),
  includeDeleted = false,
}) {
  const doc = workspaceDoc && workspaceDoc.data && workspaceDoc.data.bookings
    ? workspaceDoc.data
    : workspaceDoc || {};
  const bookings = Array.isArray(doc.bookings) ? doc.bookings : [];

  const plan = [];
  const report = {
    workspace_key: workspaceKey,
    inspected: 0,
    eligible: 0,
    planned: 0,
    already_migrated: 0,
    total_planned_halalas: 0,
    skipped_zero_paid: 0,
    skipped_deleted: 0,
    invalid: [],
    ambiguous: [],
    flags: [],
    errors: [],
  };

  if (!workspaceKey || typeof workspaceKey !== "string") {
    report.errors.push({ reason: "MISSING_WORKSPACE_KEY" });
    return { plan, report };
  }

  const seenIds = new Set();

  for (const b of bookings) {
    report.inspected += 1;

    const id = typeof b?.id === "string" ? b.id.trim() : "";
    if (!id) {
      report.invalid.push({ id: null, reason: "MISSING_BOOKING_ID" });
      continue;
    }
    if (seenIds.has(id)) {
      report.invalid.push({ id, reason: "DUPLICATE_BOOKING_ID" });
      continue;
    }
    seenIds.add(id);

    const rawPaid = b.paid;
    // The app's normalizeData treats a missing paid field as 0 — mirror that.
    if (rawPaid === undefined || rawPaid === null || rawPaid === "") {
      report.skipped_zero_paid += 1;
      continue;
    }
    const paidNumber = typeof rawPaid === "number" ? rawPaid : Number(rawPaid);
    if (Number.isNaN(paidNumber)) {
      report.invalid.push({ id, reason: "PAID_NOT_A_NUMBER" });
      continue;
    }
    if (paidNumber < 0) {
      report.invalid.push({ id, reason: "PAID_NEGATIVE" });
      continue;
    }
    if (paidNumber === 0) {
      report.skipped_zero_paid += 1;
      continue;
    }

    const conv = riyalsNumberToHalalas(paidNumber);
    if (!conv.ok) {
      report.ambiguous.push({ id, paid: rawPaid, reason: conv.error });
      continue;
    }

    if (bookingIsDeleted(b) && !includeDeleted) {
      report.skipped_deleted += 1;
      continue;
    }

    report.eligible += 1;

    const key = legacyIdempotencyKey(workspaceKey, id);
    if (existingIdempotencyKeys.has(key)) {
      report.already_migrated += 1;
      continue;
    }

    if (bookingIsCancelled(b)) {
      report.flags.push({ id, flag: "CANCELLED_WITH_PAID_AMOUNT" });
    }
    if (bookingIsDeleted(b)) {
      report.flags.push({ id, flag: "DELETED_WITH_PAID_AMOUNT" });
    }

    plan.push({
      workspace_key: workspaceKey,
      booking_id: id,
      transaction_type: "legacy_opening_balance",
      payment_method: "other",
      direction: "in",
      amount_halalas: conv.halalas,
      currency: "SAR",
      status: "succeeded",
      occurred_at: typeof b.created_at === "string" && b.created_at ? b.created_at : null,
      idempotency_key: key,
      metadata: {
        source: "legacy_paid_field",
        booking_status: String(b.status || ""),
        booking_deleted: bookingIsDeleted(b),
        legacy_paid_riyals: paidNumber,
      },
    });
    report.planned += 1;
    report.total_planned_halalas += conv.halalas;
  }

  return { plan, report };
}

function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * Emit idempotent SQL for a plan. Every insert carries
 * ON CONFLICT (idempotency_key) DO NOTHING, so applying the file twice —
 * or applying it after a previous partial run — cannot duplicate rows.
 * The legacy booking.paid values in the workspace document are NOT touched.
 */
export function planToSql(plan) {
  const lines = [
    "-- Legacy paid-amount migration (generated by scripts/migrate-legacy-paid.mjs)",
    "-- Idempotent: re-running this file cannot create duplicate transactions.",
    "-- Does NOT modify the workspace document or delete any legacy value.",
    "begin;",
  ];
  for (const t of plan) {
    lines.push(
      "insert into public.payment_transactions" +
        " (workspace_key, booking_id, transaction_type, payment_method, direction," +
        " amount_halalas, currency, status, occurred_at, idempotency_key, metadata)" +
        " values (" +
        [
          sqlQuote(t.workspace_key),
          sqlQuote(t.booking_id),
          sqlQuote(t.transaction_type),
          sqlQuote(t.payment_method),
          sqlQuote(t.direction),
          String(t.amount_halalas),
          sqlQuote(t.currency),
          sqlQuote(t.status),
          t.occurred_at ? sqlQuote(t.occurred_at) + "::timestamptz" : "now()",
          sqlQuote(t.idempotency_key),
          sqlQuote(JSON.stringify(t.metadata)) + "::jsonb",
        ].join(", ") +
        ") on conflict (idempotency_key) do nothing;",
    );
  }
  lines.push("commit;");
  return lines.join("\n") + "\n";
}
