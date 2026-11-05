const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, MAINTENANCE_ROLES, TECHNICIAN_ROLES } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');
const { generateMaintenanceReport } = require('../services/maintenanceReport');
const { sendWhatsappText } = require('../services/textmebot');
const { recomputeLinkedBatches } = require('../services/batchWorkOrderLink');
const { withLock } = require('../lib/keyedLock');

const router = new Router();
router.use(requireAuth, requireApproved);

// عمودا "من قام بالتعيين" (assigned_by = الاسم للعرض، assigned_by_user = معرّف
// الحساب) — طلب 2026-10-06: "عند التعيين يبين أيضًا من الشخص الذي قام
// بالتعيين". يُضافان تلقائيًا مرة واحدة (آمن للتكرار: IF NOT EXISTS) عند أول
// تشغيل للسيرفر بعد هذا التحديث، فلا حاجة لأي أمر ترحيل يدوي. لو فشلت
// إضافتهما لأي سبب، يستمر التعيين بالعمل كالسابق تمامًا (بلا تسجيل المُعيِّن)
// بدل أن يتعطل التعيين كله.
let assignedByReady = null;
function ensureAssignedByColumns() {
  if (!assignedByReady) {
    assignedByReady = pool
      .query(
        `ALTER TABLE work_orders
           ADD COLUMN IF NOT EXISTS assigned_by TEXT,
           ADD COLUMN IF NOT EXISTS assigned_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL`
      )
      .then(() => true)
      .catch((err) => {
        console.error('تعذّر إضافة عمودي assigned_by لجدول work_orders:', err.message);
        assignedByReady = null; // نحاول من جديد عند التعيين التالي
        return false;
      });
  }
  return assignedByReady;
}
ensureAssignedByColumns();

// ملاحظات المشرف على المهمة (طلب 2026-10-07: "عند تحويل مهمة إلى شخص يمكن
// للمشرف إضافة ملاحظات على المهمة سواء كانت منجزة أو تحت الإنجاز، تُرسل في
// الجروب وأيضًا للفني"). جدول مستقل يحفظ كل ملاحظة (نصها، كاتبها، وقتها،
// وحالة المهمة لحظة كتابتها) كسجل لا يُمسح — يُنشأ تلقائيًا مرة واحدة عند أول
// تشغيل بعد هذا التحديث (CREATE ... IF NOT EXISTS آمن للتكرار)، فلا حاجة
// لأي أمر ترحيل يدوي. لو فشل إنشاؤه لأي سبب، تستمر كل مسارات أوامر العمل
// الأخرى بالعمل كما كانت تمامًا (فقط ميزة الملاحظات تتعطل إلى حين نجاحه).
const NOTE_MAX_LENGTH = 1000;
let notesTableReady = null;
function ensureNotesTable() {
  if (!notesTableReady) {
    notesTableReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS work_order_notes (
           id                 BIGSERIAL PRIMARY KEY,
           work_order_id      BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
           note               TEXT NOT NULL,
           author_name        TEXT,
           author_user        BIGINT REFERENCES users(id) ON DELETE SET NULL,
           work_order_status  TEXT,
           created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_work_order_notes_wo ON work_order_notes (work_order_id, created_at DESC)`
      );
      return true;
    })().catch((err) => {
      console.error('تعذّر إنشاء جدول work_order_notes:', err.message);
      notesTableReady = null; // نحاول من جديد عند الطلب التالي
      return false;
    });
  }
  return notesTableReady;
}
ensureNotesTable();

// يُلحق notes_count (عدد ملاحظات المشرف) بكل صف من قائمة أوامر العمل ليظهر
// عدّاد صغير على بطاقة المهمة في التطبيق. استعلام منفصل ومحصّن بـtry/catch
// عمدًا (وليس subquery داخل LIST_QUERY نفسه) حتى لا يتعطل عرض كل أوامر العمل
// لو تعذّر وجود جدول الملاحظات لأي سبب.
async function attachNotesCount(rows) {
  if (!rows || rows.length === 0) return;
  try {
    if (!(await ensureNotesTable())) return;
    const { rows: counts } = await pool.query(
      'SELECT work_order_id, COUNT(*)::int AS n FROM work_order_notes GROUP BY work_order_id'
    );
    const byOrder = new Map(counts.map((c) => [String(c.work_order_id), Number(c.n)]));
    for (const row of rows) row.notes_count = byOrder.get(String(row.id)) || 0;
  } catch (err) {
    console.error('تعذّر جلب أعداد ملاحظات المشرف:', err.message);
  }
}

// نفس الفكرة لصف واحد: استجابات التعديل/التعيين/تحديث الحالة/الإنجاز/إزالة فني
// ترجع صف أمر العمل نفسه ويستبدل به التطبيق نسخته المحلية — فنُلحق به
// notes_count أيضًا حتى لا يعود عدّاد ملاحظات المشرف على البطاقة إلى الصفر
// مؤقتًا بعد أي من هذه العمليات.
async function attachNotesCountToOne(row) {
  if (!row || row.id === undefined || row.id === null) return;
  try {
    if (!(await ensureNotesTable())) return;
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM work_order_notes WHERE work_order_id = $1',
      [row.id]
    );
    row.notes_count = Number(rows[0] ? rows[0].n : 0);
  } catch (err) {
    console.error('تعذّر جلب عدد ملاحظات المشرف للمهمة:', err.message);
  }
}

// technician_name يبقى "الفني الأساسي" فقط (أول فني اختير) للتوافق مع أي
// كود قديم ما زال يقرأه — technician_names (بالجمع) يحمل كل الفنيين
// المُسنَد إليهم أمر العمل نفسه (راجع جدول work_order_technicians الجديد
// في schema.sql)، مفصولين بـ"، " جاهزين للعرض مباشرة.
// ملاحظة مهمة: wo.* يجلب أصلًا عمود equipment_name النصي الحر (يُعبَّأ يدويًا
// عند الإنشاء، كما في تحويل بلاغ إنتاج إلى أمر عمل — راجع
// AppState.convertIncidentToWorkOrder في التطبيق). لولا COALESCE هنا لكانت
// e.name (فارغة غالبًا لأن equipment_id نفسه غالبًا NULL) تطغى على القيمة
// الحرة الصحيحة بسبب تكرار اسم العمود equipment_name في نفس الاستعلام، فيختفي
// اسم المعدة بعد أي تحديث لاحق للقائمة رغم ظهوره الصحيح عند الإنشاء مباشرة.
//
// كود المكينة بنفس المنطق: لو لم يُخزَّن على أمر العمل نفسه (كأمر ناتج عن تحويل
// بلاغ إنتاج، حيث لا يُرسَل الكود) نأخذه من سجل المعدة المرتبطة e.code — فيظهر
// في رسائل واتساب والإشعارات والتقارير حتى لأوامر العمل القديمة المحفوظة بلا كود.
const LIST_QUERY = `
  SELECT wo.*, t.name AS technician_name, l.name AS line_name, COALESCE(wo.equipment_name, e.name) AS equipment_name,
    COALESCE(NULLIF(wo.equipment_code, ''), e.code) AS equipment_code,
    (SELECT string_agg(t2.name, '، ' ORDER BY t2.name)
       FROM work_order_technicians wot
       JOIN technicians t2 ON t2.id = wot.technician_id
      WHERE wot.work_order_id = wo.id) AS technician_names
  FROM work_orders wo
  LEFT JOIN technicians t ON t.id = wo.assigned_technician_id
  LEFT JOIN production_lines l ON l.id = wo.line_id
  LEFT JOIN equipment e ON e.id = wo.equipment_id
`;

// يجلب كل الفنيين المُسنَد إليهم أمر عمل معيّن (اسم/جوال/معرّف حساب المستخدم
// المرتبط، إن وُجد) — تُستخدم لإثراء إشعارات واتساب والإشعارات داخل التطبيق
// بحيث تصل لكل فني وليس لفني واحد فقط.
async function getWorkOrderTechnicians(workOrderId) {
  const { rows } = await pool.query(
    // specialty وstatus أُضيفا لاحقًا (2026-09-26) خصيصًا لـ GET /:id/technicians
    // (تحتاجهما شاشة "تعديل المهمة" في التطبيق لعرض دقيق لكل فني) — لا يؤثران
    // على استخدامات هذه الدالة الأخرى (إثراء إشعارات واتساب) التي تتجاهلهما.
    `SELECT t.id, t.name, t.phone, t.user_id, t.specialty, t.status
       FROM work_order_technicians wot
       JOIN technicians t ON t.id = wot.technician_id
      WHERE wot.work_order_id = $1
      ORDER BY t.name`,
    [workOrderId]
  );
  return rows;
}

// يجلب رافع بلاغ العطل الأصلي (قسم الإنتاج) لأمر عمل ناتج عن تحويل بلاغ إنتاج
// — اسمه، معرّف حسابه، ورقم جواله الشخصي (إن كان مسجَّلًا في بيانات حسابه).
// يُستخدم لإرسال رسالة واتساب شخصية له عند قبول بلاغه (تعيين فني له) — طلب
// صريح 2026-10-04: "لا يوجد إشعار بقبول أو انتهاء المهمة لقسم الإنتاج في
// الواتس اب". ترجع null لو لم يوجد البلاغ (أو لم يكن لأمر العمل بلاغ أصلًا).
async function getIncidentReporter(incidentReportId) {
  if (!incidentReportId) return null;
  const { rows } = await pool.query(
    `SELECT i.reported_by, i.reported_by_user, u.phone
       FROM incident_reports i
       LEFT JOIN users u ON u.id = i.reported_by_user
      WHERE i.id = $1`,
    [incidentReportId]
  );
  return rows[0] || null;
}

// يتحقق: هل حساب الدخول [userId] هو نفسه أحد الفنيين المُسنَد إليهم أمر
// العمل [workOrderId] تحديدًا؟ عبر ربط حساب المستخدم بسجل فني (جدول
// technicians.user_id)، ثم مطابقته إما بـ"الفني الأساسي" (assignedTechnicianId
// — توافقًا مع أوامر أُسندت قبل دعم تعدد الفنيين) أو بأي إدخال في
// work_order_technicians (تعيين متعدد فنيين). تُستخدم لتقييد كل من إنجاز
// الأمر (/close) وعرض/استخراج تقريره (GET /:id) على الفني المعني فعليًا فقط.
async function userIsAssignedTechnician(userId, workOrderId, assignedTechnicianId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM technicians t
      WHERE t.user_id = $1
        AND (
          t.id = $2
          OR EXISTS (SELECT 1 FROM work_order_technicians wot WHERE wot.work_order_id = $3 AND wot.technician_id = t.id)
        )
      LIMIT 1`,
    [userId, assignedTechnicianId, workOrderId]
  );
  return rows.length > 0;
}

// GET /api/work-orders — دعم فلترة اختيارية بالحالة: ?status=in_progress
// عمدًا بلا requireRole هنا (خلافًا لباقي مسارات هذا الملف): يعتمد عليه
// AppState.openEmergencyReports في التطبيق لعرض أوامر العمل المفتوحة كخيار
// "ربط بعملية بلاغ قائمة" داخل شاشة طلب تصريح العمل، المتاحة لأي قسم (سلامة
// وإنتاج أيضًا، ليس الصيانة فقط) — تقييده بـMAINTENANCE_ROLES يمنع تلك
// الميزة من العمل لأي مستخدم خارج الصيانة. راجع الحالة رقم ١ في مراجعة
// 2026-09-20 بمستند نظام إشعارات واتساب/التوصيات — الحل الأدق (لو رغبتم
// تضييق البيانات المكشوفة لاحقًا) هو مسار مختصر منفصل لعناوين الأوامر
// المفتوحة فقط، وليس تقييد هذا المسار كما هو.
//
// قيد خصوصية جديد (قرار صريح 2026-09-26): الفني العادي (maintenance_technician
// تحديدًا، لا مسؤول الصيانة ولا المدير) لم يعد يرى إطلاقًا إلا أوامر العمل/
// المهام التي هو مُسنَد إليها فعليًا (حاليًا أو سابقًا، بأي حالة)، أو التي رفعها
// هو بنفسه (حتى يتابع حالة بلاغه قبل تعيين أحد له) — لا "بانتظار التعيين"
// لغيره ولا أعمال زملائه بعد الآن؛ التعيين صار حصرًا من مسؤول الصيانة/المدير.
// مسؤول الصيانة والمدير يريان كل شيء دائمًا بلا أي قيد، تمامًا كما كان. أي دور
// آخر غير الصيانة (سلامة/إنتاج...) يبقى بلا أي قيد هنا عمدًا — هذا القيد خاص
// بخصوصية مهام الصيانة فقط، ولا علاقة له بميزة "ربط بعملية بلاغ قائمة" أعلاه.
// (تحديث 2026-10-03): مسؤول المخزون (inventory_manager) والمصمم (designer)
// صاروا أيضًا من "أفراد الصيانة القابلين للتكليف" — TECHNICIAN_ROLES في
// middleware/auth.js — فيخضعان لنفس قيد الخصوصية هذا تمامًا كالفني العادي.
router.get('/', async (req, res) => {
  const { status } = req.query;
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`wo.status = $${params.length}`);
  }

  if (TECHNICIAN_ROLES.includes(req.user.role)) {
    const { rows: techRows } = await pool.query('SELECT id FROM technicians WHERE user_id = $1', [req.user.id]);
    const techId = techRows[0]?.id;
    if (!techId) {
      // حساب دخول لفني بلا سجل technicians.user_id مرتبط أصلًا — لا يرى شيئًا
      // بدل تسريب كل البيانات أو رمي خطأ غامض.
      return res.json({ workOrders: [] });
    }
    params.push(techId);
    const techIdx = params.length;
    params.push(req.user.id);
    const creatorIdx = params.length;
    conditions.push(
      `(wo.assigned_technician_id = $${techIdx}
        OR EXISTS (SELECT 1 FROM work_order_technicians wot WHERE wot.work_order_id = wo.id AND wot.technician_id = $${techIdx})
        OR wo.created_by_user = $${creatorIdx})`
    );
  }

  const sql = `${LIST_QUERY}${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY wo.created_at DESC`;
  const { rows } = await pool.query(sql, params);
  await attachNotesCount(rows);
  res.json({ workOrders: rows });
});

