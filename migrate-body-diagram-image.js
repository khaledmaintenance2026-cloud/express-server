'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');
  await pool.query(`ALTER TABLE injury_report_employees ADD COLUMN IF NOT EXISTS body_diagram_image TEXT;`);
  console.log('✓ إضافة عمود body_diagram_image (رسمة تفاعلية يرسمها المستخدم بإصبعه فوق مخطط الجسم لتحديد مكان الإصابة بدقة) لتقارير إصابات العمل');
  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
