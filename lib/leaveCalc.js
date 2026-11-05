'use strict';
// ============================================================================
// محرك حساب إجازات الموظفين (استحقاق + رصيد + مدفوع/بدون راتب + حالة الموظف)
//
// دوال خالصة بلا قاعدة بيانات ولا ساعة نظام (اليوم يُمرَّر لها)، فيسهل اختبارها.
//
// المعادلات (حسب طلب الإدارة 2026-10-25) — t وكل التواريخ أرقام أيام (لا ساعات):
//   A(t) = استحقاق × max(0, t − تاريخ المباشرة) ÷ 365          (المتراكم حتى t)
//   P(t) = مجموع الأيام المدفوعة من الإجازات التي بدأت قبل t
//   E(t) = max(0, أكبر قيمة لـ [A(τ − 730) − P(τ)])  حيث τ = تاريخ بدء كل إجازة سابقة وτ = t
//   الرصيد(t) = A(t) − P(t) − E(t)
//   المدفوع = min(المدة، floor(الرصيد عند البدء))، وبدون راتب = المدة − المدفوع
// (730 = سنوات الصلاحية × 365 — قابلة للتعديل من الإعدادات، كما الاستحقاق 21).
//
// دقة الحساب: كل المقادير تُحفظ كأعداد صحيحة بوحدة (١/٣٦٥٠٠ يوم) = ١٠٠ × ٣٦٥،
// فلا أخطاء كسور عشرية (مثلًا ٢١×٧٣٠÷٣٦٥ = ٤٢ تمامًا).
//
// قرارات تفسير موثّقة (تحتاج اعتماد المالك):
//  - الرصيد «الآن» يحسب الإجازات التي بدأت اليوم أو قبله (المعادلة تقول «قبل t»، لكن
//    إجازة بدأت اليوم تُخصم من رصيد الموظف الظاهر اليوم حتى لا يُرى رصيد غير حقيقي).
//    رصيد «عند بداية» كل إجازة يتبع المعادلة حرفيًا (بلا الإجازة نفسها).
//  - إجازة بلا عودة متوقعة ولا مباشرة: مدتها مؤقتة = من البدء حتى اليوم (يوم على الأقل).
//  - تقريب الأيام المدفوعة: المعادلة تقول floor، لكن مثال الإدارة (الموظف 2145: رصيد ٩٫٩٥ يوم
//    عند بدء الإجازة ⇒ «النتيجة الصحيحة ١٠ مدفوعة»، وfloor يعطي ٩) لا يتحقق إلا بالتقريب لأقرب يوم.
//    لذلك الافتراضي «nearest» (يطابق المثال) وقابل للتحويل إلى floor من الإعدادات
//    (leave_paid_rounding)؛ وقد يزيد nearest عن الرصيد بأقل من نصف يوم.
// ============================================================================

const UNITS_PER_DAY = 36500; // ١٠٠ (منزلتان للاستحقاق) × ٣٦٥ يوم
const DAY_MS = 86400000;

const DEFAULT_SETTINGS = Object.freeze({
  annualDays: 21, // أيام الاستحقاق السنوي
  expiryYears: 2, // مدة صلاحية الرصيد بالسنوات (يسقط ما مرّ عليه أكثر منها)
  paidRounding: 'nearest', // 'nearest' (لأقرب يوم — يطابق مثال الإدارة 2145 = 10 مدفوعة) | 'floor' (للأسفل حرفيًا من المعادلة)
  soonDays: 7, // تنبيه «إجازة تبدأ خلال كذا يوم»
  alertsEnabled: true, // إرسال التنبيهات (واتساب وداخل التطبيق)
});

// ---------------------------------------------------------------------------
// التواريخ
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' → رقم اليوم (أيام منذ 1970-01-01 UTC)، أو null لو غير صالح (30 فبراير، صيغة خاطئة…). */
function toDay(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY_MS);
}

