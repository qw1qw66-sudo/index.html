-- 0002_payment_ledger.sql
-- Payment ledger foundation for the chalet booking app.
-- Requires 0001_atomic_workspace_save.sql (uses public.workspace_auth).
--
-- Money is stored EXCLUSIVELY as integer minor units: amount_halalas bigint,
-- 1 SAR = 100 halalas (1,000 SAR = 100000 halalas). No float money anywhere.
--
-- The ledger (payment_transactions) is the financial source of truth.
-- booking.paid inside the workspace JSON document is a display/compat field.
--
-- ADDITIVE ONLY. PREPARED, NOT EXECUTED against production by this branch.

begin;

create extension if not exists pgcrypto with schema public;

-- ============================================================================
-- 1. Helpers
-- ============================================================================

-- Strict riyal -> halala conversion. Rejects sub-halala precision instead of
-- rounding silently (audit AUD-011): 12.345 riyals is an error, not 1234 or
-- 1235 halalas.
create or replace function public.riyals_to_halalas(p_riyals numeric)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v numeric;
begin
  if p_riyals is null then
    return null;
  end if;
  v := p_riyals * 100;
  if v <> round(v) then
    raise exception 'AMBIGUOUS_AMOUNT_PRECISION' using errcode = '22023';
  end if;
  return round(v)::bigint;
end;
$$;

-- Fetch one booking object out of the workspace document (server-side read
-- of the authoritative store; no browser-supplied booking data is trusted).
create or replace function public.booking_from_workspace(
  p_workspace_key text,
  p_booking_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select b
  from public.shared_workspaces w,
       jsonb_array_elements(coalesce(w.data->'bookings', '[]'::jsonb)) b
  where w.workspace_key = p_workspace_key
    and b->>'id' = p_booking_id
  limit 1;
$$;

-- ============================================================================
-- 2. payment_orders — payment links / provider checkout sessions
-- ============================================================================

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  booking_id text not null,           -- UUID string from the JSON document; no FK possible
  provider text not null,
  provider_order_id text,
  amount_halalas bigint not null,
  currency text not null default 'SAR',
  status text not null default 'pending',
  payment_url text,
  expires_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_orders_amount_positive check (amount_halalas > 0),
  constraint payment_orders_currency_supported check (currency = 'SAR'),
  constraint payment_orders_status_allowed check (
    status in ('pending', 'paid', 'partially_paid', 'failed', 'expired', 'cancelled')
  ),
  constraint payment_orders_booking_id_format check (length(booking_id) between 1 and 128),
  constraint payment_orders_idempotency_unique unique (idempotency_key)
);

create unique index if not exists payment_orders_provider_ref_unique
  on public.payment_orders (provider, provider_order_id)
  where provider_order_id is not null;

create index if not exists payment_orders_booking_idx
  on public.payment_orders (workspace_key, booking_id);

-- At most one ACTIVE (pending, unexpired) order per booking at a time.
create unique index if not exists payment_orders_one_active_per_booking
  on public.payment_orders (workspace_key, booking_id)
  where status = 'pending';

-- Status transition whitelist + column immutability for orders.
create or replace function public.payment_orders_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'PAYMENT_ORDERS_ARE_IMMUTABLE' using errcode = '55000';
  end if;

  -- Financial identity of an order can never change.
  if new.id <> old.id
     or new.workspace_key <> old.workspace_key
     or new.booking_id <> old.booking_id
     or new.provider <> old.provider
     or new.amount_halalas <> old.amount_halalas
     or new.currency <> old.currency
     or new.idempotency_key <> old.idempotency_key
     or new.created_at <> old.created_at then
    raise exception 'PAYMENT_ORDER_FIELDS_IMMUTABLE' using errcode = '55000';
  end if;

  -- provider_order_id / payment_url / expires_at may be set once (from null)
  -- when the provider session is attached after row creation.
  if old.provider_order_id is not null and new.provider_order_id is distinct from old.provider_order_id then
    raise exception 'PAYMENT_ORDER_FIELDS_IMMUTABLE' using errcode = '55000';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'pending' and new.status in ('paid', 'partially_paid', 'failed', 'expired', 'cancelled'))
      or (old.status = 'partially_paid' and new.status in ('paid', 'expired', 'cancelled'))
    ) then
      raise exception 'PAYMENT_ORDER_STATUS_TRANSITION_FORBIDDEN: % -> %', old.status, new.status
        using errcode = '55000';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_orders_guard_trg on public.payment_orders;
