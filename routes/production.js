const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, MAINTENANCE_ROLES, PRODUCTION_ROLES } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');
const { generateProductionReport } = require('../services/productionReport');
const { sendWhatsappText } = require('../services/textmebot');
const { fetchWorkOrderForLink, computeStoppageFromWorkOrder, findAutoLinkWorkOrder } = require('../services/batchWorkOrderLink');

const router = new Router();

// حذف خط الإنتاج لا يحذف سجلاته أبدًا (باتشات، بلاغات أعطال، معدات، أوامر صيانة):
// الخط ذو السجلات يُؤرشَف فقط بتعبئة عمود deleted_at (يختفي من قوائم الخطوط)،
// وتبقى كل سجلاته مربوطة به وتظهر في التقارير التاريخية. العمود يُنشأ تلقائيًا
// عند أول تشغيل (بنفس نمط بقية ensure… في السيرفر) فلا حاجة لأي ترحيل يدوي.
let linesArchiveReady = null;
function ensureLinesArchive() {
  if (!linesArchiveReady) {
    linesArchiveReady = pool
      .query('ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ')
      .then(() => true)
      .catch((err) => {
        linesArchiveReady = null; // نعيد المحاولة في الطلب التالي بدل تثبيت الفشل
        throw err;
      });
  }
  return linesArchiveReady;
}
ensureLinesArchive().catch((err) => console.error('تعذّر تجهيز عمود deleted_at لخطوط الإنتاج:', err.message));

router.use(requireAuth, requireApproved, async (req, res, next) => {
  await ensureLinesArchive();
  next();
});

// يُعيد المصنع الذي يُقيَّد به المستخدم الحالي (أو null إن كان يرى كل
// المصانع بلا تقييد) — مدير النظام (admin) لا يتقيّد بهذا أبدًا. راجع عمود
// production_facility في جدول users (schema.sql) ولوحة الإدارة لتخصيصه.
function userFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.production_facility || null;
}

// ---------------------------------------------------------------------------
// خطوط الإنتاج
// ---------------------------------------------------------------------------
router.get('/lines', async (req, res) => {
  const facility = userFacility(req);
  const { rows } = facility
    ? await pool.query('SELECT * FROM production_lines WHERE deleted_at IS NULL AND location = $1 ORDER BY name', [facility])
    : await pool.query('SELECT * FROM production_lines WHERE deleted_at IS NULL ORDER BY name');
  res.json({ lines: rows });
});

router.post('/lines', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const { name, location } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم الخط إلزامي' });
  const facility = userFacility(req);
  // مستخدم مقيَّد بمصنع واحد: يُنشأ الخط في مصنعه دائمًا، ويُرفض أي محاولة
  // لتحديد مصنع آخر صراحة من الواجهة.
  if (facility && location && location !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية إضافة خط إنتاج خارج مصنعك' });
  }
  const cleanName = String(name).trim();
  if (!cleanName) return res.status(400).json({ error: 'اسم الخط إلزامي' });
  const targetLocation = facility || location || 'المستودع العام';

  // اسم الخط فريد. لو وُجد خط بنفس الاسم: إن كان محذوفًا سابقًا (مؤرشفًا) نعيده
  // بكل سجلاته القديمة بدل رفض الاسم أو إنشاء خط فارغ منفصل — وهذا ما يحمي
  // بيانات خط حُذف ثم أُعيد إنشاؤه بنفس الاسم. وإن كان نشطًا نرفض بوضوح.
  const dup = await pool.query('SELECT id, location, deleted_at FROM production_lines WHERE name = $1', [cleanName]);
  if (dup.rows.length > 0) {
    const old = dup.rows[0];
    if (!old.deleted_at) {
      return res.status(409).json({ error: 'يوجد خط بنفس هذا الاسم' });
    }
    if (old.location !== targetLocation) {
      return res.status(409).json({
        error: `كان هنالك خط محذوف بنفس الاسم في (${old.location}) وسجلاته محفوظة، اختر اسمًا مختلفًا أو أنشئه في ${old.location}`,
      });
    }
    const restored = await pool.query(
      'UPDATE production_lines SET deleted_at = NULL, active = true WHERE id = $1 RETURNING *',
      [old.id]
    );
    return res.status(201).json({ line: restored.rows[0], restored: true });
  }

  const { rows } = await pool.query(
    'INSERT INTO production_lines (name, location) VALUES ($1, $2) RETURNING *',
    [cleanName, targetLocation]
  );
  res.status(201).json({ line: rows[0] });
});

