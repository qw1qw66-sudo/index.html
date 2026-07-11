# Reverse Audit of PR #73

- **Scope:** independent, review-only verification of PR #73 (`claude/audit-payment-foundation-pe58nl`, head `ef71877`, base `836f68b`). Every claim below was re-checked against the **actual diff, committed files, SQL behavior on a live scratch PostgreSQL 16, test runs, and git history** — not against the PR description or the prior implementation report.
- **Method:** fresh diff read of all 27 files; re-application of the committed migrations to a clean database; adversarial SQL probes for cases the original test suite did not cover; independent reproduction of the claimed pre-existing failure at the exact `main` commit in an isolated worktree; secret scan across all six commit patches; per-file necessity assessment against the app's real usage profile (a personal chalet-booking app shared with a few trusted friends).
- **No code was modified in this run.** This document is the only change.

---

## 1. Verification of the six mandated attention points

### 1.1 Customer phone numbers in the public repository — **REAL, correctly not claimed as fixed, one additional surface unverified**

- Independently re-verified: `exports/bookings-2026.xlsx` as committed on `main` contains **2 distinct KSA phone-shaped values** (unzipped the workbook, regex over sheet XML). The repository is public (GitHub API `visibility: public`). The app itself links to the raw file.
- The PR **adds no new PII** (checked: no diff hunk introduces phone-shaped or name data beyond obviously fake test values), and honestly labels AUD-003 as an owner-level action rather than claiming a fix. Correct call: silently disabling the export cron would have broken a feature the app links to.
- **New concern found by this review:** Netlify builds this repo (deploy previews appear on PRs from a site named `helpful-gaufre-edf566`). If that site publishes the repo root — the default with no `netlify.toml`, and none exists — then `https://helpful-gaufre-edf566.netlify.app/exports/bookings-2026.xlsx` is a **second public PII surface** independent of GitHub, and deploy previews republish it per-PR. This could **not be verified from the review environment** (egress proxy blocks netlify.app — HTTP 000). **Owner: open that URL; if it serves the file, the AUD-003 remediation must include the Netlify site (set a publish directory or disconnect the site), not just the GitHub repo.**

### 1.2 Fallback to the old workspace-save RPC — **fallback itself is safe-by-equivalence; the real gap is that v1 stays exposed**

- The frontend prefers `save_shared_workspace_v2` and falls back to the legacy flow only when the RPC is absent (`isMissingRpc` = any HTTP 404). Pre-migration this reproduces today's behavior byte-for-byte (same pre-check, same v1 call) — no regression, no improvement, which is the honest best available before the owner applies `0001`.
- Verified nuance: a **network failure on the create-probe followed by a successful save can still wipe an existing workspace pre-migration** (tiny window; closed entirely once `0001` is applied because v1 gains the server-side empty-overwrite guard — verified live, see 1.3). The PR prose describes the fix as a client+server pair, which is accurate, but this residual pre-migration window deserves the explicit mention it gets here.
- Operational gap: neither migration ends with `notify pgrst, 'reload schema';`. Applied via `psql`, PostgREST may keep returning 404 for the new RPCs until its schema cache reloads — the frontend would **silently** stay on the weak v1 path while the owner believes the fix is live. One-line fix per migration file.

### 1.3 Does the JSON conflict validation truly prevent double booking? — **only for v2 callers; the PR overstates this**

Live probes against a clean database built from the committed files:

| Probe | Result |
|---|---|
| v2 save of a doc with two overlapping confirmed bookings | ✅ rejected `BOOKING_CONFLICT:<id1>:<id2>` (matches original smoke T9) |
| Same slot, one booking cancelled, via v2 | ✅ accepted (correct — matches frontend rules) |
| **Same conflicting doc via the legacy v1 `save_shared_workspace` after migrations applied** | ❌ **accepted — `ok=true`, both conflicting confirmed bookings landed in the cloud document** |
| v1 empty-doc overwrite of a non-empty workspace | ✅ blocked (`EMPTY_OVERWRITE_BLOCKED` — the guard 0001 adds to v1 works) |

Conclusion: the PR's claim that "two conflicting confirmed bookings can no longer both land in the cloud document" is **true only for clients using v2**. Any direct API caller, and any stale cached copy of the old frontend, still goes through v1 with no revision check and no conflict validation. For the stated usage (a few trusted friends on the new frontend) the practical risk is low — but the claim needs qualification, and a follow-up migration should either add the conflict check to v1 or revoke v1's execute grant once the new frontend is fully rolled out. Also inherent (and already documented in the PR): the validation trusts the submitted document's own period definitions and operates at whole-document granularity.

### 1.4 Are the payment RPCs securely isolated by workspace? — **yes, verified live**

