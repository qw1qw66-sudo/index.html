-- Secure cloud sync for Chalet Booking System
-- Uses Supabase Auth. Users own data by auth.uid(), not by raw email.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.user_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  data_key text not null,
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null,
  unique(user_id, data_key)
);

create table if not exists public.sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  data_key text,
  created_at timestamptz default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists user_data_set_updated_at on public.user_data;
create trigger user_data_set_updated_at
before update on public.user_data
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_data enable row level security;
alter table public.sync_log enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select to authenticated
using (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert to authenticated
with check (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
for delete to authenticated
using (id = auth.uid());

drop policy if exists user_data_select_own on public.user_data;
create policy user_data_select_own on public.user_data
for select to authenticated
using (user_id = auth.uid());

drop policy if exists user_data_insert_own on public.user_data;
create policy user_data_insert_own on public.user_data
for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists user_data_update_own on public.user_data;
create policy user_data_update_own on public.user_data
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists user_data_delete_own on public.user_data;
create policy user_data_delete_own on public.user_data
for delete to authenticated
using (user_id = auth.uid());

drop policy if exists sync_log_select_own on public.sync_log;
create policy sync_log_select_own on public.sync_log
for select to authenticated
using (user_id = auth.uid());

drop policy if exists sync_log_insert_own on public.sync_log;
create policy sync_log_insert_own on public.sync_log
for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists sync_log_update_own on public.sync_log;
create policy sync_log_update_own on public.sync_log
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists sync_log_delete_own on public.sync_log;
create policy sync_log_delete_own on public.sync_log
for delete to authenticated
using (user_id = auth.uid());
