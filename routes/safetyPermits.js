const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');
const { generateSafetyReport } = require('../services/safetyReport');
const { sendWhatsappText } = require('../services/textmebot');
const { withLock } = require('../lib/keyedLock');
const { ensureSchema: ensureRasedSchema } = require('../services/rased');

const router = new Router();
router.use(requireAuth, requireApproved);

// التصريح مع بيانات المهمة (أمر العمل) المرتبطة به إن وُجدت — حتى يعرف مسؤول
// السلامة عند المراجعة ما هي المهمة بالضبط (وصفها، موقعها، معدتها، حالتها،
// فنيوها) فيحدّد الاحتياطات المطلوبة بدل رؤية عبارة "مرتبط ببلاغ صيانة قائم"
// فقط. كل الأعمدة الإضافية بادئتها wo_ فلا تتعارض مع أعمدة safety_permits.
// نفس صياغة LIST_QUERY في routes/workOrders.js لاسم المعدة والخط والفنيين.
const PERMIT_WITH_TASK_SELECT = `
  SELECT sp.*,
    wo.kind AS wo_kind, wo.description AS wo_description, wo.status AS wo_status,
    COALESCE(wo.equipment_name, e.name) AS wo_equipment_name, wo.equipment_code AS wo_equipment_code,
    wo.facility AS wo_facility, l.name AS wo_line_name,
    wo.created_by AS wo_created_by, wo.created_at AS wo_created_at,
    (SELECT string_agg(t2.name, '، ' ORDER BY t2.name)
       FROM work_order_technicians wot
       JOIN technicians t2 ON t2.id = wot.technician_id
      WHERE wot.work_order_id = wo.id) AS wo_technician_names
  FROM safety_permits sp
  LEFT JOIN work_orders wo ON wo.id = sp.related_work_order_id
  LEFT JOIN equipment e ON e.id = wo.equipment_id
  LEFT JOIN production_lines l ON l.id = wo.line_id
`;

// يجلب تصريحًا واحدًا بنفس الشكل أعلاه (بعد الإنشاء أو المراجعة) — يُستخدم لرد
// الطلب وللويبهوك وإشعار واتساب، فيحمل التطبيق بيانات المهمة نفسها دائمًا.
async function loadPermitWithTask(id) {
  const { rows } = await pool.query(`${PERMIT_WITH_TASK_SELECT} WHERE sp.id = $1`, [id]);
  return rows[0] || null;
}

// أنواع الأعمال الخطرة القابلة للاختيار في استمارة طلب التصريح (اختيار متعدد)
// — مطابقة لقائمة الفحص في استمارة "تصريح عمل مصنع الماس الوطنية".
const OPERATION_TYPES = ['hot_work', 'confined_space', 'height', 'electrical', 'excavation', 'lifting', 'other'];

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'safety-permits');

// يحفظ صورة المعدات المُرسَلة كـ base64 (data URL) على القرص ضمن public/
// ويعيد المسار النسبي لتخزينه في قاعدة البيانات — بديل بسيط عن رفع ملفات
// multipart (غير موجود أصلًا في هذا الخادم الخفيف بدون حزم خارجية).
function saveEquipmentPhoto(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('حجم صورة المعدات كبير جدًا (الحد الأقصى ٨ ميجابايت)'), { statusCode: 400 });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return `/uploads/safety-permits/${filename}`;
}

// يُعيد القسم الذي يُقيَّد به مسؤول السلامة الحالي (أو null إن كان يرى كل
// الأقسام بلا تقييد) — مدير النظام (admin) لا يتقيّد بهذا أبدًا. راجع عمود
// safety_facility في جدول users (schema.sql) ولوحة الإدارة لتخصيصه. نفس
// نمط userFacility في routes/production.js تمامًا، بعمود مستقل خاص بالسلامة.
function userSafetyFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.safety_facility || null;
}

// حقل location قد يكون قيمة القسم وحدها ("مصنع الرجال") أو مع تفاصيل إضافية
// ("مصنع الرجال — خط ٩")، بالضبط بصيغة "$facility — $detail" التي يبنيها
// تطبيق الجوال (راجع safety_permit_request_screen.dart). لذا يُطابَق المصنع
// بالمساواة التامة أو بالبداية بنفس النص متبوعًا بـ" — ".
function permitBelongsToFacility(location, facility) {
  if (!location) return false;
  return location === facility || location.startsWith(`${facility} — `);
}

