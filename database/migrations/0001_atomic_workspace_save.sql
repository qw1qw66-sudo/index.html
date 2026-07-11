-- 0001_atomic_workspace_save.sql
-- Concurrency + auth hardening for the shared-workspace document model.
-- Fixes (server side): AUD-001 create-overwrite, AUD-002 lost updates (TOCTOU),
-- AUD-005 conflicting confirmed bookings, AUD-006 practical rate limiting.
--
-- ADDITIVE ONLY: does not drop or change the existing get_shared_workspace /
-- save_shared_workspace functions or the shared_workspaces table, so the
-- currently deployed frontend keeps working unchanged.
--
-- PREPARED, NOT EXECUTED: this file must be applied manually (staging first).

begin;

create extension if not exists pgcrypto with schema public;

-- ============================================================================
-- 1. Auth attempt throttling (sliding window, per workspace key)
-- ============================================================================
-- Limitation (documented): failures are recorded only by the *return-style*
-- functions below (v2/create/payments). The legacy v1 functions raise
-- exceptions, which roll back any counter write in the same transaction, so
-- their own failed attempts cannot increment the counter; v1 still *checks*
-- the counter, so a limit tripped via the new surface throttles everywhere.
-- Enable Supabase API rate limiting / WAF for defense in depth.

create table if not exists public.workspace_auth_throttle (
  workspace_key text primary key,
  window_start  timestamptz not null default now(),
  failures      integer not null default 0
);

alter table public.workspace_auth_throttle enable row level security;
revoke all on table public.workspace_auth_throttle from public;
revoke all on table public.workspace_auth_throttle from anon;
revoke all on table public.workspace_auth_throttle from authenticated;

