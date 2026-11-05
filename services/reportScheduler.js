// جدولة تقارير الإنتاج التلقائية (أسبوعي/شهري) — بدون أي ضغط زر من أحد.
// السيرفر يفحص بنفسه كل ساعة هل حان وقت إرسال تقرير جديد لكل مصنع، بالاعتماد
// على آخر وقت إرسال محفوظ في site_settings (نفس جدول إعدادات الموقع
// المستخدم لاسم المصنع وتذييل التقارير) — هذا يضمن الاستمرار الصحيح حتى لو
// أُعيد تشغيل السيرفر (لا يعتمد على مؤقّت في الذاكرة يُصفَّر كل إقلاع).
//
// التقرير الأسبوعي (٢٠٢٦-٠٩): لم يعد "كل ٧ أيام تقريبًا من آخر إرسال"، بل
// مرتبط بيوم/وقت محددين فعليًا بناءً على طلب العميل: يُرسل كل يوم **سبت عند
// الساعة ١١ صباحًا (بتوقيت المصنع المحلي)**، ويغطي أسبوع الإنتاج الفعلي
// **من السبت إلى الخميس** (الجمعة إجازة، فلا تدخل ضمن المدة). راجع
// checkAndSendWeeklyAnchored أدناه.
//
// "شهري" ما زال كما كان: كل ٣٠ يومًا تقريبًا من آخر إرسال (بلا ربط بيوم
// محدد من الشهر) — تبسيطًا، لأن العميل لم يطلب تغيير هذا الجزء.
'use strict';

const { pool } = require('../config/db');
const { fireWebhook } = require('./webhooks');
const { generateProductionReport } = require('./productionReport');
const { sendWhatsappText } = require('./textmebot');
const { PRODUCTION_GROUP_KEY, notifyEvent } = require('./notifications');
const { FACILITIES } = require('./facilities');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // فحص كل ساعة
const FIRST_CHECK_DELAY_MS = 60 * 1000; // أول فحص بعد دقيقة من إقلاع السيرفر
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/// يبني التقرير الفعلي ويرسله (webhook + واتساب TextMeBot لجروب المصنع
/// المعني) — مشتركة بين مسار "الأسبوعي المرتبط بيوم السبت" و"الشهري
/// الدوّار" القديم، لتفادي تكرار نفس منطق الإرسال مرتين.
async function generateAndDispatch(facility, cadence, from, to) {
  const report = await generateProductionReport({ facility, from: from.toISOString(), to: to.toISOString(), cadence });
  // لا فائدة من إشعار جروب المصنع بتقرير فاضي بلا أي باتش أو بلاغ خلال المدة
  if (report.batchCount > 0 || report.incidentCount > 0) {
    fireWebhook(
      `production_report_${cadence}`,
      {
        facility,
        from: from.toISOString(),
        to: to.toISOString(),
        report_url: report.absoluteUrl,
        total_quantity: report.totalQuantity,
        batch_count: report.batchCount,
      },
      facility
    );

    // إرسال مباشر عبر TextMeBot لجروب واتساب قسم الإنتاج المعني (رجال/نساء
    // فقط — راجع PRODUCTION_GROUP_KEY في services/notifications.js) إن كان
    // مُعرَّفًا في إعدادات الموقع. لا تحذيرات تظهر لأحد لو المفتاح أو الجروب
    // غير مضبوطين بعد؛ التقرير الأسبوعي/الشهري تلقائي بلا واجهة تفاعلية
    // أصلًا، فقط نسجّل السبب في اللوق.
    const groupSettingKey = PRODUCTION_GROUP_KEY[facility];
    const groupId = groupSettingKey ? await getSetting(groupSettingKey) : null;
    if (groupId) {
      const cadenceLabel = cadence === 'weekly' ? 'أسبوعي' : 'شهري';
      const message =
        `تقرير إنتاج ${cadenceLabel} — ${facility}\n` +
        `المدة: ${from.toLocaleDateString('ar-EG')} إلى ${to.toLocaleDateString('ar-EG')}\n` +
        `إجمالي الكمية: ${report.totalQuantity} — عدد الباتشات: ${report.batchCount}\n` +
        `رابط التقرير: ${report.absoluteUrl}`;
            const sendResult = await sendWhatsappText(groupId, message);
      if (!sendResult.ok) {
        console.error(`[reportScheduler] تعذّر إرسال تقرير ${cadence} لجروب ${facility} عبر TextMeBot:`, sendResult.error || sendResult.statusCode);
        notifyEvent('production_report_send_failed', { facility, report_url: report.absoluteUrl });
      }
    } else {
      console.log(`[reportScheduler] لا يوجد جروب واتساب مضبوط لـ "${facility}" (${groupSettingKey || 'بلا مفتاح إعدادات لهذا المصنع'}) — تم إنشاء التقرير بدون إرسال.`);
    }
  }
  return report;
}

