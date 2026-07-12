-- Migration 0008: night-anchor the conflict engine's post-midnight periods.
--
-- Convention (mirrored 1:1 in availability.mjs and index.html intervalFor):
-- a NON-wrapping period whose start hour is before 06:00 belongs to the NIGHT
-- of the chosen booking_date — both endpoints shift one day forward. Without
-- this, a 00:00–05:00 slot dated D lands in D's PAST early morning and never
-- collides with a D-dated 19:00–05:00 booking, so the middle of an occupied
-- night read as available (live report: «احجز ١٢ ساعة… الخمس ساعات اللي في
-- نص هذا الوقت يقولي انها متاحة»). Wrapping periods (end <= start) keep the
-- existing end+1day rule; adjacency stays half-open.
--
-- Grandfathering is unaffected: workspace_doc_new_booking_conflict compares
-- OLD and NEW docs with this same redefined function, so any pair the new
-- anchoring reveals inside an already-stored document appears on both sides
-- and never blocks a save — only genuinely NEW overlaps are rejected.
--
-- This migration changes ONE function only. It does not update, delete,
-- rewrite or otherwise touch any workspace/customer/booking row.

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
    if v_end <= v_start then
      v_end := v_end + interval '1 day';
    elsif split_part(v_start_t, ':', 1)::int < 6 then
      -- Night anchor: a fully post-midnight slot is the tail of this date's
      -- night, not its past early morning.
      v_start := v_start + interval '1 day';
      v_end := v_end + interval '1 day';
    end if;

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

revoke all on function public.workspace_doc_booking_conflicts(jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK (manual, functions only; never touches data rows):
-- Re-run migration 20260712000007_grandfather_existing_booking_conflicts.sql
-- to restore the pre-anchor definition of workspace_doc_booking_conflicts.