// GET /api/safety-permits — مسؤول سلامة مقيَّد بقسم واحد يرى فقط تصاريح ذلك
// القسم (بما فيها التي لم تُصنَّف "مصنع الرجال" ولا "مصنع النساء" لا تظهر له
// إطلاقًا؛ راجع نقاش التقسيم — تصاريح "المستودع العام" تبقى ظاهرة فقط
// لمسؤول سلامة غير مقيَّد أو لمدير النظام).
router.get('/', async (req, res) => {
  const facility = userSafetyFacility(req);
  const { rows } = facility
    ? await pool.query(
        `${PERMIT_WITH_TASK_SELECT} WHERE sp.location = $1 OR sp.location LIKE $1 || ' — %' ORDER BY sp.requested_at DESC`,
        [facility]
      )
    : await pool.query(`${PERMIT_WITH_TASK_SELECT} ORDER BY sp.requested_at DESC`);
  res.json({ permits: rows });
});

// POST /api/safety-permits — طلب تصريح عمل (يقدّمه الفني أو المقاول، ويبقى
// "بانتظار الاعتماد" حتى يراجعه قسم السلامة المهنية).
router.post('/', async (req, res) => {
  const {
    officeName, location, description, startAt, endAt, workersCount,
    responsiblePhone, operationTypes, equipmentUsed, equipmentPhoto, relatedWorkOrderId,
  } = req.body;

  if (!location || !description) {
    return res.status(400).json({ error: 'الموقع ووصف العمل إلزاميان' });
  }
  const types = Array.isArray(operationTypes) ? operationTypes.filter((t) => OPERATION_TYPES.includes(t)) : [];
  if (types.length === 0) {
    return res.status(400).json({ error: 'اختر نوع عمل واحدًا على الأقل' });
  }
  if (!equipmentPhoto) {
    return res.status(400).json({ error: 'صورة المعدات/الأدوات المستخدمة إلزامية' });
  }

  // حماية من تكرار الإرسال: لو ضغط المستخدم "إرسال" مرتين (أو أعاد التطبيق
  // الطلب بسبب بطء الشبكة) يصل لنا الطلب نفسه أكثر من مرة خلال ثوانٍ. نُجري
  // الفحص والإدخال داخل قفل لكل مستخدم حتى لا يمرّ طلبان معًا، وإن وُجد تصريح
  // مطابق (نفس الطالب والموقع والوصف) خلال آخر دقيقتين نُعيده كما هو بدون
  // إنشاء تصريح جديد ولا إشعارات جديدة.
  const locationText = location.trim();
  const descriptionText = description.trim();
  const outcome = await withLock(`permit-create:${req.user.id}`, async () => {
    const dup = await pool.query(
      `SELECT id FROM safety_permits
        WHERE requested_by_user = $1 AND location = $2 AND description = $3
          AND requested_at > now() - interval '2 minutes'
        ORDER BY id DESC LIMIT 1`,
      [req.user.id, locationText, descriptionText]
    );
    if (dup.rows.length > 0) return { duplicateOf: dup.rows[0].id };

    let photoPath;
    try {
      photoPath = saveEquipmentPhoto(equipmentPhoto);
    } catch (err) {
      return { error: { status: err.statusCode || 400, message: err.message } };
    }
    if (!photoPath) return { error: { status: 400, message: 'صيغة صورة المعدات غير صحيحة' } };

    const { rows } = await pool.query(
      `INSERT INTO safety_permits
         (office_name, location, description, requested_by, requested_by_user, start_at, end_at,
          workers_count, responsible_phone, operation_types, equipment_used, equipment_photo, related_work_order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        officeName ? String(officeName).trim() : null,
        locationText,
        descriptionText,
        req.user.name,
        req.user.id,
        startAt || null,
        endAt || null,
        workersCount || 1,
        responsiblePhone ? String(responsiblePhone).trim() : null,
        types,
        equipmentUsed ? String(equipmentUsed).trim() : null,
        photoPath,
        relatedWorkOrderId || null,
      ]
    );
    if (relatedWorkOrderId) {
      await pool.query("UPDATE work_orders SET status = 'waiting_loto' WHERE id = $1 AND requires_loto = true", [relatedWorkOrderId]);
    }
    return { createdId: rows[0].id, createdRow: rows[0] };
  });

  if (outcome.error) return res.status(outcome.error.status).json({ error: outcome.error.message });

  if (outcome.duplicateOf) {
    const existing = await loadPermitWithTask(outcome.duplicateOf);
    return res.status(201).json({ permit: existing, duplicate: true });
  }

  // يُحمَّل بعد تحديث حالة أمر العمل أعلاه حتى تعكس wo_status آخر حالة فعلية.
  const permit = (await loadPermitWithTask(outcome.createdId)) || outcome.createdRow;
  fireWebhook('safety_permit_requested', permit);
  notifyEvent('safety_permit_requested', permit);
  res.status(201).json({ permit });
});

// يتحقق أن مسؤول السلامة الحالي (لو كان مقيَّدًا بقسم واحد) يملك صلاحية
// الوصول لتصريح معيّن قبل مراجعته أو حذفه — يُستخدم في PATCH /:id/review
// وDELETE /:id أدناه. يُعيد التصريح إن كان الوصول مسموحًا، أو يرسل الاستجابة
// المناسبة (404/403) ويُعيد null إن لم يكن.
async function assertPermitAccess(req, res) {
  const { rows } = await pool.query('SELECT id, location FROM safety_permits WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'التصريح غير موجود' });
    return null;
  }
  const facility = userSafetyFacility(req);
  if (facility && !permitBelongsToFacility(rows[0].location, facility)) {
    res.status(403).json({ error: 'لا تملك صلاحية الوصول لتصاريح قسم آخر' });
    return null;
  }
  return rows[0];
}

// PATCH /api/safety-permits/:id/review — اعتماد أو رفض (قسم السلامة فقط) —
// يطابق استمارة "إجراءات ومتطلبات السلامة لتصريح العمل": عند القبول يُعبَّأ
// قسم القبول (مخاطر الموقع، المخاطر المحتملة، معدات الحماية، الإجراءات
// الاحترازية)، وعند الرفض يُذكر سبب الرفض فقط. مسؤول سلامة مقيَّد بقسم واحد
// لا يقدر يراجع تصريحًا تابعًا لقسم آخر (403).
router.patch('/:id/review', requireRole('safety'), async (req, res) => {
  if (!(await assertPermitAccess(req, res))) return;
  const { approve, siteHazards, potentialRisks, ppeRequired, precautions, rejectionReason } = req.body;

  // ربط راصد: التصريح المسجَّل في نظام راصد يُراجَع هناك فقط، وتصل النتيجة هنا
  // تلقائيًا (services/rased.js) — حتى لا يعتمد شخص في التطبيق ويرفض آخر في راصد.
  // مدير النظام وحده يقدر يتجاوز ذلك صراحةً بإرسال overrideRased: true.
  try {
    await ensureRasedSchema();
    const { rows: rasedRows } = await pool.query('SELECT rased_ref_no FROM safety_permits WHERE id = $1', [req.params.id]);
    if (rasedRows[0] && rasedRows[0].rased_ref_no && !(req.user.role === 'admin' && req.body.overrideRased === true)) {
      return res.status(409).json({
        error: `هذا التصريح مسجَّل في نظام راصد برقم ${rasedRows[0].rased_ref_no} — يعتمده قسم السلامة هناك وتصل النتيجة هنا تلقائيًا`,
      });
    }
  } catch (err) {
    console.error('[rased] تعذّر فحص حالة الربط قبل المراجعة:', err.message);
  }

  if (!approve && !rejectionReason) {
    return res.status(400).json({ error: 'سبب الرفض إلزامي عند الرفض' });
  }

  // التحديث ذرّي: لا يُغيَّر إلا تصريح ما زال "بانتظار الاعتماد". هكذا لو وصل
  // الطلب نفسه مرتين (ضغطتان سريعتان، أو إعادة إرسال من التطبيق، أو مسؤولان
  // يضغطان معًا) يُنفَّذ الأول فقط ويصدر عنه إشعار واحد، والثاني لا يغيّر شيئًا.
  let rows;
  if (approve) {
    ({ rows } = await pool.query(
      `UPDATE safety_permits SET
         status = 'approved', reviewed_by = $1, reviewed_at = now(),
         site_hazards = $2, potential_risks = $3, ppe_required = $4, precautions = $5,
         rejection_reason = NULL
       WHERE id = $6 AND status = 'pending' RETURNING *`,
      [
        req.user.name,
        Array.isArray(siteHazards) ? siteHazards : [],
        Array.isArray(potentialRisks) ? potentialRisks : [],
        Array.isArray(ppeRequired) ? ppeRequired : [],
        precautions ? String(precautions).trim() : null,
        req.params.id,
      ]
    ));
  } else {
    ({ rows } = await pool.query(
      `UPDATE safety_permits SET
         status = 'rejected', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user.name, String(rejectionReason).trim(), req.params.id]
    ));
  }

  if (rows.length === 0) {
    // لم يُحدَّث شيء: إما التصريح محذوف، أو سبقته مراجعة أخرى.
    const current = await loadPermitWithTask(req.params.id);
    if (!current) return res.status(404).json({ error: 'التصريح غير موجود' });
    const sameDecision = (approve && current.status === 'approved') || (!approve && current.status === 'rejected');
    if (sameDecision) {
      // الطلب نفسه وصل مرة ثانية — نعيد النتيجة الحالية بنجاح بدون إشعارات مكررة.
      return res.json({ permit: current, alreadyReviewed: true });
    }
    const was = current.status === 'approved' ? 'اعتماده' : 'رفضه';
    return res.status(409).json({
      error: `تمت مراجعة هذا التصريح مسبقًا (تم ${was} بواسطة ${current.reviewed_by || 'مسؤول السلامة'}) — حدّث الصفحة`,
      permit: current,
    });
  }

  const permit = (await loadPermitWithTask(rows[0].id)) || rows[0];
  fireWebhook('safety_permit_reviewed', permit);
  notifyEvent('safety_permit_reviewed', permit);
  res.json({ permit });
});

