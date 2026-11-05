'use strict';
// ============================================================================
// إجازات الموظفين — طلب 2026-10-25
//
// قسم لإدارة الإجازات السنوية وحساب الأرصدة تلقائيًا (استحقاق ٢١ يومًا/سنة يتراكم يوميًا من
// تاريخ المباشرة، صلاحية سنتين، خصم الأقدم أولًا، مدفوع/بدون راتب). المدخلات تواريخ فقط:
// بدء الإجازة + العودة المتوقعة، ثم «تسجيل المباشرة» عند العودة. كل شيء آخر يُحسب (lib/leaveCalc.js).
//
// الموظفون هم نفسهم قائمة العمل الإضافي (الجدول المشترك overtime_employees) بأعمدة إضافية
// (القسم + تاريخ التعيين + تاريخ المباشرة). القسم خاص بمصنع الرجال: الصلاحيات نفس أدوار العمل
// الإضافي (مدير النظام + مسؤول الصيانة + مسؤول الإنتاج + مسؤول السلامة)، لكن مسؤول الإنتاج/السلامة
// المقيَّد بمصنع غير مصنع الرجال لا يدخل (نفس أسلوب requireFacility في routes/mamoulMonitor.js
// لمصنع النساء). تعديل الإعدادات لمدير النظام فقط.
// الجداول تُنشأ تلقائيًا عند أول استخدام.
// ============================================================================

const { Router } = require('../lib/http/router');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { ensureLeaveTables } = require('../services/leaveSchema');
const svc = require('../services/leaveService');
const { runLeaveAlerts } = require('../services/leaveAlerts');
const reports = require('../services/leaveReportService');

const router = new Router();

// مطابقة لـ OVERTIME_ROLES في routes/overtime.js (مدير النظام يمرّ دائمًا داخل requireRole).
const LEAVE_ROLES = ['maintenance_manager', 'production_manager', 'safety'];

const MEN_FACILITY = svc.MEN_FACILITY;
function requireMenFactory(req, res, next) {
  const u = req.user;
  if (u.role === 'production_manager' && u.production_facility && u.production_facility !== MEN_FACILITY) {
    return res.status(403).json({ error: 'هذا القسم خاص بمصنع الرجال' });
  }
  if (u.role === 'safety' && u.safety_facility && u.safety_facility !== MEN_FACILITY) {
    return res.status(403).json({ error: 'هذا القسم خاص بمصنع الرجال' });
  }
  return next();
}

router.use(requireAuth, requireApproved, requireRole(...LEAVE_ROLES), requireMenFactory, async (req, res, next) => {
  try {
    await ensureLeaveTables();
  } catch (err) {
    console.error('تعذّر تجهيز جداول إجازات الموظفين:', err.message);
    return res.status(500).json({ error: 'تعذّر تجهيز قاعدة بيانات الإجازات، حاول مرة أخرى' });
  }
  next();
});

// يحوّل الأخطاء المتوقعة (HttpError) إلى رد JSON بحالتها، ويترك غير المتوقعة للراوتر (500).
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e && e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
};

const idParam = (req, res) => {
  const id = svc.parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: 'معرّف غير صحيح' });
    return null;
  }
  return id;
};

async function employeeReply(id, res, status = 200) {
  const data = await svc.getEmployeeView(id);
  if (!data) return res.status(404).json({ error: 'الموظف غير موجود' });
  return res.status(status).json({ employee: data.view, today: data.today });
}

// ---------------------------------------------------------------------------
// الملخص والإعدادات
// ---------------------------------------------------------------------------

router.get('/summary', wrap(async (req, res) => {
  res.json(await svc.buildSummary());
}));

router.get('/settings', wrap(async (req, res) => {
  res.json({ settings: svc.settingsForClient(await svc.getSettings()) });
}));

router.put('/settings', wrap(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'تعديل إعدادات الإجازات لمدير النظام فقط' });
  const patch = svc.validateSettingsPatch(req.body || {});
  const saved = await svc.saveSettings(patch);
  res.json({ settings: svc.settingsForClient(saved) });
}));

// ---------------------------------------------------------------------------
// الموظفون
// ---------------------------------------------------------------------------

// GET /api/leaves/employees — كل الموظفين مع الرصيد والحالة والتنبيهات (البحث والفلترة في التطبيق)
router.get('/employees', wrap(async (req, res) => {
  const { today, settings, views } = await svc.listEmployees();
  res.json({ today, settings: svc.settingsForClient(settings), employees: views });
}));

