const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, MAINTENANCE_ROLES, PRODUCTION_ROLES } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

/// نفس منطق التقييد المستخدم في routes/production.js بالضبط: مدير النظام
/// دائمًا بلا تقييد (يرى تقرير كل المصانع مجتمعة)، وأي مستخدم إنتاج آخر إما
/// بلا تقييد أيضًا (مدير إنتاج عام، production_facility فارغ) أو مقيَّد
/// بمصنع واحد فقط (مشرف صالة) حسب ما حدّده مدير النظام من لوحة الإدارة.
function userFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.production_facility || null;
}

/// نفس المنطق تمامًا، لكن لتقييد قسم السلامة (عمود safety_facility) بدل
/// الإنتاج — يطابق userSafetyFacility في routes/safetyPermits.js تمامًا،
/// المستخدم فعليًا لتقييد GET /api/safety-permits (لوحة السلامة نفسها) بمصنع
/// واحد لمسؤول سلامة مقيَّد. كان هذا التقييد مفقودًا هنا تحديدًا في تصدير
/// CSV — مسؤول سلامة مقيَّد بمصنع واحد كان يقدر يستخرج تصاريح كل المصانع
/// (بما فيها أرقام جوال المسؤولين) عبر هذا المسار، رغم أنه لا يراها إطلاقًا
/// من داخل التطبيق نفسه.
function userSafetyFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.safety_facility || null;
}

/// يحوّل صفوف من قاعدة البيانات لملف CSV يفتح مباشرة في Excel (بدون أي
/// حزمة إضافية) — لتصدير التقارير بضغطة زر كما هو مطلوب. لطباعة PDF،
/// استخدموا "طباعة" من متصفح لوحة التحكم مباشرة (Ctrl+P) على أي جدول.
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

const REPORT_QUERIES = {
  'work-orders': `
    SELECT wo.id, wo.description, wo.kind, wo.status, t.name AS technician, l.name AS line,
      wo.created_at, wo.assigned_at, wo.completed_at, wo.close_description
    FROM work_orders wo
    LEFT JOIN technicians t ON t.id = wo.assigned_technician_id
    LEFT JOIN production_lines l ON l.id = wo.line_id
    ORDER BY wo.created_at DESC`,
};

// GET /api/reports/export.csv?type=work-orders|incidents|safety-permits
//
// كل نوع تقرير مقيَّد الآن بنفس صلاحية القسم المعني (وليس فقط requireAuth+
// requireApproved العام على كل الملف) — لم يكن هذا المسار محكومًا بأي دور
// سابقًا، فأي مستخدم معتمد من أي قسم يقدر يستخرج تقرير أي قسم آخر عبر
// استدعاء API مباشر، حتى لو لم يكن زر "تصدير" ظاهرًا له أصلًا في التطبيق.
//
// تقرير "بلاغات الإنتاج" (incidents) وتقرير "تصاريح السلامة" (safety-permits)
// يخضعان أيضًا لتقييد المصنع/القسم الفرعي (نفس منطق userFacility/
// userSafetyFacility أعلاه بالضبط، ونفس منطق GET /api/safety-permits في
// routes/safetyPermits.js): مدير النظام أو مسؤول غير مقيَّد يحصل على تقرير
// يجمع كل المصانع/الأقسام معًا، بينما مسؤول مقيَّد بمصنع واحد يحصل تلقائيًا
// على تقرير قسمه فقط دون أي إعداد إضافي منه — ولا يقدر تجاوز ذلك بتغيير
// الرابط يدويًا.
router.get('/export.csv', async (req, res) => {
  const type = req.query.type;
  let sql;
  let params = [];

  if (type === 'incidents') {
    if (req.user.role !== 'admin' && !PRODUCTION_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'تقرير بلاغات الإنتاج متاح فقط لقسم الإنتاج' });
    }
    const facility = userFacility(req);
    sql = `
      SELECT i.id, i.description, l.name AS line, l.location AS facility, e.name AS equipment,
        i.reported_by, i.reported_at, i.status
      FROM incident_reports i
      LEFT JOIN production_lines l ON l.id = i.line_id
      LEFT JOIN equipment e ON e.id = i.equipment_id
      ${facility ? 'WHERE l.location = $1' : ''}
      ORDER BY i.reported_at DESC`;
    params = facility ? [facility] : [];
  } else if (type === 'safety-permits') {
    if (req.user.role !== 'admin' && req.user.role !== 'safety') {
      return res.status(403).json({ error: 'تقرير تصاريح السلامة متاح فقط لقسم السلامة المهنية' });
    }
    const facility = userSafetyFacility(req);
    sql = `
      SELECT id, office_name, array_to_string(operation_types, ' / ') AS operation_types, location, description,
        start_at, end_at, workers_count, responsible_phone, requested_by, requested_at, status,
        array_to_string(site_hazards, ' / ') AS site_hazards, array_to_string(potential_risks, ' / ') AS potential_risks,
        array_to_string(ppe_required, ' / ') AS ppe_required, precautions, rejection_reason, reviewed_by, reviewed_at
      FROM safety_permits
      ${facility ? "WHERE location = $1 OR location LIKE $1 || ' — %'" : ''}
      ORDER BY requested_at DESC`;
    params = facility ? [facility] : [];
  } else if (type === 'work-orders') {
    if (req.user.role !== 'admin' && !MAINTENANCE_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'تقرير أوامر العمل متاح فقط لقسم الصيانة' });
    }
    sql = REPORT_QUERIES[type];
  }

  if (!sql) return res.status(400).json({ error: 'نوع التقرير غير معروف' });

  const { rows } = await pool.query(sql, params);
  const csv = toCsv(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
  res.send(csv);
});

module.exports = router;