const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, MAINTENANCE_ROLES } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// نفس دالتَي userFacility/userSafetyFacility الموجودتين في routes/production.js
// وroutes/safetyPermits.js بالضبط (نسخة محلية بدل استيراد مشترك، بنفس أسلوب
// routes/reports.js الحالي في هذا المشروع) — تُستخدمان هنا لتقييد أرقام لوحة
// المؤشرات بنفس قسم/مصنع المستخدم المقيَّد، بدل عرضها بلا تمييز للجميع.
function userFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.production_facility || null;
}
function userSafetyFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.safety_facility || null;
}

// قسم الصيانة — بلا تقييد بمصنع حاليًا (دور الصيانة ليس له عمود قسم أصلًا).
async function loadMaintenanceSection() {
  const [openWorkOrders, completedThisMonth, avgResolution, topFaults, technicianPerf] = await Promise.all([
    pool.query("SELECT count(*) FROM work_orders WHERE status NOT IN ('completed', 'cancelled')"),
    pool.query("SELECT count(*) FROM work_orders WHERE status = 'completed' AND completed_at >= date_trunc('month', now())"),
    pool.query(`
      SELECT avg(EXTRACT(EPOCH FROM (completed_at - assigned_at)) / 60) AS avg_minutes
      FROM work_orders WHERE status = 'completed' AND assigned_at IS NOT NULL
        AND completed_at >= now() - interval '30 days'
    `),
    pool.query(`
      SELECT description, count(*) AS occurrences FROM incident_reports
      WHERE reported_at >= now() - interval '30 days'
      GROUP BY description ORDER BY occurrences DESC LIMIT 5
    `),
    pool.query(`
      SELECT t.id, t.name,
        count(wo.*) FILTER (WHERE wo.status = 'completed') AS completed_count,
        avg(EXTRACT(EPOCH FROM (wo.completed_at - wo.assigned_at)) / 60) FILTER (WHERE wo.status = 'completed') AS avg_minutes
      FROM technicians t
      LEFT JOIN work_orders wo ON wo.assigned_technician_id = t.id
      GROUP BY t.id, t.name ORDER BY completed_count DESC
    `),
  ]);

  return {
    openWorkOrders: Number(openWorkOrders.rows[0].count),
    completedThisMonth: Number(completedThisMonth.rows[0].count),
    avgResolutionMinutes: avgResolution.rows[0].avg_minutes ? Math.round(avgResolution.rows[0].avg_minutes) : null,
    topFaults: topFaults.rows.map((r) => ({ description: r.description, occurrences: Number(r.occurrences) })),
    technicianPerformance: technicianPerf.rows.map((r) => ({
      id: r.id,
      name: r.name,
      completedCount: Number(r.completed_count),
      avgResolutionMinutes: r.avg_minutes ? Math.round(r.avg_minutes) : null,
    })),
  };
}

// قسم الإنتاج — مقيَّد بمصنع المستخدم لو كان مقيَّدًا (راجع userFacility)،
// فمسؤول "مصنع الرجال" مثلًا يرى أرقام مصنعه فقط، لا الإنتاج كاملًا.
async function loadProductionSection(facility) {
  const params = facility ? [facility] : [];
  const cond = facility ? 'AND l.location = $1' : '';

  const [openIncidents, downtimeTotal, batchesToday, producedThisMonth] = await Promise.all([
    pool.query(
      `SELECT count(*) FROM incident_reports i LEFT JOIN production_lines l ON l.id = i.line_id
       WHERE i.status != 'closed' ${cond}`,
      params
    ),
    pool.query(
      `SELECT COALESCE(sum(
         EXTRACT(EPOCH FROM (COALESCE(i.downtime_ended_at, now()) - i.downtime_started_at)) / 60
       ), 0) AS total_minutes
       FROM incident_reports i LEFT JOIN production_lines l ON l.id = i.line_id
       WHERE i.reported_at >= now() - interval '30 days' ${cond}`,
      params
    ),
    pool.query(
      `SELECT count(*) FROM production_batches b LEFT JOIN production_lines l ON l.id = b.line_id
       WHERE b.occurred_at::date = current_date ${cond}`,
      params
    ),
    pool.query(
      `SELECT COALESCE(sum(b.quantity), 0) AS total_qty
       FROM production_batches b LEFT JOIN production_lines l ON l.id = b.line_id
       WHERE b.occurred_at >= date_trunc('month', now()) ${cond}`,
      params
    ),
  ]);

  return {
    openIncidents: Number(openIncidents.rows[0].count),
    downtimeMinutesLast30Days: Math.round(Number(downtimeTotal.rows[0].total_minutes)),
    batchesToday: Number(batchesToday.rows[0].count),
    producedQuantityThisMonth: Number(producedThisMonth.rows[0].total_qty),
  };
}

