-- Production security baseline for chalet booking app.
-- Apply in Supabase SQL editor or via Supabase CLI after validating table names.

create extension if not exists btree_gist;

alter table if exists public.chalets enable row level security;
alter table if exists public.bookings enable row level security;
alter table if exists public.app_settings enable row level security;
alter table if exists public.sync_log enable row level security;

-- Ensure ownership columns cannot be omitted.
alter table if exists public.chalets alter column user_id set not null;
alter table if exists public.bookings alter column user_id set not null;
alter table if exists public.app_settings alter column user_id set not null;

-- Basic validation constraints. PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS,
-- so use DO blocks for safe/idempotent application.
do $$
begin
  if to_regclass('public.bookings') is not null and not exists (select 1 from pg_constraint where conname = 'bookings_valid_dates') then
    alter table public.bookings add constraint bookings_valid_dates check (check_out > check_in);
  end if;
  if to_regclass('public.bookings') is not null and not exists (select 1 from pg_constraint where conname = 'bookings_valid_guests') then
    alter table public.bookings add constraint bookings_valid_guests check (guests >= 1);
  end if;
  if to_regclass('public.bookings') is not null and not exists (select 1 from pg_constraint where conname = 'bookings_valid_money') then
    alter table public.bookings add constraint bookings_valid_money check (total >= 0 and paid >= 0);
  end if;
  if to_regclass('public.bookings') is not null and not exists (select 1 from pg_constraint where conname = 'bookings_status_allowed') then
    alter table public.bookings add constraint bookings_status_allowed check (status in ('confirmed','pending','cancelled','completed'));
  end if;
  if to_regclass('public.chalets') is not null and not exists (select 1 from pg_constraint where conname = 'chalets_valid_capacity') then
    alter table public.chalets add constraint chalets_valid_capacity check (capacity >= 1);
  end if;
  if to_regclass('public.chalets') is not null and not exists (select 1 from pg_constraint where conname = 'chalets_valid_price') then
    alter table public.chalets add constraint chalets_valid_price check (price >= 0);
  end if;
end $$;

-- Unique voucher/booking number per user. This prevents duplicate vouchers across devices.
create unique index if not exists bookings_user_booking_no_unique
on public.bookings(user_id, booking_no)
where deleted_at is null;

-- Critical: database-level confirmed-booking overlap protection.
-- This is the real protection against two devices booking the same chalet at the same time.
do $$
begin
  if to_regclass('public.bookings') is not null and not exists (select 1 from pg_constraint where conname = 'bookings_no_confirmed_overlap') then
    alter table public.bookings
      add constraint bookings_no_confirmed_overlap
      exclude using gist (
        user_id with =,
        chalet_id with =,
        daterange(check_in, check_out, '[)') with &&
      )
      where (status = 'confirmed' and deleted_at is null);
  end if;
end $$;

-- RLS: users can only access their own rows.
drop policy if exists chalets_select_own on public.chalets;
create policy chalets_select_own on public.chalets for select using (auth.uid() = user_id);

drop policy if exists chalets_insert_own on public.chalets;
create policy chalets_insert_own on public.chalets for insert with check (auth.uid() = user_id);

drop policy if exists chalets_update_own on public.chalets;
create policy chalets_update_own on public.chalets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists chalets_delete_own on public.chalets;
create policy chalets_delete_own on public.chalets for delete using (auth.uid() = user_id);

drop policy if exists bookings_select_own on public.bookings;
create policy bookings_select_own on public.bookings for select using (auth.uid() = user_id);

drop policy if exists bookings_insert_own on public.bookings;
create policy bookings_insert_own on public.bookings for insert with check (auth.uid() = user_id);

drop policy if exists bookings_update_own on public.bookings;
create policy bookings_update_own on public.bookings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists bookings_delete_own on public.bookings;
create policy bookings_delete_own on public.bookings for delete using (auth.uid() = user_id);

drop policy if exists settings_select_own on public.app_settings;
create policy settings_select_own on public.app_settings for select using (auth.uid() = user_id);

drop policy if exists settings_insert_own on public.app_settings;
create policy settings_insert_own on public.app_settings for insert with check (auth.uid() = user_id);

drop policy if exists settings_update_own on public.app_settings;
create policy settings_update_own on public.app_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists sync_log_select_own on public.sync_log;
create policy sync_log_select_own on public.sync_log for select using (auth.uid() = user_id);

drop policy if exists sync_log_insert_own on public.sync_log;
create policy sync_log_insert_own on public.sync_log for insert with check (auth.uid() = user_id);
