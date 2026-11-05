const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');

const router = new Router();
router.use(requireAuth, requireApproved);

// ============================================================================
// تقرير تحقيق إصابة العمل (QMS-SAF-007) — يطابق استمارة "تقرير تحقيق بالحادث"
// الورقية بخطواتها الخمس بالضبط (راجع تحليل الملف الأصلي: تحقيق الاصابة.docx).
// كل القوائم أدناه بالإنجليزية (snake_case) لتخزينها في القاعدة، والتسميات
// العربية المقابلة موجودة في تطبيق الجوال (lib/models/injury_report.dart) —
// يجب أن تبقى المفاتيح مطابقة حرفيًا بين الطرفين تمامًا كأسلوب OPERATION_TYPES
// في routes/safetyPermits.js.
// ============================================================================

const NATURE_OF_ACCIDENT = ['near_miss', 'injury_illness', 'fire', 'leakage', 'property_damage', 'vehicle_accident', 'explosion'];
const INJURY_TYPES = ['medical_treatment', 'first_aid', 'lost_time', 'fatality'];
const WORKDAY_PARTS = ['normal_activities', 'entering_leaving', 'meal_period', 'break', 'overtime', 'other'];
const PPE_USED_TYPES = ['helmet', 'safety_shoes', 'earplugs', 'earmuffs', 'glasses', 'face_protection', 'gloves', 'dust_mask', 'full_body_harness'];
const HIERARCHY_OF_CONTROL_TYPES = ['elimination', 'substitution', 'engineering_control', 'administrative_control', 'ppe'];
// الخطوة الثالثة: أسباب مخطط "عظم السمكة" (Fishbone) — ٣٦ سببًا مقسّمة على ٦
// فروع (راجع kFishboneBranches في lib/models/injury_report.dart بالتطبيق —
// يجب أن تبقى المفاتيح مطابقة حرفيًا هناك بنفس الترتيب).
const FISHBONE_CAUSE_TYPES = [
  'ind1_inattention_harassment', 'ind1_unsafe_speed', 'ind1_not_using_tools',
  'ind1_unsafe_act_other', 'ind1_not_following_instructions', 'ind1_other',
  'ind2_working_without_stopping', 'ind2_work_without_permit', 'ind2_not_trained',
  'ind2_no_loto', 'ind2_unsafe_lifting', 'ind2_unsafe_position',
  'ind3_wrong_way_use', 'ind3_damaged_equipment', 'ind3_no_ppe',
  'ind3_work_under_pressure', 'ind3_excessive_confidence', 'ind3_lack_awareness',
  'env_housekeeping', 'env_lighting', 'env_workstation_layout',
  'env_humidity_temp', 'env_ventilation', 'env_instructions_insufficient',
  'method_supervision', 'method_overload', 'method_time',
  'method_instruction_unclear', 'method_instruction_unavailable', 'method_instruction_insufficient',
  'equip_lack_tools', 'equip_maintenance', 'equip_inappropriate_damaged',
  'equip_danger_to_employees', 'equip_guards_poor', 'equip_unclear_controls',
];
const PREVENTION_CHANGE_TYPES = [
  'stop_activity', 'guard_hazard', 'train_employees', 'train_supervisors', 'redesign_task',
  'redesign_workstation', 'new_policy', 'enforce_policy', 'routine_inspection', 'use_ppe', 'other',
];
const BODY_PARTS = [
  'head', 'face', 'eye', 'neck', 'shoulder', 'arm', 'elbow', 'wrist', 'hand_fingers',
  'chest', 'back', 'abdomen', 'pelvis', 'thigh', 'knee', 'leg', 'ankle', 'foot_toes', 'other',
];
// جهة الإصابة من الجسم (أمامي/خلفي) — اختياري، يُستخدم فقط لدقّة تعليم مخطط
// الجسم في التقرير المطبوع (راجع bodyDiagramWithMarks في injury_report_html.dart):
// بدونه توضع دائرة على كل الاحتمالات الممكنة للجزء المصاب (مثال: الكتف يظهر
// على ٤ مواضع معًا — أمامي يمين/يسار وخلفي يمين/يسار) لأن جهة الإصابة لم تكن
// مسجَّلة أصلًا؛ بتحديدها هنا تُعرض فقط المواضع المطابقة فيصير التأشير دقيقًا.
const BODY_INJURY_SIDES = ['front', 'back'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'seasonal', 'temporary', 'contractor'];
const INJURY_NATURE_TYPES = [
  'abrasion', 'amputation', 'broken_bone', 'bruise', 'burn_heat', 'burn_chemical', 'burn_fire',
  'concussion', 'cut_laceration_puncture', 'hernia', 'sprain', 'body_system_damage', 'other',
];

