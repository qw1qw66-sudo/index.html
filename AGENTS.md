# AGENTS.md — دستور مشروع نظام حجوزات الشاليهات

هذا الملف هو دستور العمل بين ChatGPT و Codex و GitHub داخل هذا المشروع.

## الأدوار

### ChatGPT
- يفهم المشروع والسياق العام.
- يحلل المتطلبات قبل تحويلها إلى كود.
- يكتب Issues وطلبات Codex بوضوح.
- يراجع Pull Requests قبل الدمج.
- يمنع الدمج إذا كان التعديل يغير سلوكًا حساسًا أو يسبب تعارضًا.
- لا يعتمد على كلام الأداة بأنها أنجزت؛ يعتمد على GitHub diff والـ PR الفعلي.

### Codex
- يعدل الكود فقط حسب Issue أو Prompt محدد.
- يشغل فحص JavaScript قبل تسليم أي PR.
- يفتح Pull Request واضح من فرع نظيف مبني على آخر main.
- لا يدمج بنفسه إلا إذا طُلب ذلك صراحة.
- لا يغير نطاق الطلب أو يعيد بناء التطبيق من جديد.

### GitHub
- هو مصدر الحقيقة للكود.
- يحفظ التاريخ، الفروع، Pull Requests، والمراجعات.
- أي تعديل غير موجود في GitHub لا يعتبر منجزًا.
- لا يعتبر العمل جاهزًا حتى يظهر PR واضح وفيه diff قابل للمراجعة.

## قاعدة العمل الأساسية

1. نفهم المشكلة أولًا.
2. نفتح Issue واضح إذا كان التعديل كبيرًا أو حساسًا.
3. Codex ينفذ على فرع جديد من latest main.
4. Codex يشغل الاختبار ويرجع رقم PR.
5. ChatGPT يراجع الـ diff من GitHub.
6. لا ندمج إلا إذا كان التعديل نظيفًا ومحددًا.
7. بعد الدمج، ننشر على gh-pages عند الحاجة.

## قواعد السلامة في هذا المشروع

ممنوع تغيير هذه المناطق إلا بطلب صريح جدًا:

- Supabase RPC
- login/session logic
- safe upload
- upload guards
- booking editor placement
- voucher placement
- upcoming/past booking split
- cancelled booking behavior
- chalet delete behavior
- JSON root data model
- service worker / PWA cache

## ممنوعات ثابتة

- لا Supabase Auth.
- لا Magic Link.
- لا email login.
- لا OTP.
- لا service_role في المتصفح.
- لا service worker.
- لا external JS.
- لا external CSS.
- لا auto upload.
- لا إعادة بناء كاملة بدون طلب صريح.
- لا تعديل PR قديم ملوث إذا كان إنشاء PR نظيف أسلم.

## قاعدة PR النظيف

أي PR جيد يجب أن يكون:

- مبني على آخر main.
- محدد النطاق.
- صغير قدر الإمكان.
- لا يحتوي تغييرات غير مطلوبة.
- يحتوي وصف واضح.
- يحتوي Manual QA أو Testing.
- يجتاز JavaScript syntax check.

## فحص JavaScript المطلوب

```bash
node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];
new Function(js);
console.log('JS syntax OK');
NODE
```

## صيغة طلب Codex المفضلة

```text
Implement Issue #[number] exactly.
Create a new clean branch from latest main.
Do not modify unrelated files.
Run JS syntax check.
Create a Pull Request to main.
Return the PR number.
Do not merge automatically.
```

## سياسة الدمج

لا يتم الدمج إذا:

- الـ diff يحتوي تغييرات خارج النطاق.
- التعديل يمس سلوك حساس بدون طلب.
- PR مبني على فرع قديم وفيه تعارضات.
- Codex قال أنجز لكن التعديل غير ظاهر في GitHub.
- يوجد كود مكسور أو chain مكسور في JavaScript.
- تم إدخال cancelled bookings في قوائم غير مطلوبة.
- تم تغيير حذف الشاليه أو upload بدون طلب صريح.

## سياسة النشر

بعد الدمج في main:

- يتم النشر إلى gh-pages فقط بعد مراجعة الدمج.
- لا يتم النشر من PR غير مدمج.
- رابط الاختبار يضاف له query version لتفادي الكاش.

## ملاحظة تشغيلية

إذا تعقد PR أو صار ملوثًا بتعديلات كثيرة:

- أوقفه.
- لا تحاول ترقيعه.
- افتح PR جديد نظيف من latest main.
- طبق أقل تعديل آمن ممكن.