- Foreign-workspace read probe: valid credentials for workspace B requesting workspace A's booking → `ok:true` with an **empty transaction list and null booking total** — no data leak, and usefully, no existence oracle either. (Semantic nit: `ok:true` with zeros for a booking that isn't yours is odd but harmless.)
- Foreign-workspace write probe: manual payment against another workspace's booking id → `BOOKING_NOT_FOUND`. ✅
- Structure: all four payment tables revoked from `public/anon/authenticated`, RLS enabled, access only via `SECURITY DEFINER` functions with pinned `search_path`, FKs to `shared_workspaces`, and every RPC begins with the bcrypt PIN check. ✅
- A concern the original tests never covered was also probed: `get_booking_payments` is declared `STABLE` yet its auth path writes throttle rows. Tested live with a wrong PIN — returns a clean `{ok:false}` **and** records the throttle failure; no runtime error. Not a bug.
- Trade-off worth stating plainly: the throttle means anyone who knows a workspace *key* can lock its owner out for 15 minutes with 20 junk PINs (deliberate DoS). Acceptable against the brute-force alternative at this app's threat level, but it is a real property of the design.

### 1.5 Can the test provider ever be enabled outside tests? — **not accidentally; the "production" guard is weaker than the README implies**

- Enabling it requires **all** of: the Edge Functions actually deployed (they are not), `PAYMENT_PROVIDER=test`, `PAYMENTS_ALLOW_TEST_PROVIDER=true`, and `PAYMENT_WEBHOOK_SECRET` set — three deliberate configuration acts plus a deploy. Accidental enablement is implausible.
- **However**, the "refuses production runtimes" check is a *denylist* (`DENO_ENV`/`NODE_ENV === "production"`) on variables **Supabase does not set automatically** — so on a real project where the owner sets the three variables, nothing distinguishes production from staging. The guard should be an *allowlist* (require `DENO_ENV` ∈ {`test`,`staging`} explicitly) and the README wording softened.
- Blast radius if misused: the adapter cannot move money (in-memory sessions, RFC-2606 `.invalid` URLs verified in code and tests); the harm is fake "paid" states in the ledger by someone holding the owner-set webhook secret. Moderate, not monetary.

### 1.6 Are all 27 changed files necessary? — **~70% yes for the mandate; ~900 lines are ahead of actual need**

| Group | Files / lines | Necessity for THIS app |
|---|---|---|
| Audit + gate | `docs/AUDIT_PAYMENT_READINESS.md` (324) | Yes — the findings are real and actionable |
| Concurrency/auth fix | `0001_…sql` (624) + `index.html` guard portions + `database/migrations/README.md` | **Yes — highest-value content in the PR**, fixes real data-loss paths |
| Frontend safety (probe, v2-preference, beforeunload) | part of `index.html` (+655 total) | Yes |
| Payment ledger + manual payments | `0002_…sql` (767), payment panel in `index.html`, ledger/legacy docs, migration tool (93) | Yes **if** the owner wants payment tracking — manual cash/transfer recording is the realistic feature for trusted-friends usage |
| e2e repair + mock realism | `e2e/app.spec.js` (+72/−3) | Yes — the suite was red on `main`; no assertions removed (verified: zero deleted `expect` lines) |
| Unit tests + helpers | 10 files (~1,475) | Proportionate to what they pin; the in-memory store mirrors constraints that were separately verified on real Postgres |
| **Edge Functions + provider abstraction** | `create-payment-session/index.ts` (166), `payment-webhook/index.ts` (166), `providers/*` (184), functions README (62) | **Built ahead of need.** No provider is chosen; these two `.ts` files have **never been executed by any runtime** (no Deno in the dev environment — only their extracted pure core is tested). They are inert and harmless, but for a personal app they could have been deferred until a provider decision exists |
| `.gitignore` (+3) | trivial | Yes |

Overengineering verdict: **moderate**. The original task mandate explicitly ordered the provider abstraction and Edge Functions, so the PR is compliant-but-heavy rather than gratuitous. Measured against the app's real profile, the provider/webhook layer (~580 source lines + ~380 test-harness lines) is speculative. It costs nothing at runtime (undeployed) but adds review surface and maintenance weight.

---

## 2. Verification of claimed P0 issues and fixes