const DEPARTMENTS = ['مصنع الرجال', 'مصنع النساء', 'المستودع العام'];

function filterList(arr, allowed) {
  return Array.isArray(arr) ? arr.filter((v) => allowed.includes(v)) : [];
}
function oneOf(value, allowed) {
  return allowed.includes(value) ? value : null;
}

// رسمة تفاعلية يرسمها المستخدم بإصبعه فوق مخطط الجسم (BodyDiagramDrawer في
// التطبيق) لتحديد مكان الإصابة بدقة كاملة — بديل عن أي تخمين آلي لمكان
// الإصابة. نفس نمط saveEquipmentPhoto في routes/safetyPermits.js بالضبط:
// تُرسَل كـ data URL (data:image/png;base64,...) فتُحفَظ كملف فعلي ضمن
// public/uploads/، ويُخزَّن مسارها النسبي فقط في قاعدة البيانات.
//
// حالة خاصة: بما أن insertChildren تحذف صفوف المصابين وتُعيد إدراجها في كل
// تعديل لتقرير (راجع تعليق done أعلاه)، يُعيد التطبيق إرسال المسار المحفوظ
// كما هو لو لم يرسم المستخدم شيئًا جديدًا أثناء التعديل — فنمرّره كما هو
// بدل محاولة فك تشفيره كـ base64 من جديد (وإلا سيُفقَد عند كل تعديل).
const BODY_DIAGRAM_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'injury-reports');
function saveBodyDiagramImage(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('/uploads/injury-reports/')) return trimmed;
  const match = /^data:image\/(png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i.exec(trimmed);
  if (!match) return null;
  const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) {
    throw Object.assign(new Error('حجم رسمة مخطط الجسم كبير جدًا (الحد الأقصى ٦ ميجابايت)'), { statusCode: 400 });
  }
  fs.mkdirSync(BODY_DIAGRAM_UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(BODY_DIAGRAM_UPLOAD_DIR, filename), buf);
  return `/uploads/injury-reports/${filename}`;
}

// كل ضابط مختار في هرم الضوابط (hierarchy_of_controls) له خانة تفاصيل مستقلة
// به بدل نص واحد مشترك — يُخزَّن control_details كنص JSON عمودي (وليس عمود
// JSONB فعلي — راجع encodeParam في lib/pgLite.js: لا يُسلسِل الكائنات
// تلقائيًا)، فنبني هنا كائنًا يحوي فقط المفاتيح المسموحة والمعبّأة فعليًا.
function sanitizeControlDetails(input, allowedKeys) {
  const out = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const k of allowedKeys) {
      const v = input[k];
      if (v && String(v).trim()) out[k] = String(v).trim();
    }
  }
  return out;
}

// نفس نمط userSafetyFacility في routes/safetyPermits.js وroutes/dashboard.js
// بالضبط — لكن هنا لا حاجة لتحليل نص "قسم — تفاصيل" لأن عمود department في
// injury_reports قيمة قسم صِرفة دائمًا (وليس نصًا حرًا فيه تفاصيل الموقع).
function userSafetyFacility(req) {
  if (req.user.role === 'admin') return null;
  return req.user.safety_facility || null;
}

