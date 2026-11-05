'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custody_items (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      category        TEXT,
      code            TEXT,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول custody_items (كتالوج العهدة: عدة ومعدات)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custody_assignments (
      id                  BIGSERIAL PRIMARY KEY,
      item_id             BIGINT NOT NULL REFERENCES custody_items(id) ON DELETE CASCADE,
      work_order_id       BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
      assigned_to         TEXT NOT NULL,
      technician_id       BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
      assigned_by         TEXT NOT NULL,
      assigned_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL,
      assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      expected_return_at  TIMESTAMPTZ,
      notes               TEXT,
      returned_at         TIMESTAMPTZ,
      return_notes        TEXT,
      returned_by         TEXT,
      returned_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  console.log('✓ إنشاء جدول custody_assignments (سجل تسليم/استرجاع العهدة)');

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_one_open_assignment
      ON custody_assignments(item_id) WHERE returned_at IS NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_custody_items_status ON custody_items(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_custody_assignments_item ON custody_assignments(item_id);`);
  console.log('✓ إضافة الفهارس');

  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
