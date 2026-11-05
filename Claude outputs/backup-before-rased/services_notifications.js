// موزّع إشعارات واتساب مركزي — يحوّل كل حدث بيانات (بلاغ عطل، تسجيل باتش،
// أمر عمل، تصريح سلامة، Near Miss) لرسالة نصية عربية مفصّلة (بنفس صيغة
// الرسائل التي اعتاد عليها المصنع)، ثم يرسلها مباشرة عبر TextMeBot (بدون أي
// أتمتة وسيطة مثل n8n) — لجروب القسم المعني، وأيضًا لرقم الشخص المعني
// مباشرة حين يكون ذلك منطقيًا (الفني أو الفنيون المُسنَد لهم أمر العمل، مُنشئ
// البلاغ عند إنجازه، أو مقدّم تصريح السلامة عند مراجعته).
//
// كل حدث يحفظ أيضًا إشعارًا داخل التطبيق (جدول notifications) للأشخاص
// المعنيين تحديدًا فقط — يظهر لهم عند فتح جرس الإشعارات، بديل خفيف عن
// إشعارات نظام Push الحقيقية (تلك تحتاج ربط خدمة Firebase منفصلة، غير
// موجودة بالنظام بعد). فشل حفظ إشعار داخلي لا يوقف إرسال واتساب أبدًا، والعكس.
//
// أقسام النظام الأربعة وجروبات واتساب كل منها (تُضبَط من "إعدادات الموقع"):
//   - إنتاج (مصنع الرجال): textmebot_group_production_men
//   - إنتاج (مصنع النساء): textmebot_group_production_women
//   - الصيانة (كل الفنيين):  textmebot_group_maintenance
//   - السلامة المهنية:       textmebot_group_safety
// أي جروب غير مضبوط بعد يعني ببساطة تجاهل الإرسال الجماعي لذلك الحدث (يُسجَّل
// في اللوق فقط)، دون أي تأثير على الإشعار الفردي إن وُجد له مستلم.
'use strict';

const { pool } = require('../config/db');
const { sendWhatsappText, normalizePhoneNumber } = require('./textmebot');
const { MAINTENANCE_ROLES } = require('../middleware/auth');
const { sendPushToUsers } = require('./push');

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0] && rows[0].value ? rows[0].value : null;
}

// "المستودع العام" عمدًا بلا جروب مخصّص — الأربعة أقسام المطلوبة هنا فقط.
const PRODUCTION_GROUP_KEY = {
  'مصنع الرجال': 'textmebot_group_production_men',
  'مصنع النساء': 'textmebot_group_production_women',
};

// نص رد TextMeBot الفعلي (مقتطع) — حتى يظهر في اللوق سبب الرفض الحقيقي (مفتاح
// غير صالح، اشتراك منتهٍ، واتساب غير مربوط...) بدل رمز الحالة وحده (403 مثلًا)
// الذي لا يفسّر شيئًا. فارغ لو لم يصل أي نص.
function whatsappBodyHint(result) {
  const body = result && typeof result.body === 'string' ? result.body.replace(/\s+/g, ' ').trim() : '';
  return body ? `— رد الخدمة: ${body.slice(0, 200)}` : '';
}

async function sendToGroup(settingKey, message, logLabel) {
  if (!settingKey) return;
  const groupId = await getSetting(settingKey);
  if (!groupId) {
    console.log(`[notifications] لا يوجد جروب واتساب مضبوط لـ "${logLabel}" (${settingKey}) — تم تجاهل الإرسال الجماعي.`);
    return;
  }
  // لا ننتظر الإرسال الفعلي عمدًا (2026-10-12): كل رسائل واتساب تمر عبر طابور
  // واحد بفاصل ٨٫٥ ثانية بين كل رسالتين (شرط TextMeBot)، فانتظارها هنا كان
  // يؤخّر الإشعار داخل التطبيق والـPush (وهما بعد هذا الاستدعاء في كل حدث)
  // دقائق كاملة عند ازدحام الطابور — فيظهر للمستخدم أن الطلب لم يصل أو تأخر
  // قبوله. الآن الإشعار داخل التطبيق فوري، وواتساب يصل بدوره من الطابور.
  deliverWhatsapp(groupId, message, logLabel, 'لجروب واتساب');
}

async function sendToPerson(phone, message, logLabel) {
  if (!phone) return;
  deliverWhatsapp(phone, message, logLabel, 'لرقم شخصي');
}

// يضع الرسالة في طابور واتساب ويسجّل فشلها لاحقًا في اللوق، دون أن ينتظره
// المستدعي (راجع التعليق في sendToGroup أعلاه).
function deliverWhatsapp(recipient, message, logLabel, kindLabel) {
  Promise.resolve(sendWhatsappText(recipient, message))
    .then((result) => {
      if (result && !result.ok) {
        console.error(`[notifications] تعذّر إرسال إشعار "${logLabel}" ${kindLabel}:`, result.error || result.statusCode, whatsappBodyHint(result));
      }
    })
    .catch((err) => console.error(`[notifications] خطأ غير متوقع أثناء إرسال "${logLabel}":`, err.message));
}

// يؤجّل رسالة "بلاغ/مهمة جديدة" لجروب الصيانة، ويلغيها لو أُسندت المهمة لفني
// خلال المهلة (رسالة الإسناد تحمل نفس التفاصيل) — راجع التعليق في الحالة
// work_order_created. WO_CREATED_MERGE_DELAY_MS في .env لضبط المهلة (افتراضي ٦٠٠٠).
function createdMergeDelayMs() {
  const v = Number(process.env.WO_CREATED_MERGE_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
}

function sendCreatedMessageToGroup(workOrderId, message, logLabel) {
  const send = () => sendToGroup('textmebot_group_maintenance', message, logLabel).catch((err) => {
    console.error(`[notifications] خطأ أثناء إرسال "${logLabel}":`, err.message);
  });
  if (!workOrderId) { send(); return; }
  setTimeout(async () => {
    try {
      const { rows } = await pool.query('SELECT status FROM work_orders WHERE id = $1', [workOrderId]);
      if (rows.length === 0) return; // حُذف الأمر قبل انتهاء المهلة
      if (rows[0].status !== 'new' && rows[0].status !== 'pending_assignment') {
        console.log(`[notifications] أمر العمل ${workOrderId} أُسند خلال المهلة — اكتُفي برسالة الإسناد بدل رسالة "جديد".`);
        return;
      }
    } catch (err) {
      console.error('[notifications] تعذّر فحص حالة الأمر قبل رسالة "جديد" — تُرسل مباشرة:', err.message);
    }
    send();
  }, createdMergeDelayMs());
}

// ---------------------------------------------------------------------------
// إشعارات داخل التطبيق — تُحفظ في جدول notifications، مستقلة تمامًا عن نجاح
// أو فشل إرسال واتساب.
// ---------------------------------------------------------------------------

async function insertNotification(userId, { title, body, eventType, refId }) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, body, event_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
      [userId, title, body, eventType || null, refId || null]
    );
  } catch (err) {
    console.error('[notifications] تعذّر حفظ إشعار داخل التطبيق:', err.message);
  }
}