async function fetchFullReport(id) {
  const { rows } = await pool.query('SELECT * FROM injury_reports WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const [employees, actions, investigators] = await Promise.all([
    pool.query('SELECT * FROM injury_report_employees WHERE injury_report_id = $1 ORDER BY id', [id]),
    pool.query('SELECT * FROM injury_report_actions WHERE injury_report_id = $1 ORDER BY id', [id]),
    pool.query('SELECT * FROM injury_report_investigators WHERE injury_report_id = $1 ORDER BY id', [id]),
  ]);
  return {
    ...rows[0],
    employees: employees.rows,
    actions: actions.rows,
    investigators: investigators.rows,
  };
}

// GET /api/injury-reports — قائمة مختصرة (بدون تفاصيل المصابين والإجراءات)،
// مقيَّدة بقسم مسؤول السلامة الحالي لو كان مقيَّدًا بقسم واحد فقط.
router.get('/', async (req, res) => {
  const facility = userSafetyFacility(req);
  const { rows } = facility
    ? await pool.query('SELECT * FROM injury_reports WHERE department = $1 ORDER BY occurred_at DESC', [facility])
    : await pool.query('SELECT * FROM injury_reports ORDER BY occurred_at DESC');
  res.json({ reports: rows });
});

// يتحقق من صلاحية الوصول لتقرير معيّن (نفس فكرة assertPermitAccess في
// routes/safetyPermits.js) — يُعيد صف injury_reports إن كان الوصول مسموحًا.
async function assertReportAccess(req, res) {
  const { rows } = await pool.query('SELECT id, department FROM injury_reports WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: 'التقرير غير موجود' });
    return null;
  }
  const facility = userSafetyFacility(req);
  if (facility && rows[0].department !== facility) {
    res.status(403).json({ error: 'لا تملك صلاحية الوصول لتقارير قسم آخر' });
    return null;
  }
  return rows[0];
}

// GET /api/injury-reports/:id — تفاصيل كاملة (المصابون + الإجراءات + فريق التحقيق)
router.get('/:id', async (req, res) => {
  if (!(await assertReportAccess(req, res))) return;
  const report = await fetchFullReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'التقرير غير موجود' });
  res.json({ report });
});

