# Root-cause analysis & prevention path

> الغرض (بالعربية): تحقيق في **لماذا** حدث كل صنف من الأخطاء التي ظهرت في التدقيق
> والصور، ثم **المسار الدائم** الذي يمنع رجوعها. لكل خطأ: السبب الجذري، الإصلاح،
> والبوّابة الثابتة التي تكشف أي انحدار مستقبلًا تلقائيًا.

This document exists because the same *classes* of defect kept recurring: an
assistant that misread a request, a screen that repeated itself, money that read
differently from two places, and a document that could be corrupted below the
layer we were validating. Fixing each instance is not enough — each class needs a
**permanent gate** so a regression is caught by CI or the deploy smoke, never by
the owner in production.

The rule for every guard below: on a **live** database it must **grandfather**
existing data and **fail open** on anything it cannot compute, so a guard can
never lock the owner out of saving.

---

## 1. The assistant misread «أقرب حجز متاح» as a customer-name search (IMG_6744)

- **Symptom:** «شنو اقرب حجز متاح و اي شالية» answered «لم أجد حجوزات مطابقة لبحثك».
- **Root cause:** the deterministic intent chain is a hand-ordered list of Arabic
  regexes. The word «حجز» (booking) matched the *booking-by-name* search branch
  **before** any availability branch existed, so an availability question was
  routed to a name lookup that found nothing.
- **Fix:** a dedicated availability intent placed **before** the by-name branch,
  plus a guard so «متاح/فاضي/متوفّر» can never be captured as a customer name
  (`handler.mjs`).
- **Permanent gate:** `tests/assistant/a-availability-intent.test.js` (a corpus of
  the real failing phrases, asserted `model_calls=0`) + staging smoke **10l**
  (`availability_not_read_as_search`) runs the exact IMG_6744 phrase live.

## 2. The same empty slot rendered three times (IMG_6745)

- **Symptom:** `find_empty_dates` listed one opening 3×; a duplicated booking also
  showed twice.
- **Root cause:** the read/render path did not de-duplicate. Distinct rows that
  mapped to the same physical (chalet, date, period) slot each produced a line.
- **Fix:** de-dup by `period_id` in `find_empty_dates` (keeps genuinely distinct
  same-time price tiers) and by booking `id` in `nonDeletedBookingRows` /
  `outstandingFromLedger`.
- **Permanent gate:** staging smoke **10m** (`empty_slots_deduped`) asserts no
  duplicate (chalet, date, period) tuple is ever returned.

## 3. The assistant "forgot" the most recent messages

- **Symptom:** it repeated questions the owner had just answered.
- **Root cause:** `loadHistory` ordered `created_at ASC` and `limit(20)` — it
  fetched the **oldest** 20 messages of a thread, so in any conversation longer
  than 20 turns the model never saw the recent ones.
- **Fix:** fetch the **newest** 20 (`order desc, limit 20`) then reverse to
  chronological order before injecting (`index.ts`).
- **Permanent gate:** the ordering is documented at the call site; the real-model
  smoke exercises multi-turn context so a re-introduction of the bug surfaces
  there.

## 4. Outstanding balance could read differently from two money sources

- **Symptom (latent):** a booking paid via the **form** (`booking.paid`, whole
  riyals) vs. the **ledger** (halalas) could disagree, risking over-collection.
- **Root cause:** two sources of truth for "how much is paid" with no
  reconciliation on the read path.
- **Fix:** `effectiveNetPaidHalalas(ledgerNet, docPaidRiyals) =
  max(ledgerNet, round(paid×100))` — the ledger and the form-tracked amount are
  reconciled to whichever is greater (`_shared/ledger-core.mjs`).
- **Permanent gate:** `tests/payments/*` unit coverage + staging smoke **10j**
  (a seeded partially-paid booking asserts `owes 300`, not the raw form value).

## 5. A direct RPC client could corrupt the document (duplicate booking id)

- **Symptom / risk:** the browser always writes an id-keyed document, but a client
  holding the PIN could `save_shared_workspace*` a document with the **same
  booking id on two active rows** — the corruption behind the «حجزان مكرران»
  duplicate and (when the rows shared an id) the repeated empty slot.
- **Root cause:** the save RPCs validated auth, revision, booking-slot conflicts
  and the empty-overwrite wipe — but **not the structural integrity** of the
  document. Validation lived on the *assistant* path, not on the *raw save* path.
