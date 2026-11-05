'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN (
          'admin', 'maintenance_technician', 'maintenance_manager', 'production', 'production_manager',
          'safety', 'contractor', 'general', 'inventory_manager', 'designer'
        ));
    END $$;
  `);
  console.log('✓ إضافة دوري "مسؤول المخزون" (inventory_manager) و"مصمم" (designer) لجدول users');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      category        TEXT,
      unit            TEXT NOT NULL DEFAULT 'قطعة',
      quantity        INT NOT NULL DEFAULT 0,
      min_quantity    INT,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول inventory_items (كتالوج المخزون والقطع)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS part_requests (
      id                  BIGSERIAL PRIMARY KEY,
      item_id             BIGINT REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name           TEXT NOT NULL,
      quantity            INT NOT NULL DEFAULT 1,
      work_order_id       BIGINT REFERENCES work_orders(id) ON DELETE SET NULL,
      notes               TEXT,
      needs_design        BOOLEAN NOT NULL DEFAULT false,
      status              TEXT NOT NULL DEFAULT 'pending_issue'
                            CHECK (status IN ('pending_design', 'pending_issue', 'issued', 'returned')),
      requested_by        TEXT NOT NULL,
      requested_by_user   BIGINT REFERENCES users(id) ON DELETE SET NULL,
      technician_id       BIGINT REFERENCES technicians(id) ON DELETE SET NULL,
      design_file_url     TEXT,
      design_notes        TEXT,
      designed_by         TEXT,
      designed_by_user    BIGINT REFERENCES users(id) ON DELETE SET NULL,
      designed_at         TIMESTAMPTZ,
      issued_by           TEXT,
      issued_by_user      BIGINT REFERENCES users(id) ON DELETE SET NULL,
      issued_at           TIMESTAMPTZ,
      returned_at         TIMESTAMPTZ,
      return_notes        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول part_requests (طلبات القطع)');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_part_requests_status ON part_requests(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_part_requests_work_order ON part_requests(work_order_id);`);
  console.log('✓ إضافة الفهارس');

  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
