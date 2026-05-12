create table if not exists public.shared_workspaces (
  workspace_key text primary key,
  access_pin text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_workspaces enable row level security;

revoke all on public.shared_workspaces from public;
revoke all on public.shared_workspaces from anon;
revoke all on public.shared_workspaces from authenticated;

drop function if exists public.get_shared_workspace(text, text);
create or replace function public.get_shared_workspace(p_workspace_key text, p_access_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.shared_workspaces%rowtype;
  normalized_key text := upper(regexp_replace(coalesce(p_workspace_key, ''), '[^A-Za-z0-9_-]', '', 'g'));
begin
  select * into row_data from public.shared_workspaces where workspace_key = normalized_key;
  if not found or row_data.access_pin <> p_access_pin then
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID';
  end if;
  return jsonb_set(coalesce(row_data.data, '{}'::jsonb), '{updated_at}', to_jsonb(row_data.updated_at), true);
end;
$$;

drop function if exists public.save_shared_workspace(text, text, jsonb);
create or replace function public.save_shared_workspace(p_workspace_key text, p_access_pin text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.shared_workspaces%rowtype;
  normalized_key text := upper(regexp_replace(coalesce(p_workspace_key, ''), '[^A-Za-z0-9_-]', '', 'g'));
  stamped_at timestamptz := now();
  stamped_data jsonb := jsonb_set(p_data, '{updated_at}', to_jsonb(now()), true);
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'INVALID_DATA';
  end if;
  select * into row_data from public.shared_workspaces where workspace_key = normalized_key for update;
  if not found then
    insert into public.shared_workspaces (workspace_key, access_pin, data, created_at, updated_at)
    values (normalized_key, p_access_pin, stamped_data, stamped_at, stamped_at);
  elsif row_data.access_pin = p_access_pin then
    update public.shared_workspaces set data = stamped_data, updated_at = stamped_at where workspace_key = normalized_key;
  else
    raise exception 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID';
  end if;
  return stamped_data;
end;
$$;

revoke execute on function public.get_shared_workspace(text, text) from public;
revoke execute on function public.save_shared_workspace(text, text, jsonb) from public;
revoke execute on function public.get_shared_workspace(text, text) from anon;
revoke execute on function public.save_shared_workspace(text, text, jsonb) from anon;

grant execute on function public.get_shared_workspace(text, text) to anon;
grant execute on function public.save_shared_workspace(text, text, jsonb) to anon;
