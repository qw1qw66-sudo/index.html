# Supabase Edge Functions — payment foundation (PREPARED, NOT DEPLOYED)

Nothing in this directory is deployed by the branch that introduced it.
Real payments are **not operational**: no real provider adapter exists, no
provider credentials exist anywhere in this repository, and the only adapter
implementation is a test fake that cannot move money (see
`_shared/providers/test-adapter.mjs`).

## Layout

| Path | Role |
|---|---|
| `create-payment-session/` | Creates a payment order + provider checkout link, server-side validated (Edge Function) |
| `payment-webhook/` | Verifies, records, deduplicates, and processes provider webhook events (Edge Function) |
| `_shared/ledger-core.mjs` | Pure decision logic (amount parsing, totals, payment-state derivation, webhook action planning) — unit-tested from `tests/payments/` with Node/vitest |
| `_shared/providers/index.mjs` | Provider adapter factory + production guards |
| `_shared/providers/test-adapter.mjs` | TEST-ONLY fake provider (HMAC-signed fake events, `.invalid` URLs) |

`record-manual-payment`, `get-booking-payments`, and
`reconcile-booking-payment` are implemented as SQL RPCs in
`database/migrations/0002_payment_ledger.sql` (same RPC-only access model as
the existing app) rather than as Edge Functions — the browser calls them via
`/rest/v1/rpc/...` exactly like `get_shared_workspace` today.

## Deployment (owner-only, staging first — do NOT run against production casually)

```sh
# 1. Apply database/migrations/0001 + 0002 to the STAGING project first.
# 2. Deploy functions to staging:
supabase functions deploy create-payment-session --project-ref <staging-ref>
supabase functions deploy payment-webhook --project-ref <staging-ref>

# 3. Configure secrets (values are owner-held; never commit them):
supabase secrets set --project-ref <staging-ref> \
  PAYMENT_PROVIDER=test \
  PAYMENTS_ALLOW_TEST_PROVIDER=true \
  PAYMENT_WEBHOOK_SECRET=<throwaway-staging-value> \
  PAYMENTS_ALLOW_PARTIAL=true

# 4. Exercise the flows in staging, then repeat with a REAL provider's
#    SANDBOX credentials and that provider's adapter implementation.
#    Only after the sandbox webhook matrix passes may production be considered.
```

Required env for a real provider (names only — see `_shared/providers/index.mjs`):
`PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_API_BASE`, `PAYMENT_PROVIDER_SECRET_KEY`,
`PAYMENT_PROVIDER_PUBLISHABLE_KEY`, `PAYMENT_WEBHOOK_SECRET`,
`PAYMENTS_ALLOW_PARTIAL`.

## Safety properties

- The test provider refuses to start when `NODE_ENV`/`DENO_ENV` is
  `production` or when `PAYMENTS_ALLOW_TEST_PROVIDER` is not `"true"`.
- Webhook processing: signature verification precedes everything; raw events
  are stored before business logic; duplicates are acknowledged and skipped;
  the same provider transaction can never be recorded twice (DB unique
  index); out-of-order anomalies are flagged for review, never guessed.
- Ledger rows are immutable at the database level (trigger-enforced) — a bug
  in these functions cannot rewrite financial history.
- The service-role key is platform-injected (`SUPABASE_SERVICE_ROLE_KEY`)
  and exists only inside the Edge runtime; it appears nowhere in this repo
  and is never returned to browsers.
