# Data Safety Policy

## Non-negotiable rules

1. No seed data before cloud pull.
2. No automatic push on app boot.
3. No push before a successful workspace pull.
4. No email login, Magic Link, SMTP, or Supabase Auth session for the final app.
5. No recovery page as the production user interface.
6. No overwrite of existing cloud data with an empty local state.
7. Backup local state before any cloud push.
8. Backup local state before any JSON import.
9. JSON import never pushes automatically.
10. Old experimental links should not be given to users.

## Empty overwrite guard

Before calling `save_shared_workspace`, the app compares current local counts with the last cloud counts. If the current state has zero active chalets and zero active bookings while the last cloud state had data, the upload is blocked.

## Large data reduction guard

If the current local booking count is much lower than the last cloud booking count, the app requires a typed confirmation before upload.

## What local cache means

Local storage is cache only. The source of truth is the workspace JSON returned by Supabase RPC.

## Import behavior

Importing a JSON file updates the screen/local cache only. It never uploads until the user explicitly clicks upload and passes the safety checks.
