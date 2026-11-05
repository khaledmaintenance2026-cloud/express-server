// "العهدة" — عدة ومعدات (دريل، إلخ) تُسلَّم لفني كعهدة ويرجعها لاحقًا، بعكس
// قطع الغيار الاستهلاكية في routes/inventory.js التي تُصرف ولا ترجع. راجع
// التعليق التفصيلي أعلى جدولي custody_items وcustody_assignments في
// schema.sql لشرح دورة الحالة الكاملة قبل قراءة هذا الملف: العدة
// "available" ← تُسلَّم لفني (POST /assignments) ← تُسترجع
// (PATCH /assignments/:id/return).
'use strict';

const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, MAINTENANCE_ROLES, INVENTORY_MANAGE_ROLES } = require('../middleware/auth');
const { notifyEvent } = require('../services/notifications');
const { logMovement } = require('../services/inventoryMovements');

const router = new Router();
router.use(requireAuth, requireApproved);

// نفس فريق "المخزون والقطع" يقدر يرى كتالوج العهدة وسجلها (فني/مسؤول صيانة +
// مسؤول مخزون) — التسليم والاسترجاع فقط يبقيان مقصورين على
// INVENTORY_MANAGE_ROLES (نفس نمط تأكيد صرف/إرجاع طلب قطعة في
// routes/inventory.js).
const CUSTODY_VIEW_ROLES = [...MAINTENANCE_ROLES, 'inventory_manager'];

const CUSTODY_ITEM_LIST_QUERY = `
  SELECT ci.*,
    ca.id AS current_assignment_id, ca.assigned_to AS current_holder,
    ca.assigned_at AS current_assigned_at, ca.expected_return_at AS current_expected_return_at,
    wo.description AS current_work_order_description
  FROM custody_items ci
  LEFT JOIN custody_assignments ca ON ca.item_id = ci.id AND ca.returned_at IS NULL
  LEFT JOIN work_orders wo ON wo.id = ca.work_order_id
`;

// ----------------------------------------------------------------------------
// كتالوج العهدة
// ----------------------------------------------------------------------------

// GET /api/custody/items — كل عدة/معدة مع بيانات من بحوزته حاليًا (إن وُجد).
router.get('/items', requireRole(...CUSTODY_VIEW_ROLES), async (req, res) => {
  const { rows } = await pool.query(`${CUSTODY_ITEM_LIST_QUERY} ORDER BY ci.category NULLS LAST, ci.name`);
  res.json({ items: rows });
});

// POST /api/custody/items — إضافة عدة/معدة جديدة لكتالوج العهدة.
router.post('/items', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, category, code, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم العدة/المعدة إلزامي' });

  const { rows } = await pool.query(
    `INSERT INTO custody_items (name, category, code, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
    [
      String(name).trim(),
      category ? String(category).trim() : null,
      code ? String(code).trim() : null,
      notes ? String(notes).trim() : null,
    ]
  );
  res.status(201).json({ item: rows[0] });
});

// PATCH /api/custody/items/:id — تعديل بيانات العدة نفسها (ليس تسليمها —
// ذلك عبر /assignments أدناه).
router.patch('/items/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, category, code, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم العدة/المعدة إلزامي' });

  const { rows } = await pool.query(
    `UPDATE custody_items SET name = $1, category = $2, code = $3, notes = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [
      String(name).trim(),
      category ? String(category).trim() : null,
      code ? String(code).trim() : null,
      notes ? String(notes).trim() : null,
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'العدة/المعدة غير موجودة' });
  res.json({ item: rows[0] });
});

