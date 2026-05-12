# Deploy Checklist

## قبل الدمج إلى main

- [ ] تأكد أن الفرع هو `rebuild/clean-root-app`.
- [ ] راجع `/index.html`.
- [ ] راجع `/database/shared_workspace_sync.sql`.
- [ ] راجع `/tests/manual-test-checklist.md`.
- [ ] تأكد أن GitHub Pages workflow ينسخ الملفات الثلاثة فقط.

## الملفات المنشورة فقط

```text
dist/index.html
dist/404.html
dist/database/shared_workspace_sync.sql
```

## ممنوع نشره

```text
app.html
app-release
clean.html
stable.html
sync-cloud
cloud.html
sw.js
archive
```

## فحص المصدر

Workflow يفحص الملفات المنشورة ضد بقايا تسجيل البريد، مفاتيح السيرفر، كود الكاش القديم، وأكواد التحويل.

## بعد النشر

- [ ] افتح رابط Pages النهائي.
- [ ] نفذ T1-T10 من ملف الاختبارات اليدوية.
- [ ] لا تعتمد على نجاح النشر فقط؛ يجب تجربة Pull/Create ورفع التعديلات فعليًا.
