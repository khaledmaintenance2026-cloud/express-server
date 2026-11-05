// قسم "المخزون والقطع" بالصيانة — كتالوج أصناف (inventory_items) + طلبات
// قطع (part_requests) يرفعها الفني وتمر اختياريًا بمرحلة تصميم قبل أن يصرفها
// مسؤول المخزون فعليًا. راجع التعليق التفصيلي أعلى جدولي inventory_items
// وpart_requests في schema.sql لشرح دورة الحالة الكاملة قبل قراءة هذا الملف.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, MAINTENANCE_ROLES, INVENTORY_MANAGE_ROLES } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');
const { logMovement } = require('../services/inventoryMovements');

const router = new Router();
router.use(requireAuth, requireApproved);

// من يقدر يرى الكتالوج ويقدّم/يتابع طلبات قطع؟ كل قسم الصيانة (فني ومسؤول)
// + مسؤول المخزون + المصمم — نفس فريق "المخزون والقطع" ككل. requireRole هنا
// عام على كل مسارات القراءة، وكل مسار كتابة/إجراء يُقيَّد إضافيًا بدوره الخاص.
const ALL_INVENTORY_ROLES = [...MAINTENANCE_ROLES, 'inventory_manager', 'designer'];

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'part-designs');

// يحفظ ملف التصميم (صورة عادة) المُرسَل كـ base64 (data URL) على القرص —
// بنفس أسلوب saveEquipmentPhoto في routes/safetyPermits.js تمامًا (لا يوجد
// رفع ملفات multipart في هذا الخادم الخفيف بدون حزم خارجية).
function saveDesignFile(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('حجم ملف التصميم كبير جدًا (الحد الأقصى ٨ ميجابايت)'), { statusCode: 400 });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return `/uploads/part-designs/${filename}`;
}

// يُلحق رقم جوال صاحب طلب القطعة الأصلي (requested_by_user) بالحمولة قبل
// notifyEvent — رسالتا "تصميم جاهز"/"تم الصرف" الشخصيتان تحتاجانه، ولا يحمله
// عمود مباشر في part_requests نفسه (بنفس أسلوب created_by_phone في
// routes/workOrders.js عند إغلاق أمر عمل). فشل الجلب لا يمنع الإشعار نفسه —
// فقط تصل الرسالة الشخصية بلا رقم (تُتجاهَل بصمت من sendToPerson).
async function notifyRequesterEvent(eventType, partRequest) {
  let requesterPhone = null;
  if (partRequest.requested_by_user) {
    try {
      const { rows } = await pool.query('SELECT phone FROM users WHERE id = $1', [partRequest.requested_by_user]);
      requesterPhone = rows[0]?.phone || null;
    } catch (err) {
      console.error('تعذّر جلب رقم صاحب طلب القطعة لإثراء الإشعار:', err.message);
    }
  }
  notifyEvent(eventType, { ...partRequest, requester_phone: requesterPhone });
}

const PART_REQUEST_LIST_QUERY = `
  SELECT pr.*, i.name AS catalog_item_name, i.unit AS item_unit,
    e.name AS equipment_name_wo, wo.description AS work_order_description
  FROM part_requests pr
  LEFT JOIN inventory_items i ON i.id = pr.item_id
  LEFT JOIN work_orders wo ON wo.id = pr.work_order_id
  LEFT JOIN equipment e ON e.id = wo.equipment_id
`;

// ----------------------------------------------------------------------------
// كتالوج الأصناف
// ----------------------------------------------------------------------------

// GET /api/inventory/items — كل الأصناف (فرز أبجدي داخل كل فئة)، مع اسم
// المورّد وموقع العمل المرتبطين (إن وُجدا) لعرضهما مباشرة في بطاقة الصنف
// بلا استعلام إضافي من التطبيق.
router.get('/items', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.*, s.name AS supplier_name, ws.name AS site_name
    FROM inventory_items i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    LEFT JOIN work_sites ws ON ws.id = i.site_id
    ORDER BY i.category NULLS LAST, i.name
  `);
  res.json({ items: rows });
});

// GET /api/inventory/items/categories — الفئات المستخدمة فعليًا (بلا تكرار)
// لعرضها كاقتراحات سريعة عند إضافة صنف جديد، بدل شاشة إدارة فئات منفصلة.
router.get('/items/categories', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL AND trim(category) <> '' ORDER BY category`
  );
  res.json({ categories: rows.map((r) => r.category) });
});

