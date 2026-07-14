# Architecture

## هدف التصميم

إزالة تعدد الصفحات والتجارب السابقة وبناء سطح واحد واضح وقابل للاختبار.

## الملفات العامة (المنشورة على Pages)

```text
/index.html
/404.html
```

مخطط قاعدة البيانات ليس ملفاً عاماً منشوراً؛ مصدره `supabase/migrations/`
(يُطبَّق على Supabase عبر ورك‑فلو النشر). `database/shared_workspace_sync.sql`
نسخة مرجعية للأساس فقط، غير منشورة.

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

الاتصال من المتصفح يتم إلى Supabase عبر RPC وEdge Functions:

```text
# RPC (قاعدة البيانات)
/rest/v1/rpc/get_shared_workspace
/rest/v1/rpc/create_shared_workspace
/rest/v1/rpc/save_shared_workspace_v2   # المسار الأساسي (revision-atomic)
/rest/v1/rpc/save_shared_workspace      # v1 قديم (fallback عند 404 فقط، بلا CAS)
# Edge Functions
/functions/v1/chalet-assistant          # المساعد (قراءة/تجهيز/تأكيد)
/functions/v1/chalet-setup-status       # حالة الإعداد + app_env
/functions/v1/create-payment-session … # مسار الدفع (خامل حتى يُفعَّل)
```

### 4. نموذج البيانات

مستند مساحة العمل (JSON في `shared_workspaces`، يُحفظ عبر save v2):

```text
schema_version
settings
chalets
chalets.periods
bookings
expenses          # المصاريف/التكاليف (تبويب المصاريف + صافي التقرير)
```

جداول خادمية منفصلة (خارج مستند المساحة، عبر Edge Functions/RPC):

```text
payment_orders / payment_transactions / payment_webhook_events / payment_audit_log
assistant_threads / assistant_messages / assistant_memory / assistant_actions
assistant_booking_drafts / automation_rules / automation_runs / outbound_messages
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
