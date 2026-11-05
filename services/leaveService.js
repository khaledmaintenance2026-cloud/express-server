'use strict';
// ============================================================================
// منطق «إجازات الموظفين» على قاعدة البيانات: الإعدادات، تحميل الموظفين وإجازاتهم،
// بناء العرض المحسوب (رصيد/حالة/تنبيهات)، التحقق والإضافة والتعديل، المعاينة، الملخص.
// الحساب نفسه في lib/leaveCalc.js (دوال خالصة)؛ هنا فقط الربط بالقاعدة.
// ============================================================================

const { pool } = require('../config/db');
const C = require('../lib/leaveCalc');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
const badRequest = (m) => new HttpError(400, m);

// القسم خاص بمصنع الرجال (طلب 2026-10-25): هو القسم الافتراضي لأي موظف يُضاف من هذا القسم.
const MEN_FACILITY = 'مصنع الرجال';

// ---------------------------------------------------------------------------
// الإعدادات (site_settings)
// ---------------------------------------------------------------------------

const SETTING_KEYS = {
  annualDays: 'leave_annual_days',
  expiryYears: 'leave_expiry_years',
  paidRounding: 'leave_paid_rounding',
  soonDays: 'leave_soon_days',
  alertsEnabled: 'leave_alerts_enabled',
};

async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM site_settings WHERE key = ANY($1)', [Object.values(SETTING_KEYS)]);
  const byKey = {};
  for (const r of rows) byKey[r.key] = r.value;
  const raw = {};
  for (const [name, key] of Object.entries(SETTING_KEYS)) raw[name] = byKey[key];
  return C.cleanSettings(raw);
}

// يتحقق من تعديل الإعدادات بصرامة (يرفض القيم الخاطئة بدل تجاهلها بصمت).
function validateSettingsPatch(body) {
  const out = {};
  const num = (v) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim()));
  if (body.annualDays !== undefined) {
    const n = num(body.annualDays);
    if (!Number.isFinite(n) || n < 1 || n > 365) throw badRequest('أيام الاستحقاق السنوي يجب أن تكون رقمًا بين 1 و365');
    out.annualDays = Math.round(n * 100) / 100;
  }
  if (body.expiryYears !== undefined) {
    const n = num(body.expiryYears);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw badRequest('مدة صلاحية الرصيد يجب أن تكون عددًا صحيحًا من السنوات بين 1 و10');
    out.expiryYears = n;
  }
  if (body.paidRounding !== undefined) {
    if (body.paidRounding !== 'floor' && body.paidRounding !== 'nearest') throw badRequest('طريقة التقريب غير صحيحة (floor أو nearest)');
    out.paidRounding = body.paidRounding;
  }
  if (body.soonDays !== undefined) {
    const n = num(body.soonDays);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw badRequest('مدة تنبيه الإجازة القادمة يجب أن تكون عددًا صحيحًا من الأيام بين 1 و60');
    out.soonDays = n;
  }
  if (body.alertsEnabled !== undefined) {
    if (typeof body.alertsEnabled !== 'boolean') throw badRequest('تفعيل التنبيهات يجب أن يكون true أو false');
    out.alertsEnabled = body.alertsEnabled;
  }
  if (Object.keys(out).length === 0) throw badRequest('لا يوجد ما يُعدَّل');
  return out;
}

async function saveSettings(patch) {
  for (const [name, value] of Object.entries(patch)) {
    await pool.query(
      'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [SETTING_KEYS[name], String(value)]
    );
  }
  return getSettings();
}

function settingsForClient(s) {
  return {
    annual_days: s.annualDays,
    expiry_years: s.expiryYears,
    paid_rounding: s.paidRounding,
    soon_days: s.soonDays,
    alerts_enabled: s.alertsEnabled,
    cap_days: C.capDays(s),
  };
}

// ---------------------------------------------------------------------------
// تحميل الموظفين والإجازات
// ---------------------------------------------------------------------------

const EMP_COLUMNS = `e.id, e.name, e.employee_number, e.department,
  to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date,
  to_char(e.start_date, 'YYYY-MM-DD') AS start_date`;

const LEAVE_COLUMNS = `l.id, l.employee_id,
  to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(l.expected_return, 'YYYY-MM-DD') AS expected_return,
  to_char(l.actual_return, 'YYYY-MM-DD') AS actual_return,
  l.note, l.replacement, l.created_by, l.created_at`;

