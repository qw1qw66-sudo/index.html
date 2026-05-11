# Security Threat Model and Production Readiness Review

## Status

Production readiness score: **45 / 100** after this PR, assuming CI passes.

The project is safer than before, but it is **not production-complete** until the Supabase migration is applied and verified against the real database.

## Threat model: how to break the app

### 1. Access another workspace / another user's rows
- **Attack scenario:** A malicious user opens DevTools and changes `user_id` in localStorage before sync.
- **Severity:** Critical
- **Affected files:** `src/main.js`, `sync-cloud/index.html`, `chalets-supabase-config.js`
- **Database weakness:** If RLS is missing or permissive, the browser can upsert rows for any `user_id`.
- **Exact fix:** Enable RLS on all tables and require `auth.uid() = user_id` for select/insert/update/delete. See `supabase/migrations/001_security_constraints.sql`.

### 2. Bypass PIN / workspace-code logic
- **Attack scenario:** The app currently has no real workspace code/PIN model. If a future PIN is stored plain in localStorage, anyone can bypass it.
- **Severity:** Critical
- **Affected files:** current app has email login only; no workspace tables exist in repo.
- **Database weakness:** No `workspaces`, `workspace_members`, hashed PIN, or membership policies.
- **Exact fix:** Add workspace tables, store only hashed PIN server-side, verify via RPC, and never trust localStorage for authorization.

### 3. Edit another user's bookings
- **Attack scenario:** User tampers a booking payload with another `user_id` and calls Supabase directly.
- **Severity:** Critical
- **Affected files:** `src/main.js`, `sync-cloud/index.html`
- **Database weakness:** Missing RLS lets anon/authenticated clients update rows they should not own.
- **Exact fix:** RLS policies with `auth.uid() = user_id`; reject client-supplied ownership not matching auth user.

### 4. Create duplicate bookings from two devices
- **Attack scenario:** Two devices create confirmed bookings for the same chalet/date at the same time. Client-side checks pass on both before either sees the other.
- **Severity:** Critical
- **Affected files:** `src/main.js`, `sync-cloud/index.html`
- **Database weakness:** No database exclusion constraint or transactional RPC.
- **Exact fix:** Add `bookings_no_confirmed_overlap` GiST exclusion constraint or a locked RPC transaction. This PR adds the SQL migration, but it must be applied and verified.

### 5. Tamper with localStorage
- **Attack scenario:** User changes booking totals, dates, paid amount, or local queue manually.
- **Severity:** High
- **Affected files:** `src/main.js`, `sync-cloud/index.html`
- **Database weakness:** Server accepts client timestamps and fields if no constraints/audit exist.
- **Exact fix:** Database constraints, audit log, server-side conflict protection, and never using localStorage as authority.

### 6. Break Supabase RLS by exposing service_role key
- **Attack scenario:** Developer accidentally puts `service_role` key in frontend config.
- **Severity:** Critical
- **Affected files:** `chalets-supabase-config.js`
- **Database weakness:** A service role key bypasses RLS completely.
- **Exact fix:** Frontend must contain only anon key. Add secret scanning and rotate credentials if service role was ever exposed.

### 7. Abuse API calls / sync spam
- **Attack scenario:** Malicious client loops upserts and sync_log inserts.
- **Severity:** High
- **Affected files:** `src/main.js`, `sync-cloud/index.html`
- **Database weakness:** No rate limits or server-side write budget.
- **Exact fix:** Supabase Edge Function/RPC with rate limits, audit log, and server-side validation.

### 8. Data loss via stale device sync
- **Attack scenario:** Old offline device comes online and overwrites newer local state because `updated_at` is client-controlled.
- **Severity:** High
- **Affected files:** `src/main.js`, `sync-cloud/index.html`
- **Database weakness:** No server version column / conflict resolution policy.
- **Exact fix:** Use server timestamps, row version numbers, and conflict resolution UI. Never let old clients blindly overwrite newer records.

### 9. Delete chalet with bookings
- **Attack scenario:** One device deletes chalet while another creates/edits bookings.
- **Severity:** High
- **Affected files:** `src/main.js`
- **Database weakness:** No foreign-key behavior documented.
- **Exact fix:** Foreign keys from bookings to chalets, restrict deletion if active/pending bookings exist, use soft-delete with RLS.

### 10. Date/time errors
- **Attack scenario:** Browser timezone or invalid date strings produce wrong night count.
- **Severity:** Medium
- **Affected files:** `src/main.js`, `chalets-supabase-config.js`
- **Database weakness:** If dates are text instead of date type, invalid values can enter database.
- **Exact fix:** Use `date` columns in Supabase, check `check_out > check_in`, and test timezones.

## Required exact checks before merge

Run in GitHub Actions or locally:

```bash
npm install
npm run lint
npm run build
npm test
npx playwright install --with-deps
npx playwright test
```

## Monitoring and logs required for production

- Add Sentry for frontend exceptions.
- Add LogRocket or equivalent session replay only if privacy policy is ready.
- Review Supabase Logs daily for RLS denials, constraint failures, and auth anomalies.
- If deploying on Vercel later, review Vercel Function/Edge logs. Current GitHub Pages deployment has no server logs.

## Backups and restore plan

- Daily Supabase database backup must be enabled.
- Weekly manual export of `bookings`, `chalets`, and `app_settings`.
- Restore drill: create staging project, restore latest backup, run smoke tests, then document recovery time.
- App-level JSON export is not enough for production backup.

## Production vs staging

- **Production:** real customer bookings only.
- **Staging:** test Supabase project + test GitHub Pages/Vercel URL + fake customers.
- Never test destructive sync on production.

## Real user scenarios that must pass

- Customer books same date from two devices at same time: database constraint rejects one.
- Internet disconnects while saving: local save and queue persist; later sync does not overwrite newer cloud record.
- Wrong PIN: must fail server-side. Not implemented yet.
- Delete chalet with active bookings: must fail server-side. Not fully proven yet.
- Edit price after booking: existing booking total must not change unless explicitly recalculated.
- iPhone Safari: open, add to home screen, reload offline, save locally, reconnect and sync.

## Still uncertain

- Real Supabase schema may not match migration assumptions.
- RLS is not proven until migration is applied and tested in Supabase.
- GitHub Actions results must pass before merge.
- Workspace Code + PIN is not implemented.
- Sentry/LogRocket/Vercel logging is not implemented in code.