async function insertNotificationForUsers(userIds, data) {
  const unique = Array.from(new Set((userIds || []).filter(Boolean)));
  await Promise.all(unique.map((id) => insertNotification(id, data)));
  // إشعار Push حقيقي عبر Firebase (صوت + شريط إشعارات، حتى لو التطبيق مغلق)
  // بجانب الحفظ داخل التطبيق أعلاه — بلا await عمدًا (fire-and-forget، تمامًا
  // كإرسال واتساب) حتى لا يُبطئ أي مسار ينتظر هذه الدالة. لا يرمي أبدًا، وإن
  // لم يُضبط ملف مفتاح Firebase بعد (راجع services/push.js) يُتجاهل بصمت.
  sendPushToUsers(unique, { title: data.title, body: data.body });
}

// كل المستخدمين المعتمدين بأدوار معيّنة — تُستخدم لإشعار "كل فريق الصيانة"
// أو "كل قسم السلامة" داخل التطبيق (وليس واتساب، فذلك عبر جروب واحد).
async function getApprovedUserIdsByRole(roles) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = ANY($1) AND status = 'approved'`,
    [roles]
  );
  return rows.map((r) => r.id);
}

// بنفس فكرة getApprovedUserIdsByRole أعلاه لكن ترجع رقم الجوال أيضًا — تُستخدم
// لإرسال رسالة واتساب شخصية لكل مستخدم بدور معيّن (مثل "كل مسؤولي المخزون"
// أو "كل المصممين") لا يوجد لهم جروب واتساب مخصّص خاص بهم، خلافًا لأقسام
// الإنتاج/الصيانة/السلامة الأربعة (راجع PRODUCTION_GROUP_KEY أعلى الملف).
// تُعيد قائمة المعرّفات نفسها (مفيدة لإشعار داخل التطبيق بنفس الاستدعاء).
async function sendToPersonsByRole(roles, message, logLabel) {
  const { rows } = await pool.query(
    `SELECT id, phone FROM users WHERE role = ANY($1) AND status = 'approved'`,
    [roles]
  );
  await Promise.all(rows.filter((u) => u.phone).map((u) => sendToPerson(u.phone, message, logLabel)));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// أدوات تنسيق التاريخ والوقت — بدون أي مكتبة خارجية، تعتمد على ساعة السيرفر
// نفسه (جهاز الويندوز الذي يشغّل الخدمة، بتوقيته المحلي الفعلي).
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

// تنسيق عربي "2026/08/30" و"3:45:00 ص" — لرسائل الصيانة والسلامة.
function fmtDateAr(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}/${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}`;
}
function fmtTimeAr(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  let h = dt.getHours();
  const period = h >= 12 ? 'م' : 'ص';
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())} ${period}`;
}

// تنسيق إنجليزي بلا أصفار زائدة "9/6/2026" و"8:00:00 AM" — لرسالة تسجيل
// الباتش تحديدًا، بنفس الصيغة المعتمدة سابقًا لدى المصنع.
function fmtDateEn(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}

// وقت فقط (بلا تاريخ) قادم من عمود TIME في قاعدة البيانات، مثل "08:00:00" —
// يصل كنص خام كما هو (راجع lib/pgLite.js: لا يوجد تحويل خاص لنوع TIME).
function fmtTimeOnlyEn(t) {
  if (!t) return '';
  const parts = String(t).split(':');
  let h = parseInt(parts[0], 10);
  if (Number.isNaN(h)) return String(t);
  const m = parts[1] || '00';
  const s = parts[2] || '00';
  const period = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${m}:${s} ${period}`;
}

const SEVERITY_LABELS = { simple: 'بسيط', medium: 'متوسط', critical: 'حرج' };
function severityLabel(sev) {
  return SEVERITY_LABELS[sev] || null;
}

const OPERATION_TYPE_LABELS = {
  hot_work: 'أعمال حرارية/لحام',
  confined_space: 'أماكن مغلقة',
  height: 'العمل على مرتفعات',
  electrical: 'كهرباء',
  excavation: 'حفريات',
  lifting: 'أعمال رفع',
  other: 'أخرى',
};
function operationTypesLabel(types) {
  if (!Array.isArray(types) || types.length === 0) return '—';
  return types.map((t) => OPERATION_TYPE_LABELS[t] || t).join('، ');
}

function listOrDash(list) {
  if (!Array.isArray(list) || list.length === 0) return '—';
  return list.join('، ');
}

// اسم الموقع والخط الكامل — يجمع القسم (مصنع رجال أو نساء أو مستودع) واسم الخط إن
// وُجد، ويتجاهل أي جزء غير متوفر بدل ترك فراغ غريب في الرسالة.
function locationLine(facility, lineName) {
  return [facility, lineName].filter(Boolean).join(' / ') || '—';
}