// قسم السلامة — مقيَّد بقسم المستخدم لو كان مقيَّدًا (راجع userSafetyFacility)
// بنفس منطق location = القسم أو "القسم — تفاصيل" المستخدم في routes/safetyPermits.js.
// ملاحظة: عدد "حوادث وشيكة مفتوحة" (near_miss_reports) نفس التقييد أيضًا، لكن
// حقل location هناك نص حر وليس مضبوطًا بنفس القائمة دائمًا — فقد يظهر صفرًا
// لمسؤول مقيَّد حتى لو وُجدت بلاغات فعليًا بصياغة مختلفة قليلًا لنفس القسم.
async function loadSafetySection(facility) {
  const params = facility ? [facility] : [];
  const cond = facility ? "AND (location = $1 OR location LIKE $1 || ' — %')" : '';

  const [pending, approvedThisMonth, openNearMiss, topOps] = await Promise.all([
    pool.query(`SELECT count(*) FROM safety_permits WHERE status = 'pending' ${cond}`, params),
    pool.query(
      `SELECT count(*) FROM safety_permits
       WHERE status = 'approved' AND reviewed_at >= date_trunc('month', now()) ${cond}`,
      params
    ),
    pool.query(`SELECT count(*) FROM near_miss_reports WHERE status = 'open' ${cond}`, params),
    pool.query(
      `SELECT unnest(operation_types) AS op, count(*) AS occurrences
       FROM safety_permits WHERE requested_at >= now() - interval '30 days' ${cond}
       GROUP BY op ORDER BY occurrences DESC LIMIT 5`,
      params
    ),
  ]);

  return {
    pendingSafetyPermits: Number(pending.rows[0].count),
    approvedThisMonth: Number(approvedThisMonth.rows[0].count),
    openNearMissReports: Number(openNearMiss.rows[0].count),
    topOperationTypes: topOps.rows.map((r) => ({ type: r.op, occurrences: Number(r.occurrences) })),
  };
}

// GET /api/dashboard — مؤشرات لوحة التحكم الرئيسية، مقسَّمة الآن بحسب القسم
// (صيانة / إنتاج / سلامة) بدل رقم واحد مختلط يراه الجميع. كل قسم يُعاد فقط
// لصاحب الدور المناظر له (أو لمدير النظام الذي يرى الثلاثة معًا كما كان
// الوضع سابقًا) — قسم لا يظهر إطلاقًا لمن لا يملك صلاحيته (قيمته null)، وليس
// مجرد إخفاء في الواجهة فقط.
router.get('/', async (req, res) => {
  const role = req.user.role;
  const isAdmin = role === 'admin';
  const wantsMaintenance = isAdmin || MAINTENANCE_ROLES.includes(role);
  const wantsProduction = isAdmin || role === 'production' || role === 'production_manager';
  const wantsSafety = isAdmin || role === 'safety';

  const [maintenance, production, safety] = await Promise.all([
    wantsMaintenance ? loadMaintenanceSection() : Promise.resolve(null),
    wantsProduction ? loadProductionSection(userFacility(req)) : Promise.resolve(null),
    wantsSafety ? loadSafetySection(userSafetyFacility(req)) : Promise.resolve(null),
  ]);

  res.json({ maintenance, production, safety });
});

module.exports = router;
