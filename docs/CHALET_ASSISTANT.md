# Chalet Brain — DeepSeek assistant + vacancy autopilot

A small, safe, Arabic-first assistant for a personal chalet-booking app. It is
**not** a SaaS product, a coding agent, or a general orchestration framework.
It reuses the PR #73 booking/payment foundation — it adds **no** second ledger,
booking table, payment panel, conflict engine, or money parser.

Everything here is **prepared, not deployed**: the migration is not executed
against production, the Edge Functions are not deployed, and no customer
message is ever sent automatically.

## Architecture (memory is context; deterministic validators are authority)

```
Browser (المساعد الذكي tab)
   │  POST workspace_key + PIN + message   (never the DeepSeek key)
   ▼
chalet-assistant Edge Function ── handler.mjs (runtime-tested)
   │   1. workspace_auth (existing)         5. prepare = create action + hashed token
   │   2. active memory (context only)      6. confirm = atomic consume + run existing contract
   │   3. DeepSeek (server-side, redacted)   7. never claim success without a server result
   │   4. registry-only tool validation
   ▼
DeepSeek API (server-side, key in Supabase secrets)   Existing contracts:
                                                        save_shared_workspace_v2, record_manual_payment,
chalet-autopilot Edge Function (scheduled)             create-payment-session, get_booking_payments
   └── deterministic vacancy detection / eligibility / limits; DeepSeek drafts wording only
```

## Adapted concepts (from control-system work) — and what was NOT copied

Adapted: memory-is-context; check prior decisions/mistakes before planning;
check policy + current state immediately before execution; known tools only;
deterministic validators are final; no raw shell/SQL/arbitrary code; no
duplicated engines; every meaningful action produces a traceable result.

**Not** copied: Master Planner, multi-agent orchestration, merge gates, GitHub
agents, Telegram control, night builds, autonomous coding, self-evolution,
generic workflow engines, shell execution.

## DeepSeek integration

- **Model note (verified 2026-07-11):** `deepseek-chat` / `deepseek-reasoner`
  are **deprecated 2026-07-24**; current models are `deepseek-v4-flash` /
  `deepseek-v4-pro`; base URL `https://api.deepseek.com`; OpenAI-compatible
  chat completions with tool calling. The client does **not** hardcode an
  obsolete name — model and base URL are env-configurable; default is
  `deepseek-v4-flash`.
- The browser never calls DeepSeek and never holds the key.
- Fails **closed**: no key / no model → no call, clear Arabic error, no action.
- Redacts phone numbers before every call; enforces request timeout, size and
  history limits; response-size cap; never logs or returns the key or provider
  body; validates output as strict JSON — invalid output causes **no** action.

### Secrets (owner-held; set via `supabase secrets set`, never committed)

`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` (default `deepseek-v4-flash`),
`DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`),
`ASSISTANT_CONFIRM_SECRET` (HMAC for confirmation tokens),
and for official WhatsApp: `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_PHONE_ID`.

## Confirmation protocol (two-step, server-side)

`prepare_*` tools create an `assistant_actions` row and return a summary + a
one-time token to the **owner** (never to the model). `confirm_*` (invoked by
the owner's button, never by the model) calls the atomic SQL
`assistant_consume_confirmation`, which rejects an expired, reused, wrong-token,
changed-payload, stale-revision, or already-completed confirmation. Only then
does the existing contract run; success is reported **only** if that contract
returns success.

## Tool registry (single source; read vs sensitive)

Read tools (auto): today's bookings, list/detail, available periods, empty
dates, outstanding balances, payment history, recent payments, automation
status, campaign results, attributed revenue. Booking writes go **only**
through `save_shared_workspace_v2` (no AI fallback to v1 — on its absence the
assistant returns an Arabic "database needs update; nothing changed"). Payments
reuse `record_manual_payment` / `create-payment-session` / `get_booking_payments`.
Communication tools draft freely but sending/queueing requires confirmation.
Refunds are intentionally **not** exposed (no safe refund RPC yet) — the
assistant can explain a refund balance but never fakes or executes one.

## Vacancy autopilot (OFF by default)

`automation_rules` default `owner_approval_required=true`,
`automatic_send_enabled=false`. For each enabled rule the **deterministic**
code: finds empty eligible dates, derives a stable `vacancy_key`, prevents
duplicate runs, selects previous customers (valid phone, not opted out,
cooldown, daily cap, minimum price), re-checks the vacancy is still empty,
sends only minimal **non-phone** context to DeepSeek for drafting, then queues
for owner approval — or auto-sends **only** when the rule explicitly enables it
**and** official WhatsApp is healthy. A booked vacancy stops the campaign.

## WhatsApp adapter (three modes, one message object)

- `disconnected`: drafting/copy work; nothing is sent; UI says
  «واتساب التلقائي غير مربوط».
- `open_manual_whatsapp`: opens the existing safe `wa.me` link; recorded as
  `opened_manual` — **never** "sent".
- `official_cloud_api`: server-side credentials; "sent" only after a real API
  acknowledgement; delivery updated only from verified webhook events.

## Measurable benefit

`automation_runs` records empty periods detected, offers drafted/approved,
messages opened manually vs sent by official API, bookings attributed, and
attributed revenue. Attribution requires same vacancy + campaign contact +
within the window; uncertain matches are marked «محتمل», never confirmed. No
revenue is invented.

## Privacy

The full workspace document is never sent to DeepSeek; phone numbers are never
sent merely to draft wording and are never stored in `assistant_memory`.
Internal customer references (non-reversible hashes) are used; the delivery
layer resolves the real number server-side only when actually sending.

## Deploy (owner-only; staging first — NOT done here)

1. Apply `database/migrations/0003_chalet_assistant.sql` to staging (after 0001/0002).
2. `supabase functions deploy chalet-assistant chalet-autopilot` (staging).
3. `supabase secrets set DEEPSEEK_API_KEY=... ASSISTANT_CONFIRM_SECRET=... ...`.
4. Wire the autopilot to a schedule (pg_cron → edge). Keep automation disabled
   until you have tested drafts and, for auto-send, configured official WhatsApp.
5. `executeConfirmed` is **fully wired** (`_shared/assistant/executors.mjs`):
   confirmed booking create/update/cancel go through `save_shared_workspace_v2`,
   manual payments through `record_manual_payment`, payment links through the
   `create-payment-session` Edge Function, and messages through the WhatsApp
   adapter. The PIN is carried through the single HTTPS request only. Proven
   end-to-end against real PostgreSQL 16 (real `payment_transactions` rows,
   real bookings via v2, idempotent replay). Official WhatsApp *sending* is the
   only executor path still requiring owner credentials.

## What is test-only vs deployment work

- **Fully operational locally (proven against real PostgreSQL 16):** registry,
  policy/memory, confirmation protocol, the wired executors (booking
  create/update/cancel, manual payment, payment-link disabled-safe), vacancy/
  eligibility/attribution, WhatsApp disconnected+manual, DeepSeek client
  (fail-closed/redaction/limits), both handlers, the migration chain, the
  Arabic chat UI with the full confirm flow.
- **Requires Supabase deployment:** applying `0003` and deploying the two Edge
  Functions to a project (the logic is tested; the deploy is mechanical).
- **Requires a DeepSeek key:** a real model call (the client is done and
  fail-closed; an opt-in smoke test runs when `DEEPSEEK_API_KEY` is present).
- **Requires official WhatsApp credentials:** automatic sending (manual open
  works today).
- **Disabled by default:** all automation rules (`enabled=false`,
  `automatic_send_enabled=false`).