// GET /api/work-orders/:id — مع قطع الغيار وسجلات LOTO المرتبطة. مقيّد بقسم
// الصيانة (كباقي مسارات هذا الملف)، وبداخله: استخراج/عرض تقرير أمر العمل
// (هذا هو المسار الوحيد الذي تعتمد عليه شاشة "تقرير البلاغ" —
// MaintenanceReportPrintScreen) متاح فقط لمسؤول الصيانة (أو المدير) — لا
// يقدر أي فني، حتى لو كان هو من أنجز الأمر بنفسه، استخراج تقريره.
router.get('/:id', requireRole(...MAINTENANCE_ROLES), async (req, res) => {
  const { rows } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });

  if (req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    return res.status(403).json({ error: 'استخراج تقرير أمر العمل متاح فقط لمسؤول الصيانة' });
  }

  const [parts, loto] = await Promise.all([
    pool.query('SELECT * FROM spare_parts_used WHERE work_order_id = $1 ORDER BY created_at', [req.params.id]),
    pool.query('SELECT * FROM loto_logs WHERE work_order_id = $1 ORDER BY created_at', [req.params.id]),
  ]);
  res.json({ workOrder: rows[0], spareParts: parts.rows, lotoLogs: loto.rows });
});

// POST /api/work-orders — إنشاء أمر عمل (من بلاغ عطل أو مبادرة وقائية مستقلة)
// دور "السلامة" (safety) مضاف هنا صراحة إلى جانب MAINTENANCE_ROLES — يسمح
// لضابط السلامة برفع بلاغ صيانة مباشرة لأي مكان في المصنع أثناء جولاته
// (مثل مراجعة تصاريح العمل)، فيظهر البلاغ فورًا في قائمة أوامر عمل الصيانة
// نفسها بلا خطوة وسيطة، بدل مساره القديم الوحيد المتاح لغير الصيانة (بلاغ
// إنتاج عبر POST /production/incidents يحتاج تحويلًا يدويًا لاحقًا من
// الصيانة، غير مناسب هنا لأن طلب المستخدم صريح: "اربطه مع قائمة البلاغات
// للصيانة" مباشرة). هذا لا يفتح أي صلاحية إضافية لقسم السلامة على هذا
// المسار غير الإنشاء نفسه — الشرط أدناه (kind === 'preventive') يبقى كما هو
// فيمنع السلامة (وأي دور آخر غير مسؤول/مدير الصيانة) من إنشاء أمر عمل
// وقائي، وباقي مسارات هذا الملف (تعيين فني، إغلاق، حذف...) تبقى مقيّدة
// بـMAINTENANCE_ROLES فقط دون أي تغيير.
//
// تحديث 2026-10-05 (قرار صريح): فني الصيانة (maintenance_technician) لم يعد
// يقدر ينشئ أي أمر عمل أو "مهمة عمل" بنفسه إطلاقًا — الإنشاء المباشر
// لمسؤول الصيانة والمدير (admin يمر دائمًا من requireRole) وضابط السلامة
// (بلاغه المباشر كما وُصف أعلاه) فقط. الفني يبقى ينفّذ ويُنجز ما يُسنَد إليه.
router.post('/', requireRole('maintenance_manager', 'safety'), async (req, res) => {
  const {
    incidentReportId, equipmentId, lineId, kind, description, requiresLoto,
    reminderIntervalDays, equipmentName, facility, equipmentCode,
    isTask, taskScope, expectedBatchNumber,
  } = req.body;
  if (!description) return res.status(400).json({ error: 'وصف العمل إلزامي' });
  // "مهمة عمل" (داخلية/خارجية) — تصنيف ثالث منفصل تمامًا عن بلاغ العطل
  // الطارئ والصيانة الوقائية، يبادره فريق الصيانة نفسه لمهام عامة لا ترتبط
  // بعطل فعلي في معدة. kind يبقى 'emergency' عمدًا (راجع تعليق is_task في
  // schema.sql) — isTask/taskScope فقط للتمييز لاحقًا في التقارير والواجهة.
  if (isTask && taskScope && !['internal', 'external'].includes(taskScope)) {
    return res.status(400).json({ error: 'نوع المهمة غير صحيح' });
  }

  // بلاغ العطل الطارئ المباشر (بلا بلاغ إنتاج سابق) متاح للفني والمسؤول معًا
  // كما كان دائمًا (أما تحويل بلاغ إنتاج قائم فللمسؤول فقط — راجع الشرط
  // التالي مباشرة بعد هذا). أما أمر العمل
  // الوقائي (kind: 'preventive') فيبادره مشرف الصيانة نفسه حصرًا (راجع تعليق
  // createWorkOrder في lib/services/app_state.dart بالتطبيق) — قرار صريح:
  // يُحصر بمسؤول الصيانة أو المدير، ولا يقدر الفني إنشاءه حتى عبر استدعاء
  // API مباشر.
  if (kind === 'preventive' && req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    return res.status(403).json({ error: 'إنشاء أمر عمل وقائي متاح فقط لمسؤول الصيانة' });
  }

  // تحويل بلاغ إنتاج إلى أمر عمل (incidentReportId = زر "تحويل" في التطبيق)
  // قرار صريح 2026-10-05: لمسؤول الصيانة أو المدير فقط. الفني (وأي دور آخر
  // كالسلامة) يرى البلاغ وصورته لكن لا يحوّله، حتى عبر استدعاء API مباشر.
  // إنشاء أمر عمل طارئ مباشر (بلا incidentReportId) يبقى متاحًا كما كان.
  if (incidentReportId && req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    return res.status(403).json({ error: 'تحويل بلاغ الإنتاج إلى أمر عمل متاح فقط لمسؤول الصيانة' });
  }

  // حماية من التكرار (شكوى: أمر العمل نفسه يُنشأ/يُحوَّل أكثر من مرة وتصل
  // رسائل مكررة): الفحص والإدخال داخل قفل، فلا يمرّ طلبان متطابقان معًا.
  //  - تحويل بلاغ إنتاج: إن كان للبلاغ أمر عمل قائم (غير ملغى) نعيده كما هو.
  //  - إنشاء مباشر: نفس المنشئ + نفس الوصف والنوع والمعدة/الخط خلال دقيقتين
  //    = ضغطة مكررة أو إعادة إرسال من التطبيق، فنعيد الأمر الأول.
  const lockKey = incidentReportId ? `wo-convert:${incidentReportId}` : `wo-create:${req.user.id}`;
  const created = await withLock(lockKey, async () => {
    if (incidentReportId) {
      const ex = await pool.query(
        "SELECT id FROM work_orders WHERE incident_report_id = $1 AND status <> 'cancelled' ORDER BY id DESC LIMIT 1",
        [incidentReportId]
      );
      if (ex.rows.length > 0) return { existingId: ex.rows[0].id, reason: 'alreadyConverted' };
    } else {
      const ex = await pool.query(
        `SELECT id FROM work_orders
          WHERE incident_report_id IS NULL AND created_by_user = $1 AND description = $2
            AND kind = $3 AND is_task = $4
            AND equipment_id IS NOT DISTINCT FROM $5 AND line_id IS NOT DISTINCT FROM $6
            AND COALESCE(equipment_name, '') = $7
            AND created_at > now() - interval '2 minutes'
          ORDER BY id DESC LIMIT 1`,
        [
          req.user.id,
          description.trim(),
          kind === 'preventive' ? 'preventive' : 'emergency',
          Boolean(isTask),
          equipmentId || null,
          lineId || null,
          equipmentName ? String(equipmentName).trim() : '',
        ]
      );
      if (ex.rows.length > 0) return { existingId: ex.rows[0].id, reason: 'duplicate' };
    }

    // "صاحب البلاغ" الحقيقي لأمر عمل ناتج عن تحويل بلاغ عطل من الإنتاج
    // (incidentReportId) هو مَن رفع البلاغ الأصلي (منتج/مشغّل خط) — وليس فني
    // أو مسؤول الصيانة الذي ضغط زر "تحويل لأمر عمل" (وهو req.user هنا فقط
    // بصفته مُنفِّذ العملية). بدون هذا التصحيح، أمر العمل يُنسَب بالكامل خطأً
    // لمن حوّله: يظهر اسمًا خاطئًا في "رفع بواسطة" بلوحة الصيانة، والأهم أن
    // رسالة واتساب الشخصية "تم إنجاز أمر العمل الذي طلبته" عند الإغلاق (راجع
    // notifyEvent الحالة 'work_order_completed' في services/notifications.js)
    // كانت تصل لجوال من حوّل البلاغ بدل صاحب البلاغ الفعلي الذي ينتظر فعلًا
    // معرفة أن عطله أُصلح. لو تعذّر ربط حساب صاحب البلاغ الأصلي (رقم جواله غير
    // مسجَّل أو حسابه محذوف)، نترك created_by_user فارغًا (NULL) بدل نسبته خطأً
    // لمن حوّل البلاغ — فلا تصل رسالة شخصية لأحد بدل وصولها للشخص الخطأ.
    let createdByName = req.user.name;
    let createdByUserId = req.user.id;
    // "رقم الباتش المتوقع" (إن كتبه مشرف الإنتاج عند رفع البلاغ نفسه — راجع
    // POST /production/incidents) يُنسَخ هنا تلقائيًا إلى أمر العمل الناتج عن
    // تحويل ذلك البلاغ، بلا أي إدخال إضافي من الصيانة (زر "تحويل لأمر عمل" ضغطة
    // واحدة بلا بيانات إضافية). يُستخدم لاحقًا لمطابقة/ربط الباتش تلقائيًا فور
    // تسجيله الفعلي بنفس الرقم على نفس الخط (راجع findAutoLinkWorkOrder في
    // services/batchWorkOrderLink.js). لو لم يأتِ أمر العمل من بلاغ إنتاج (مثلًا
    // أمر وقائي أو بلاغ صيانة مباشر)، نقبل القيمة كحقل اختياري مباشر بدلًا منها.
    let incidentExpectedBatchNumber = null;
    if (incidentReportId) {
      try {
        const { rows: incidentRows } = await pool.query(
          'SELECT reported_by, reported_by_user, expected_batch_number FROM incident_reports WHERE id = $1',
          [incidentReportId]
        );
        if (incidentRows.length > 0) {
          createdByName = incidentRows[0].reported_by || createdByName;
          createdByUserId = incidentRows[0].reported_by_user;
          incidentExpectedBatchNumber = incidentRows[0].expected_batch_number || null;
        }
      } catch (err) {
        console.error('تعذّر جلب بيانات رافع البلاغ الأصلي عند تحويله لأمر عمل:', err.message);
      }
    }
    const finalExpectedBatchNumber = incidentExpectedBatchNumber
      || (expectedBatchNumber && String(expectedBatchNumber).trim() ? String(expectedBatchNumber).trim() : null);

    // كود المكينة: لو لم يُرسَل صراحةً (كتحويل بلاغ إنتاج لأمر عمل — التطبيق يرسل
    // equipmentId فقط) نأخذه من سجل المعدة نفسها، وإن لم تُرسَل المعدة أصلًا نجرّب
    // معدة البلاغ الأصلي. فشل هذه القراءة لا يمنع إنشاء أمر العمل.
    let resolvedEquipmentCode = equipmentCode && String(equipmentCode).trim() ? String(equipmentCode).trim() : null;
    if (!resolvedEquipmentCode) {
      try {
        let codeEquipmentId = equipmentId || null;
        if (!codeEquipmentId && incidentReportId) {
          const inc = await pool.query('SELECT equipment_id FROM incident_reports WHERE id = $1', [incidentReportId]);
          codeEquipmentId = inc.rows[0] ? inc.rows[0].equipment_id : null;
        }
        if (codeEquipmentId) {
          const eq = await pool.query('SELECT code FROM equipment WHERE id = $1', [codeEquipmentId]);
          if (eq.rows[0] && eq.rows[0].code && String(eq.rows[0].code).trim()) resolvedEquipmentCode = String(eq.rows[0].code).trim();
        }
      } catch (err) {
        console.error('تعذّر جلب كود المكينة من سجل المعدة:', err.message);
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO work_orders
         (incident_report_id, equipment_id, line_id, kind, description, requires_loto, created_by, created_by_user, reminder_interval_days, status, equipment_name, facility, equipment_code, is_task, task_scope, expected_batch_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_assignment', $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        incidentReportId || null,
        equipmentId || null,
        lineId || null,
        kind === 'preventive' ? 'preventive' : 'emergency',
        description.trim(),
        Boolean(requiresLoto),
        createdByName,
        createdByUserId,
        reminderIntervalDays || null,
        equipmentName ? String(equipmentName).trim() : null,
        facility ? String(facility).trim() : null,
        resolvedEquipmentCode,
        Boolean(isTask),
        isTask && taskScope ? taskScope : null,
        finalExpectedBatchNumber,
      ]
    );
    if (incidentReportId) {
      await pool.query("UPDATE incident_reports SET status = 'linked' WHERE id = $1", [incidentReportId]);
    }
    return { workOrder: rows[0] };
  });

  if (created.existingId) {
    const { rows: existingRows } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [created.existingId]);
    await attachNotesCountToOne(existingRows[0]);
    return res.status(200).json({ workOrder: existingRows[0], [created.reason]: true });
  }

  const workOrder = created.workOrder;
  res.status(201).json({ workOrder });
  // بلاغات الأعطال الطارئة تحتاج انتباه فريق الصيانة فورًا — إشعار جروب
  // الصيانة بمجرد رفع البلاغ، وليس فقط عند تعيين فني له لاحقًا (كان هذا
  // مفقودًا تمامًا سابقًا؛ راجع services/notifications.js).
  //
  // استثناء: أمر عمل ناتج عن تحويل بلاغ إنتاج قائم (incidentReportId) لا
  // يُطلق هذا الإشعار — جروب الصيانة استلم فعليًا إشعار "بلاغ عطل مفاجئ"
  // الكامل لحظة رفع ذلك البلاغ نفسه (راجع notifyEvent الحالة
  // 'incident_created' في routes/production.js)، فإطلاقه مجددًا هنا كان
  // يعني رسالتين منفصلتين لنفس العطل الواحد. هذا الحدث الآن مخصّص فقط لبلاغ
  // عطل طارئ يُنشئه فريق الصيانة مباشرة بلا بلاغ إنتاج سابق على الإطلاق.
  if (workOrder.kind === 'emergency' && !workOrder.incident_report_id) {
    // fireWebhook مفقود سابقًا هنا رغم أن 'work_order_created' مُدرَج أصلًا
    // كنوع حدث قابل للاختيار عند إنشاء ويبهوك (راجع EVENT_TYPES في
    // routes/webhooks.js) — أي ويبهوك يُضبط لهذا الحدث تحديدًا كان يستحيل
    // أن يُطلَق إطلاقًا مهما فعل المدير، خلافًا لكل الأحداث المشابهة الأخرى
    // في هذا الملف (work_order_assigned، work_order_completed) التي تستدعي
    // fireWebhook وnotifyEvent معًا دائمًا.
    fireWebhook('work_order_created', workOrder);
    notifyEvent('work_order_created', workOrder);
  }
});