/// التقرير الشهري — بلا تغيير عن السابق: كل ٣٠ يومًا تقريبًا من آخر إرسال.
async function checkAndSendMonthly(facility) {
  const settingKey = `report_last_monthly::${facility}`;
  const lastSentRaw = await getSetting(settingKey);
  const lastSent = lastSentRaw ? new Date(lastSentRaw) : null;
  const now = new Date();

  if (lastSent && now.getTime() - lastSent.getTime() < MONTHLY_MS) return;

  const from = lastSent || new Date(now.getTime() - MONTHLY_MS);
  try {
    await generateAndDispatch(facility, 'monthly', from, now);
    await setSetting(settingKey, now.toISOString());
  } catch (err) {
    // خطأ متوقع جدًا لو "رابط السيرفر العام" لم يُضبَط بعد في الإعدادات —
    // نتجاهل ونحاول مجددًا في الفحص القادم، وليس مرة كل ساعة تكرارًا للخطأ
    // بلا داعٍ في اللوق (نطبعه مرة فقط هنا، وهذا كافٍ).
    console.error(`[reportScheduler] تعذّر إنشاء تقرير monthly لـ "${facility}":`, err.message);
  }
}

/// التقرير الأسبوعي المرتبط بيوم السبت الساعة ١١ صباحًا — يفحص كل ساعة هل
/// الوقت المحلي الآن هو "يوم سبت بعد الساعة ١١ صباحًا" ولم يُرسل تقرير هذا
/// السبت بالذات بعد؛ لو كذلك يبني تقريرًا يغطي أسبوع الإنتاج الفائت بالكامل
/// (السبت الماضي ٠٠:٠٠ وحتى الخميس الفائت ٢٣:٥٩، بدون يوم الجمعة).
///
/// كل الحسابات تتم بالتوقيت المحلي المُعرَّف عبر إعداد الموقع
/// "report_timezone_offset_hours" (افتراضي ٣ = توقيت السعودية/الخليج بلا
/// توقيت صيفي) لتفادي الاعتماد على المنطقة الزمنية لنظام تشغيل السيرفر
/// نفسه والتي قد تكون UTC.
async function checkAndSendWeeklyAnchored(facility) {
  const tzOffsetHours = Number(await getSetting('report_timezone_offset_hours'));
  const offsetMs = (Number.isFinite(tzOffsetHours) ? tzOffsetHours : 3) * 60 * 60 * 1000;

  const now = new Date();
  const localNowMs = now.getTime() + offsetMs;
  const localNow = new Date(localNowMs); // نقرأ حقول UTC منه فقط، فهو مجرد "ساعة محلية" مُزاحة

  const localDay = localNow.getUTCDay(); // 0=أحد .. 6=سبت
  const localHour = localNow.getUTCHours();
  if (localDay !== 6 || localHour < 11) return; // ليس بعد يوم السبت الساعة ١١ صباحًا محليًا

  // بداية اليوم المحلي الحالي (السبت)، مُعاد تحويلها لطابع زمني UTC صحيح.
  const localMidnightMs =
    Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - offsetMs;
  const todayKey = new Date(localMidnightMs).toISOString().slice(0, 10); // مفتاح يوم فريد لمنع الإرسال المكرر

  const settingKey = `report_last_weekly::${facility}`;
  const lastSentKey = await getSetting(settingKey);
  if (lastSentKey === todayKey) return; // أُرسل بالفعل عن سبت اليوم

  const fridayStartMs = localMidnightMs - DAY_MS;
  const to = new Date(fridayStartMs - 1); // نهاية يوم الخميس ٢٣:٥٩:٥٩.٩٩٩ محليًا
  const from = new Date(localMidnightMs - 7 * DAY_MS); // بداية يوم السبت الماضي محليًا

  try {
    await generateAndDispatch(facility, 'weekly', from, to);
    await setSetting(settingKey, todayKey);
  } catch (err) {
    console.error(`[reportScheduler] تعذّر إنشاء تقرير weekly لـ "${facility}":`, err.message);
  }
}

function startReportScheduler() {
  const tick = async () => {
    for (const facility of FACILITIES) {
      await checkAndSendWeeklyAnchored(facility);
      await checkAndSendMonthly(facility);
    }
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[reportScheduler] جدولة تقارير الإنتاج الأسبوعية (سبت ١١ص) والشهرية مفعّلة.');
}

module.exports = { startReportScheduler };
