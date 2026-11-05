'use strict';
// ============================================================================
// تقارير «إجازات الموظفين» — دوال خالصة (بلا قاعدة بيانات): تبني من عروض الموظفين
// (leaveService.buildView بخيار full) نموذج التقرير، ثم تُخرجه:
//   • صفحة HTML للعرض والطباعة (PDF): شامل (A4 أفقي) أو كشف شخص (A4 طولي).
//   • ملف Excel (.xlsx) بنفس أعمدة ملف المالك: م، الرقم الوظيفي، اسم الموظف، القسم،
//     تاريخ المباشرة/التعيين، بدء الإجازة، العودة المتوقعة، المدة، العودة الفعلية،
//     تاريخ استحقاق الإجازة القادمة، الأيام المتبقية للاستحقاق، حالة الموظف، الموظف البديل،
//     ملاحظات — وبعدها أعمدة الرصيد والمدفوع/بدون راتب.
//
// قاعدة الصف الواحد لكل موظف في الجدول الشامل: الإجازة المعروضة هي (متأخرة ← جارية ← أقرب
// قادمة ← آخر إجازة منتهية). المدة = العودة − البدء (تختلف عن +١ في ملف الإكسل القديم لأن يوم
// العودة هو أول يوم عمل). استحقاق الإجازة القادمة = آخر مباشرة فعلية (أو تاريخ المباشرة/التعيين) + ١٢ شهرًا.
// ============================================================================

const C = require('./leaveCalc');
const { Workbook } = require('./xlsxLite');

const BRAND = 'صيانتي — إدارة الصيانة والإنتاج والسلامة';
const COLOR = '1B6E87';
const FACILITY_TITLE = 'مصنع الرجال';

const STATUS_FILTERS = ['active', 'on_leave', 'upcoming', 'late'];
const STATUS_LABEL = {
  active: 'على رأس العمل',
  on_leave: 'في إجازة',
  upcoming: 'إجازة قادمة',
  late: 'متأخر عن المباشرة',
};
const LEAVE_STATE_LABEL = { completed: 'منتهية', ongoing: 'جارية', upcoming: 'قادمة', late: 'متأخر عن المباشرة' };

// ---------------------------------------------------------------------------
// أدوات صغيرة
// ---------------------------------------------------------------------------

const EAST = '٠١٢٣٤٥٦٧٨٩';
const eastern = (v) => String(v).replace(/[0-9]/g, (d) => EAST[Number(d)]);

const esc = (s) =>
  String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** رقم أيام بمنزلتين عشريتين كحد أقصى: 9.95 → ٩٫٩٥ ، 10 → ١٠ ، null → —. */
function amount(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  let s = Number(v).toFixed(2);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return eastern(s).replace('.', '٫');
}

const intText = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : eastern(Math.round(v)));

/**
 * تاريخ بأرقام عربية: نستعمل «/» بدل «-» لأن الشرطة بين الأرقام العربية تعكس ترتيب الأجزاء
 * في قواعد الاتجاه (٢٠٢٦-١١-٠٤ تظهر ٠٤-١١-٢٠٢٦)، بينما «/» تُبقيها رقمًا واحدًا بالترتيب الصحيح.
 */
const dateText = (iso) => eastern(iso).replace(/-/g, '/');
const dateHtml = (iso) => (iso ? `<bdi dir="ltr">${dateText(iso)}</bdi>` : '—');