// POST /api/inventory/items — إضافة صنف جديد للكتالوج. supplierId/siteId
// اختياريان (ربط المورّد وموقع العمل الافتراضيين لهذا الصنف).
router.post('/items', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, category, unit, quantity, minQuantity, notes, supplierId, siteId } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم الصنف إلزامي' });

  const finalQuantity = Number.isFinite(Number(quantity)) ? Math.max(0, Math.round(Number(quantity))) : 0;

  const { rows } = await pool.query(
    `INSERT INTO inventory_items (name, category, unit, quantity, min_quantity, notes, supplier_id, site_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      String(name).trim(),
      category ? String(category).trim() : null,
      unit && String(unit).trim() ? String(unit).trim() : 'قطعة',
      finalQuantity,
      minQuantity === null || minQuantity === undefined || minQuantity === '' ? null : Math.max(0, Math.round(Number(minQuantity))),
      notes ? String(notes).trim() : null,
      supplierId || null,
      siteId || null,
    ]
  );
  const item = rows[0];
  res.status(201).json({ item });

  // رصيد ابتدائي عند الإضافة — يُسجَّل في سجل الحركة فقط لو الصنف أُنشئ
  // برصيد أكبر من صفر (إضافة صنف جديد فارغ لا تُعتبر "حركة").
  if (finalQuantity > 0) {
    logMovement(null, {
      itemId: item.id,
      itemName: item.name,
      type: 'supply',
      quantityDelta: finalQuantity,
      quantityAfter: finalQuantity,
      performedBy: req.user.name,
      performedByUser: req.user.id,
    });
  }
});

// PATCH /api/inventory/items/:id — تعديل بيانات صنف، بما فيها تصحيح الكمية
// يدويًا (جرد مثلًا) — منفصل تمامًا عن الخصم/الإرجاع التلقائي عبر طلبات القطع.
// قرار صريح: يستقبل بيانات الصنف كاملة في كل مرة (لا COALESCE جزئي) — تمامًا
// كنمط PATCH /production/equipment/:id (راجع تعليقه) — الشاشة المقابلة في
// التطبيق نموذج تعديل كامل أصلًا، فلا داعٍ لدعم تحديث حقل واحد فقط، وهذا يمنع
// أي التباس حول تمرير undefined كمعامل استعلام لقاعدة البيانات.
router.patch('/items/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, category, unit, quantity, minQuantity, notes, supplierId, siteId } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم الصنف إلزامي' });

  const { rows: oldRows } = await pool.query('SELECT quantity FROM inventory_items WHERE id = $1', [req.params.id]);
  if (oldRows.length === 0) return res.status(404).json({ error: 'الصنف غير موجود' });
  const oldQuantity = oldRows[0].quantity;
  const newQuantity = Number.isFinite(Number(quantity)) ? Math.max(0, Math.round(Number(quantity))) : 0;

  const { rows } = await pool.query(
    `UPDATE inventory_items SET
       name = $1, category = $2, unit = $3, quantity = $4, min_quantity = $5, notes = $6, supplier_id = $7, site_id = $8, updated_at = now()
     WHERE id = $9 RETURNING *`,
    [
      String(name).trim(),
      category ? String(category).trim() : null,
      unit && String(unit).trim() ? String(unit).trim() : 'قطعة',
      newQuantity,
      minQuantity === null || minQuantity === undefined || minQuantity === '' ? null : Math.max(0, Math.round(Number(minQuantity))),
      notes ? String(notes).trim() : null,
      supplierId || null,
      siteId || null,
      req.params.id,
    ]
  );
  const item = rows[0];
  res.json({ item });

  // تصحيح يدوي للرصيد (جرد مثلًا) — يُسجَّل في سجل الحركة فقط لو الكمية
  // تغيّرت فعليًا عن القيمة السابقة.
  const delta = newQuantity - oldQuantity;
  if (delta !== 0) {
    logMovement(null, {
      itemId: item.id,
      itemName: item.name,
      type: 'stock_adjustment',
      quantityDelta: delta,
      quantityAfter: newQuantity,
      performedBy: req.user.name,
      performedByUser: req.user.id,
    });
  }
});

// DELETE /api/inventory/items/:id
router.delete('/items/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'الصنف غير موجود' });
  res.json({ ok: true });
});

// POST /api/inventory/items/:id/movement — "حركة مخزون سريعة": ودجت البحث عن
// صنف (بالاسم/الكود) + تسجيل حركة مباشرة عليه بلا فتح نموذج تعديل الصنف
// الكامل. ثلاثة أنواع فقط مسموحة هنا (توريد/صرف استهلاكي/تسوية جرد) —
// حركات العهدة (صرف/إعادة معدات) لا تمس inventory_items أصلًا فمكانها
// routes/custody.js، وتصحيح مخزون (stock_adjustment) يبقى محصورًا بنموذج
// تعديل الصنف الكامل (PATCH /items/:id) عمدًا — عملية منفصلة تمامًا عن هذا
// الودجت السريع، حتى لو كان أثرها الحسابي على الرصيد مشابهًا لتسوية الجرد.
//
// معنى "quantity" يختلف حسب النوع: توريد/صرف = كمية الحركة نفسها (تُضاف أو
// تُطرح من الرصيد الحالي)، بينما تسوية جرد = الرصيد الفعلي المعدود بعد الجرد
// (يُحسب الفرق تلقائيًا كـ delta) — يطابق فكرة "تسوية" التي تصفّر الفرق بين
// المسجَّل والمعدود فعليًا بدل إدخال فرق يدوي قد يُحسب خطأ.
router.post('/items/:id/movement', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { type, quantity, notes } = req.body;
  if (!['supply', 'consumable_issue', 'stock_reconciliation'].includes(type)) {
    return res.status(400).json({ error: 'نوع الحركة غير صالح لهذا الإجراء (توريد / صرف استهلاكي / تسوية جرد فقط)' });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) {
    return res.status(400).json({ error: 'الكمية غير صالحة' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: itemRows } = await client.query('SELECT * FROM inventory_items WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (itemRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الصنف غير موجود' });
    }
    const item = itemRows[0];

    let delta;
    let newQuantity;
    if (type === 'stock_reconciliation') {
      newQuantity = Math.max(0, Math.round(qty));
      delta = newQuantity - item.quantity;
    } else if (type === 'supply') {
      delta = Math.max(0, Math.round(qty));
      newQuantity = item.quantity + delta;
    } else {
      const issueQty = Math.max(0, Math.round(qty));
      if (issueQty > item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `الكمية المتوفرة (${item.quantity}) أقل من كمية الصرف المطلوبة (${issueQty})`,
        });
      }
      delta = -issueQty;
      newQuantity = item.quantity - issueQty;
    }

    if (delta === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يوجد تغيير فعلي في الرصيد لتسجيله' });
    }

    await client.query('UPDATE inventory_items SET quantity = $1, updated_at = now() WHERE id = $2', [newQuantity, item.id]);
    await logMovement(client, {
      itemId: item.id,
      itemName: item.name,
      type,
      quantityDelta: delta,
      quantityAfter: newQuantity,
      performedBy: req.user.name,
      performedByUser: req.user.id,
      notes: notes ? String(notes).trim() : null,
    });
    await client.query('COMMIT');

    const { rows: freshRows } = await pool.query(`
      SELECT i.*, s.name AS supplier_name, ws.name AS site_name
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN work_sites ws ON ws.id = i.site_id
      WHERE i.id = $1
    `, [item.id]);
    res.json({ item: freshRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الحركة' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// الموردون — سجل مستقل (اسم، جهة اتصال، هاتف، بريد، عنوان، نشط/غير نشط)
// يُربط اختياريًا بأصناف الكتالوج عبر inventory_items.supplier_id.
// ----------------------------------------------------------------------------

// GET /api/inventory/suppliers
router.get('/suppliers', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM suppliers ORDER BY active DESC, name');
  res.json({ suppliers: rows });
});

// POST /api/inventory/suppliers
router.post('/suppliers', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, contactName, phone, email, address, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم المورّد إلزامي' });

  const { rows } = await pool.query(
    `INSERT INTO suppliers (name, contact_name, phone, email, address, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      String(name).trim(),
      contactName ? String(contactName).trim() : null,
      phone ? String(phone).trim() : null,
      email ? String(email).trim() : null,
      address ? String(address).trim() : null,
      notes ? String(notes).trim() : null,
    ]
  );
  res.status(201).json({ supplier: rows[0] });
});

