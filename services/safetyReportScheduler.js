// جدولة تقارير السلامة التلقائية (أسبوعي/شهري) — بدون أي ضغط زر من أحد،
// بنفس نمط services/maintenanceReportScheduler.js تمامًا: السيرفر يفحص
// بنفسه كل ساعة هل حان وقت إرسال تقرير جديد، بالاعتماد على آخر وقت إرسال
// محفوظ في site_settings — يضمن الاستمرار الصحيح حتى لو أُعيد تشغيل
// السيرفر. تصاريح السلامة غير مقسَّمة حسب المصنع في جروب واتساب مستقل لكل
// قسم (خلافًا للإنتاج) — جروب واحد فقط (textmebot_group_safety) يستلم كل
// التقارير التلقائية بغض النظر عن الموقع.
//
// ملاحظة: "أسبوعي" هنا تعني كل ٧ أيام تقريبًا من آخر إرسال (وليس مرتبطًا
// بيوم محدد كتقرير الإنتاج الأسبوعي)، و"شهري" كل ٣٠ يومًا تقريبًا — نفس
// التبسيط المستخدم في تقارير الصيانة ولنفس السبب. لو رغبتم لاحقًا بربط
// التقرير الأسبوعي بيوم/ساعة محددين (بنفس أسلوب سبت الساعة ١١ في
// services/reportScheduler.js)، هذا يحتاج تعديلًا منفصلًا صريحًا.
'use strict';

const { pool } = require('../config/db');
const { fireWebhook } = require('./webhooks');
const { generateSafetyReport } = require('./safetyReport');
const { sendWhatsappText } = require('./textmebot');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // فحص كل ساعة
const FIRST_CHECK_DELAY_MS = 150 * 1000; // بعد دقيقتين ونصف من إقلاع السيرفر (بعد سكجولري الإنتاج والصيانة)
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

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
  const settingKey = `safety_report_last_${cadence}`;
  const lastSentRaw = await getSetting(settingKey);
  const lastSent = lastSentRaw ? new Date(lastSentRaw) : null;
  const now = new Date();

  if (lastSent && now.getTime() - lastSent.getTime() < intervalMs) return;

  const from = lastSent || new Date(now.getTime() - intervalMs);
  try {
    const report = await generateSafetyReport({ from: from.toISOString(), to: now.toISOString() });
    if (report.totalCount > 0) {
      fireWebhook(`safety_report_${cadence}`, {
        from: from.toISOString(),
        to: now.toISOString(),
        report_url: report.absoluteUrl,
        total_count: report.totalCount,
        approved_count: report.approvedCount,
        rejected_count: report.rejectedCount,
      });

      const groupId = await getSetting('textmebot_group_safety');
      if (groupId) {
        const cadenceLabel = cadence === 'weekly' ? 'أسبوعي' : 'شهري';
        const message =
          `تقرير سلامة ${cadenceLabel}\n` +
          `المدة: ${from.toLocaleDateString('ar-EG')} إلى ${now.toLocaleDateString('ar-EG')}\n` +
          `إجمالي طلبات التصاريح: ${report.totalCount} — مقبولة: ${report.approvedCount} — مرفوضة: ${report.rejectedCount}\n` +
          `رابط التقرير: ${report.absoluteUrl}`;
        const sendResult = await sendWhatsappText(groupId, message);
        if (!sendResult.ok) {
          console.error(`[safetyReportScheduler] تعذّر إرسال تقرير ${cadence} لجروب السلامة عبر TextMeBot:`, sendResult.error || sendResult.statusCode);
        }
      } else {
        console.log(`[safetyReportScheduler] لا يوجد جروب واتساب مضبوط للسلامة (textmebot_group_safety) — تم إنشاء التقرير بدون إرسال.`);
      }
    }
    await setSetting(settingKey, now.toISOString());
  } catch (err) {
    console.error(`[safetyReportScheduler] تعذّر إنشاء تقرير سلامة ${cadence}:`, err.message);
  }
}

function startSafetyReportScheduler() {
  const tick = async () => {
    await checkAndSendFor('weekly', WEEKLY_MS);
    await checkAndSendFor('monthly', MONTHLY_MS);
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[safetyReportScheduler] جدولة تقارير السلامة الأسبوعية/الشهرية مفعّلة.');
}

module.exports = { startSafetyReportScheduler };