// يُدخل صفوف الموظفين المصابين والإجراءات وفريق التحقيق لتقرير معيّن ضمن
// معاملة قائمة (client) — يُستخدم عند الإنشاء وعند التعديل (بعد حذف القديم).
async function insertChildren(client, reportId, { employees, actions, investigators }) {
  for (const e of employees || []) {
    if (!e || !e.employeeName) continue;
    await client.query(
      `INSERT INTO injury_report_employees
         (injury_report_id, employee_name, nationality, employee_id_no, age, department, job_title, shift,
          body_parts_affected, body_injury_side, body_diagram_image, lost_work_days, employment_type, months_in_job, months_in_company,
          injury_nature, injury_nature_other, is_fatality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        reportId,
        String(e.employeeName).trim(),
        e.nationality ? String(e.nationality).trim() : null,
        e.employeeIdNo ? String(e.employeeIdNo).trim() : null,
        e.age || null,
        e.department ? String(e.department).trim() : null,
        e.jobTitle ? String(e.jobTitle).trim() : null,
        e.shift ? String(e.shift).trim() : null,
        filterList(e.bodyPartsAffected, BODY_PARTS),
        oneOf(e.bodyInjurySide, BODY_INJURY_SIDES),
        saveBodyDiagramImage(e.bodyDiagramImage),
        e.lostWorkDays || 0,
        oneOf(e.employmentType, EMPLOYMENT_TYPES),
        e.monthsInJob || null,
        e.monthsInCompany || null,
        filterList(e.injuryNature, INJURY_NATURE_TYPES),
        e.injuryNatureOther ? String(e.injuryNatureOther).trim() : null,
        !!e.isFatality,
      ]
    );
  }
  for (const a of actions || []) {
    if (!a || !a.actionDescription) continue;
    // نقبل حالة "تم" هنا أيضًا (لا فقط عبر PATCH /:id/actions/:actionId) —
    // لأن تعديل التقرير كاملًا (PATCH /:id) يحذف كل الإجراءات القديمة ويعيد
    // إدراجها من جديد ضمن هذه الدالة، فبدون هذا الحقل كانت أي إجراءات أُنجزت
    // مسبقًا (status='done') تُعاد إلى "بانتظار التنفيذ" فور أي تعديل آخر في
    // التقرير حتى لو لم يمسّها المستخدم أصلًا — تطبيق الجوال يعيد إرسال حالة
    // done لكل إجراء كما هي عند تحميل التقرير للتعديل (راجع InjuryReportAction).
    const done = a.done === true;
    await client.query(
      `INSERT INTO injury_report_actions (injury_report_id, action_description, responsible_person, target_date, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        reportId,
        String(a.actionDescription).trim(),
        a.responsiblePerson ? String(a.responsiblePerson).trim() : null,
        a.targetDate || null,
        done ? 'done' : 'pending',
        done ? (a.completedAt || new Date()) : null,
      ]
    );
  }
  for (const inv of investigators || []) {
    if (!inv || !inv.name) continue;
    await client.query(
      'INSERT INTO injury_report_investigators (injury_report_id, name, job_title) VALUES ($1,$2,$3)',
      [reportId, String(inv.name).trim(), inv.jobTitle ? String(inv.jobTitle).trim() : null]
    );
  }
}