create trigger payment_orders_guard_trg
before update or delete on public.payment_orders
for each row execute function public.payment_orders_guard();

-- ============================================================================
-- 3. payment_transactions — the immutable financial ledger
-- ============================================================================

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid references public.payment_orders(id),
  workspace_key text not null references public.shared_workspaces(workspace_key),
  booking_id text not null,
  transaction_type text not null,
  payment_method text not null default 'provider',
  direction text not null default 'in',
  amount_halalas bigint not null,
  currency text not null default 'SAR',
  provider text,
  provider_transaction_id text,
  status text not null default 'succeeded',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,

  constraint payment_tx_type_allowed check (
    transaction_type in ('payment', 'manual_payment', 'refund', 'adjustment', 'legacy_opening_balance')
  ),
  constraint payment_tx_method_allowed check (
    payment_method in ('provider', 'cash', 'bank_transfer', 'pos', 'worker', 'other')
  ),
  constraint payment_tx_direction_allowed check (direction in ('in', 'out')),
  -- Stored amounts are never negative; refunds are direction='out' rows.
  constraint payment_tx_amount_non_negative check (amount_halalas >= 0),
  constraint payment_tx_currency_supported check (currency = 'SAR'),
  constraint payment_tx_status_allowed check (status in ('succeeded', 'pending', 'failed')),
  constraint payment_tx_booking_id_format check (length(booking_id) between 1 and 128),
  -- Direction must match type semantics.
  constraint payment_tx_direction_matches_type check (
    (transaction_type in ('payment', 'manual_payment', 'legacy_opening_balance') and direction = 'in')
    or (transaction_type = 'refund' and direction = 'out')
    or (transaction_type = 'adjustment')
  ),
  constraint payment_tx_idempotency_unique unique (idempotency_key)
);

create unique index if not exists payment_tx_provider_ref_unique
  on public.payment_transactions (provider, provider_transaction_id)
  where provider_transaction_id is not null;

create index if not exists payment_tx_booking_idx
  on public.payment_transactions (workspace_key, booking_id, occurred_at);

-- Immutability: corrections are NEW rows (adjustment/refund), never edits.
-- Sole allowed update: settlement of a pending row to succeeded/failed
-- (webhook confirmation), touching status only.
create or replace function public.payment_transactions_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'LEDGER_ROWS_ARE_IMMUTABLE' using errcode = '55000';
  end if;

  if new.id <> old.id
     or new.payment_order_id is distinct from old.payment_order_id
     or new.workspace_key <> old.workspace_key
     or new.booking_id <> old.booking_id
     or new.transaction_type <> old.transaction_type
     or new.payment_method <> old.payment_method
     or new.direction <> old.direction
     or new.amount_halalas <> old.amount_halalas
     or new.currency <> old.currency
     or new.provider is distinct from old.provider
     or new.provider_transaction_id is distinct from old.provider_transaction_id
     or new.occurred_at <> old.occurred_at
     or new.created_at <> old.created_at
     or new.idempotency_key is distinct from old.idempotency_key
     or new.metadata <> old.metadata then
    raise exception 'LEDGER_ROWS_ARE_IMMUTABLE' using errcode = '55000';
  end if;

  if new.status <> old.status
     and not (old.status = 'pending' and new.status in ('succeeded', 'failed')) then
    raise exception 'LEDGER_STATUS_TRANSITION_FORBIDDEN: % -> %', old.status, new.status
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists payment_transactions_guard_trg on public.payment_transactions;
create trigger payment_transactions_guard_trg
before update or delete on public.payment_transactions
for each row execute function public.payment_transactions_guard();

-- ============================================================================
-- 4. payment_webhook_events — raw provider events, replay-safe
-- ============================================================================

create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  signature_valid boolean not null,
  processing_status text not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,

  constraint payment_webhook_status_allowed check (
    processing_status in ('received', 'processed', 'skipped_duplicate', 'failed')
  ),
  -- Duplicate deliveries collide here and are recorded as skipped_duplicate.
  constraint payment_webhook_event_unique unique (provider, provider_event_id)
);

create index if not exists payment_webhook_received_idx
  on public.payment_webhook_events (provider, received_at);

