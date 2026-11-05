'use strict';
// ============================================================================
// تنبيهات «إجازات الموظفين» — تلقائية بلا ضغط زر (نفس نمط جداول التقارير): السيرفر يفحص بنفسه كل
// ساعة، ويرسل كل تنبيه جديد مرة واحدة فقط (سجل leave_alert_log) إلى:
//   - إشعار داخل التطبيق + Push لكل مسؤول (الأدوار المسموح لها بقسم الإجازات + مدير النظام).
//   - جروب واتساب (رسالة واحدة مجمّعة لكل فحص): textmebot_group_leaves، وإن لم يُضبط فجروب إنتاج
//     مصنع الرجال textmebot_group_production_men (القسم خاص بمصنع الرجال)، ثم جروب العمل الإضافي
//     textmebot_group_overtime، وأخيرًا جروب الصيانة textmebot_group_maintenance.
//
// أنواع التنبيهات:
//   cap       رصيد الموظف وصل الحد الأقصى (٤٢ يومًا) — يتكرر فقط إن نزل الرصيد عن الحد ثم عاد إليه
//   late      الموظف تجاوز العودة المتوقعة ولم تُسجَّل مباشرته (مرة لكل إجازة)
//   soon      إجازة تبدأ خلال مدة قريبة (الافتراضي ٧ أيام) (مرة لكل إجازة)
//   noreturn  إجازة بلا تاريخ عودة (مرة لكل إجازة)
// ولا تُرسل ليلًا: الفحص يمرّ فقط بين السابعة صباحًا والثامنة مساءً بتوقيت الرياض.
// ============================================================================

const { pool } = require('../config/db');
const C = require('../lib/leaveCalc');
const svc = require('./leaveService');
const { ensureLeaveTables } = require('./leaveSchema');
const { sendWhatsappText } = require('./textmebot');
const { sendPushToUsers } = require('./push');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 4 * 60 * 1000;
const SEND_FROM_HOUR = 7;
const SEND_UNTIL_HOUR = 20;
const WHATSAPP_MAX = 3500;
const MAX_INDIVIDUAL_NOTIFICATIONS = 10;

function riyadhHour(now) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', hour12: false }).format(now);
  return Number(h) % 24;
}

function who(v) {
  return v.employee_number ? `${v.name} (${v.employee_number})` : v.name;
}

function whenText(n) {
  return n === 1 ? 'غدًا' : `بعد ${n} أيام`;
}

/** يجمع التنبيهات المستحقة من عروض الموظفين (بلا لمس القاعدة). */
function collectAlerts(views, today, settings) {
  const out = [];
  for (const v of views) {
    if (v.at_cap) {
      out.push({ kind: 'cap', refKey: String(v.id), employeeId: v.id, text: `${who(v)}: رصيد إجازته وصل الحد الأقصى (${C.capDays(settings)} يومًا) وأي استحقاق جديد يُسقط الأقدم` });
    }
    for (const a of v.alerts) {
      if (!a.leave_id) continue;
      if (a.code === 'late') {
        out.push({ kind: 'late', refKey: `${a.leave_id}:${a.expected || ''}`, employeeId: v.id, text: `${who(v)}: ${a.text}` });
      } else if (a.code === 'soon') {
        out.push({ kind: 'soon', refKey: `${a.leave_id}:${a.start || ''}`, employeeId: v.id, text: `${who(v)}: ${a.text}` });
      } else if (a.code === 'no_return') {
        out.push({ kind: 'noreturn', refKey: String(a.leave_id), employeeId: v.id, text: `${who(v)}: ${a.text}` });
      }
    }
  }
  return out;
}

async function whatsappGroup() {
  const { rows } = await pool.query(
    `SELECT key, value FROM site_settings WHERE key IN ('textmebot_group_leaves', 'textmebot_group_production_men', 'textmebot_group_overtime', 'textmebot_group_maintenance')`
  );
  const by = {};
  for (const r of rows) by[r.key] = r.value;
  return by.textmebot_group_leaves || by.textmebot_group_production_men || by.textmebot_group_overtime || by.textmebot_group_maintenance || null;
}

