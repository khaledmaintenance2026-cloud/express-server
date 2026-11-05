// خدمة توليد تقارير الإنتاج (بمدة مخصّصة، أو أسبوعي أو شهري تلقائي) كملف HTML
// مستقل يُحفظ داخل public/uploads/reports/ (نفس نمط saveEquipmentPhoto في
// routes/safetyPermits.js) ويُخدَّم مباشرة كرابط ثابت — يسمح لأتمتة واتساب
// (n8n مثلاً) بإرسال رابط نصي بدل ملف مرفق (الأتمتة الحالية لدى العميل لا
// تدعم إرسال مرفقات، فقط رسائل نصية تتضمن رابطًا).
//
// الشكل الحالي (٢٠٢٦-٠٩) يطابق التقرير الأسبوعي الشامل النهائي الذي أرسله
// العميل كمرجع: ملخص لكل خط إنتاج على حدة (إنتاج وتوقف وباتشات وحالة تشغيلية)،
// رسم بياني مقارن، ثم جدول تفصيلي منفصل لكل خط. حل محل الشكل السابق (جدول
// واحد مدمج لكل الخطوط حسب التاريخ).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');

const REPORTS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'reports');

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0] && rows[0].value ? rows[0].value : null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDateTime(d) {
  try {
    return new Date(d).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return String(d);
  }
}

function fmtDate(d) {
  try {
    return new Date(d).toLocaleDateString('ar-EG', { dateStyle: 'medium' });
  } catch {
    return String(d);
  }
}

