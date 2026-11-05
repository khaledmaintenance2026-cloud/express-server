'use strict';
// ============================================================================
// الاستيراد الأولي لقسم «إجازات الموظفين» (طلب 2026-10-25): يضيف الموظفين الـ79 إلى قائمة الأفراد
// المشتركة (overtime_employees) بقسم «مصنع الرجال» ثم يسجّل الإجازات الـ16 الحالية.
//
// التشغيل (من نافذة cmd داخل C:\sayanati-server):
//   node seed-leaves.js --check     ← تجربة بلا حفظ أي شيء (يعرض النتيجة المتوقعة فقط)
//   node seed-leaves.js             ← التنفيذ الفعلي
// آمن للتكرار: لا يكرّر موظفًا (الرقم الوظيفي فريد) ولا إجازة (موظف + تاريخ البدء)، ولا يغيّر اسم
// موظف موجود ولا تواريخه المُدخلة؛ يملأ فقط الفارغ (القسم/التعيين/المباشرة).
// الكل في معاملة واحدة: لو فشل شيء لا يُحفظ أي جزء.
//
// المخرجات في الشاشة بالإنجليزية فقط (لتفادي تشوّه العربي في نافذة cmd)، والتقرير العربي الكامل
// يُكتب في ملف seed-leaves-report.txt بجانب هذا الملف.
// ============================================================================

const path = require('path');
const fs = require('fs');

if (require.main === module) require('./lib/loadEnv').loadEnv(path.join(__dirname, '.env'));

const { pool } = require('./config/db');
const C = require('./lib/leaveCalc');
const { ensureLeaveTables } = require('./services/leaveSchema');
const svc = require('./services/leaveService');
const { EMPLOYEES, LEAVES } = require('./services/leaveSeedData');

const ACTOR = 'استيراد الإجازات';

/**
 * @param {{dryRun?: boolean, now?: Date}} opts
 * @returns تقرير: {employees:{expected, added, existing, present_after}, leaves:{expected, inserted, existing, skipped},
 *                   warnings:[], result2145}
 */
