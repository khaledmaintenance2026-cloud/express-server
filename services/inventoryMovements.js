// يسجّل حركة واحدة في سجل حركات المخزون الموحّد (inventory_movements) —
// مشترك بين كتالوج المخزون الاستهلاكي (routes/inventory.js) وكتالوج العهدة
// (routes/custody.js)، بست أنواع تطابق تصنيف نظام "مخزني بلس" المرجعي:
// توريد (supply)، صرف استهلاكي (consumable_issue)، صرف معدات
// (custody_issue)، إعادة معدات (custody_return)، تسوية جرد
// (stock_reconciliation)، تعديل مخزون (stock_adjustment). راجع التعليق
// التفصيلي أعلى جدول inventory_movements في schema.sql لشرح كل نوع ولماذا
// item_id بلا ربط صارم (Foreign Key) بجدول بعينه.
//
// استُخرجت هذه الدالة لملف مستقل (بدل بقائها محلية داخل routes/inventory.js
// كما كانت) تحديدًا لأن routes/custody.js يحتاجها أيضًا الآن بعد أن أصبحت
// حركات تسليم/استرجاع العهدة تُسجَّل بنفس السجل الموحّد — استيرادها مباشرة من
// routes/inventory.js كان سيُنشئ اعتمادية دائرية بين ملفي المسارات.
'use strict';

const { pool } = require('../config/db');

/// db اختياري: pool أو client داخل معاملة (transaction) — يُستخدم client عند
/// الحاجة لمشاركة نفس المعاملة مع تحديث الرصيد/الحالة نفسها (صرف/إرجاع طلب
/// قطعة، تسليم/استرجاع عهدة)، بحيث تُلغى الحركة تلقائيًا لو فشلت العملية
/// الأساسية (ROLLBACK). fallback إلى pool خارج أي معاملة لعمليات pool.query
/// المباشرة (إضافة/تعديل صنف، حركة سريعة توريد/صرف/تسوية جرد ليست ضمن
/// معاملة أعمق).
///
/// quantityDelta/quantityAfter تُترك null عمدًا لحركات العهدة (source:
/// 'custody') — كل عدة عنصر واحد بحالة متاح/مُسلَّم لا رصيد رقمي له أصلًا.
/// فشل تسجيل الحركة نفسه لا يُفشل العملية الأساسية (تغيير الرصيد/الحالة نجح
/// بالفعل) — فقط يُسجَّل في اللوق للمراجعة اليدوية لاحقًا.
async function logMovement(db, {
  itemId,
  itemName,
  type,
  source = 'inventory',
  quantityDelta = null,
  quantityAfter = null,
  partRequestId = null,
  performedBy,
  performedByUser = null,
  notes = null,
}) {
  try {
    await (db || pool).query(
      `INSERT INTO inventory_movements
         (item_id, item_name, type, source, quantity_delta, quantity_after, part_request_id, performed_by, performed_by_user, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [itemId || null, itemName, type, source, quantityDelta, quantityAfter, partRequestId, performedBy, performedByUser, notes]
    );
  } catch (err) {
    console.error('تعذّر تسجيل حركة المخزون:', err.message);
  }
}

module.exports = { logMovement };
