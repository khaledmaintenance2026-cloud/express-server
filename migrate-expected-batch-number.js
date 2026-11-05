// ترحيل: "رقم الباتش المتوقع" — يحل ثغرة توقيت بين رفع بلاغ العطل وتسجيل
// الباتش (طلب 2026-09-29). يضيف عمودين نصيَّين اختياريَّين فقط:
//   - incident_reports.expected_batch_number — يكتبه مشرف الإنتاج عند رفع
//     بلاغ العطل نفسه (رقم الباتش الذي يتوقع أن يتأخر بسببه).
//   - work_orders.expected_batch_number — يُنسَخ إليه تلقائيًا من البلاغ عند
//     تحويله لأمر عمل صيانة، ويُستخدم لاحقًا لمطابقة/ربط الباتش تلقائيًا فور
//     تسجيله الفعلي بنفس الرقم على نفس الخط (بلا ربط يدوي من المستخدم).
//
// آمن للتشغيل أكثر من مرة (IF NOT EXISTS) — بنفس نمط بقية ملفات migrate-*.js.
// شغّلوه مرة واحدة على السيرفر الفعلي، ثم أعيدوا تشغيل خدمة "SayanatiServer".
'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء ترحيل "رقم الباتش المتوقع"...');

  await pool.query(`
    ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS expected_batch_number TEXT
  `);
  console.log('✅ عمود expected_batch_number على incident_reports جاهز');

  await pool.query(`
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS expected_batch_number TEXT
  `);
  console.log('✅ عمود expected_batch_number على work_orders جاهز');

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_work_orders_expected_batch ON work_orders(line_id, expected_batch_number)
  `);
  console.log('✅ فهرس idx_work_orders_expected_batch جاهز');

  console.log('اكتمل الترحيل بنجاح.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل:', err);
  process.exit(1);
});
