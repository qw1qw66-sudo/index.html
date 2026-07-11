# Supabase migrations — the single source of truth

This directory is what `supabase db push` applies, in filename order. It is the
**only** maintained migration set (the old `database/migrations/` copies were
relocated here with timestamped names — same SQL, same rollback comments).

**Nothing here has been applied to the production Supabase project by the
branches that introduced it.** Staging first, always.

## The chain (applied in this exact order)

1. `20260601000000_shared_workspace_baseline.sql` — the schema production
   already runs (shared_workspaces + v1 RPCs). Kept **byte-identical** to
   `database/shared_workspace_sync.sql` (the copy published with the app);
   a unit test enforces the equality so the two can never drift. On a fresh
   staging project this creates the baseline; on production it would be a
   no-op (`if not exists` guards), but production application stays a manual,
   owner-approved step regardless.
2. `20260701000001_atomic_workspace_save.sql` — concurrency + auth hardening
   (workspace_auth, atomic v2 save, PIN rate limiting; AUD-001/002/005/006).
3. `20260701000002_payment_ledger.sql` — payment ledger foundation
   (payment_orders/transactions/webhook_events/audit_log, derived totals,
   manual-payment/read/reconcile RPCs). Requires 0001's auth helper.
4. `20260711000003_chalet_assistant.sql` — Chalet Brain assistant tables
   (assistant_threads/messages/memory/actions, automation_rules/runs,
   outbound_messages) + atomic confirmation/memory RPCs, with composite
   `(workspace_key, id)` FKs. Requires the two files above.

## How they are applied

- **Staging:** the `Deploy Supabase Staging` GitHub Actions workflow
  (`workflow_dispatch` only) runs `supabase db push` against the staging
  project linked via repository secrets. See `.github/workflows/deploy-supabase-staging.yml`.
- **Production:** manual only, by the owner, in a maintenance window, after
  staging verification. Nothing in CI targets production.

Each file is transactional (`begin/commit`) and guarded (`if not exists`)
where possible; `supabase db push` records applied versions in
`supabase_migrations.schema_migrations`, so re-running the workflow is a no-op
for already-applied files.

## Compatibility guarantees

- Existing tables, RPCs (`get_shared_workspace`, `save_shared_workspace`) and
  data are **not dropped, altered destructively, or rewritten**. The deployed
  frontend keeps working before, during, and after applying these files.
- The frontend feature-detects the new functions and falls back to the old
  behavior when they are absent, so deploy order (Pages vs SQL) does not matter.

## ⚠️ Legacy SQL elsewhere in this repository — do NOT apply

These predate the current single-document architecture and were moved out of
this directory so the CLI can never apply them:

- `database/legacy-sql/001_security_constraints.sql` (normalized bookings/chalets model — obsolete)
- `database/legacy-sql/20260509_secure_cloud_sync.sql` (auth.users/user_data model — obsolete)
- `database/supabase-schema.sql`, `database/supabase_schema.sql` (identical duplicates — obsolete)
- `chalets-supabase-schema.sql` (legacy key/value model — obsolete)

## Rollback

Each migration file ends with a commented rollback section listing the exact
objects it created. Because the chain is purely additive, rollback is `drop`
of those objects and never touches `shared_workspaces` data. The payment
ledger tables contain financial history once used — back them up
(`pg_dump --table 'payment_*'`) before any rollback.
