// جدولة تقارير الصيانة التلقائية (أسبوعي/شهري/سنوي) — بدون أي ضغط زر من أحد،
// بنفس نمط services/reportScheduler.js (تقارير الإنتاج): السيرفر يفحص بنفسه كل
// ساعة هل حان وقت إرسال تقرير جديد، بالاعتماد على ما هو محفوظ في site_settings —
// يضمن الاستمرار الصحيح حتى لو أُعيد تشغيل السيرفر. الفرق الوحيد: تقارير الصيانة
// غير مقسَّمة حسب المصنع (نظام واحد موحّد)، وتُرسَل دائمًا لجروب "الصيانة" فقط.
//
// • «أسبوعي» = كل ٧ أيام تقريبًا، و«سنوي» = كل ٣٦٥ يومًا تقريبًا، من آخر إرسال.
// • «شهري» (تعديل 2026-10-26 بطلب المالك): يُرسَل تلقائيًا **يوم ٢٥ من كل شهر**
//   الساعة ٨ صباحًا بتوقيت الرياض، ويغطي دورة كاملة من ٢٥ الشهر الماضي إلى ٢٤ من
//   الشهر الحالي (بلا تداخل ولا فجوة بين تقريرين). لو كان السيرفر مطفأً يوم ٢٥
//   يُرسَل عند أول فحص بعد عودته (مرة واحدة لكل دورة). عند أول تشغيل بعد هذا
//   التعديل لا يُرسَل شيء فورًا، بل يُسجَّل الشهر الحالي ويبدأ الإرسال من ٢٥ الشهر
//   القادم.
'use strict';

const { pool } = require('../config/db');
const { fireWebhook } = require('./webhooks');
const { generateMaintenanceReport } = require('./maintenanceReport');
const { sendWhatsappText } = require('./textmebot');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // فحص كل ساعة
const FIRST_CHECK_DELAY_MS = 90 * 1000; // بعد دقيقة ونصف من إقلاع السيرفر (بعد سكجولر الإنتاج)
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const YEARLY_MS = 365 * 24 * 60 * 60 * 1000;

// التقرير الشهري: يوم ٢٥ الساعة ٨ صباحًا بتوقيت الرياض (UTC+3 بلا توقيت صيفي).
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHLY_DAY = 25;
const MONTHLY_HOUR = 8;
const MONTHLY_CYCLE_KEY = 'maintenance_report_last_monthly_cycle';

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

/// أول لحظة من يوم (y, m من 0 إلى 11, d) بتوقيت الرياض، كـ Date (UTC).
function riyadhMidnight(y, m, d) {
  return new Date(Date.UTC(y, m, d) - RIYADH_OFFSET_MS);
}

/// الدورة الشهرية المستحقة الآن: آخر يوم ٢٥ (الساعة ٨ صباحًا بتوقيت الرياض) مرّ.
/// تعيد {key: 'YYYY-MM' (شهر الإرسال)، from: أول يوم في الدورة (٢٥ الشهر السابق)،
/// to: آخر يوم في الدورة (٢٤ من شهر الإرسال)} — كلها بتوقيت الرياض.
function monthlyDueCycle(now) {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS); // getUTC* تعطي ساعة الرياض
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  const day = local.getUTCDate();
  const passed = day > MONTHLY_DAY || (day === MONTHLY_DAY && local.getUTCHours() >= MONTHLY_HOUR);
  if (!passed) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  let py = y;
  let pm = m - 1;
  if (pm < 0) { pm = 11; py -= 1; }
  return {
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    from: riyadhMidnight(py, pm, MONTHLY_DAY),
    to: riyadhMidnight(y, m, MONTHLY_DAY - 1),
  };
}

const dateLabel = (d) => new Intl.DateTimeFormat('ar-EG', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'numeric', year: 'numeric' }).format(d);

/// يُنشئ التقرير ويرسله (ويب هوك + جروب الصيانة). يرمي الخطأ لو تعذّر إنشاء التقرير
/// كي يُعاد المحاولة في الفحص التالي؛ أما فشل واتساب وحده فيُسجَّل فقط (كما كان).
async function deliverReport(cadence, from, to, periodText) {
  const report = await generateMaintenanceReport({ from: from.toISOString(), to: to.toISOString() });
  if (report.totalCount > 0 || report.permitsCount > 0) {
    fireWebhook(`maintenance_report_${cadence}`, {
      from: from.toISOString(),
      to: to.toISOString(),
      report_url: report.absoluteUrl,
      total_count: report.totalCount,
      permits_count: report.permitsCount,
    });

    const groupId = await getSetting('textmebot_group_maintenance');
    if (groupId) {
      const cadenceLabel = CADENCE_LABELS[cadence] || cadence;
      const message =
        `تقرير صيانة ${cadenceLabel}\n` +
        `المدة: ${periodText}\n` +
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
}

async function checkAndSendFor(cadence, intervalMs) {
  const settingKey = `maintenance_report_last_${cadence}`;
  const lastSentRaw = await getSetting(settingKey);
  const lastSent = lastSentRaw ? new Date(lastSentRaw) : null;
  const now = new Date();

  if (lastSent && now.getTime() - lastSent.getTime() < intervalMs) return;

  const from = lastSent || new Date(now.getTime() - intervalMs);
  try {
    await deliverReport(cadence, from, now, `${from.toLocaleDateString('ar-EG')} إلى ${now.toLocaleDateString('ar-EG')}`);
    await setSetting(settingKey, now.toISOString());
  } catch (err) {
    console.error(`[maintenanceReportScheduler] تعذّر إنشاء تقرير صيانة ${cadence}:`, err.message);
  }
}

/// التقرير الشهري: مرة واحدة لكل دورة (٢٥ → ٢٤)، يُرسَل عند أول فحص بعد ٨ صباح يوم ٢٥.
async function checkAndSendMonthly(now = new Date()) {
  const cycle = monthlyDueCycle(now);
  const lastKey = await getSetting(MONTHLY_CYCLE_KEY);
  if (!lastKey) {
    // أول تشغيل بعد التعديل: لا نرسل تقريرًا قديمًا فجأة، نسجّل الدورة الحالية فقط.
    await setSetting(MONTHLY_CYCLE_KEY, cycle.key);
    console.log(`[maintenanceReportScheduler] التقرير الشهري صار يُرسَل يوم ٢٥ من كل شهر — أول إرسال تلقائي في دورة تلي ${cycle.key}.`);
    return 'initialized';
  }
  if (lastKey >= cycle.key) return 'not-due';
  try {
    await deliverReport('monthly', cycle.from, cycle.to, `من ${dateLabel(cycle.from)} إلى ${dateLabel(cycle.to)}`);
    await setSetting(MONTHLY_CYCLE_KEY, cycle.key);
    return 'sent';
  } catch (err) {
    console.error('[maintenanceReportScheduler] تعذّر إنشاء تقرير صيانة monthly:', err.message);
    return 'failed';
  }
}

function startMaintenanceReportScheduler() {
  const tick = async () => {
    await checkAndSendFor('weekly', WEEKLY_MS);
    await checkAndSendMonthly();
    await checkAndSendFor('yearly', YEARLY_MS);
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[maintenanceReportScheduler] جدولة تقارير الصيانة مفعّلة: أسبوعي، وشهري يوم ٢٥ من كل شهر، وسنوي.');
}

module.exports = { startMaintenanceReportScheduler, monthlyDueCycle, checkAndSendMonthly };