// تاريخ قصير DD/MM/YY يطابق شكل التقرير الأسبوعي المرجعي (مثال: 29/08/26).
//
// تصحيح مهم (٢٠٢٦-٠٩): كانت تُستخدَم هنا getUTCDate/getUTCMonth/getUTCFullYear
// بدل النظائر المحلية (بخلاف بقية دوال التنسيق في هذا الملف — fmtDate
// وfmtDateTime تستخدمان toLocaleDateString/toLocaleString بلا تحديد UTC، أي
// بالتوقيت المحلي للسيرفر). occurred_at يُخزَّن أصلًا من تاريخ/وقت يختاره
// المستخدم في التطبيق كـ DateTime محلي (بلا فارق توقيت في نص ISO المُرسَل)،
// فيفسّره Node.js كوقت محلي أيضًا عند الحفظ — استخدام getUTCDate هنا لعرضه
// لاحقًا كان يُرجعه ليوم مختلف (أبكر بيوم كامل) لأي باتش سُجِّل بتوقيت الفترة
// الليلية القريبة من منتصف الليل (٠٠:٠٠–٠٢:٥٩ تقريبًا، حسب فارق توقيت
// السيرفر عن UTC) — بالضبط الحالة الشائعة لباتشات "NIGHTLY". الحل: نطابق
// بقية الملف ونستخدم النظائر المحلية.
function fmtDateShort(d) {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// أرقام بفواصل الآلاف بالخط اللاتيني (52,085) كما في التقرير المرجعي.
function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/// يُنشئ تقرير إنتاج HTML لمصنع أو قسم واحد خلال مدة زمنية محددة (باتشات +
/// بلاغات أعطال)، يحفظه على القرص، ويعيد رابطه الكامل (مطلَق) القابل
/// للإرسال عبر واتساب. يرمي خطأ برسالة عربية واضحة (مع statusCode) لو لم
/// يكن "رابط السيرفر العام" مضبوطًا بعد في إعدادات الموقع، أو لو كانت
/// المدخلات غير صحيحة.
async function generateProductionReport({ facility, from, to, cadence }) {
  if (!facility) {
    throw Object.assign(new Error('حدد المصنع/القسم'), { statusCode: 400 });
  }

  const publicBaseUrl = await getSetting('public_base_url');
  if (!publicBaseUrl) {
    throw Object.assign(
      new Error(
        'لم يُحدَّد "رابط السيرفر العام" بعد — من لوحة التحكم، تبويب "إعدادات الموقع"، ' +
          'أضيفوا رابط الوصول من خارج المصنع (رابط Cloudflare مثلاً) في الحقل الجديد أولًا، ' +
          'وإلا فلن يعمل رابط التقرير عند فتحه من واتساب.'
      ),
      { statusCode: 400 }
    );
  }

  const fromTs = new Date(from);
  const toTs = new Date(to);
  if (isNaN(fromTs.getTime()) || isNaN(toTs.getTime()) || fromTs > toTs) {
    throw Object.assign(new Error('مدى التاريخ غير صحيح'), { statusCode: 400 });
  }
  // نشمل يوم "إلى" كاملًا لو أُرسل كتاريخ بلا وقت (نهاية اليوم = 23:59:59.999)
  const toEnd = new Date(toTs.getTime() + (24 * 60 * 60 * 1000 - 1));

  const [batchesRes, incidentsRes, factoryName, footer, shiftMinutesSetting] = await Promise.all([
    // تصحيح مهم (٢٠٢٦-٠٩): كانت الفلترة والترتيب هنا على b.created_at (وقت
    // إدخال الباتش فعليًا) بدل b.occurred_at (تاريخ الباتش "الفعلي" الذي
    // يختاره المستخدم) — بعكس GET /batches في routes/production.js الذي
    // يستخدم occurred_at عمدًا بالضبط لهذا السبب (راجع تعليقه هناك). النتيجة:
    // باتش سُجِّل اليوم بتاريخ فعلي أمس كان يظهر في تقرير اليوم لا أمس (أو
    // يُستبعَد تمامًا من تقرير أمس رغم وجوده في قائمة البيانات الخام التي
    // تعتمد occurred_at بشكل صحيح) — بالضبط ما لاحظه العميل. صُحِّح لمطابقة
    // GET /batches تمامًا.
    pool.query(
      `SELECT b.*, l.name AS line_name, l.code AS line_code
       FROM production_batches b
       LEFT JOIN production_lines l ON l.id = b.line_id
       WHERE l.location = $1 AND b.occurred_at BETWEEN $2 AND $3
       ORDER BY b.occurred_at ASC`,
      [facility, fromTs, toEnd]
    ),
    pool.query(
      `SELECT i.*, l.name AS line_name
       FROM incident_reports i
       LEFT JOIN production_lines l ON l.id = i.line_id
       WHERE l.location = $1 AND i.reported_at BETWEEN $2 AND $3
       ORDER BY i.reported_at ASC`,
      [facility, fromTs, toEnd]
    ),
    getSetting('factory_name'),
    getSetting('report_footer'),
    getSetting('production_shift_minutes_per_day'),
  ]);

  const batches = batchesRes.rows;
  const incidents = incidentsRes.rows;

  const totalQuantity = batches.reduce((sum, b) => sum + Number(b.quantity || 0), 0);
  const totalStoppageMinutes = batches.reduce((sum, b) => sum + Number(b.stoppage_minutes || 0), 0);

  // عدد أيام التقرير (شامل يوم البداية والنهاية) — يُستخدم كمقام تقديري
  // لحساب "نسبة التوقف %" لكل خط (راجع buildLineSummaries أدناه).
  const rangeDays = Math.max(1, Math.round((toEnd.getTime() - fromTs.getTime()) / (24 * 60 * 60 * 1000)));
  const shiftMinutesPerDay = Number(shiftMinutesSetting) || 480; // افتراضي: ٨ ساعات/يوم

  const { lineSummaries, byLineId } = buildLineSummaries(batches, rangeDays, shiftMinutesPerDay);

  const html = renderHtml({
    facility,
    from: fromTs,
    to: toTs,
    factoryName: factoryName || 'مصنع الماس الوطنية',
    footer: footer || '',
    incidents,
    totalQuantity,
    totalStoppageMinutes,
    batchCount: batches.length,
    lineSummaries,
    byLineId,
    cadence,
    rangeDays,
    shiftMinutesPerDay,
  });

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const token = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const filename = `${token}.html`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), html, 'utf8');

  const relativeUrl = `/uploads/reports/${filename}`;
  const absoluteUrl = `${publicBaseUrl.replace(/\/+$/, '')}${relativeUrl}`;

  return {
    relativeUrl,
    absoluteUrl,
    totalQuantity,
    batchCount: batches.length,
    incidentCount: incidents.length,
  };
}

// يحدد تصنيف "الحالة التشغيلية" النصي بناءً على نسبة التوقف % — عتبات
// تقديرية معقولة (وليست مستخرجة من صيغة رسمية، إذ لا توجد بيانات "ساعات
// تشغيل معتمدة" فعلية بالنظام) يمكن تعديلها لاحقًا بسهولة من هنا لو احتاج
// الأمر.
function statusForPercentage(pct) {
  if (pct <= 2) return 'ممتاز';
  if (pct <= 5) return 'جيد جدًا';
  if (pct <= 10) return 'جيد';
  return 'يحتاج متابعة';
}

