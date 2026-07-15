-- 20260712000010_structural_duplicate_id_guard.sql
-- =============================================================================
-- B1 — server-side STRUCTURAL validation on the save path. Before this, the
-- save RPCs validated auth, revision (v2), booking-slot CONFLICTS and the
-- empty-overwrite wipe guard, but NOT the structural integrity of the document
-- itself. A direct RPC client holding the PIN (bypassing the browser, which
-- always writes structurally-valid docs) could persist a document with the same
-- booking id appearing on two DIFFERENT active rows — the exact corruption
-- behind the live «حجزان لخالد» duplicate and the 3× repeated empty slot.
--
-- This adds a grandfathered guard: a duplicate booking id that is NEW to the
-- proposed document (absent from the locked, authoritative OLD document) is
-- rejected; a pre-existing duplicate is grandfathered so an unrelated safe edit
-- is never blocked. It FAILS OPEN — an id-less row, a non-array bookings field,
-- or any document with no NEW duplicate proceeds exactly as before. The browser
-- keys bookings by id (editing id X replaces the single row with id X), so it
-- never produces a duplicate active id and is never blocked; the deploy smoke's
-- real booking-create exercises this path live.
--
-- Deleted rows are tombstones and are ignored, so an id may legitimately be
-- reused by a fresh active row after its predecessor was soft-deleted.
--
-- Functions only — this migration does NOT update, delete or rewrite any
-- workspace/customer/booking row. Both save function bodies are the definitions
-- from 20260712000009 byte-for-byte; only the new structural check is inserted.
-- =============================================================================

begin;

-- Tokens: 'DUPLICATE_BOOKING_ID:<id>' for every non-deleted booking id that
-- appears on more than one row. Empty array on null/malformed input (fail-open).
create or replace function public.workspace_doc_duplicate_booking_ids(p_data jsonb)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_bookings jsonb;
  b jsonb;
  v_seen text[] := '{}';
  v_dups text[] := '{}';
  v_id text;
begin
  if p_data is null then return '{}'::text[]; end if;
  v_bookings := coalesce(p_data->'bookings', '[]'::jsonb);
  if jsonb_typeof(v_bookings) <> 'array' then return '{}'::text[]; end if;

  for b in select * from jsonb_array_elements(v_bookings) loop
    -- Ignore tombstones: a soft-deleted row's id may reappear as a fresh active
    -- row without being a duplicate.
    if (b ? 'deleted_at') and b->'deleted_at' <> 'null'::jsonb
       and coalesce(b->>'deleted_at', '') <> '' then continue; end if;
    v_id := coalesce(b->>'id', '');
    if v_id = '' then continue; end if; -- id-less rows can't collide by id
    if v_id = any(v_seen) then
      if not (('DUPLICATE_BOOKING_ID:' || v_id) = any(v_dups)) then
        v_dups := v_dups || ('DUPLICATE_BOOKING_ID:' || v_id);
      end if;
    else
      v_seen := v_seen || v_id;
    end if;
  end loop;
  return v_dups;
end;
$$;

-- Grandfather wrapper (mirrors workspace_doc_new_booking_conflict): return the
-- first duplicate-id token present in the NEW document but not the OLD one.
create or replace function public.workspace_doc_new_structural_problem(
  p_old_data jsonb,
  p_new_data jsonb
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_old text[] := public.workspace_doc_duplicate_booking_ids(coalesce(p_old_data, '{}'::jsonb));
  v_new text[] := public.workspace_doc_duplicate_booking_ids(coalesce(p_new_data, '{}'::jsonb));
  v_token text;
begin
  foreach v_token in array v_new loop
    if not (v_token = any(v_old)) then return v_token; end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.workspace_doc_duplicate_booking_ids(jsonb) from public, anon, authenticated;
revoke all on function public.workspace_doc_new_structural_problem(jsonb, jsonb) from public, anon, authenticated;

-- --- save v2 (revision-atomic) — add the structural check after the conflict --
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
  v_structural text;
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

  v_data := p_data - 'updated_at';
  v_now := statement_timestamp();

  select * into v_workspace
  from public.shared_workspaces
  where workspace_key = v_auth.workspace_key
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID');
  end if;
  if v_workspace.updated_at <> p_expected_updated_at then
    return jsonb_build_object(
      'ok', false,
      'error', 'STALE_REVISION',
      'current_updated_at', v_workspace.updated_at
    );
  end if;

  -- Only a pair absent from the locked, authoritative OLD document blocks.
  v_conflict := public.workspace_doc_new_booking_conflict(v_workspace.data, v_data);
  if v_conflict is not null then
    return jsonb_build_object('ok', false, 'error', v_conflict);
  end if;

  -- Structural integrity: a NEW duplicate booking id (grandfathering any that
  -- already exists in the locked OLD document) is data corruption — reject it.
  v_structural := public.workspace_doc_new_structural_problem(v_workspace.data, v_data);
  if v_structural is not null then
    return jsonb_build_object('ok', false, 'error', v_structural);
  end if;

  -- Wipe guard: an empty-of-business-data document may not overwrite one that
  -- HAS business data (chalets, bookings, OR expenses — see helper).
  if not public.workspace_has_business_data(v_data)
     and public.workspace_has_business_data(v_workspace.data) then
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

-- --- save v1 (legacy, non-CAS) — same structural check in both branches ------
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
  v_conflict text;
  v_structural text;
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

  select * into v_workspace
  from public.shared_workspaces
  where workspace_key = v_workspace_key
  for update;

  if not found then
    -- A new workspace has no legacy state to grandfather.
    v_conflict := public.workspace_doc_new_booking_conflict('{}'::jsonb, v_data);
    if v_conflict is not null then
      raise exception '%', v_conflict using errcode = '23514';
    end if;
    v_structural := public.workspace_doc_new_structural_problem('{}'::jsonb, v_data);
    if v_structural is not null then
      raise exception '%', v_structural using errcode = '23514';
    end if;
    insert into public.shared_workspaces (
      workspace_key, pin_hash, data, created_at, updated_at
    ) values (
      v_workspace_key, crypt(v_pin, gen_salt('bf', 12)), v_data, v_updated_at, v_updated_at
    )
    returning * into v_workspace;
  elsif crypt(v_pin, v_workspace.pin_hash) = v_workspace.pin_hash then
    v_conflict := public.workspace_doc_new_booking_conflict(v_workspace.data, v_data);
    if v_conflict is not null then
      raise exception '%', v_conflict using errcode = '23514';
    end if;
    v_structural := public.workspace_doc_new_structural_problem(v_workspace.data, v_data);
    if v_structural is not null then
      raise exception '%', v_structural using errcode = '23514';
    end if;
    if not public.workspace_has_business_data(v_data)
       and public.workspace_has_business_data(v_workspace.data) then
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

notify pgrst, 'reload schema';

commit;

-- ROLLBACK (manual, functions only; never touches data rows):
-- Re-run 20260712000009_unified_business_data_guard.sql to restore the save
-- functions WITHOUT the structural check, then:
-- drop function if exists public.workspace_doc_new_structural_problem(jsonb, jsonb);
-- drop function if exists public.workspace_doc_duplicate_booking_ids(jsonb);
