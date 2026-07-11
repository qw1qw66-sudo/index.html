#!/usr/bin/env node
// migrate-legacy-paid.mjs — plan the migration of legacy booking.paid values
// into legacy_opening_balance ledger transactions.
//
// SAFE BY DEFAULT:
//   - DRY-RUN is the default and only mode that touches nothing.
//   - This tool NEVER connects to any database or network. With
//     --sql-out it writes an idempotent SQL file for HUMAN REVIEW; applying
//     that file (staging first!) is a separate, deliberate owner action.
//   - The legacy paid values inside the workspace document are never
//     modified or deleted.
//   - Deterministic idempotency keys (legacy:<workspace>:<booking_id>) +
//     ON CONFLICT DO NOTHING make repeated runs duplicate-free.
//
// Usage:
//   node scripts/migrate-legacy-paid.mjs --input workspace.json --workspace-key ALI6
//   node scripts/migrate-legacy-paid.mjs --input workspace.json --workspace-key ALI6 \
//        --sql-out migrate-ALI6.sql [--include-deleted] [--existing-keys keys.txt]
//
//   --input          workspace JSON: either the raw document or the
//                    get_shared_workspace RPC response ({ ok, data: {...} }).
//                    Obtain it with scripts/fetch_supabase_workspace.py
//                    (uses env credentials; see docs/LEGACY_PAYMENT_MIGRATION.md).
//   --workspace-key  the workspace the bookings belong to (required).
//   --sql-out        write reviewable idempotent SQL (still not applied!).
//   --existing-keys  optional file with one idempotency_key per line
//                    (export from payment_transactions) so the report can
//                    show what a re-run would skip.
//   --include-deleted  also migrate soft-deleted bookings with paid > 0.

import { readFileSync, writeFileSync } from "node:fs";
import { planLegacyMigration, planToSql } from "../supabase/functions/_shared/legacy-migration-core.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function has(name) {
  return process.argv.includes(name);
}

const inputPath = arg("--input");
const workspaceKey = arg("--workspace-key");
const sqlOut = arg("--sql-out");
const existingKeysPath = arg("--existing-keys");
const includeDeleted = has("--include-deleted");

if (!inputPath || !workspaceKey) {
  console.error("Usage: node scripts/migrate-legacy-paid.mjs --input <workspace.json> --workspace-key <KEY> [--sql-out out.sql] [--existing-keys keys.txt] [--include-deleted]");
  process.exit(2);
}

let workspaceDoc;
try {
  workspaceDoc = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (e) {
  console.error(`ERROR: cannot read/parse ${inputPath}: ${e.message}`);
  process.exit(1);
}

const existingIdempotencyKeys = new Set();
if (existingKeysPath) {
  try {
    for (const line of readFileSync(existingKeysPath, "utf8").split("\n")) {
      const k = line.trim();
      if (k) existingIdempotencyKeys.add(k);
    }
  } catch (e) {
    console.error(`ERROR: cannot read ${existingKeysPath}: ${e.message}`);
    process.exit(1);
  }
}

const { plan, report } = planLegacyMigration({
  workspaceKey,
  workspaceDoc,
  existingIdempotencyKeys,
  includeDeleted,
});

console.log(JSON.stringify({ mode: sqlOut ? "plan+sql" : "dry-run", report }, null, 2));

if (report.errors.length > 0) {
  console.error("Plan finished with errors — no SQL written.");
  process.exit(1);
}

if (sqlOut) {
  writeFileSync(sqlOut, planToSql(plan), "utf8");
  console.log(`\nWrote ${plan.length} idempotent insert(s) to ${sqlOut}`);
  console.log("REVIEW the file, apply to STAGING first, verify totals, then decide about production.");
  console.log("This tool did NOT apply anything to any database.");
}
