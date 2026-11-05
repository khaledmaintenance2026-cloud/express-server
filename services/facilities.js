// قائمة مصانع/أقسام الإنتاج المتاحة — مصدر واحد يُستخدم في تقييد الويبهوكات
// (routes/webhooks.js) وفي جدولة التقارير التلقائية (services/reportScheduler.js)
// حتى لا تتكرر نفس القائمة في أكثر من ملف وتخرج عن التطابق بالخطأ لاحقًا.
// يجب أن تطابق تمامًا قيم عمود production_facility بجدول users وعمود
// location بجدول production_lines.
const FACILITIES = ['مصنع الرجال', 'مصنع النساء', 'المستودع العام'];

module.exports = { FACILITIES };
