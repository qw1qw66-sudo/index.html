-- 20260712000006_assistant_booking_drafts.sql
-- Server-owned per-thread booking DRAFT for the "Chalet Brain" assistant: the
-- slot-filling scratchpad the server keeps while the owner dictates a booking,
-- BEFORE anything reaches the two-step prepare/confirm card (assistant_actions).
--
-- Design rules enforced here (same rules as 0003):
--   - drafts are CONTEXT, not authority: a draft never creates a booking; only
--     the prepared+confirmed assistant_actions flow can write real data.
--   - customer PII stays out of model paths: `private` holds customer_phone
--     ONLY and is never returned to DeepSeek; `fields` holds the non-private
--     draft fields the model may see.
--   - at most ONE active draft per thread (partial unique index), so a thread
--     can never accumulate competing half-filled bookings.
--
-- ADDITIVE ONLY. No existing table, row, or function is touched.

begin;

-- ============================================================================
-- 1. assistant_booking_drafts (per-thread slot-filling state)
-- ============================================================================

create table if not exists public.assistant_booking_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  thread_id uuid not null,
  -- Non-private draft fields only (chalet, dates, price notes...). Safe to
  -- echo back into model context.
  fields jsonb not null default '{}'::jsonb,
  -- customer_phone ONLY; never returned to model paths. Read server-side at
  -- prepare time, then referenced — not copied — by the action payload.
  private jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  -- The prepared assistant_actions row, when the draft reached a card. Kept as
  -- a plain reference (no FK) so archiving/purging actions never blocks drafts.
  linked_action_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite FK: the draft's thread must belong to the SAME workspace, and a
  -- deleted thread takes its drafts with it (drafts carry no audit value).
  foreign key (workspace_key, thread_id)
    references public.assistant_threads(workspace_key, id) on delete cascade
);

-- At most one ACTIVE draft per thread; completed/cancelled history may pile up.
create unique index if not exists assistant_booking_drafts_one_active
  on public.assistant_booking_drafts (workspace_key, thread_id) where status = 'active';
create index if not exists assistant_booking_drafts_ws_idx
  on public.assistant_booking_drafts (workspace_key, updated_at desc);

comment on table public.assistant_booking_drafts is
  'Server-owned per-thread booking draft for the assistant: fields = non-private slot values, private = customer_phone only (never returned to model paths). Additive-only migration; no existing data touched.';

-- ============================================================================
-- 2. RLS + grants — no direct browser table access (RPC/service-role only)
-- ============================================================================

alter table public.assistant_booking_drafts enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'assistant_booking_drafts'
  ] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Reload PostgREST's schema cache (reverse-audit R-6 pattern).
notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- ROLLBACK (manual; additive objects only)
-- ============================================================================
-- drop table if exists public.assistant_booking_drafts cascade;