// POST /api/injury-reports — إنشاء تقرير تحقيق إصابة كامل (كل الخطوات الخمس
// دفعة واحدة، بنفس أسلوب استمارة الشاشة متعددة الخطوات في التطبيق) — يقدَّم
// من قسم السلامة (أو مدير النظام). مسؤول سلامة مقيَّد بقسم واحد لا يقدر ينشئ
// تقريرًا لقسم آخر.
router.post('/', requireRole('safety'), async (req, res) => {
  const b = req.body;
  if (!b.department || !DEPARTMENTS.includes(b.department)) {
    return res.status(400).json({ error: 'القسم إلزامي ويجب أن يكون أحد الأقسام المعروفة' });
  }
  const facility = userSafetyFacility(req);
  if (facility && b.department !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية إنشاء تقرير لقسم آخر' });
  }
  if (!b.incidentLocation || !b.occurredAt || !b.incidentDescription) {
    return res.status(400).json({ error: 'موقع الحادث وتاريخه ووصف الحادثة إلزامية' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO injury_reports
         (incident_number, department, investigation_date, nature_of_accident, injury_types,
          incident_location, occurred_at, workday_part, workday_part_other,
          witness_statements, photographs_taken, maps_drawings, ppe_used, incident_description,
          unsafe_condition_reason, unsafe_act_reason, had_reward_incentive, reported_before, similar_incidents_before,
          fishbone_causes, hierarchy_of_controls, control_details, prevention_changes, prevention_changes_other, prevention_notes,
          written_by, written_by_title, reported_by, reported_by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING *`,
      [
        b.incidentNumber ? String(b.incidentNumber).trim() : null,
        b.department,
        b.investigationDate || new Date().toISOString().slice(0, 10),
        filterList(b.natureOfAccident, NATURE_OF_ACCIDENT),
        filterList(b.injuryTypes, INJURY_TYPES),
        String(b.incidentLocation).trim(),
        b.occurredAt,
        oneOf(b.workdayPart, WORKDAY_PARTS),
        b.workdayPartOther ? String(b.workdayPartOther).trim() : null,
        !!b.witnessStatements,
        !!b.photographsTaken,
        !!b.mapsDrawings,
        filterList(b.ppeUsed, PPE_USED_TYPES),
        String(b.incidentDescription).trim(),
        b.unsafeConditionReason ? String(b.unsafeConditionReason).trim() : null,
        b.unsafeActReason ? String(b.unsafeActReason).trim() : null,
        b.hadRewardIncentive === true || b.hadRewardIncentive === false ? b.hadRewardIncentive : null,
        b.reportedBefore === true || b.reportedBefore === false ? b.reportedBefore : null,
        b.similarIncidentsBefore === true || b.similarIncidentsBefore === false ? b.similarIncidentsBefore : null,
        filterList(b.fishboneCauses, FISHBONE_CAUSE_TYPES),
        filterList(b.hierarchyOfControls, HIERARCHY_OF_CONTROL_TYPES),
        JSON.stringify(sanitizeControlDetails(b.controlDetails, HIERARCHY_OF_CONTROL_TYPES)),
        filterList(b.preventionChanges, PREVENTION_CHANGE_TYPES),
        b.preventionChangesOther ? String(b.preventionChangesOther).trim() : null,
        b.preventionNotes ? String(b.preventionNotes).trim() : null,
        b.writtenBy ? String(b.writtenBy).trim() : req.user.name,
        b.writtenByTitle ? String(b.writtenByTitle).trim() : null,
        req.user.name,
        req.user.id,
      ]
    );
    const report = rows[0];
    await insertChildren(client, report.id, { employees: b.employees, actions: b.actions, investigators: b.investigators });
    await client.query('COMMIT');

    // نُرفق رقم جوال مُدخِل التقرير الشخصي (مسؤول أو موظف السلامة الذي سجّل
    // الإصابة) — يُستخدم لإرسال رسالة تأكيد واتساب له مباشرة، بنفس أسلوب
    // reported_by_phone في routes/production.js (راجع services/notifications.js).
    const full = { ...(await fetchFullReport(report.id)), reported_by_phone: req.user.phone || null };
    fireWebhook('injury_report_created', full);
    notifyEvent('injury_report_created', full);
    res.status(201).json({ report: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ تقرير الإصابة' });
  } finally {
    client.release();
  }
});

// PATCH /api/injury-reports/:id — تعديل تقرير قائم (طالما لا يزال "مفتوحًا")
// — يستبدل كل بيانات الخطوات الخمس دفعة واحدة (بما فيها المصابون والإجراءات و
// فريق التحقيق: تُحذف القديمة وتُدرج الجديدة ضمن نفس المعاملة) بدل مقارنة
// الفروقات، بنفس بساطة أسلوب هذا المشروع في التعامل مع نماذج متعددة الخطوات.
router.patch('/:id', requireRole('safety'), async (req, res) => {
  const existing = await assertReportAccess(req, res);
  if (!existing) return;

  const { rows: currentRows } = await pool.query('SELECT * FROM injury_reports WHERE id = $1', [req.params.id]);
  const current = currentRows[0];
  if (current.status === 'closed') {
    return res.status(400).json({ error: 'لا يمكن تعديل تقرير مُغلَق — أعد فتحه أولًا' });
  }

  const b = req.body;
  if (b.department && !DEPARTMENTS.includes(b.department)) {
    return res.status(400).json({ error: 'القسم غير صحيح' });
  }
  const facility = userSafetyFacility(req);
  if (facility && b.department && b.department !== facility) {
    return res.status(403).json({ error: 'لا تملك صلاحية نقل التقرير لقسم آخر' });
  }

  // نُبقي على القيمة الحالية لأي حقل لم يُرسله العميل (undefined) بدل مسحه —
  // مهم خصوصًا للأعمدة الإلزامية (department/investigationDate/incidentLocation/
  // occurredAt/incidentDescription): استمارة التطبيق ترسل كل الحقول دائمًا،
  // لكن أي عميل آخر يرسل تعديلًا جزئيًا (مثال: تحديث حقل واحد فقط) لا يجب أن
  // يصفّر باقي الحقول ويصطدم بقيود NOT NULL على السيرفر.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE injury_reports SET
         incident_number = $1, department = $2, investigation_date = $3, nature_of_accident = $4, injury_types = $5,
         incident_location = $6, occurred_at = $7, workday_part = $8, workday_part_other = $9,
         witness_statements = $10, photographs_taken = $11, maps_drawings = $12, ppe_used = $13, incident_description = $14,
         unsafe_condition_reason = $15, unsafe_act_reason = $16, had_reward_incentive = $17, reported_before = $18, similar_incidents_before = $19,
         fishbone_causes = $20, hierarchy_of_controls = $21, control_details = $22, prevention_changes = $23, prevention_changes_other = $24, prevention_notes = $25,
         written_by = $26, written_by_title = $27, updated_at = now()
       WHERE id = $28 RETURNING *`,
      [
        b.incidentNumber !== undefined ? (b.incidentNumber ? String(b.incidentNumber).trim() : null) : current.incident_number,
        b.department || current.department,
        b.investigationDate || current.investigation_date,
        b.natureOfAccident !== undefined ? filterList(b.natureOfAccident, NATURE_OF_ACCIDENT) : current.nature_of_accident,
        b.injuryTypes !== undefined ? filterList(b.injuryTypes, INJURY_TYPES) : current.injury_types,
        b.incidentLocation ? String(b.incidentLocation).trim() : current.incident_location,
        b.occurredAt || current.occurred_at,
        b.workdayPart !== undefined ? oneOf(b.workdayPart, WORKDAY_PARTS) : current.workday_part,
        b.workdayPartOther !== undefined ? (b.workdayPartOther ? String(b.workdayPartOther).trim() : null) : current.workday_part_other,
        b.witnessStatements !== undefined ? !!b.witnessStatements : current.witness_statements,
        b.photographsTaken !== undefined ? !!b.photographsTaken : current.photographs_taken,
        b.mapsDrawings !== undefined ? !!b.mapsDrawings : current.maps_drawings,
        b.ppeUsed !== undefined ? filterList(b.ppeUsed, PPE_USED_TYPES) : current.ppe_used,
        b.incidentDescription ? String(b.incidentDescription).trim() : current.incident_description,
        b.unsafeConditionReason !== undefined ? (b.unsafeConditionReason ? String(b.unsafeConditionReason).trim() : null) : current.unsafe_condition_reason,
        b.unsafeActReason !== undefined ? (b.unsafeActReason ? String(b.unsafeActReason).trim() : null) : current.unsafe_act_reason,
        b.hadRewardIncentive === true || b.hadRewardIncentive === false ? b.hadRewardIncentive : current.had_reward_incentive,
        b.reportedBefore === true || b.reportedBefore === false ? b.reportedBefore : current.reported_before,
        b.similarIncidentsBefore === true || b.similarIncidentsBefore === false ? b.similarIncidentsBefore : current.similar_incidents_before,
        b.fishboneCauses !== undefined ? filterList(b.fishboneCauses, FISHBONE_CAUSE_TYPES) : current.fishbone_causes,
        b.hierarchyOfControls !== undefined ? filterList(b.hierarchyOfControls, HIERARCHY_OF_CONTROL_TYPES) : current.hierarchy_of_controls,
        b.controlDetails !== undefined ? JSON.stringify(sanitizeControlDetails(b.controlDetails, HIERARCHY_OF_CONTROL_TYPES)) : current.control_details,
        b.preventionChanges !== undefined ? filterList(b.preventionChanges, PREVENTION_CHANGE_TYPES) : current.prevention_changes,
        b.preventionChangesOther !== undefined ? (b.preventionChangesOther ? String(b.preventionChangesOther).trim() : null) : current.prevention_changes_other,
        b.preventionNotes !== undefined ? (b.preventionNotes ? String(b.preventionNotes).trim() : null) : current.prevention_notes,
        b.writtenBy !== undefined ? (b.writtenBy ? String(b.writtenBy).trim() : null) : current.written_by,
        b.writtenByTitle !== undefined ? (b.writtenByTitle ? String(b.writtenByTitle).trim() : null) : current.written_by_title,
        req.params.id,
      ]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'التقرير غير موجود' });
    }

    if (b.employees || b.actions || b.investigators) {
      await client.query('DELETE FROM injury_report_employees WHERE injury_report_id = $1', [req.params.id]);
      await client.query('DELETE FROM injury_report_actions WHERE injury_report_id = $1', [req.params.id]);
      await client.query('DELETE FROM injury_report_investigators WHERE injury_report_id = $1', [req.params.id]);
      await insertChildren(client, req.params.id, { employees: b.employees, actions: b.actions, investigators: b.investigators });
    }

    await client.query('COMMIT');
    const full = await fetchFullReport(req.params.id);
    res.json({ report: full });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تعديل تقرير الإصابة' });
  } finally {
    client.release();
  }
});