// DELETE /api/work-orders/:id — حذف نهائي (لأعمال منجزة/مؤرشفة فقط عمليًا،
// الواجهة لا تعرض هذا الخيار إلا هناك) — قطع الغيار وسجلات LOTO المرتبطة
// تُحذف تلقائيًا معه (ON DELETE CASCADE غير مُعرَّف هنا، فنحذفها صراحة).
// قرار صريح: حذف نهائي يُحصر بمسؤول الصيانة أو المدير فقط، لا الفني — راجع
// requireRole(...MAINTENANCE_ROLES) القديم أدناه الذي كان يسمح للفني أيضًا.
// قرار صريح 2026-09-26: الحذف لم يعد مقصورًا على الأعمال المؤرشفة/المنجزة
// فقط (كان هذا مجرد قيد واجهة، لا قيد سيرفر أصلًا) — مسؤول الصيانة/المدير
// يقدر يحذف أي مهمة/أمر عمل بأي حالة الآن، مع إشعار جروب الصيانة والفنيين
// المعنيين بالحذف (لم يكن هناك أي إشعار على الحذف إطلاقًا من قبل).
router.delete('/:id', requireRole('maintenance_manager'), async (req, res) => {
  const { rows: woRows } = await pool.query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
  if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  const workOrder = woRows[0];

  // نجلب الفنيين المعنيين ونحرر حالتهم قبل الحذف — نفس منطق الإلغاء تمامًا
  // (كان يترك فنييه "مشغولين" للأبد بلا أي أمر عمل مرتبط بهم بعد الحذف).
  const technicians = await getWorkOrderTechnicians(req.params.id);
  const technicianIdsToFree = technicians.length > 0
    ? technicians.map((t) => t.id)
    : (workOrder.assigned_technician_id ? [workOrder.assigned_technician_id] : []);
  for (const techId of technicianIdsToFree) {
    await pool.query("UPDATE technicians SET status = 'available' WHERE id = $1", [techId]);
  }

  await pool.query('DELETE FROM spare_parts_used WHERE work_order_id = $1', [req.params.id]);
  await pool.query('DELETE FROM loto_logs WHERE work_order_id = $1', [req.params.id]);
  await pool.query('DELETE FROM work_order_technicians WHERE work_order_id = $1', [req.params.id]);
  const { rowCount } = await pool.query('DELETE FROM work_orders WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  res.json({ ok: true });

  const enriched = { ...workOrder, technicians, deleted_by: req.user.name };
  fireWebhook('work_order_deleted', enriched);
  notifyEvent('work_order_deleted', enriched);
});

// PATCH /api/work-orders/:id — تعديل بيانات المهمة/البلاغ الأساسية (الوصف،
// الموقع، كود/اسم المعدة، نوع المهمة داخلية/خارجية) بعد الإنشاء — قرار صريح
// 2026-09-26 (لم تكن هذه القدرة موجودة إطلاقًا من قبل، فقط الإنشاء لمرة
// واحدة). مقصور على مسؤول الصيانة/المدير كباقي عمليات الإدارة في هذا الملف.
// كل حقل اختياري ويُحدَّث فقط لو أُرسل فعليًا (COALESCE) — تعديل جزئي مسموح.
router.patch('/:id', requireRole('maintenance_manager'), async (req, res) => {
  const { description, facility, equipmentName, equipmentCode, taskScope } = req.body;
  if (taskScope !== undefined && taskScope !== null && !['internal', 'external'].includes(taskScope)) {
    return res.status(400).json({ error: 'نوع المهمة غير صحيح' });
  }
  const { rows } = await pool.query(
    `UPDATE work_orders SET
       description = COALESCE($1, description),
       facility = COALESCE($2, facility),
       equipment_name = COALESCE($3, equipment_name),
       equipment_code = COALESCE($4, equipment_code),
       task_scope = COALESCE($5, task_scope)
     WHERE id = $6 RETURNING *`,
    [
      description ? String(description).trim() : null,
      facility ? String(facility).trim() : null,
      equipmentName ? String(equipmentName).trim() : null,
      equipmentCode ? String(equipmentCode).trim() : null,
      taskScope || null,
      req.params.id,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  const workOrder = rows[0];
  await attachNotesCountToOne(workOrder);
  res.json({ workOrder });

  getWorkOrderTechnicians(req.params.id)
    .then((technicians) => {
      const enriched = { ...workOrder, technicians, updated_by: req.user.name };
      fireWebhook('work_order_updated', enriched);
      notifyEvent('work_order_updated', enriched);
    })
    .catch((err) => {
      console.error('تعذّر جلب قائمة الفنيين لإثراء إشعار التعديل:', err.message);
      fireWebhook('work_order_updated', { ...workOrder, updated_by: req.user.name });
      notifyEvent('work_order_updated', { ...workOrder, updated_by: req.user.name });
    });
});

// DELETE /api/work-orders/:id/technicians/:techId — إزالة فني واحد بعينه من
// أمر عمل قائم (بعكس /assign الذي يُضيف فقط ولا يقدر يزيل أحدًا) — قرار صريح
// 2026-09-26: "تغيير الفنيين" يعني إزالة من أُسند بالخطأ ثم إضافة غيره عبر
// /assign العادي، لا استبدالًا دفعة واحدة. مقصور على مسؤول الصيانة/المدير.
// الفني المُزال يعود "متاح" فورًا — إلا لو كان مُسنَدًا فعليًا لأمر عمل آخر
// مفتوح غير هذا (نفس منطق تسوية الحالة في migrate-technician-status-reconcile.js)،
// فيبقى "مشغول" بحق. لو كان "الفني الأساسي" (assigned_technician_id) نُسنِد
// الأساسي لأول فني متبقٍ، أو نُعيد الأمر لـ"بانتظار التعيين" لو لم يبقَ أحد.
router.delete('/:id/technicians/:techId', requireRole('maintenance_manager'), async (req, res) => {
  const { id, techId } = req.params;

  const { rows: woRows } = await pool.query('SELECT * FROM work_orders WHERE id = $1', [id]);
  if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  const workOrder = woRows[0];

  const { rows: techRows } = await pool.query('SELECT id, name, phone, user_id FROM technicians WHERE id = $1', [techId]);
  if (techRows.length === 0) return res.status(404).json({ error: 'الفني غير موجود' });
  const removedTechnician = techRows[0];

  const { rowCount } = await pool.query(
    'DELETE FROM work_order_technicians WHERE work_order_id = $1 AND technician_id = $2',
    [id, techId]
  );
  if (rowCount === 0 && String(workOrder.assigned_technician_id) !== String(techId)) {
    return res.status(400).json({ error: 'هذا الفني غير مُسنَد لهذا الأمر أصلًا' });
  }

  const remaining = await getWorkOrderTechnicians(id);
  const newPrimaryId = remaining.length > 0 ? remaining[0].id : null;
  const newStatus = newPrimaryId ? workOrder.status : 'pending_assignment';
  const { rows: updatedRows } = await pool.query(
    `UPDATE work_orders SET assigned_technician_id = $1, status = $2 WHERE id = $3 RETURNING *`,
    [newPrimaryId, newStatus, id]
  );

  // تحرير الفني المُزال — إلا لو كان مُسنَدًا فعليًا لأمر عمل آخر مفتوح غيره.
  const { rows: otherOpenRows } = await pool.query(
    `SELECT 1 FROM work_orders wo
      WHERE wo.status NOT IN ('completed', 'cancelled') AND wo.id != $1
        AND (wo.assigned_technician_id = $2
             OR EXISTS (SELECT 1 FROM work_order_technicians wot WHERE wot.work_order_id = wo.id AND wot.technician_id = $2))
      LIMIT 1`,
    [id, techId]
  );
  if (otherOpenRows.length === 0) {
    await pool.query("UPDATE technicians SET status = 'available' WHERE id = $1", [techId]);
  }

  const workOrder2 = updatedRows[0];
  await attachNotesCountToOne(workOrder2);
  res.json({ workOrder: workOrder2 });

  const enriched = {
    ...workOrder2,
    removed_technician_name: removedTechnician.name,
    removed_technician_phone: removedTechnician.phone,
    removed_technician_user_id: removedTechnician.user_id,
  };
  fireWebhook('work_order_technician_removed', enriched);
  notifyEvent('work_order_technician_removed', enriched);
});

// GET /api/work-orders/:id/technicians — قائمة الفنيين المُسنَدين لأمر عمل
// معيّن (معرّف/اسم/جوال كل واحد على حدة) — تُستخدم فقط من شاشة "تعديل
// المهمة" (لإتاحة إزالة فني بعينه بمعرّفه)، بعكس technician_names الجاهز في
// LIST_QUERY أعلاه وهو نص عرض مُدمَج بلا معرّفات. مقصور على مسؤول الصيانة/
// المدير مثل باقي عمليات التعديل، قرار صريح 2026-09-26.
router.get('/:id/technicians', requireRole('maintenance_manager'), async (req, res) => {
  const { rows: woRows } = await pool.query('SELECT id FROM work_orders WHERE id = $1', [req.params.id]);
  if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  const technicians = await getWorkOrderTechnicians(req.params.id);
  res.json({ technicians });
});

// PATCH /api/work-orders/:id/assign — تعيين فني واحد أو أكثر لنفس أمر العمل
// (technicianIds: مصفوفة — الأحدث والموصى به)، مع دعم الصيغة القديمة
// technicianId (فني واحد) للتوافق مع أي نسخة تطبيق لم تُحدَّث بعد.
// مسؤول المخزون (inventory_manager) والمصمم (designer) عمدًا غير مضافين هنا
// (قرار صريح 2026-10-03: رفضتم تحديدًا إعطائهما صلاحية "إضافة فني آخر" لأي
// مهمة — فقط استلام مهامهما وإنجازها، راجع /:id/status و/:id/close تحت).
// قرار صريح 2026-10-05: التعيين (إضافة أي فني لأي مهمة) مقصور الآن على مسؤول
// الصيانة (maintenance_manager) والمدير (admin) فقط — الفني العادي
// (maintenance_technician) لا يقدر يعيّن ولا يضيف فنيًا لنفسه أو لغيره إطلاقًا،
// تمامًا مثل الحذف والتعديل وإزالة فني (كلها مقصورة على المسؤول أعلاه).
router.patch('/:id/assign', requireRole('maintenance_manager'), (req, res) =>
  // قفل لكل أمر عمل: طلبا تعيين متزامنان لنفس الأمر يُنفَّذان بالتتابع، فالثاني
  // يرى أن الفني مُسنَد فعلًا ولا يُرسل "قبول الطلب" مرة ثانية.
  withLock(`wo-assign:${req.params.id}`, () => assignWorkOrder(req, res))
);

async function assignWorkOrder(req, res) {
  const { technicianId, technicianIds } = req.body;
  const ids = Array.isArray(technicianIds) && technicianIds.length > 0
    ? Array.from(new Set(technicianIds.map(String)))
    : (technicianId ? [String(technicianId)] : []);
  if (ids.length === 0) return res.status(400).json({ error: 'اختيار فني واحد على الأقل إلزامي' });

  // ملاحظة المشرف أثناء التعيين (اختيارية، طلب 2026-10-07): تُحفظ مع سجل
  // ملاحظات المهمة، وتصل ضمن رسالة التعيين نفسها (جروب الصيانة + الفني) بدل
  // رسالة منفصلة — راجع الحالة 'work_order_assigned' في services/notifications.js.
  const assignNote = String((req.body && req.body.note) ?? '').trim();
  if (assignNote.length > NOTE_MAX_LENGTH) {
    return res.status(400).json({ error: `الملاحظة طويلة جدًا — الحد الأقصى ${NOTE_MAX_LENGTH} حرف` });
  }

  const woRes = await pool.query('SELECT requires_loto, status, assigned_technician_id FROM work_orders WHERE id = $1', [req.params.id]);
  if (woRes.rows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  // أمر منتهٍ (مُنجز/ملغى) لا يُعاد فتحه بالخطأ عبر ضغطة تعيين متأخرة أو مكررة —
  // كان UPDATE أدناه يرجعه "قيد التنفيذ" ويُعيد إرسال إشعارات التعيين.
  if (woRes.rows[0].status === 'completed' || woRes.rows[0].status === 'cancelled') {
    return res.status(409).json({
      error: woRes.rows[0].status === 'completed'
        ? 'هذا الأمر أُنجز بالفعل — لا يمكن تعيين فني عليه'
        : 'هذا الأمر ملغى — لا يمكن تعيين فني عليه',
    });
  }
  const nextStatus = woRes.rows[0].requires_loto ? 'waiting_loto' : 'in_progress';

  // الفاصل الملزم فعليًا: التطبيق (FilterChip في شاشات إنشاء أمر عمل/مهمة
  // جديدة) لم يكن يتحقق إطلاقًا من حالة الفني قبل هذا التعديل، فيسهل تعيين
  // فني مشغول فعليًا بأمر آخر أو في إجازة بالخطأ — شكوى العميل 2026-09-26.
  // نتحقق هنا من كل فني في القائمة: إما أنه "متاح" فعلًا الآن، أو أنه أصلًا
  // مُسنَد لنفس أمر العمل هذا تحديدًا (إعادة إرسال/تعيين إضافي لا يغيّر شيئًا
  // في حالته فلا داعي لمنعه). أي فني آخر غير متاح يُرفض التعيين كاملًا برسالة
  // توضّح مَن وبأي سبب (مشغول/إجازة) بدل قبول تعيين جزئي مربك.
  const { rows: alreadyOnOrderRows } = await pool.query(
    'SELECT technician_id FROM work_order_technicians WHERE work_order_id = $1',
    [req.params.id]
  );
  const alreadyOnThisOrder = new Set(alreadyOnOrderRows.map((r) => String(r.technician_id)));
  // أول تعيين فني لهذا الأمر (لم يكن عليه أي فني قبل هذا الطلب) = لحظة "قبول
  // الصيانة" فعليًا لبلاغ الإنتاج. نحسبه هنا قبل أي INSERT أدناه حتى لا تصل
  // رافع البلاغ رسالة جديدة كلما أُضيف فني آخر لنفس الأمر لاحقًا.
  const isFirstAssignment = alreadyOnOrderRows.length === 0;

  // الطلب نفسه وصل مرة ثانية (ضغطتان سريعتان، أو إعادة إرسال من التطبيق بعد
  // بطء الشبكة): كل الفنيين المطلوبين مُسنَدون فعلًا، والفني الأساسي لم يتغيّر،
  // ولا ملاحظة جديدة. لا نعدّل شيئًا ولا نُرسل أي إشعار — نعيد الحالة الحالية.
  const newTechIds = ids.filter((tid) => !alreadyOnThisOrder.has(tid));
  if (newTechIds.length === 0 && ids[0] === String(woRes.rows[0].assigned_technician_id)) {
    let noteIsRepeat = !assignNote;
    if (assignNote) {
      try {
        if (await ensureNotesTable()) {
          const dupNote = await pool.query(
            `SELECT 1 FROM work_order_notes
              WHERE work_order_id = $1 AND note = $2 AND author_user = $3
                AND created_at > now() - interval '2 minutes' LIMIT 1`,
            [req.params.id, assignNote, req.user.id]
          );
          noteIsRepeat = dupNote.rows.length > 0;
        }
      } catch (err) {
        console.error('تعذّر فحص تكرار ملاحظة التعيين:', err.message);
      }
    }
    if (noteIsRepeat) {
      const { rows: sameRows } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [req.params.id]);
      await attachNotesCountToOne(sameRows[0]);
      return res.json({ workOrder: sameRows[0], alreadyAssigned: true });
    }
  }
  const { rows: statusRows } = await pool.query(
    'SELECT id, name, status FROM technicians WHERE id = ANY($1::bigint[])',
    [ids]
  );
  const STATUS_LABELS = { busy: 'مشغول', on_leave: 'في إجازة' };
  const blocked = statusRows.filter(
    (t) => t.status !== 'available' && !alreadyOnThisOrder.has(String(t.id))
  );
  if (blocked.length > 0) {
    const names = blocked.map((t) => `${t.name} (${STATUS_LABELS[t.status] || t.status})`).join('، ');
    return res.status(409).json({ error: `تعذّر التعيين — غير متاح حاليًا: ${names}` });
  }

  // assigned_technician_id يبقى "الفني الأساسي" (أول فني في القائمة) — أي
  // كود/تقرير قديم يعتمد على هذا العمود الوحيد يستمر بالعمل بلا تغيير.
  // من قام بالتعيين: آخر شخص أضاف فنيًا لهذا الأمر (يتبدّل مع كل تعيين جديد،
  // تمامًا كما يتبدّل assigned_at).
  const hasAssignedBy = await ensureAssignedByColumns();
  const { rows } = hasAssignedBy
    ? await pool.query(
        `UPDATE work_orders SET assigned_technician_id = $1, assigned_at = now(),
           started_at = COALESCE(started_at, CASE WHEN $2 = 'in_progress' THEN now() END), status = $2,
           assigned_by = $4, assigned_by_user = $5
         WHERE id = $3 RETURNING *`,
        [ids[0], nextStatus, req.params.id, req.user.name || null, req.user.id || null]
      )
    : await pool.query(
        `UPDATE work_orders SET assigned_technician_id = $1, assigned_at = now(),
           started_at = COALESCE(started_at, CASE WHEN $2 = 'in_progress' THEN now() END), status = $2
         WHERE id = $3 RETURNING *`,
        [ids[0], nextStatus, req.params.id]
      );

  for (const techId of ids) {
    await pool.query(
      `INSERT INTO work_order_technicians (work_order_id, technician_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, techId]
    );
    await pool.query("UPDATE technicians SET status = 'busy' WHERE id = $1", [techId]);
  }

  // حفظ ملاحظة التعيين في سجل الملاحظات. فشلها لا يُفشل التعيين (نجح فعلًا)،
  // وتبقى الملاحظة مع ذلك في رسالة الإشعار أدناه.
  if (assignNote) {
    try {
      if (await ensureNotesTable()) {
        await pool.query(
          `INSERT INTO work_order_notes (work_order_id, note, author_name, author_user, work_order_status)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, assignNote, req.user.name || null, req.user.id || null, nextStatus]
        );
      }
    } catch (err) {
      console.error('تعذّر حفظ ملاحظة التعيين:', err.message);
    }
  }

  const { rows: listedRows } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [req.params.id]);
  const workOrder = listedRows[0] || rows[0];
  await attachNotesCountToOne(workOrder);
  res.json({ workOrder });
  // نُرفق كل الفنيين المُسنَد إليهم (اسم/جوال/حساب المستخدم المرتبط لكل
  // واحد) ضمن حمولة الويبهوك — يسمح بإشعار كل فني شخصيًا، وليس فقط جروب
  // الصيانة العام. هذا بعد إرسال الاستجابة عمدًا وبكتلة try/catch خاصة به،
  // حتى لا يفشل تعيين الفني (وقد نجح فعلًا) لمجرد تعذّر جلب بيانات الإثراء.
  getWorkOrderTechnicians(req.params.id)
    .then(async (technicians) => {
      // أمر عمل ناتج عن بلاغ إنتاج وهذا أول تعيين فني له: نُرفق رافع البلاغ
      // الأصلي ليصله إشعار "تم قبول بلاغك" شخصيًا (راجع notifyEvent الحالة
      // 'work_order_assigned' في services/notifications.js). فشل جلبه لا يمنع
      // باقي الإشعارات (جروب الصيانة والفنيين).
      let reporter = null;
      if (isFirstAssignment && workOrder.incident_report_id) {
        try {
          reporter = await getIncidentReporter(workOrder.incident_report_id);
        } catch (err) {
          console.error('تعذّر جلب رافع البلاغ الأصلي لإشعار قبول البلاغ:', err.message);
        }
      }
      const enriched = {
        ...workOrder,
        technicians,
        technician_phone: technicians[0]?.phone || null,
        technician_name: technicians[0]?.name || null,
        notify_incident_reporter: Boolean(reporter),
        incident_reporter_name: reporter?.reported_by || null,
        incident_reporter_user: reporter?.reported_by_user || null,
        incident_reporter_phone: reporter?.phone || null,
        assignment_note: assignNote || null,
        // الرسالة الشخصية "تم إسناد أمر عمل لك" تصل فقط للفنيين المُضافين الآن —
        // لا تُعاد لمن أُسند له الأمر سابقًا (كانت تتكرر لكل فني قديم عند إضافة
        // فني جديد). مع ملاحظة مشرف جديدة تصل للجميع لأنها معلومة جديدة لهم.
        new_technician_ids: assignNote ? null : newTechIds,
      };
      fireWebhook('work_order_assigned', enriched);
      notifyEvent('work_order_assigned', enriched);
    })
    .catch((err) => {
      console.error('تعذّر جلب قائمة الفنيين لإثراء الويبهوك:', err.message);
      const fallback = { ...workOrder, assignment_note: assignNote || null, new_technician_ids: assignNote ? null : newTechIds };
      fireWebhook('work_order_assigned', fallback);
      notifyEvent('work_order_assigned', fallback);
    });
}

