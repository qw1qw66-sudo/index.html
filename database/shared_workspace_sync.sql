create table if not exists public.shared_workspaces (
  workspace_key text primary key,
  access_pin text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_workspaces enable row level security;

revoke all on public.shared_workspaces from anon;
revoke all on public.shared_workspaces from authenticated;

drop function if exists public.get_shared_workspace(text, text);

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
  row_data public.shared_workspaces%rowtype;
  normalized_key text := upper(regexp_replace(coalesce(p_workspace_key, ''), '[^A-Za-z0-9_-]', '', 'g'));
begin
  if length(normalized_key) < 3 then
    return null;
  end if;

  if length(coalesce(p_access_pin, '')) < 4 then
    return null;
  end if;

  select *
  into row_data
  from public.shared_workspaces
  where workspace_key = normalized_key;

  if not found then
    return null;
  end if;

  if row_data.access_pin <> p_access_pin then
    return null;
  end if;

  return row_data.data;
end;
$$;

drop function if exists public.save_shared_workspace(text, text, jsonb);

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
  row_data public.shared_workspaces%rowtype;
  normalized_key text := upper(regexp_replace(coalesce(p_workspace_key, ''), '[^A-Za-z0-9_-]', '', 'g'));
  created_new boolean := false;
begin
  if length(normalized_key) < 3 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_WORKSPACE_KEY');
  end if;

  if length(coalesce(p_access_pin, '')) < 4 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PIN');
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DATA');
  end if;

  if length(p_data::text) > 5000000 then
    return jsonb_build_object('ok', false, 'error', 'DATA_TOO_LARGE');
  end if;

  select *
  into row_data
  from public.shared_workspaces
  where workspace_key = normalized_key
  for update;

  if not found then
    insert into public.shared_workspaces (
      workspace_key,
      access_pin,
      data,
      created_at,
      updated_at
    ) values (
      normalized_key,
      p_access_pin,
      p_data,
      now(),
      now()
    );
    created_new := true;
  else
    if row_data.access_pin <> p_access_pin then
      return jsonb_build_object('ok', false, 'error', 'INVALID_PIN');
    end if;

    update public.shared_workspaces
    set data = p_data,
        updated_at = now()
    where workspace_key = normalized_key;
  end if;

  return jsonb_build_object('ok', true, 'created', created_new, 'workspace_key', normalized_key, 'updated_at', now());
end;
$$;

grant execute on function public.get_shared_workspace(text, text) to anon;
grant execute on function public.save_shared_workspace(text, text, jsonb) to anon;
grant execute on function public.get_shared_workspace(text, text) to authenticated;
grant execute on function public.save_shared_workspace(text, text, jsonb) to authenticated;