/// يبني ملخص لكل خط إنتاج (إجمالي الإنتاج والتوقف والباتشات ونسبة التوقف
/// والحالة التشغيلية)، ويرجع أيضًا الباتشات مجمّعة حسب رقم الخط لبناء
/// الجداول التفصيلية لاحقًا. الباتشات بلا خط محدد (line_id فارغ) تُجمَّع
/// تحت بند "غير محدد" منفصل حتى لا تُفقد من التقرير.
function buildLineSummaries(batches, rangeDays, shiftMinutesPerDay) {
  const byLineId = new Map();
  for (const b of batches) {
    const key = b.line_id != null ? String(b.line_id) : 'unassigned';
    if (!byLineId.has(key)) {
      byLineId.set(key, {
        lineId: key,
        lineName: b.line_name || 'غير محدد',
        lineCode: b.line_code || null,
        batches: [],
        totalQuantity: 0,
        totalStoppageMinutes: 0,
      });
    }
    const g = byLineId.get(key);
    g.batches.push(b);
    g.totalQuantity += Number(b.quantity || 0);
    g.totalStoppageMinutes += Number(b.stoppage_minutes || 0);
  }

  const denominator = rangeDays * shiftMinutesPerDay;
  const lineSummaries = [...byLineId.values()].map((g) => {
    const pct = denominator > 0 ? (g.totalStoppageMinutes / denominator) * 100 : 0;
    return {
      ...g,
      batchCount: g.batches.length,
      stoppagePercentage: pct,
      statusLabel: statusForPercentage(pct),
    };
  });

  // ترتيب الخطوط حسب الاسم لثبات ظهورها بنفس الترتيب في كل تقرير.
  lineSummaries.sort((a, b) => a.lineName.localeCompare(b.lineName, 'ar'));

  return { lineSummaries, byLineId };
}

function buildSummaryTable(lineSummaries, totalQuantity, totalStoppageMinutes, batchCount, rangeDays, shiftMinutesPerDay) {
  if (!lineSummaries.length) {
    return '<p class="empty">لا توجد باتشات في هذه المدة</p>';
  }

  const rows = lineSummaries
    .map(
      (l) => `
    <tr>
      <td>${escapeHtml(l.lineCode || l.lineName)}</td>
      <td>${escapeHtml(l.lineName)}</td>
      <td>${fmtNum(l.totalQuantity)}</td>
      <td>${fmtNum(l.totalStoppageMinutes)}</td>
      <td>${l.batchCount}</td>
      <td>${l.stoppagePercentage.toFixed(1)}%</td>
      <td>${escapeHtml(l.statusLabel)}</td>
    </tr>`
    )
    .join('');

  const totalDenominator = rangeDays * shiftMinutesPerDay * lineSummaries.length;
  const totalPct = totalDenominator > 0 ? (totalStoppageMinutes / totalDenominator) * 100 : 0;
  const totalStatus = totalPct <= 5 ? 'تشغيل مستقر' : 'يحتاج متابعة أسبوعيًا';
  const lineCodes = lineSummaries.map((l) => l.lineCode || l.lineName).join('، ');

  return `<div class="scrollx"><table>
    <thead><tr><th>رمز الخط</th><th>اسم خط الإنتاج</th><th>إجمالي الإنتاج (عبوة)</th><th>إجمالي التوقف (دقيقة)</th><th>عدد الباتشات</th><th>نسبة التوقف %</th><th>الحالة التشغيلية</th></tr></thead>
    <tbody>
    ${rows}
    <tr class="grand-total"><td>TOTAL</td><td>إجمالي إنتاج الخطوط (${escapeHtml(lineCodes)})</td><td>${fmtNum(totalQuantity)}</td><td>${fmtNum(totalStoppageMinutes)}</td><td>${batchCount}</td><td>${totalPct.toFixed(1)}%</td><td>${totalStatus}</td></tr>
    </tbody>
  </table></div>`;
}

// رسم بياني بسيط بالأعمدة (CSS بحت، بلا أي مكتبة خارجية) يقارن إجمالي
// الإنتاج بين الخطوط — يطابق فكرة الرسم في التقرير المرجعي.
function buildChart(lineSummaries) {
  if (!lineSummaries.length) return '';
  const max = Math.max(...lineSummaries.map((l) => l.totalQuantity), 1);
  const bars = lineSummaries
    .map((l) => {
      const heightPct = Math.max(4, Math.round((l.totalQuantity / max) * 100));
      // نستخدم "border" ثابت الظهور بالإضافة للتعبئة السوداء — فبعض متصفحات
      // الجوال تتجاهل خلفيات الطباعة رغم print-color-adjust، فيبقى إطار
      // العمود ظاهرًا كحد أدنى حتى لو سقطت التعبئة، بدل اختفاء العمود بالكامل
      // (وهو ما كان يحدث سابقًا).
      return `
      <div class="bar-col">
        <div class="bar-value">${fmtNum(l.totalQuantity)}</div>
        <div class="bar-track"><div class="bar" style="height:${heightPct}%;"></div></div>
        <div class="bar-label">${escapeHtml(l.lineName)}</div>
      </div>`;
    })
    .join('');
  return `
    <h2>مقارنة إجمالي الإنتاج الكلي حسب خط الإنتاج (عبوة)</h2>
    <div class="chart-wrap"><div class="chart">${bars}</div></div>`;
}

