-- 0003_chalet_assistant.sql
-- Minimal data model for the DeepSeek-powered "Chalet Brain" assistant.
-- Requires 0001 (workspace_auth) and 0002 (payment ledger).
--
-- Design rules enforced here:
--   - memory is CONTEXT, not authority: it never grants a DB permission; a
--     model-proposed memory starts 'proposed' and only an explicit owner
--     action promotes it to 'active'.
--   - the ledger/booking document remain the source of truth; this migration
--     copies NO financial amounts and NO customer phone numbers into AI tables.
--   - every sensitive AI action is a two-step prepare/confirm with a hashed,
--     one-time, workspace+payload+revision-bound confirmation token.
--
-- ADDITIVE ONLY. PREPARED, NOT EXECUTED against production by this branch.

begin;

create extension if not exists pgcrypto with schema public;

-- ============================================================================
-- 1. assistant_threads / assistant_messages (conversation)
-- ============================================================================

create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  title text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for composite (workspace_key, id) foreign keys so children can never
  -- reference a thread that belongs to a DIFFERENT workspace.
  unique (workspace_key, id)
);
create index if not exists assistant_threads_ws_idx on public.assistant_threads (workspace_key, updated_at desc);

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  thread_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  -- safe_content: redacted text only (no phone numbers / PINs / secrets).
  safe_content text not null default '',
  tool_name text,
  tool_result_reference text,
  created_at timestamptz not null default now(),
  -- Composite FK: the message's thread must belong to the SAME workspace.
  foreign key (workspace_key, thread_id)
    references public.assistant_threads(workspace_key, id) on delete cascade
);
create index if not exists assistant_messages_thread_idx on public.assistant_messages (thread_id, created_at);

-- ============================================================================
-- 2. assistant_memory (context, not authority)
-- ============================================================================

create table if not exists public.assistant_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  memory_type text not null check (memory_type in ('fact', 'preference', 'decision', 'policy', 'mistake', 'lesson')),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'superseded', 'expired', 'rejected')),
  content_json jsonb not null default '{}'::jsonb,
  source_type text not null default 'model',
  source_reference text,
  evidence_json jsonb not null default '{}'::jsonb,
  enforcement_level text not null default 'advisory'
    check (enforcement_level in ('advisory', 'warning', 'requires_confirmation', 'hard_block')),
  effective_at timestamptz,
  expires_at timestamptz,
  last_verified_at timestamptz,
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_key, id),
  -- A superseded memory must be from the SAME workspace.
  foreign key (workspace_key, supersedes_id)
    references public.assistant_memory(workspace_key, id)
);
create index if not exists assistant_memory_active_idx
  on public.assistant_memory (workspace_key, status) where status = 'active';

-- ============================================================================
-- 3. assistant_actions (single AI action + confirmation record)
-- ============================================================================
-- Stores only references to real payment/booking results — never financial
-- amounts or customer PII. The confirmation token is stored HASHED.

create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  -- Nullable (an action may exist without a thread). When set, the composite FK
  -- forces it to a thread of the SAME workspace. NO ACTION on delete: threads
  -- are archived (status), not deleted, so the audit trail is preserved.
  thread_id uuid,
  action_type text not null,
  tool_name text not null,
  normalized_payload_json jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  expected_workspace_revision timestamptz,
  confirmation_token_hash text,
  confirmation_expires_at timestamptz,
  confirmation_used_at timestamptz,
  status text not null default 'prepared'
    check (status in ('prepared', 'confirmed', 'running', 'succeeded', 'failed', 'expired', 'rejected')),
  result_reference text,
  safe_result_json jsonb not null default '{}'::jsonb,
  error_code text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_key, thread_id)
    references public.assistant_threads(workspace_key, id)
);
create index if not exists assistant_actions_ws_idx on public.assistant_actions (workspace_key, created_at desc);

