'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));
const { pool } = require('./config/db');

async function migrate() {
  console.log('بدء الترحيل...');

  // نزيل قيد النوع القديم أولاً — يجب أن يحدث قبل تحديث القيم الحالية
  // لأسمائها الجديدة، وإلا رفض القيد القديم نفسه القيم الجديدة أثناء الانتقال.
  await pool.query(`ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_type_check;`);
  console.log('✓ إزالة قيد النوع القديم');

  // نزيل الربط الصارم (Foreign Key) بين item_id وinventory_items — لازم الآن
  // لأن حركات العهدة (custody_items، جدول مختلف تمامًا) ستُسجَّل بنفس الجدول
  // أيضًا؛ سجل الحركة أصلًا يعرض الاسم النصي المحفوظ وقت الحركة (item_name)
  // فلا يحتاج ربطًا صارمًا بجدول بعينه لكل صف.
  await pool.query(`ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_item_id_fkey;`);
  console.log('✓ إزالة الربط الصارم لعمود item_id (يسمح بتسجيل حركات العهدة أيضًا)');

  await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inventory' CHECK (source IN ('inventory', 'custody'));`);
  console.log('✓ إضافة عمود source (لتمييز حركات المخزون عن حركات العهدة)');

  await pool.query(`ALTER TABLE inventory_movements ALTER COLUMN quantity_delta DROP NOT NULL;`);
  await pool.query(`ALTER TABLE inventory_movements ALTER COLUMN quantity_after DROP NOT NULL;`);
  console.log('✓ السماح بترك الكمية فارغة (حركات العهدة لا تُحسب بكمية رقمية أصلًا)');

  // تحويل الأنواع الأربعة القديمة لتصنيفها الجديد المطابق لنظام "مخزني بلس"
  // المرجعي — راجع التعليق أعلى الجدول في schema.sql لشرح كل نوع بالتفصيل.
  await pool.query(`UPDATE inventory_movements SET type = 'supply' WHERE type IN ('initial_stock', 'return');`);
  await pool.query(`UPDATE inventory_movements SET type = 'consumable_issue' WHERE type = 'issue';`);
  await pool.query(`UPDATE inventory_movements SET type = 'stock_adjustment' WHERE type = 'adjustment';`);
  console.log('✓ تحويل أنواع الحركات القديمة (الأربعة) لتصنيفها الجديد (الستة)');

  await pool.query(`
    ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_type_check
      CHECK (type IN ('supply', 'consumable_issue', 'custody_issue', 'custody_return', 'stock_reconciliation', 'stock_adjustment'));
  `);
  console.log('✓ إضافة قيد النوع الجديد بالتصنيفات الستة');

  console.log('تم الترحيل بنجاح ✅');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('فشل الترحيل ❌:', err);
  process.exit(1);
});
