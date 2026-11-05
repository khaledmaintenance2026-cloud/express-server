const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, MAINTENANCE_ROLES, TECHNICIAN_ROLES } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// بداية «شهر الصيانة» الحالي: يوم ٢٥ من هذا الشهر لو وصلناه، وإلا يوم ٢٥ من
// الشهر السابق (الساعة 00:00 بتوقيت جهاز السيرفر). new Date(y, -1, 25) يعطي
// ٢٥ ديسمبر من السنة السابقة تلقائيًا عند يناير.
function maintenanceCycleStart(now) {
  const year = now.getFullYear();
  const month = now.getMonth();
  return now.getDate() >= 25
    ? new Date(year, month, 25, 0, 0, 0, 0)
    : new Date(year, month - 1, 25, 0, 0, 0, 0);
}

// GET /api/maintenance-analysis?from=YYYY-MM-DD&to=YYYY-MM-DD — صفحة "تحليل
// الصيانة" (طلب 2026-10-03: "المهام وعمل الفنيين"). كانت مقصورة على مسؤول
// الصيانة؛ وبقرار المالك 2026-10-26 صارت لكل أفراد الصيانة مع الفنيين: مسؤول
// الصيانة وفني الصيانة (MAINTENANCE_ROLES) + مسؤول المخزون والمصمم
// (TECHNICIAN_ROLES، وهم «أفراد صيانة» قابلون للتكليف)، ومدير النظام تلقائيًا
// (requireRole يسمح له دائمًا). أما الإنتاج والسلامة والقسم العام فلا.
// الصفحة للقراءة فقط وتعرض أداء كل الفنيين، لا أداء المستخدم وحده.
//
// from/to اختياريان: لو غابا، الفترة الافتراضية هي «شهر الصيانة» الحالي الذي
// يبدأ يوم ٢٥ من كل شهر (طلب المالك 2026-11-04: «العداد يتصفّر كل شهر ويبدأ
// من تاريخ ٢٥»، متوافقًا مع التقرير الشهري يوم ٢٥) — أي من الساعة 00:00 يوم
// ٢٥ الأخير وحتى الآن. كانت سابقًا آخر ٣٠ يومًا متحركة. لو حُدِّدا،
// يُحتسب التحليل بالضبط عن الفترة المخصصة (شاملةً كل أحداث يوم "to" نفسه،
// لا لحظة منتصف الليل فقط). الاتجاه الزمني (trend) يُجمَّع أسبوعيًا تلقائيًا
// لو كانت الفترة أطول من ٦٠ يومًا (بدل عشرات/مئات الأعمدة اليومية التي يصعب
// قراءتها)، وإلا يوميًا.
router.get('/', requireRole(...MAINTENANCE_ROLES, ...TECHNICIAN_ROLES), async (req, res) => {
  const now = new Date();
  const defaultFrom = maintenanceCycleStart(now);
  const from = req.query.from ? new Date(req.query.from) : defaultFrom;
  const to = req.query.to ? new Date(req.query.to) : now;

  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return res.status(400).json({ error: 'الفترة الزمنية المحددة غير صالحة' });
  }
  // نهاية يوم "to" نفسه (٢٣:٥٩:٥٩) حتى تشمل كل أحداث ذلك اليوم، لا تتوقف عند منتصف ليله فقط.
  const toInclusive = new Date(to);
  toInclusive.setHours(23, 59, 59, 999);

  const rangeDays = Math.max(1, Math.ceil((toInclusive - from) / (24 * 60 * 60 * 1000)));
  const bucket = rangeDays > 60 ? 'week' : 'day';

  const [summaryRows, kindRows, trendRows, techRows] = await Promise.all([
    // الملخص العام: كل أوامر العمل التي أُنشئت خلال الفترة المحددة (created_at)
    // — "مُنجزة الآن" تعني أنها أُنجزت فعليًا (بصرف النظر عن متى)، و"مفتوحة
    // حاليًا" تعني لم تُنجز ولم تُلغَ بعد. متوسط وقت الإصلاح محسوب فقط على ما
    // أُنشئ وأُنجز كلاهما خلال نفس الفترة، حتى يعكس أداء الفترة نفسها بدقة.
    pool.query(
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) AS open,
         count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
         avg(EXTRACT(EPOCH FROM (completed_at - assigned_at)) / 60)
           FILTER (WHERE status = 'completed' AND completed_at BETWEEN $1 AND $2 AND assigned_at IS NOT NULL) AS avg_minutes
       FROM work_orders WHERE created_at BETWEEN $1 AND $2`,
      [from, toInclusive]
    ),
    // التوزيع الثلاثي: مهام عامة (is_task) / أعطال طارئة فعلية (kind=emergency
    // وليست مهمة) / أعمال وقائية (kind=preventive) — نفس تصنيف تبويبات
    // maintenance_dashboard_screen.dart في التطبيق بالضبط.
    pool.query(
      `SELECT
         count(*) FILTER (WHERE is_task) AS task,
         count(*) FILTER (WHERE kind = 'emergency' AND NOT is_task) AS emergency,
         count(*) FILTER (WHERE kind = 'preventive') AS preventive
       FROM work_orders WHERE created_at BETWEEN $1 AND $2`,
      [from, toInclusive]
    ),
    // الاتجاه الزمني: عدد الأوامر المُنشأة والمُنجزة في كل نقطة زمنية (يوم/أسبوع).
    pool.query(
      `SELECT date_trunc($3, created_at) AS bucket,
         count(*) AS created,
         count(*) FILTER (WHERE status = 'completed') AS completed
       FROM work_orders WHERE created_at BETWEEN $1 AND $2
       GROUP BY bucket ORDER BY bucket`,
      [from, toInclusive, bucket]
    ),
    // أداء كل فني خلال الفترة: عدد المهام المُنجزة ومتوسط وقت إنجازها
    // (completed_at داخل الفترة)، وعدد المهام المفتوحة حاليًا من بين ما أُنشئ
    // خلال الفترة نفسها. LEFT JOIN من جدول الفنيين كاملاً (لا فقط من له نشاط)
    // حتى يظهر أي فني بلا أي مهمة في الفترة بصفر، لا أن يختفي من القائمة.
    // الربط عبر work_order_technicians (يدعم تعدد الفنيين لنفس الأمر) بدل
    // assigned_technician_id وحده، حتى يُحتسب كل فني شارك في الأمر لا الأساسي فقط.
    pool.query(
      `SELECT t.id, t.name,
         count(wo.*) FILTER (WHERE wo.status = 'completed' AND wo.completed_at BETWEEN $1 AND $2) AS completed_count,
         count(wo.*) FILTER (WHERE wo.status NOT IN ('completed','cancelled') AND wo.created_at BETWEEN $1 AND $2) AS open_count,
         avg(EXTRACT(EPOCH FROM (wo.completed_at - wo.assigned_at)) / 60)
           FILTER (WHERE wo.status = 'completed' AND wo.completed_at BETWEEN $1 AND $2 AND wo.assigned_at IS NOT NULL) AS avg_minutes
       FROM technicians t
       LEFT JOIN work_order_technicians wot ON wot.technician_id = t.id
       LEFT JOIN work_orders wo ON wo.id = wot.work_order_id
       GROUP BY t.id, t.name
       ORDER BY completed_count DESC, t.name`,
      [from, toInclusive]
    ),
  ]);

  const s = summaryRows.rows[0];
  const k = kindRows.rows[0];

  res.json({
    range: { from: from.toISOString(), to: toInclusive.toISOString(), bucket },
    summary: {
      total: Number(s.total),
      completed: Number(s.completed),
      open: Number(s.open),
      cancelled: Number(s.cancelled),
      avgResolutionMinutes: s.avg_minutes ? Math.round(s.avg_minutes) : null,
      byKind: { task: Number(k.task), emergency: Number(k.emergency), preventive: Number(k.preventive) },
    },
    trend: trendRows.rows.map((r) => ({
      date: r.bucket,
      created: Number(r.created),
      completed: Number(r.completed),
    })),
    technicians: techRows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      completedCount: Number(r.completed_count),
      openCount: Number(r.open_count),
      avgResolutionMinutes: r.avg_minutes ? Math.round(r.avg_minutes) : null,
    })),
  });
});

module.exports = router;
