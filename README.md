# نظام حجوزات الشاليهات

تطبيق عربي لإدارة حجوزات الشاليهات على الآيفون.

## ملاحظات مهمة

- التطبيق يحفظ البيانات محليًا أولًا داخل نفس الجهاز.
- تم دعم وضع ليلي ونهاري.
- لتشغيله كتطبيق: افتحه من Safari ثم Share ثم Add to Home Screen.

## Cloud Sync Setup

تم تنفيذ مزامنة سحابية آمنة باستخدام Supabase Auth + PostgreSQL + Row Level Security، بدون الاعتماد على Netlify.

### ما تم اكتشافه في المشروع

- نوع المشروع: plain HTML / JavaScript بدون React أو Vite أو Next.
- التخزين الحالي: `localStorage` و `IndexedDB`.
- مفتاح بيانات التطبيق الحالي: `chalets_app_state_v3`.
- شكل البيانات الأساسي:
  - `chalets[]`
  - `bookings[]`
  - `set{}`
  - `theme`

### الملفات المهمة

- `chalets-cloud-sync.js` نقطة تشغيل المزامنة.
- `src/lib/supabaseClient.js` إعداد Supabase client.
- `src/lib/localStore.js` قراءة/كتابة البيانات المحلية والنسخ الاحتياطي.
- `src/lib/syncService.js` منطق تسجيل الدخول والمزامنة والـ offline queue.
- `chalets-supabase-config.js` ملف إعدادات المتصفح النهائي.
- `.github/workflows/pages.yml` يولّد إعدادات Supabase من GitHub Secrets وينشر على GitHub Pages.
- `supabase/migrations/20260509_secure_cloud_sync.sql` يحتوي الجداول و RLS.
- `.env.example` يوضح المتغيرات المطلوبة.

### طريقة التشغيل على Supabase و GitHub Pages

1. أنشئ مشروعًا جديدًا في Supabase.
2. افتح Supabase SQL Editor.
3. شغّل الملف التالي كاملًا:

```txt
supabase/migrations/20260509_secure_cloud_sync.sql
```

4. من Supabase Auth فعّل Email OTP أو Magic Link.
5. في Supabase Auth URL Configuration أضف رابط الموقع في Site URL و Redirect URLs، مثل:

```txt
https://qw1qw66-sudo.github.io/index.html/cloud/
```

6. في GitHub repository افتح:

```txt
Settings -> Secrets and variables -> Actions -> New repository secret
```

7. أضف السرّين:

```txt
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_PUBLIC_KEY
```

8. افتح:

```txt
Actions -> Deploy static site to GitHub Pages -> Run workflow
```

9. افتح التطبيق من جوالين:

```txt
https://qw1qw66-sudo.github.io/index.html/cloud/
```

10. اضغط زر Cloud، أدخل الإيميل، وافتح رابط الدخول من البريد أو أدخل رمز OTP.
11. بعد التحقق أول مرة، تتم المزامنة تلقائيًا بدون تدخل يدوي.

### الأمان

- لا يتم استخدام الإيميل وحده كهوية، لأن أي شخص يستطيع كتابة إيميل غيره.
- المالك الحقيقي للبيانات هو `auth.uid()` القادم من Supabase Auth.
- الجداول محمية بـ RLS.
- كل مستخدم يستطيع قراءة وتعديل بياناته فقط.
- لا تضع `service_role key` داخل ملفات الواجهة نهائيًا.

### اختبار سريع

- مستخدم جديد يدخل الإيميل ويؤكد OTP أو Magic Link.
- البيانات المحلية ترفع للسحابة بعد أول دخول.
- الجوال الثاني بنفس الإيميل بعد التحقق يحمل نفس البيانات.
- أي تعديل في جوال A يظهر في جوال B عبر Realtime أو pull sync.
- إذا انقطع الإنترنت، يحفظ التطبيق محليًا ثم يزامن عند رجوع الاتصال.
- تسجيل الخروج لا يحذف النسخة المحلية.
- الرمز الخاطئ أو المنتهي يظهر رسالة عربية واضحة.
