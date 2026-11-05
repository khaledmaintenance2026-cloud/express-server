'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');
  await pool.query(`ALTER TABLE equipment ADD COLUMN IF NOT EXISTS facility TEXT;`);
  console.log('✓ إضافة عمود facility (مصنع/قسم المعدة — يُستخدم فقط للمعدات بدون خط محدد لمنع ظهورها في قسم آخر) لجدول equipment');
  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});