// DELETE /api/custody/items/:id — يُمنع حذف عدة مُسلَّمة حاليًا لفني؛ يجب
// استرجاعها أولًا حتى لا يضيع سجل من بحوزته شيء من عهدة الشركة.
router.delete('/items/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { rows: existing } = await pool.query('SELECT status FROM custody_items WHERE id = $1', [req.params.id]);
  if (existing.length === 0) return res.status(404).json({ error: 'العدة/المعدة غير موجودة' });
  if (existing[0].status === 'assigned') {
    return res.status(400).json({ error: 'هذه العدة مُسلَّمة حاليًا لأحد الفنيين — استرجعوها أولًا قبل الحذف' });
  }
  await pool.query('DELETE FROM custody_items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// تسليم/استرجاع العهدة
// ----------------------------------------------------------------------------

// GET /api/custody/assignments — سجل كامل (تسليم + مُرجَع)، بدعم ?open=1
// لعرض غير المُرجَع فقط (شاشة "عهدة غير مُرجَعة").
router.get('/assignments', requireRole(...CUSTODY_VIEW_ROLES), async (req, res) => {
  const { open } = req.query;
  const base = `
    SELECT ca.*, ci.name AS item_name, ci.category AS item_category, ci.code AS item_code,
      wo.description AS work_order_description
    FROM custody_assignments ca
    JOIN custody_items ci ON ci.id = ca.item_id
    LEFT JOIN work_orders wo ON wo.id = ca.work_order_id
  `;
  const sql = open ? `${base} WHERE ca.returned_at IS NULL ORDER BY ca.assigned_at DESC` : `${base} ORDER BY ca.assigned_at DESC`;
  const { rows } = await pool.query(sql);
  res.json({ assignments: rows });
});

// POST /api/custody/assignments — تسليم عدة لفني. يقبل إما technicianId (يُشتق
// منه اسم الفني تلقائيًا من جدول technicians) أو assignedToName حرًا — بنفس
// نمط itemId/itemName الاختياري في POST /inventory/part-requests.
router.post('/assignments', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { itemId, technicianId, assignedToName, workOrderId, expectedReturnAt, notes } = req.body;
  if (!itemId) return res.status(400).json({ error: 'يجب تحديد العدة/المعدة المطلوب تسليمها' });

  let resolvedTechnicianId = null;
  let resolvedAssignedToName = assignedToName ? String(assignedToName).trim() : '';
  if (technicianId) {
    const { rows: techRows } = await pool.query('SELECT id, name FROM technicians WHERE id = $1', [technicianId]);
    if (techRows.length === 0) return res.status(400).json({ error: 'الفني المختار غير موجود' });
    resolvedTechnicianId = techRows[0].id;
    resolvedAssignedToName = techRows[0].name;
  }
  if (!resolvedAssignedToName) {
    return res.status(400).json({ error: 'اسم الفني المستلم إلزامي (اختاروا فنيًا أو اكتبوا اسمًا)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: itemRows } = await client.query('SELECT * FROM custody_items WHERE id = $1 FOR UPDATE', [itemId]);
    if (itemRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'العدة/المعدة غير موجودة' });
    }
    if (itemRows[0].status === 'assigned') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'هذه العدة مُسلَّمة بالفعل لفني آخر — استرجعوها أولًا' });
    }

    const { rows } = await client.query(
      `INSERT INTO custody_assignments
         (item_id, work_order_id, assigned_to, technician_id, assigned_by, assigned_by_user, expected_return_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        itemId,
        workOrderId || null,
        resolvedAssignedToName,
        resolvedTechnicianId,
        req.user.name,
        req.user.id,
        expectedReturnAt || null,
        notes ? String(notes).trim() : null,
      ]
    );
    await client.query(`UPDATE custody_items SET status = 'assigned', updated_at = now() WHERE id = $1`, [itemId]);

    // تُسجَّل حركة "صرف معدات" في سجل حركات المخزون الموحّد (نفس سجل حركات
    // المخزون الاستهلاكي) — source: 'custody' يميّزها، وبلا كمية رقمية (راجع
    // تعليق logMovement في services/inventoryMovements.js). تُسجَّل هنا داخل
    // نفس المعاملة حتى تُلغى تلقائيًا لو فشل التسليم نفسه (ROLLBACK).
    await logMovement(client, {
      itemId: itemRows[0].id,
      itemName: itemRows[0].name,
      type: 'custody_issue',
      source: 'custody',
      performedBy: req.user.name,
      performedByUser: req.user.id,
      notes: `تسليم إلى ${resolvedAssignedToName}`,
    });

    await client.query('COMMIT');

    const assignment = rows[0];
    res.status(201).json({ assignment });

    notifyEvent('custody_assigned', { ...assignment, item_name: itemRows[0].name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تسليم العهدة' });
  } finally {
    client.release();
  }
});

// PATCH /api/custody/assignments/:id/return — استرجاع عدة من فني.
router.patch('/assignments/:id/return', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { returnNotes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query('SELECT * FROM custody_assignments WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (existingRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'سجل التسليم غير موجود' });
    }
    if (existingRows[0].returned_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'هذه العهدة مُسترجَعة بالفعل' });
    }

    // نجلب اسم العدة هنا (داخل المعاملة) بدل الاكتفاء بجلبه بعد COMMIT كما
    // كان سابقًا — logMovement أدناه يحتاجه، والإشعار بعد الـ commit يعيد
    // استخدام نفس القيمة بدل استعلام مكرَّر.
    const { rows: itemRows } = await client.query('SELECT name FROM custody_items WHERE id = $1', [existingRows[0].item_id]);
    const itemName = itemRows[0]?.name || '';

    const { rows } = await client.query(
      `UPDATE custody_assignments SET returned_at = now(), return_notes = $1, returned_by = $2, returned_by_user = $3
       WHERE id = $4 RETURNING *`,
      [returnNotes ? String(returnNotes).trim() : null, req.user.name, req.user.id, req.params.id]
    );
    await client.query(`UPDATE custody_items SET status = 'available', updated_at = now() WHERE id = $1`, [existingRows[0].item_id]);

    // حركة "إعادة معدات" — تُقفل بها نفس دورة الحركة التي بدأتها "صرف معدات"
    // عند التسليم أعلاه، بنفس المعاملة (تُلغى تلقائيًا لو فشلت الاسترجاع نفسها).
    await logMovement(client, {
      itemId: existingRows[0].item_id,
      itemName,
      type: 'custody_return',
      source: 'custody',
      performedBy: req.user.name,
      performedByUser: req.user.id,
      notes: returnNotes ? String(returnNotes).trim() : null,
    });

    await client.query('COMMIT');

    const assignment = rows[0];
    res.json({ assignment });

    notifyEvent('custody_returned', { ...assignment, item_name: itemName });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء استرجاع العهدة' });
  } finally {
    client.release();
  }
});

module.exports = router;