create or replace function public.payment_webhook_events_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'WEBHOOK_EVENTS_ARE_IMMUTABLE' using errcode = '55000';
  end if;
  if new.id <> old.id
     or new.provider <> old.provider
     or new.provider_event_id <> old.provider_event_id
     or new.event_type <> old.event_type
     or new.payload <> old.payload
     or new.signature_valid <> old.signature_valid
     or new.received_at <> old.received_at then
    raise exception 'WEBHOOK_EVENT_FIELDS_IMMUTABLE' using errcode = '55000';
  end if;
  if new.processing_status <> old.processing_status
     and not (old.processing_status = 'received'
              and new.processing_status in ('processed', 'skipped_duplicate', 'failed')) then
    raise exception 'WEBHOOK_STATUS_TRANSITION_FORBIDDEN: % -> %',
      old.processing_status, new.processing_status using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_webhook_events_guard_trg on public.payment_webhook_events;
create trigger payment_webhook_events_guard_trg
before update or delete on public.payment_webhook_events
for each row execute function public.payment_webhook_events_guard();

-- ============================================================================
-- 5. payment_audit_log — manual/administrative action trail
-- ============================================================================
-- Documented limitation: the app has one shared PIN per workspace, so
-- actor_label is an operator-supplied name, not a verified identity.

