# نظام حجوزات الشاليهات

تطبيق عربي لإدارة حجوزات الشاليهات على الآيفون.

## ملاحظات مهمة

- التطبيق يحفظ البيانات محليًا أولًا داخل نفس الجهاز.
- تم دعم وضع ليلي ونهاري.
- لتشغيله كتطبيق: افتحه من Safari ثم Share ثم Add to Home Screen.

## Cloud Sync Setup

تم تنفيذ مزامنة سحابية آمنة باستخدام Supabase Auth + PostgreSQL + Row Level Security.

### ما تم اكتشافه في المشروع

- نوع المشروع: plain HTML / JavaScript بدون React أو Vite أو Next.
- التخزين الحالي: `localStorage` و `IndexedDB`.
- مفتاح بيانات التطبيق الحالي: `chalets_app_state_v3`.
- شكل البيانات الأساسي:
  - `chalets[]`
  - `bookings[]`
  - `set{}`
  - `theme`

### طريقة التشغيل على Supabase و Netlify

1. أنشئ مشروعًا جديدًا في Supabase.
2. افتح Supabase SQL Editor.
3. شغّل الملف التالي كاملًا:

```txt
supabase/migrations/20260509_secure_cloud_sync.sql
```

4. من Supabase Auth فعّل Email OTP أو Magic Link.
5. في Netlify افتح:

```txt
Site settings -> Environment variables
```

6. أضف القيم التالية:

```txt
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_PUBLIC_KEY
```

7. أعد النشر من Netlify.
8. افتح التطبيق من جوالين.
9. اضغط زر Cloud.
10. أدخل الإيميل.
11. افتح رابط الدخول من البريد أو أدخل رمز OTP.
12. بعد التحقق أول مرة، تتم المزامنة تلقائيًا بدون تدخل يدوي.

### الأمان

- لا يتم استخدام الإيميل وحده كهوية، لأن أي شخص يستطيع كتابة إيميل غيره.
- المالك الحقيقي للبيانات هو `auth.uid()` القادم من Supabase Auth.
- الجداول محمية بـ RLS.
- كل مستخدم يستطيع قراءة وتعديل بياناته فقط.
- لا تضع `service_role key` داخل ملفات الواجهة نهائيًا.

### ملفات المزامنة

- `chalets-cloud-sync.js` يحتوي منطق المزامنة.
- `chalets-supabase-config.js` يتم توليده تلقائيًا في Netlify بواسطة `build-env.js`.
- `netlify.toml` يحدد أمر البناء والنشر.
- `.env.example` يوضح المتغيرات المطلوبة.
- `supabase/migrations/20260509_secure_cloud_sync.sql` يحتوي جداول Supabase و RLS.

### اختبار سريع

- مستخدم جديد يدخل الإيميل ويؤكد OTP أو Magic Link.
- البيانات المحلية ترفع للسحابة بعد أول دخول.
- الجوال الثاني بنفس الإيميل بعد التحقق يحمل نفس البيانات.
- أي تعديل في جوال A يظهر في جوال B عبر Realtime أو pull sync.
- إذا انقطع الإنترنت، يحفظ التطبيق محليًا ثم يزامن عند رجوع الاتصال.
- تسجيل الخروج لا يحذف النسخة المحلية.
