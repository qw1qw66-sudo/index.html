# Legacy Payment Migration Plan

Existing bookings carry a non-zero `paid` value inside the workspace JSON
document with **no transaction history** (audit AUD-004). This plan converts
each such value into exactly one immutable `legacy_opening_balance`
transaction in the payment ledger — without deleting or modifying the legacy
value, and safely re-runnable any number of times.

## What the migration does — and does not do

| Does | Does not |
|---|---|
| Read bookings from the workspace **JSON document** (there is no relational booking table — verified in the audit) | Assume any `bookings` table exists |
| Create one `legacy_opening_balance` ledger row per eligible booking | Modify, delete, or rewrite `booking.paid` or any other document field |
| Use the deterministic key `legacy:<workspace_key>:<booking_id>` | Create duplicates on re-run (unique `idempotency_key` + `ON CONFLICT DO NOTHING`) |
| Run in **dry-run mode by default** | Touch any database or network from the planning tool |
| Report every decision (see below) | Auto-apply anything to production |

## Eligibility rules (deterministic)

Per booking in `data->bookings`:

1. missing/duplicate `id` → **invalid** (reported, skipped);
2. `paid` missing / not numeric / negative → **invalid** (reported, skipped);
3. `paid = 0` → **skipped_zero_paid** (nothing to migrate);
4. `paid` with sub-halala precision (e.g. `12.345`) → **ambiguous** (reported,
   skipped — a human must decide the true amount);
5. soft-deleted booking with `paid > 0` → **skipped_deleted** by default
   (reported; `--include-deleted` migrates them too — owner decision);
6. cancelled booking with `paid > 0` → migrated **and flagged**
   (`CANCELLED_WITH_PAID_AMOUNT`) — money was physically received and may
   need a refund decision;
7. otherwise → **planned**: one transaction of
   `riyals × 100` halalas, `occurred_at` = the booking's `created_at`
   (falls back to migration time), metadata records the source and the
   original riyal value.

The report contains: bookings inspected, eligible, planned,
already-migrated, total planned halalas, skipped (zero-paid / deleted),
invalid ids, ambiguous values, flags, and errors — the exact fields required
for sign-off.

## How to run (owner)

```sh
# 1. Export the workspace document using the existing read-only path
#    (workspace key + PIN via environment variables — never hardcoded):
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
EXPORT_WORKSPACE_KEY=... EXPORT_ACCESS_PIN=... \
python scripts/fetch_supabase_workspace.py --output workspace.json

# 2. DRY-RUN (default; prints the report, changes nothing):
node scripts/migrate-legacy-paid.mjs --input workspace.json --workspace-key <KEY>

# 3. When the report looks right, emit reviewable idempotent SQL:
node scripts/migrate-legacy-paid.mjs --input workspace.json --workspace-key <KEY> \
  --sql-out migrate-legacy-<KEY>.sql

# 4. REVIEW the SQL. Apply to the STAGING project first (psql / SQL editor).
#    Verify: select count(*), sum(amount_halalas) from payment_transactions
#            where transaction_type = 'legacy_opening_balance';
#    against the report's planned/total numbers.

# 5. Re-run steps 1–4 (safe: re-runs cannot duplicate) and only then apply
#    the reviewed SQL to production in a maintenance window.
```

To make the report aware of an existing ledger (what a re-run would skip):

```sh
# psql -c "copy (select idempotency_key from payment_transactions where
#          transaction_type='legacy_opening_balance') to stdout" > keys.txt
node scripts/migrate-legacy-paid.mjs --input workspace.json --workspace-key <KEY> \
  --existing-keys keys.txt
```

## Idempotency proof points

- Deterministic migration key per booking: `legacy:<workspace>:<booking_id>`.
- `payment_transactions.idempotency_key` is UNIQUE (migration `0002`).
- Emitted SQL uses `ON CONFLICT (idempotency_key) DO NOTHING`.
- Verified in the SQL smoke suite (T32: double insert → one row) and in the
  vitest suite (repeated planning + repeated SQL application scenarios).

## After migration

- The app keeps displaying `booking.paid` as before — **the value is not
  deleted**. The payment panel shows ledger-derived totals; for migrated
  bookings the two agree by construction (`legacy_opening_balance` = the
  paid value at migration time).
- Payments recorded after migration go through the ledger, so `paid` slowly
  becomes stale on old devices; the optional `reconcile_booking_payment(...,
  p_write_back := true)` RPC can refresh it explicitly during the transition.
- Divergence detection: bookings where `paid × 100 ≠ net_paid_halalas` are
  surfaced by the payment panel as "بحاجة لتسوية" (needs reconciliation)
  rather than silently trusting either side.

## Rollback

Ledger rows are immutable by design; "rolling back" the migration means the
owner deletes rows `where transaction_type = 'legacy_opening_balance'` with
superuser rights after `pg_dump`-ing the table (the immutability trigger
blocks deletes for normal roles — this is intentional friction). Because the
legacy `paid` values were never modified, the app's displayed state is
unaffected by adding or removing these rows.

## §6 Long-term direction (out of scope here)

The stepping-stone order for eventually normalizing bookings:
1. ledger tables (this branch) — payments stop depending on the document;
2. atomic document saves (this branch, migration 0001);
3. per-booking rows *derived* from the document (read model, no writes);
4. dual-write bookings to rows + document behind a feature flag;
5. flip reads to rows; enforce GiST no-overlap constraint; document becomes
   an export format.
Each step needs its own review and owner approval.