- **Fix:** migration `20260712000010` — a **grandfathered** structural guard in
  `save_shared_workspace_v2` and `v1`: a booking id that is duplicated **new** to
  the locked OLD document is rejected; a pre-existing duplicate is grandfathered;
  it fails open on null / non-array / id-less rows and ignores soft-deleted
  tombstones. Functions only — no data row is touched.
- **Permanent gate:** `tests/payments/sql-contracts.test.js` (clause pins) +
  `tests/assistant/integration-postgres.test.js` (rejects a new dup, grandfathers
  an existing one, reuses a tombstoned id — on a **real** Postgres) + staging
  smoke **10n** (`structural_duplicate_id_rejected`) proves the deployed guard
  rejects the corruption live with **zero writes**.

## 6. SQL regressions were only caught at deploy time, against live staging

- **Root cause:** `tests/assistant/integration-postgres.test.js` runs the real
  save/ledger/guard RPCs against a real Postgres, but **skipped** in CI because the
  default runner has no database. So a broken migration would pass `qa` and only
  fail when applied to live staging.
- **Fix:** a dedicated **`sql-integration`** job in `.github/workflows/qa.yml`
  spins up an ephemeral Postgres 16, and the suite self-provisions the Supabase
  roles it needs. `ASSIST_PG_REQUIRED=1` turns an unreachable database into a hard
  failure so the job can never *false-green* by skipping.
- **Permanent gate:** every PR now runs the full SQL contract suite against a real
  database before merge — the exact class of regression that used to reach staging
  is now caught on the PR.

## 7. The model was pinned to Flash in places instead of Pro

- **Root cause:** the model id lived in several places (the in-app setup template
  the owner copies, `.env.example`, docs, and a manually-set Supabase secret). One
  copy still said `deepseek-v4-flash`, silently capping intelligence.
- **Fix:** `deepseek-v4-pro` across the setup template, `.env.example`, docs and
  frontend; the deploy workflow **re-asserts** `DEEPSEEK_MODEL=deepseek-v4-pro` on
  every run so a manual override cannot drift it back.
- **Permanent gate:** `tests/setup/frontend-setup.test.js` pins the template to
  `deepseek-v4-pro`; the deploy step re-sets it every deploy.

---

## The prevention path (durable invariants)

These are the standing rules that keep the classes above from recurring:

1. **Deterministic assistant corpus.** Every intent fix ships with the real
   failing phrase as a `model_calls=0` test (red before, green after). The router
   is regression-tested against hundreds of real owner phrasings.
2. **No-duplicate-output smoke.** The live smoke asserts the assistant never
   returns a duplicated slot/row and never misroutes an availability question.
3. **Structural server invariants.** Data-shape guarantees (booking-slot
   conflict, night-anchor, structural duplicate-id, empty-overwrite) live in the
   save RPCs as grandfathered, fail-open guards — enforced for *every* writer,
   not just the browser.
4. **Real-Postgres CI.** The SQL contract suite runs against a real database on
   every PR (`sql-integration`), so migration regressions are caught pre-merge.
5. **Deploy discipline.** Server/SQL changes deploy only behind the `[deploy]`
   marker; a normal merge never silently runs a migration. Every `[deploy]` merge
   is verified green at the **job** level, including the live smoke.
6. **Adversarial review before server merges.** Any change to a save/ledger RPC
   on the live database gets an independent adversarial review focused on "how
   could this block a legitimate save, throw, or mutate data" before it merges.
7. **Grandfather + fail-open, always.** On a live database a guard rejects only
   what is *new*, grandfathers existing data, and fails open on anything it cannot
   compute — so it can never lock the owner out.

## Owner-action items (cannot be done from code alone)

These strengthen privacy/robustness but require the owner's decision or access:

- **Make the repository private** — the strongest privacy fix; cuts public access
  to all history immediately.
- **Purge phone numbers from git history** — a destructive history rewrite; done
  only with explicit permission (or by the owner).
- **Separate the production Supabase project from staging** — infra + secrets.
- **Accounts/roles instead of a shared PIN** — removes the shared-secret risk.
- **Enable a real payment provider / official WhatsApp / Autopilot scheduling**
  only if those channels should go live (today they are intentionally disabled).
