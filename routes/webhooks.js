const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { renderTemplate } = require('../services/webhooks');
const { FACILITIES } = require('../services/facilities');

const router = new Router();
router.use(requireAuth, requireApproved, requireRole('admin'));

const EVENT_TYPES = [
  'incident_created', 'work_order_created', 'work_order_assigned', 'work_order_completed',
  'safety_permit_requested', 'safety_permit_reviewed', 'near_miss_reported',
  'batch_recorded', 'production_report_custom', 'production_report_weekly',
  'production_report_monthly', 'maintenance_report_custom', 'maintenance_report_monthly',
  'maintenance_report_yearly',
  // كانتا مفقودتين رغم أن routes/injuryReports.js يستدعي fireWebhook لهما
  // فعليًا منذ إضافة تقارير إصابات العمل — بدون وجودهما هنا، POST /api/
  // webhooks كان يرفض أي محاولة لإنشاء ويبهوك بهذا النوع (لا eventType صحيح
  // غيرهما)، فيستحيل عمليًا ضبط تكامل خارجي (n8n مثلًا) لأي منهما مهما فعل
  // المدير من لوحة التحكم.
  'injury_report_created', 'injury_report_closed',
  // تقارير السلامة الأسبوعية/الشهرية التلقائية + المخصّصة (راجع
  // services/safetyReportScheduler.js وPOST /api/safety-permits/reports/request)
  // — بنفس نمط تقارير الصيانة/الإنتاج تمامًا.
  'safety_report_weekly', 'safety_report_monthly', 'safety_report_custom',
  // قسم "المخزون والقطع" الجديد بالصيانة — دورة حياة طلب القطعة الكاملة
  // (راجع routes/inventory.js وschema.sql: جدول part_requests).
  'part_request_created', 'part_request_designed', 'part_request_issued', 'part_request_returned',
  // إدارة أوامر العمل بعد الإنشاء (تعديل/حذف/تغيير الفنيين) — قرار صريح
  // 2026-09-26، راجع routes/workOrders.js: PATCH /:id، DELETE /:id،
  // DELETE /:id/technicians/:techId.
  'work_order_updated', 'work_order_deleted', 'work_order_technician_removed',
];

// GET /api/webhooks
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM webhooks ORDER BY created_at DESC');
  res.json({ webhooks: rows, availableEvents: EVENT_TYPES, availableFacilities: FACILITIES });
});

// POST /api/webhooks — مثال: رابط استقبال واتساب (n8n / Zapier / أي خدمة تدعم Webhook)
// facility اختياري: لو حُدِّد، لن يُرسَل هذا الويبهوك إلا للأحداث التابعة لنفس
// المصنع (حاليًا: بلاغات الإنتاج فقط)؛ اتركه فارغًا ليستقبل كل أحداث نوعه.
router.post('/', async (req, res) => {
  const { name, url, eventType, facility, messageTemplate } = req.body;
  if (!name || !url || !EVENT_TYPES.includes(eventType)) {
    return res.status(400).json({ error: 'الاسم والرابط ونوع الحدث الصحيح كلها إلزامية' });
  }
  if (facility && !FACILITIES.includes(facility)) {
    return res.status(400).json({ error: 'قسم إنتاج غير صحيح' });
  }
  const { rows } = await pool.query(
    'INSERT INTO webhooks (name, url, event_type, facility, message_template) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name.trim(), url.trim(), eventType, facility || null, messageTemplate || null]
  );
  res.status(201).json({ webhook: rows[0] });
});

// PATCH /api/webhooks/:id — تعديل أو تفعيل/تعطيل. ملاحظة: facility و
// messageTemplate يُضبَطان دائمًا مباشرة (وليس عبر COALESCE) حتى يمكن للمدير
// إزالتهما فعليًا بإرسال null، بدل تجاهل القيمة الفارغة.
router.patch('/:id', async (req, res) => {
  const { name, url, eventType, enabled, facility, messageTemplate } = req.body;
  if (facility !== undefined && facility !== null && !FACILITIES.includes(facility)) {
    return res.status(400).json({ error: 'قسم إنتاج غير صحيح' });
  }
  const { rows } = await pool.query(
    `UPDATE webhooks SET
       name = COALESCE($1, name), url = COALESCE($2, url),
       event_type = COALESCE($3, event_type), enabled = COALESCE($4, enabled),
       facility = CASE WHEN $6 THEN $5 ELSE facility END,
       message_template = CASE WHEN $8 THEN $7 ELSE message_template END
     WHERE id = $9 RETURNING *`,
    [
      name, url, eventType, enabled,
      facility || null, facility !== undefined,
      messageTemplate || null, messageTemplate !== undefined,
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الويبهوك غير موجود' });
  res.json({ webhook: rows[0] });
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// POST /api/webhooks/:id/test — إرسال حمولة تجريبية للتأكد أن الرابط يستقبل صحيح
router.post('/:id/test', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM webhooks WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'الويبهوك غير موجود' });
  try {
    const testPayload = { message: 'رسالة اختبار من نظام صيانتي' };
    const response = await fetch(rows[0].url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'test',
        data: testPayload,
        renderedText: renderTemplate(rows[0].message_template, testPayload),
        sentAt: new Date().toISOString(),
      }),
    });
    res.json({ ok: true, statusCode: response.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