// PATCH /api/inventory/suppliers/:id — يشمل تفعيل/تعطيل المورّد (active)
// بدل حذفه، حتى لا تنكسر الأصناف المرتبطة به تاريخيًا.
router.patch('/suppliers/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, contactName, phone, email, address, active, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم المورّد إلزامي' });

  const { rows } = await pool.query(
    `UPDATE suppliers SET
       name = $1, contact_name = $2, phone = $3, email = $4, address = $5, active = $6, notes = $7, updated_at = now()
     WHERE id = $8 RETURNING *`,
    [
      String(name).trim(),
      contactName ? String(contactName).trim() : null,
      phone ? String(phone).trim() : null,
      email ? String(email).trim() : null,
      address ? String(address).trim() : null,
      active === undefined || active === null ? true : Boolean(active),
      notes ? String(notes).trim() : null,
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المورّد غير موجود' });
  res.json({ supplier: rows[0] });
});

// DELETE /api/inventory/suppliers/:id — حذف فعلي؛ الأصناف المرتبطة به
// (supplier_id) تُصبح تلقائيًا بلا مورّد (ON DELETE SET NULL في schema.sql)
// بدل رفض الحذف أو حذف الأصناف نفسها.
router.delete('/suppliers/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'المورّد غير موجود' });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// مواقع العمل — كيانات مُدارة (بدل نص حر) يُربط بها اختياريًا أصناف الكتالوج
// عبر inventory_items.site_id.
// ----------------------------------------------------------------------------

// GET /api/inventory/sites
router.get('/sites', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM work_sites ORDER BY active DESC, name');
  res.json({ sites: rows });
});

