# Data Safety Policy

Final production route: `/app/`.

The production app is intentionally conservative. The highest priority is preventing a browser page from overwriting real cloud data with empty, stale, or legacy local data.

## R1 — No seed data

The app never creates demo chalets, demo bookings, demo periods, or fallback customer data. If a workspace is empty, the UI remains empty and shows an Arabic message.

## R2 — No recovery UI in production

The production route has no localStorage scanner, no recovery page, no restore page, and no "adopt best candidate" flow. Legacy recovery code is excluded from the Pages artifact.

## R3 — No push before successful pull

`save_shared_workspace` may not be called unless all of these are true in the current browser session:

- `workspaceKey` is set.
- `accessPin` is set.
- `workspaceLoaded === true`.
- `lastCloudPullAt` is set from a successful pull.
- `lastCloudCounts` is known.

If any condition is false, upload is blocked client-side with an Arabic message.

## R4 — Empty overwrite guard

Before upload, the app compares local counts against the most recent cloud counts. If local data has zero active chalets and zero active bookings while the last cloud pull had data, upload is blocked with:

```text
تم إيقاف الرفع: البيانات المحلية فارغة وستحذف بيانات السحابة.
```

## R5 — Low-count destructive guard

If chalets drop by at least one, or bookings drop by at least 20% and at least three records, the user must type exactly:

```text
أؤكد استبدال بيانات السحابة
```

A normal browser confirm dialog is not used.

## R6 — Backup before push

Immediately before cloud upload, the app writes a local backup under:

```text
backup_before_cloud_push_<ISO timestamp>
```

The backup contains workspace key, counts, data, and timestamp. The app keeps the latest ten push backups.

## R7 — Import never auto-pushes

No JSON import path exists on the production landing route. If a future internal import tool is added, it must load to screen/cache only and must never upload without a separate post-review upload action.

## R8 — No auto push on boot

On load, the app either shows the connect screen or performs a pull only if saved credentials exist. It never pushes on boot, focus, visibility changes, reconnect, or timer. There is no periodic upload loop.

## R9 — Concurrent edit safety

Each pull captures the cloud `updated_at`. Immediately before upload, the app performs a fresh `get_shared_workspace` call. If cloud `updated_at` advanced, upload is blocked and the user must pull and review first.

## Source of truth

The source of truth is `shared_workspaces.data` returned by Supabase RPC. LocalStorage is only cache and safety backup.