router.patch('/lines/:id', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const { name, location, active } = req.body;
  const facility = userFacility(req);
  if (facility) {
    const existing = await pool.query('SELECT location FROM production_lines WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'الخط غير موجود' });
    if (existing.rows[0].location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية تعديل خط تابع لقسم آخر' });
    }
    if (location && location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية نقل الخط لمصنع آخر' });
    }
  }
  if (name !== undefined && name !== null) {
    const clash = await pool.query('SELECT id, deleted_at FROM production_lines WHERE name = $1 AND id <> $2::bigint', [String(name).trim(), req.params.id]);
    if (clash.rows.length > 0) {
      return res.status(409).json({
        error: clash.rows[0].deleted_at
          ? 'هذا الاسم كان لخط محذوف سابقًا وسجلاته محفوظة، اختر اسمًا مختلفًا'
          : 'يوجد خط بنفس هذا الاسم',
      });
    }
  }
  const { rows } = await pool.query(
    `UPDATE production_lines SET
       name = COALESCE($1, name), location = COALESCE($2, location), active = COALESCE($3, active)
     WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
    [name === undefined || name === null ? null : String(name).trim(), location, active, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الخط غير موجود' });
  res.json({ line: rows[0] });
});

// حذف خط إنتاج — لا يُحذف أي إدخال أبدًا. الخط الذي له سجلات (باتشات، بلاغات
// أعطال، معدات، أوامر صيانة) يُؤرشَف فقط (deleted_at) فيختفي من قوائم الخطوط
// وتبقى سجلاته كاملة ومربوطة به وتظهر في التقارير التاريخية؛ وإعادة إنشاء خط
// بنفس اسمه (نفس المصنع) تُعيده بكل سجلاته. أما الخط الفارغ تمامًا فيُحذف فعليًا.
// (سابقًا كان DELETE الفعلي يفكّ ارتباط السجلات عبر ON DELETE SET NULL فتختفي
// من شاشات الإنتاج رغم بقائها في قاعدة البيانات.)
router.delete('/lines/:id', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const facility = userFacility(req);
  const existing = await pool.query('SELECT id, location FROM production_lines WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'الخط غير موجود' });
  if (facility && existing.rows[0].location !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية حذف خط تابع لقسم آخر' });
  }
  const used = await pool.query(
    `SELECT (SELECT count(*) FROM production_batches WHERE line_id = $1::bigint)
          + (SELECT count(*) FROM incident_reports WHERE line_id = $1::bigint)
          + (SELECT count(*) FROM equipment WHERE line_id = $1::bigint)
          + (SELECT count(*) FROM work_orders WHERE line_id = $1::bigint) AS total`,
    [req.params.id]
  );
  if (Number(used.rows[0].total) > 0) {
    await pool.query('UPDATE production_lines SET deleted_at = now() WHERE id = $1::bigint', [req.params.id]);
  } else {
    await pool.query('DELETE FROM production_lines WHERE id = $1::bigint', [req.params.id]);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// المعدات
// ---------------------------------------------------------------------------
router.get('/equipment', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM equipment ORDER BY name');
  res.json({ equipment: rows });
});

router.post('/equipment', requireRole(...PRODUCTION_ROLES, ...MAINTENANCE_ROLES), async (req, res) => {
  const { name, lineId, code, type, facility } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم المعدة إلزامي' });
  const { rows } = await pool.query(
    'INSERT INTO equipment (name, line_id, code, type, facility) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name.trim(), lineId || null, code || null, type || 'أخرى', facility || null]
  );
  res.status(201).json({ equipment: rows[0] });
});

// ملاحظة: lineId وcode وfacility تُرسَل دائمًا من نموذج التعديل في الواجهة
// (قيمة أو null) لذا نضبطها مباشرة بدل COALESCE (لتفادي تجاهل تفريغها).
// facility تُحفظ فقط كمرجع عند عدم وجود خط (راجع equipmentByFacility في
// app_state.dart)، ويُعاد ضبطها من الواجهة عند كل تعديل لتصحيح المعدات
// القديمة التي أُضيفت قبل وجود هذا الحقل.
router.patch('/equipment/:id', requireRole(...PRODUCTION_ROLES, ...MAINTENANCE_ROLES), async (req, res) => {
  const { name, lineId, code, type, facility } = req.body;
  const { rows } = await pool.query(
    `UPDATE equipment SET
       name = COALESCE($1, name), line_id = $2, code = $3, type = COALESCE($4, type), facility = $5
     WHERE id = $6 RETURNING *`,
    [name || null, lineId || null, code || null, type || null, facility || null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المعدة غير موجودة' });
  res.json({ equipment: rows[0] });
});

// حذف معدة — نفس منطق الخطوط، البلاغات المرتبطة تبقى لكن بدون ربط equipment_id.
router.delete('/equipment/:id', requireRole(...PRODUCTION_ROLES, ...MAINTENANCE_ROLES), async (req, res) => {
  const { rows } = await pool.query('DELETE FROM equipment WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'المعدة غير موجودة' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// بلاغات أعطال الإنتاج الفورية + تتبع زمن التوقف
// ---------------------------------------------------------------------------
router.get('/incidents', async (req, res) => {
  const facility = userFacility(req);
  const { rows } = await pool.query(
    `SELECT i.*, l.name AS line_name, l.location AS facility, e.name AS equipment_name,
      CASE WHEN i.downtime_ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (i.downtime_ended_at - i.downtime_started_at)) / 60
        ELSE EXTRACT(EPOCH FROM (now() - i.downtime_started_at)) / 60
      END AS downtime_minutes
    FROM incident_reports i
    LEFT JOIN production_lines l ON l.id = i.line_id
    LEFT JOIN equipment e ON e.id = i.equipment_id
    ${facility ? 'WHERE l.location = $1' : ''}
    ORDER BY i.reported_at DESC`,
    facility ? [facility] : []
  );
  res.json({ incidents: rows });
});

const INCIDENT_SEVERITIES = ['simple', 'medium', 'critical'];
const INCIDENT_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'incidents');

// يحفظ صورة بلاغ العطل المُرسَلة كـ base64 (data URL) — بنفس أسلوب صورة
// معدات تصريح السلامة تمامًا (راجع saveEquipmentPhoto في routes/safetyPermits.js
// لشرح مفصّل لسبب هذا الأسلوب بدل رفع ملفات multipart).
function saveIncidentPhoto(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('حجم صورة البلاغ كبير جدًا (الحد الأقصى ٨ ميجابايت)'), { statusCode: 400 });
  }
  fs.mkdirSync(INCIDENT_UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(INCIDENT_UPLOAD_DIR, filename), buf);
  return `/uploads/incidents/${filename}`;
}

router.post('/incidents', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const { lineId, equipmentId, description, severity, photo, expectedBatchNumber } = req.body;
  if (!description) return res.status(400).json({ error: 'وصف العطل إلزامي' });
  if (severity && !INCIDENT_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: 'تصنيف نوع العطل غير صحيح' });
  }
  const facility = userFacility(req);

  // نجلب مصنع الخط واسمه (إن وُجد lineId) دائمًا — سواء كان المستخدم مقيَّدًا
  // أم لا — لأننا نحتاجه لتحديد مصنع البلاغ نفسه (لإرسال ويبهوك واتساب
  // مخصّص لمصنع بعينه لاحقًا، مثلاً)، وأيضًا لإظهار اسم الخط في رسالة واتساب
  // "بلاغ عطل مفاجئ" — وليس فقط للتحقق من صلاحية المستخدم المقيَّد.
  let lineLocation = null;
  let lineName = null;
  if (lineId) {
    const lineCheck = await pool.query('SELECT name, location FROM production_lines WHERE id = $1 AND deleted_at IS NULL', [lineId]);
    if (lineCheck.rows.length === 0) {
      return res.status(400).json({ error: 'الخط المحدد غير موجود' });
    }
    lineLocation = lineCheck.rows[0].location;
    lineName = lineCheck.rows[0].name;
  }

  if (facility) {
    // مستخدم مقيَّد بمصنع واحد: يجب اختيار خط تابع لمصنعه تحديدًا، لا يمكنه
    // إرسال بلاغ بدون خط أو بخط من مصنع آخر.
    if (!lineId) return res.status(400).json({ error: 'اختر خطًا تابعًا لمصنعك أولًا' });
    if (lineLocation !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية الإبلاغ عن خط تابع لقسم آخر' });
    }
  }

  // اسم/كود معدة البلاغ (إن حُدِّدت) — نجلبهما هنا مرة واحدة لإظهارهما في
  // رسالة واتساب "بلاغ عطل مفاجئ" (اسم المعدة + رقم كودها).
  let equipmentName = null;
  let equipmentCode = null;
  if (equipmentId) {
    const eqCheck = await pool.query('SELECT name, code FROM equipment WHERE id = $1', [equipmentId]);
    if (eqCheck.rows.length > 0) {
      equipmentName = eqCheck.rows[0].name;
      equipmentCode = eqCheck.rows[0].code;
    }
  }

  // صورة اختيارية للعطل (data URL) — بنفس أسلوب صورة معدات تصريح السلامة.
  let photoPath = null;
  if (photo) {
    try {
      photoPath = saveIncidentPhoto(photo);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    if (!photoPath) return res.status(400).json({ error: 'صيغة صورة البلاغ غير صحيحة' });
  }

  // رقم الباتش المتوقع (اختياري) — يكتبه مشرف الإنتاج لحظة رفع البلاغ نفسه،
  // قبل معرفة أي شيء عن الباتش سوى رقمه المتوقع. يُنسَخ تلقائيًا إلى أمر
  // الصيانة عند تحويل هذا البلاغ إليه (راجع routes/workOrders.js)، ثم يُستخدم
  // لاحقًا لمطابقة/ربط الباتش تلقائيًا فور تسجيله الفعلي بنفس الرقم على نفس
  // الخط (راجع services/batchWorkOrderLink.js: findAutoLinkWorkOrder).
  const expectedBatchNumberValue = expectedBatchNumber && String(expectedBatchNumber).trim()
    ? String(expectedBatchNumber).trim()
    : null;

  const { rows } = await pool.query(
    `INSERT INTO incident_reports (line_id, equipment_id, description, reported_by, reported_by_user, severity, photo_path, expected_batch_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [lineId || null, equipmentId || null, description.trim(), req.user.name, req.user.id, severity || null, photoPath, expectedBatchNumberValue]
  );
  // نُرفق مصنع الخط ضمن حمولة الويبهوك (data.facility) حتى تقدر أتمتة واتساب
  // (n8n مثلاً) على قراءته مباشرة، إضافة لفلترة السيرفر نفسه حسب مصنع الويبهوك.
  // نُرفق أيضًا رقم رافع البلاغ الشخصي (إن كان مسجَّلًا في بياناته)، واسم
  // الخط، واسم/كود المعدة — كلها تُستخدم في رسالة واتساب المفصّلة الجديدة
  // (راجع services/notifications.js).
  const incident = {
    ...rows[0],
    facility: lineLocation,
    line_name: lineName,
    equipment_name: equipmentName,
    equipment_code: equipmentCode,
    reported_by_phone: req.user.phone || null,
  };
  fireWebhook('incident_created', incident, lineLocation);
  notifyEvent('incident_created', incident);
  res.status(201).json({ incident });
});

