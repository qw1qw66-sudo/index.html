-- Chalet Booking System email-only cloud sync
-- Run this in Supabase SQL Editor

create table if not exists public.chalets_booking_state_email (
  sync_key text primary key,
  email_hint text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chalets_booking_state_email enable row level security;

create policy "email sync select"
on public.chalets_booking_state_email
for select
to anon, authenticated
using (true);

create policy "email sync insert"
on public.chalets_booking_state_email
for insert
to anon, authenticated
with check (sync_key is not null);

create policy "email sync update"
on public.chalets_booking_state_email
for update
to anon, authenticated
using (sync_key is not null)
with check (sync_key is not null);
