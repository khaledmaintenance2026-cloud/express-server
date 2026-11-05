// خدمة توليد تقارير السلامة المهنية (بمدة مخصّصة، أو أسبوعي أو شهري تلقائي)
// — بنفس نمط services/maintenanceReport.js تمامًا: ملف HTML مستقل يُحفظ داخل
// public/uploads/reports/ ويُخدَّم كرابط ثابت يصلح للإرسال عبر واتساب (رابط
// نصي بدل ملف مرفق، لأن أتمتة واتساب الحالية لدى العميل لا تدعم إرسال
// مرفقات). يغطي كل طلبات تصاريح العمل (بانتظار الموافقة + مقبولة + مرفوضة)
// مع تفصيل كل طلب من بدايته (تقديم الطلب) وحتى قرار قسم السلامة النهائي
// (قبول بكل تفاصيل السلامة المطلوبة، أو رفض بسببه) — وليس فقط عددًا إجماليًا.
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

const STATUS_LABELS = { pending: 'بانتظار الموافقة', approved: 'مقبول', rejected: 'مرفوض' };

// نفس القيم بالضبط المستخدمة في routes/safetyPermits.js (OPERATION_TYPES)
// وservices/notifications.js (OPERATION_TYPE_LABELS) — يجب أن تبقى متطابقة.
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

