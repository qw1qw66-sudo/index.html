# Database migrations (prepared — NOT executed against production)

These files are **additive** migrations for the Supabase project backing the
chalet booking app. They have been validated against a scratch PostgreSQL 16
instance in CI/dev only. **Nothing in this directory has been applied to the
production Supabase project by the branch that introduced it.**

## Apply order (manual, by the project owner, staging first)

1. `0001_atomic_workspace_save.sql` — concurrency + auth hardening
   (fixes audit findings AUD-001, AUD-002, AUD-005 server-side; adds
   practical PIN rate limiting for the new RPC surface, AUD-006).
2. `0002_payment_ledger.sql` — payment ledger foundation
   (payment_orders, payment_transactions, payment_webhook_events,
   payment_audit_log, derived totals, manual-payment/read/reconcile RPCs).
   Requires 0001 (uses its auth helper).

Apply with the Supabase SQL editor or `psql` against a **staging** project
first, run the app + tests against staging, then apply to production in a
maintenance window. Each file is transactional (`begin/commit`) and idempotent
where possible (`if not exists` guards), but they are still one-way migrations:
review before running.

## Compatibility guarantees

- Existing tables, RPCs (`get_shared_workspace`, `save_shared_workspace`) and
  data are **not dropped, altered destructively, or rewritten**. The deployed
  frontend keeps working before, during, and after applying these files.
- The frontend on this branch feature-detects the new functions and falls back
  to the old behavior when they are absent, so deploy order (Pages vs SQL)
  does not matter.

## ⚠️ Legacy SQL elsewhere in this repository — do NOT apply

The following files predate the current single-document architecture and
target tables that do not exist in production. Applying them would create
orphan tables at best and mislead future migrations at worst:

- `supabase/migrations/001_security_constraints.sql` (normalized bookings/chalets model — obsolete)
- `supabase/migrations/20260509_secure_cloud_sync.sql` (auth.users/user_data model — obsolete)
- `database/supabase-schema.sql`, `database/supabase_schema.sql` (identical duplicates — obsolete)
- `chalets-supabase-schema.sql` (legacy key/value model — obsolete)

The only SQL matching production today is `database/shared_workspace_sync.sql`.

## Rollback

Each migration file ends with a commented rollback section listing the exact
objects it created. Because both migrations are purely additive, rollback is
`drop` of those objects and never touches `shared_workspaces` data. The
payment ledger tables contain financial history once used — back them up
(`pg_dump --table 'payment_*'`) before any rollback.