// POST /api/leaves/employees — { employeeNumber, name, department?, hireDate?, startDate? }
router.post('/employees', wrap(async (req, res) => {
  const id = await svc.createEmployee(req.body || {}, req.user.name);
  return employeeReply(id, res, 201);
}));

router.get('/employees/:id', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  return employeeReply(id, res);
}));

// PATCH /api/leaves/employees/:id — أي من: name, employeeNumber, department, hireDate, startDate
router.patch('/employees/:id', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  await svc.updateEmployee(id, req.body || {});
  return employeeReply(id, res);
}));

// ---------------------------------------------------------------------------
// الإجازات
// ---------------------------------------------------------------------------

// POST /api/leaves/preview — { employeeId, start, expected, actual?, excludeLeaveId? }
// معاينة قبل الحفظ: الرصيد المتاح عند البدء + المدفوع + بدون راتب (تتحقق من التداخل أيضًا).
router.post('/preview', wrap(async (req, res) => {
  const b = req.body || {};
  const employeeId = svc.parseId(b.employeeId);
  if (!employeeId) return res.status(400).json({ error: 'اختر الموظف' });
  const exclude = b.excludeLeaveId === undefined || b.excludeLeaveId === null ? null : svc.parseId(b.excludeLeaveId);
  const preview = await svc.previewLeave(
    employeeId,
    { start: b.start, expected: b.expected, actual: b.actual },
    new Date(),
    { excludeLeaveId: exclude }
  );
  res.json({ preview });
}));

// POST /api/leaves/employees/:id/leaves — { start, expected, note?, replacement?, actual? }
router.post('/employees/:id/leaves', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  const b = req.body || {};
  await svc.createLeave(id, { start: b.start, expected: b.expected, actual: b.actual, note: b.note, replacement: b.replacement }, req.user.name);
  return employeeReply(id, res, 201);
}));

// PATCH /api/leaves/leaves/:id — { start?, expected?, actual?, note?, replacement? }
router.patch('/leaves/:id', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  const b = req.body || {};
  const input = {};
  for (const k of ['start', 'expected', 'actual', 'note', 'replacement']) if (b[k] !== undefined) input[k] = b[k];
  if (Object.keys(input).length === 0) return res.status(400).json({ error: 'لا يوجد ما يُعدَّل' });
  const employeeId = await svc.updateLeave(id, input);
  return employeeReply(employeeId, res);
}));

// POST /api/leaves/leaves/:id/return — { actualDate } «تسجيل المباشرة» بعد الإجازة
router.post('/leaves/:id/return', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  const b = req.body || {};
  if (!b.actualDate) return res.status(400).json({ error: 'أدخل تاريخ المباشرة' });
  const employeeId = await svc.registerReturn(id, b.actualDate);
  return employeeReply(employeeId, res);
}));

// DELETE /api/leaves/leaves/:id — حذف إجازة مسجَّلة بالخطأ (الأرصدة تُعاد حسابها تلقائيًا)
router.delete('/leaves/:id', wrap(async (req, res) => {
  const id = idParam(req, res);
  if (!id) return null;
  const employeeId = await svc.deleteLeave(id);
  return employeeReply(employeeId, res);
}));

// ---------------------------------------------------------------------------
// التقارير (شامل أو كشف شخص) — نفس أعمدة ملف الإكسل
// ---------------------------------------------------------------------------

// GET /api/leaves/report?employeeId=&status= — HTML جاهز للطباعة/PDF + بيانات وصفية.
// بلا employeeId = تقرير شامل (status فلتر اختياري: active|on_leave|upcoming|late).
router.get('/report', wrap(async (req, res) => {
  const options = reports.readOptions(req.query);
  res.json(await reports.buildHtmlReport(options));
}));

// GET /api/leaves/export.xlsx?employeeId=&status=[&token=] — ملف Excel حقيقي (يُفتح عبر رابط مباشر بالرمز).
router.get('/export.xlsx', wrap(async (req, res) => {
  const options = reports.readOptions(req.query);
  const { buffer, filename } = await reports.buildExcel(options);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}));

// ---------------------------------------------------------------------------
// تنبيهات (تشغيل يدوي لمدير النظام: dryRun يعرض المرشّحين بلا إرسال)
// ---------------------------------------------------------------------------

router.post('/alerts/run', wrap(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'لمدير النظام فقط' });
  const b = req.body || {};
  const result = await runLeaveAlerts({ force: b.force === true, dryRun: b.dryRun === true });
  res.json(result);
}));

module.exports = router;