/// يُنشئ تقرير سلامة HTML شاملًا لكل طلبات تصاريح العمل خلال مدة زمنية
/// محددة (بانتظار الموافقة + مقبولة + مرفوضة، كل واحد بتفاصيل قراره
/// الكامل)، يحفظه على القرص، ويعيد رابطه الكامل (مطلَق) القابل للإرسال عبر
/// واتساب. facility اختياري: لو حُدِّد، يقتصر التقرير على تصاريح ذلك القسم
/// فقط (نفس منطق userSafetyFacility في routes/safetyPermits.js) — يُستخدم
/// لطلب تقرير مخصّص من مسؤول سلامة مقيَّد بقسم واحد؛ التقرير التلقائي
/// الأسبوعي/الشهري (جروب واتساب واحد مشترك للسلامة بالكامل) لا يمرره فيغطي
/// كل الأقسام. يرمي خطأ برسالة عربية واضحة (مع statusCode) لو لم يكن "رابط
/// السيرفر العام" مضبوطًا بعد، أو لو كانت المدخلات غير صحيحة.
async function generateSafetyReport({ from, to, facility }) {
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

  const params = [fromTs, toEnd];
  let sql = 'SELECT * FROM safety_permits WHERE requested_at BETWEEN $1 AND $2';
  if (facility) {
    sql += " AND (location = $3 OR location LIKE $3 || ' — %')";
    params.push(facility);
  }
  sql += ' ORDER BY requested_at ASC';

  const [permitsRes, factoryName, footer] = await Promise.all([
    pool.query(sql, params),
    getSetting('factory_name'),
    getSetting('report_footer'),
  ]);

  const permits = permitsRes.rows;
  const approvedCount = permits.filter((p) => p.status === 'approved').length;
  const rejectedCount = permits.filter((p) => p.status === 'rejected').length;
  const pendingCount = permits.filter((p) => p.status === 'pending').length;

  const html = renderHtml({
    from: fromTs,
    to: toTs,
    factoryName: factoryName || 'مصنع الماس الوطنية',
    footer: footer || '',
    permits,
    totalCount: permits.length,
    approvedCount,
    rejectedCount,
    pendingCount,
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
    totalCount: permits.length,
    approvedCount,
    rejectedCount,
    pendingCount,
  };
}

function renderHtml({ from, to, factoryName, footer, permits, totalCount, approvedCount, rejectedCount, pendingCount }) {
  const rangeLabel = `${fmtDate(from)} — ${fmtDate(to)}`;

  const rows = permits
    .map((p) => {
      // "تفاصيل القرار" — قسم القبول الكامل (خلوّ الموقع، المخاطر المحتملة،
      // معدات الوقاية، الإجراءات الإلزامية) عند الموافقة، أو سبب الرفض عند
      // الرفض، أو "—" ما دام الطلب بانتظار المراجعة — بالضبط ما طُلب: عرض
      // كل تصريح فردي من بداية الطلب وحتى قرار قسم السلامة النهائي.
      let decision = '—';
      if (p.status === 'approved') {
        decision =
          `خلوّ الموقع من: ${escapeHtml(listOrDash(p.site_hazards))}<br>` +
          `المخاطر المحتملة: ${escapeHtml(listOrDash(p.potential_risks))}<br>` +
          `معدات الوقاية: ${escapeHtml(listOrDash(p.ppe_required))}<br>` +
          `الإجراءات: ${escapeHtml(p.precautions || '—')}`;
      } else if (p.status === 'rejected') {
        decision = `سبب الرفض: ${escapeHtml(p.rejection_reason || '—')}`;
      }
      return `
    <tr>
      <td>${fmtDateTime(p.requested_at)}</td>
      <td>${escapeHtml(p.location)}${p.office_name ? ` (${escapeHtml(p.office_name)})` : ''}</td>
      <td>${escapeHtml(p.requested_by)}</td>
      <td>${escapeHtml(operationTypesLabel(p.operation_types))}</td>
      <td>${STATUS_LABELS[p.status] || p.status}</td>
      <td>${escapeHtml(p.reviewed_by || '—')}${p.reviewed_at ? `<br><span style="color:#5B6470;font-size:10.5px;">${fmtDateTime(p.reviewed_at)}</span>` : ''}</td>
      <td>${decision}</td>
    </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تقرير سلامة</title>
<style>
  /* بنفس منطق services/maintenanceReport.js — تصميم أساسه الأسود الغامق
     ليظهر بوضوح تام عند الطباعة بطابعة أبيض/أسود، مع فرض طباعة الخلفيات
     (print-color-adjust) وتكرار عنوان الجدول عند امتداده لأكثر من صفحة. */
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}
  body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F7F8FA;color:#111417;padding:18px;direction:rtl;margin:0;}
  .wrap{max-width:1080px;margin:0 auto;background:#fff;border:1px solid #D8DCE1;border-radius:14px;padding:22px;}
  h1{font-size:19px;font-weight:800;margin:0 0 4px;color:#000;}
  .sub{color:#3A4149;font-size:13px;margin:0 0 20px;}
  .kpis{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap;}
  .kpi{flex:1;min-width:110px;background:#F0F1F3;border:1px solid #D8DCE1;border-radius:10px;padding:12px;text-align:center;}
  .kpi b{display:block;font-size:19px;font-weight:800;color:#000;}
  .kpi span{font-size:11.5px;color:#3A4149;}
  h2{font-size:15.5px;font-weight:800;color:#000;margin:22px 0 10px;border-inline-start:5px solid #000;padding-inline-start:8px;page-break-after:avoid;break-after:avoid;}
  .section{page-break-inside:avoid;break-inside:avoid;}
  table{width:100%;border-collapse:collapse;font-size:11.5px;}
  th,td{border:1px solid #B9BEC5;padding:6px 8px;text-align:right;vertical-align:top;}
  th{background:#000;color:#fff;font-weight:800;}
  thead{display:table-header-group;}
  tfoot{display:table-footer-group;}
  tr{page-break-inside:avoid;break-inside:avoid;}
  .empty{color:#5B6470;font-size:12.5px;padding:8px 0;}
  .footer{margin-top:24px;color:#5B6470;font-size:11px;text-align:center;}
  .scrollx{overflow-x:auto;}
  @media print{
    body{background:#fff;padding:0;}
    .wrap{border:none;border-radius:0;max-width:100%;padding:8px;}
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(factoryName)} — تقرير السلامة المهنية</h1>
    <p class="sub">المدة: ${rangeLabel}</p>
    <div class="kpis">
      <div class="kpi"><b>${totalCount}</b><span>إجمالي طلبات التصاريح</span></div>
      <div class="kpi"><b>${approvedCount}</b><span>مقبولة</span></div>
      <div class="kpi"><b>${rejectedCount}</b><span>مرفوضة</span></div>
      <div class="kpi"><b>${pendingCount}</b><span>بانتظار الموافقة</span></div>
    </div>

    <div class="section">
    <h2>تفاصيل طلبات تصاريح العمل</h2>
    ${permits.length ? `<div class="scrollx"><table><thead><tr><th>وقت الطلب</th><th>الموقع</th><th>مقدّم الطلب</th><th>نوع العمل</th><th>الحالة</th><th>المراجِع</th><th>تفاصيل القرار</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">لا توجد طلبات في هذه المدة</p>'}
    </div>

    <div class="footer">${escapeHtml(footer)}</div>
  </div>
</body>
</html>`;
}

module.exports = { generateSafetyReport };