create table if not exists public.payment_audit_log (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  booking_id text,
  transaction_id uuid,
  actor_label text not null default '',
  action text not null,
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.payment_audit_log enable row level security;

create or replace function public.payment_audit_log_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'AUDIT_ROWS_ARE_IMMUTABLE' using errcode = '55000';
end;
$$;

drop trigger if exists payment_audit_log_guard_trg on public.payment_audit_log;
create trigger payment_audit_log_guard_trg
before update or delete on public.payment_audit_log
for each row execute function public.payment_audit_log_guard();

-- ============================================================================
-- 6. RLS + grants: RPC/service-role only (no direct browser table access)
-- ============================================================================

alter table public.payment_orders enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_webhook_events enable row level security;

revoke all on table public.payment_orders from public, anon, authenticated;
revoke all on table public.payment_transactions from public, anon, authenticated;
revoke all on table public.payment_webhook_events from public, anon, authenticated;
revoke all on table public.payment_audit_log from public, anon, authenticated;

-- ============================================================================
-- 7. Derived totals — the ONLY sanctioned way to read "paid"
-- ============================================================================

create or replace view public.v_booking_payment_totals as
select
  t.workspace_key,
  t.booking_id,
  coalesce(sum(t.amount_halalas) filter (
    where t.status = 'succeeded' and t.direction = 'in'), 0)::bigint as gross_paid_halalas,
  coalesce(sum(t.amount_halalas) filter (
    where t.status = 'succeeded' and t.direction = 'out'), 0)::bigint as refunded_halalas,
  (coalesce(sum(t.amount_halalas) filter (
    where t.status = 'succeeded' and t.direction = 'in'), 0)
   - coalesce(sum(t.amount_halalas) filter (
    where t.status = 'succeeded' and t.direction = 'out'), 0))::bigint as net_paid_halalas,
  count(*) filter (where t.status = 'pending')::integer as pending_tx_count,
  max(t.occurred_at) as last_activity_at
from public.payment_transactions t
group by t.workspace_key, t.booking_id;

revoke all on public.v_booking_payment_totals from public, anon, authenticated;

-- Payment state derivation. Single source of truth in SQL; mirrored by
-- supabase/functions/_shared/ledger-core.mjs for JS callers (unit tested).
create or replace function public.derive_payment_state(
  p_total_halalas bigint,
  p_gross_paid_halalas bigint,
  p_refunded_halalas bigint,
  p_net_paid_halalas bigint,
  p_has_pending_order boolean,
  p_last_order_status text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_refunded_halalas > 0 and p_net_paid_halalas = 0 and p_gross_paid_halalas > 0 then
    return 'refunded';
  elsif p_refunded_halalas > 0 and p_net_paid_halalas > 0 then
    return 'partially_refunded';
  elsif p_total_halalas > 0 and p_net_paid_halalas >= p_total_halalas then
    return 'paid';
  elsif p_net_paid_halalas > 0 then
    return 'partially_paid';
  elsif p_has_pending_order then
    return 'pending';
  elsif p_last_order_status = 'failed' then
    return 'failed';
  elsif p_last_order_status = 'expired' then
    return 'expired';
  else
    return 'unpaid';
  end if;
end;
$$;

-- ============================================================================
-- 8. RPC: record_manual_payment (cash / bank transfer / POS / worker)
-- ============================================================================

create or replace function public.record_manual_payment(
  p_workspace_key text,
  p_access_pin text,
  p_booking_id text,
  p_amount_halalas bigint,
  p_payment_method text,
  p_actor_label text default '',
  p_reason text default '',
  p_occurred_at timestamptz default now(),
  p_idempotency_key text default null,
  p_allow_over_collection boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth record;
  v_booking jsonb;
  v_total_halalas bigint;
  v_totals record;
  v_remaining bigint;
  v_tx public.payment_transactions%rowtype;
  v_idem text;
begin
  select * into v_auth from public.workspace_auth(p_workspace_key, p_access_pin);
  if not v_auth.ok then
    return jsonb_build_object('ok', false, 'error', v_auth.error_code);
  end if;

  if p_amount_halalas is null or p_amount_halalas <= 0 then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_MUST_BE_POSITIVE');
  end if;
  if p_payment_method not in ('cash', 'bank_transfer', 'pos', 'worker', 'other') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PAYMENT_METHOD');
  end if;
  if p_payment_method = 'bank_transfer' and btrim(coalesce(p_reason, '')) = '' then
    return jsonb_build_object('ok', false, 'error', 'REFERENCE_REQUIRED_FOR_BANK_TRANSFER');
  end if;

  -- Lock the workspace row: serializes concurrent manual payments for the
  -- same workspace so remaining-balance checks cannot race each other.
  perform 1 from public.shared_workspaces
   where workspace_key = v_auth.workspace_key for update;

  v_booking := public.booking_from_workspace(v_auth.workspace_key, p_booking_id);
  if v_booking is null then
    return jsonb_build_object('ok', false, 'error', 'BOOKING_NOT_FOUND');
  end if;
  if coalesce(v_booking->>'deleted_at', '') not in ('', 'null') then
    return jsonb_build_object('ok', false, 'error', 'BOOKING_DELETED');
  end if;
  if coalesce(v_booking->>'status', '') = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'BOOKING_CANCELLED');
  end if;

  begin
    v_total_halalas := public.riyals_to_halalas((v_booking->>'total')::numeric);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'BOOKING_TOTAL_INVALID');
  end;

  select * into v_totals
  from public.v_booking_payment_totals
  where workspace_key = v_auth.workspace_key and booking_id = p_booking_id;

  v_remaining := greatest(0, v_total_halalas - coalesce(v_totals.net_paid_halalas, 0));

  if p_amount_halalas > v_remaining and not p_allow_over_collection then
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_EXCEEDS_REMAINING',
                              'remaining_halalas', v_remaining);
  end if;

  v_idem := coalesce(p_idempotency_key,
                     'manual:' || v_auth.workspace_key || ':' || p_booking_id || ':' || gen_random_uuid());

  begin
    insert into public.payment_transactions
      (workspace_key, booking_id, transaction_type, payment_method, direction,
       amount_halalas, status, occurred_at, idempotency_key, metadata)
    values
      (v_auth.workspace_key, p_booking_id, 'manual_payment', p_payment_method, 'in',
       p_amount_halalas, 'succeeded', coalesce(p_occurred_at, now()), v_idem,
       jsonb_build_object('actor_label', left(coalesce(p_actor_label, ''), 120),
                          'reason', left(coalesce(p_reason, ''), 500),
                          'over_collection', p_amount_halalas > v_remaining))
    returning * into v_tx;
  exception when unique_violation then
    -- Idempotent retry: return the already-recorded transaction.
    select * into v_tx from public.payment_transactions where idempotency_key = v_idem;
    return jsonb_build_object('ok', true, 'duplicate', true, 'transaction_id', v_tx.id);
  end;

  insert into public.payment_audit_log
    (workspace_key, booking_id, transaction_id, actor_label, action, reason, metadata)
  values
    (v_auth.workspace_key, p_booking_id, v_tx.id,
     left(coalesce(p_actor_label, ''), 120), 'record_manual_payment',
     left(coalesce(p_reason, ''), 500),
     jsonb_build_object('amount_halalas', p_amount_halalas,
                        'payment_method', p_payment_method,
                        'over_collection', p_amount_halalas > v_remaining));

  return public.get_booking_payment_summary(v_auth.workspace_key, p_booking_id)
         || jsonb_build_object('transaction_id', v_tx.id);
end;
$$;

-- ============================================================================
-- 9. RPC: get_booking_payments + internal summary helper
-- ============================================================================