async function recipients() {
  // نفس من يحق لهم دخول القسم (routes/leaves.js): مدير النظام + مسؤول الصيانة + مسؤول الإنتاج/السلامة
  // غير المقيَّد بمصنع أو المقيَّد بمصنع الرجال.
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE status = 'approved'
        AND (role IN ('admin', 'maintenance_manager')
          OR (role = 'production_manager' AND (production_facility IS NULL OR production_facility = $1))
          OR (role = 'safety' AND (safety_facility IS NULL OR safety_facility = $1)))`,
    [svc.MEN_FACILITY]
  );
  return rows.map((r) => Number(r.id));
}

function buildWhatsappText(alerts, todayIso) {
  const lines = [`تنبيهات إجازات الموظفين — ${todayIso}`, ''];
  const sections = [
    ['late', 'متأخرون عن المباشرة'],
    ['noreturn', 'إجازات بلا تاريخ عودة'],
    ['soon', 'إجازات تبدأ قريبًا'],
    ['cap', 'وصل رصيدهم الحد الأقصى'],
  ];
  for (const [kind, title] of sections) {
    const group = alerts.filter((a) => a.kind === kind);
    if (group.length === 0) continue;
    lines.push(`${title}:`);
    for (const a of group) lines.push(`- ${a.text}`);
    lines.push('');
  }
  let text = lines.join('\n').trim();
  if (text.length > WHATSAPP_MAX) text = `${text.slice(0, WHATSAPP_MAX).trimEnd()}\n… (القائمة طويلة — التفاصيل في قسم إجازات الموظفين بالتطبيق)`;
  return text;
}

let running = false;

/**
 * يفحص ويرسل. الخيارات: now (للاختبار)، force (تجاوز نافذة الساعات)، dryRun (يرجع المرشّحين دون حفظ أو إرسال).
 */
async function runLeaveAlerts({ now = new Date(), force = false, dryRun = false } = {}) {
  if (running) return { skipped: 'running' };
  running = true;
  try {
    await ensureLeaveTables();
    const settings = await svc.getSettings();
    if (!settings.alertsEnabled && !dryRun) return { skipped: 'disabled' };
    if (!force && !dryRun) {
      const h = riyadhHour(now);
      if (h < SEND_FROM_HOUR || h >= SEND_UNTIL_HOUR) return { skipped: 'quiet_hours' };
    }

    const { today, views } = await svc.listEmployees(now);
    const candidates = collectAlerts(views, C.toDay(today), settings);

    if (dryRun) return { dry_run: true, today, candidates };

    // أعد تفعيل تنبيه «وصل الحد الأقصى» للموظفين الذين نزل رصيدهم عنه.
    const capIds = views.filter((v) => v.at_cap).map((v) => String(v.id));
    if (capIds.length > 0) await pool.query(`DELETE FROM leave_alert_log WHERE kind = 'cap' AND ref_key <> ALL($1)`, [capIds]);
    else await pool.query(`DELETE FROM leave_alert_log WHERE kind = 'cap'`);

    const fresh = [];
    for (const a of candidates) {
      const ins = await pool.query(
        'INSERT INTO leave_alert_log (kind, ref_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING kind',
        [a.kind, a.refKey]
      );
      if (ins.rows.length > 0) fresh.push(a);
    }
    if (fresh.length === 0) return { today, sent: 0, candidates: candidates.length };

    // داخل التطبيق + Push
    const userIds = await recipients();
    const notes = fresh.length > MAX_INDIVIDUAL_NOTIFICATIONS
      ? [{ title: 'تنبيهات إجازات الموظفين', body: `${fresh.length} تنبيهًا جديدًا — افتح قسم إجازات الموظفين لمراجعتها`, refId: null }]
      : fresh.map((a) => ({ title: 'تنبيه إجازات', body: a.text, refId: a.employeeId }));
    for (const n of notes) {
      for (const uid of userIds) {
        try {
          await pool.query(
            'INSERT INTO notifications (user_id, title, body, event_type, ref_id) VALUES ($1, $2, $3, $4, $5)',
            [uid, n.title, n.body, 'leave_alert', n.refId]
          );
        } catch (err) {
          console.error('[leaveAlerts] تعذّر حفظ إشعار داخل التطبيق:', err.message);
        }
      }
      sendPushToUsers(userIds, { title: n.title, body: n.body });
    }

    // واتساب: رسالة واحدة مجمّعة
    let whatsapp = 'no_group';
    const group = await whatsappGroup();
    if (group) {
      const result = await sendWhatsappText(group, buildWhatsappText(fresh, today));
      whatsapp = result && result.ok ? 'sent' : 'failed';
      if (whatsapp === 'failed') console.error('[leaveAlerts] تعذّر إرسال تنبيهات الإجازات لجروب واتساب:', (result && (result.error || result.statusCode)) || '');
    } else {
      console.log('[leaveAlerts] لا يوجد جروب واتساب مضبوط للإجازات (textmebot_group_leaves/production_men/overtime/maintenance) — اكتفينا بالإشعارات داخل التطبيق.');
    }
    return { today, sent: fresh.length, whatsapp, alerts: fresh.map((a) => ({ kind: a.kind, text: a.text })) };
  } finally {
    running = false;
  }
}

function startLeaveAlertScheduler() {
  const tick = async () => {
    try {
      await runLeaveAlerts();
    } catch (err) {
      console.error('[leaveAlerts] فشل فحص تنبيهات الإجازات:', err.message);
    }
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[leaveAlerts] جدولة تنبيهات إجازات الموظفين مفعّلة (فحص كل ساعة، بين 7 صباحًا و8 مساءً بتوقيت الرياض).');
}

module.exports = { runLeaveAlerts, startLeaveAlertScheduler, collectAlerts, buildWhatsappText };