async function runSeed({ dryRun = false, now = new Date() } = {}) {
  await ensureLeaveTables();
  const today = C.todayDay(now);
  const warnings = [];
  const report = {
    today: C.fromDay(today),
    dry_run: dryRun,
    employees: { expected: EMPLOYEES.length, added: 0, existing: 0, present_after: 0 },
    leaves: { expected: LEAVES.length, inserted: 0, existing: 0, skipped: 0 },
    warnings,
    result2145: null,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- الموظفون
    const idByNumber = new Map();
    for (const [no, name, dept, date] of EMPLOYEES) {
      const found = await client.query(
        `SELECT id, name, department, to_char(hire_date,'YYYY-MM-DD') AS hire_date, to_char(start_date,'YYYY-MM-DD') AS start_date
           FROM overtime_employees WHERE employee_number = $1`,
        [no]
      );
      if (found.rows.length === 0) {
        const sameName = await client.query(
          'SELECT id FROM overtime_employees WHERE employee_number IS NULL AND lower(name) = lower($1)',
          [name]
        );
        if (sameName.rows.length > 0) {
          warnings.push(`الموظف "${name}" له سجل سابق بلا رقم وظيفي (معرّف ${sameName.rows[0].id}) — أُضيف سجل جديد بالرقم ${no}؛ راجعهما واحذف المكرر من تبويب العمل الإضافي`);
        }
        const ins = await client.query(
          `INSERT INTO overtime_employees (name, employee_number, department, hire_date, start_date, created_by)
           VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
          [name, no, dept, date, ACTOR]
        );
        idByNumber.set(no, Number(ins.rows[0].id));
        report.employees.added += 1;
      } else {
        const cur = found.rows[0];
        idByNumber.set(no, Number(cur.id));
        report.employees.existing += 1;
        if (cur.name !== name) warnings.push(`الرقم ${no} موجود مسبقًا باسم "${cur.name}" (الطلب: "${name}") — لم يُغيَّر الاسم`);
        // نملأ الفارغ فقط
        await client.query(
          `UPDATE overtime_employees
              SET department = COALESCE(department, $2),
                  hire_date  = COALESCE(hire_date, $3::date),
                  start_date = COALESCE(start_date, $3::date),
                  updated_at = now()
            WHERE id = $1 AND (department IS NULL OR hire_date IS NULL OR start_date IS NULL)`,
          [cur.id, dept, date]
        );
      }
    }
    const present = await client.query('SELECT count(*) AS n FROM overtime_employees WHERE employee_number = ANY($1)', [EMPLOYEES.map((e) => e[0])]);
    report.employees.present_after = Number(present.rows[0].n);

    // ---- الإجازات
    for (const l of LEAVES) {
      const empId = idByNumber.get(l.no);
      if (!empId) {
        report.leaves.skipped += 1;
        warnings.push(`إجازة الموظف ${l.no}: الموظف غير موجود — تخطّيناها`);
        continue;
      }
      // قاعدة الاستيراد: العودة المتوقعة قبل اليوم ولا مباشرة مسجّلة ⇒ المباشرة الفعلية = العودة المتوقعة
      let actual = l.actual;
      if (!actual && l.expected && C.toDay(l.expected) < today) actual = l.expected;

      const parsed = C.parseLeaveDates({ start: l.start, expected: l.expected, actual }, today, { allowMissingReturn: true });
      if (parsed.error) {
        report.leaves.skipped += 1;
        warnings.push(`إجازة الموظف ${l.no} (${l.start}): ${parsed.error} — تخطّيناها`);
        continue;
      }
      const emp = (await client.query("SELECT to_char(start_date,'YYYY-MM-DD') AS start_date FROM overtime_employees WHERE id = $1", [empId])).rows[0];
      if (emp.start_date && parsed.start < C.toDay(emp.start_date)) {
        report.leaves.skipped += 1;
        warnings.push(`إجازة الموظف ${l.no} (${l.start}): تبدأ قبل تاريخ مباشرته ${emp.start_date} — تخطّيناها`);
        continue;
      }
      const existingRows = await client.query(
        `SELECT id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(expected_return,'YYYY-MM-DD') AS expected_return, to_char(actual_return,'YYYY-MM-DD') AS actual_return
           FROM employee_leaves WHERE employee_id = $1`,
        [empId]
      );
      if (existingRows.rows.some((r) => r.start_date === l.start)) {
        report.leaves.existing += 1;
        continue;
      }
      const hit = C.findOverlap(parsed, existingRows.rows.map(svc.dbLeaveToCalc), today);
      if (hit) {
        report.leaves.skipped += 1;
        warnings.push(`إجازة الموظف ${l.no} (${l.start}): تتداخل مع إجازة موجودة — تخطّيناها`);
        continue;
      }
      await client.query(
        `INSERT INTO employee_leaves (employee_id, start_date, expected_return, actual_return, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [empId, l.start, l.expected, C.fromDay(parsed.actual), l.note, ACTOR]
      );
      report.leaves.inserted += 1;
    }

    // ---- نتيجة الموظف 2145 (مثال التحقق في الطلب) — داخل المعاملة نفسها
    const probe = idByNumber.get('2145');
    if (probe) {
      const data = await svc.getEmployeeView(probe, now, client);
      if (data) {
        const lv = data.view.leaves[0];
        report.result2145 = lv
          ? { start: lv.start, return: lv.actual || lv.expected, duration: lv.duration, balance_at_start: lv.balance_at_start, paid: lv.paid, unpaid: lv.unpaid, rounding: data.settings.paidRounding }
          : null;
      }
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return report;
}

function arabicReport(r) {
  const L = [];
  L.push(`تقرير استيراد إجازات الموظفين — ${r.today}${r.dry_run ? ' (تجربة بلا حفظ)' : ''}`);
  L.push('');
  L.push(`الموظفون: المطلوب ${r.employees.expected} — أُضيف الآن ${r.employees.added} — موجود مسبقًا ${r.employees.existing} — الموجودون من القائمة بعد الاستيراد ${r.employees.present_after}`);
  L.push(`الإجازات: المطلوب ${r.leaves.expected} — سُجّلت الآن ${r.leaves.inserted} — موجودة مسبقًا ${r.leaves.existing} — تُخطّيت ${r.leaves.skipped}`);
  if (r.result2145) {
    const x = r.result2145;
    L.push(`الموظف 2145: إجازة ${x.start} إلى ${x.return} (${x.duration} يومًا) — الرصيد عند البدء ${x.balance_at_start} — مدفوع ${x.paid} — بدون راتب ${x.unpaid} (التقريب: ${x.rounding === 'nearest' ? 'لأقرب يوم' : 'للأسفل'})`);
  }
  if (r.warnings.length > 0) {
    L.push('');
    L.push('ملاحظات تحتاج مراجعة:');
    for (const w of r.warnings) L.push(`- ${w}`);
  }
  return L.join('\n');
}

module.exports = { runSeed, arabicReport };

if (require.main === module) {
  const dryRun = process.argv.includes('--check');
  runSeed({ dryRun })
    .then((r) => {
      console.log(`Mode: ${dryRun ? 'CHECK ONLY (nothing saved)' : 'SAVED'}   Date: ${r.today}`);
      console.log(`Employees: expected ${r.employees.expected} | added now ${r.employees.added} | already there ${r.employees.existing} | present after ${r.employees.present_after}`);
      console.log(`Leaves:    expected ${r.leaves.expected} | registered now ${r.leaves.inserted} | already there ${r.leaves.existing} | skipped ${r.leaves.skipped}`);
      if (r.result2145) {
        const x = r.result2145;
        console.log(`Employee 2145: leave ${x.start} -> ${x.return} (${x.duration} days) | balance at start ${x.balance_at_start} | paid ${x.paid} | unpaid ${x.unpaid}`);
      }
      console.log(`Warnings: ${r.warnings.length} (see seed-leaves-report.txt)`);
      const file = path.join(__dirname, 'seed-leaves-report.txt');
      fs.writeFileSync(file, `\uFEFF${arabicReport(r)}\n`, 'utf8');
      console.log(`Full Arabic report: ${file}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('SEED FAILED (nothing was saved):', err && err.message ? err.message : err);
      process.exit(1);
    });
}