// GET /api/work-orders/:id/notes — كل ملاحظات المشرف على مهمة معيّنة (الأحدث
// أولًا). يقرؤها مسؤول الصيانة/المدير دائمًا، والفني (ومسؤول المخزون/المصمم
// المكلَّفان) فقط لو كان مُسنَدًا لهذه المهمة فعليًا — نفس قيد /status و/close.
router.get('/:id/notes', requireRole(...MAINTENANCE_ROLES, 'inventory_manager', 'designer'), async (req, res) => {
  const { rows: woRows } = await pool.query(
    'SELECT id, assigned_technician_id FROM work_orders WHERE id = $1',
    [req.params.id]
  );
  if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });

  if (req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    const mine = await userIsAssignedTechnician(req.user.id, req.params.id, woRows[0].assigned_technician_id);
    if (!mine) {
      return res.status(403).json({ error: 'هذا الأمر غير مُسنَد إليك — لا يرى ملاحظاته إلا الفني المُسنَد له أو مسؤول الصيانة' });
    }
  }

  if (!(await ensureNotesTable())) return res.json({ notes: [] });
  const { rows } = await pool.query(
    `SELECT id, work_order_id, note, author_name, work_order_status, created_at
       FROM work_order_notes
      WHERE work_order_id = $1
      ORDER BY created_at DESC, id DESC`,
    [req.params.id]
  );
  res.json({ notes: rows });
});

