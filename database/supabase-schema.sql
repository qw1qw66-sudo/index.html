-- Production Supabase schema for Arabic chalet booking PWA
-- Run this in Supabase SQL Editor.
-- Security: ownership is auth.uid(); email-only ownership is intentionally not used.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.chalets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  capacity integer default 1,
  price numeric default 0,
  description text default '',
  color integer default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz null
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chalet_id uuid not null references public.chalets(id) on delete cascade,
  booking_no text,
  customer_name text not null,
  customer_phone text not null,
  check_in date not null,
  check_out date not null,
  nights integer not null,
  guests integer default 1,
  total numeric default 0,
  paid numeric default 0,
  status text not null default 'confirmed',
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz null,
  constraint bookings_valid_dates check (check_out > check_in),
  constraint bookings_valid_nights check (nights > 0),
  constraint bookings_valid_guests check (guests >= 1),
  constraint bookings_valid_status check (status in ('confirmed','pending','cancelled','completed'))
);

create table if not exists public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists public.sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists chalets_user_idx on public.chalets(user_id);
create index if not exists bookings_user_idx on public.bookings(user_id);
create index if not exists bookings_chalet_dates_idx on public.bookings(chalet_id, check_in, check_out);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists chalets_set_updated_at on public.chalets;
create trigger chalets_set_updated_at before update on public.chalets for each row execute function public.set_updated_at();
drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at before update on public.bookings for each row execute function public.set_updated_at();
drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at before update on public.app_settings for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.chalets enable row level security;
alter table public.bookings enable row level security;
alter table public.app_settings enable row level security;
alter table public.sync_log enable row level security;

drop policy if exists profiles_own_select on public.profiles;
create policy profiles_own_select on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists profiles_own_insert on public.profiles;
create policy profiles_own_insert on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_own_delete on public.profiles;
create policy profiles_own_delete on public.profiles for delete to authenticated using (id = auth.uid());

drop policy if exists chalets_own_select on public.chalets;
create policy chalets_own_select on public.chalets for select to authenticated using (user_id = auth.uid());
drop policy if exists chalets_own_insert on public.chalets;
create policy chalets_own_insert on public.chalets for insert to authenticated with check (user_id = auth.uid());
drop policy if exists chalets_own_update on public.chalets;
create policy chalets_own_update on public.chalets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists chalets_own_delete on public.chalets;
create policy chalets_own_delete on public.chalets for delete to authenticated using (user_id = auth.uid());

drop policy if exists bookings_own_select on public.bookings;
create policy bookings_own_select on public.bookings for select to authenticated using (user_id = auth.uid());
drop policy if exists bookings_own_insert on public.bookings;
create policy bookings_own_insert on public.bookings for insert to authenticated with check (user_id = auth.uid());
drop policy if exists bookings_own_update on public.bookings;
create policy bookings_own_update on public.bookings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists bookings_own_delete on public.bookings;
create policy bookings_own_delete on public.bookings for delete to authenticated using (user_id = auth.uid());

drop policy if exists app_settings_own_select on public.app_settings;
create policy app_settings_own_select on public.app_settings for select to authenticated using (user_id = auth.uid());
drop policy if exists app_settings_own_insert on public.app_settings;
create policy app_settings_own_insert on public.app_settings for insert to authenticated with check (user_id = auth.uid());
drop policy if exists app_settings_own_update on public.app_settings;
create policy app_settings_own_update on public.app_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists app_settings_own_delete on public.app_settings;
create policy app_settings_own_delete on public.app_settings for delete to authenticated using (user_id = auth.uid());

drop policy if exists sync_log_own_select on public.sync_log;
create policy sync_log_own_select on public.sync_log for select to authenticated using (user_id = auth.uid());
drop policy if exists sync_log_own_insert on public.sync_log;
create policy sync_log_own_insert on public.sync_log for insert to authenticated with check (user_id = auth.uid());
drop policy if exists sync_log_own_update on public.sync_log;
create policy sync_log_own_update on public.sync_log for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sync_log_own_delete on public.sync_log;
create policy sync_log_own_delete on public.sync_log for delete to authenticated using (user_id = auth.uid());
