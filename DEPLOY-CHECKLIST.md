# Deploy Checklist

Before giving the link to a user:

1. Run `npm install`.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm test`.
5. Run `npm run e2e`.
6. Confirm `/sync-cloud/final.html` is the only public link given to users.
7. Confirm `app.html` redirects to `/sync-cloud/final.html`.
8. Confirm the app does not show default chalets before workspace pull.
9. Confirm the final app does not contain email login, Magic Link, or SMTP UI.
10. Confirm the Supabase SQL in `/database/shared_workspace_sync.sql` has been applied.
11. Test at least one real workspace on two devices.
12. Export a JSON backup before any production migration.

Final link:

```text
https://qw1qw66-sudo.github.io/index.html/sync-cloud/final.html
```
