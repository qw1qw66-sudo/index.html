# Architecture

## هدف التصميم

إزالة تعدد الصفحات والتجارب السابقة وبناء سطح واحد واضح وقابل للاختبار.

## الملفات العامة

```text
/index.html
/404.html
/database/shared_workspace_sync.sql
```

## طبقات النظام

### 1. الواجهة

- ملف واحد: `/index.html`
- HTML/CSS/JS فقط
- عربي RTL
- لا frameworks
- لا external JS
- لا external CSS

### 2. البيانات

البيانات تحفظ كسند JSON داخل جدول `shared_workspaces` عبر RPC فقط.

### 3. الاتصال بالسحابة

الاتصال من المتصفح يتم فقط إلى:

```text
/rest/v1/rpc/get_shared_workspace
/rest/v1/rpc/save_shared_workspace
```

### 4. نموذج البيانات

```text
settings
chalets
chalets.periods
bookings
```

### 5. قواعد الحجز

يمنع تعارض الحجوزات المؤكدة فقط عندما تتحقق الشروط:

```text
same chalet
status confirmed
not deleted
different booking id
time intervals overlap
```

### 6. الرفع الآمن

الرفع لا يحدث إلا من زر `رفع التعديلات` وبعد Pull/Create ناجح في نفس الجلسة.

### 7. الأرشيف

`/archive` موجود فقط للمرجع داخل الريبو ولا يدخل في `dist` ولا Pages artifact.
