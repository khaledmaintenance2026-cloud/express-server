// جدولة تقارير الصيانة التلقائية (أسبوعي/شهري/سنوي) — بدون أي ضغط زر من أحد،
// بنفس نمط services/reportScheduler.js (تقارير الإنتاج) تمامًا: السيرفر يفحص
// بنفسه كل ساعة هل حان وقت إرسال تقرير جديد، بالاعتماد على آخر وقت إرسال
// محفوظ في site_settings — يضمن الاستمرار الصحيح حتى لو أُعيد تشغيل
// السيرفر. الفرق الوحيد: تقارير الصيانة غير مقسَّمة حسب المصنع (نظام واحد
// موحّد)، وتُرسَل دائمًا لجروب "الصيانة" فقط (وليس جروبات الإنتاج).
//
// ملاحظة: "أسبوعي" هنا تعني كل ٧ أيام تقريبًا، و"شهري" كل ٣٠ يومًا تقريبًا،
// و"سنوي" كل ٣٦٥ يومًا تقريبًا — كلها من آخر إرسال، نفس التبسيط المستخدم في
// تقارير الإنتاج ولنفس السبب.
'use strict';

const { pool } = require('../config/db');
const { fireWebhook } = require('./webhooks');
const { generateMaintenanceReport } = require('./maintenanceReport');
const { sendWhatsappText } = require('./textmebot');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // فحص كل ساعة
const FIRST_CHECK_DELAY_MS = 90 * 1000; // بعد دقيقة ونصف من إقلاع السيرفر (بعد سكجولر الإنتاج)
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;
const YEARLY_MS = 365 * 24 * 60 * 60 * 1000;

const CADENCE_LABELS = { weekly: 'أسبوعي', monthly: 'شهري', yearly: 'سنوي' };

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0] && rows[0].value ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}

async function checkAndSendFor(cadence, intervalMs) {
  const settingKey = `maintenance_report_last_${cadence}`;
  const lastSentRaw = await getSetting(settingKey);
  const lastSent = lastSentRaw ? new Date(lastSentRaw) : null;
  const now = new Date();

  if (lastSent && now.getTime() - lastSent.getTime() < intervalMs) return;

  const from = lastSent || new Date(now.getTime() - intervalMs);
  try {
    const report = await generateMaintenanceReport({ from: from.toISOString(), to: now.toISOString() });
    if (report.totalCount > 0 || report.permitsCount > 0) {
      fireWebhook(`maintenance_report_${cadence}`, {
        from: from.toISOString(),
        to: now.toISOString(),
        report_url: report.absoluteUrl,
        total_count: report.totalCount,
        permits_count: report.permitsCount,
      });

      const groupId = await getSetting('textmebot_group_maintenance');
      if (groupId) {
        const cadenceLabel = CADENCE_LABELS[cadence] || cadence;
        const message =
          `تقرير صيانة ${cadenceLabel}\n` +
          `المدة: ${from.toLocaleDateString('ar-EG')} إلى ${now.toLocaleDateString('ar-EG')}\n` +
          `إجمالي البلاغات/الأوامر: ${report.totalCount} — مُنجَز: ${report.completedCount}\n` +
          `تصاريح العمل المرتبطة: ${report.permitsCount}\n` +
          `رابط التقرير: ${report.absoluteUrl}`;
        const sendResult = await sendWhatsappText(groupId, message);
        if (!sendResult.ok) {
          console.error(`[maintenanceReportScheduler] تعذّر إرسال تقرير ${cadence} لجروب الصيانة عبر TextMeBot:`, sendResult.error || sendResult.statusCode);
        }
      } else {
        console.log(`[maintenanceReportScheduler] لا يوجد جروب واتساب مضبوط للصيانة (textmebot_group_maintenance) — تم إنشاء التقرير بدون إرسال.`);
      }
    }
    await setSetting(settingKey, now.toISOString());
  } catch (err) {
    console.error(`[maintenanceReportScheduler] تعذّر إنشاء تقرير صيانة ${cadence}:`, err.message);
  }
}

function startMaintenanceReportScheduler() {
  const tick = async () => {
    await checkAndSendFor('weekly', WEEKLY_MS);
    await checkAndSendFor('monthly', MONTHLY_MS);
    await checkAndSendFor('yearly', YEARLY_MS);
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[maintenanceReportScheduler] جدولة تقارير الصيانة الأسبوعية/الشهرية/السنوية مفعّلة.');
}

module.exports = { startMaintenanceReportScheduler };