// POST /api/inventory/sites
router.post('/sites', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم موقع العمل إلزامي' });

  const { rows } = await pool.query(
    `INSERT INTO work_sites (name, notes) VALUES ($1, $2) RETURNING *`,
    [String(name).trim(), notes ? String(notes).trim() : null]
  );
  res.status(201).json({ site: rows[0] });
});

// PATCH /api/inventory/sites/:id
router.patch('/sites/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { name, notes, active } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم موقع العمل إلزامي' });

  const { rows } = await pool.query(
    `UPDATE work_sites SET name = $1, notes = $2, active = $3, updated_at = now() WHERE id = $4 RETURNING *`,
    [
      String(name).trim(),
      notes ? String(notes).trim() : null,
      active === undefined || active === null ? true : Boolean(active),
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الموقع غير موجود' });
  res.json({ site: rows[0] });
});

// DELETE /api/inventory/sites/:id
router.delete('/sites/:id', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM work_sites WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'الموقع غير موجود' });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// طلبات القطع
// ----------------------------------------------------------------------------

// GET /api/inventory/part-requests — دعم فلترة اختيارية بالحالة.
router.get('/part-requests', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { status } = req.query;
  const sql = status
    ? `${PART_REQUEST_LIST_QUERY} WHERE pr.status = $1 ORDER BY pr.created_at DESC`
    : `${PART_REQUEST_LIST_QUERY} ORDER BY pr.created_at DESC`;
  const { rows } = await pool.query(sql, status ? [status] : []);
  res.json({ partRequests: rows });
});

