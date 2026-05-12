# Architecture

## Final public surface

The only production entry point is:

```text
/app/
```

All legacy surfaces are excluded from the GitHub Pages artifact by `.github/workflows/pages.yml`.

## Sync flow

```text
Browser /app/
  → Supabase JS v2 with anon public key
  → RPC get_shared_workspace(workspace_key, pin)
  → one JSON document from shared_workspaces.data
  → local screen/cache
  → explicit user upload only
  → fresh RPC get_shared_workspace for updated_at check
  → RPC save_shared_workspace(workspace_key, pin, data)
```

There is no Supabase Auth session, no Magic Link, no OTP, no SMTP, and no `auth.uid()` tenancy.

## Database source of truth

```text
shared_workspaces (
  workspace_key text primary key,
  access_pin text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

The browser does not directly read or write `chalets`, `bookings`, `app_settings`, or `sync_log`.

## Canonical JSON model

```text
data.schema_version = 3
data.settings.facility_name
data.settings.tag
data.settings.holidays[]
data.chalets[]
data.chalets[].periods[]
data.bookings[]
```

Bookings use `booking_date + period_id`. `check_in`, `check_out`, and `nights` are not primary fields.

## Safety model

The app requires a successful pull before upload, blocks empty overwrites, requires typed confirmation for destructive count drops, writes local backup before upload, and checks cloud `updated_at` immediately before save.
