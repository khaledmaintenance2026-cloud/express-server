// ترحيل قاعدة بيانات injury_reports — نسخة Node.js بدل psql (psql غير مثبت
// على هذا السيرفر). يستخدم نفس اتصال قاعدة البيانات الذي يستخدمه السيرفر
// نفسه (pool من config/db.js) بدل الاعتماد على أي أداة خارجية.
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split(/\r?\n/).forEach((line) => {
  const match = line.match(/^([^=#]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim();
  }
});

const { pool } = require('./config/db');

const statements = [
  `ALTER TABLE injury_reports
     ALTER COLUMN hierarchy_of_control TYPE TEXT[]
     USING CASE WHEN hierarchy_of_control IS NULL THEN '{}'::TEXT[] ELSE ARRAY[hierarchy_of_control] END`,
  `ALTER TABLE injury_reports ALTER COLUMN hierarchy_of_control SET DEFAULT '{}'`,
  `ALTER TABLE injury_reports ALTER COLUMN hierarchy_of_control SET NOT NULL`,
  `ALTER TABLE injury_reports RENAME COLUMN hierarchy_of_control TO hierarchy_of_controls`,
  `ALTER TABLE injury_reports ADD COLUMN control_details_new TEXT`,
  `UPDATE injury_reports SET control_details_new =
     CASE
       WHEN array_length(hierarchy_of_controls, 1) > 0 AND control_details IS NOT NULL AND control_details <> ''
         THEN json_build_object(hierarchy_of_controls[1], control_details)::text
       ELSE '{}'
     END`,
  `ALTER TABLE injury_reports DROP COLUMN control_details`,
  `ALTER TABLE injury_reports RENAME COLUMN control_details_new TO control_details`,
  `ALTER TABLE injury_reports ALTER COLUMN control_details SET DEFAULT '{}'`,
  `ALTER TABLE injury_reports ALTER COLUMN control_details SET NOT NULL`,
  `ALTER TABLE injury_reports ADD COLUMN fishbone_causes TEXT[] NOT NULL DEFAULT '{}'`,
];

async function run() {
  for (let i = 0; i < statements.length; i++) {
    console.log(`[migrate] تنفيذ الخطوة ${i + 1} من ${statements.length}...`);
    await pool.query(statements[i]);
  }
  console.log('[migrate] تم الترحيل بنجاح ✅');
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] فشل الترحيل:', err.message);
  console.error(err.stack);
  process.exit(1);
});