-- ============================================================================
-- 4. automation_rules / automation_runs (vacancy marketing)
-- ============================================================================

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  chalet_id text not null,
  enabled boolean not null default false,
  scan_days_ahead integer not null default 14 check (scan_days_ahead between 1 and 120),
  eligible_weekdays integer[] not null default '{}',
  eligible_period_ids text[] not null default '{}',
  allowed_offer_types text[] not null default '{discount,reminder}',
  minimum_price_halalas bigint not null default 0 check (minimum_price_halalas >= 0),
  maximum_daily_messages integer not null default 10 check (maximum_daily_messages >= 0),
  contact_cooldown_hours integer not null default 168 check (contact_cooldown_hours >= 0),
  preferred_tone text not null default 'concise',
  customer_groups text[] not null default '{previous}',
  -- Marketing is OFF by default and requires explicit owner approval.
  owner_approval_required boolean not null default true,
  automatic_send_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_key, chalet_id),
  -- Target for the composite (workspace_key, id) FK from automation_runs.
  unique (workspace_key, id)
);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  -- Nullable, but the composite FK forces any set value to a rule of the SAME
  -- workspace. NO ACTION on delete: rules are disabled, not deleted, so run
  -- history (and its rule linkage) is preserved.
  rule_id uuid,
  vacancy_key text not null,
  idempotency_key text not null,
  -- 'queued'/'sending' precede a real send; a run is 'sent' ONLY after an
  -- official Cloud API acknowledgement, 'delivered' only after a webhook.
  -- 'duplicate_skipped' is the atomic-uniqueness loser (no messages emitted).
  status text not null default 'started'
    check (status in ('started', 'drafted', 'awaiting_approval', 'queued', 'sending',
                      'sent', 'delivered', 'stopped_booked', 'completed', 'failed', 'duplicate_skipped')),
  eligible_contacts integer not null default 0,
  drafted_messages integer not null default 0,
  approved_messages integer not null default 0,
  sent_messages integer not null default 0,
  converted_booking_id text,
  attributed_revenue_halalas bigint not null default 0,
  safe_summary_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A given vacancy is processed at most once per rule per scan window. This
  -- uniqueness is the AUTHORITATIVE duplicate guard (the planner INSERTs first
  -- and treats a violation as duplicate_skipped BEFORE any outbound message).
  unique (workspace_key, idempotency_key),
  -- Target for the composite (workspace_key, id) FK from outbound_messages.
  unique (workspace_key, id),
  foreign key (workspace_key, rule_id)
    references public.automation_rules(workspace_key, id)
);

-- ============================================================================
-- 5. outbound_messages (server-side delivery; no plain phone in a client table)
-- ============================================================================

create table if not exists public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  -- Nullable in the schema, but the autopilot ALWAYS links a real run before any
  -- message is emitted (never null in practice). The composite FK forces the
  -- run to belong to the SAME workspace.
  automation_run_id uuid,
  booking_id text,
  -- Internal, non-PII reference to the customer (e.g. a per-workspace hash).
  customer_reference text not null default '',
  channel text not null default 'whatsapp',
  mode text not null default 'disconnected'
    check (mode in ('disconnected', 'open_manual_whatsapp', 'official_cloud_api')),
  template_name text,
  safe_message_body text not null default '',
  -- The real phone is NEVER stored in plaintext here. Only a server-side
  -- opaque reference the delivery layer can resolve; encrypted-at-rest if a
  -- number must be persisted at all.
  destination_ref text not null default '',
  -- 'sending' = handed to the Cloud API; 'sent' ONLY after its acknowledgement;
  -- 'delivered' ONLY after a delivery webhook; 'stopped_booked' if the vacancy
  -- filled before send. A manually opened link is 'opened_manual', never 'sent'.
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_approval', 'queued', 'sending', 'opened_manual',
                      'sent', 'delivered', 'failed', 'skipped_opt_out', 'stopped_booked')),
  provider_message_id text,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  foreign key (workspace_key, automation_run_id)
    references public.automation_runs(workspace_key, id)
);
create index if not exists outbound_messages_run_idx on public.outbound_messages (automation_run_id);

-- ============================================================================
-- 6. RLS + grants — no direct browser table access (RPC/service-role only)
-- ============================================================================

alter table public.assistant_threads enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_memory enable row level security;
alter table public.assistant_actions enable row level security;
alter table public.automation_rules enable row level security;
alter table public.automation_runs enable row level security;
alter table public.outbound_messages enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'assistant_threads','assistant_messages','assistant_memory','assistant_actions',
    'automation_rules','automation_runs','outbound_messages'
  ] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ============================================================================
