'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      contact_name    TEXT,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      active          BOOLEAN NOT NULL DEFAULT true,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول suppliers (الموردون)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_sites (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      notes           TEXT,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول work_sites (مواقع العمل)');

  // إضافة عمودي supplier_id وsite_id لجدول inventory_items الموجود بالفعل —
  // ADD COLUMN IF NOT EXISTS يجعل إعادة تشغيل هذا الترحيل بلا خطر لو نُفِّذ
  // بالخطأ مرتين.
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS site_id BIGINT REFERENCES work_sites(id) ON DELETE SET NULL;`);
  console.log('✓ إضافة عمودي supplier_id وsite_id لجدول inventory_items');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id                  BIGSERIAL PRIMARY KEY,
      item_id             BIGINT REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name           TEXT NOT NULL,
      type                TEXT NOT NULL CHECK (type IN ('initial_stock', 'adjustment', 'issue', 'return')),
      quantity_delta      INT NOT NULL,
      quantity_after      INT NOT NULL,
      part_request_id     BIGINT REFERENCES part_requests(id) ON DELETE SET NULL,
      performed_by        TEXT NOT NULL,
      performed_by_user   BIGINT REFERENCES users(id) ON DELETE SET NULL,
      notes               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('✓ إنشاء جدول inventory_movements (سجل حركات المخزون)');

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(item_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_created ON inventory_movements(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_items_supplier ON inventory_items(supplier_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_items_site ON inventory_items(site_id);`);
  console.log('✓ إضافة الفهارس');

  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
