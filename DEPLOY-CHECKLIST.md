# Deploy Checklist

Final public route:

```text
/app/
```

Expected GitHub Pages URL for this repository:

```text
https://qw1qw66-sudo.github.io/index.html/app/
```

## Pre-deploy checks

1. Run `npm install`.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm test`.
5. Run `npm run e2e`.
6. Confirm the Supabase SQL in `database/shared_workspace_sync.sql` has been applied.
7. Confirm the browser app uses only `get_shared_workspace` and `save_shared_workspace` RPC.
8. Confirm no email login, Magic Link, OTP, SMTP, or Supabase Auth UI appears in `/app/`.
9. Confirm no seed chalets/bookings/periods appear before a successful pull.
10. Confirm upload is disabled until a successful pull is completed.
11. Confirm the empty-overwrite guard blocks upload with the required Arabic message.
12. Confirm the typed phrase guard requires exactly:

```text
أؤكد استبدال بيانات السحابة
```

13. Confirm the concurrent-edit guard blocks stale upload when cloud `updated_at` has advanced.
14. Confirm voucher output uses only fields from the booking's linked chalet.
15. Confirm the generated Pages artifact contains only:

```text
/app/
/404.html
```

16. Confirm the generated Pages artifact does not contain:

```text
/app.html
/cloud.html
/sync-cloud/
/sync-v*/
/archive/
```

17. Confirm `/404.html` is readable, Arabic RTL, and links to `/app/` without redirecting or scanning localStorage.
18. Test one real workspace from two devices before using it with production data.

## Deployment workflow

`.github/workflows/pages.yml` builds a clean `dist` directory by copying only `app/*` and `404.html`, then uploads `dist` using `actions/upload-pages-artifact` and deploys with `actions/deploy-pages`.
