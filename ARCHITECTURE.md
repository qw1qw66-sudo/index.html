# Final Architecture

## Final public app

The only production app to use is:

```text
/sync-cloud/final.html
```

`app.html` redirects to this final app.

## Sync model

The app uses Supabase RPC only:

- `get_shared_workspace(p_workspace_key text, p_access_pin text)`
- `save_shared_workspace(p_workspace_key text, p_access_pin text, p_data jsonb)`

No email login, no Magic Link, no Supabase Auth session, no SMTP, and no user-based tables are required for the final app.

## Database table

The app expects one table:

```text
shared_workspaces
```

Columns:

- `workspace_key text primary key`
- `access_pin text`
- `data jsonb`
- `created_at timestamptz`
- `updated_at timestamptz`

## Data format

Workspace `data` is a JSON document with:

- `schema_version: 3`
- `settings`
- `chalets`
- `bookings`

Chalets own their voucher details and periods. Bookings reference a chalet and period.

## Important production rule

The app never creates seed chalets. If the cloud data is empty or invalid, the UI stays empty and shows a message.
