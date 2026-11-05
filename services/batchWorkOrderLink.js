const { pool } = require('../config/db');

// ---------------------------------------------------------------------------
// ربط باتش الإنتاج بأمر صيانة فعلي (work_orders) — الميزة التي تحل الثغرة:
// "كيف سوف يسجل الباتش أنه تأخر بسبب الصيانة" (طلب العميل 2026-09-29).
// بدل إدخال المشرف لسبب/دقائق التوقف يدويًا، إن رُبط الباتش بأمر صيانة حقيقي
// (عبر عمود production_batches.work_order_id) تُحسَب حقول التوقف الثلاثة
// (has_stoppage / stoppage_reason / stoppage_minutes) تلقائيًا من بيانات ذلك
// الأمر نفسه — ومن بلاغ العطل المرتبط به (incident_reports) إن وُجد، لأنه
// يحمل التوقيت الحقيقي الدقيق لبداية التوقف (downtime_started_at)، وليس فقط
// وقت إنشاء أمر العمل الذي قد يتأخر قليلًا عن اللحظة الفعلية للعطل.
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  new: 'جديد',
  pending_assignment: 'بانتظار إسناد فني',
  waiting_loto: 'بانتظار عزل الطاقة (LOTO)',
  in_progress: 'قيد التنفيذ',
  waiting_parts: 'بانتظار قطع غيار',
  completed: 'أُنجز',
  cancelled: 'أُلغي',
};

// يجلب أمر العمل مع بيانات بلاغ العطل المرتبط به (إن وُجد) في استعلام واحد —
// نحتاج downtime_started_at/downtime_ended_at من incident_reports لأنها أدق
// من created_at/completed_at الخاصين بأمر العمل نفسه.
async function fetchWorkOrderForLink(workOrderId) {
  const { rows } = await pool.query(
    `SELECT wo.*, ir.downtime_started_at AS incident_started_at, ir.downtime_ended_at AS incident_ended_at
     FROM work_orders wo
     LEFT JOIN incident_reports ir ON ir.id = wo.incident_report_id
     WHERE wo.id = $1`,
    [workOrderId]
  );
  return rows[0] || null;
}

// يبحث عن أمر صيانة "بانتظار" ربط تلقائي بنفس رقم الباتش على نفس الخط —
// يحل ثغرة توقيت رفع البلاغ (وقت حدوث العطل فعليًا) مقابل تسجيل الباتش
// (يحدث لاحقًا، بعد معرفة كميته النهائية): مشرف الإنتاج يكتب "رقم الباتش
// المتوقع" عند رفع بلاغ العطل نفسه (يُنسَخ لأمر العمل عند تحويله — راجع
// routes/workOrders.js)، وحين يُسجَّل الباتش الحقيقي لاحقًا بنفس الرقم على
// نفس الخط بلا اختيار يدوي من قائمة الربط، يُستدعى هذا البحث فيربطه بنفسه.
// المقارنة نصية بعد إزالة المسافات وتوحيد حالة الأحرف، والأحدث يُفضَّل لو
// تعدّدت النتائج (نادر جدًا عمليًا). يُعيد null بصمت لو لم يوجد تطابق أو لو
// كانت المدخلات ناقصة — هذا اكتشاف تلقائي مساعد، وليس تحققًا إلزاميًا.
async function findAutoLinkWorkOrder(lineId, batchNumber) {
  if (!lineId || !batchNumber || !String(batchNumber).trim()) return null;
  const { rows } = await pool.query(
    `SELECT id FROM work_orders
     WHERE line_id = $1 AND lower(trim(expected_batch_number)) = lower(trim($2))
     ORDER BY created_at DESC LIMIT 1`,
    [lineId, String(batchNumber)]
  );
  return rows[0]?.id ?? null;
}

