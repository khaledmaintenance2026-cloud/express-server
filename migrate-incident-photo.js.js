'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');
 
async function migrate() {
  console.log('بدء الترحيل...');
  await pool.query(`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS photo_path TEXT;`);
  console.log('✓ إضافة عمود photo_path لبلاغات الإنتاج (صورة العطل الاختيارية)');
  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}
 
migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});