// قسم "المهمة المرتبطة" في رسائل تصاريح السلامة — حتى يعرف مسؤول السلامة (وجروب
// الصيانة) ما هي المهمة بالضبط بدل الاكتفاء بوصف التصريح. يعتمد على أعمدة wo_*
// التي تضيفها routes/safetyPermits.js (PERMIT_WITH_TASK_SELECT). فارغ تمامًا لو
// التصريح غير مرتبط بأمر عمل، وينتهي بسطر جديد لو لم يكن فارغًا.
function permitTaskBlock(payload) {
  if (!payload.related_work_order_id) return '';
  const equipment = payload.wo_equipment_name
    ? `${payload.wo_equipment_name}${payload.wo_equipment_code ? ` (${payload.wo_equipment_code})` : ''}`
    : '—';
  return (
    `🔧 المهمة المرتبطة (أمر عمل رقم ${payload.related_work_order_id}):\n` +
    `وصف المهمة: ${payload.wo_description || '—'}\n` +
    `موقع المهمة: ${locationLine(payload.wo_facility, payload.wo_line_name)}\n` +
    `المعدة: ${equipment}\n` +
    (payload.wo_technician_names ? `الفنيون المسؤولون: ${payload.wo_technician_names}\n` : '')
  );
}

/// نقطة الدخول الرئيسية — تُستدعى بجانب (أو بدل) fireWebhook من أي مسار
/// يُنشئ حدثًا يستحق إشعار واتساب. لا ترمي أبدًا؛ استدعوها بدون await لو ما
/// يهمكم انتظار نتيجة الإرسال (fire-and-forget)، أو مع await لو تبون ضمان
/// محاولة الإرسال قبل إغلاق العملية (مثل السكجولر).
async function notifyEvent(eventType, payload) {
  try {
    switch (eventType) {
      case 'incident_created': {
        // بلاغ عطل مفاجئ يرفعه الإنتاج — رسالة مفصّلة بنفس صيغة استمارة
        // "بلاغ عن عطل مفاجئ" الورقية: رقم البلاغ، وقت الطلب، الموقع، اسم
        // المعدة وكودها، وصف العطل، تصنيف حدته (بسيط أو متوسط أو حرج)، ومن رفعه،
        // ورابط صورة العطل إن أُرفقت (photo_path).
        let photoLine = '';
        if (payload.photo_path) {
          const base = await getSetting('public_base_url');
          if (base) photoLine = `\nصورة البلاغ: ${base.replace(/\/+$/, '')}${payload.photo_path}`;
        }
        const msg =
          `🔧 هناك بلاغ عن عطل مفاجئ:\n` +
          `رقم البلاغ: ${payload.id ?? ''}\n` +
          `وقت طلب البلاغ: ${fmtDateAr(payload.reported_at)} ${fmtTimeAr(payload.reported_at)}\n` +
          `الموقع: ${locationLine(payload.facility, payload.line_name)}\n` +
          `اسم المعدة: ${payload.equipment_name || '—'}\n` +
          `رقم الكود للمعدة: ${payload.equipment_code || '—'}\n` +
          `وصف العطل: ${payload.description || ''}\n` +
          `نوع العطل: ${severityLabel(payload.severity) || '—'}\n` +
          `اسم رافع الطلب: ${payload.reported_by || ''}` +
          photoLine;
        await sendToGroup('textmebot_group_maintenance', msg, 'بلاغ عطل جديد (جروب الصيانة)');
        const ids = await getApprovedUserIdsByRole(MAINTENANCE_ROLES);
        await insertNotificationForUsers(ids, {
          title: `بلاغ عطل جديد — ${locationLine(payload.facility, payload.line_name)}`,
          body: payload.description || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'batch_recorded': {
        // بنفس صيغة رسالة تسجيل الباتش المعتمدة سابقًا لدى المصنع (حقول
        // إنجليزية) — لا تغيير في الشكل، فقط يصدر الآن مباشرة من صيانتي.
        // "date" هو occurred_at (التاريخ "الفعلي" الذي قد يكون سابقًا لو
        // سُجِّل الباتش متأخرًا) لا created_at (وقت الإدخال الحقيقي).
        const groupKey = PRODUCTION_GROUP_KEY[payload.facility];
        const msg =
          `date : ${fmtDateEn(payload.occurred_at || payload.created_at)}\n` +
          `line : ${payload.line_name || ''}\n` +
          `product name : ${payload.product_name || ''}\n` +
          `B,NO : ${payload.batch_number || ''}\n` +
          `TIME FROM : ${fmtTimeOnlyEn(payload.time_from) || 'No'}\n` +
          `TIME TO : ${fmtTimeOnlyEn(payload.time_to) || 'No'}\n` +
          `WORKER : ${payload.workers_count ?? 'No'}\n` +
          `QUANTTY : ${payload.quantity ?? ''}\n` +
          `NOTES : ${payload.operational_notes || 'No'}\n` +
          `Reasons for the stoppage : ${payload.stoppage_reason || 'No'}\n` +
          `Radical solutions: ${payload.actions_taken || 'No'}\n` +
          `Avoidance methods : ${payload.prevention_methods || 'No'}`;
        await sendToGroup(groupKey, msg, 'تسجيل باتش');
        break;
      }

      case 'work_order_created': {
        // بلاغ عطل طارئ جديد يبادر به فريق الصيانة مباشرة (بدون بلاغ إنتاج
        // سابق) — نفس صيغة "بلاغ عطل مفاجئ" أعلاه قدر الإمكان، بالحقول
        // المتوفرة لهذا المسار (denormalized على work_orders نفسه).
        // "مهمة عمل" (is_task) تستخدم نفس المسار/الإشعار بالضبط (kind تبقى
        // 'emergency' عمدًا) — فقط العنوان ووصف الحقل يتغيّران هنا ليعكسا أنها
        // مهمة عامة وليست عطلًا فعليًا في معدة (راجع is_task في schema.sql).
        const isTask = Boolean(payload.is_task);
        const taskLabel = payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية';
        const msg =
          `${isTask ? `🆕 هناك ${taskLabel} جديدة — الصيانة:` : '🆕 هناك بلاغ عطل جديد — الصيانة:'}\n` +
          `رقم البلاغ: ${payload.id ?? ''}\n` +
          `وقت طلب البلاغ: ${fmtDateAr(payload.created_at)} ${fmtTimeAr(payload.created_at)}\n` +
          `${payload.facility ? `الموقع: ${payload.facility}\n` : ''}` +
          `${!isTask && payload.equipment_name ? `اسم المعدة: ${payload.equipment_name}\n` : ''}` +
          `${payload.equipment_code ? `رقم الكود للمعدة: ${payload.equipment_code}\n` : ''}` +
          `${isTask ? 'وصف المهمة' : 'وصف العطل'}: ${payload.description || ''}\n` +
          `اسم رافع الطلب: ${payload.created_by || ''}`;
        // رسالة الجروب مؤجَّلة ثوانيَ قليلة عمدًا: التطبيق ينشئ المهمة ثم يُسنِدها
        // لفني بطلب ثانٍ بعد لحظة، فكان الجروب يستلم رسالتين متتاليتين عن المهمة
        // نفسها ("مهمة جديدة" ثم "تم إسناد أمر عمل" بنفس التفاصيل). إن أُسندت
        // المهمة خلال المهلة نكتفي برسالة الإسناد، وإلا تُرسل رسالة الإنشاء كالمعتاد.
        // الإشعار داخل التطبيق أدناه فوري ولا يتأثر بالمهلة.
        sendCreatedMessageToGroup(payload.id, msg, isTask ? 'مهمة عمل جديدة (جروب الصيانة)' : 'بلاغ عطل صيانة جديد (جروب الصيانة)');
        const ids = await getApprovedUserIdsByRole(MAINTENANCE_ROLES);
        await insertNotificationForUsers(ids, {
          title: `${isTask ? taskLabel : 'بلاغ عطل جديد'} — ${payload.facility || 'الصيانة'}`,
          body: payload.description || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'work_order_assigned': {
        // يشمل الآن كل الفنيين المُسنَد إليهم أمر العمل (وليس فنيًا واحدًا
        // فقط كما كان)، ونوع العمل بنص عربي واضح، والمعدة وكودها والقسم.
        const kindLabel = payload.is_task
          ? (payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية')
          : (payload.kind === 'preventive' ? 'صيانة وقائية' : 'عطل طارئ');
        const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
        const technicianNames = technicians.length > 0
          ? technicians.map((t) => t.name).filter(Boolean).join('، ')
          : (payload.technician_name || 'غير معروف');
        const equipmentLine = payload.equipment_name
          ? `المعدة: ${payload.equipment_name}${payload.equipment_code ? ` (${payload.equipment_code})` : ''}\n`
          : '';
        // اسم من قام بالتعيين (طلب 2026-10-06) — يظهر فقط لو كان معروفًا.
        const assignedByLine = payload.assigned_by ? `\nتم التعيين بواسطة: ${payload.assigned_by}` : '';
        // ملاحظة المشرف المكتوبة أثناء التعيين (طلب 2026-10-07) — تصل ضمن نفس
        // الرسالة للجروب والفني (وفي الإشعار داخل التطبيق أدناه).
        const assignNote = payload.assignment_note ? String(payload.assignment_note).trim() : '';
        const assignNoteLine = assignNote ? `\nملاحظة المشرف: ${assignNote}` : '';
        const details =
          `${payload.facility ? `القسم: ${payload.facility}\n` : ''}` +
          equipmentLine +
          `النوع: ${kindLabel}\n` +
          `الوصف: ${payload.description || ''}` +
          assignedByLine +
          assignNoteLine;
        const groupMsg = `🛠️ تم إسناد أمر عمل — الفني: ${technicianNames}\n${details}`;
        const personMsg = `🛠️ تم إسناد أمر عمل لك\n${details}`;
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'إسناد أمر عمل (جروب الصيانة)');
        if (technicians.length > 0) {
          // عند إضافة فني لأمر عليه فنيون سابقون: الرسالة الشخصية للمُضافين الآن
          // فقط (لا تتكرر على من استلمها سابقًا). new_technician_ids غائبة/فارغة
          // الدلالة (null) = الجميع كما كان. وأي رقم جوال مكرر بين فنيين يُرسل له مرة.
          const onlyIds = Array.isArray(payload.new_technician_ids) ? payload.new_technician_ids.map(String) : null;
          const recipients = technicians.filter((t) => !onlyIds || onlyIds.includes(String(t.id)));
          const seenPhones = new Set();
          await Promise.all(recipients.map((t) => {
            const norm = normalizePhoneNumber(t.phone) || `id:${t.id}`;
            if (seenPhones.has(norm)) return null;
            seenPhones.add(norm);
            return sendToPerson(t.phone, personMsg, `إسناد أمر عمل (${t.name || 'فني'})`);
          }));
          await insertNotificationForUsers(recipients.map((t) => t.user_id), {
            title: 'تم إسناد أمر عمل لك',
            body: `${payload.description || ''}${payload.assigned_by ? ` — بواسطة: ${payload.assigned_by}` : ''}${assignNote ? ` — ملاحظة المشرف: ${assignNote}` : ''}`,
            eventType,
            refId: payload.id,
          });
        } else {
          await sendToPerson(payload.technician_phone, personMsg, 'إسناد أمر عمل (الفني)');
        }
        // "قبول" بلاغ الإنتاج: أول تعيين فني لأمر عمل ناتج عن بلاغ رفعه قسم
        // الإنتاج = الصيانة قبلت البلاغ وبدأت العمل عليه فعليًا. رسالة شخصية
        // لرافع البلاغ نفسه فقط (قرار صريح 2026-10-04: "رقم من رفع البلاغ فقط"،
        // لا جروب الإنتاج)، إضافة لإشعار داخل التطبيق له.
        if (payload.notify_incident_reporter) {
          const reporterMsg =
            `✅ تم قبول بلاغك من قِبل الصيانة — رقم البلاغ: ${payload.incident_report_id ?? ''}\n` +
            `الموقع: ${locationLine(payload.facility, payload.line_name)}\n` +
            equipmentLine +
            `الفني المسؤول: ${technicianNames}\n` +
            `وصف العطل: ${payload.description || ''}`;
          if (payload.incident_reporter_phone) {
            await sendToPerson(payload.incident_reporter_phone, reporterMsg, 'قبول بلاغ (لرافع البلاغ)');
          } else {
            console.log(
              `[notifications] لا يوجد رقم جوال مسجَّل في حساب رافع البلاغ رقم ${payload.incident_report_id} ` +
              `(${payload.incident_reporter_name || '—'}) — لم تُرسَل له رسالة قبول البلاغ على واتساب.`
            );
          }
          await insertNotificationForUsers([payload.incident_reporter_user], {
            title: `تم قبول بلاغك رقم ${payload.incident_report_id ?? ''}`,
            body: `الفني المسؤول: ${technicianNames}`,
            eventType,
            refId: payload.id,
          });
        }
        break;
      }

      case 'work_order_completed': {
        // رسالة "تم النجاح في الصيانة" — تشمل رقم البلاغ، الموقع، كل
        // الفنيين الذين عملوا عليه، كود المكينة، التاريخ، وقت البدء
        // والانتهاء الفعلي، حالة المهمة، بيان العمل، والملاحظات.
        // "مهمة عمل" (is_task) لا كود مكينة لها عادة — نُسقطه من التفاصيل
        // بدل عرضه "—" دائمًا بلا فائدة، ونُظهر بدلًا عنه نوع المهمة.
        const isTask = Boolean(payload.is_task);
        const taskLabel = payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية';
        const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
        const technicianNames = technicians.length > 0
          ? technicians.map((t) => t.name).filter(Boolean).join('، ')
          : (payload.technician_name || '—');
        const details =
          `الموقع: ${locationLine(payload.facility, payload.line_name)}\n` +
          `اسم الفني: ${technicianNames}\n` +
          `${isTask ? `نوع المهمة: ${taskLabel}\n` : `كود المكينة: ${payload.equipment_code || '—'}\n`}` +
          `التاريخ: ${fmtDateAr(payload.completed_at)}\n` +
          `الوقت من: ${fmtTimeAr(payload.started_at) || '—'}\n` +
          `الوقت إلى: ${fmtTimeAr(payload.completed_at)}\n` +
          `حالة المهمة: منجزة\n` +
          `بيان العمل: ${payload.close_description || ''}\n` +
          `ملاحظات: ${payload.close_notes || 'لا يوجد'}`;
        const groupMsg = `✅ ${isTask ? `تم إنجاز ${taskLabel}` : 'تم النجاح في الصيانة'} — رقم: ${payload.id ?? ''}\n${details}`;
        const personMsg = `✅ تم إنجاز ${isTask ? 'المهمة' : 'أمر العمل'} الذي طلبته — رقم: ${payload.id ?? ''}\n${details}`;
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'إنجاز أمر عمل (جروب الصيانة)');
        if (!payload.created_by_phone && payload.incident_report_id) {
          // أمر عمل ناتج عن بلاغ إنتاج لكن رافع البلاغ بلا رقم جوال مسجَّل في
          // حسابه (أو حسابه محذوف) — نُسجّل السبب صراحة في لوق السيرفر بدل
          // الصمت التام، حتى يسهل اكتشاف لماذا لم تصله رسالة الإنجاز.
          console.log(
            `[notifications] لا يوجد رقم جوال مسجَّل لرافع البلاغ الأصلي لأمر العمل رقم ${payload.id} ` +
            `(${payload.created_by || '—'}) — لم تُرسَل له رسالة الإنجاز على واتساب.`
          );
        }
        await sendToPerson(payload.created_by_phone, personMsg, 'إنجاز أمر عمل (لمن طلبه)');
        await insertNotificationForUsers([payload.created_by_user], {
          title: `تم إنجاز أمر العمل رقم ${payload.id ?? ''}`,
          body: payload.close_description || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'work_order_note_added': {
        // ملاحظة يضيفها المشرف (مسؤول الصيانة/المدير) على مهمة مُسنَدة لفني —
        // سواء كانت قيد التنفيذ أو منجزة (طلب 2026-10-07). تصل لجروب الصيانة،
        // ولكل فني على المهمة (واتساب شخصي + إشعار داخل التطبيق + Push).
        const isTask = Boolean(payload.is_task);
        const kindLabel = isTask
          ? (payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية')
          : (payload.kind === 'preventive' ? 'صيانة وقائية' : 'أمر عمل');
        const STATUS_LABELS = {
          completed: 'منجزة',
          cancelled: 'ملغاة',
          waiting_parts: 'بانتظار قطع غيار',
          waiting_loto: 'بانتظار LOTO',
        };
        const statusLabel = STATUS_LABELS[payload.status] || 'قيد التنفيذ';
        const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
        const technicianNames = technicians.length > 0
          ? technicians.map((t) => t.name).filter(Boolean).join('، ')
          : (payload.technician_name || '—');
        const equipmentLine = payload.equipment_name
          ? `المعدة: ${payload.equipment_name}${payload.equipment_code ? ` (${payload.equipment_code})` : ''}\n`
          : '';
        const author = payload.note_author || 'المشرف';
        const details =
          `حالة المهمة: ${statusLabel}\n` +
          `${payload.facility ? `القسم: ${payload.facility}\n` : ''}` +
          equipmentLine +
          `الوصف: ${payload.description || ''}\n` +
          `الملاحظة: ${payload.note_text || ''}\n` +
          `بواسطة: ${author}`;
        const groupMsg = `📝 ملاحظة من المشرف على ${kindLabel} رقم ${payload.id ?? ''}\nالفني: ${technicianNames}\n${details}`;
        const personMsg = `📝 ملاحظة جديدة من المشرف على ${kindLabel} رقم ${payload.id ?? ''} المُسنَدة لك\n${details}`;
        // الإشعار داخل التطبيق + Push أولًا (فوري)، ثم واتساب (طابور TextMeBot
        // يفصل بين الرسائل بعدة ثوانٍ) — حتى لا يتأخر وصول الإشعار للفني
        // بانتظار رسائل واتساب.
        if (technicians.length > 0) {
          await insertNotificationForUsers(technicians.map((t) => t.user_id), {
            title: `ملاحظة من المشرف على ${kindLabel} رقم ${payload.id ?? ''}`,
            body: `${payload.note_text || ''} — ${author}`,
            eventType,
            refId: payload.id,
          });
        }
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'ملاحظة مشرف على مهمة (جروب الصيانة)');
        await Promise.all(technicians.map((t) => sendToPerson(t.phone, personMsg, `ملاحظة مشرف (${t.name || 'فني'})`)));
        break;
      }

      case 'work_order_updated': {
        // تعديل بيانات مهمة/بلاغ قائم (وصف، موقع، معدة، نوع مهمة) بعد الإنشاء
        // — قرار صريح 2026-09-26 لإتاحة تصحيح خطأ إدخال بدل حذف وإعادة إنشاء.
        const isTask = Boolean(payload.is_task);
        const taskLabel = payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية';
        const kindLabel = isTask ? taskLabel : (payload.kind === 'preventive' ? 'صيانة وقائية' : 'عطل طارئ');
        const details =
          `${payload.facility ? `الموقع: ${payload.facility}\n` : ''}` +
          `${!isTask && payload.equipment_name ? `اسم المعدة: ${payload.equipment_name}\n` : ''}` +
          `${payload.equipment_code ? `كود المكينة: ${payload.equipment_code}\n` : ''}` +
          `${isTask ? 'وصف المهمة' : 'وصف العمل'}: ${payload.description || ''}`;
        const groupMsg = `✏️ تم تعديل ${kindLabel} رقم ${payload.id ?? ''} بواسطة ${payload.updated_by || 'مسؤول الصيانة'}\n${details}`;
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'تعديل أمر عمل (جروب الصيانة)');
        const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
        if (technicians.length > 0) {
          await insertNotificationForUsers(technicians.map((t) => t.user_id), {
            title: `تم تعديل ${kindLabel} رقم ${payload.id ?? ''}`,
            body: payload.description || '',
            eventType,
            refId: payload.id,
          });
        }
        break;
      }

      case 'work_order_deleted': {
        // حذف نهائي لمهمة/بلاغ (أي حالة، ليس فقط المؤرشف) — لم يكن هناك أي
        // إشعار على الحذف من قبل، فيختفي البلاغ من التطبيق بلا أي تفسير
        // لمن كان معنيًا به. قرار صريح 2026-09-26.
        const isTask = Boolean(payload.is_task);
        const kindLabel = isTask
          ? (payload.task_scope === 'external' ? 'مهمة عمل خارجية' : 'مهمة عمل داخلية')
          : (payload.kind === 'preventive' ? 'أمر عمل وقائي' : 'بلاغ عطل');
        const details =
          `${payload.facility ? `الموقع: ${payload.facility}\n` : ''}` +
          `${isTask ? 'وصف المهمة' : 'الوصف'}: ${payload.description || ''}`;
        const groupMsg = `🗑️ تم حذف ${kindLabel} رقم ${payload.id ?? ''} بواسطة ${payload.deleted_by || 'مسؤول الصيانة'}\n${details}`;
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'حذف أمر عمل (جروب الصيانة)');
        const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
        if (technicians.length > 0) {
          await insertNotificationForUsers(technicians.map((t) => t.user_id), {
            title: `تم حذف ${kindLabel} رقم ${payload.id ?? ''}`,
            body: 'حُذف من قِبل مسؤول الصيانة ولم يعد ظاهرًا في التطبيق',
            eventType,
            refId: payload.id,
          });
        }
        break;
      }

      case 'work_order_technician_removed': {
        // إزالة فني واحد بعينه من مهمة/أمر عمل (بلا لمس بقية الفنيين
        // المُسنَدين) — قرار صريح 2026-09-26، مكمِّل لـ"إسناد أمر عمل" أعلاه
        // الذي يُضيف فقط ولا يقدر يزيل أحدًا.
        const details =
          `${payload.facility ? `الموقع: ${payload.facility}\n` : ''}` +
          `الوصف: ${payload.description || ''}`;
        const groupMsg = `👤 تم إزالة الفني ${payload.removed_technician_name || ''} من أمر العمل رقم ${payload.id ?? ''}\n${details}`;
        const personMsg = `تمت إزالتك من أمر العمل/المهمة رقم ${payload.id ?? ''}\n${details}`;
        await sendToGroup('textmebot_group_maintenance', groupMsg, 'إزالة فني من أمر عمل (جروب الصيانة)');
        await sendToPerson(payload.removed_technician_phone, personMsg, `إزالة فني (${payload.removed_technician_name || 'فني'})`);
        if (payload.removed_technician_user_id) {
          await insertNotificationForUsers([payload.removed_technician_user_id], {
            title: `تمت إزالتك من أمر العمل رقم ${payload.id ?? ''}`,
            body: payload.description || '',
            eventType,
            refId: payload.id,
          });
        }
        break;
      }

      case 'safety_permit_requested': {
        // "هناك طلب تصريح عمل" — بنفس صيغة استمارة طلب التصريح الورقية.
        const msg =
          `📋 هناك طلب تصريح عمل:\n` +
          `رقم الطلب: ${payload.id ?? ''}\n` +
          `موقع العمل: ${[payload.location, payload.office_name].filter(Boolean).join(' - ')}\n` +
          `وقت طلب البلاغ: ${fmtDateAr(payload.requested_at)} ${fmtTimeAr(payload.requested_at)}\n` +
          `اسم رافع الطلب: ${payload.requested_by || ''}\n` +
          `وصف العمل: ${payload.description || ''}\n` +
          `تاريخ البدء: ${fmtDateAr(payload.start_at) || '—'}\n` +
          `تاريخ الانتهاء: ${fmtDateAr(payload.end_at) || '—'}\n` +
          `وقت البدء: ${fmtTimeAr(payload.start_at) || '—'}\n` +
          `وقت الانتهاء: ${fmtTimeAr(payload.end_at) || '—'}\n` +
          `عدد العاملين: ${payload.workers_count ?? ''}\n` +
          `رقم جوال المسؤول: ${payload.responsible_phone || '—'}\n` +
          `نوع العمل: ${operationTypesLabel(payload.operation_types)}\n` +
          permitTaskBlock(payload).trimEnd();
        await sendToGroup('textmebot_group_safety', msg.trimEnd(), 'طلب تصريح سلامة');
        const ids = await getApprovedUserIdsByRole(['safety']);
        await insertNotificationForUsers(ids, {
          title: `طلب تصريح عمل جديد — ${payload.location || ''}`,
          body: payload.description || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'safety_permit_reviewed': {
        const approved = payload.status === 'approved';
        let details;
        if (approved) {
          details =
            `خلوّ الموقع من التالي: ${listOrDash(payload.site_hazards)}\n` +
            `المخاطر المحتملة: ${listOrDash(payload.potential_risks)}\n` +
            `الوقاية الشخصية المطلوبة: ${listOrDash(payload.ppe_required)}\n` +
            `الإجراءات الإلزامية للتصريح:\n${payload.precautions || '—'}`;
        } else {
          details = `سبب الرفض: ${payload.rejection_reason || '—'}`;
        }
        // تعريف التصريح نفسه (الموقع/رافع الطلب/وصف العمل/المهمة المرتبطة) قبل
        // القرار — حتى يعرف جروب السلامة ومقدّم الطلب أي تصريح المقصود بلا فتح
        // التطبيق. مقدّم الطلب قد يكون مقاولًا خارجيًا (دور contractor) لا علاقة
        // له بقسم الصيانة، لذلك لا يُرسَل الرد لجروب الصيانة إطلاقًا.
        const permitContext =
          `الموقع: ${[payload.location, payload.office_name].filter(Boolean).join(' - ') || '—'}\n` +
          `رافع الطلب: ${payload.requested_by || '—'}\n` +
          `وصف العمل: ${payload.description || '—'}\n` +
          permitTaskBlock(payload);
        const groupMsg =
          `📋 هناك رد عن التصريح رقم: ${payload.id ?? ''}\n` +
          permitContext +
          `هذا التصريح: ${approved ? 'مقبول ✅' : 'مرفوض ❌'}\n` +
          `تمت المراجعة بواسطة: ${payload.reviewed_by || '—'}\n${details}`;
        const personMsg =
          `${approved ? '✅ تم قبول' : '❌ تم رفض'} طلب تصريح العمل رقم: ${payload.id ?? ''}\n` +
          permitContext +
          `${details}`;
        // الرد يصل لمقدّم الطلب نفسه على جوال حسابه، وأيضًا لجوال المسؤول المكتوب
        // بنموذج الطلب (إن كان رقمًا مختلفًا) — بلا تكرار لو كانا نفس الرقم.
        let requesterPhone = null;
        if (payload.requested_by_user) {
          try {
            const { rows } = await pool.query('SELECT phone FROM users WHERE id = $1', [payload.requested_by_user]);
            requesterPhone = rows[0] ? rows[0].phone : null;
          } catch (err) {
            console.error('[notifications] تعذّر جلب جوال مقدّم طلب التصريح:', err.message);
          }
        }
        const permitPhones = new Map();
        [requesterPhone, payload.responsible_phone].forEach((raw) => {
          const normalized = normalizePhoneNumber(raw);
          if (normalized && !permitPhones.has(normalized)) permitPhones.set(normalized, raw);
        });
        if (permitPhones.size === 0) {
          console.log(`[notifications] لا يوجد رقم جوال لمقدّم طلب التصريح رقم ${payload.id ?? ''} (لا في حسابه ولا في نموذج الطلب) — لم تُرسَل له رسالة واتساب.`);
        }
        for (const phone of permitPhones.values()) {
          await sendToPerson(phone, personMsg, 'مراجعة تصريح سلامة (لمقدّم الطلب)');
        }
        // الجروب بعد مقدّم الطلب عمدًا: رسائل واتساب تخرج بالتتابع (٨٫٥ ثانية بين
        // كل رسالتين)، ومن ينتظر ردّ القبول هو مقدّم الطلب، أما قسم السلامة فهو
        // من اتخذ القرار أصلًا.
        await sendToGroup('textmebot_group_safety', groupMsg, 'مراجعة تصريح سلامة (جروب السلامة)');
        await insertNotificationForUsers([payload.requested_by_user], {
          title: `رد على تصريح العمل رقم ${payload.id ?? ''} — ${approved ? 'مقبول' : 'مرفوض'}`,
          body: approved ? (payload.precautions || '') : (payload.rejection_reason || ''),
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'near_miss_reported': {
        const msg =
          `⚠️ بلاغ Near Miss جديد\n` +
          `الموقع: ${payload.location || ''}\n` +
          `نوع الخطر: ${payload.hazard_type || ''}\n` +
          `الوصف: ${payload.description || ''}`;
        await sendToGroup('textmebot_group_safety', msg, 'بلاغ Near Miss');
        break;
      }

      case 'injury_report_created': {
        // تقرير تحقيق إصابة عمل جديد (QMS-SAF-007) — تُرسل لجروب واتساب
        // السلامة، وأيضًا رسالة تأكيد شخصية لمن أدخل التقرير نفسه (مسؤول
        // السلامة أو موظف السلامة، بحسب من سجّل الدخول وقدّم التقرير) على
        // رقم جواله — بنفس أسلوب reported_by_phone في incident_created أعلاه.
        const employeeNames = Array.isArray(payload.employees) && payload.employees.length > 0
          ? payload.employees.map((e) => e.employee_name).filter(Boolean).join('، ')
          : '—';
        const details =
          `رقم الحادثة: ${payload.incident_number || payload.id || ''}\n` +
          `القسم: ${payload.department || ''}\n` +
          `موقع الحادث: ${payload.incident_location || ''}\n` +
          `تاريخ ووقت الحادث: ${fmtDateAr(payload.occurred_at)} ${fmtTimeAr(payload.occurred_at)}\n` +
          `المصاب/المصابون: ${employeeNames}\n` +
          `وصف الحادثة: ${payload.incident_description || ''}`;
        const groupMsg = `🚑 تقرير تحقيق إصابة عمل جديد\n${details}`;
        const personMsg = `✅ تم حفظ تقرير تحقيق الإصابة الذي أدخلته بنجاح\n${details}`;
        await sendToGroup('textmebot_group_safety', groupMsg, 'تقرير إصابة عمل جديد (جروب السلامة)');
        await sendToPerson(payload.reported_by_phone, personMsg, 'تأكيد إدخال تقرير إصابة عمل');
        const ids = await getApprovedUserIdsByRole(['safety']);
        await insertNotificationForUsers(ids, {
          title: `تقرير إصابة عمل جديد — ${payload.department || ''}`,
          body: payload.incident_description || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      // ------------------------------------------------------------------
      // قسم "المخزون والقطع" الجديد بالصيانة (راجع routes/inventory.js
      // وschema.sql: جدول part_requests لشرح دورة الحالة الكاملة). لا يوجد
      // جروب واتساب مخصّص لـ"مسؤول المخزون" أو "المصمم" (خلافًا لأقسام
      // الإنتاج/الصيانة/السلامة الأربعة) — رسالتهم الشخصية تصل عبر
      // sendToPersonsByRole أعلاه بدل جروب.
      // ------------------------------------------------------------------
      case 'part_request_created': {
        const needsDesign = Boolean(payload.needs_design);
        const msg =
          `${needsDesign ? '🎨 طلب قطعة يحتاج تصميمًا' : '📦 طلب قطعة جديد بانتظار الصرف'}\n` +
          `رقم الطلب: ${payload.id ?? ''}\n` +
          `القطعة: ${payload.item_name || ''} (الكمية: ${payload.quantity ?? 1})\n` +
          `${payload.notes ? `ملاحظات: ${payload.notes}\n` : ''}` +
          `اسم الطالب: ${payload.requested_by || ''}`;
        await sendToGroup(
          'textmebot_group_maintenance',
          msg,
          needsDesign ? 'طلب قطعة يحتاج تصميم (جروب الصيانة)' : 'طلب قطعة جديد (جروب الصيانة)'
        );
        const managerIds = await getApprovedUserIdsByRole(['maintenance_manager']);
        const roleIds = needsDesign
          ? await sendToPersonsByRole(['designer'], msg, 'طلب قطعة يحتاج تصميم (للمصمم)')
          : await sendToPersonsByRole(['inventory_manager'], msg, 'طلب قطعة جديد (لمسؤول المخزون)');
        await insertNotificationForUsers([...roleIds, ...managerIds], {
          title: needsDesign
            ? `طلب قطعة يحتاج تصميم — ${payload.item_name || ''}`
            : `طلب قطعة جديد بانتظار الصرف — ${payload.item_name || ''}`,
          body: payload.notes || '',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'part_request_designed': {
        // requester_phone يصل مُلحقًا من routes/inventory.js (وليس عمودًا في
        // جدول part_requests نفسه) — جُلب بجلب رقم جوال requested_by_user
        // قبل استدعاء notifyEvent، بنفس أسلوب created_by_phone في
        // work_order_completed أعلاه.
        const details =
          `القطعة: ${payload.item_name || ''} (الكمية: ${payload.quantity ?? 1})\n` +
          `${payload.design_notes ? `ملاحظات التصميم: ${payload.design_notes}\n` : ''}` +
          `اسم المصمم: ${payload.designed_by || ''}`;
        const requesterMsg = `🎨 تم الانتهاء من تصميم القطعة التي طلبتها — أصبحت بانتظار الصرف من المخزون\n${details}`;
        await sendToPerson(payload.requester_phone, requesterMsg, 'تصميم قطعة جاهز (لصاحب الطلب)');
        const managerMsg = `🎨 تصميم جاهز — القطعة الآن بانتظار الصرف\n${details}`;
        const inventoryIds = await sendToPersonsByRole(['inventory_manager'], managerMsg, 'تصميم قطعة جاهز (لمسؤول المخزون)');
        const managerIds = await getApprovedUserIdsByRole(['maintenance_manager']);
        await insertNotificationForUsers([payload.requested_by_user, ...inventoryIds, ...managerIds], {
          title: `تصميم القطعة "${payload.item_name || ''}" جاهز`,
          body: 'أصبحت بانتظار الصرف من المخزون',
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'part_request_issued': {
        // requester_phone مُلحق من routes/inventory.js — راجع تعليق
        // part_request_designed أعلاه لنفس السبب.
        const details = `القطعة: ${payload.item_name || ''} (الكمية: ${payload.quantity ?? 1})\nصرفها: ${payload.issued_by || ''}`;
        const requesterMsg = `📦 تم صرف القطعة التي طلبتها من المخزون\n${details}`;
        await sendToPerson(payload.requester_phone, requesterMsg, 'صرف قطعة (لصاحب الطلب)');
        await insertNotificationForUsers([payload.requested_by_user], {
          title: `تم صرف القطعة "${payload.item_name || ''}"`,
          body: `الكمية: ${payload.quantity ?? 1}`,
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'part_request_returned': {
        // إشعار داخلي فقط (بلا واتساب) — سجل متابعة داخلي لمسؤولي المخزون
        // والصيانة، ليس حدثًا يستحق رسالة واتساب لأي طرف.
        const ids = await getApprovedUserIdsByRole(['inventory_manager', 'maintenance_manager']);
        await insertNotificationForUsers(ids, {
          title: `تم إرجاع القطعة "${payload.item_name || ''}" للمخزون`,
          body: payload.return_notes || `الكمية: ${payload.quantity ?? 1}`,
          eventType,
          refId: payload.id,
        });
        break;
      }

      // ------------------------------------------------------------------
      // "العهدة" (راجع routes/custody.js وschema.sql: جدولا custody_items
      // وcustody_assignments) — إشعار داخل التطبيق فقط (بلا واتساب)، بنفس
      // منطق part_request_returned أعلاه: سجل متابعة داخلي لمسؤولي المخزون
      // والصيانة فقط.
      // ------------------------------------------------------------------
      case 'custody_assigned': {
        const ids = await getApprovedUserIdsByRole(['inventory_manager', 'maintenance_manager']);
        await insertNotificationForUsers(ids, {
          title: `تم تسليم عهدة: ${payload.item_name || ''}`,
          body: `إلى: ${payload.assigned_to || ''}` +
            (payload.expected_return_at ? ` — الإرجاع المتوقع: ${fmtDateAr(payload.expected_return_at)}` : ''),
          eventType,
          refId: payload.id,
        });
        break;
      }

      case 'custody_returned': {
        const ids = await getApprovedUserIdsByRole(['inventory_manager', 'maintenance_manager']);
        await insertNotificationForUsers(ids, {
          title: `تم استرجاع عهدة: ${payload.item_name || ''}`,
          body: payload.return_notes || `من: ${payload.assigned_to || ''}`,
          eventType,
          refId: payload.id,
        });
        break;
      }

      default:
        break; // أحداث التقارير (production_report_*) تُدار مباشرة في مكانها، ليست هنا
    }
  } catch (err) {
    console.error(`[notifications] خطأ غير متوقع أثناء معالجة الحدث "${eventType}":`, err.message);
  }
}

module.exports = { notifyEvent, PRODUCTION_GROUP_KEY };
