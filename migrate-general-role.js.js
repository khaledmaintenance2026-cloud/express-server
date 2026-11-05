// ترحيل قاعدة البيانات لإضافة دور "قسم عام" — شغّل مرة واحدة فقط:
//   node migrate-general-role.js
'use strict';

require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');
const GENERAL_FACILITIES = [
  'مستودع الخام - نساء', 'مستودع التام - نساء', 'مستودع الزيوت',
  'مستودع الخام - رجال', 'مستودع التام - رجال',
  'المكاتب الإدارية - نساء', 'المكاتب الإدارية - رجال',
];

async function migrate() {
  console.log('بدء الترحيل...');

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'maintenance_technician', 'maintenance_manager', 'production', 'production_manager', 'safety', 'contractor', 'general'));
    END $$;
  `);
  console.log('✓ تحديث قائمة الأدوار المسموحة (أُضيف "general")');

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS general_facility TEXT;`);
  console.log('✓ إضافة عمود general_facility');

  const facilitiesList = GENERAL_FACILITIES.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_general_facility_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_general_facility_check;
      END IF;
      ALTER TABLE users ADD CONSTRAINT users_general_facility_check
        CHECK (general_facility IS NULL OR general_facility IN (${facilitiesList}));
    END $$;
  `);
  console.log('✓ إضافة قيد المواقع المسموحة (٧ مواقع)');

  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});