/** رقم اليوم → 'YYYY-MM-DD'. */
function fromDay(n) {
  if (!Number.isInteger(n)) return null;
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** تاريخ اليوم (رقم يوم) بتوقيت المنطقة الزمنية المعطاة (الافتراضي الرياض). */
function todayDay(now = new Date(), timeZone = 'Asia/Riyadh') {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return toDay(iso);
}

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------

function numberInRange(v, min, max, fallback, decimals = 2) {
  const n = typeof v === 'number' ? v : Number(String(v === undefined || v === null ? '' : v).replace(',', '.').trim());
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** يقبل كائنًا ناقصًا/نصوصًا (من site_settings) ويرجع إعدادات سليمة كاملة. */
function cleanSettings(raw) {
  const r = raw || {};
  const d = DEFAULT_SETTINGS;
  const rounding = r.paidRounding === 'floor' || r.paidRounding === 'nearest' ? r.paidRounding : d.paidRounding;
  const enabledRaw = r.alertsEnabled;
  const alertsEnabled = enabledRaw === undefined || enabledRaw === null || enabledRaw === ''
    ? d.alertsEnabled
    : !(enabledRaw === false || enabledRaw === '0' || enabledRaw === 0 || String(enabledRaw).toLowerCase() === 'false');
  return {
    annualDays: numberInRange(r.annualDays, 0.01, 365, d.annualDays, 2),
    expiryYears: Math.round(numberInRange(r.expiryYears, 1, 10, d.expiryYears, 0)),
    paidRounding: rounding,
    soonDays: Math.round(numberInRange(r.soonDays, 1, 60, d.soonDays, 0)),
    alertsEnabled,
  };
}

/** الحد الأقصى للرصيد = استحقاق السنة × سنوات الصلاحية (٢١ × ٢ = ٤٢). */
function capDays(settings) {
  const s = cleanSettings(settings);
  return Math.round(s.annualDays * s.expiryYears * 100) / 100;
}

// ---------------------------------------------------------------------------
// مدة الإجازة وحالتها
// ---------------------------------------------------------------------------

/** نهاية الإجازة (أول يوم عمل): المباشرة الفعلية، وإلا العودة المتوقعة، وإلا مؤقتة (اليوم + ١). */
function leaveSpan(l, today) {
  let end;
  let provisional = false;
  if (Number.isInteger(l.actual)) end = l.actual;
  else if (Number.isInteger(l.expected)) end = l.expected;
  else {
    end = Math.max(l.start + 1, today + 1);
    provisional = true;
  }
  return { end, duration: Math.max(0, end - l.start), provisional };
}

/** حالة إجازة واحدة: completed | upcoming | late | ongoing */
function leaveState(l, today) {
  if (Number.isInteger(l.actual)) return 'completed';
  if (l.start > today) return 'upcoming';
  if (Number.isInteger(l.expected) && today > l.expected) return 'late';
  return 'ongoing';
}

/** حالة الموظف: late > on_leave > upcoming > active. */
function employeeStatus(leaves, today) {
  let late = false;
  let onLeave = false;
  let upcoming = false;
  for (const l of leaves) {
    const st = leaveState(l, today);
    if (st === 'late') late = true;
    else if (st === 'ongoing') onLeave = true;
    else if (st === 'upcoming') upcoming = true;
  }
  if (late) return 'late';
  if (onLeave) return 'on_leave';
  if (upcoming) return 'upcoming';
  return 'active';
}

// ---------------------------------------------------------------------------
// التحقق من المدخلات
// ---------------------------------------------------------------------------

/**
 * يتحقق من تواريخ إجازة (نصوص ISO أو null): {start, expected, actual}. يرجع {error} أو {start, expected, actual} أرقام أيام.
 * allowMissingReturn=true للاستيراد (إجازة بلا عودة متوقعة ولا مباشرة).
 */
function parseLeaveDates({ start, expected, actual }, today, { allowMissingReturn = false } = {}) {
  const s = toDay(start);
  if (s === null) return { error: 'تاريخ بدء الإجازة غير صحيح أو غير موجود في التقويم' };
  const hasExpected = expected !== undefined && expected !== null && expected !== '';
  const hasActual = actual !== undefined && actual !== null && actual !== '';
  let e = null;
  let a = null;
  if (hasExpected) {
    e = toDay(expected);
    if (e === null) return { error: 'تاريخ العودة المتوقع غير صحيح أو غير موجود في التقويم' };
    if (e <= s) return { error: 'تاريخ العودة المتوقع يجب أن يكون بعد تاريخ بدء الإجازة' };
  }
  if (hasActual) {
    a = toDay(actual);
    if (a === null) return { error: 'تاريخ المباشرة بعد الإجازة غير صحيح أو غير موجود في التقويم' };
    if (a <= s) return { error: 'تاريخ المباشرة بعد الإجازة يجب أن يكون بعد تاريخ بدء الإجازة' };
    if (Number.isInteger(today) && a > today) return { error: 'تاريخ المباشرة لا يمكن أن يكون بعد اليوم' };
  }
  if (e === null && a === null && !allowMissingReturn) {
    return { error: 'أدخل تاريخ العودة المتوقع' };
  }
  return { start: s, expected: e, actual: a };
}

/** هل تتداخل الإجازة [start, end) مع إجازة أخرى؟ ترجع الإجازة المتداخلة أو null. (إجازة بلا نهاية = مفتوحة.) */
function findOverlap(candidate, others, today) {
  const endOf = (l) => {
    if (Number.isInteger(l.actual)) return l.actual;
    if (Number.isInteger(l.expected)) return l.expected;
    return Infinity;
  };
  const cs = candidate.start;
  const ce = endOf(candidate);
  for (const o of others) {
    const oe = endOf(o);
    if (cs < oe && o.start < ce) return o;
  }
  return null;
}

// ---------------------------------------------------------------------------
// الحساب الرئيسي
// ---------------------------------------------------------------------------

const toDays2 = (units) => Math.round((units / UNITS_PER_DAY) * 100) / 100;

/**
 * @param startDay رقم يوم المباشرة (أو null لو غير معروف → لا رصيد)
 * @param leaves   [{id, start, expected, actual}] أرقام أيام (expected/actual قد تكون null)
 * @param today    رقم يوم اليوم
 * @param settings إعدادات (تُنقّى بـ cleanSettings)
 */
function computeLeaveReport({ startDay, leaves, today, settings }) {
  const s = cleanSettings(settings);
  const ent = Math.round(s.annualDays * 100);
  const expiryDays = s.expiryYears * 365;
  const capUnits = ent * expiryDays;
  const hasBalance = Number.isInteger(startDay);
  const A = (t) => (hasBalance ? ent * Math.max(0, t - startDay) : 0);

  const sorted = leaves
    .map((l) => ({ id: l.id, start: l.start, expected: Number.isInteger(l.expected) ? l.expected : null, actual: Number.isInteger(l.actual) ? l.actual : null }))
    .sort((a, b) => a.start - b.start || (a.id > b.id ? 1 : -1));

  let P = 0; // مجموع المدفوع (وحدات) قبل الإجازة الحالية
  let M = 0; // أكبر قيمة سابقة لـ [A(τ−730) − P(τ)] (≥ ٠)
  let Pnow = 0;
  let Mnow = 0;
  let unpaidNow = 0;
  const rows = [];

  for (const l of sorted) {
    const span = leaveSpan(l, today);
    const row = {
      id: l.id,
      start: l.start,
      expected: l.expected,
      actual: l.actual,
      end: span.end,
      duration: span.duration,
      provisional: span.provisional,
      state: leaveState(l, today),
      paid: null,
      unpaid: null,
      balance_at_start: null,
    };
    if (hasBalance) {
      const term = A(l.start - expiryDays) - P;
      if (term > M) M = term;
      const availUnits = A(l.start) - P - M;
      const nonNeg = Math.max(0, availUnits);
      const whole = s.paidRounding === 'nearest'
        ? Math.floor((nonNeg + UNITS_PER_DAY / 2) / UNITS_PER_DAY)
        : Math.floor(nonNeg / UNITS_PER_DAY);
      row.paid = Math.min(span.duration, whole);
      row.unpaid = span.duration - row.paid;
      row.balance_at_start = toDays2(nonNeg);
      P += row.paid * UNITS_PER_DAY;
    }
    if (l.start <= today) {
      if (hasBalance) {
        Pnow = P;
        Mnow = M;
        unpaidNow += row.unpaid;
      }
    }
    rows.push(row);
  }

  const report = {
    has_balance: hasBalance,
    leaves: rows,
    status: employeeStatus(sorted, today),
    cap_days: capDays(s),
    settings: s,
  };

  if (hasBalance) {
    const accrued = A(today);
    const expiredUnits = Math.max(Mnow, A(today - expiryDays) - Pnow, 0);
    const availUnits = Math.max(0, accrued - Pnow - expiredUnits);
    report.service_days = Math.max(0, today - startDay);
    report.accrued = toDays2(accrued);
    report.used = toDays2(Pnow);
    report.expired = toDays2(expiredUnits);
    report.available = toDays2(availUnits);
    report.available_units = availUnits;
    report.cap_units = capUnits;
    report.at_cap = availUnits >= capUnits;
    report.unpaid_total = unpaidNow;
  } else {
    report.service_days = null;
    report.accrued = null;
    report.used = null;
    report.expired = null;
    report.available = null;
    report.available_units = null;
    report.cap_units = capUnits;
    report.at_cap = false;
    report.unpaid_total = null;
  }
  return report;
}

module.exports = {
  UNITS_PER_DAY,
  DEFAULT_SETTINGS,
  toDay,
  fromDay,
  todayDay,
  cleanSettings,
  capDays,
  leaveSpan,
  leaveState,
  employeeStatus,
  parseLeaveDates,
  findOverlap,
  computeLeaveReport,
};