function buildLineDetailSection(line, facility, cadenceLabel) {
  const rows = line.batches
    .map((b) => {
      const stoppageMinutes = b.has_stoppage && b.stoppage_minutes ? fmtNum(b.stoppage_minutes) : '';
      const stoppageReason = b.has_stoppage && b.stoppage_reason ? escapeHtml(b.stoppage_reason) : '';
      const notes = b.operational_notes ? escapeHtml(b.operational_notes) : '';
      const actions = b.actions_taken ? escapeHtml(b.actions_taken) : '';
      return `
    <tr>
      <td>${fmtDateShort(b.occurred_at)}</td>
      <td>${escapeHtml(b.product_name)}</td>
      <td>${escapeHtml(b.batch_number)}</td>
      <td>${fmtNum(b.quantity)}</td>
      <td>${stoppageMinutes}</td>
      <td>${stoppageReason}</td>
      <td>${notes}</td>
      <td>${actions}</td>
    </tr>`;
    })
    .join('');

  return `
    <div class="section">
    <h2>التقرير ${cadenceLabel} تفصيلي - ${escapeHtml(line.lineName)} (${escapeHtml(facility)})</h2>
    <div class="scrollx"><table>
      <thead><tr><th>التاريخ</th><th>اسم المنتج</th><th>رقم الباتش</th><th>الكمية المنتجة (عبوة)</th><th>زمن التوقف (دقيقة)</th><th>أسباب التوقف</th><th>الملاحظات التشغيلية</th><th>الحلول والإجراءات المتخذة</th></tr></thead>
      <tbody>
      ${rows}
      <tr class="grand-total"><td colspan="3">المجموع الكلي والأداء ${cadenceLabel}</td><td>${fmtNum(line.totalQuantity)}</td><td>${fmtNum(line.totalStoppageMinutes)}</td><td colspan="3"></td></tr>
      </tbody>
    </table></div>
    </div>`;
}