// POST /api/inventory/part-requests — الفني (أو مسؤول الصيانة) يقدّم طلب
// قطعة، إما من صنف موجود في الكتالوج (itemId) أو باسم حر لقطعة غير مكتلَنة
// بعد تحتاج تصميمًا (itemName + needsDesign: true). لا يُخصم أي شيء من
// المخزون هنا — فقط عند تأكيد الصرف لاحقًا (PATCH /:id/issue). مسؤول المخزون
// (inventory_manager) مضاف هنا صراحة — قرار 2026-10-03 — كانت هذه الثغرة
// الوحيدة المتبقية في صلاحياته داخل قسم المخزون (كل مسارات القراءة والتعديل
// الأخرى هنا كانت تشمله أصلًا عبر ALL_INVENTORY_ROLES/INVENTORY_MANAGE_ROLES).
router.post('/part-requests', requireRole(...MAINTENANCE_ROLES, 'inventory_manager'), async (req, res) => {
  const { itemId, itemName, quantity, workOrderId, notes, needsDesign } = req.body;

  let resolvedItemName = itemName ? String(itemName).trim() : '';
  if (itemId) {
    const { rows: itemRows } = await pool.query('SELECT name FROM inventory_items WHERE id = $1', [itemId]);
    if (itemRows.length === 0) return res.status(400).json({ error: 'الصنف المختار غير موجود في الكتالوج' });
    resolvedItemName = itemRows[0].name;
  }
  if (!resolvedItemName) return res.status(400).json({ error: 'اسم القطعة إلزامي (اختر صنفًا من الكتالوج أو اكتب اسمًا)' });

  const qty = Number.isFinite(Number(quantity)) && Number(quantity) > 0 ? Math.round(Number(quantity)) : 1;
  const needsDesignBool = Boolean(needsDesign);

  // يحاول ربط الطلب بسجل الفني صاحب الحساب (إن وُجد) — لعرض "طلباتي" لاحقًا
  // في التطبيق؛ فشل الربط لا يمنع إنشاء الطلب نفسه أبدًا.
  let technicianId = null;
  try {
    const { rows: techRows } = await pool.query('SELECT id FROM technicians WHERE user_id = $1', [req.user.id]);
    if (techRows.length > 0) technicianId = techRows[0].id;
  } catch (err) {
    console.error('تعذّر ربط طلب القطعة بسجل الفني:', err.message);
  }

  const { rows } = await pool.query(
    `INSERT INTO part_requests
       (item_id, item_name, quantity, work_order_id, notes, needs_design, status, requested_by, requested_by_user, technician_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      itemId || null,
      resolvedItemName,
      qty,
      workOrderId || null,
      notes ? String(notes).trim() : null,
      needsDesignBool,
      needsDesignBool ? 'pending_design' : 'pending_issue',
      req.user.name,
      req.user.id,
      technicianId,
    ]
  );
  const partRequest = rows[0];
  res.status(201).json({ partRequest });

  fireWebhook('part_request_created', partRequest);
  notifyEvent('part_request_created', partRequest);
});

// DELETE /api/inventory/part-requests/:id — إلغاء طلب لم يُصرف بعد (بانتظار
// تصميم أو بانتظار صرف فقط) — يقدر عليه صاحب الطلب نفسه، أو من يدير المخزون.
router.delete('/part-requests/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM part_requests WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'الطلب غير موجود' });
  const partRequest = rows[0];

  const isOwner = partRequest.requested_by_user === req.user.id;
  const isManager = req.user.role === 'admin' || INVENTORY_MANAGE_ROLES.includes(req.user.role);
  if (!isOwner && !isManager) return res.status(403).json({ error: 'لا تقدر تلغي طلب قطعة لم ترفعه أنت' });
  if (partRequest.status === 'issued' || partRequest.status === 'returned') {
    return res.status(400).json({ error: 'لا يمكن إلغاء طلب صُرف بالفعل — استخدم "إرجاع للمخزون" بدل ذلك' });
  }

  await pool.query('DELETE FROM part_requests WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// PATCH /api/inventory/part-requests/:id/design — المصمم يرفع نتيجة التصميم
// (ملف/صورة + ملاحظات) فينتقل الطلب لمرحلة "بانتظار الصرف".
router.patch('/part-requests/:id/design', requireRole('designer', 'maintenance_manager'), async (req, res) => {
  const { designFileDataUrl, designNotes } = req.body;

  const { rows: existingRows } = await pool.query('SELECT * FROM part_requests WHERE id = $1', [req.params.id]);
  if (existingRows.length === 0) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (existingRows[0].status !== 'pending_design') {
    return res.status(400).json({ error: 'هذا الطلب ليس بانتظار تصميم' });
  }

  let designFileUrl = null;
  try {
    designFileUrl = saveDesignFile(designFileDataUrl);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    throw err;
  }
  if (!designFileUrl) return res.status(400).json({ error: 'يجب إرفاق ملف/صورة التصميم' });

  const { rows } = await pool.query(
    `UPDATE part_requests SET
       status = 'pending_issue', design_file_url = $1, design_notes = $2,
       designed_by = $3, designed_by_user = $4, designed_at = now()
     WHERE id = $5 RETURNING *`,
    [designFileUrl, designNotes ? String(designNotes).trim() : null, req.user.name, req.user.id, req.params.id]
  );
  const partRequest = rows[0];
  res.json({ partRequest });

  fireWebhook('part_request_designed', partRequest);
  notifyRequesterEvent('part_request_designed', partRequest);
});

// PATCH /api/inventory/part-requests/:id/issue — مسؤول المخزون (أو مسؤول
// الصيانة) يؤكد صرف القطعة فعليًا للفني — هذه هي اللحظة الوحيدة التي يُخصم
// فيها العدد من inventory_items.quantity (لو كان item_id مرتبطًا بصنف كتالوج
// فعلي؛ قطعة مخصّصة بلا صنف تُصرف بلا أي أثر على أي رصيد).
router.patch('/part-requests/:id/issue', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query('SELECT * FROM part_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (existingRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    const existing = existingRows[0];
    if (existing.status !== 'pending_issue') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'هذا الطلب ليس بانتظار الصرف' });
    }

    if (existing.item_id) {
      const { rows: itemRows } = await client.query('SELECT quantity FROM inventory_items WHERE id = $1 FOR UPDATE', [existing.item_id]);
      if (itemRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'صنف المخزون المرتبط بهذا الطلب لم يعد موجودًا' });
      }
      if (itemRows[0].quantity < existing.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `الكمية المتوفرة (${itemRows[0].quantity}) أقل من الكمية المطلوبة (${existing.quantity}) — عدّلوا رصيد المخزون أولًا`,
        });
      }
      const { rows: updatedItemRows } = await client.query(
        'UPDATE inventory_items SET quantity = quantity - $1, updated_at = now() WHERE id = $2 RETURNING quantity',
        [existing.quantity, existing.item_id]
      );
      await logMovement(client, {
        itemId: existing.item_id,
        itemName: existing.item_name,
        type: 'consumable_issue',
        quantityDelta: -existing.quantity,
        quantityAfter: updatedItemRows[0].quantity,
        partRequestId: existing.id,
        performedBy: req.user.name,
        performedByUser: req.user.id,
      });
    }

    const { rows } = await client.query(
      `UPDATE part_requests SET status = 'issued', issued_by = $1, issued_by_user = $2, issued_at = now()
       WHERE id = $3 RETURNING *`,
      [req.user.name, req.user.id, req.params.id]
    );
    await client.query('COMMIT');
    const partRequest = rows[0];
    res.json({ partRequest });

    fireWebhook('part_request_issued', partRequest);
    notifyRequesterEvent('part_request_issued', partRequest);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تأكيد صرف القطعة' });
  } finally {
    client.release();
  }
});

// PATCH /api/inventory/part-requests/:id/return — القطعة صُرفت لكن لم
// تُستخدم فعليًا (أُنجزت المهمة بدونها) — تعيد العدد لرصيد المخزون إن كانت
// مرتبطة بصنف كتالوج فعلي.
router.patch('/part-requests/:id/return', requireRole(...INVENTORY_MANAGE_ROLES), async (req, res) => {
  const { returnNotes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query('SELECT * FROM part_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (existingRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    const existing = existingRows[0];
    if (existing.status !== 'issued') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يمكن إرجاع طلب لم يُصرف بعد' });
    }

    if (existing.item_id) {
      const { rows: updatedItemRows } = await client.query(
        'UPDATE inventory_items SET quantity = quantity + $1, updated_at = now() WHERE id = $2 RETURNING quantity',
        [existing.quantity, existing.item_id]
      );
      await logMovement(client, {
        itemId: existing.item_id,
        itemName: existing.item_name,
        type: 'supply',
        quantityDelta: existing.quantity,
        quantityAfter: updatedItemRows[0].quantity,
        partRequestId: existing.id,
        performedBy: req.user.name,
        performedByUser: req.user.id,
        notes: returnNotes ? String(returnNotes).trim() : null,
      });
    }

    const { rows } = await client.query(
      `UPDATE part_requests SET status = 'returned', returned_at = now(), return_notes = $1 WHERE id = $2 RETURNING *`,
      [returnNotes ? String(returnNotes).trim() : null, req.params.id]
    );
    await client.query('COMMIT');
    const partRequest = rows[0];
    res.json({ partRequest });

    notifyEvent('part_request_returned', partRequest);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إرجاع القطعة للمخزون' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// سجل حركات المخزون
// ----------------------------------------------------------------------------

// GET /api/inventory/movements — كل حركة أثّرت فعليًا على رصيد صنف (رصيد
// ابتدائي عند الإضافة، تصحيح يدوي، صرف/إرجاع طلب قطعة) — للمراجعة والتدقيق
// فقط، لا تعديل هنا. فلترة اختيارية بصنف واحد (itemId) لعرض تاريخ حركة صنف
// بعينه من داخل شاشته مباشرة.
router.get('/movements', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const { itemId } = req.query;
  const sql = itemId
    ? `SELECT * FROM inventory_movements WHERE item_id = $1 ORDER BY created_at DESC LIMIT 500`
    : `SELECT * FROM inventory_movements ORDER BY created_at DESC LIMIT 500`;
  const { rows } = await pool.query(sql, itemId ? [itemId] : []);
  res.json({ movements: rows });
});

// ----------------------------------------------------------------------------
// تصدير CSV
// ----------------------------------------------------------------------------

// نفس دالة toCsv المستخدمة في routes/reports.js بالضبط (راجع تعليقها هناك) —
// مكرَّرة هنا بدل استيرادها من ملف آخر لتجنّب أي ترابط بين ملفي المسارات لا
// علاقة له بمنطق العمل نفسه.
function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return '﻿' + lines.join('\n'); // BOM حتى يفتح إكسل النص العربي بشكل صحيح
}

// GET /api/inventory/export.csv?type=items|movements
//
// يُفتح من داخل التطبيق عبر رابط خارجي (url_launcher) وليس عبر fetch داخلي،
// لذلك لا يقدر يُرسل ترويسة Authorization — يقبل رمز الدخول (JWT) نفسه عبر
// ?token= بدلًا منها (راجع تعليق requireAuth في middleware/auth.js لشرح
// السبب والتقييد الدقيق لهذا الاستثناء).
router.get('/export.csv', requireRole(...ALL_INVENTORY_ROLES), async (req, res) => {
  const type = req.query.type;
  let sql;

  if (type === 'items') {
    sql = `
      SELECT i.id, i.name, i.category, i.unit, i.quantity, i.min_quantity,
        s.name AS supplier, ws.name AS site, i.notes, i.created_at
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN work_sites ws ON ws.id = i.site_id
      ORDER BY i.category NULLS LAST, i.name`;
  } else if (type === 'movements') {
    sql = `SELECT id, item_name, type, source, quantity_delta, quantity_after, performed_by, notes, created_at
           FROM inventory_movements ORDER BY created_at DESC LIMIT 5000`;
  } else {
    return res.status(400).json({ error: 'نوع التصدير غير معروف (استخدم items أو movements)' });
  }

  const { rows } = await pool.query(sql);
  const csv = toCsv(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventory-${type}.csv"`);
  res.send(csv);
});

module.exports = router;