// POST /api/work-orders/:id/notes — إضافة ملاحظة من المشرف على مهمة مُسنَدة
// لفني، سواء كانت قيد التنفيذ أو منجزة. مقصورة على مسؤول الصيانة والمدير فقط
// (requireRole('maintenance_manager') يمرّر admin تلقائيًا) — الفني لا يضيف
// ملاحظات، فقط يقرؤها. بعد الحفظ تُرسَل الملاحظة لجروب الصيانة على واتساب،
// ولكل فني على المهمة (واتساب شخصي + إشعار داخل التطبيق + Push) — راجع الحالة
// 'work_order_note_added' في services/notifications.js. مهمة "بانتظار التعيين"
// (لم يُسنَد لها فني بعد) ترفض الملاحظة لأنه لا يوجد فني يستلمها.
router.post('/:id/notes', requireRole('maintenance_manager'), async (req, res) => {
  const note = String((req.body && req.body.note) ?? '').trim();
  if (!note) return res.status(400).json({ error: 'نص الملاحظة إلزامي' });
  if (note.length > NOTE_MAX_LENGTH) {
    return res.status(400).json({ error: `الملاحظة طويلة جدًا — الحد الأقصى ${NOTE_MAX_LENGTH} حرف` });
  }

  const { rows: woRows } = await pool.query('SELECT id, status FROM work_orders WHERE id = $1', [req.params.id]);
  if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
  const woStatus = woRows[0].status;
  if (woStatus === 'new' || woStatus === 'pending_assignment') {
    return res.status(400).json({ error: 'هذه المهمة لم تُسنَد لفني بعد — الملاحظات تُضاف على المهام المُسنَدة فقط' });
  }

  if (!(await ensureNotesTable())) {
    return res.status(500).json({ error: 'تعذّر تجهيز جدول الملاحظات على السيرفر، حاول مرة أخرى بعد قليل' });
  }

  const authorName = req.user.name || null;
  // نفس الملاحظة من نفس المشرف على نفس المهمة خلال نصف دقيقة = ضغطة مكررة:
  // لا تُحفظ مرتين ولا تُرسل للجروب والفنيين مرتين. القفل يمنع مرور طلبين معًا.
  const noteResult = await withLock(`wo-note:${req.params.id}:${req.user.id}`, async () => {
    const dup = await pool.query(
      `SELECT id, work_order_id, note, author_name, work_order_status, created_at FROM work_order_notes
        WHERE work_order_id = $1 AND note = $2 AND author_user = $3
          AND created_at > now() - interval '30 seconds'
        ORDER BY id DESC LIMIT 1`,
      [req.params.id, note, req.user.id]
    );
    if (dup.rows.length > 0) return { duplicate: dup.rows[0] };
    const ins = await pool.query(
      `INSERT INTO work_order_notes (work_order_id, note, author_name, author_user, work_order_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, work_order_id, note, author_name, work_order_status, created_at`,
      [req.params.id, note, authorName, req.user.id || null, woStatus]
    );
    return { inserted: ins.rows[0] };
  });
  if (noteResult.duplicate) {
    const { rows: dupCount } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM work_order_notes WHERE work_order_id = $1',
      [req.params.id]
    );
    return res.status(201).json({ note: noteResult.duplicate, notesCount: Number(dupCount[0]?.n || 0), duplicate: true });
  }
  const inserted = noteResult.inserted;
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM work_order_notes WHERE work_order_id = $1',
    [req.params.id]
  );
  res.status(201).json({ note: inserted, notesCount: Number(countRows[0]?.n || 0) });

  // الإشعارات بعد إرسال الاستجابة عمدًا وبكتلة try/catch خاصة بها — الملاحظة
  // حُفظت فعلًا، فلا يظهر للمشرف خطأ لمجرد تعذّر جلب بيانات الإثراء أو الإرسال.
  (async () => {
    let technicians = [];
    try {
      technicians = await getWorkOrderTechnicians(req.params.id);
    } catch (err) {
      console.error('تعذّر جلب فنيي المهمة لإشعار الملاحظة:', err.message);
    }
    let workOrder = {};
    try {
      const { rows: listed } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [req.params.id]);
      workOrder = listed[0] || {};
    } catch (err) {
      console.error('تعذّر جلب بيانات المهمة لإشعار الملاحظة:', err.message);
    }
    const enriched = {
      id: inserted.work_order_id,
      status: woStatus,
      ...workOrder,
      technicians,
      note_id: inserted.id,
      note_text: note,
      note_author: authorName,
    };
    fireWebhook('work_order_note_added', enriched);
    notifyEvent('work_order_note_added', enriched);
  })().catch((err) => {
    console.error('تعذّر إرسال إشعارات ملاحظة المشرف:', err.message);
  });
});

