# Codex Task: Build Hesabate Reports Supabase App

IMPORTANT:
This project is NOT the chalet booking project.
Do not mention chalets.
Do not reuse chalet logic.
Do not mix old booking code.
This is a NEW independent Arabic ERP / Accounting Reports project named:
"مشروع الحسابات - Hesabate Reports".

Related GitHub Issue:
https://github.com/qw1qw66-sudo/index.html/issues/53

Current PR:
https://github.com/qw1qw66-sudo/index.html/pull/52

Current preview:
https://deploy-preview-52--helpful-gaufre-edf566.netlify.app/

Current branch:
claude/arabic-erp-reports-app-PcVVv

Repository:
qw1qw66-sudo/index.html

---

## Mission

The current app is a static Arabic RTL Hesabate-style reports interface.
Convert it into a real functional database-backed Arabic ERP reports web app using Supabase.

Keep the current polished RTL visual style, but make the app actually functional.

---

## Non-negotiable rules

1. This is an ERP / accounting reports app only.
2. Keep the existing Arabic RTL Hesabate-style design as much as possible.
3. Do not create fake buttons.
4. Every button must either work or show a clear Arabic "قريبًا" message.
5. Do not use localStorage as the main database.
6. Use Supabase as the real database.
7. Use only Supabase anon key in frontend. Never expose service_role key.
8. Add loading, empty, and error states.
9. App must work on iPhone Safari.
10. App must deploy on Netlify.
11. Keep it simple, stable, and production-clean.
12. No old service worker issues.
13. No conflicting pages.
14. No duplicated app.html / clean.html / stable.html.
15. One main public page only: index.html.
16. Add SQL files for database setup.
17. Add README instructions.

---

## Technical stack

Use:
- Single-page frontend
- HTML + inline CSS + vanilla JS
- Arabic RTL
- Google Font: Tajawal or IBM Plex Sans Arabic
- Supabase database

Allowed external dependencies:
- Google Fonts
- Supabase JS CDN or direct Supabase REST API fetch

Recommended Supabase CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Frontend config at top of JS:

```js
const SUPABASE_URL = "PASTE_SUPABASE_URL_HERE";
const SUPABASE_ANON_KEY = "PASTE_SUPABASE_ANON_KEY_HERE";
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

If values are missing, show setup screen:
"يرجى إضافة إعدادات Supabase لتفعيل قاعدة البيانات."

---

## Files to create/update

Create or update:

```text
/index.html
/supabase/schema.sql
/supabase/seed.sql
/README.md
```

---

## Database design

Create these Supabase tables:

### companies
- id uuid primary key default gen_random_uuid()
- name text not null
- created_at timestamptz default now()

### profiles
- id uuid primary key references auth.users(id) on delete cascade
- company_id uuid references companies(id) on delete cascade
- full_name text
- role text default 'admin'
- created_at timestamptz default now()

### erp_modules
- id uuid primary key default gen_random_uuid()
- company_id uuid nullable references companies(id) on delete cascade
- module_key text not null
- name_ar text not null
- icon_key text not null
- sort_order int not null
- is_active boolean default true
- created_at timestamptz default now()

### erp_reports
- id uuid primary key default gen_random_uuid()
- module_id uuid references erp_modules(id) on delete cascade
- report_key text not null
- title_ar text not null
- description_ar text
- sort_order int not null
- is_active boolean default true
- created_at timestamptz default now()

### report_columns
- id uuid primary key default gen_random_uuid()
- report_id uuid references erp_reports(id) on delete cascade
- column_key text not null
- label_ar text not null
- data_type text default 'text'
- sort_order int not null
- is_visible boolean default true

### report_rows
- id uuid primary key default gen_random_uuid()
- report_id uuid references erp_reports(id) on delete cascade
- company_id uuid nullable references companies(id) on delete cascade
- row_date date
- counterparty_name text
- amount numeric default 0
- status text
- row_data jsonb not null default '{}'
- created_at timestamptz default now()

### audit_logs
- id uuid primary key default gen_random_uuid()
- company_id uuid nullable references companies(id) on delete cascade
- action text not null
- entity_type text
- entity_id uuid
- details jsonb default '{}'
- created_at timestamptz default now()

---

## RLS and security

Enable RLS on all tables.

For MVP demo:
- Allow public read for erp_modules, erp_reports, report_columns, and demo report_rows where company_id is null.
- Allow authenticated users to read/write their own company data through profiles.company_id.
- Do not allow anonymous write.
- Never use service_role key in frontend.

Add comments in schema.sql explaining:
- For real accounting data, user must enable Supabase Auth.
- Public demo data is only for preview.
- Sensitive financial data must not be added until Auth/RLS is verified.

---

## Seed data

Create seed.sql with the 17 modules in this exact RTL order:

1. العملاء والموردين
2. حساباتي HR الرواتب والأجور
3. POS
4. البنوك و الشيكات
5. كشوف الفواتير و المستودعات
6. الفواتير
7. السندات المحاسبية
8. الصلاحيات و المستخدمين
9. كشف حركات المصاريف
10. الضريبة المضافة
11. تقارير الصلاحية
12. المستودعات
13. حركات مراكز التكلفة
14. تقارير محاسبية
15. المستودعات
16. حساباتي HR الدوام
17. تقارير الأصول

Default active module:
العملاء والموردين

Add these 11 reports under العملاء والموردين:

1. أرصدة العملاء والموردين
2. فئات سعر البيع الخاصة
3. تقرير الزيارات الميدانية
4. كشف حساب عميل
5. أرصدة حركات العملاء والموردين
6. أرصدة تعدت حد الدين
7. كشف دفعات الزبائن
8. أرصدة لم تتحرك منذ
9. زيارات المندوبين
10. تعمير الذمم
11. استعلام العملاء

Add at least 3 useful reports for every other module.

Add sample report_rows for default customer/supplier reports using row_data fields such as:
- customer_name
- supplier_name
- debit
- credit
- balance
- invoice_no
- payment_status
- due_date
- branch
- notes

---

## Frontend requirements

Keep current layout:

### Header bar
- Right side:
  - Company name: مؤسسة متوكل لمواد البناء
  - Logo placeholder: cyan circle with white “H”
- Left side:
  - round user avatar
  - 8 quick-action icon buttons
  - notification bell with red badge “2”

### Sub-header
- cyan pill: عربي
- live clock format: PM HH:MM:SS
- updates every second

### Primary tab bar
Tabs:
الواجهة الرئيسية | تعريفات | الفواتير و السندات | حساباتي HR | أنظمة أخرى | حساباتي POS | التقارير | تحدث معنا

Active tab:
التقارير

### Module icon strip
- Load modules from Supabase erp_modules.
- Horizontally scrollable on mobile.
- Active module has cyan rounded-square highlight.
- Active module has speech-bubble tail pointing down.
- Clicking module updates report list from database.

### Sub-reports panel
- Load reports from Supabase erp_reports.
- Two columns on desktop.
- One column under 640px.
- Clicking a report opens a report view.

---

## Functional report view

When user clicks a report, show a report workspace below the module strip.

Header:
- report title
- module name
- back button: رجوع للتقارير
- refresh button: تحديث
- print button: طباعة
- export CSV button: تصدير CSV

Filters:
- search input: بحث
- date from
- date to
- status dropdown
- amount min
- amount max

Table:
- Load rows from report_rows.
- Display columns dynamically from report_columns.
- If no report_columns exist, infer columns from row_data keys.
- Support Arabic labels.
- Show loading spinner while fetching.
- Show empty state if no data.
- Show error state if Supabase fails.

Summary cards above table:
- عدد السجلات
- إجمالي المبالغ
- أعلى رصيد
- آخر تحديث

CSV export:
- Export visible filtered rows.
- File name should include report title and date.

Print:
- Print clean report layout.
- Arabic RTL print styling.
- Hide navigation/header buttons in print mode.

---

## Admin / management features

Add a simple admin drawer/modal.

Button:
إدارة التقارير

Inside:
1. Add new module
2. Edit module name
3. Enable/disable module
4. Add new report under selected module
5. Edit report title
6. Enable/disable report
7. Add sample row to selected report
8. Delete sample row

All changes must save to Supabase.

If user is not authenticated:
- Disable write buttons.
- Show message:
"تسجيل الدخول مطلوب لتعديل البيانات. وضع المعاينة يسمح بالقراءة فقط."

---

## Auth

Add simple Supabase Auth screen:

- Email
- Password
- Login
- Sign up
- Logout

After login:
- If user has no company, create company automatically:
  name: مؤسسة متوكل لمواد البناء
- Create profile linked to company.
- User can write data only for their company.

For demo:
- Public default modules/reports remain readable without login.
- Report management and row editing require login.

---

## UI details

Direction:
rtl

Language:

```html
<html lang="ar" dir="rtl">
```

Font:
Tajawal

Colors:
- Accent cyan: #3DD9D6
- Background: #FFFFFF
- Section divider: #F8FAFC
- Active text: #1F2937
- Inactive text: #6B7280
- Borders: #E5E7EB

Icons:
Use inline SVG only.
No icon libraries.

Pastel fills:
- yellow #FCD34D
- blue #93C5FD
- mint #A7F3D0
- gray #D1D5DB

Effects:
- soft shadows: 0 1px 3px rgba(0,0,0,.05)
- hover lift on icons
- active scale(1.05)
- cyan glow on active module
- smooth transitions

Mobile:
- module strip swipeable
- report table horizontally scrollable
- tab bar collapses to hamburger under 480px
- drawer must open/close correctly
- no horizontal page overflow except table/strip

---

## Error handling

Handle:

1. Supabase config missing
2. Supabase connection failed
3. Empty module list
4. Empty report list
5. Empty report data
6. Auth error
7. Insert/update/delete error

Add useful console logs only. Do not spam console.
Do not leave TODO buttons.
Do not leave broken click handlers.

---

## Acceptance tests

Desktop:
1. Page opens without errors.
2. Clock updates every second.
3. Reports tab active.
4. 17 modules appear from database.
5. العملاء والموردين active by default.
6. 11 default reports appear.
7. Clicking any module changes active highlight.
8. Clicking a report opens report view.
9. Filters work.
10. Refresh works.
11. CSV export works.
12. Print layout works.

Mobile iPhone width:
1. Header does not overflow.
2. Hamburger appears under 480px.
3. Drawer opens and closes.
4. Module strip scrolls smoothly.
5. Reports become one column.
6. Table scrolls horizontally without breaking page.
7. Buttons are tappable.

Database:
1. schema.sql runs successfully.
2. seed.sql runs successfully.
3. Data loads from Supabase.
4. Auth signup/login works.
5. Logged-in user can create company/profile.
6. Logged-in user can add/edit reports.
7. Anonymous user cannot write.
8. No service_role key exposed.

---

## Deliverable

Return:
1. Updated index.html
2. supabase/schema.sql
3. supabase/seed.sql
4. README.md
5. Final report with:
   - What changed
   - Database tables created
   - How to configure Supabase
   - How to deploy on Netlify
   - Test results
   - Known limitations

Make the app production-clean, not a UI-only prototype.
