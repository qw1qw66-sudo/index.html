# نظام حجوزات الشاليهات

تطبيق حجز عربي بسيط يعمل من ملف جذر واحد: `/index.html`.

## السطح الرسمي

- الصفحة الوحيدة للتطبيق: `/index.html`
- صفحة الخطأ: `/404.html`
- ملف قاعدة البيانات: `/database/shared_workspace_sync.sql`

## النشر

GitHub Pages workflow يبني مجلد `dist` وينشر فقط:

```text
dist/index.html
dist/404.html
dist/database/shared_workspace_sync.sql
```

ولا ينشر أي أسطح قديمة أو ملفات أرشيف.

## قاعدة التشغيل

- لا يوجد تسجيل دخول بالبريد.
- لا توجد روابط تحقق بالبريد.
- لا توجد مكتبات خارجية.
- الاتصال بالسحابة يتم فقط عبر `fetch` إلى Supabase RPC.
- لا يحدث رفع تلقائي عند فتح الصفحة أو تغيير التبويبات.
- الرفع يتم فقط من زر: `رفع التعديلات`.

## الفرع الحالي للعمل

```text
rebuild/clean-root-app
```

## النسخة الاحتياطية

```text
backup-before-full-clean-rebuild
```
