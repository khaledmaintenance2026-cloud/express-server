'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');
  await pool.query(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS is_task BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'work_orders' AND column_name = 'task_scope'
      ) THEN
        ALTER TABLE work_orders ADD COLUMN task_scope TEXT CHECK (task_scope IN ('internal', 'external'));
      END IF;
    END $$;
  `);
  console.log('✓ إضافة عمودي is_task وtask_scope (مهام العمل الداخلية/الخارجية — منفصلة عن بلاغات العطل الطارئ والصيانة الوقائية) لجدول work_orders');
  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