-- Internal (not granted): summary for one booking from the ledger.
create or replace function public.get_booking_payment_summary(
  p_workspace_key text,
  p_booking_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_booking jsonb;
  v_total_halalas bigint := null;
  v_totals record;
  v_has_pending_order boolean;
  v_last_order_status text;
  v_state text;
begin
  v_booking := public.booking_from_workspace(p_workspace_key, p_booking_id);
  if v_booking is not null then
    begin
      v_total_halalas := public.riyals_to_halalas((v_booking->>'total')::numeric);
    exception when others then
      v_total_halalas := null;
    end;
  end if;

  select * into v_totals
  from public.v_booking_payment_totals
  where workspace_key = p_workspace_key and booking_id = p_booking_id;

  select exists(
    select 1 from public.payment_orders
    where workspace_key = p_workspace_key and booking_id = p_booking_id
      and status = 'pending' and (expires_at is null or expires_at > now())
  ) into v_has_pending_order;

  select status into v_last_order_status
  from public.payment_orders
  where workspace_key = p_workspace_key and booking_id = p_booking_id
  order by created_at desc limit 1;

  v_state := public.derive_payment_state(
    coalesce(v_total_halalas, 0),
    coalesce(v_totals.gross_paid_halalas, 0),
    coalesce(v_totals.refunded_halalas, 0),
    coalesce(v_totals.net_paid_halalas, 0),
    v_has_pending_order,
    v_last_order_status
  );

  return jsonb_build_object(
    'ok', true,
    'booking_id', p_booking_id,
    'booking_total_halalas', v_total_halalas,
    'gross_paid_halalas', coalesce(v_totals.gross_paid_halalas, 0),
    'refunded_halalas', coalesce(v_totals.refunded_halalas, 0),
    'net_paid_halalas', coalesce(v_totals.net_paid_halalas, 0),
    'remaining_halalas', greatest(0, coalesce(v_total_halalas, 0) - coalesce(v_totals.net_paid_halalas, 0)),
    'payment_state', v_state
  );
end;
$$;

create or replace function public.get_booking_payments(
  p_workspace_key text,
  p_access_pin text,
  p_booking_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_auth record;
  v_transactions jsonb;
begin
  select * into v_auth from public.workspace_auth(p_workspace_key, p_access_pin);
  if not v_auth.ok then
    return jsonb_build_object('ok', false, 'error', v_auth.error_code);
  end if;

  -- Only rows of THIS workspace + booking. Safe fields only: no raw webhook
  -- payloads, no provider secrets, metadata restricted to whitelisted keys.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'transaction_type', t.transaction_type,
    'payment_method', t.payment_method,
    'direction', t.direction,
    'amount_halalas', t.amount_halalas,
    'currency', t.currency,
    'status', t.status,
    'occurred_at', t.occurred_at,
    'provider', t.provider,
    'provider_reference', left(coalesce(t.provider_transaction_id, ''), 24),
    'actor_label', coalesce(t.metadata->>'actor_label', ''),
    'reason', coalesce(t.metadata->>'reason', '')
  ) order by t.occurred_at, t.created_at), '[]'::jsonb)
  into v_transactions
  from public.payment_transactions t
  where t.workspace_key = v_auth.workspace_key
    and t.booking_id = p_booking_id;

  return public.get_booking_payment_summary(v_auth.workspace_key, p_booking_id)
         || jsonb_build_object('transactions', v_transactions);
end;
$$;

-- ============================================================================
-- 10. RPC: reconcile_booking_payment
-- ============================================================================
-- Recomputes derived state from the ledger. Optional explicit write-back of
-- booking.paid (in riyals) into the workspace document for legacy display
-- compatibility — never automatic, uses the same locked row as saves.