// يحسب حالة التوقف (وجود/سبب/دقائق) من بيانات أمر عمل واحد جاهز (كما يُعيده
// fetchWorkOrderForLink) — دالة حسابية بحتة، لا تقرأ ولا تكتب لقاعدة البيانات.
// - بداية التوقف: وقت بدء التوقف الفعلي المسجَّل في بلاغ العطل إن وُجد، وإلا
//   وقت إنشاء أمر العمل نفسه (لأمر وقائي/مهمة لا بلاغ عطل خلفه).
// - نهاية التوقف: وقت الإنجاز الفعلي لو اكتمل الأمر، وإلا اللحظة الحالية
//   (أفضل تقدير متاح لأمر لا يزال مفتوحًا أو أُلغي بلا عمود "وقت الإلغاء" في
//   قاعدة البيانات حاليًا) — يُعاد الحساب تلقائيًا لاحقًا عند إنجاز/إلغاء
//   الأمر فعليًا (راجع recomputeLinkedBatches أدناه) فتنعكس الأرقام النهائية
//   الدقيقة على كل باتش رُبط بهذا الأمر أثناء كان لا يزال مفتوحًا.
function computeStoppageFromWorkOrder(workOrder) {
  const startRaw = workOrder.incident_started_at || workOrder.created_at;
  const startDate = startRaw ? new Date(startRaw) : new Date();
  const endDate = workOrder.status === 'completed'
    ? new Date(workOrder.incident_ended_at || workOrder.completed_at || Date.now())
    : new Date();
  const minutes = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
  const statusLabel = STATUS_LABELS[workOrder.status] || workOrder.status;
  const equipmentPart = workOrder.equipment_name ? ` — ${workOrder.equipment_name}` : '';
  const descriptionPart = workOrder.description ? `: ${workOrder.description}` : '';
  const reason = `توقف بسبب أمر صيانة رقم #${workOrder.id}${equipmentPart} (${statusLabel})${descriptionPart}`;
  return { hasStoppage: true, stoppageReason: reason, stoppageMinutes: minutes };
}

// يُعيد حساب التوقف لكل الباتشات المرتبطة بأمر عمل معيّن — يُستدعى fire-and-
// forget (بلا انتظار/await من المتصل) فور إنجاز أو إلغاء أمر العمل، حتى تصل
// الأرقام "النهائية" الدقيقة لكل باتش رُبط بهذا الأمر بينما كان لا يزال
// مفتوحًا. كل تحديث يُسجَّل في production_batch_edits كأي تعديل يدوي تمامًا
// (بـ edited_by_name يوضّح أنه تلقائي) حتى يبقى قابلًا للمراجعة من شاشة سجل
// التعديلات نفسها بلا تمييز خاص بالواجهة.
async function recomputeLinkedBatches(workOrderId) {
  try {
    const workOrder = await fetchWorkOrderForLink(workOrderId);
    if (!workOrder) return;
    const { rows: batches } = await pool.query(
      'SELECT * FROM production_batches WHERE work_order_id = $1',
      [workOrderId]
    );
    if (batches.length === 0) return;
    const computed = computeStoppageFromWorkOrder(workOrder);
    for (const batch of batches) {
      const changes = {};
      if (Boolean(batch.has_stoppage) !== computed.hasStoppage) {
        changes.hasStoppage = { old: batch.has_stoppage, new: computed.hasStoppage };
      }
      if ((batch.stoppage_reason || '') !== (computed.stoppageReason || '')) {
        changes.stoppageReason = { old: batch.stoppage_reason, new: computed.stoppageReason };
      }
      // مقارنة نصية عمدًا (وليس رقمية مباشرة) — بعض عملاء Postgres الخفيفة قد
      // تُعيد أعمدة رقمية كنص، فتُسجَّل قيمة الدقائق نفسها كـ"تغيير" وهمي.
      if (String(batch.stoppage_minutes ?? '') !== String(computed.stoppageMinutes ?? '')) {
        changes.stoppageMinutes = { old: batch.stoppage_minutes, new: computed.stoppageMinutes };
      }
      if (Object.keys(changes).length === 0) continue;
      await pool.query(
        'UPDATE production_batches SET has_stoppage = $1, stoppage_reason = $2, stoppage_minutes = $3 WHERE id = $4',
        [computed.hasStoppage, computed.stoppageReason, computed.stoppageMinutes, batch.id]
      );
      await pool.query(
        `INSERT INTO production_batch_edits (batch_id, edited_by_user, edited_by_name, changes)
         VALUES ($1, NULL, $2, $3)`,
        [batch.id, 'تحديث تلقائي (عند تحديث أمر الصيانة المرتبط)', JSON.stringify(changes)]
      );
    }
  } catch (err) {
    console.error('تعذّر إعادة حساب توقف الباتشات المرتبطة بأمر العمل:', err.message);
  }
}

module.exports = {
  fetchWorkOrderForLink,
  computeStoppageFromWorkOrder,
  recomputeLinkedBatches,
  findAutoLinkWorkOrder,
  STATUS_LABELS,
};
