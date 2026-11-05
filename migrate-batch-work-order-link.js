// ترحيل: ربط باتش الإنتاج بأمر صيانة فعلي (work_orders) — يحل ثغرة "كيف
// سوف يسجل الباتش أنه تأخر بسبب الصيانة" (طلب 2026-09-29). يضيف عمود
// work_order_id على production_batches فقط؛ حساب حقول التوقف تلقائيًا من
// أمر العمل يتم بالكامل في كود السيرفر (services/batchWorkOrderLink.js)،
// لا حاجة لأي عمود/دالة إضافية في قاعدة البيانات نفسها.
//
// آمن للتشغيل أكثر من مرة (كل أوامره IF NOT EXISTS) — بنفس نمط بقية ملفات
// migrate-*.js في هذا المشروع. شغّلوه مرة واحدة على السيرفر الفعلي، ثم
// أعيدوا تشغيل خدمة "SayanatiServer".
'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء ترحيل ربط الباتش بأمر الصيانة...');

  await pool.query(`
    ALTER TABLE production_batches
      ADD COLUMN IF NOT EXISTS work_order_id BIGINT REFERENCES work_orders(id) ON DELETE SET NULL
  `);
  console.log('✅ عمود work_order_id على production_batches جاهز');

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_production_batches_work_order ON production_batches(work_order_id)
  `);
  console.log('✅ فهرس idx_production_batches_work_order جاهز');

  console.log('اكتمل الترحيل بنجاح.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل:', err);
  process.exit(1);
});