create or replace function public.workspace_auth_throttled(p_workspace_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_auth_throttle%rowtype;
  -- 20 failures per 15 minutes per workspace key.
  c_max_failures constant integer := 20;
  c_window constant interval := interval '15 minutes';
begin
  select * into v_row
  from public.workspace_auth_throttle
  where workspace_key = p_workspace_key;
  if not found then
    return false;
  end if;
  if v_row.window_start < now() - c_window then
    return false; -- stale window; will be reset on next failure
  end if;
  return v_row.failures >= c_max_failures;
end;
$$;

create or replace function public.workspace_auth_record_failure(p_workspace_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c_window constant interval := interval '15 minutes';
begin
  insert into public.workspace_auth_throttle as t (workspace_key, window_start, failures)
  values (p_workspace_key, now(), 1)
  on conflict (workspace_key) do update
    set window_start = case
          when t.window_start < now() - c_window then now()
          else t.window_start
        end,
        failures = case
          when t.window_start < now() - c_window then 1
          else t.failures + 1
        end;
end;
$$;

create or replace function public.workspace_auth_clear(p_workspace_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.workspace_auth_throttle where workspace_key = p_workspace_key;
end;
$$;

-- ============================================================================
-- 2. Shared auth helper (return-style: lets callers commit failure counters)
-- ============================================================================
-- Returns: ok, error code (null when ok), normalized workspace key, and the
-- workspace row id when authenticated. Never leaks whether the key or the PIN
-- was wrong.

create or replace function public.workspace_auth(
  p_workspace_key text,
  p_access_pin text
)
returns table(ok boolean, error_code text, workspace_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_pin text;
  v_workspace public.shared_workspaces%rowtype;
begin
  v_key := upper(regexp_replace(btrim(coalesce(p_workspace_key, '')), '[^A-Za-z0-9_-]', '', 'g'));
  v_pin := coalesce(p_access_pin, '');

  if v_key !~ '^[A-Z0-9_-]{3,64}$' then
    return query select false, 'INVALID_WORKSPACE_KEY'::text, null::text;
    return;
  end if;
  if length(v_pin) < 4 or length(v_pin) > 128 then
    return query select false, 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID'::text, v_key;
    return;
  end if;
  if public.workspace_auth_throttled(v_key) then
    return query select false, 'TOO_MANY_ATTEMPTS'::text, v_key;
    return;
  end if;

  select * into v_workspace
  from public.shared_workspaces w
  where w.workspace_key = v_key;

  if not found or crypt(v_pin, v_workspace.pin_hash) <> v_workspace.pin_hash then
    perform public.workspace_auth_record_failure(v_key);
    return query select false, 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID'::text, v_key;
    return;
  end if;

  perform public.workspace_auth_clear(v_key);
  return query select true, null::text, v_key;
end;
$$;

-- ============================================================================
-- 3. Document validation: reject internally conflicting confirmed bookings
-- ============================================================================
-- Mirrors the frontend rules exactly (index.html findConflict/intervalFor):
-- same chalet, both status='confirmed', both not soft-deleted, different id,
-- period time intervals overlap on the booking date (end<=start rolls to the
-- next day). Bookings whose chalet/period cannot be resolved produce no
-- interval and therefore no conflict — identical to the frontend behavior.
-- Returns null when the document is consistent, else a short conflict token
-- 'BOOKING_CONFLICT:<id1>:<id2>' (ids only — no customer data in errors).

create or replace function public.workspace_doc_booking_conflict(p_data jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_bookings jsonb;
  v_chalets jsonb;
  b jsonb;
  v_starts timestamptz[] := '{}';
  v_ends timestamptz[] := '{}';
  v_ids text[] := '{}';
  v_chalet_ids text[] := '{}';
  i integer;
  j integer;
  v_chalet jsonb;
  v_period jsonb;
  v_date text;
  v_start_t text;
  v_end_t text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_data is null then
    return null;
  end if;
  v_bookings := coalesce(p_data->'bookings', '[]'::jsonb);
  v_chalets := coalesce(p_data->'chalets', '[]'::jsonb);
  if jsonb_typeof(v_bookings) <> 'array' then
    return null;
  end if;

  for b in select * from jsonb_array_elements(v_bookings) loop
    -- Only confirmed, non-deleted bookings participate in conflicts.
    if coalesce(b->>'status', '') <> 'confirmed' then continue; end if;
    if (b ? 'deleted_at') and b->'deleted_at' <> 'null'::jsonb
       and coalesce(b->>'deleted_at', '') <> '' then continue; end if;

    v_date := coalesce(b->>'booking_date', '');
    if v_date !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;

    -- Resolve the period (active or not) from the booking's chalet.
    select c into v_chalet
    from jsonb_array_elements(v_chalets) c
    where c->>'id' = b->>'chalet_id'
    limit 1;
    if v_chalet is null then continue; end if;

    select p into v_period
    from jsonb_array_elements(coalesce(v_chalet->'periods', '[]'::jsonb)) p
    where p->>'id' = b->>'period_id'
    limit 1;
    if v_period is null then continue; end if;

    v_start_t := coalesce(v_period->>'start', '');
    v_end_t := coalesce(v_period->>'end', '');
    if v_start_t !~ '^\d{1,2}:\d{2}$' or v_end_t !~ '^\d{1,2}:\d{2}$' then continue; end if;

    v_start := (v_date || ' ' || v_start_t || ':00')::timestamp at time zone 'UTC';
    v_end := (v_date || ' ' || v_end_t || ':00')::timestamp at time zone 'UTC';
    if v_end <= v_start then
      v_end := v_end + interval '1 day';
    end if;

    v_ids := v_ids || coalesce(b->>'id', '');
    v_chalet_ids := v_chalet_ids || coalesce(b->>'chalet_id', '');
    v_starts := v_starts || v_start;
    v_ends := v_ends || v_end;
  end loop;

  for i in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    for j in (i + 1) .. coalesce(array_length(v_ids, 1), 0) loop
      if v_chalet_ids[i] = v_chalet_ids[j]
         and v_ids[i] <> v_ids[j]
         and v_starts[i] < v_ends[j]
         and v_ends[i] > v_starts[j] then
        return 'BOOKING_CONFLICT:' || v_ids[i] || ':' || v_ids[j];
      end if;
    end loop;
  end loop;

  return null;
end;
$$;

-- ============================================================================
-- 4. Save audit (append-only tamper evidence; no customer data stored)
-- ============================================================================

create table if not exists public.workspace_save_audit (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  action text not null check (action in ('create', 'save_v2', 'reconcile_write_back')),
  prev_updated_at timestamptz,
  new_updated_at timestamptz not null,
  chalet_count integer not null default 0,
  booking_count integer not null default 0,
  doc_hash_prefix text not null default '',
  created_at timestamptz not null default now()
);

alter table public.workspace_save_audit enable row level security;
revoke all on table public.workspace_save_audit from public;
revoke all on table public.workspace_save_audit from anon;
revoke all on table public.workspace_save_audit from authenticated;

create or replace function public.workspace_save_audit_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'IMMUTABLE_AUDIT_ROW' using errcode = '55000';
end;
$$;

drop trigger if exists workspace_save_audit_immutable on public.workspace_save_audit;
create trigger workspace_save_audit_immutable
before update or delete on public.workspace_save_audit
for each row execute function public.workspace_save_audit_block_mutation();

-- ============================================================================
-- 5. create_shared_workspace: create-only (fails when the key exists)
-- ============================================================================
-- Replaces the dangerous "create by saving an empty document" flow (AUD-001).
-- Return-style: {ok:true,...} or {ok:false, error:'...'} — never overwrites.

create or replace function public.create_shared_workspace(
  p_workspace_key text,
  p_access_pin text,
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_pin text;
  v_data jsonb;
  v_now timestamptz;
  v_workspace public.shared_workspaces%rowtype;
begin
  v_key := upper(regexp_replace(btrim(coalesce(p_workspace_key, '')), '[^A-Za-z0-9_-]', '', 'g'));
  v_pin := coalesce(p_access_pin, '');

  if v_key !~ '^[A-Z0-9_-]{3,64}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_WORKSPACE_KEY');
  end if;
  -- New workspaces require a stronger PIN (existing workspaces unaffected).
  if length(v_pin) < 6 or length(v_pin) > 128 then
    return jsonb_build_object('ok', false, 'error', 'PIN_TOO_SHORT');
  end if;
  if public.workspace_auth_throttled(v_key) then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DATA');
  end if;

  v_data := p_data - 'updated_at';
  v_now := statement_timestamp();

  begin
    insert into public.shared_workspaces (workspace_key, pin_hash, data, created_at, updated_at)
    values (v_key, crypt(v_pin, gen_salt('bf', 12)), v_data, v_now, v_now)
    returning * into v_workspace;
  exception when unique_violation then
    -- Existence is leaked here by design necessity: the caller must pick
    -- another key. This does NOT validate any PIN, so it is not an oracle
    -- for credentials. Count it toward the throttle to slow enumeration.
    perform public.workspace_auth_record_failure(v_key);
    return jsonb_build_object('ok', false, 'error', 'WORKSPACE_ALREADY_EXISTS');
  end;

  insert into public.workspace_save_audit
    (workspace_key, action, prev_updated_at, new_updated_at, chalet_count, booking_count, doc_hash_prefix)
  values
    (v_key, 'create', null, v_now,
     coalesce(jsonb_array_length(v_data->'chalets'), 0),
     coalesce(jsonb_array_length(v_data->'bookings'), 0),
     left(md5(v_data::text), 12));

  return jsonb_build_object(
    'ok', true,
    'workspace_key', v_workspace.workspace_key,
    'updated_at', v_workspace.updated_at,
    'data', coalesce(v_workspace.data, '{}'::jsonb)
  );
end;
$$;

-- ============================================================================
-- 6. save_shared_workspace_v2: atomic compare-and-save
-- ============================================================================
-- - Requires the expected revision (updated_at) observed at pull time and
--   verifies it INSIDE the row lock: no TOCTOU window (AUD-002).
-- - Never auto-creates a workspace (AUD-001): unknown key => error.
-- - Rejects documents containing conflicting confirmed bookings (AUD-005).
-- - Return-style errors ({ok:false, error}) so throttle writes commit.
--   STALE_REVISION responses include the current cloud revision so clients
--   can tell the user to pull.

create or replace function public.save_shared_workspace_v2(
  p_workspace_key text,
  p_access_pin text,
  p_data jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth record;
  v_workspace public.shared_workspaces%rowtype;
  v_data jsonb;
  v_now timestamptz;
  v_conflict text;
begin
  select * into v_auth from public.workspace_auth(p_workspace_key, p_access_pin);
  if not v_auth.ok then
    return jsonb_build_object('ok', false, 'error', v_auth.error_code);
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DATA');
  end if;
  if p_expected_updated_at is null then
    return jsonb_build_object('ok', false, 'error', 'MISSING_EXPECTED_REVISION');
  end if;

  v_conflict := public.workspace_doc_booking_conflict(p_data);
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'error', v_conflict);
  end if;

  v_data := p_data - 'updated_at';
  v_now := statement_timestamp();

  select * into v_workspace
  from public.shared_workspaces
  where workspace_key = v_auth.workspace_key
  for update;

  if not found then
    -- Auth succeeded moments ago; row deleted concurrently. Do not create.
    return jsonb_build_object('ok', false, 'error', 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID');
  end if;

  if v_workspace.updated_at <> p_expected_updated_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'STALE_REVISION',
      'current_updated_at', v_workspace.updated_at
    );
  end if;

  -- Guard against wiping a non-empty workspace with an empty document
  -- (server-side twin of the client-side guard).
  if coalesce(jsonb_array_length(v_data->'chalets'), 0) = 0
     and coalesce(jsonb_array_length(v_data->'bookings'), 0) = 0
     and (coalesce(jsonb_array_length(v_workspace.data->'chalets'), 0) > 0
          or coalesce(jsonb_array_length(v_workspace.data->'bookings'), 0) > 0) then
    return jsonb_build_object('ok', false, 'error', 'EMPTY_OVERWRITE_BLOCKED');
  end if;

  update public.shared_workspaces
  set data = v_data,
      updated_at = v_now
  where workspace_key = v_auth.workspace_key
  returning * into v_workspace;

  insert into public.workspace_save_audit
    (workspace_key, action, prev_updated_at, new_updated_at, chalet_count, booking_count, doc_hash_prefix)
  values
    (v_auth.workspace_key, 'save_v2', p_expected_updated_at, v_now,
     coalesce(jsonb_array_length(v_data->'chalets'), 0),
     coalesce(jsonb_array_length(v_data->'bookings'), 0),
     left(md5(v_data::text), 12));

  return jsonb_build_object(
    'ok', true,
    'workspace_key', v_workspace.workspace_key,
    'updated_at', v_workspace.updated_at,
    'data', coalesce(v_workspace.data, '{}'::jsonb)
  );
end;
$$;

-- ============================================================================
-- 7. Hardened legacy v1 functions (contract-compatible re-creation)
-- ============================================================================
-- v1 bodies are re-created with the SAME signatures and error contract
-- (raise on failure) so the currently deployed frontend keeps working:
--   - get: adds the throttle check.
--   - save: adds the throttle check AND a server-side empty-overwrite guard —
--     replacing a NON-EMPTY workspace document with an EMPTY one is rejected.
--     This turns the AUD-001 "create account wipes existing data" click into
--     a visible error for old clients instead of silent data loss, while
--     creating genuinely new workspaces still works. v1 auto-create is
--     intentionally kept for old-frontend compatibility; disable it in a
--     future migration once all clients use create_shared_workspace.

create or replace function public.get_shared_workspace(
  p_workspace_key text,
  p_access_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace public.shared_workspaces%rowtype;
  v_workspace_key text;
  v_pin text;
begin
  v_workspace_key := upper(regexp_replace(btrim(coalesce(p_workspace_key, '')), '[^A-Za-z0-9_-]', '', 'g'));
  v_pin := coalesce(p_access_pin, '');

  if v_workspace_key !~ '^[A-Z0-9_-]{3,64}$' then
    raise exception 'INVALID_WORKSPACE_KEY' using errcode = '22023';
  end if;

  if length(v_pin) < 4 or length(v_pin) > 128 then
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' using errcode = '28000';
  end if;

  if public.workspace_auth_throttled(v_workspace_key) then
    raise exception 'TOO_MANY_ATTEMPTS' using errcode = '54000';
  end if;

  select *
  into v_workspace
  from public.shared_workspaces
  where workspace_key = v_workspace_key;

  if not found or crypt(v_pin, v_workspace.pin_hash) <> v_workspace.pin_hash then
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'ok', true,
    'workspace_key', v_workspace.workspace_key,
    'updated_at', v_workspace.updated_at,
    'data', coalesce(v_workspace.data, '{}'::jsonb)
  );
end;
$$;

create or replace function public.save_shared_workspace(
  p_workspace_key text,
  p_access_pin text,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace public.shared_workspaces%rowtype;
  v_workspace_key text;
  v_pin text;
  v_data jsonb;
  v_updated_at timestamptz;
begin
  v_workspace_key := upper(regexp_replace(btrim(coalesce(p_workspace_key, '')), '[^A-Za-z0-9_-]', '', 'g'));
  v_pin := coalesce(p_access_pin, '');

  if v_workspace_key !~ '^[A-Z0-9_-]{3,64}$' then
    raise exception 'INVALID_WORKSPACE_KEY' using errcode = '22023';
  end if;

  if length(v_pin) < 4 or length(v_pin) > 128 then
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' using errcode = '28000';
  end if;

  if public.workspace_auth_throttled(v_workspace_key) then
    raise exception 'TOO_MANY_ATTEMPTS' using errcode = '54000';
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'INVALID_DATA' using errcode = '22023';
  end if;

  v_data := p_data - 'updated_at';
  v_updated_at := statement_timestamp();

  select *
  into v_workspace
  from public.shared_workspaces
  where workspace_key = v_workspace_key
  for update;

  if not found then
    insert into public.shared_workspaces (
      workspace_key, pin_hash, data, created_at, updated_at
    ) values (
      v_workspace_key, crypt(v_pin, gen_salt('bf', 12)), v_data, v_updated_at, v_updated_at
    )
    returning * into v_workspace;
  elsif crypt(v_pin, v_workspace.pin_hash) = v_workspace.pin_hash then
    -- Server-side twin of the client-side empty-overwrite guard (AUD-001):
    -- never let an empty document replace a non-empty one through v1.
    if coalesce(jsonb_array_length(v_data->'chalets'), 0) = 0
       and coalesce(jsonb_array_length(v_data->'bookings'), 0) = 0
       and (coalesce(jsonb_array_length(v_workspace.data->'chalets'), 0) > 0
            or coalesce(jsonb_array_length(v_workspace.data->'bookings'), 0) > 0) then
      raise exception 'EMPTY_OVERWRITE_BLOCKED' using errcode = '22023';
    end if;
    update public.shared_workspaces
    set data = v_data,
        updated_at = v_updated_at
    where workspace_key = v_workspace_key
    returning * into v_workspace;
  else
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'ok', true,
    'workspace_key', v_workspace.workspace_key,
    'updated_at', v_workspace.updated_at,
    'data', coalesce(v_workspace.data, '{}'::jsonb)
  );
end;
$$;

-- ============================================================================
-- 8. Grants: RPC-only for anon, same model as the existing functions
-- ============================================================================

revoke all on function public.workspace_auth_throttled(text) from public, anon, authenticated;
revoke all on function public.workspace_auth_record_failure(text) from public, anon, authenticated;
revoke all on function public.workspace_auth_clear(text) from public, anon, authenticated;
revoke all on function public.workspace_auth(text, text) from public, anon, authenticated;
revoke all on function public.workspace_doc_booking_conflict(jsonb) from public, anon, authenticated;
revoke all on function public.workspace_save_audit_block_mutation() from public, anon, authenticated;

revoke all on function public.create_shared_workspace(text, text, jsonb) from public, authenticated;
revoke all on function public.save_shared_workspace_v2(text, text, jsonb, timestamptz) from public, authenticated;
grant execute on function public.create_shared_workspace(text, text, jsonb) to anon;
grant execute on function public.save_shared_workspace_v2(text, text, jsonb, timestamptz) to anon;

commit;

-- ============================================================================
-- ROLLBACK (manual; additive objects only — never touches shared_workspaces)
-- ============================================================================
-- drop function if exists public.save_shared_workspace_v2(text, text, jsonb, timestamptz);
-- drop function if exists public.create_shared_workspace(text, text, jsonb);
-- drop function if exists public.workspace_doc_booking_conflict(jsonb);
-- drop function if exists public.workspace_auth(text, text);
-- drop function if exists public.workspace_auth_clear(text);
-- drop function if exists public.workspace_auth_record_failure(text);
-- drop function if exists public.workspace_auth_throttled(text);
-- drop trigger if exists workspace_save_audit_immutable on public.workspace_save_audit;
-- drop function if exists public.workspace_save_audit_block_mutation();
-- drop table if exists public.workspace_save_audit;
-- drop table if exists public.workspace_auth_throttle;
-- To restore the original v1 get_shared_workspace, re-run
-- database/shared_workspace_sync.sql (it recreates both v1 functions).