| Claim | Verdict | Evidence |
|---|---|---|
| AUD-001 create-wipe exists on `main` | **Confirmed** | `main`'s `createWorkspace()` sends an empty doc through upsert `save_shared_workspace`; SQL update branch overwrites `data` on PIN match |
| AUD-001 fix works | **Confirmed, with residual pre-migration window** (§1.2) | Probe-then-open covered by e2e; create-only RPC rejects duplicates (smoke T2); v1 empty-overwrite guard verified live in this review |
| AUD-002 TOCTOU exists on `main` | **Confirmed** | Two separate RPCs; no revision parameter in v1 |
| AUD-002 fix works | **Confirmed for v2 callers** | STALE_REVISION verified in smoke + re-verified logic in unit tests; **v1 bypass remains** (§1.3) |
| AUD-003 public PII | **Confirmed** (§1.1) | 2 phone-shaped values in committed workbook; repo public; possible second Netlify surface unverified |
| AUD-004 no payment record on `main` | **Confirmed** | `paid` is a plain JSON float; one-tap `markPaymentComplete` |
| AUD-004 fix (immutable ledger) | **Confirmed** | Immutability triggers verified live (UPDATE/DELETE raise); `booking.paid` untouched by ledger writes; write-back strictly opt-in |
| AUD-005 double booking on `main` | **Confirmed** | Browser-only check; whole-doc overwrite arbitration |
| AUD-005 mitigation | **Partially as claimed** — v2-only (§1.3); PR prose overstates | Live probe B |
| AUD-010 e2e fails on `main` | **Independently reproduced** in a clean worktree at `836f68b`: timeout at `e2e/app.spec.js:147` | This review, not inherited from the prior report |
| "94 unit + 8 e2e passing" | **Confirmed** on head `ef71877`: local runs + CI job log shows the full pipeline (lint → build → vitest → Playwright `8 passed`) | CI job 86512283764 |
| "No secrets committed" | **Confirmed** | Pattern scan across all six commit patches; only matches are the scanner's own pattern list in the test file |
| "No booking data touched" | **Confirmed** | `normalizeData`/`saveBooking`/`softDelete*`/`voucherText` absent from the diff; only `createWorkspace`/`uploadChanges` bodies replaced; no existing file deleted |
| "Migrations validated on real Postgres" | **Re-confirmed independently** | This review rebuilt a clean DB from the committed files before probing |

## 3. Additional findings from this review (not in the PR)

| ID | Sev | Finding |
|---|---|---|
| R-1 | P2 | `backupBeforePush()` now runs before every upload attempt, including ones that fail the revision check; ten identical retry backups can evict older, *different* backups from the 10-slot ring. Small fix: back up only when proceeding, or skip when the doc hash equals the newest backup |
| R-2 | P2 | Throttle lockout DoS by key-knowers (§1.4) — accept and document, or scope the counter to key+IP at an edge layer later |
| R-3 | P2 | Pre-migration, every booking-edit open fires one guaranteed-404 `get_booking_payments` call (harmless; could cache the miss per session) |
| R-4 | Info | Riyal→halala conversion exists twice (inline `index.html` + `ledger-core.mjs`) with a sync-note comment; tests pin both, but it is still duplication |
| R-5 | Info | Commit `ef71877` shows the first push omitted a staged file (caught by CI, fixed within minutes). Process note only; the final tree is consistent and CI-green |
| R-6 | P2 | Missing `notify pgrst, 'reload schema'` in both migrations (§1.2) |
| R-7 | Info | The two Edge Function `.ts` files are unexecuted-by-any-runtime code (§1.6) and must be treated as untested I/O shells until staging runs them |

## 4. What a "small fixes" follow-up should contain (all bounded, no rework)

1. Qualify the double-booking claim in `docs/AUDIT_PAYMENT_READINESS.md` / PR text (v2-only), and add a planned `0003` that hardens or retires v1 after frontend rollout.
2. Add `notify pgrst, 'reload schema';` before `commit;` in both migrations.
3. Flip the test-provider guard to an environment allowlist; reword the functions README ("refuses production" → "requires explicit non-production env + opt-in flag").
4. Move `backupBeforePush()` after the revision decision (or hash-dedupe).
5. Owner: test the Netlify URL in §1.1 and fold the result into the AUD-003 remediation.

None of these change data shapes, external behavior for current users, or the inert status of the payment stack.

---

## VERDICT: **APPROVE WITH SMALL FIXES**

The audit's findings are real (each P0 re-verified against `main` from scratch), the fixes do what they say for clients on the new path, everything financial is inert until deliberate owner action, no secrets or PII were added, no existing behavior regressed (pre-migration fallbacks reproduce today's semantics exactly), and the tests genuinely pin the claimed properties — including a pre-existing `main` failure this branch surfaced rather than masked. The defects found by this reverse audit (§3, §4) are prose overstatements and small hardening items, not structural flaws.

The one legitimate hesitation is size: ~900 lines of provider/webhook machinery serve a future that a trusted-friends app may never reach. If the owner prefers a minimal merge, an acceptable alternative is splitting the PR (merge audit + migration 0001 + `index.html` guards + e2e repair now; hold 0002/functions/panel until a payment decision exists) — but given that the deferred parts are demonstrably inert and tested, the split's re-review cost outweighs its benefit. Hence: approve, then land the five small fixes above in a follow-up before any migration is applied.

*Review-only run: no application code, SQL, tests, or workflows were modified; nothing was merged, deployed, or executed against production.*
