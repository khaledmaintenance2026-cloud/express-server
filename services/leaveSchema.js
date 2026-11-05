'use strict';
// ============================================================================
// جداول «إجازات الموظفين» — تُنشأ تلقائيًا عند أول استخدام (آمنة للتكرار)، بلا ترحيل يدوي.
//
// قرار التصميم: لا نخزّن أي رصيد ولا أيام مدفوعة/بدون راتب. نخزّن فقط التواريخ التي
// يدخلها المستخدم (بدء الإجازة، العودة المتوقعة، المباشرة الفعلية) ويُحسب كل شيء آخر
// عند كل طلب (lib/leaveCalc.js)، فلا يختلّ رصيد أبدًا لو عُدّلت إجازة قديمة أو تغيّرت
// الإعدادات.
//
// الموظفون في الجدول المشترك overtime_employees (نفس قائمة العمل الإضافي)؛ نضيف له:
// القسم + تاريخ التعيين + تاريخ المباشرة. أعمدة جديدة اختيارية، فلا تتأثر شاشات
// العمل الإضافي الحالية.
// ============================================================================

const { pool } = require('../config/db');

const DDL = [
  // نسخة مطابقة لما في routes/overtime.js لو لم يُستعمل العمل الإضافي بعد.
  `CREATE TABLE IF NOT EXISTS overtime_employees (
     id               BIGSERIAL PRIMARY KEY,
     name             TEXT NOT NULL,
     employee_number  TEXT,
     created_by       TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS overtime_employees_number_uq
     ON overtime_employees (employee_number) WHERE employee_number IS NOT NULL`,
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS department TEXT`,
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS hire_date DATE`,
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS start_date DATE`,

  // الإجازات: تواريخ فقط. actual_return = تاريخ المباشرة بعد الإجازة (أول يوم عمل بعد العودة).
  `CREATE TABLE IF NOT EXISTS employee_leaves (
     id               BIGSERIAL PRIMARY KEY,
     employee_id      BIGINT NOT NULL REFERENCES overtime_employees(id) ON DELETE RESTRICT,
     start_date       DATE NOT NULL,
     expected_return  DATE,
     actual_return    DATE,
     note             TEXT,
     created_by       TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT employee_leaves_expected_after_start CHECK (expected_return IS NULL OR expected_return > start_date),
     CONSTRAINT employee_leaves_actual_after_start CHECK (actual_return IS NULL OR actual_return > start_date)
   )`,
  // لا إجازتان لنفس الموظف تبدآن في اليوم نفسه (وهما متداخلتان حتمًا) — يمنع التكرار عند إعادة الاستيراد.
  `CREATE UNIQUE INDEX IF NOT EXISTS employee_leaves_emp_start_uq ON employee_leaves (employee_id, start_date)`,
  `CREATE INDEX IF NOT EXISTS employee_leaves_emp_idx ON employee_leaves (employee_id)`,
  // الموظف البديل (اسم حر اختياري) — عمود في تقرير الإكسل الذي طلبه المالك.
  `ALTER TABLE employee_leaves ADD COLUMN IF NOT EXISTS replacement TEXT`,

  // سجل التنبيهات المُرسَلة، حتى لا يتكرر التنبيه نفسه كل ساعة.
  `CREATE TABLE IF NOT EXISTS leave_alert_log (
     kind     TEXT NOT NULL,
     ref_key  TEXT NOT NULL,
     sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (kind, ref_key)
   )`,
];

let ready = null;
function ensureLeaveTables() {
  if (!ready) {
    ready = (async () => {
      for (const sql of DDL) await pool.query(sql);
    })().catch((err) => {
      ready = null; // نعيد المحاولة في الطلب التالي
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureLeaveTables, DDL };