function renderHtml({
  facility, from, to, factoryName, footer, incidents,
  totalQuantity, totalStoppageMinutes, batchCount, lineSummaries, cadence,
  rangeDays, shiftMinutesPerDay,
}) {
  const rangeLabel = `${fmtDate(from)} — ${fmtDate(to)}`;
  const cadenceTitleLabel = cadence === 'weekly' ? 'الأسبوعي'
    : cadence === 'monthly' ? 'الشهري'
    : 'لهذه المدة';
  const cadenceInlineLabel = cadence === 'weekly' ? 'الأسبوعي'
    : cadence === 'monthly' ? 'الشهري'
    : 'للمدة';

  const totalStoppageHours = (totalStoppageMinutes / 60);
  const totalStoppageHoursLabel = Number.isInteger(totalStoppageHours)
    ? String(totalStoppageHours)
    : totalStoppageHours.toFixed(1);

  const summaryTableHtml = buildSummaryTable(
    lineSummaries, totalQuantity, totalStoppageMinutes, batchCount,
    rangeDays, shiftMinutesPerDay
  );
  const chartHtml = buildChart(lineSummaries);
  const detailSections = lineSummaries.map((l) => buildLineDetailSection(l, facility, cadenceInlineLabel)).join('');

  const incidentRows = incidents
    .map(
      (i) => `
    <tr>
      <td>${fmtDateTime(i.reported_at)}</td>
      <td>${escapeHtml(i.line_name || '-')}</td>
      <td>${escapeHtml(i.description)}</td>
      <td>${escapeHtml(i.status)}</td>
    </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>التقرير ${cadenceTitleLabel} الشامل لخطوط إنتاج ${escapeHtml(facility)}</title>
<style>
  /* تصميم أساسه الأسود والرمادي الغامق (بدل الأزرق السابق) حتى يظهر التقرير
     بوضوح تام عند الطباعة بطابعة أبيض/أسود عادية، بلا اعتماد على دقة الألوان.
     مع فرض طباعة الخلفيات (print-color-adjust) — فالمتصفحات تتجاهل خلفيات
     الطباعة افتراضيًا إلا لو فُعِّل "Background graphics" يدويًا من نافذة
     الطباعة؛ هذا كان سبب اختفاء أعمدة الرسم البياني بالكامل سابقًا. */
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}
  body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F7F8FA;color:#111417;padding:18px;direction:rtl;margin:0;}
  .wrap{max-width:1050px;margin:0 auto;background:#fff;border:1px solid #D8DCE1;border-radius:14px;padding:22px;}
  h1{font-size:19px;font-weight:800;margin:0 0 4px;background:#000;color:#fff;padding:12px 16px;border-radius:10px;text-align:center;}
  .sub{color:#3A4149;font-size:13px;margin:8px 0 20px;text-align:center;}
  .kpis{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap;}
  .kpi{flex:1;min-width:140px;background:#F0F1F3;border:1px solid #D8DCE1;border-radius:10px;padding:14px;text-align:center;}
  .kpi.main{background:#000;}
  .kpi b{display:block;font-size:22px;font-weight:800;color:#000;}
  .kpi.main b{color:#fff;font-size:26px;}
  .kpi span{font-size:12px;color:#3A4149;}
  .kpi.main span{color:#E7E8EA;}
  h2{font-size:15.5px;font-weight:800;color:#000;margin:26px 0 10px;border-inline-start:5px solid #000;padding-inline-start:8px;}
  .section{page-break-inside:avoid;break-inside:avoid;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th,td{border:1px solid #B9BEC5;padding:6px 8px;text-align:center;}
  th{background:#000;color:#fff;font-weight:800;}
  tr.grand-total td{background:#000;color:#fff;font-weight:800;font-size:12.5px;}
  /* تكرار صف العنوان في كل صفحة عند امتداد الجدول لأكثر من ورقة، ومنع تقطيع
     أي صف بين صفحتين — يحل مشكلة ظهور عنوان الجدول في ورقة وبياناته في
     ورقة تالية بلا عنوان. */
  thead{display:table-header-group;}
  tfoot{display:table-footer-group;}
  tr{page-break-inside:avoid;break-inside:avoid;}
  h2{page-break-after:avoid;break-after:avoid;}
  .empty{color:#5B6470;font-size:12.5px;padding:8px 0;}
  .footer{margin-top:24px;color:#5B6470;font-size:11px;text-align:center;}
  .scrollx{overflow-x:auto;}
  .chart-wrap{page-break-inside:avoid;break-inside:avoid;}
  .chart{display:flex;align-items:flex-end;gap:18px;height:220px;padding:20px 30px 0;background:#F0F1F3;border:1px solid #D8DCE1;border-radius:12px;}
  .bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;}
  .bar-value{font-size:11.5px;font-weight:800;color:#000;margin-bottom:4px;}
  .bar-track{width:60%;height:100%;display:flex;align-items:flex-end;border:1px solid #000;border-radius:6px 6px 0 0;overflow:hidden;}
  .bar{width:100%;background:#000;min-height:6px;}
  .bar-label{font-size:11.5px;font-weight:700;color:#111417;margin-top:8px;text-align:center;}
  @media print{
    body{background:#fff;padding:0;}
    .wrap{border:none;border-radius:0;max-width:100%;padding:8px;}
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>التقرير ${cadenceTitleLabel} الشامل لخطوط إنتاج ${escapeHtml(facility)}</h1>
    <p class="sub">${escapeHtml(factoryName)} — المدة: ${rangeLabel}</p>

    <div class="kpis">
      <div class="kpi main"><b>${fmtNum(totalQuantity)}</b><span>إجمالي الإنتاج الكلي (عبوة)</span></div>
      <div class="kpi"><b>${batchCount}</b><span>إجمالي الباتشات المنجزة</span></div>
      <div class="kpi"><b>${totalStoppageHoursLabel}</b><span>إجمالي ساعات التوقف</span></div>
    </div>

    <div class="section">
    <h2>ملخص أداء خطوط الإنتاج</h2>
    ${summaryTableHtml}
    </div>

    ${chartHtml}

    ${detailSections}

    <div class="section">
    <h2>بلاغات الأعطال خلال هذه المدة</h2>
    ${incidents.length ? `<div class="scrollx"><table><thead><tr><th>الوقت</th><th>الخط</th><th>الوصف</th><th>الحالة</th></tr></thead><tbody>${incidentRows}</tbody></table></div>` : '<p class="empty">لا توجد بلاغات في هذه المدة</p>'}
    </div>

    <div class="footer">${escapeHtml(footer)}</div>
  </div>
</body>
</html>`;
}

module.exports = { generateProductionReport };