-- 7. assistant_consume_confirmation — atomic one-time-use token check
-- ============================================================================
-- Called (service role) right before executing a sensitive action. Rejects
-- an expired / reused / mismatched / stale-revision / already-completed
-- confirmation. DeepSeek cannot generate or approve its own confirmation:
-- the token is created server-side at prepare time and the owner returns it.

create or replace function public.assistant_consume_confirmation(
  p_action_id uuid,
  p_workspace_key text,
  p_token_hash text,
  p_payload_hash text,
  p_current_workspace_revision timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.assistant_actions%rowtype;
begin
  select * into v_action
  from public.assistant_actions
  where id = p_action_id
  for update;

  if not found or v_action.workspace_key <> p_workspace_key then
    return jsonb_build_object('ok', false, 'error', 'ACTION_NOT_FOUND');
  end if;
  if v_action.status <> 'prepared' then
    return jsonb_build_object('ok', false, 'error', 'ACTION_NOT_PENDING');
  end if;
  if v_action.confirmation_used_at is not null then
    return jsonb_build_object('ok', false, 'error', 'CONFIRMATION_ALREADY_USED');
  end if;
  if v_action.confirmation_expires_at is null or v_action.confirmation_expires_at < now() then
    update public.assistant_actions set status = 'expired', updated_at = now() where id = p_action_id;
    return jsonb_build_object('ok', false, 'error', 'CONFIRMATION_EXPIRED');
  end if;
  if v_action.confirmation_token_hash is distinct from p_token_hash then
    return jsonb_build_object('ok', false, 'error', 'CONFIRMATION_TOKEN_MISMATCH');
  end if;
  if v_action.payload_hash is distinct from p_payload_hash then
    return jsonb_build_object('ok', false, 'error', 'PAYLOAD_CHANGED');
  end if;
  -- Stale-revision guard for booking writes (payment writes pass null).
  if v_action.expected_workspace_revision is not null
     and p_current_workspace_revision is not null
     and v_action.expected_workspace_revision <> p_current_workspace_revision then
    return jsonb_build_object('ok', false, 'error', 'STALE_REVISION');
  end if;

  update public.assistant_actions
  set status = 'confirmed', confirmation_used_at = now(), updated_at = now()
  where id = p_action_id;

  return jsonb_build_object('ok', true, 'action_type', v_action.action_type, 'tool_name', v_action.tool_name);
end;
$$;

-- ============================================================================
-- 8. assistant_promote_memory — explicit owner promotion (proposed -> active)
-- ============================================================================
-- Old active memory of the same "key" is superseded, not overwritten.

create or replace function public.assistant_promote_memory(
  p_workspace_key text,
  p_memory_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mem public.assistant_memory%rowtype;
begin
  select * into v_mem from public.assistant_memory
  where id = p_memory_id and workspace_key = p_workspace_key for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'MEMORY_NOT_FOUND');
  end if;
  if v_mem.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'error', 'MEMORY_NOT_PROPOSED');
  end if;
  if v_mem.supersedes_id is not null then
    update public.assistant_memory set status = 'superseded'
    where id = v_mem.supersedes_id and workspace_key = p_workspace_key;
  end if;
  update public.assistant_memory
  set status = 'active', effective_at = coalesce(effective_at, now()), last_verified_at = now()
  where id = p_memory_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.assistant_consume_confirmation(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.assistant_promote_memory(text, uuid) from public, anon, authenticated;

-- Reload PostgREST's schema cache (reverse-audit R-6 pattern).
notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- ROLLBACK (manual; additive objects only)
-- ============================================================================
-- drop function if exists public.assistant_promote_memory(text, uuid);
-- drop function if exists public.assistant_consume_confirmation(uuid, text, text, text, timestamptz);
-- drop table if exists public.outbound_messages cascade;
-- drop table if exists public.automation_runs cascade;
-- drop table if exists public.automation_rules cascade;
-- drop table if exists public.assistant_actions cascade;
-- drop table if exists public.assistant_memory cascade;
-- drop table if exists public.assistant_messages cascade;
-- drop table if exists public.assistant_threads cascade;