/** نص حرّ (ملاحظة/بديل/تنبيه) للعرض: تواريخ ISO فيه تُحوَّل لصيغة «/» وكل الأرقام عربية. */
const prettyText = (s) =>
  eastern(String(s === null || s === undefined ? '' : s).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$1/$2/$3'));

/** مثل EDATE في إكسل: يضيف أشهرًا ويقصّ اليوم لآخر الشهر عند الحاجة. */
function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const y = Math.floor(total / 12);
  const mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(Number(m[3]), last);
  return `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** وقت الإنشاء بتوقيت الرياض: «2026-10-25 14:30». */
function riyadhStamp(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** اسم ملف آمن (ASCII): أحرف وأرقام وشرطات فقط. */
const safePart = (s) => String(s || '').replace(/[^A-Za-z0-9-]+/g, '').slice(0, 30);

// ---------------------------------------------------------------------------
// النموذج
// ---------------------------------------------------------------------------

/** الإجازة المعروضة لموظف: متأخرة ← جارية ← أقرب قادمة ← آخر منتهية. */
function pickLeave(leaves) {
  if (!leaves || leaves.length === 0) return null;
  const by = (state) => leaves.filter((l) => l.state === state);
  const asc = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id);
  const late = by('late').sort(asc);
  if (late.length) return late[0];
  const ongoing = by('ongoing').sort(asc);
  if (ongoing.length) return ongoing[0];
  const upcoming = by('upcoming').sort(asc);
  if (upcoming.length) return upcoming[0];
  const done = by('completed').sort(asc);
  return done.length ? done[done.length - 1] : null;
}

/** استحقاق الإجازة القادمة: آخر مباشرة فعلية (أو المباشرة/التعيين) + ١٢ شهرًا. */
function nextDueDate(view) {
  const returns = (view.leaves || []).filter((l) => l.actual).map((l) => l.actual).sort();
  const base = returns.length ? returns[returns.length - 1] : view.start_date || view.hire_date || null;
  return base ? addMonths(base, 12) : null;
}

function sortKey(view) {
  const n = view.employee_number;
  const num = n && /^\d+/.test(n) ? parseInt(n, 10) : Number.POSITIVE_INFINITY;
  return [num, n || '', view.name || ''];
}
function compareViews(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
  if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
  return String(ka[2]).localeCompare(String(kb[2]), 'ar');
}

// تنبيهات لا تُكرَّر في عمود الملاحظات: «أدخل التواريخ» (ظاهرة من الخلايا الفارغة) و«إجازة قادمة» (ظاهرة من الحالة).
const NOTE_SKIP = new Set(['missing_dates', 'soon']);

function noteLines(view, leave) {
  const out = [];
  if (leave && leave.note) out.push(leave.note);
  for (const a of view.alerts || []) {
    if (a.text && !NOTE_SKIP.has(a.code) && !out.includes(a.text)) out.push(a.text);
  }
  return out;
}

/** صف الموظف في الجدول الشامل. */
function buildRow(view, todayDay) {
  const leave = pickLeave(view.leaves);
  const nextDue = nextDueDate(view);
  const dueDay = nextDue ? C.toDay(nextDue) : null;
  return {
    id: view.id,
    number: view.employee_number || null,
    name: view.name,
    department: view.department || null,
    joined: view.start_date || view.hire_date || null,
    status: view.status,
    status_label: view.status_label,
    leave_start: leave ? leave.start : null,
    leave_expected: leave ? leave.expected : null,
    leave_actual: leave ? leave.actual : null,
    duration: leave && !leave.provisional ? leave.duration : null,
    leave_state: leave ? leave.state : null,
    next_due: nextDue,
    days_to_due: dueDay === null ? null : dueDay - todayDay,
    replacement: leave ? leave.replacement || null : null,
    notes: noteLines(view, leave),
    available: view.available,
    paid: leave ? leave.paid : null,
    unpaid: leave ? leave.unpaid : null,
    has_balance: view.has_balance,
  };
}

/**
 * نموذج التقرير الشامل. views = buildView(..., {full:true}) لكل الموظفين.
 * status: فلتر اختياري (active|on_leave|upcoming|late).
 */
function buildAllModel(views, todayDay, { status = null, now = new Date() } = {}) {
  const filtered = views.filter((v) => !status || v.status === status).sort(compareViews);
  const rows = filtered.map((v) => buildRow(v, todayDay));
  rows.forEach((r, i) => {
    r.seq = i + 1;
  });

  // صف لكل إجازة (للورقة الثانية في الإكسل): بترتيب الموظفين ثم البدء تصاعديًا.
  const leaves = [];
  filtered.forEach((v, i) => {
    const sorted = (v.leaves || []).slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
    for (const l of sorted) {
      leaves.push({
        seq: i + 1,
        number: v.employee_number || null,
        name: v.name,
        department: v.department || null,
        start: l.start,
        expected: l.expected,
        actual: l.actual,
        duration: l.provisional ? null : l.duration,
        state: l.state,
        state_label: l.state_label || LEAVE_STATE_LABEL[l.state],
        balance_at_start: l.balance_at_start,
        paid: l.paid,
        unpaid: l.unpaid,
        replacement: l.replacement || null,
        note: l.note || null,
      });
    }
  });

  const count = (st) => views.filter((v) => v.status === st).length;
  return {
    kind: 'all',
    today: C.fromDay(todayDay),
    generated: riyadhStamp(now),
    status: status || null,
    counts: {
      shown: rows.length,
      total: views.length,
      active: count('active'),
      on_leave: count('on_leave'),
      upcoming: count('upcoming'),
      late: count('late'),
      no_dates: views.filter((v) => !v.has_balance).length,
    },
    rows,
    leaves,
  };
}

/** نموذج كشف شخص. view = buildView(..., {full:true}). */
function buildPersonModel(view, todayDay, settings, { now = new Date() } = {}) {
  const nextDue = nextDueDate(view);
  const dueDay = nextDue ? C.toDay(nextDue) : null;
  return {
    kind: 'person',
    today: C.fromDay(todayDay),
    generated: riyadhStamp(now),
    employee: view,
    next_due: nextDue,
    days_to_due: dueDay === null ? null : dueDay - todayDay,
    leaves: view.leaves || [],
    paid_rounding: settings && settings.paidRounding === 'floor' ? 'floor' : 'nearest',
    cap_days: view.cap_days,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const CSS = (landscape) => `
  @page { size: A4${landscape ? ' landscape' : ''}; margin: ${landscape ? '9mm 8mm' : '12mm 10mm'}; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  body { margin: 0; background: #FFFFFF; }
  .page { width: 100%; max-width: ${landscape ? '1080px' : '794px'}; margin: 0 auto; padding: 10px 8px 14px; font-family: 'IBM Plex Sans Arabic','Segoe UI',Tahoma,'Noto Naskh Arabic',sans-serif; color: #1A2129; font-size: ${landscape ? '12px' : '13px'}; line-height: 1.5; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 2px solid #${COLOR}; }
  .title { font-size: ${landscape ? '20px' : '21px'}; font-weight: 700; color: #${COLOR}; }
  .sub { font-size: 13px; color: #5C6673; margin-top: 3px; }
  .brand { font-size: 11px; color: #8892A0; text-align: left; white-space: nowrap; }
  .kpis { display: flex; gap: 8px; margin: 12px 0 8px; flex-wrap: wrap; }
  .kpi { flex: 1; min-width: 96px; background: #F2F5F9; border-radius: 10px; padding: 8px 11px; }
  .kpi .k { font-size: 11px; color: #5C6673; }
  .kpi .v { font-size: 17px; font-weight: 700; color: #${COLOR}; margin-top: 1px; }
  .kpi .v.green { color: #1E7B4A; } .kpi .v.amber { color: #B45309; } .kpi .v.red { color: #B3261E; }
  .grid { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 10px 0 4px; }
  .cell { background: #F2F5F9; border-radius: 8px; padding: 5px 10px; font-size: 12px; }
  .cell span { color: #5C6673; margin-left: 5px; }
  .cell b { color: #1A2129; }
  .box { background: #FFF8E6; border-radius: 8px; padding: 7px 11px; margin: 8px 0; font-size: 12px; }
  .box .lbl { font-weight: 700; color: #B45309; margin-bottom: 2px; }
  .box.red { background: #FDECEA; } .box.red .lbl { color: #B3261E; }
  .sec { font-size: 14px; font-weight: 700; margin: 14px 0 6px; color: #1A2129; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  th { background: #${COLOR}; color: #FFFFFF; font-size: ${landscape ? '10px' : '11px'}; font-weight: 700; padding: 5px 3px; border: 1px solid #${COLOR}; text-align: center; line-height: 1.3; }
  td { border: 1px solid #C9CFD8; padding: 3px 3px; font-size: ${landscape ? '10.5px' : '11.5px'}; vertical-align: middle; text-align: center; line-height: 1.35; word-wrap: break-word; overflow-wrap: anywhere; }
  td.r { text-align: right; padding-right: 6px; }
  table tbody tr.row-on_leave td { background: #D8EBF4; }
  table tbody tr.row-upcoming td { background: #FFEEC4; }
  table tbody tr.row-late td { background: #FADAD6; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td.dim { color: #8892A0; }
  td.neg { color: #B3261E; font-weight: 700; }
  td.notes { text-align: right; font-size: ${landscape ? '9.5px' : '10.5px'}; color: #5C6673; }
  td.empty { height: 44px; color: #8892A0; }
  .pill { display: inline-block; border-radius: 10px; padding: 1px 7px; font-size: ${landscape ? '10px' : '11px'}; font-weight: 700; white-space: nowrap; }
  .st-active { background: #E6F4EC; color: #1E7B4A; } .st-completed { background: #ECEEF1; color: #5C6673; }
  .st-on_leave, .st-ongoing { background: #B5D8E8; color: #${COLOR}; }
  .st-upcoming { background: #FFDD99; color: #B45309; } .st-late { background: #F5BDB7; color: #B3261E; }
  .note { font-size: 11px; color: #8892A0; margin-top: 8px; line-height: 1.6; }
  .approve { margin-top: 22px; display: flex; gap: 40px; font-size: 12px; color: #3A4250; break-inside: avoid; }
  .approve div { flex: 1; border-top: 1px solid #8892A0; padding-top: 5px; text-align: center; }
  .foot { margin-top: 16px; padding-top: 8px; border-top: 1px solid #EDEFF2; font-size: 10px; color: #B4BAC2; display: flex; justify-content: space-between; }
`;

function wrapHtml(body, { landscape, generated }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS(landscape)}</style>
</head>
<body>
<div class="page" dir="rtl">
${body}
  <div class="foot"><span>تم إنشاء هذا التقرير تلقائيًا من تطبيق صيانتي</span><span><bdi dir="ltr">${dateText(generated)}</bdi></span></div>
</div>
</body>
</html>`;
}

const head = (title, sub, sub2) =>
  `  <div class="head"><div><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div>${
    sub2 ? `<div class="sub">${esc(sub2)}</div>` : ''
  }</div><div class="brand">${esc(BRAND)}</div></div>`;

const kpi = (label, value, tone = '') => `<div class="kpi"><div class="k">${esc(label)}</div><div class="v ${tone}">${esc(value)}</div></div>`;
const cell = (label, valueHtml) => `<div class="cell"><span>${esc(label)}</span><b>${valueHtml}</b></div>`;
/** صنف تلوين الصف: من في إجازة (أزرق) / إجازته قادمة (كهرماني) / متأخر (أحمر)؛ غيرهم بلا تلوين. */
const rowClass = (status) => {
  const t = status === 'ongoing' ? 'on_leave' : status;
  return t === 'on_leave' || t === 'upcoming' || t === 'late' ? ` class="row-${t}"` : '';
};
const pill = (cls, label) => `<span class="pill st-${cls}">${esc(label)}</span>`;

const APPROVE = '  <div class="approve"><div>اعتماد المسؤول</div><div>التوقيع</div></div>';

/** الأيام المتبقية للاستحقاق: ما مضى على موعد الاستحقاق يُكتب «مستحقة منذ ...» بالأحمر (بلا إشارة سالب لأنها تنعكس في النص العربي). */
function dueCell(days) {
  if (days === null || days === undefined) return '<td class="dim">—</td>';
  if (days < 0) return `<td class="neg">مستحقة منذ<br>${eastern(Math.abs(days))}</td>`;
  return `<td>${eastern(days)}</td>`;
}

function filterLabel(status) {
  return status ? `الحالة: ${STATUS_LABEL[status]}` : null;
}

function allTitles(model) {
  const f = filterLabel(model.status);
  return {
    title: 'تقرير إجازات الموظفين',
    subtitle: `${FACILITY_TITLE} — حتى تاريخ ${dateText(model.today)}`,
    subtitle2: f,
  };
}

function renderAllHtml(model) {
  const { title, subtitle, subtitle2 } = allTitles(model);
  const c = model.counts;
  const kpis = [
    kpi(model.status ? 'الموظفون المعروضون' : 'إجمالي الموظفين', eastern(c.shown)),
    kpi('على رأس العمل', eastern(c.active), 'green'),
    kpi('في إجازة', eastern(c.on_leave)),
    kpi('إجازة قادمة', eastern(c.upcoming), 'amber'),
    kpi('متأخرون عن المباشرة', eastern(c.late), c.late > 0 ? 'red' : ''),
  ];
  if (c.no_dates > 0) kpis.push(kpi('بلا تاريخ مباشرة', eastern(c.no_dates), 'amber'));

  const widths = [2.4, 4.2, 14.2, 6.4, 6.6, 6.6, 6.6, 3.2, 6.6, 6.6, 6, 8.6, 8, 4, 9.2];
  const heads = [
    'م',
    'الرقم الوظيفي',
    'اسم الموظف',
    'القسم',
    'تاريخ المباشرة / التعيين',
    'تاريخ بدء الإجازة',
    'تاريخ العودة المتوقع',
    'المدة (يوم)',
    'تاريخ العودة الفعلية',
    'تاريخ استحقاق الإجازة القادمة',
    'الأيام المتبقية للاستحقاق',
    'حالة الموظف',
    'الموظف البديل',
    'الرصيد (يوم)',
    'ملاحظات',
  ];

  const rows = model.rows.length
    ? model.rows
        .map((r) => {
          const notes = r.notes.map((n) => esc(prettyText(n))).join('<br>');
          return (
            `<tr${rowClass(r.status)}>` +
            `<td class="dim">${eastern(r.seq)}</td>` +
            `<td>${r.number ? esc(eastern(r.number)) : '—'}</td>` +
            `<td class="r">${esc(r.name)}</td>` +
            `<td>${esc(r.department || '—')}</td>` +
            `<td>${dateHtml(r.joined)}</td>` +
            `<td>${dateHtml(r.leave_start)}</td>` +
            `<td>${dateHtml(r.leave_expected)}</td>` +
            `<td>${r.duration === null ? '—' : eastern(r.duration)}</td>` +
            `<td>${dateHtml(r.leave_actual)}</td>` +
            `<td>${dateHtml(r.next_due)}</td>` +
            dueCell(r.days_to_due) +
            `<td>${pill(r.status, r.status_label)}</td>` +
            `<td>${r.replacement ? esc(prettyText(r.replacement)) : '—'}</td>` +
            `<td>${r.has_balance ? amount(r.available) : '—'}</td>` +
            `<td class="notes">${notes}</td>` +
            '</tr>'
          );
        })
        .join('')
    : `<tr><td class="empty" colspan="${heads.length}">لا يوجد موظفون مطابقون</td></tr>`;

  const body = [
    head(title, subtitle, subtitle2),
    `  <div class="kpis">${kpis.join('')}</div>`,
    `  <table><colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` +
      `<thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`,
    '  <div class="note">الإجازة المعروضة لكل موظف: المتأخرة ثم الجارية ثم أقرب قادمة ثم آخر إجازة منتهية. ' +
      'مدة الإجازة = العودة − البدء. استحقاق الإجازة القادمة = آخر مباشرة فعلية (أو تاريخ المباشرة) + ١٢ شهرًا، و«مستحقة منذ» = مضى على موعد الاستحقاق هذا العدد من الأيام. ' +
      'الرصيد المتاح محسوب تلقائيًا من التواريخ. التلوين: أزرق = في إجازة الآن، أصفر = إجازته قادمة، أحمر = متأخر عن المباشرة.</div>',
    APPROVE,
  ].join('\n');
  return {
    html: wrapHtml(body, { landscape: true, generated: model.generated }),
    orientation: 'landscape',
    title,
    subtitle: [subtitle, subtitle2].filter(Boolean).join(' — '),
    filename: `leaves-report-${model.today}${model.status ? `-${model.status}` : ''}.pdf`,
  };
}

function personTitles(model) {
  const e = model.employee;
  return {
    title: 'كشف إجازات موظف',
    subtitle: e.name,
    subtitle2: `${e.employee_number ? `الرقم الوظيفي ${eastern(e.employee_number)} — ` : ''}${FACILITY_TITLE} — حتى تاريخ ${dateText(model.today)}`,
  };
}

function serviceText(days) {
  if (days === null || days === undefined) return '—';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const parts = [];
  if (years > 0) parts.push(years === 1 ? 'سنة' : years === 2 ? 'سنتان' : `${eastern(years)} سنوات`);
  if (months > 0) parts.push(months === 1 ? 'شهر' : months === 2 ? 'شهران' : `${eastern(months)} أشهر`);
  const base = `${eastern(days)} يومًا`;
  return parts.length ? `${base} (نحو ${parts.join(' و')})` : base;
}

function renderPersonHtml(model) {
  const { title, subtitle, subtitle2 } = personTitles(model);
  const e = model.employee;

  const info = [
    cell('الرقم الوظيفي', e.employee_number ? esc(eastern(e.employee_number)) : '—'),
    cell('القسم', esc(e.department || '—')),
    cell('تاريخ التعيين', dateHtml(e.hire_date)),
    cell('تاريخ المباشرة', dateHtml(e.start_date)),
    cell('مدة الخدمة', esc(serviceText(e.service_days))),
    cell('الحالة', pill(e.status, e.status_label)),
    cell('استحقاق الإجازة القادمة', model.next_due ? `${dateHtml(model.next_due)}${model.days_to_due !== null ? ` — ${model.days_to_due < 0 ? `مستحقة منذ ${eastern(Math.abs(model.days_to_due))} يومًا` : model.days_to_due === 0 ? 'مستحقة اليوم' : `بعد ${eastern(model.days_to_due)} يومًا`}` : ''}` : '—'),
  ].join('');

  let balance;
  if (e.has_balance) {
    balance =
      '<div class="kpis">' +
      kpi('الرصيد المتاح (يوم)', amount(e.available), e.at_cap ? 'amber' : '') +
      kpi('المستحق منذ المباشرة', amount(e.accrued)) +
      kpi('المستخدم (مدفوع)', amount(e.used)) +
      kpi('ما سقط بانتهاء الصلاحية', amount(e.expired)) +
      kpi('أيام بدون راتب', intText(e.unpaid_total), e.unpaid_total > 0 ? 'amber' : '') +
      '</div>';
  } else {
    balance = '<div class="box"><div class="lbl">تعذّر حساب الرصيد</div>أدخل تاريخ مباشرة الموظف أولًا ليُحسب رصيده.</div>';
  }

  const alerts = (e.alerts || []).length
    ? `<div class="box red"><div class="lbl">تنبيهات</div>${e.alerts.map((a) => esc(prettyText(a.text))).join('<br>')}</div>`
    : '';

  const widths = [3.5, 10.5, 10.5, 10.5, 6, 11, 9, 7, 7, 11, 14];
  const heads = ['م', 'بدء الإجازة', 'العودة المتوقعة', 'العودة الفعلية', 'المدة (يوم)', 'الحالة', 'الرصيد عند البدء', 'مدفوعة', 'بدون راتب', 'الموظف البديل', 'ملاحظات'];
  const total = model.leaves.length;
  const rows = total
    ? model.leaves
        .map(
          (l, i) =>
            `<tr${rowClass(l.state)}>` +
            `<td class="dim">${eastern(total - i)}</td>` +
            `<td>${dateHtml(l.start)}</td>` +
            `<td>${dateHtml(l.expected)}</td>` +
            `<td>${dateHtml(l.actual)}</td>` +
            `<td>${l.provisional ? '—' : eastern(l.duration)}</td>` +
            `<td>${pill(l.state, l.state_label || LEAVE_STATE_LABEL[l.state])}</td>` +
            `<td>${l.balance_at_start === null || l.balance_at_start === undefined ? '—' : amount(l.balance_at_start)}</td>` +
            `<td>${l.paid === null || l.paid === undefined ? '—' : eastern(l.paid)}</td>` +
            `<td${l.unpaid > 0 ? ' class="neg"' : ''}>${l.unpaid === null || l.unpaid === undefined ? '—' : eastern(l.unpaid)}</td>` +
            `<td>${l.replacement ? esc(prettyText(l.replacement)) : '—'}</td>` +
            `<td class="notes">${l.note ? esc(prettyText(l.note)) : ''}</td>` +
            '</tr>'
        )
        .join('')
    : `<tr><td class="empty" colspan="${heads.length}">لا توجد إجازات مسجَّلة لهذا الموظف</td></tr>`;

  const roundingTxt = model.paid_rounding === 'floor' ? 'للأسفل' : 'لأقرب يوم';
  const body = [
    head(title, subtitle, subtitle2),
    `  <div class="grid">${info}</div>`,
    `  ${balance}`,
    alerts ? `  ${alerts}` : '',
    '  <div class="sec">سجل الإجازات (الأحدث أولًا)</div>',
    `  <table><colgroup>${widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` +
      `<thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`,
    `  <div class="note">الرصيد يتراكم يوميًا من تاريخ المباشرة وصلاحيته سنتان (الحد الأقصى ${amount(model.cap_days)} يومًا)، ويُخصم الأقدم أولًا. ` +
      `الأيام المدفوعة = الأقل من (مدة الإجازة، الرصيد عند البدء) بتقريب «${roundingTxt}»، والباقي بدون راتب. كل الأرقام محسوبة تلقائيًا من التواريخ.</div>`,
    APPROVE,
  ]
    .filter(Boolean)
    .join('\n');

  const num = safePart(e.employee_number) || String(e.id);
  return {
    html: wrapHtml(body, { landscape: false, generated: model.generated }),
    orientation: 'portrait',
    title,
    subtitle: [subtitle, subtitle2].join(' — '),
    filename: `leaves-employee-${num}-${model.today}.pdf`,
  };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

// تلوين صفوف Excel: أزرق فاتح لمن في إجازة، كهرماني لمن إجازته قادمة، أحمر فاتح للمتأخر.
const TONE_FILL = { on_leave: 'D8EBF4', ongoing: 'D8EBF4', upcoming: 'FFEEC4', late: 'FADAD6' };
const rowTone = (status) => (TONE_FILL[status] ? (status === 'ongoing' ? 'on_leave' : status) : null);

function makeStyles(wb) {
  const base = { border: true };
  // alt: true = تظليل الصفوف الزوجية، أو اسم حالة (on_leave/upcoming/late) = لون تلك الحالة
  const stripe = (alt) => (typeof alt === 'string' && TONE_FILL[alt] ? { fill: TONE_FILL[alt] } : alt === true ? { fill: 'F2F5F9' } : {});
  const cache = new Map();
  const get = (def) => {
    const k = JSON.stringify(def);
    if (!cache.has(k)) cache.set(k, wb.style(def));
    return cache.get(k);
  };
  return {
    header: get({ bold: true, color: 'FFFFFF', fill: COLOR, align: 'center', wrap: true, border: true }),
    title: get({ bold: true, size: 14, color: COLOR, align: 'right' }),
    label: get({ bold: true, fill: 'F2F5F9', align: 'right', border: true }),
    text: (alt) => get({ ...base, ...stripe(alt), align: 'right', wrap: true }),
    center: (alt) => get({ ...base, ...stripe(alt), align: 'center' }),
    wrapCenter: (alt) => get({ ...base, ...stripe(alt), align: 'center', wrap: true }),
    num: (alt) => get({ ...base, ...stripe(alt), align: 'center', numFmt: '#,##0' }),
    dec: (alt) => get({ ...base, ...stripe(alt), align: 'center', numFmt: '#,##0.00' }),
    id: (alt) => get({ ...base, ...stripe(alt), align: 'center', numFmt: '0' }),
    date: (alt) => get({ ...base, ...stripe(alt), align: 'center', numFmt: 'yyyy-mm-dd' }),
    neg: (alt) => get({ ...base, ...stripe(alt), align: 'center', numFmt: '#,##0', bold: true, color: 'B3261E' }),
    status: (st, alt) => {
      const tone = {
        active: ['1E7B4A', 'E6F4EC'],
        on_leave: [COLOR, 'B5D8E8'],
        ongoing: [COLOR, 'B5D8E8'],
        upcoming: ['B45309', 'FFDD99'],
        late: ['B3261E', 'F5BDB7'],
        completed: ['5C6673', 'ECEEF1'],
      }[st];
      return tone ? get({ ...base, align: 'center', bold: true, color: tone[0], fill: tone[1], wrap: true }) : get({ ...base, ...stripe(alt), align: 'center', wrap: true });
    },
  };
}

const isNumeric = (s) => typeof s === 'string' && /^\d{1,9}$/.test(s);
const dateCell = (iso, style) => (iso ? { v: iso, t: 'date', s: style } : { v: null, s: style });
const numCell = (v, style) => (v === null || v === undefined ? { v: null, s: style } : { v, s: style });

function allWorkbook(model, now = new Date()) {
  const wb = new Workbook({ title: 'تقرير إجازات الموظفين', creator: 'صيانتي' });
  const S = makeStyles(wb);

  // ---- الورقة ١: نفس أعمدة ملف المالك (A..N) ثم الرصيد والمدفوع/بدون راتب ----
  const widths1 = [6, 13, 32, 16, 17, 15, 15, 10, 15, 17, 15, 19, 20, 38, 12, 10, 11];
  const ws = wb.addSheet('جدول إجازات وسفر الموظفين', {
    rtl: true,
    landscape: true,
    widths: widths1,
    freeze: { rows: 1, cols: 3 },
    autoFilter: true,
    repeatRows: [1, 1],
    tabColor: COLOR,
  });
  const heads1 = [
    'م',
    'الرقم الوظيفي',
    'اسم الموظف',
    'القسم / الهيكل الإداري',
    'تاريخ المباشرة / التعيين',
    'تاريخ بدء الإجازة',
    'تاريخ العودة المتوقع',
    'مدة الإجازة (يوم)',
    'تاريخ العودة الفعلية',
    'تاريخ استحقاق الإجازة القادمة',
    'الأيام المتبقية للاستحقاق',
    'حالة الموظف',
    'الموظف البديل',
    'ملاحظات',
    'الرصيد المتاح (يوم)',
    'أيام مدفوعة',
    'أيام بدون راتب',
  ];
  ws.addRow(heads1.map((v) => ({ v, s: S.header })), { height: 34 });
  model.rows.forEach((r, i) => {
    const alt = rowTone(r.status) || false;
    const rn = i + 2;
    ws.addRow([
      { v: r.seq, s: S.num(alt) },
      r.number ? (isNumeric(r.number) ? { v: Number(r.number), s: S.id(alt) } : { v: r.number, s: S.center(alt) }) : { v: null, s: S.center(alt) },
      { v: r.name, s: S.text(alt) },
      { v: r.department, s: S.text(alt) },
      dateCell(r.joined, S.date(alt)),
      dateCell(r.leave_start, S.date(alt)),
      dateCell(r.leave_expected, S.date(alt)),
      numCell(r.duration, S.num(alt)),
      dateCell(r.leave_actual, S.date(alt)),
      dateCell(r.next_due, S.date(alt)),
      // الأيام المتبقية: صيغة حيّة مثل ملف المالك (تتجدد كلما فُتح الملف) مع القيمة المحسوبة وقت التصدير
      { f: `IF(J${rn}="","",J${rn}-TODAY())`, v: r.days_to_due === null ? '' : r.days_to_due, s: r.days_to_due !== null && r.days_to_due < 0 ? S.neg(alt) : S.num(alt) },
      { v: r.status_label, s: S.status(r.status, alt) },
      { v: r.replacement, s: S.text(alt) },
      { v: r.notes.join('\n') || null, s: S.text(alt) },
      r.has_balance ? { v: r.available, s: S.dec(alt) } : { v: null, s: S.dec(alt) },
      numCell(r.paid, S.num(alt)),
      numCell(r.unpaid, S.num(alt)),
    ]);
  });

  // ---- الورقة ٢: كل الإجازات (صف لكل إجازة) ----
  const ws2 = wb.addSheet('كل الإجازات', {
    rtl: true,
    landscape: true,
    widths: [6, 13, 32, 16, 15, 15, 15, 10, 17, 14, 11, 11, 20, 38],
    freeze: { rows: 1, cols: 3 },
    autoFilter: true,
    repeatRows: [1, 1],
  });
  const heads2 = ['م', 'الرقم الوظيفي', 'اسم الموظف', 'القسم', 'تاريخ بدء الإجازة', 'تاريخ العودة المتوقع', 'تاريخ العودة الفعلية', 'المدة (يوم)', 'حالة الإجازة', 'الرصيد عند البدء', 'أيام مدفوعة', 'أيام بدون راتب', 'الموظف البديل', 'ملاحظات'];
  ws2.addRow(heads2.map((v) => ({ v, s: S.header })), { height: 34 });
  model.leaves.forEach((l, i) => {
    const alt = rowTone(l.state) || false;
    ws2.addRow([
      { v: l.seq, s: S.num(alt) },
      l.number ? (isNumeric(l.number) ? { v: Number(l.number), s: S.id(alt) } : { v: l.number, s: S.center(alt) }) : { v: null, s: S.center(alt) },
      { v: l.name, s: S.text(alt) },
      { v: l.department, s: S.text(alt) },
      dateCell(l.start, S.date(alt)),
      dateCell(l.expected, S.date(alt)),
      dateCell(l.actual, S.date(alt)),
      numCell(l.duration, S.num(alt)),
      { v: l.state_label, s: S.status(l.state, alt) },
      l.balance_at_start === null || l.balance_at_start === undefined ? { v: null, s: S.dec(alt) } : { v: l.balance_at_start, s: S.dec(alt) },
      numCell(l.paid, S.num(alt)),
      numCell(l.unpaid, S.num(alt)),
      { v: l.replacement, s: S.text(alt) },
      { v: l.note, s: S.text(alt) },
    ]);
  });

  // ---- الورقة ٣: ملخص ----
  const ws3 = wb.addSheet('ملخص التقرير', { rtl: true, widths: [30, 26] });
  const c = model.counts;
  const f = filterLabel(model.status);
  const kv = (k, v, style) => ws3.addRow([{ v: k, s: S.label }, typeof v === 'number' ? { v, s: S.num(false) } : { v, s: style || S.text(false) }]);
  ws3.addRow([{ v: 'تقرير إجازات الموظفين — ' + FACILITY_TITLE, s: S.title }], { height: 26 });
  ws3.addRow([]);
  kv('التاريخ', model.today, S.center(false));
  kv('وقت الإنشاء (الرياض)', model.generated, S.center(false));
  kv('الفلتر', f || 'كل الموظفين');
  kv('الموظفون المعروضون', c.shown);
  kv('إجمالي الموظفين', c.total);
  kv('على رأس العمل', c.active);
  kv('في إجازة', c.on_leave);
  kv('إجازة قادمة', c.upcoming);
  kv('متأخرون عن المباشرة', c.late);
  kv('بلا تاريخ مباشرة', c.no_dates);
  ws3.addRow([]);
  ws3.addRow([
    {
      v: 'الإجازة المعروضة لكل موظف في الجدول الأول: المتأخرة ثم الجارية ثم أقرب قادمة ثم آخر منتهية. مدة الإجازة = العودة − البدء. عمود الأيام المتبقية يتجدد تلقائيًا عند فتح الملف (سالب = مستحقة منذ هذا العدد من الأيام).',
      s: S.text(false),
    },
  ], { height: 64 });
  ws3.merge(ws3.rows.length, 1, ws3.rows.length, 2);

  return wb.build(now);
}

function personWorkbook(model, now = new Date()) {
  const wb = new Workbook({ title: 'كشف إجازات موظف', creator: 'صيانتي' });
  const S = makeStyles(wb);
  const e = model.employee;

  const ws = wb.addSheet('بيانات الموظف', { rtl: true, widths: [28, 34], tabColor: COLOR });
  const kv = (k, v, style) => {
    let cellV;
    if (v && v.date !== undefined) cellV = dateCell(v.date, S.date(false));
    else if (typeof v === 'number') cellV = { v, s: style || S.dec(false) };
    else cellV = { v, s: style || S.text(false) };
    ws.addRow([{ v: k, s: S.label }, cellV]);
  };
  ws.addRow([{ v: `كشف إجازات — ${e.name}`, s: S.title }], { height: 26 });
  ws.addRow([]);
  kv('اسم الموظف', e.name);
  kv('الرقم الوظيفي', e.employee_number || null, S.center(false));
  kv('القسم', e.department || null);
  kv('تاريخ التعيين', { date: e.hire_date });
  kv('تاريخ المباشرة', { date: e.start_date });
  kv('مدة الخدمة', serviceText(e.service_days).replace(/[٠-٩]/g, (d) => EAST.indexOf(d)));
  kv('الحالة', e.status_label, S.status(e.status, false));
  kv('تاريخ استحقاق الإجازة القادمة', { date: model.next_due });
  kv('الأيام المتبقية للاستحقاق', model.days_to_due === null ? null : model.days_to_due, S.num(false));
  ws.addRow([]);
  if (e.has_balance) {
    kv('الرصيد المتاح (يوم)', e.available, S.dec(false));
    kv('المستحق منذ المباشرة (يوم)', e.accrued, S.dec(false));
    kv('المستخدم — مدفوع (يوم)', e.used, S.dec(false));
    kv('ما سقط بانتهاء الصلاحية (يوم)', e.expired, S.dec(false));
    kv('إجمالي أيام بدون راتب', e.unpaid_total, S.num(false));
    kv('الحد الأقصى للرصيد (يوم)', e.cap_days, S.dec(false));
  } else {
    kv('الرصيد', 'تعذّر الحساب: أدخل تاريخ المباشرة');
  }
  if ((e.alerts || []).length) {
    ws.addRow([]);
    e.alerts.forEach((a, i) => kv(i === 0 ? 'تنبيهات' : '', a.text));
  }
  ws.addRow([]);
  kv('تاريخ التقرير', model.today, S.center(false));
  kv('وقت الإنشاء (الرياض)', model.generated, S.center(false));

  const ws2 = wb.addSheet('سجل الإجازات', {
    rtl: true,
    landscape: true,
    widths: [6, 15, 15, 15, 10, 17, 14, 11, 11, 20, 38],
    freeze: { rows: 1, cols: 0 },
    autoFilter: true,
    repeatRows: [1, 1],
  });
  const heads = ['م', 'تاريخ بدء الإجازة', 'تاريخ العودة المتوقع', 'تاريخ العودة الفعلية', 'المدة (يوم)', 'حالة الإجازة', 'الرصيد عند البدء', 'أيام مدفوعة', 'أيام بدون راتب', 'الموظف البديل', 'ملاحظات'];
  ws2.addRow(heads.map((v) => ({ v, s: S.header })), { height: 34 });
  const total = model.leaves.length;
  model.leaves.forEach((l, i) => {
    const alt = rowTone(l.state) || false;
    ws2.addRow([
      { v: total - i, s: S.num(alt) },
      dateCell(l.start, S.date(alt)),
      dateCell(l.expected, S.date(alt)),
      dateCell(l.actual, S.date(alt)),
      numCell(l.provisional ? null : l.duration, S.num(alt)),
      { v: l.state_label || LEAVE_STATE_LABEL[l.state], s: S.status(l.state, alt) },
      l.balance_at_start === null || l.balance_at_start === undefined ? { v: null, s: S.dec(alt) } : { v: l.balance_at_start, s: S.dec(alt) },
      numCell(l.paid, S.num(alt)),
      numCell(l.unpaid, S.num(alt)),
      { v: l.replacement, s: S.text(alt) },
      { v: l.note, s: S.text(alt) },
    ]);
  });
  return wb.build(now);
}

module.exports = {
  STATUS_FILTERS,
  STATUS_LABEL,
  addMonths,
  eastern,
  amount,
  pickLeave,
  nextDueDate,
  buildRow,
  buildAllModel,
  buildPersonModel,
  renderAllHtml,
  renderPersonHtml,
  allWorkbook,
  personWorkbook,
  riyadhStamp,
};
