# Owner action: customer-PII cleanup (AUD-003)

This repository is **public** and historically committed an Excel export that
contained real customer phone numbers (`exports/bookings-2026.xlsx`, refreshed
by a scheduled GitHub Action).

## What this PR already did (safe, automatic)

- The exporter (`scripts/export_bookings_excel.py`) now **redacts phone numbers
  by default** — booked slots show only the marker `محجوز`, never a number.
  The scheduled Action uses the default, so **future** exports are PII-free.
- The **current** committed workbook was redacted in place (the live phone
  cells were replaced with the marker). `HEAD` no longer contains customer
  numbers.
- A Netlify publish directory now excludes `exports/` (and all dev files), so
  the deploy preview / site cannot serve the workbook.

## What still requires YOU (not done automatically — it rewrites history)

The old phone numbers remain in **git history** (previous commits of the
workbook). Anyone can still `git show <old-sha>:exports/bookings-2026.xlsx`.
Removing them requires a history rewrite, which is destructive and must be your
decision:

1. **Rotate the export credential first.** In GitHub repo secrets, change
   `EXPORT_ACCESS_PIN` (and consider a new `EXPORT_WORKSPACE_KEY`). Update the
   workspace PIN in the app to match. This limits future exposure regardless of
   history.
2. **Decide repo visibility.** The simplest durable fix is making the
   repository **private**. GitHub Pages on a private repo needs a paid plan; if
   you rely on free Pages, keep it public but complete step 3.
3. **Purge the file from history** (only after everyone has pushed/merged what
   they need — this rewrites SHAs):
   ```sh
   # with git-filter-repo (recommended):
   pip install git-filter-repo
   git filter-repo --path exports/bookings-2026.xlsx --invert-paths
   # then force-push (coordinate with any collaborators):
   git push --force origin main
   ```
   Note: open PRs based on old history (including this one) will need rebasing
   after a history purge. Do the purge when convenient, not mid-review.
4. **Check the Netlify site history.** If Netlify built older commits, its build
   cache/CDN may have served the old file. In Netlify → project → Deploys, you
   can clear the cache and redeploy; or disconnect the site if you don't use it.

## Verifying

```sh
# current tree is clean:
git grep -nE '05[0-9]{8}|9665[0-9]{8}' -- exports/ ; echo "exit $?"   # no matches expected

# history still contains it until you purge (expected to find the old blob):
git log --all --oneline -- exports/bookings-2026.xlsx | head
```

Do not run the history purge from CI or automatically — it is a deliberate,
coordinated owner action.