// إنهاء فترة التوقف يدويًا (عادة يحدث تلقائيًا عند إغلاق أمر العمل المرتبط)
router.patch('/incidents/:id/end-downtime', requireRole(...PRODUCTION_ROLES, ...MAINTENANCE_ROLES), async (req, res) => {
  const facility = userFacility(req);
  if (facility) {
    const check = await pool.query(
      'SELECT l.location FROM incident_reports i LEFT JOIN production_lines l ON l.id = i.line_id WHERE i.id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0 || check.rows[0].location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية التعامل مع بلاغ تابع لقسم آخر' });
    }
  }
  const { rows } = await pool.query(
    "UPDATE incident_reports SET downtime_ended_at = now(), status = 'closed' WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'البلاغ غير موجود' });
  res.json({ incident: rows[0] });
});

// ---------------------------------------------------------------------------
// باتشات الإنتاج — كانت محلية على جهاز المشرف فقط، أصبحت الآن محفوظة على
// السيرفر (راجع الترحيل في schema.sql) بنفس نمط بلاغات الأعطال أعلاه.
// ---------------------------------------------------------------------------

// GET /api/production/batches — يدعم from/to (تاريخ ISO) اختياريَّين لتقرير
// بمدة مخصصة لاحقًا؛ بدونهما يُرجِع كل الباتشات (الواجهة تفلتر "اليوم" بنفسها).
// الفلترة والترتيب على occurred_at (التاريخ "الفعلي" للباتش) وليس created_at
// (وقت الإدخال الحقيقي) — حتى يظهر باتش سُجِّل اليوم بتاريخ أمس في مكانه
// الصحيح ضمن تقرير أمس، لا ضمن تقرير اليوم. راجع الترحيل في schema.sql.
// workOrderId اختياري إضافي: يُستخدم من شاشة أمر الصيانة نفسها لعرض "الباتشات
// المتأثرة بهذا العمل" — بلا قيد صلاحية دور خاص (نفس هذا المسار مفتوح أصلًا
// لكل الأدوار المعتمدة)، لأن فريق الصيانة يحتاج رؤية أثر عمله على الإنتاج.
router.get('/batches', async (req, res) => {
  const facility = userFacility(req);
  const { from, to, workOrderId } = req.query;
  const conditions = [];
  const params = [];
  if (facility) { params.push(facility); conditions.push(`l.location = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`b.occurred_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`b.occurred_at <= $${params.length}`); }
  if (workOrderId) { params.push(workOrderId); conditions.push(`b.work_order_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT b.*, l.name AS line_name, l.location AS facility
     FROM production_batches b
     LEFT JOIN production_lines l ON l.id = b.line_id
     ${where}
     ORDER BY b.occurred_at DESC`,
    params
  );
  res.json({ batches: rows });
});

// occurredAt اختياري — تاريخ/وقت الباتش "الفعلي" (بصيغة ISO)، يسمح بتسجيل
// باتش بتاريخ سابق. بلا حد على القدم؛ لو أُرسل تاريخ غير صالح نرفضه، وإلا
// نستخدم الوقت الحالي كافتراضي (نفس سلوك ما قبل هذا التحديث تمامًا).
function parseOccurredAt(value) {
  if (value === undefined || value === null || value === '') return { ok: true, date: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, date: d };
}

router.post('/batches', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const {
    lineId, batchNumber, productName, quantity,
    hasStoppage, stoppageReason, stoppageMinutes, operationalNotes, actionsTaken, workersCount,
    timeFrom, timeTo, preventionMethods, occurredAt, workOrderId,
  } = req.body;
  if (!lineId || !batchNumber || !productName || !quantity) {
    return res.status(400).json({ error: 'الخط ورقم الباتش واسم المنتج والكمية كلها إلزامية' });
  }
  const occurred = parseOccurredAt(occurredAt);
  if (!occurred.ok) return res.status(400).json({ error: 'تاريخ الباتش غير صحيح' });
  const facility = userFacility(req);

  const lineCheck = await pool.query('SELECT name, location FROM production_lines WHERE id = $1 AND deleted_at IS NULL', [lineId]);
  if (lineCheck.rows.length === 0) return res.status(400).json({ error: 'الخط المحدد غير موجود' });
  const lineLocation = lineCheck.rows[0].location;
  if (facility && lineLocation !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية تسجيل باتش على خط تابع لقسم آخر' });
  }

  // ربط الباتش بأمر صيانة فعلي (اختياري): عند تحديده، تُحسَب حقول التوقف
  // الثلاثة تلقائيًا من بيانات ذلك الأمر (راجع computeStoppageFromWorkOrder
  // في services/batchWorkOrderLink.js) — أي قيم توقف يدوية أُرسلت مع نفس
  // الطلب تُتجاهَل عمدًا حتى لا يتضارب مصدرا البيانات (يدوي مقابل تلقائي).
  let linkedWorkOrderId = null;
  let stoppage = {
    hasStoppage: Boolean(hasStoppage),
    stoppageReason: stoppageReason ? String(stoppageReason).trim() : null,
    stoppageMinutes: stoppageMinutes || null,
  };
  if (workOrderId) {
    const workOrder = await fetchWorkOrderForLink(workOrderId);
    if (!workOrder) return res.status(400).json({ error: 'أمر الصيانة المحدد غير موجود' });
    if (facility && workOrder.facility && workOrder.facility !== facility) {
      return res.status(403).json({ error: 'أمر الصيانة هذا تابع لقسم آخر' });
    }
    linkedWorkOrderId = workOrder.id;
    stoppage = computeStoppageFromWorkOrder(workOrder);
  } else {
    // لا رقم أمر صيانة صريح من المستخدم — نحاول ربطًا تلقائيًا بأمر صيانة
    // سبق أن كُتب فيه "رقم الباتش المتوقع" هذا نفسه على نفس الخط (البلاغ الذي
    // رفعه المشرف لحظة حدوث العطل، قبل معرفة أي شيء عن الباتش سوى رقمه
    // المتوقع — راجع findAutoLinkWorkOrder في services/batchWorkOrderLink.js).
    // هذا اكتشاف مساعد صامت: لو لم يوجد تطابق، أو كان أمر الصيانة المطابق
    // تابعًا لمصنع آخر، يُتجاهَل بصمت والباتش يُسجَّل بلا ربط كالمعتاد (بلا أي
    // خطأ يظهر للمستخدم — الربط اليدوي من القائمة يبقى متاحًا كما هو دائمًا).
    const autoMatchId = await findAutoLinkWorkOrder(lineId, batchNumber);
    if (autoMatchId) {
      const workOrder = await fetchWorkOrderForLink(autoMatchId);
      if (workOrder && !(facility && workOrder.facility && workOrder.facility !== facility)) {
        linkedWorkOrderId = workOrder.id;
        stoppage = computeStoppageFromWorkOrder(workOrder);
      }
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO production_batches
       (line_id, batch_number, product_name, quantity, recorded_by, recorded_by_user,
        has_stoppage, stoppage_reason, stoppage_minutes, operational_notes, actions_taken, workers_count,
        time_from, time_to, prevention_methods, occurred_at, work_order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16, now()), $17) RETURNING *`,
    [
      lineId,
      String(batchNumber).trim(),
      String(productName).trim(),
      Number(quantity),
      req.user.name,
      req.user.id,
      stoppage.hasStoppage,
      stoppage.stoppageReason,
      stoppage.stoppageMinutes,
      operationalNotes ? String(operationalNotes).trim() : null,
      actionsTaken ? String(actionsTaken).trim() : null,
      workersCount || null,
      timeFrom ? String(timeFrom).trim() : null,
      timeTo ? String(timeTo).trim() : null,
      preventionMethods ? String(preventionMethods).trim() : null,
      occurred.date,
      linkedWorkOrderId,
    ]
  );
  const batch = { ...rows[0], line_name: lineCheck.rows[0].name, facility: lineLocation };
  fireWebhook('batch_recorded', batch, lineLocation);
  notifyEvent('batch_recorded', batch);
  res.status(201).json({ batch });
});

// الحقول القابلة للتعديل على باتش قديم — نفس حقول التسجيل تقريبًا، بالإضافة
// لإمكانية تصحيح التاريخ نفسه (occurredAt) والخط (lineId).
const BATCH_EDITABLE_FIELDS = [
  ['lineId', 'line_id', (v) => v || null],
  ['batchNumber', 'batch_number', (v) => (v != null ? String(v).trim() : null)],
  ['productName', 'product_name', (v) => (v != null ? String(v).trim() : null)],
  ['quantity', 'quantity', (v) => (v != null ? Number(v) : null)],
  ['hasStoppage', 'has_stoppage', (v) => Boolean(v)],
  ['stoppageReason', 'stoppage_reason', (v) => (v ? String(v).trim() : null)],
  ['stoppageMinutes', 'stoppage_minutes', (v) => v || null],
  ['operationalNotes', 'operational_notes', (v) => (v ? String(v).trim() : null)],
  ['actionsTaken', 'actions_taken', (v) => (v ? String(v).trim() : null)],
  ['workersCount', 'workers_count', (v) => v || null],
  ['timeFrom', 'time_from', (v) => (v ? String(v).trim() : null)],
  ['timeTo', 'time_to', (v) => (v ? String(v).trim() : null)],
  ['preventionMethods', 'prevention_methods', (v) => (v ? String(v).trim() : null)],
];

// PATCH /api/production/batches/:id — تعديل باتش قديم، صلاحية "مسؤول إنتاج"
// فقط (production_manager)، وليس موظف الإنتاج العادي. كل تعديل يُسجَّل في
// production_batch_edits (من عدّل، متى، وما الحقول التي تغيّرت فعليًا فقط).
router.patch('/batches/:id', requireRole('production_manager'), async (req, res) => {
  const facility = userFacility(req);
  const existing = await pool.query(
    `SELECT b.*, l.location FROM production_batches b LEFT JOIN production_lines l ON l.id = b.line_id WHERE b.id = $1`,
    [req.params.id]
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: 'الباتش غير موجود' });
  const before = existing.rows[0];
  if (facility && before.location !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية تعديل باتش تابع لقسم آخر' });
  }

  let occurredDate = undefined; // undefined = لم يُرسَل، لا نعدّله
  if (Object.prototype.hasOwnProperty.call(req.body, 'occurredAt')) {
    const occurred = parseOccurredAt(req.body.occurredAt);
    if (!occurred.ok) return res.status(400).json({ error: 'تاريخ الباتش غير صحيح' });
    occurredDate = occurred.date || new Date();
  }

  // ربط/فك ربط الباتش بأمر صيانة فعلي: وجود المفتاح workOrderId في الطلب
  // (حتى لو null) يعني تعديل الربط صراحة. عند الربط بأمر جديد، تُحسَب حقول
  // التوقف الثلاثة تلقائيًا من بيانات ذلك الأمر (راجع
  // computeStoppageFromWorkOrder) وتتجاهَل أي قيم توقف يدوية أُرسلت بنفس
  // الطلب. عند الفك (workOrderId: null) تبقى قيم التوقف الحالية كما هي —
  // يقدر المستخدم تعديلها يدويًا بعدها في طلب منفصل إن احتاج.
  const linkingWorkOrder = Object.prototype.hasOwnProperty.call(req.body, 'workOrderId');
  let computedStoppage = null;
  if (linkingWorkOrder && req.body.workOrderId) {
    const workOrder = await fetchWorkOrderForLink(req.body.workOrderId);
    if (!workOrder) return res.status(400).json({ error: 'أمر الصيانة المحدد غير موجود' });
    if (facility && workOrder.facility && workOrder.facility !== facility) {
      return res.status(403).json({ error: 'أمر الصيانة هذا تابع لقسم آخر' });
    }
    computedStoppage = computeStoppageFromWorkOrder(workOrder);
  }

  // ربط تلقائي صامت: الباتش غير مربوط أصلًا بأي أمر صيانة (before.work_order_id
  // فارغ)، والطلب لم يذكر workOrderId صراحة (لا ربط ولا فك ربط يدوي مقصود)،
  // ورقم الباتش نفسه ضمن هذا الطلب — نحاول مطابقته بأمر صيانة سبق أن كُتب فيه
  // هذا الرقم كـ"رقم باتش متوقع" على نفس الخط (راجع findAutoLinkWorkOrder في
  // services/batchWorkOrderLink.js). اكتشاف مساعد صامت فقط: بلا تطابق أو عند
  // تعارض المصنع يُتجاهَل بلا أي خطأ، والربط اليدوي من القائمة يبقى متاحًا.
  let autoLinkedWorkOrderId; // undefined = لم يحدث ربط تلقائي في هذا الطلب
  if (!linkingWorkOrder && !before.work_order_id && req.body.batchNumber) {
    const effectiveLineId = Object.prototype.hasOwnProperty.call(req.body, 'lineId') && req.body.lineId
      ? req.body.lineId
      : before.line_id;
    const autoMatchId = await findAutoLinkWorkOrder(effectiveLineId, req.body.batchNumber);
    if (autoMatchId) {
      const workOrder = await fetchWorkOrderForLink(autoMatchId);
      if (workOrder && !(facility && workOrder.facility && workOrder.facility !== facility)) {
        autoLinkedWorkOrderId = workOrder.id;
        computedStoppage = computeStoppageFromWorkOrder(workOrder);
      }
    }
  }

  const setClauses = [];
  const params = [];
  const changes = {};

  if (linkingWorkOrder) {
    const newWorkOrderId = req.body.workOrderId ? Number(req.body.workOrderId) : null;
    // مقارنة نصية (كبقية الحقول أعلاه) لا رقمية مباشرة — بعض عملاء Postgres
    // الخفيفة (راجع lib/pgLite.js) تُعيد أعمدة BIGINT كنص، فمقارنة نوعين
    // مختلفين (نص/رقم) بـ!== كانت ستُسجِّل "تغييرًا" وهميًا في كل مرة رغم أن
    // القيمة نفسها لم تتغيّر فعليًا.
    if (String(before.work_order_id ?? '') !== String(newWorkOrderId ?? '')) {
      changes.workOrderId = { old: before.work_order_id, new: newWorkOrderId };
    }
    params.push(newWorkOrderId);
    setClauses.push(`work_order_id = $${params.length}`);
  } else if (autoLinkedWorkOrderId !== undefined) {
    changes.workOrderId = { old: before.work_order_id, new: autoLinkedWorkOrderId };
    params.push(autoLinkedWorkOrderId);
    setClauses.push(`work_order_id = $${params.length}`);
  }

  for (const [bodyKey, column, normalize] of BATCH_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(req.body, bodyKey)) continue;
    // عند ربط الباتش بأمر صيانة فعلي بنفس الطلب، تُحسَب حقول التوقف تلقائيًا
    // أدناه — أي قيمة يدوية لهذه الحقول الثلاثة ضمن الطلب نفسه تُتجاهَل عمدًا.
    if (computedStoppage && ['hasStoppage', 'stoppageReason', 'stoppageMinutes'].includes(bodyKey)) continue;
    const newValue = normalize(req.body[bodyKey]);
    const oldValue = before[column];
    // مقارنة نصية بسيطة تكفي هنا (لا حقول معقدة/متداخلة بين هذه الأعمدة).
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      changes[bodyKey] = { old: oldValue, new: newValue };
    }
    params.push(newValue);
    setClauses.push(`${column} = $${params.length}`);
  }
  if (occurredDate !== undefined) {
    if (before.occurred_at?.toISOString?.() !== occurredDate.toISOString()) {
      changes.occurredAt = { old: before.occurred_at, new: occurredDate };
    }
    params.push(occurredDate);
    setClauses.push(`occurred_at = $${params.length}`);
  }
  if (computedStoppage) {
    for (const [column, key, value] of [
      ['has_stoppage', 'hasStoppage', computedStoppage.hasStoppage],
      ['stoppage_reason', 'stoppageReason', computedStoppage.stoppageReason],
      ['stoppage_minutes', 'stoppageMinutes', computedStoppage.stoppageMinutes],
    ]) {
      const oldValue = before[column];
      if (String(oldValue ?? '') !== String(value ?? '')) {
        changes[key] = { old: oldValue, new: value };
      }
      params.push(value);
      setClauses.push(`${column} = $${params.length}`);
    }
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'لم تُرسَل أي حقول للتعديل' });
  }

  // لو المستخدم غيّر الخط: تحقق أن الخط الجديد ضمن مصنعه (إن كان مقيَّدًا).
  // (الخط الحالي نفسه لا يُفحَص — تعديل باتش خطه الحالي مؤرشف يجب أن يبقى ممكنًا.)
  if (Object.prototype.hasOwnProperty.call(req.body, 'lineId') && req.body.lineId
      && String(req.body.lineId) !== String(before.line_id ?? '')) {
    const lineCheck = await pool.query('SELECT location FROM production_lines WHERE id = $1 AND deleted_at IS NULL', [req.body.lineId]);
    if (lineCheck.rows.length === 0) return res.status(400).json({ error: 'الخط المحدد غير موجود' });
    if (facility && lineCheck.rows[0].location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية نقل الباتش لخط تابع لقسم آخر' });
    }
  }

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE production_batches SET ${setClauses.join(', ')} WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  if (Object.keys(changes).length > 0) {
    await pool.query(
      `INSERT INTO production_batch_edits (batch_id, edited_by_user, edited_by_name, changes)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, req.user.id, req.user.name, JSON.stringify(changes)]
    );
  }

  const enriched = await pool.query(
    `SELECT b.*, l.name AS line_name, l.location AS facility
     FROM production_batches b LEFT JOIN production_lines l ON l.id = b.line_id WHERE b.id = $1`,
    [req.params.id]
  );
  if (Object.keys(changes).length > 0) {
    notifyEvent('batch_edited', { ...enriched.rows[0], edited_by_name: req.user.name });
  }
  res.json({ batch: enriched.rows[0] });
});

