# Manual Test Checklist

## T1 - فتح الصفحة

Steps:
1. افتح `/index.html`.

Expected:
- تظهر شاشة الربط فقط.
- يظهر Debug Log.
- يظهر Ready في Debug Log.

Result: Not run in this environment.

## T2 - Pull بدون بيانات

Steps:
1. اضغط Pull بدون Workspace/PIN.

Expected:
- يظهر click في Debug Log فورًا.
- تظهر رسالة خطأ.
- لا يفتح التطبيق.

Result: Not run in this environment.

## T3 - إنشاء مساحة فارغة

Steps:
1. أدخل Workspace جديد.
2. أدخل PIN صحيح.
3. اضغط Create empty workspace.

Expected:
- يتم استدعاء `save_shared_workspace`.
- تفتح التبويبات.
- لا توجد seed data.

Result: Not run in this environment.

## T4 - إضافة شاليه وفترة

Steps:
1. افتح تبويب الشاليهات.
2. أضف شاليه.
3. أضف فترة.
4. احفظ.

Expected:
- ID ثابت للشاليه والفترة.
- زر رفع التعديلات يصبح enabled.
- يظهر feedback و Debug Log.

Result: Not run in this environment.

## T5 - تعديل شاليه وفترة

Steps:
1. عدّل الشاليه والفترة.
2. احفظ.

Expected:
- لا يتغير ID.
- لا يتم إنشاء نسخة جديدة.
- يظهر feedback و Debug Log.

Result: Not run in this environment.

## T6 - إضافة حجز مؤكد

Steps:
1. افتح الحجوزات.
2. أضف حجز مؤكد.
3. احفظ.

Expected:
- يظهر الحجز في القائمة.
- زر السند يظهر.
- زر رفع التعديلات يصبح enabled.

Result: Not run in this environment.

## T7 - منع تعارض الحجز المؤكد

Steps:
1. أضف حجز مؤكد لنفس الشاليه والفترة.
2. حاول إضافة حجز مؤكد آخر بنفس الفترة المتداخلة.

Expected:
- يتم منع الحفظ.
- تظهر الرسالة: `يوجد حجز مؤكد متعارض في نفس الشاليه والفترة.`

Result: Not run in this environment.

## T8 - الحجز غير المؤكد لا يمنع التعارض

Steps:
1. أضف حجز pending في فترة متداخلة.

Expected:
- لا يتم منع الحفظ لأن المنع للحجوزات المؤكدة فقط.

Result: Not run in this environment.

## T9 - السند والتقارير

Steps:
1. افتح سند الحجز.
2. تأكد من الحقول المعروضة.
3. افتح التقارير.
4. اختر شهر وشاليه.
5. انسخ التقرير.

Expected:
- السند لا يعرض booking id أو notes أو day-type أو بيانات شاليه آخر.
- التقرير يعرض count/total/paid/remaining/best chalet.
- عند نقص البيانات تظهر: `البيانات غير كافية لحكم دقيق.`

Result: Not run in this environment.

## T10 - الرفع الآمن وفحص المصدر

Steps:
1. لا تضغط رفع التعديلات.
2. بدّل التبويبات.
3. أعد فتح الصفحة.
4. اضغط رفع التعديلات بعد وجود تغييرات.
5. افحص View Source.

Expected:
- لا يحدث رفع عند page load.
- لا يحدث رفع عند tab switch.
- لا يحدث رفع عند reconnect.
- الرفع فقط من زر `رفع التعديلات`.
- يتم إنشاء backup_before_cloud_push_<ISO> قبل الرفع.
- يحتفظ النظام بآخر 10 backups فقط.
- لا تظهر بقايا المصدر التالية داخل الملفات المنشورة:
  - signInWithOtp
  - Magic Link
  - email login
  - service_role
  - serviceWorker
  - sync-cloud
  - redirect scripts

Result: Not run in this environment.
