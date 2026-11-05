// خدمة توليد تقارير الصيانة (بمدة مخصّصة، أو شهري أو سنوي تلقائي) — بنفس نمط
// services/productionReport.js تمامًا: ملف HTML مستقل يُحفظ داخل
// public/uploads/reports/ ويُخدَّم كرابط ثابت يصلح للإرسال عبر واتساب
// (رابط نصي بدل ملف مرفق، لأن أتمتة واتساب الحالية لدى العميل لا تدعم إرسال
// مرفقات). يغطي كل أوامر العمل (بلاغات الأعطال الطارئة + الصيانة الوقائية)
// بغض النظر عن القسم أو المصنع — نظام الصيانة غير مقسَّم حسب المصنع في التطبيق
// خلافًا لتقارير الإنتاج.
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
  if (!d) return '—';
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

function fmtMinutes(mins) {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h <= 0) return `${m} د`;
  return `${h} س ${m} د`;
}

const STATUS_LABELS = {
  new: 'جديد',
  pending_assignment: 'بانتظار التعيين',
  waiting_loto: 'بانتظار LOTO',
  in_progress: 'قيد التنفيذ',
  waiting_parts: 'بانتظار قطع غيار',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

/// يُنشئ تقرير صيانة HTML شاملًا لكل أوامر العمل (طارئة + وقائية) خلال مدة
/// زمنية محددة، يحفظه على القرص، ويعيد رابطه الكامل (مطلَق) القابل للإرسال
/// عبر واتساب. يرمي خطأ برسالة عربية واضحة (مع statusCode) لو لم يكن "رابط
/// السيرفر العام" مضبوطًا بعد، أو لو كانت المدخلات غير صحيحة.
async function generateMaintenanceReport({ from, to }) {
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
  const toEnd = new Date(toTs.getTime() + (24 * 60 * 60 * 1000 - 1));

  const [ordersRes, techRows, factoryName, footer] = await Promise.all([
    pool.query(
      `SELECT wo.*, t.name AS technician_name
       FROM work_orders wo
       LEFT JOIN technicians t ON t.id = wo.assigned_technician_id
       WHERE wo.created_at BETWEEN $1 AND $2
       ORDER BY wo.created_at ASC`,
      [fromTs, toEnd]
    ),
    // أداء كل فني خلال مدة التقرير نفسها — طلب صريح 2026-10-03: "إضافتها
    // للتقارير أيضًا"، بنفس استعلام routes/maintenanceAnalysis.js تمامًا (عبر
    // work_order_technicians حتى يُحتسب كل فني شارك في الأمر لا الأساسي
    // فقط)، حتى تتطابق أرقام هذا التقرير المطبوع مع صفحة "تحليل الصيانة" الحيّة.
    pool.query(
      `SELECT t.id, t.name,
         count(wo.*) FILTER (WHERE wo.status = 'completed' AND wo.completed_at BETWEEN $1 AND $2) AS completed_count,
         count(wo.*) FILTER (WHERE wo.status NOT IN ('completed','cancelled') AND wo.created_at BETWEEN $1 AND $2) AS open_count,
         avg(EXTRACT(EPOCH FROM (wo.completed_at - wo.assigned_at)) / 60)
           FILTER (WHERE wo.status = 'completed' AND wo.completed_at BETWEEN $1 AND $2 AND wo.assigned_at IS NOT NULL) AS avg_minutes
       FROM technicians t
       LEFT JOIN work_order_technicians wot ON wot.technician_id = t.id
       LEFT JOIN work_orders wo ON wo.id = wot.work_order_id
       GROUP BY t.id, t.name
       ORDER BY completed_count DESC, t.name`,
      [fromTs, toEnd]
    ),
    getSetting('factory_name'),
    getSetting('report_footer'),
  ]);

  const orders = ordersRes.rows;
  const completed = orders.filter((o) => o.status === 'completed' && o.completed_at);
  const preventiveCount = orders.filter((o) => o.kind === 'preventive').length;
  // "مهام العمل" (داخلية/خارجية) — تصنيف ثالث منفصل عن الوقائي والطارئ
  // الفعلي، راجع is_task في schema.sql وrenderHtml أدناه (عمود "النوع").
  const taskCount = orders.filter((o) => o.is_task).length;
  const openCount = orders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled').length;
  // أعطال طارئة فعلية فقط (kind=emergency وليست مهمة عمل) — نفس تصنيف
  // routes/maintenanceAnalysis.js بالضبط. لا حاجة لفلترة إضافية لأن كل أمر
  // يقع في فئة واحدة من الثلاث بالضبط (راجع orderTypeLabel أعلاه).
  const emergencyCount = orders.length - preventiveCount - taskCount;

  const technicians = techRows.rows.map((r) => ({
    name: r.name,
    completedCount: Number(r.completed_count),
    openCount: Number(r.open_count),
    avgResolutionMinutes: r.avg_minutes ? Math.round(r.avg_minutes) : null,
  }));

  const avgResolutionMinutes = completed.length
    ? completed.reduce((sum, o) => sum + (new Date(o.completed_at) - new Date(o.created_at)) / 60000, 0) / completed.length
    : null;

  const html = renderHtml({
    from: fromTs,
    to: toTs,
    factoryName: factoryName || 'مصنع الماس الوطنية',
    footer: footer || '',
    orders,
    totalCount: orders.length,
    completedCount: completed.length,
    openCount,
    preventiveCount,
    taskCount,
    emergencyCount,
    avgResolutionMinutes,
    technicians,
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
    totalCount: orders.length,
    completedCount: completed.length,
    openCount,
    preventiveCount,
    taskCount,
  };
}

// "مهمة عمل" (is_task) تبقى kind = 'emergency' في قاعدة البيانات عمدًا (راجع
// is_task في schema.sql)، لذا التمييز هنا صريح بدل الاعتماد على kind فقط —
// وإلا ظهرت في عمود "النوع" كـ"طارئ" رغم أنها ليست عطلًا فعليًا في معدة.
function orderTypeLabel(o) {
  if (o.kind === 'preventive') return 'وقائي';
  if (o.is_task) return o.task_scope === 'external' ? 'مهمة عمل (خارجية)' : 'مهمة عمل (داخلية)';
  return 'طارئ';
}

function renderHtml({ from, to, factoryName, footer, orders, totalCount, completedCount, openCount, preventiveCount, taskCount, emergencyCount, avgResolutionMinutes, technicians }) {
  const rangeLabel = `${fmtDate(from)} — ${fmtDate(to)}`;

  // شريط توزيع نسبي بالأسود فقط (لا ألوان) — يطابق فلسفة التصميم المطبوعة
  // أعلى هذا الملف (أبيض/أسود بالكامل حتى يظهر بوضوح على طابعة بلا ألوان)؛
  // يختلف هذا عمدًا عن الرسم الدائري الملوّن في صفحة "تحليل الصيانة" بالتطبيق.
  function distRow(label, count) {
    const pct = totalCount > 0 ? Math.round((count / totalCount) * 100) : 0;
    return `
    <div class="distrow">
      <div class="distlabel">${escapeHtml(label)}</div>
      <div class="disttrack"><div class="distfill" style="width:${pct}%"></div></div>
      <div class="distval">${count}</div>
    </div>`;
  }
  const distributionHtml = distRow('أعطال طارئة', emergencyCount) + distRow('أعمال وقائية', preventiveCount) + distRow('مهام عمل', taskCount);

  const technicianRows = (technicians || [])
    .map(
      (t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${t.completedCount}</td>
      <td>${fmtMinutes(t.avgResolutionMinutes)}</td>
      <td>${t.openCount}</td>
    </tr>`
    )
    .join('');

  const rows = orders
    .map((o) => {
      const resolutionMinutes = o.completed_at ? (new Date(o.completed_at) - new Date(o.created_at)) / 60000 : null;
      return `
    <tr>
      <td>${fmtDateTime(o.created_at)}</td>
      <td>${orderTypeLabel(o)}</td>
      <td>${escapeHtml(o.facility || '-')}</td>
      <td>${escapeHtml(o.equipment_name || '-')}</td>
      <td>${escapeHtml(o.description)}</td>
      <td>${escapeHtml(o.technician_name || '-')}</td>
      <td>${STATUS_LABELS[o.status] || o.status}</td>
      <td>${fmtMinutes(resolutionMinutes)}</td>
    </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تقرير صيانة</title>
<style>
  /* بنفس منطق services/productionReport.js — تصميم أساسه الأسود الغامق
     ليظهر بوضوح تام عند الطباعة بطابعة أبيض/أسود، مع فرض طباعة الخلفيات
     (print-color-adjust) وتكرار عنوان الجدول عند امتداده لأكثر من صفحة. */
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}
  body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F7F8FA;color:#111417;padding:18px;direction:rtl;margin:0;}
  .wrap{max-width:960px;margin:0 auto;background:#fff;border:1px solid #D8DCE1;border-radius:14px;padding:22px;}
  h1{font-size:19px;font-weight:800;margin:0 0 4px;color:#000;}
  .sub{color:#3A4149;font-size:13px;margin:0 0 20px;}
  .kpis{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap;}
  .kpi{flex:1;min-width:110px;background:#F0F1F3;border:1px solid #D8DCE1;border-radius:10px;padding:12px;text-align:center;}
  .kpi b{display:block;font-size:19px;font-weight:800;color:#000;}
  .kpi span{font-size:11.5px;color:#3A4149;}
  h2{font-size:15.5px;font-weight:800;color:#000;margin:22px 0 10px;border-inline-start:5px solid #000;padding-inline-start:8px;page-break-after:avoid;break-after:avoid;}
  .section{page-break-inside:avoid;break-inside:avoid;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th,td{border:1px solid #B9BEC5;padding:6px 8px;text-align:right;}
  th{background:#000;color:#fff;font-weight:800;}
  thead{display:table-header-group;}
  tfoot{display:table-footer-group;}
  tr{page-break-inside:avoid;break-inside:avoid;}
  .empty{color:#5B6470;font-size:12.5px;padding:8px 0;}
  .footer{margin-top:24px;color:#5B6470;font-size:11px;text-align:center;}
  .scrollx{overflow-x:auto;}
  /* توزيع الأوامر حسب النوع — أسود فقط، لا ألوان (نفس قاعدة الملف كله) */
  .distrow{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
  .distlabel{width:130px;font-size:12.5px;color:#111417;flex-shrink:0;}
  .disttrack{flex:1;height:14px;background:#EDEEF0;border:1px solid #D8DCE1;border-radius:7px;overflow:hidden;}
  .distfill{height:100%;background:#000;}
  .distval{width:40px;text-align:left;font-size:12.5px;font-weight:800;color:#000;flex-shrink:0;}
  @media print{
    body{background:#fff;padding:0;}
    .wrap{border:none;border-radius:0;max-width:100%;padding:8px;}
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(factoryName)} — تقرير الصيانة</h1>
    <p class="sub">المدة: ${rangeLabel}</p>
    <div class="kpis">
      <div class="kpi"><b>${totalCount}</b><span>إجمالي البلاغات/الأوامر</span></div>
      <div class="kpi"><b>${openCount}</b><span>قيد المتابعة الآن</span></div>
      <div class="kpi"><b>${completedCount}</b><span>مُنجَز</span></div>
      <div class="kpi"><b>${preventiveCount}</b><span>صيانة وقائية</span></div>
      <div class="kpi"><b>${taskCount}</b><span>مهام عمل</span></div>
      <div class="kpi"><b>${fmtMinutes(avgResolutionMinutes)}</b><span>متوسط وقت الإصلاح</span></div>
    </div>

    <div class="section">
    <h2>توزيع الأوامر حسب النوع</h2>
    ${totalCount ? distributionHtml : '<p class="empty">لا توجد بيانات في هذه المدة</p>'}
    </div>

    <div class="section">
    <h2>أداء الفنيين خلال هذه الفترة</h2>
    ${technicianRows ? `<div class="scrollx"><table><thead><tr><th>الفني</th><th>مُنجزة</th><th>متوسط وقت الإنجاز</th><th>مفتوحة حاليًا</th></tr></thead><tbody>${technicianRows}</tbody></table></div>` : '<p class="empty">لا يوجد فنيون مسجّلون</p>'}
    </div>

    <div class="section">
    <h2>تفاصيل البلاغات وأوامر العمل</h2>
    ${orders.length ? `<div class="scrollx"><table><thead><tr><th>الوقت</th><th>النوع</th><th>القسم</th><th>المعدة</th><th>الوصف</th><th>الفني</th><th>الحالة</th><th>وقت الإصلاح</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">لا توجد بيانات في هذه المدة</p>'}
    </div>

    <div class="footer">${escapeHtml(footer)}</div>
  </div>
</body>
</html>`;
}

module.exports = { generateMaintenanceReport };
