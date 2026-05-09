# نظام حجوزات الشاليهات

تطبيق عربي ثابت Static PWA لإدارة حجوزات الشاليهات والمنتجعات، يعمل محليًا أولًا ثم يزامن مع Supabase بعد تسجيل الدخول الحقيقي بالبريد عبر Magic Link.

## الرابط النهائي للاختبار

```txt
https://qw1qw66-sudo.github.io/index.html/app.html
```

الرابط القديم يحوّل للتطبيق:

```txt
https://qw1qw66-sudo.github.io/index.html/cloud/
```

## ما تم تنفيذه

- إدارة شاليهات حقيقية: إضافة، تعديل، حذف آمن.
- إدارة حجوزات حقيقية: إضافة، تعديل، حذف ناعم، سند حجز.
- منع الحجز المؤكد المتعارض على نفس الشاليه ونفس الفترة.
- حفظ محلي Local-first باستخدام `localStorage` و `IndexedDB`.
- ترحيل بيانات النسخ القديمة من `chalets_app_state_v3` إلى النسخة الجديدة.
- تصدير واستيراد نسخة احتياطية JSON.
- تسجيل دخول حقيقي عبر Supabase Auth باستخدام Email Magic Link فقط.
- لا يتم قبول الإيميل كهوية بمجرد كتابته؛ الدخول يتم بعد تحقق Supabase فقط.
- مزامنة Supabase حقيقية عبر الجداول: `chalets`, `bookings`, `app_settings`.
- Realtime + مزامنة عند التشغيل، الرجوع للاتصال، التركيز على النافذة، وكل 30 ثانية.
- واجهة عربية RTL مناسبة للآيفون و Add to Home Screen.

## الملفات المهمة

```txt
app.html                         واجهة التطبيق الإنتاجية
src/main.js                      منطق التطبيق والحفظ والمزامنة
cloud/index.html                 تحويل إلى app.html
manifest.webmanifest             إعداد PWA
database/supabase-schema.sql     قاعدة بيانات Supabase و RLS
database/supabase_schema.sql     نسخة بنفس المحتوى لمن يفضل الاسم underscore
chalets-supabase-config.js       قيم Supabase العامة للمتصفح
README.md                        هذا الدليل
```

## طريقة إنشاء Supabase

1. افتح Supabase وأنشئ مشروعًا جديدًا.
2. افتح SQL Editor.
3. شغّل الملف كاملًا:

```txt
database/supabase-schema.sql
```

أو:

```txt
database/supabase_schema.sql
```

هذا الملف ينشئ الجداول التالية:

```txt
profiles
chalets
bookings
app_settings
sync_log
```

ويفعّل RLS بحيث كل مستخدم يرى بياناته فقط عن طريق:

```txt
auth.uid()
```

وليس عن طريق البريد المكتوب يدويًا.

## المشاركة عبر نفس الإيميل

المشاركة تتم عبر نفس الإيميل بعد التحقق، لكن الحماية داخل قاعدة البيانات تعتمد على `auth.uid()` وليس نص الإيميل.

التسلسل الصحيح:

```txt
المستخدم يكتب الإيميل
Supabase يرسل Magic Link
المستخدم يفتح الرابط ويتحقق
Supabase يعطي session و user.id
التطبيق يحفظ البيانات بـ user_id = auth.uid()
كل جهاز يدخل بنفس الإيميل الموثق يرى نفس البيانات
```

## تفعيل Email Magic Link

من Supabase Dashboard:

```txt
Authentication > Providers > Email = Enabled
```

استخدم Email فقط. لا تستخدم SMS ولا Phone OTP.

## إعداد رابط GitHub Pages في Supabase

من:

```txt
Authentication > URL Configuration
```

اضبط:

```txt
Site URL = https://qw1qw66-sudo.github.io/index.html/app.html
```

وفي Additional Redirect URLs أضف:

```txt
https://qw1qw66-sudo.github.io/index.html/app.html
https://qw1qw66-sudo.github.io/index.html/cloud/
```

الكود يستخدم:

```js
window.location.origin + window.location.pathname
```

حتى يرجع رابط Magic Link لنفس صفحة التطبيق.

## قالب Magic Link

من:

```txt
Authentication > Email Templates > Magic Link
```

تأكد أن القالب يحتوي:

```txt
{{ .ConfirmationURL }}
```

لا تستبدلها برابط ثابت، ولا تحذفها.

## تفعيل الإيميل للإنتاج - Custom SMTP

خادم البريد الافتراضي في Supabase مناسب للاختبار فقط. للإنتاج ومع العملاء الحقيقيين، فعّل Custom SMTP.

مزودات SMTP مناسبة:

```txt
Resend
SendGrid
Postmark
Brevo
AWS SES
ZeptoMail
```

الحقول المطلوبة عادة:

```txt
SMTP host
SMTP port
SMTP username
SMTP password
Sender email مثل no-reply@yourdomain.com
Sender name
```

الخطوات:

```txt
1) Supabase Dashboard
2) Authentication
3) SMTP Settings / Custom SMTP
4) Enable Custom SMTP
5) Enter SMTP host
6) Enter port
7) Enter username
8) Enter password
9) Enter sender email
10) Save
11) Send test email
```

قائمة DNS لتحسين وصول الإيميلات:

```txt
SPF
DKIM
DMARC
```

هذه السجلات تضبطها في مزود النطاق/DNS، وليس داخل كود التطبيق.

يفضل عدم استخدام دومين التسويق للإيميلات الحساسة. استخدم مثلًا:

```txt
auth.yourdomain.com
no-reply@yourdomain.com
```

## إضافة Supabase URL و anon key

التطبيق لا يعتمد على Netlify ولا يحتاج build step.

افتح التطبيق ثم:

```txt
الإعدادات > المزامنة السحابية
```

ضع:

```txt
Supabase URL
Supabase anon public key
```

ثم اضغط:

```txt
حفظ إعدادات Supabase
```

مهم: استخدم `anon public key` فقط. لا تستخدم `service_role key` داخل الواجهة أبدًا.

## تسجيل الدخول والمزامنة

1. افتح التطبيق من الجوال الأول.
2. أدخل Supabase URL و anon key من الإعدادات.
3. أدخل بريدك واضغط “إرسال رابط الدخول”.
4. لا تظهر رسالة النجاح إلا بعد قبول Supabase للطلب فعلًا.
5. افتح رابط التحقق من البريد.
6. بعد الدخول، يتم رفع البيانات المحلية للسحابة.
7. افتح التطبيق من جوال آخر، استخدم نفس البريد بعد التحقق، وستظهر البيانات بعد المزامنة.

## منع الحجز المتعارض

الحجز المؤكد فقط يمنع التعارض. القاعدة المستخدمة:

```txt
existing.check_in < new.check_out
AND existing.check_out > new.check_in
AND same chalet
AND status = confirmed
AND deleted_at is null
```

إذا وجد تعارض، تظهر الرسالة:

```txt
يوجد حجز مؤكد لنفس الشاليه في هذه الفترة. لا يمكن حفظ الحجز.
```

الحجوزات المعلقة يمكن أن تتداخل حسب منطق التطبيق، والملغية أو المحذوفة لا تمنع الحجز.

## حل مشكلة عدم وصول إيميل التحقق

A. تأكد من:

```txt
Supabase Dashboard > Authentication > Providers > Email = Enabled
```

B. تأكد من إعداد الروابط:

```txt
Authentication > URL Configuration
Site URL = رابط التطبيق الحقيقي
Additional Redirect URLs = رابط التطبيق الحقيقي
```

C. تأكد من قالب Magic Link:

```txt
Magic Link template contains {{ .ConfirmationURL }}
```

D. إذا كنت تستخدم OTP template، يجب أن يحتوي:

```txt
{{ .Token }}
```

E. افحص Spam / Junk.

F. انتظر 60 ثانية قبل طلب رابط جديد.

G. افتح Console في المتصفح وتأكد أن الطلب يذهب فعلًا إلى Supabase Auth. إذا ظهر خطأ، التطبيق يعرضه بدل رسالة نجاح وهمية.

H. إذا فتح رابط البريد على `localhost`، فهذا يعني أن رابط الدخول أرسل من نسخة محلية. افتح التطبيق من الرابط النهائي وأرسل الرابط من جديد:

```txt
https://qw1qw66-sudo.github.io/index.html/app.html
```

## اختبار سريع

### Test A: الحفظ المحلي

- افتح التطبيق.
- أضف شاليه.
- أضف حجز.
- حدّث الصفحة.
- يجب أن تبقى البيانات.

### Test B: منع التعارض

- أضف حجز مؤكد لشاليه من تاريخ X إلى Y.
- حاول إضافة حجز مؤكد آخر لنفس الشاليه داخل نفس الفترة.
- يجب أن يمنعه التطبيق.
- الحجز المعلق يمكن أن يتداخل.

### Test C: البريد الحقيقي

- أدخل Supabase URL و anon key.
- أدخل البريد.
- اضغط إرسال رابط الدخول.
- يجب أن يرسل Supabase الطلب الحقيقي.
- لا تظهر رسالة النجاح إذا رجع Supabase بخطأ.

### Test D: الجلسة

- افتح رابط Magic Link من البريد.
- يرجع التطبيق ويفحص الجلسة.
- يظهر البريد في الإعدادات.
- بعد تحديث الصفحة تبقى الجلسة.

### Test E: جهازين

- سجل دخول في الجوال A.
- أضف حجزًا.
- سجل دخول بنفس البريد في الجوال B.
- يجب أن تظهر البيانات بعد المزامنة.

### Test F: بدون إنترنت

- افصل الإنترنت.
- أضف حجزًا.
- يجب أن يحفظ محليًا.
- أعد الاتصال.
- يجب أن تتم المزامنة تلقائيًا.

### Test G: النسخ الاحتياطي

- صدّر نسخة JSON.
- احذف/غيّر بيانات محلية.
- استورد النسخة.
- يجب أن ترجع البيانات.

## ملاحظات أمان

- البريد وحده لا يفتح البيانات.
- التحقق يتم عبر Supabase Auth.
- المالك الحقيقي للبيانات هو `auth.uid()`.
- `anon key` مسموح في الواجهة بشرط تفعيل RLS.
- `service_role key` ممنوع في الواجهة.
- يتم الهروب من النصوص المعروضة لتقليل خطر HTML injection.
