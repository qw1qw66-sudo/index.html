-- 20260712000009_unified_business_data_guard.sql
-- =============================================================================
-- H2 — unified "business data present" definition for the empty-overwrite wipe
-- guard. Before this, the guard (in save_shared_workspace_v2 AND the legacy v1)
-- counted ONLY chalets + bookings, so a document holding expenses (and no
-- chalets/bookings) was:
--   (A) wrongly REJECTED on save — EMPTY_OVERWRITE_BLOCKED — losing the update, and
--   (B) at risk of a silent WIPE by a truly-empty document (the guard's "old has
--       data?" test was blind to expenses).
-- Both RPCs now derive the guard from ONE helper, workspace_has_business_data(),
-- which is the single source of truth for "this document holds real business
-- data". Adding a future protected collection is a one-line change there.
--
-- Safety: this only CORRECTS the guard — it still blocks an empty document from
-- overwriting a non-empty one (wipe protection preserved and EXTENDED to
-- expenses); it merely stops falsely rejecting a non-empty (expenses-bearing)
-- save. The rest of each function body is byte-for-byte the definition from
-- 20260712000007; only the guard clause changed.
-- =============================================================================

begin;

create or replace function public.workspace_has_business_data(p_data jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- SINGLE SOURCE OF TRUTH: extend this list when a new protected collection is
  -- added to the workspace document (keep in sync with the browser's
  -- BUSINESS_COLLECTIONS in index.html).
  select coalesce(jsonb_array_length(p_data->'chalets'), 0) > 0
      or coalesce(jsonb_array_length(p_data->'bookings'), 0) > 0
      or coalesce(jsonb_array_length(p_data->'expenses'), 0) > 0;
$$;

-- Internal helper — callers reach it only through the security-definer RPCs.
revoke all on function public.workspace_has_business_data(jsonb) from public, anon, authenticated;

-- --- save v2 (revision-atomic) — guard clause now uses the helper ------------
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

-- --- save v1 (legacy, non-CAS) — guard clause now uses the helper ------------
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
-- Re-run 20260712000007_grandfather_existing_booking_conflicts.sql to restore the
-- chalets+bookings-only guard, then:
-- drop function if exists public.workspace_has_business_data(jsonb);
