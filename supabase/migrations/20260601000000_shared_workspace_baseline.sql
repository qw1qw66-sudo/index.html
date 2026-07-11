-- Shared workspace sync backend
-- RPC-only access model for the Arabic chalet booking app.
-- Do not expose public table access. Clients must use the RPC functions only.

begin;

create extension if not exists pgcrypto with schema public;

create table if not exists public.shared_workspaces (
  workspace_key text primary key,
  pin_hash text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_workspaces_workspace_key_format check (
    workspace_key = upper(workspace_key)
    and workspace_key ~ '^[A-Z0-9_-]{3,64}$'
  )
);

-- Safe migration guard for older drafts that stored the PIN as plaintext.
alter table public.shared_workspaces add column if not exists pin_hash text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shared_workspaces'
      and column_name = 'access_pin'
  ) then
    execute $sql$
      update public.shared_workspaces
      set pin_hash = crypt(access_pin, gen_salt('bf', 12))
      where pin_hash is null
        and access_pin is not null
    $sql$;

    execute 'alter table public.shared_workspaces drop column access_pin';
  end if;
end $$;

-- If a previous broken row has no hash, make it inaccessible instead of keeping a null secret.
update public.shared_workspaces
set pin_hash = crypt(gen_random_uuid()::text, gen_salt('bf', 12))
where pin_hash is null;

alter table public.shared_workspaces alter column pin_hash set not null;
alter table public.shared_workspaces alter column data set default '{}'::jsonb;
alter table public.shared_workspaces alter column created_at set default now();
alter table public.shared_workspaces alter column updated_at set default now();

alter table public.shared_workspaces enable row level security;

-- RPC-only: no direct table access for browser roles.
revoke all on table public.shared_workspaces from public;
revoke all on table public.shared_workspaces from anon;
revoke all on table public.shared_workspaces from authenticated;

-- Replace older insecure RPC definitions.
drop function if exists public.get_shared_workspace(text, text);
drop function if exists public.save_shared_workspace(text, text, jsonb);

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

  select *
  into v_workspace
  from public.shared_workspaces
  where workspace_key = v_workspace_key;

  if not found or crypt(v_pin, v_workspace.pin_hash) <> v_workspace.pin_hash then
    -- Same error for missing workspace and wrong PIN to avoid leaking existence.
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

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'INVALID_DATA' using errcode = '22023';
  end if;

  -- Do not trust client-side timestamps inside the workspace document.
  v_data := p_data - 'updated_at';
  v_updated_at := statement_timestamp();

  select *
  into v_workspace
  from public.shared_workspaces
  where workspace_key = v_workspace_key
  for update;

  if not found then
    insert into public.shared_workspaces (
      workspace_key,
      pin_hash,
      data,
      created_at,
      updated_at
    ) values (
      v_workspace_key,
      crypt(v_pin, gen_salt('bf', 12)),
      v_data,
      v_updated_at,
      v_updated_at
    )
    returning * into v_workspace;
  elsif crypt(v_pin, v_workspace.pin_hash) = v_workspace.pin_hash then
    update public.shared_workspaces
    set data = v_data,
        updated_at = v_updated_at
    where workspace_key = v_workspace_key
    returning * into v_workspace;
  else
    -- Same error shape as missing workspace. No existence leak.
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

-- Function execution is explicitly RPC-only for anon.
revoke all on function public.get_shared_workspace(text, text) from public;
revoke all on function public.get_shared_workspace(text, text) from authenticated;
revoke all on function public.get_shared_workspace(text, text) from anon;

revoke all on function public.save_shared_workspace(text, text, jsonb) from public;
revoke all on function public.save_shared_workspace(text, text, jsonb) from authenticated;
revoke all on function public.save_shared_workspace(text, text, jsonb) from anon;

grant execute on function public.get_shared_workspace(text, text) to anon;
grant execute on function public.save_shared_workspace(text, text, jsonb) to anon;

commit;