// PATCH /api/work-orders/:id/status — تحديث الحالة يدويًا (بانتظار قطع غيار، بدء التنفيذ بعد LOTO...)
// مسموح أيضًا لمسؤول المخزون (inventory_manager) والمصمم (designer) — قرار
// 2026-10-03 — حتى يقدرا يحدّثا حالة أمر مُسنَد إليهما فعليًا (مثل "بدء
// التنفيذ") تمامًا كالفني العادي.
router.patch('/:id/status', requireRole(...MAINTENANCE_ROLES, 'inventory_manager', 'designer'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending_assignment', 'waiting_loto', 'in_progress', 'waiting_parts', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  // قرار صريح 2026-10-05: الفني (ومسؤول المخزون والمصمم) لا يعدّل المهمة ولا
  // يلغيها إطلاقًا. المسموح لهم فقط تقدّم العمل الفعلي على أمر مُسنَد إليهم:
  // "قيد التنفيذ" و"بانتظار قطع غيار". أما الإلغاء (وهو عمليًا حذف المهمة من
  // القائمة النشطة) وإعادتها لـ"بانتظار التعيين" أو "بانتظار LOTO" فمقصورة على
  // مسؤول الصيانة/المدير. ولا يقدر غيرهما يحرّك أمرًا مُنجَزًا/مُلغى مرة أخرى،
  // ولا أمرًا غير مُسنَد إليه (نفس قيد /close أدناه).
  if (req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    if (!['in_progress', 'waiting_parts'].includes(status)) {
      return res.status(403).json({ error: 'إلغاء أمر العمل أو إعادته للانتظار متاح فقط لمسؤول الصيانة' });
    }
    const { rows: curRows } = await pool.query(
      'SELECT status, assigned_technician_id FROM work_orders WHERE id = $1',
      [req.params.id]
    );
    if (curRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
    if (curRows[0].status === 'completed' || curRows[0].status === 'cancelled') {
      return res.status(403).json({ error: 'لا يمكن تعديل أمر عمل منتهٍ — يتم ذلك فقط عبر مسؤول الصيانة' });
    }
    const mine = await userIsAssignedTechnician(req.user.id, req.params.id, curRows[0].assigned_technician_id);
    if (!mine) {
      return res.status(403).json({ error: 'هذا الأمر غير مُسنَد إليك — لا يقدر يغيّر حالته إلا الفني المُسنَد له أو مسؤول الصيانة' });
    }
  }

  const { rows } = await pool.query(
    `UPDATE work_orders SET status = $1, started_at = COALESCE(started_at, CASE WHEN $1 = 'in_progress' THEN now() END)
     WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });

  // إلغاء أمر العمل (cancelled) كان يترك كل الفني/الفنيين المُسنَدين إليه
  // "مشغولين" (status = 'busy') إلى الأبد — /:id/close وحده كان يُعيدهم
  // "متاح" عند الإنجاز، فإن أُلغي الأمر بدل إنجازه (خطأ إدخال، تكرار...) لا
  // ينفَّذ /close إطلاقًا فتتراكم حالات "مشغول" الوهمية بلا أي عمل فعلي وراءها
  // حتى يظهر أغلب/كل الفنيين "غير متاحين" رغم فراغهم الفعلي — بالضبط شكوى
  // العميل 2026-09-26. نُحرر هنا بنفس منطق /close تمامًا عند الإلغاء تحديدًا؛
  // بقية الحالات المسموحة أعلاه لا تُغيّر تعيين الفني فتبقى كما هي.
  if (status === 'cancelled') {
    const workOrder = rows[0];
    const { rows: techRows } = await pool.query(
      'SELECT technician_id FROM work_order_technicians WHERE work_order_id = $1',
      [workOrder.id]
    );
    const technicianIdsToFree = techRows.length > 0
      ? techRows.map((r) => r.technician_id)
      : (workOrder.assigned_technician_id ? [workOrder.assigned_technician_id] : []);
    for (const techId of technicianIdsToFree) {
      await pool.query("UPDATE technicians SET status = 'available' WHERE id = $1", [techId]);
    }
    // أي باتشات إنتاج مربوطة بهذا الأمر تُحدَّث فورًا لتجميد دقائق التوقف عند
    // لحظة الإلغاء (وليست ناقصة أو مستمرة الحساب لأمر أُلغي فعليًا) — راجع
    // services/batchWorkOrderLink.js. fire-and-forget عمدًا حتى لا يتأخر رد
    // الإلغاء نفسه بانتظار تحديث كل باتش مرتبط.
    recomputeLinkedBatches(workOrder.id);
  }

  await attachNotesCountToOne(rows[0]);
  res.json({ workOrder: rows[0] });
});

// PATCH /api/work-orders/:id/close — إنجاز أمر العمل نهائيًا + تسجيل قطع الغيار
// مقيّد: يقدر يكتب "جاهز"/يُنجز الأمر فقط الفني (أو أحد الفنيين) المُسنَد إليه
// هذا الأمر تحديدًا — عبر work_order_technicians (تعيين متعدد فنيين) أو
// assigned_technician_id (توافق مع أوامر أُسندت قبل دعم تعدد الفنيين). مسؤول
// الصيانة (maintenance_manager) والمدير (admin) يبقيان يقدران يُنجزان أي أمر
// عمل بلا قيد، كإشراف عام على عمل الفنيين. مسموح أيضًا لمسؤول المخزون
// (inventory_manager) والمصمم (designer) — قرار 2026-10-03 — بنفس القيد
// تمامًا (لا يقدران ينجزا إلا أمرًا مُسنَدًا إليهما فعليًا)، عبر
// userIsAssignedTechnician أدناه التي تعمل تلقائيًا بمجرد ربط حسابهما بجدول
// الفنيين (راجع ensureTechnicianForUser في routes/users.js).
router.patch('/:id/close', requireRole(...MAINTENANCE_ROLES, 'inventory_manager', 'designer'), async (req, res) => {
  const { closeDescription, spareParts, closeNotes } = req.body;
  if (!closeDescription) return res.status(400).json({ error: 'وصف العمل المنجز إلزامي' });

  if (req.user.role !== 'admin' && req.user.role !== 'maintenance_manager') {
    const { rows: woRows } = await pool.query('SELECT assigned_technician_id FROM work_orders WHERE id = $1', [req.params.id]);
    if (woRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });

    const allowed = await userIsAssignedTechnician(req.user.id, req.params.id, woRows[0].assigned_technician_id);
    if (!allowed) {
      return res.status(403).json({ error: 'هذا الأمر غير مُسنَد إليك — لا يقدر يُنجزه إلا الفني المُسنَد له أو مسؤول الصيانة' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE work_orders SET status = 'completed', completed_at = now(), close_description = $1, close_notes = $2
       WHERE id = $3 AND status <> 'completed' RETURNING *`,
      [closeDescription.trim(), closeNotes ? String(closeNotes).trim() : null, req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      // إما الأمر غير موجود، أو أُنجز مسبقًا (ضغطة إنجاز مكررة/إعادة إرسال):
      // في الحالة الثانية لا نُسجّل قطع غيار مرة أخرى ولا نُحرّر فنيين صاروا على
      // مهام أخرى ولا نُرسل "تم الإنجاز" مرة ثانية — نعيد الأمر كما هو بنجاح.
      const { rows: currentRows } = await pool.query(`${LIST_QUERY} WHERE wo.id = $1`, [req.params.id]);
      if (currentRows.length === 0) return res.status(404).json({ error: 'أمر العمل غير موجود' });
      await attachNotesCountToOne(currentRows[0]);
      return res.json({ workOrder: currentRows[0], alreadyCompleted: true });
    }
    const workOrder = rows[0];

    for (const part of spareParts || []) {
      if (!part.partName) continue;
      await client.query(
        'INSERT INTO spare_parts_used (work_order_id, part_name, quantity, unit_cost) VALUES ($1, $2, $3, $4)',
        [workOrder.id, part.partName, part.quantity || 1, part.unitCost || 0]
      );
    }

    // إعادة كل الفنيين المُسنَد إليهم أمر العمل (وليس "الفني الأساسي" فقط)
    // إلى حالة "متاح" — يدعم الآن تعيين أكثر من فني لنفس أمر العمل.
    const { rows: techRows } = await client.query(
      'SELECT technician_id FROM work_order_technicians WHERE work_order_id = $1',
      [workOrder.id]
    );
    const technicianIdsToFree = techRows.length > 0
      ? techRows.map((r) => r.technician_id)
      : (workOrder.assigned_technician_id ? [workOrder.assigned_technician_id] : []);
    for (const techId of technicianIdsToFree) {
      await client.query("UPDATE technicians SET status = 'available' WHERE id = $1", [techId]);
    }
    if (workOrder.incident_report_id) {
      await client.query(
        "UPDATE incident_reports SET downtime_ended_at = COALESCE(downtime_ended_at, now()), status = 'closed' WHERE id = $1",
        [workOrder.incident_report_id]
      );
    }

    await client.query('COMMIT');
    await attachNotesCountToOne(workOrder);
    res.json({ workOrder });
    // نفس منطق تجميد التوقف عند الإلغاء أعلاه (/:id/status)، هنا عند الإنجاز
    // الفعلي — يصل لكل باتش مربوط الوقت الحقيقي الدقيق لنهاية التوقف (وقت
    // إغلاق البلاغ إن وُجد، وإلا لحظة إغلاق أمر العمل نفسه). بعد إرسال
    // الاستجابة عمدًا وبلا انتظار، حتى لا يتأخر رد إغلاق أمر العمل بانتظار
    // تحديث كل باتش مرتبط به.
    recomputeLinkedBatches(workOrder.id);
    // نُرفق رقم مُنشئ أمر العمل الشخصي، اسم الخط/القسم، وكل الفنيين الذين
    // عملوا عليه ضمن حمولة الويبهوك — بعد إرسال الاستجابة عمدًا وبكتلة
    // try/catch خاصة بها، حتى لا يظهر للمستخدم خطأ في إغلاق أمر العمل (وقد
    // نجح ونُحفظ فعلًا) لمجرد تعذّر جلب بيانات الإثراء.
    (async () => {
      let createdByPhone = null;
      let lineName = null;
      if (workOrder.created_by_user) {
        try {
          const creatorRes = await pool.query('SELECT phone FROM users WHERE id = $1', [workOrder.created_by_user]);
          createdByPhone = creatorRes.rows[0]?.phone || null;
        } catch (err) {
          console.error('تعذّر جلب رقم منشئ أمر العمل لإثراء الويبهوك:', err.message);
        }
      }
      if (workOrder.line_id) {
        try {
          const lineRes = await pool.query('SELECT name FROM production_lines WHERE id = $1', [workOrder.line_id]);
          lineName = lineRes.rows[0]?.name || null;
        } catch (err) {
          console.error('تعذّر جلب اسم الخط لإثراء الويبهوك:', err.message);
        }
      }
      let technicians = [];
      try {
        technicians = await getWorkOrderTechnicians(workOrder.id);
      } catch (err) {
        console.error('تعذّر جلب قائمة الفنيين لإثراء الويبهوك:', err.message);
      }
      const enriched = { ...workOrder, created_by_phone: createdByPhone, line_name: lineName, technicians };
      fireWebhook('work_order_completed', enriched);
      notifyEvent('work_order_completed', enriched);
    })();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إغلاق أمر العمل' });
  } finally {
    client.release();
  }
});

// POST /api/work-orders/reports/request — تقرير صيانة احترافي بمدة مخصّصة،
// يُرسَل رابطه مباشرة عبر واتساب لرقم طالب التقرير نفسه فقط (وليس لجروب) —
// بنفس نمط POST /production/reports/request تمامًا (راجع routes/production.js
// و services/maintenanceReport.js).
// قرار صريح: يُحصر بمسؤول الصيانة أو المدير — لم يكن مقيَّدًا بأي دور إطلاقًا
// سابقًا (حتى مستخدم من قسم آخر تمامًا كان يقدر يطلبه عبر API مباشر).
router.post('/reports/request', requireRole('maintenance_manager'), async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'تاريخ البداية والنهاية إلزاميان' });

  try {
    const report = await generateMaintenanceReport({ from, to });

    fireWebhook('maintenance_report_custom', {
      from,
      to,
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
      `تقرير صيانة — بمدة مخصّصة\n` +
      `المدة: ${new Date(from).toLocaleDateString('ar-EG')} إلى ${new Date(to).toLocaleDateString('ar-EG')}\n` +
      `إجمالي البلاغات/الأوامر: ${report.totalCount}\n` +
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
    console.error('تعذّر إنشاء تقرير الصيانة المخصّص:', err);
    res.status(500).json({ error: 'تعذّر إنشاء التقرير، حاول مرة أخرى' });
  }
});

module.exports = router;
