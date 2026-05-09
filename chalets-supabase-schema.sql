-- Chalet Booking System Cloud Sync schema for Supabase
-- Run this file in Supabase SQL Editor.

create table if not exists public.chalets_booking_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chalets_booking_state enable row level security;

create or replace function public.chalets_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists chalets_booking_state_set_updated_at on public.chalets_booking_state;
create trigger chalets_booking_state_set_updated_at
before update on public.chalets_booking_state
for each row
execute function public.chalets_set_updated_at();

drop policy if exists "chalets select own state" on public.chalets_booking_state;
create policy "chalets select own state"
on public.chalets_booking_state
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "chalets insert own state" on public.chalets_booking_state;
create policy "chalets insert own state"
on public.chalets_booking_state
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "chalets update own state" on public.chalets_booking_state;
create policy "chalets update own state"
on public.chalets_booking_state
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
