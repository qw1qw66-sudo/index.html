# Live Excel Sync — foundation & setup

Goal: saving/uploading a booking in the web app updates the OneDrive Excel
workbook near real-time, visible in the Excel mobile app — **without any write
secret in the frontend**.

This document describes the foundation shipped in this PR and the user setup
required to make live sync actually work. **Nothing here is auto-deployed.**

## Architecture (recommended)

```
Web app (index.html)
  → POST { p_workspace_key, p_access_pin }   (no secrets; same creds as the RPC)
  → Supabase Edge Function  supabase/functions/excel-sync
        • authenticates by reading get_shared_workspace with those creds
        • fetches the current workspace (cloud = source of truth)
        • POSTs the workspace to POWER_AUTOMATE_EXCEL_WEBHOOK_URL (env secret)
  → Power Automate flow (HTTP trigger)
  → Office Script on the OneDrive workbook (rebuilds booking slots)
  → OneDrive Excel workbook  (opens in Excel mobile)
```

The GitHub Action export (`.github/workflows/export-bookings.yml`) stays as
**backup/recovery only** — not the live path.

## Why a backend (security)

The frontend must never hold a Microsoft token/refresh token/client secret, a
Power Automate webhook that allows public writes, a GitHub PAT, the Supabase
`service_role` key, or any write secret. Therefore:

- The **only** value the app stores is the Edge Function URL (public, not a
  secret). It is kept in `localStorage` (`excel_sync_endpoint`), not in source.
- The Power Automate webhook URL lives **only** in the Edge Function env
  (`POWER_AUTOMATE_EXCEL_WEBHOOK_URL`).

## When does sync run?

Decision: **after a successful cloud upload** (option B), because the exporter
reads cloud/Supabase data — local-only edits are not visible until uploaded.

This first PR ships a **manual button only** ("مزامنة Excel الآن"). Auto-trigger
after a successful upload is a **separate follow-up PR** once the backend is
verified. No auto-upload is introduced.

So the user flow today is: edit → **رفع التعديلات** (upload) → **مزامنة Excel الآن**.

## ⚠️ Microsoft account-type limitation (important)

**Power Automate + Office Scripts require a Microsoft 365 work/school (Business)
account.** The "Excel Online (Business)" connector and the Office Scripts
"Automate" tab are **not available on personal OneDrive (consumer)** accounts.

The OneDrive link provided is a **personal** (`1drv.ms`) link. If the account is
personal-only, the Power Automate path is **not feasible**; use **Microsoft Graph**
instead:

- Register an Azure AD app (consumer/`common` audience) with delegated
  `Files.ReadWrite` (+ offline_access for a refresh token).
- Store the refresh token / client secret **only** in the Edge Function env.
- The Edge Function calls the Graph **Workbook API**
  (`/me/drive/items/{id}/workbook/...`) to update cells.
- This is more setup and needs explicit approval before building.

Confirm the account type before choosing Power Automate vs Graph.

## Office Script design notes (Power Automate path)

The script must **update the existing workbook, not recreate it**:
- Operate on sheet `ورقة1`, year 2026.
- Chalets (phase 1): `شاليه تولوم` (cols A–I), `شاليه سكاي` (cols J–R).
- 4 daily slots = first 4 **active** periods by `sort`; **confirmed** bookings
  only; exclude cancelled/deleted/pending.
- **Clear only the booking slot cells** (period/phone/amount), then refill —
  preserve styles, merged cells, borders, column widths, Hijri formulas.
- Report skipped/conflicts (mirror `scripts/export_bookings_excel.py`).
- Limitation: if the Office Script cannot reliably preserve the template, fall
  back to the openpyxl GitHub Action (already accurate) and treat live sync as
  best-effort.

## Deploy (user runs these — not automated)

```bash
# 1) Deploy the Edge Function
supabase functions deploy excel-sync

# 2) Set the webhook secret (Power Automate HTTP trigger URL)
supabase secrets set POWER_AUTOMATE_EXCEL_WEBHOOK_URL="https://....logic.azure.com/..."
# SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically by the platform.

# 3) Copy the function URL, e.g.
#    https://<project-ref>.supabase.co/functions/v1/excel-sync
#    Paste it into the app: Settings → مزامنة Excel اللحظية → رابط خدمة المزامنة
```

Local check (optional, requires Deno): `deno check supabase/functions/excel-sync/index.ts`

## Required secrets (server-side only)

| Where | Name | Notes |
|---|---|---|
| Edge Function env | `POWER_AUTOMATE_EXCEL_WEBHOOK_URL` | the write secret; never in frontend |
| Edge Function env | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | auto-injected by Supabase |
| Frontend (`localStorage`) | `excel_sync_endpoint` | public function URL, **not** a secret |

## Next steps

1. Confirm Microsoft account type (Business vs personal OneDrive).
2. If Business: build the Power Automate flow + Office Script; deploy the Edge
   Function; set the secret; paste the function URL into the app; test the
   manual button.
3. If personal-only: approve the Microsoft Graph path; we add Graph calls to the
   Edge Function in a follow-up PR.
4. After the manual button is verified end-to-end: follow-up PR to auto-trigger
   sync after a successful cloud upload (with the "تم حفظ الحجز، لكن لم تتم
   مزامنة Excel. أعد المحاولة." fallback message).
