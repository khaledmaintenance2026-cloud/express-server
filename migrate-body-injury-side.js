'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');
  await pool.query(`ALTER TABLE injury_report_employees ADD COLUMN IF NOT EXISTS body_injury_side TEXT;`);
  console.log('✓ إضافة عمود body_injury_side (جهة الإصابة: أمامي/خلفي) لتقارير إصابات العمل — يجعل تعليم مخطط الجسم في التقرير المطبوع دقيقًا بدل وضع دائرة على كل الاحتمالات معًا');
  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});