// PATCH /api/injury-reports/:id/actions/:actionId — تحديث حالة إجراء تصحيحي
// واحد (تمت أو بانتظار) دون الحاجة لإعادة إرسال التقرير كاملًا — مفيد لمتابعة
// جدول "Action / Responsibility / Sign / Timeline" بعد إغلاق التحقيق.
router.patch('/:id/actions/:actionId', requireRole('safety'), async (req, res) => {
  if (!(await assertReportAccess(req, res))) return;
  const done = !!req.body.done;
  const { rows } = await pool.query(
    `UPDATE injury_report_actions SET status = $1, completed_at = $2
     WHERE id = $3 AND injury_report_id = $4 RETURNING *`,
    [done ? 'done' : 'pending', done ? new Date() : null, req.params.actionId, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الإجراء غير موجود' });
  res.json({ action: rows[0] });
});

// PATCH /api/injury-reports/:id/close — الخطوة الخامسة: اعتماد التقرير
// وإغلاقه نهائيًا (يصبح للقراءة فقط بعدها، ويظهر جاهزًا للطباعة الرسمية).
router.patch('/:id/close', requireRole('safety'), async (req, res) => {
  if (!(await assertReportAccess(req, res))) return;
  const { approvedBy, approvedByTitle } = req.body;
  if (!approvedBy) return res.status(400).json({ error: 'اسم المعتمِد إلزامي لإغلاق التقرير' });

  const { rows } = await pool.query(
    `UPDATE injury_reports SET
       status = 'closed', approved_by = $1, approved_by_title = $2, approved_at = now(), updated_at = now()
     WHERE id = $3 RETURNING *`,
    [String(approvedBy).trim(), approvedByTitle ? String(approvedByTitle).trim() : null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'التقرير غير موجود' });
  const full = await fetchFullReport(req.params.id);
  fireWebhook('injury_report_closed', full);
  notifyEvent('injury_report_closed', full);
  res.json({ report: full });
});

// PATCH /api/injury-reports/:id/reopen — إعادة فتح تقرير مُغلَق للتعديل.
router.patch('/:id/reopen', requireRole('safety'), async (req, res) => {
  if (!(await assertReportAccess(req, res))) return;
  const { rows } = await pool.query(
    "UPDATE injury_reports SET status = 'open', updated_at = now() WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'التقرير غير موجود' });
  res.json({ report: rows[0] });
});

// DELETE /api/injury-reports/:id — حذف تقرير نهائيًا (قسم السلامة أو مدير
// النظام فقط) — تُحذف كل السجلات التابعة تلقائيًا (ON DELETE CASCADE).
router.delete('/:id', requireRole('safety'), async (req, res) => {
  if (!(await assertReportAccess(req, res))) return;
  const { rows } = await pool.query('DELETE FROM injury_reports WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'التقرير غير موجود' });
  res.status(204).end();
});

module.exports = router;
