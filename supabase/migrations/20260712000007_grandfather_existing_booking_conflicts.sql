-- Migration 0007: let safe writes proceed beside untouched legacy conflicts.
--
-- The previous save guard rejected the whole proposed document whenever any
-- overlap existed. That correctly prevented new double-bookings, but it also
-- made an unrelated historical conflict block every future create/update/
-- cancel. This migration compares conflict PAIRS before and after the write:
-- existing pairs may remain untouched; every newly introduced pair is still
-- rejected with the same BOOKING_CONFLICT:<id1>:<id2> contract.
--
-- This migration changes functions only. It does not update, delete, rewrite
-- or otherwise touch any workspace/customer/booking row.

begin;

create or replace function public.workspace_doc_booking_conflicts(p_data jsonb)
returns text[]
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
  v_conflicts text[] := '{}';
  i integer;
  j integer;
  v_count integer;
  v_chalet jsonb;
  v_period jsonb;
  v_date text;
  v_start_t text;
  v_end_t text;
  v_start timestamptz;
  v_end timestamptz;
  v_token text;
begin
  if p_data is null then
    return '{}'::text[];
  end if;
  v_bookings := coalesce(p_data->'bookings', '[]'::jsonb);
  v_chalets := coalesce(p_data->'chalets', '[]'::jsonb);
  if jsonb_typeof(v_bookings) <> 'array' then
    return '{}'::text[];
  end if;

  for b in select * from jsonb_array_elements(v_bookings) loop
    if coalesce(b->>'status', '') <> 'confirmed' then continue; end if;
    if (b ? 'deleted_at') and b->'deleted_at' <> 'null'::jsonb
       and coalesce(b->>'deleted_at', '') <> '' then continue; end if;

    v_date := coalesce(b->>'booking_date', '');
    if v_date !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;

    v_chalet := null;
    select c into v_chalet
    from jsonb_array_elements(v_chalets) c
    where c->>'id' = b->>'chalet_id'
    limit 1;
    if v_chalet is null then continue; end if;

    v_period := null;
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
    if v_end <= v_start then v_end := v_end + interval '1 day'; end if;

    v_ids := v_ids || coalesce(b->>'id', '');
    v_chalet_ids := v_chalet_ids || coalesce(b->>'chalet_id', '');
    v_starts := v_starts || v_start;
    v_ends := v_ends || v_end;
  end loop;

  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count < 2 then return v_conflicts; end if;

  for i in 1 .. (v_count - 1) loop
    for j in (i + 1) .. v_count loop
      if v_chalet_ids[i] = v_chalet_ids[j]
         and v_ids[i] <> v_ids[j]
         and v_starts[i] < v_ends[j]
         and v_ends[i] > v_starts[j] then
        -- Canonical id order makes the comparison insensitive to harmless
        -- booking-array reordering by an older client.
        v_token := 'BOOKING_CONFLICT:' || least(v_ids[i], v_ids[j]) || ':' || greatest(v_ids[i], v_ids[j]);
        if not (v_token = any(v_conflicts)) then
          v_conflicts := v_conflicts || v_token;
        end if;
      end if;
    end loop;
  end loop;
  return v_conflicts;
end;
$$;

-- Preserve the original helper/API for callers and diagnostics.
create or replace function public.workspace_doc_booking_conflict(p_data jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select (public.workspace_doc_booking_conflicts(p_data))[1]
$$;

create or replace function public.workspace_doc_new_booking_conflict(
  p_old_data jsonb,
  p_new_data jsonb
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_old text[] := public.workspace_doc_booking_conflicts(coalesce(p_old_data, '{}'::jsonb));
  v_new text[] := public.workspace_doc_booking_conflicts(coalesce(p_new_data, '{}'::jsonb));
  v_token text;
begin
  foreach v_token in array v_new loop
    if not (v_token = any(v_old)) then return v_token; end if;
  end loop;
  return null;
end;
$$;

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

-- Keep the legacy v1 contract usable for older cached Pages clients while
-- applying the same old-vs-new conflict comparison. It remains non-CAS.
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

revoke all on function public.workspace_doc_booking_conflicts(jsonb) from public, anon, authenticated;
revoke all on function public.workspace_doc_booking_conflict(jsonb) from public, anon, authenticated;
revoke all on function public.workspace_doc_new_booking_conflict(jsonb, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK (manual, functions only; never touches data rows):
-- Re-run migration 20260701000001_atomic_workspace_save.sql to restore the
-- original whole-document guard, then drop the two helpers below.
-- drop function if exists public.workspace_doc_new_booking_conflict(jsonb, jsonb);
-- drop function if exists public.workspace_doc_booking_conflicts(jsonb);