// DELETE /api/safety-permits/:id — حذف طلب تصريح (قسم السلامة أو مدير النظام
// فقط) — يُستخدم عادة لحذف طلب أُنشئ بالخطأ أو أصبح غير ذي صلة. requireRole
// يسمح لمدير النظام دائمًا بالمرور بغض النظر عن الدور المذكور (راجع
// middleware/auth.js). مسؤول سلامة مقيَّد بقسم واحد لا يقدر يحذف تصريحًا
// تابعًا لقسم آخر (403).
router.delete('/:id', requireRole('safety'), async (req, res) => {
  if (!(await assertPermitAccess(req, res))) return;
  const { rows } = await pool.query('DELETE FROM safety_permits WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'التصريح غير موجود' });
  res.status(204).end();
});

// POST /api/safety-permits/reports/request — تقرير سلامة احترافي بمدة
// مخصّصة، يُرسَل رابطه مباشرة عبر واتساب لرقم طالب التقرير نفسه فقط (وليس
// لجروب) — بنفس نمط POST /api/work-orders/reports/request تمامًا (راجع
// routes/workOrders.js وservices/safetyReport.js). مقيَّد بقسم السلامة (أو
// مدير النظام)، ومُصفّى تلقائيًا بنفس قسم مسؤول السلامة المقيَّد به إن وُجد
// (userSafetyFacility) — تمامًا كتقييد GET / أعلاه.
router.post('/reports/request', requireRole('safety'), async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'تاريخ البداية والنهاية إلزاميان' });

  try {
    const facility = userSafetyFacility(req);
    const report = await generateSafetyReport({ from, to, facility });

    fireWebhook('safety_report_custom', {
      from,
      to,
      facility,
      report_url: report.absoluteUrl,
      requested_by_phone: req.user.phone || null,
      requested_by_name: req.user.name,
      total_count: report.totalCount,
    });

    if (!req.user.phone) {
      return res.status(201).json({
        reportUrl: report.absoluteUrl,
        whatsappSent: false,
        warning: 'رقم جوالك غير مسجَّل في حسابك — لن يصلك التقرير على واتساب تلقائيًا، افتح الرابط مباشرة',
      });
    }

    const message =
      `تقرير سلامة — بمدة مخصّصة\n` +
      `المدة: ${new Date(from).toLocaleDateString('ar-EG')} إلى ${new Date(to).toLocaleDateString('ar-EG')}\n` +
      `إجمالي طلبات التصاريح: ${report.totalCount} — مقبولة: ${report.approvedCount} — مرفوضة: ${report.rejectedCount}\n` +
      `رابط التقرير: ${report.absoluteUrl}`;
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
    console.error('تعذّر إنشاء تقرير السلامة المخصّص:', err);
    res.status(500).json({ error: 'تعذّر إنشاء التقرير، حاول مرة أخرى' });
  }
});

module.exports = router;
// يُستخدم من services/rased.js لإرسال إشعار المراجعة بنفس شكل التصريح (مع بيانات المهمة).
module.exports.loadPermitWithTask = loadPermitWithTask;