create or replace function public.reconcile_booking_payment(
  p_workspace_key text,
  p_access_pin text,
  p_booking_id text,
  p_write_back boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth record;
  v_summary jsonb;
  v_workspace public.shared_workspaces%rowtype;
  v_bookings jsonb;
  v_new_bookings jsonb := '[]'::jsonb;
  v_item jsonb;
  v_found boolean := false;
  v_net_riyals numeric;
  v_now timestamptz;
begin
  select * into v_auth from public.workspace_auth(p_workspace_key, p_access_pin);
  if not v_auth.ok then
    return jsonb_build_object('ok', false, 'error', v_auth.error_code);
  end if;

  v_summary := public.get_booking_payment_summary(v_auth.workspace_key, p_booking_id);

  if not p_write_back then
    return v_summary || jsonb_build_object('written_back', false);
  end if;

  v_net_riyals := (v_summary->>'net_paid_halalas')::numeric / 100;
  v_now := statement_timestamp();

  select * into v_workspace
  from public.shared_workspaces
  where workspace_key = v_auth.workspace_key
  for update;

  v_bookings := coalesce(v_workspace.data->'bookings', '[]'::jsonb);
  for v_item in select * from jsonb_array_elements(v_bookings) loop
    if v_item->>'id' = p_booking_id then
      v_found := true;
      v_item := jsonb_set(v_item, '{paid}', to_jsonb(v_net_riyals));
      v_item := jsonb_set(v_item, '{updated_at}', to_jsonb(v_now));
    end if;
    v_new_bookings := v_new_bookings || v_item;
  end loop;

  if not v_found then
    return v_summary || jsonb_build_object('written_back', false, 'error', 'BOOKING_NOT_FOUND');
  end if;

  update public.shared_workspaces
  set data = jsonb_set(v_workspace.data, '{bookings}', v_new_bookings),
      updated_at = v_now
  where workspace_key = v_auth.workspace_key;

  insert into public.workspace_save_audit
    (workspace_key, action, prev_updated_at, new_updated_at, chalet_count, booking_count, doc_hash_prefix)
  values
    (v_auth.workspace_key, 'reconcile_write_back', v_workspace.updated_at, v_now,
     coalesce(jsonb_array_length(v_workspace.data->'chalets'), 0),
     coalesce(jsonb_array_length(v_new_bookings), 0),
     left(md5(v_new_bookings::text), 12));

  insert into public.payment_audit_log
    (workspace_key, booking_id, actor_label, action, reason, metadata)
  values
    (v_auth.workspace_key, p_booking_id, '', 'reconcile_write_back', '',
     jsonb_build_object('net_paid_halalas', v_summary->>'net_paid_halalas'));

  return v_summary || jsonb_build_object('written_back', true, 'updated_at', v_now);
end;
$$;

-- ============================================================================
-- 11. Grants — RPC-only surface for anon; internals not exposed
-- ============================================================================

revoke all on function public.riyals_to_halalas(numeric) from public, anon, authenticated;
revoke all on function public.booking_from_workspace(text, text) from public, anon, authenticated;
revoke all on function public.get_booking_payment_summary(text, text) from public, anon, authenticated;
revoke all on function public.derive_payment_state(bigint, bigint, bigint, bigint, boolean, text) from public, anon, authenticated;
revoke all on function public.payment_orders_guard() from public, anon, authenticated;
revoke all on function public.payment_transactions_guard() from public, anon, authenticated;
revoke all on function public.payment_webhook_events_guard() from public, anon, authenticated;
revoke all on function public.payment_audit_log_guard() from public, anon, authenticated;

revoke all on function public.record_manual_payment(text, text, text, bigint, text, text, text, timestamptz, text, boolean) from public, authenticated;
revoke all on function public.get_booking_payments(text, text, text) from public, authenticated;
revoke all on function public.reconcile_booking_payment(text, text, text, boolean) from public, authenticated;

grant execute on function public.record_manual_payment(text, text, text, bigint, text, text, text, timestamptz, text, boolean) to anon;
grant execute on function public.get_booking_payments(text, text, text) to anon;
grant execute on function public.reconcile_booking_payment(text, text, text, boolean) to anon;

commit;

-- ============================================================================
-- ROLLBACK (manual; additive objects only)
-- ============================================================================
-- NOTE: payment tables contain financial history once used. pg_dump them
-- before dropping anything.
-- drop function if exists public.reconcile_booking_payment(text, text, text, boolean);
-- drop function if exists public.get_booking_payments(text, text, text);
-- drop function if exists public.get_booking_payment_summary(text, text);
-- drop function if exists public.record_manual_payment(text, text, text, bigint, text, text, text, timestamptz, text, boolean);
-- drop function if exists public.derive_payment_state(bigint, bigint, bigint, bigint, boolean, text);
-- drop view if exists public.v_booking_payment_totals;
-- drop table if exists public.payment_audit_log cascade;
-- drop table if exists public.payment_webhook_events cascade;
-- drop table if exists public.payment_transactions cascade;
-- drop table if exists public.payment_orders cascade;
-- drop function if exists public.payment_audit_log_guard();
-- drop function if exists public.payment_webhook_events_guard();
-- drop function if exists public.payment_transactions_guard();
-- drop function if exists public.payment_orders_guard();
-- drop function if exists public.booking_from_workspace(text, text);
-- drop function if exists public.riyals_to_halalas(numeric);
