# نظام حجوزات الشاليهات - الإصدار الإنتاجي

هذا الإصدار يثبت سطحًا عامًا واحدًا فقط للتطبيق:

```text
/app/
```

رابط GitHub Pages المتوقع لهذا المستودع:

```text
https://qw1qw66-sudo.github.io/index.html/app/
```

> ملاحظة تشغيل: التطبيق نفسه يستخدم المسار القانوني `/app/` وملف manifest على `/app/manifest.webmanifest` حسب متطلبات الإصدار. إذا بقي الموقع منشورًا كـ project page تحت `/index.html/`، قد تحتاج إعداد Pages أو custom domain بحيث يكون `/app/` متاحًا من جذر النطاق.

## ما الذي تم إيقافه

لا يستخدم الإصدار النهائي أيًا من التالي:

- بريد إلكتروني.
- Magic Link.
- OTP.
- SMTP.
- Supabase Auth للمستخدم النهائي.
- `auth.uid()` للتقسيم بين المستخدمين.
- صفحات recovery / restore / scanner كواجهة إنتاجية.
- بيانات seed أو demo.
- رفع تلقائي عند الفتح أو التركيز أو الرجوع للاتصال.

## طريقة الربط والمزامنة

الربط يتم فقط عبر:

```text
Workspace Code + PIN
```

المتصفح يتصل بـ Supabase باستخدام anon public key ويستدعي RPC فقط:

```text
get_shared_workspace(p_workspace_key, p_access_pin)
save_shared_workspace(p_workspace_key, p_access_pin, p_data)
```

لا يقرأ المتصفح ولا يكتب مباشرة في جداول `chalets` أو `bookings` أو `app_settings` أو `sync_log`.

## إعداد Supabase

افتح:

```text
Supabase → SQL Editor → New query
```

ثم شغّل الملف:

```text
database/shared_workspace_sync.sql
```

هذا الملف ينشئ جدول المصدر الوحيد:

```text
shared_workspaces
```

ويضيف دوال RPC ويمنع direct table access من المتصفح.

## نموذج البيانات

كل بيانات المساحة محفوظة داخل `shared_workspaces.data` كـ JSON واحد:

```json
{
  "schema_version": 3,
  "updated_at": "server timestamp",
  "settings": {
    "facility_name": "",
    "tag": "",
    "holidays": []
  },
  "chalets": [],
  "bookings": []
}
```

كل شاليه يحتفظ ببياناته الخاصة للسند:

- `contactPhone`
- `workerPhone`
- `workerName`
- `mapUrl`
- `terms`
- `periods[]`

## حماية البيانات

قبل أي رفع للسحابة يجب أن يكون هناك سحب ناجح في نفس الجلسة. التطبيق يطبّق:

- منع الرفع قبل Pull ناجح.
- منع رفع نسخة محلية فارغة فوق سحابة فيها بيانات.
- طلب عبارة تأكيد مكتوبة عند انخفاض عدد الشاليهات أو الحجوزات بشكل خطر.
- Backup محلي قبل كل رفع.
- فحص `updated_at` من السحابة قبل الرفع لمنع overwrite من جهاز قديم.

## الاختبار المحلي

```text
npm install
npm run lint
npm run build
npm test
npm run e2e
```

## النشر

النشر يتم عبر `.github/workflows/pages.yml`، وهو يبني artifact نظيف يحتوي فقط:

```text
/app/
/404.html
```

ولا ينشر `/archive/` أو `/sync-cloud/` أو أي صفحات قديمة.