// GET /api/production/batches/:id/edits — سجل تعديلات باتش معيّن (الأحدث أولًا).
// ملاحظة: lib/pgLite.js (عميل Postgres الخفيف بلا تبعيات في هذا المشروع) لا
// يحوّل أعمدة JSONB تلقائيًا لكائن — تصل كنص خام، لذا نُفكّكها هنا صراحةً
// حتى يستلم التطبيق كائن JSON حقيقي كما يتوقع (راجع BatchEdit.fromApi).
router.get('/batches/:id/edits', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, edited_by_user, edited_by_name, edited_at, changes
     FROM production_batch_edits WHERE batch_id = $1 ORDER BY edited_at DESC`,
    [req.params.id]
  );
  const edits = rows.map((r) => ({
    ...r,
    changes: typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes,
  }));
  res.json({ edits });
});

// حذف باتش (لتصحيح إدخال خاطئ) — صلاحية "مسؤول إنتاج" فقط (وليس أي موظف
// إنتاج عادي، خلافًا للسلوك السابق قبل هذا التحديث).
router.delete('/batches/:id', requireRole('production_manager'), async (req, res) => {
  const facility = userFacility(req);
  if (facility) {
    const check = await pool.query(
      'SELECT l.location FROM production_batches b LEFT JOIN production_lines l ON l.id = b.line_id WHERE b.id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0 || check.rows[0].location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية حذف باتش تابع لقسم آخر' });
    }
  }
  const { rows } = await pool.query('DELETE FROM production_batches WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'الباتش غير موجود' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// تقرير إنتاج بمدة مخصّصة — يُنشئ ملف HTML لباتشات وبلاغات مصنع واحد خلال
// مدة زمنية يحددها المستخدم، يحفظه كرابط ثابت، ثم يرسل ويبهوك يتضمن الرابط
// ورقم واتساب طالب التقرير نفسه (requested_by_phone) حتى ترسله أتمتة واتساب
// (n8n) له شخصيًا فقط، لا لجروب المصنع — راجع services/productionReport.js.
// ---------------------------------------------------------------------------
router.post('/reports/request', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'تاريخ البداية والنهاية إلزاميان' });
  const facility = userFacility(req) || req.body.facility;
  if (!facility) return res.status(400).json({ error: 'حدد المصنع' });

  try {
    const report = await generateProductionReport({ facility, from, to });

    // نُبقي الويبهوك العام (fireWebhook) لأي تكامل خارجي يُضاف لاحقًا (n8n
    // أو غيره)، لكن الإرسال الفعلي الحالي مباشر عبر TextMeBot (راجع
    // services/textmebot.js) — أبسط وأسرع لعدم توفر "ويبهوك استقبال" جاهز
    // لدى العميل حاليًا.
    fireWebhook(
      'production_report_custom',
      {
        facility,
        from,
        to,
        report_url: report.absoluteUrl,
        requested_by_phone: req.user.phone || null,
        requested_by_name: req.user.name,
        total_quantity: report.totalQuantity,
        batch_count: report.batchCount,
      },
      facility
    );

    if (!req.user.phone) {
      return res.status(201).json({
        reportUrl: report.absoluteUrl,
        whatsappSent: false,
        warning: 'رقم جوالك غير مسجَّل في حسابك — لن يصلك التقرير على واتساب تلقائيًا، افتح الرابط مباشرة',
      });
    }

    const message =
      `تقرير إنتاج ${facility}\n` +
      `المدة: ${new Date(from).toLocaleDateString('ar-EG')} إلى ${new Date(to).toLocaleDateString('ar-EG')}\n` +
      `إجمالي الكمية: ${report.totalQuantity} — عدد الباتشات: ${report.batchCount}\n` +
      `رابط التقرير: ${report.absoluteUrl}`;
    // فشل إرسال واتساب هنا (مفتاح TextMeBot غير مضبوط، خطأ شبكة...) يصل
    // للمستخدم فورًا عبر warning في استجابة الطلب نفسها أدناه — لا حاجة
    // لحدث notifyEvent إضافي هنا (كان موجودًا سابقًا بلا أي معالجة فعلية له
    // في services/notifications.js، فلم يكن يفعل شيئًا أصلًا).
    const sendResult = await sendWhatsappText(req.user.phone, message);

    res.status(201).json({
      reportUrl: report.absoluteUrl,
      whatsappSent: sendResult.ok,
      warning: sendResult.ok
        ? null
        : 'تعذّر إرسال رسالة واتساب تلقائيًا (تحقق من مفتاح TextMeBot في إعدادات الموقع) — يمكنك فتح رابط التقرير أدناه يدويًا',
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('تعذّر إنشاء تقرير الإنتاج المخصّص:', err);
    res.status(500).json({ error: 'تعذّر إنشاء التقرير، حاول مرة أخرى' });
  }
});

// حذف بلاغ عطل (لتصحيح إدخال خاطئ مثلًا) — أوامر العمل المرتبطة به لا تُحذف،
// فقط يُفصَل ربطها (incident_report_id تصير NULL).
router.delete('/incidents/:id', requireRole(...PRODUCTION_ROLES), async (req, res) => {
  const facility = userFacility(req);
  if (facility) {
    const check = await pool.query(
      'SELECT l.location FROM incident_reports i LEFT JOIN production_lines l ON l.id = i.line_id WHERE i.id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0 || check.rows[0].location !== facility) {
      return res.status(403).json({ error: 'لا تملك صلاحية حذف بلاغ تابع لقسم آخر' });
    }
  }
  const { rows } = await pool.query('DELETE FROM incident_reports WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'البلاغ غير موجود' });
  res.status(204).end();
});

module.exports = router;