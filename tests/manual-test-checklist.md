# Manual Test Checklist

## T1 - فتح الصفحة
Expected: شاشة دخول فقط، Debug Log، و Ready.
Result: Not manually checked in this chat.

## T2 - دخول بدون بيانات
Expected: لا يفتح التطبيق وتظهر رسالة خطأ.
Result: Not manually checked in this chat.

## T3 - إنشاء حساب/مساحة فارغة
Expected: حساب جديد ببيانات canonical empty ولا توجد seed data.
Result: Not manually checked in this chat.

## T4 - إضافة شاليه
Expected: إضافة شاليه بدون بيانات وهمية وزر رفع التعديلات يتفعل.
Result: Not manually checked in this chat.

## T5 - تعديل شاليه
Expected: لا يتغير chalet ID ولا booking IDs.
Result: Not manually checked in this chat.

## T6 - إضافة حجز مؤكد
Expected: يظهر في القائمة وزر السند يظهر.
Result: Not manually checked in this chat.

## T7 - منع تعارض الحجز المؤكد
Expected: تظهر رسالة: يوجد حجز مؤكد متعارض في نفس الشاليه والفترة.
Result: Not manually checked in this chat.

## T8 - pending لا يمنع التعارض
Expected: الحجز المعلق لا يمنع حفظ حجز آخر.
Result: Not manually checked in this chat.

## T9 - السند والتقارير
Expected: السند والتقرير يعرضان البيانات الصحيحة فقط.
Result: Not manually checked in this chat.

## T10 - الرفع الآمن وفحص المصدر
Expected: لا رفع إلا بزر رفع التعديلات ولا تظهر بقايا auth/redirect/sync القديمة.
Result: Not manually checked in this chat.

## T11 - Create new account
Expected:
- username + password required
- account created with empty canonical data
- app opens
- no seed data
Result: Not manually checked in this chat.

## T12 - Edit chalet
Expected:
- edit form opens
- fields update
- same chalet ID remains
- success message appears: تم تحديث بيانات الشاليه.
Result: Not manually checked in this chat.

## T13 - Edit six periods
Expected:
- each chalet has 6 periods
- all 6 can be edited
- period IDs remain stable after edit
- inactive periods disappear from booking dropdown
Result: Not manually checked in this chat.

## T14 - Booking period dropdown
Expected:
- selecting chalet shows only that chalet’s active periods
- no periods from other chalets appear
- if no active periods: لا توجد فترات مفعلة لهذا الشاليه.
Result: Not manually checked in this chat.

## T15 - Voucher period accuracy
Expected:
- voucher shows correct chalet
- voucher shows correct period label
- voucher shows correct entry and exit time
Result: Not manually checked in this chat.