function groupLeaves(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = Number(r.employee_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

async function loadAll(db = pool) {
  const emps = await db.query(`SELECT ${EMP_COLUMNS} FROM overtime_employees e ORDER BY e.id`);
  const leaves = await db.query(`SELECT ${LEAVE_COLUMNS} FROM employee_leaves l ORDER BY l.start_date, l.id`);
  return { employees: emps.rows, leavesByEmp: groupLeaves(leaves.rows) };
}

async function loadOne(db, id, { lock = false } = {}) {
  const emp = await db.query(`SELECT ${EMP_COLUMNS} FROM overtime_employees e WHERE e.id = $1${lock ? ' FOR UPDATE OF e' : ''}`, [id]);
  if (emp.rows.length === 0) return null;
  const leaves = await db.query(`SELECT ${LEAVE_COLUMNS} FROM employee_leaves l WHERE l.employee_id = $1 ORDER BY l.start_date, l.id`, [id]);
  return { employee: emp.rows[0], leaves: leaves.rows };
}

// ---------------------------------------------------------------------------
// بناء العرض المحسوب
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  active: 'على رأس العمل',
  on_leave: 'في إجازة',
  upcoming: 'إجازة قادمة',
  late: 'متأخر عن المباشرة',
};
const LEAVE_STATE_LABEL = {
  completed: 'منتهية',
  ongoing: 'جارية',
  upcoming: 'قادمة',
  late: 'متأخر عن المباشرة',
};

const dbLeaveToCalc = (r) => ({
  id: Number(r.id),
  start: C.toDay(r.start_date),
  expected: r.expected_return ? C.toDay(r.expected_return) : null,
  actual: r.actual_return ? C.toDay(r.actual_return) : null,
});

const iso = (d) => (Number.isInteger(d) ? C.fromDay(d) : null);

function ordinalDays(n) {
  return n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يومًا`;
}

/**
 * يبني عرض موظف واحد: بياناته + الرصيد + الحالة + التنبيهات + (اختياريًا) سجل إجازاته.
 */
function buildView(emp, leaveRows, today, settings, { full = false } = {}) {
  const startDay = emp.start_date ? C.toDay(emp.start_date) : null;
  const calcLeaves = leaveRows.map(dbLeaveToCalc);
  const report = C.computeLeaveReport({ startDay, leaves: calcLeaves, today, settings });
  const dbById = new Map(leaveRows.map((r) => [Number(r.id), r]));

  const leaves = report.leaves.map((l) => ({
    id: l.id,
    start: iso(l.start),
    expected: iso(l.expected),
    actual: iso(l.actual),
    end: iso(l.end),
    duration: l.duration,
    provisional: l.provisional,
    state: l.state,
    state_label: LEAVE_STATE_LABEL[l.state],
    paid: l.paid,
    unpaid: l.unpaid,
    balance_at_start: l.balance_at_start,
    note: (dbById.get(l.id) || {}).note || null,
    replacement: (dbById.get(l.id) || {}).replacement || null,
  }));

  // الإجازة الأبرز للعرض في القائمة: متأخرة ثم جارية ثم أقرب قادمة.
  const pick = (st) => leaves.filter((l) => l.state === st).sort((a, b) => (a.start < b.start ? -1 : 1));
  const featured = pick('late')[0] || pick('ongoing')[0] || pick('upcoming')[0] || null;

  const alerts = [];
  if (!emp.employee_number) alerts.push({ code: 'missing_number', text: 'أدخل الرقم الوظيفي' });
  else if (!/^\d+$/.test(emp.employee_number)) alerts.push({ code: 'fix_number', text: 'يجب تصحيح الرقم الوظيفي' });
  if (!emp.start_date || !emp.hire_date) alerts.push({ code: 'missing_dates', text: 'أدخل تاريخ التعيين والمباشرة' });
  for (const l of leaves) {
    if (l.state === 'late') {
      const late = today - C.toDay(l.expected);
      alerts.push({ code: 'late', leave_id: l.id, expected: l.expected, text: `متأخر عن المباشرة ${ordinalDays(late)} (العودة المتوقعة ${l.expected})` });
    }
    if (!l.expected && !l.actual) {
      alerts.push({ code: 'no_return', leave_id: l.id, text: `إجازة بدأت ${l.start} بلا تاريخ عودة — أدخل العودة المتوقعة أو سجّل المباشرة` });
    }
    if (l.state === 'upcoming') {
      const left = C.toDay(l.start) - today;
      if (left <= settings.soonDays) {
        alerts.push({ code: 'soon', leave_id: l.id, start: l.start, text: `إجازة تبدأ ${left === 1 ? 'غدًا' : `بعد ${ordinalDays(left)}`} (${l.start})` });
      }
    }
  }
  if (report.at_cap) {
    alerts.push({ code: 'at_cap', text: `رصيده وصل الحد الأقصى (${report.cap_days} يومًا) — أي استحقاق جديد يُسقط الأقدم` });
  }

  const view = {
    id: Number(emp.id),
    name: emp.name,
    employee_number: emp.employee_number,
    department: emp.department,
    hire_date: emp.hire_date,
    start_date: emp.start_date,
    status: report.status,
    status_label: STATUS_LABEL[report.status],
    has_balance: report.has_balance,
    available: report.available,
    at_cap: report.at_cap,
    service_days: report.service_days,
    unpaid_total: report.unpaid_total,
    alerts,
    leave: featured
      ? { id: featured.id, start: featured.start, expected: featured.expected, actual: featured.actual, state: featured.state, state_label: featured.state_label }
      : null,
  };
  if (full) {
    view.accrued = report.accrued;
    view.used = report.used;
    view.expired = report.expired;
    view.cap_days = report.cap_days;
    view.leaves = leaves.slice().sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
  }
  return view;
}

async function listEmployees(now = new Date()) {
  const settings = await getSettings();
  const today = C.todayDay(now);
  const { employees, leavesByEmp } = await loadAll();
  const views = employees.map((e) => buildView(e, leavesByEmp.get(Number(e.id)) || [], today, settings));
  views.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return { today: C.fromDay(today), settings, views };
}

async function getEmployeeView(id, now = new Date(), db = pool) {
  const settings = await getSettings(db);
  const today = C.todayDay(now);
  const data = await loadOne(db, id);
  if (!data) return null;
  return { today: C.fromDay(today), settings, view: buildView(data.employee, data.leaves, today, settings, { full: true }) };
}

// ---------------------------------------------------------------------------
// لوحة الملخص
// ---------------------------------------------------------------------------

async function buildSummary(now = new Date()) {
  const { today, settings, views } = await listEmployees(now);
  const todayDay = C.toDay(today);
  const compact = (v, extra = {}) => ({
    id: v.id,
    name: v.name,
    employee_number: v.employee_number,
    department: v.department,
    ...extra,
  });
  const away = views.filter((v) => v.status === 'on_leave' || v.status === 'late');
  const lateList = views.filter((v) => v.status === 'late');
  // كل الإجازات القادمة (حتى لو كان الموظف في إجازة حالية وله أخرى قادمة).
  const { employees, leavesByEmp } = await loadAll();
  const upcomingAll = [];
  for (const e of employees) {
    for (const r of leavesByEmp.get(Number(e.id)) || []) {
      const l = dbLeaveToCalc(r);
      if (C.leaveState(l, todayDay) === 'upcoming') {
        upcomingAll.push({ id: Number(e.id), name: e.name, employee_number: e.employee_number, department: e.department, leave_id: l.id, start: r.start_date, expected: r.expected_return, days_left: l.start - todayDay });
      }
    }
  }
  upcomingAll.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));

  const atCap = views.filter((v) => v.at_cap);
  const missingDates = views.filter((v) => v.alerts.some((a) => a.code === 'missing_dates'));
  const noReturn = views.filter((v) => v.alerts.some((a) => a.code === 'no_return'));
  const fixNumber = views.filter((v) => v.alerts.some((a) => a.code === 'fix_number' || a.code === 'missing_number'));

  return {
    today,
    settings: settingsForClient(settings),
    counts: {
      employees: views.length,
      active: views.filter((v) => v.status === 'active').length,
      on_leave: views.filter((v) => v.status === 'on_leave').length,
      away_now: away.length,
      upcoming_leaves: upcomingAll.length,
      late: lateList.length,
      at_cap: atCap.length,
      missing_dates: missingDates.length,
      no_return: noReturn.length,
      fix_number: fixNumber.length,
    },
    lists: {
      away_now: away.map((v) => compact(v, { status: v.status, leave: v.leave })),
      upcoming: upcomingAll,
      late: lateList.map((v) => compact(v, { leave: v.leave, alerts: v.alerts.filter((a) => a.code === 'late') })),
      at_cap: atCap.map((v) => compact(v, { available: v.available })),
      missing_dates: missingDates.map((v) => compact(v)),
      no_return: noReturn.map((v) => compact(v, { leave: v.leave })),
      fix_number: fixNumber.map((v) => compact(v)),
    },
  };
}

// ---------------------------------------------------------------------------
// التحقق من الإدخال
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  let s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
  if (!s) return null;
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s || null;
}

function parseId(v) {
  if (v === undefined || v === null || !/^\d{1,15}$/.test(String(v))) return null;
  return Number(v);
}

// تاريخ اختياري: فارغ → null؛ غير فارغ ولا يوجد في التقويم → خطأ.
function optionalDate(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const d = C.toDay(String(v));
  if (d === null) throw badRequest(`${label} غير صحيح أو غير موجود في التقويم`);
  return String(v);
}

// ---------------------------------------------------------------------------
// الموظفون (الجدول المشترك overtime_employees)
// ---------------------------------------------------------------------------

function readEmployeeBody(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) throw badRequest('اسم الموظف إلزامي');
    out.name = name;
  }
  if (!partial || body.employeeNumber !== undefined) {
    const num = cleanText(body.employeeNumber, 40);
    if (!num) throw badRequest('الرقم الوظيفي إلزامي');
    out.employeeNumber = num;
  }
  if (body.department !== undefined) out.department = cleanText(body.department, 80);
  else if (!partial) out.department = MEN_FACILITY;
  if (body.hireDate !== undefined) out.hireDate = optionalDate(body.hireDate, 'تاريخ التعيين');
  else if (!partial) out.hireDate = null;
  if (body.startDate !== undefined) out.startDate = optionalDate(body.startDate, 'تاريخ المباشرة');
  else if (!partial) out.startDate = null;
  return out;
}

function checkHireStart(hireDate, startDate) {
  if (hireDate && startDate && C.toDay(startDate) < C.toDay(hireDate)) {
    throw badRequest('تاريخ المباشرة لا يمكن أن يكون قبل تاريخ التعيين');
  }
}

async function createEmployee(body, actorName) {
  const data = readEmployeeBody(body, { partial: false });
  checkHireStart(data.hireDate, data.startDate);
  const dup = await pool.query('SELECT 1 FROM overtime_employees WHERE employee_number = $1', [data.employeeNumber]);
  if (dup.rows.length > 0) throw new HttpError(409, 'هذا الرقم الوظيفي مسجَّل لموظف آخر');
  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO overtime_employees (name, employee_number, department, hire_date, start_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [data.name, data.employeeNumber, data.department, data.hireDate, data.startDate, actorName || null]
    );
  } catch (err) {
    if (err && err.code === '23505') throw new HttpError(409, 'هذا الرقم الوظيفي مسجَّل لموظف آخر');
    throw err;
  }
  return Number(inserted.rows[0].id);
}

async function updateEmployee(id, body) {
  const data = readEmployeeBody(body, { partial: true });
  if (Object.keys(data).length === 0) throw badRequest('لا يوجد ما يُعدَّل');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await loadOne(client, id, { lock: true });
    if (!cur) {
      await client.query('ROLLBACK');
      throw new HttpError(404, 'الموظف غير موجود');
    }
    const e = cur.employee;
    const name = data.name !== undefined ? data.name : e.name;
    const number = data.employeeNumber !== undefined ? data.employeeNumber : e.employee_number;
    const department = data.department !== undefined ? data.department : e.department;
    const hire = data.hireDate !== undefined ? data.hireDate : e.hire_date;
    const start = data.startDate !== undefined ? data.startDate : e.start_date;
    checkHireStart(hire, start);

    // لا إجازة يجوز أن تبدأ قبل مباشرة الموظف.
    if (start) {
      const startDay = C.toDay(start);
      const early = cur.leaves.find((l) => C.toDay(l.start_date) < startDay);
      if (early) throw new HttpError(409, `يوجد إجازة تبدأ في ${early.start_date} قبل تاريخ المباشرة ${start} — عدّل تلك الإجازة أولًا`);
    }
    if (number && number !== e.employee_number) {
      const dup = await client.query('SELECT 1 FROM overtime_employees WHERE employee_number = $1 AND id <> $2', [number, id]);
      if (dup.rows.length > 0) throw new HttpError(409, 'هذا الرقم الوظيفي مسجَّل لموظف آخر');
    }

    await client.query(
      `UPDATE overtime_employees
          SET name = $1, employee_number = $2, department = $3, hire_date = $4, start_date = $5, updated_at = now()
        WHERE id = $6`,
      [name, number, department, hire, start, id]
    );
    // نفس السلوك في routes/overtime.js: تصحيح الاسم/الرقم ينعكس على سجلات العمل الإضافي القديمة.
    const reg = await client.query("SELECT to_regclass('public.overtime_entries') AS t");
    if (reg.rows[0] && reg.rows[0].t) {
      await client.query('UPDATE overtime_entries SET employee_name = $1, employee_number = $2 WHERE employee_id = $3', [name, number, id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') throw new HttpError(409, 'هذا الرقم الوظيفي مسجَّل لموظف آخر');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// الإجازات: التحقق + المعاينة
// ---------------------------------------------------------------------------

/**
 * يتحقق من تواريخ إجازة مرشّحة لموظف (بدء/عودة متوقعة/مباشرة) ويرفض: التواريخ غير الموجودة،
 * العودة/المباشرة قبل البدء، البدء قبل مباشرة الموظف، والتداخل مع إجازاته الأخرى.
 * @param {object} emp  صف الموظف (start_date)
 * @param {Array} otherRows صفوف إجازاته الأخرى (بدون الإجازة المرشّحة)
 */
function validateCandidate(emp, otherRows, input, today, { allowMissingReturn = false } = {}) {
  const parsed = C.parseLeaveDates(
    { start: input.start, expected: input.expected, actual: input.actual },
    today,
    { allowMissingReturn }
  );
  if (parsed.error) throw badRequest(parsed.error);
  if (emp.start_date && parsed.start < C.toDay(emp.start_date)) {
    throw badRequest(`تاريخ بدء الإجازة قبل تاريخ مباشرة الموظف (${emp.start_date})`);
  }
  const hit = C.findOverlap(parsed, otherRows.map(dbLeaveToCalc), today);
  if (hit) {
    const end = Number.isInteger(hit.actual) ? hit.actual : Number.isInteger(hit.expected) ? hit.expected : null;
    throw new HttpError(
      409,
      `تتداخل هذه الإجازة مع إجازة أخرى للموظف نفسه (من ${iso(hit.start)}${end !== null ? ` إلى ${iso(end)}` : ' بلا تاريخ عودة'})`
    );
  }
  return parsed;
}

/** معاينة قبل الحفظ: الرصيد عند البدء + المدفوع + بدون راتب (دون حفظ شيء). */
async function previewLeave(employeeId, input, now = new Date(), { excludeLeaveId = null } = {}) {
  const settings = await getSettings();
  const today = C.todayDay(now);
  const data = await loadOne(pool, employeeId);
  if (!data) throw new HttpError(404, 'الموظف غير موجود');
  const others = data.leaves.filter((l) => Number(l.id) !== Number(excludeLeaveId));
  const parsed = validateCandidate(data.employee, others, input, today);

  const startDay = data.employee.start_date ? C.toDay(data.employee.start_date) : null;
  const probeId = -1;
  const report = C.computeLeaveReport({
    startDay,
    leaves: [...others.map(dbLeaveToCalc), { id: probeId, start: parsed.start, expected: parsed.expected, actual: parsed.actual }],
    today,
    settings,
  });
  const row = report.leaves.find((l) => l.id === probeId);
  return {
    start: iso(parsed.start),
    expected: iso(parsed.expected),
    actual: iso(parsed.actual),
    duration: row.duration,
    has_balance: report.has_balance,
    balance_at_start: row.balance_at_start,
    paid: row.paid,
    unpaid: row.unpaid,
    paid_rounding: settings.paidRounding,
    message: report.has_balance ? null : 'لا يمكن حساب الرصيد: أدخل تاريخ مباشرة الموظف أولًا',
  };
}

async function createLeave(employeeId, input, actorName, now = new Date()) {
  const today = C.todayDay(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = await loadOne(client, employeeId, { lock: true }); // قفل الموظف: يمنع إجازتين متداخلتين متزامنتين
    if (!data) throw new HttpError(404, 'الموظف غير موجود');
    const parsed = validateCandidate(data.employee, data.leaves, input, today);
    const note = cleanText(input.note, 300);
    const replacement = cleanText(input.replacement, 120);
    const ins = await client.query(
      `INSERT INTO employee_leaves (employee_id, start_date, expected_return, actual_return, note, replacement, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [employeeId, iso(parsed.start), iso(parsed.expected), iso(parsed.actual), note, replacement, actorName || null]
    );
    await client.query('COMMIT');
    return Number(ins.rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') throw new HttpError(409, 'توجد إجازة تبدأ في اليوم نفسه لهذا الموظف');
    throw err;
  } finally {
    client.release();
  }
}

async function updateLeave(leaveId, input, now = new Date()) {
  const today = C.todayDay(now);
  const found = await pool.query('SELECT employee_id FROM employee_leaves WHERE id = $1', [leaveId]);
  if (found.rows.length === 0) throw new HttpError(404, 'الإجازة غير موجودة');
  const employeeId = Number(found.rows[0].employee_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = await loadOne(client, employeeId, { lock: true });
    const cur = data.leaves.find((l) => Number(l.id) === leaveId);
    if (!cur) throw new HttpError(404, 'الإجازة غير موجودة');
    const others = data.leaves.filter((l) => Number(l.id) !== leaveId);
    const has = (k) => input[k] !== undefined;
    const merged = {
      start: has('start') ? input.start : cur.start_date,
      expected: has('expected') ? input.expected : cur.expected_return,
      actual: has('actual') ? input.actual : cur.actual_return,
    };
    // تعديل إجازة قديمة بلا عودة (مثل المستوردة) لا يُجبر على إدخال عودة جديدة لو لم يلمسها المستخدم.
    const parsed = validateCandidate(data.employee, others, merged, today, { allowMissingReturn: !has('expected') && !has('actual') });
    const note = has('note') ? cleanText(input.note, 300) : cur.note;
    const replacement = has('replacement') ? cleanText(input.replacement, 120) : cur.replacement;
    await client.query(
      `UPDATE employee_leaves SET start_date = $1, expected_return = $2, actual_return = $3, note = $4, replacement = $5, updated_at = now() WHERE id = $6`,
      [iso(parsed.start), iso(parsed.expected), iso(parsed.actual), note, replacement, leaveId]
    );
    await client.query('COMMIT');
    return employeeId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') throw new HttpError(409, 'توجد إجازة تبدأ في اليوم نفسه لهذا الموظف');
    throw err;
  } finally {
    client.release();
  }
}

/** «تسجيل المباشرة»: تاريخ المباشرة بعد الإجازة فقط. */
async function registerReturn(leaveId, actualDate, now = new Date()) {
  const found = await pool.query('SELECT employee_id, actual_return FROM employee_leaves WHERE id = $1', [leaveId]);
  if (found.rows.length === 0) throw new HttpError(404, 'الإجازة غير موجودة');
  if (found.rows[0].actual_return) throw new HttpError(409, 'تم تسجيل المباشرة لهذه الإجازة مسبقًا — استخدم تعديل الإجازة لتصحيحها');
  return updateLeave(leaveId, { actual: actualDate }, now);
}

async function deleteLeave(leaveId) {
  const { rows } = await pool.query('DELETE FROM employee_leaves WHERE id = $1 RETURNING employee_id', [leaveId]);
  if (rows.length === 0) throw new HttpError(404, 'الإجازة غير موجودة');
  return Number(rows[0].employee_id);
}

module.exports = {
  MEN_FACILITY,
  HttpError,
  badRequest,
  SETTING_KEYS,
  getSettings,
  saveSettings,
  validateSettingsPatch,
  settingsForClient,
  loadAll,
  loadOne,
  buildView,
  listEmployees,
  getEmployeeView,
  buildSummary,
  createEmployee,
  updateEmployee,
  previewLeave,
  createLeave,
  updateLeave,
  registerReturn,
  deleteLeave,
  parseId,
  cleanText,
  dbLeaveToCalc,
  STATUS_LABEL,
};
