'use strict';
// ============================================================================
// العمل الإضافي (ساعات العمل الإضافي) — طلب 2026-10-06
//
// تبويب مخصّص للمسؤولين فقط: مدير النظام + مسؤول الصيانة + مسؤول الإنتاج +
// مسؤول السلامة (توسيع 2026-10-06 بطلب الإدارة)؛ الفني العادي وموظف الإنتاج
// العادي والمخزون والمصمم والقسم العام لا يرونه ولا يقدرون يستدعون أي مسار
// هنا (requireRole أدناه هو الفاصل الملزم فعليًا، وإخفاء التبويب في التطبيق
// للمظهر فقط). كل من يملك الصلاحية يرى نفس البيانات ويسجّل لكل الأفراد.
//
//  - قائمة أفراد دائمة (الاسم + الرقم الوظيفي) تُضاف وتُعدَّل وتُحذف.
//  - سجل عمل إضافي: التاريخ + العمل + السبب (اختياري) + معلومات اختيارية
//    (الموقع، الخطوط، المنتج، الباتش، عدد العمال، وقت البداية والنهاية) +
//    الأفراد الذين عملوا (يُنسخ اسم/رقم كل فرد داخل السجل نفسه، فيبقى التقرير
//    القديم سليمًا حتى لو حُذف الفرد من القائمة لاحقًا).
//  - تقرير ليوم معيّن أو شهر معيّن (قائمة + ملخص لكل فرد + إجماليات)، وإرسال
//    ملخصه على واتساب (لجوال الطالب أو لجروب).
//
// الجداول تُنشأ تلقائيًا عند أول استخدام (CREATE TABLE IF NOT EXISTS) — لا حاجة
// لأي أمر ترحيل يدوي.
// ============================================================================

const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { sendWhatsappText } = require('../services/textmebot');

const router = new Router();

// الأدوار المسموح لها بالعمل الإضافي (مدير النظام يمرّ دائمًا داخل requireRole).
// مطابقة لـ canOpenOvertimeTab في التطبيق (overtime_home_screen.dart).
const OVERTIME_ROLES = ['maintenance_manager', 'production_manager', 'safety'];

// ---------------------------------------------------------------------------
// إنشاء الجداول (مرة واحدة لكل تشغيل، آمن للتكرار)
// ---------------------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS overtime_employees (
     id               BIGSERIAL PRIMARY KEY,
     name             TEXT NOT NULL,
     employee_number  TEXT,
     created_by       TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS overtime_employees_number_uq
     ON overtime_employees (employee_number) WHERE employee_number IS NOT NULL`,
  // أعمدة قسم «إجازات الموظفين» (القسم + تاريخ التعيين + تاريخ المباشرة) — اختيارية، راجع routes/leaves.js
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS department TEXT`,
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS hire_date DATE`,
  `ALTER TABLE overtime_employees ADD COLUMN IF NOT EXISTS start_date DATE`,
  `CREATE TABLE IF NOT EXISTS overtime_records (
     id                BIGSERIAL PRIMARY KEY,
     work_date         DATE NOT NULL,
     work_description  TEXT NOT NULL,
     reason            TEXT,
     start_time        TIME,
     end_time          TIME,
     location          TEXT,
     lines             TEXT,
     product           TEXT,
     batch             TEXT,
     workers_count     INT,
     created_by        TEXT,
     created_by_user   BIGINT,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS overtime_records_date_idx ON overtime_records (work_date)`,
  `CREATE TABLE IF NOT EXISTS overtime_entries (
     id               BIGSERIAL PRIMARY KEY,
     record_id        BIGINT NOT NULL REFERENCES overtime_records(id) ON DELETE CASCADE,
     employee_id      BIGINT REFERENCES overtime_employees(id) ON DELETE SET NULL,
     employee_name    TEXT NOT NULL,
     employee_number  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS overtime_entries_record_idx ON overtime_entries (record_id)`,
  `CREATE INDEX IF NOT EXISTS overtime_entries_employee_idx ON overtime_entries (employee_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS overtime_entries_record_employee_uq
     ON overtime_entries (record_id, employee_id) WHERE employee_id IS NOT NULL`,
];

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      for (const sql of DDL) await pool.query(sql);
    })().catch((err) => {
      tablesReady = null; // نعيد المحاولة في الطلب التالي
      throw err;
    });
  }
  return tablesReady;
}

router.use(requireAuth, requireApproved, requireRole(...OVERTIME_ROLES), async (req, res, next) => {
  try {
    await ensureTables();
  } catch (err) {
    console.error('تعذّر تجهيز جداول العمل الإضافي:', err.message);
    return res.status(500).json({ error: 'تعذّر تجهيز قاعدة بيانات العمل الإضافي، حاول مرة أخرى' });
  }
  next();
});

// ---------------------------------------------------------------------------
// أدوات التحقق والتنسيق
// ---------------------------------------------------------------------------

// يقصّ النص ويحذف محارف التحكم (يُبقي السطر الجديد والتبويب) ويقتطع بحسب
// الحروف (code points) لا وحدات UTF-16 حتى لا يُقطع حرف في المنتصف. فارغ → null.
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

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function parseId(v) {
  if (v === undefined || v === null || !/^\d{1,15}$/.test(String(v))) return null;
  return Number(v);
}

// يحوّل (date | month | from+to) إلى مدى {from, to, mode} أو يرمي خطأً بحالة 400.
function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function resolveRange(q) {
  if (q.date) {
    if (!isValidDate(q.date)) throw badRequest('تاريخ غير صحيح');
    return { mode: 'day', from: q.date, to: q.date };
  }
  if (q.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw badRequest('شهر غير صحيح');
    const [y, m] = q.month.split('-').map(Number);
    if (y < 2000 || y > 2100) throw badRequest('شهر غير صحيح');
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { mode: 'month', from: `${q.month}-01`, to: `${q.month}-${String(last).padStart(2, '0')}` };
  }
  if (q.from && q.to) {
    if (!isValidDate(q.from) || !isValidDate(q.to)) throw badRequest('تاريخ غير صحيح');
    if (q.from > q.to) throw badRequest('تاريخ البداية بعد تاريخ النهاية');
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86400000;
    if (days > 400) throw badRequest('المدة المطلوبة أطول من اللازم (الحد الأقصى ٤٠٠ يوم)');
    return { mode: 'range', from: q.from, to: q.to };
  }
  throw badRequest('حدّد يومًا (date) أو شهرًا (month) أو مدة (from/to)');
}

// عدد الساعات بين وقتين HH:MM، مع دعم تجاوز منتصف الليل (٢٢:٠٠ → ٠٢:٠٠ = ٤ ساعات).
function computeHours(start, end) {
  if (!isValidTime(start) || !isValidTime(end)) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 1440;
  return Math.round((minutes / 60) * 100) / 100;
}

const round2 = (n) => Math.round(n * 100) / 100;

// فترة السجل بالدقائق من منتصف ليل تاريخه (٢٢:٠٠ → ٠٢:٠٠ تصير ١٣٢٠ → ١٥٦٠)، أو null
// لو لا وقت محدد.
function recordInterval(r) {
  if (!isValidTime(r.start_time) || !isValidTime(r.end_time)) return null;
  const [sh, sm] = r.start_time.split(':').map(Number);
  const [eh, em] = r.end_time.split(':').map(Number);
  const s = sh * 60 + sm;
  let e = eh * 60 + em;
  if (e <= s) e += 1440;
  return [s, e];
}

// مجموع الدقائق بعد دمج الفترات المتداخلة: الفرد الواحد لا يعمل عملين في الساعة
// نفسها، فلا يُحسب له الوقت المتداخل مرتين.
function mergedMinutes(intervals) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of sorted) {
    if (curE === null || s > curE) {
      if (curE !== null) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE !== null) total += curE - curS;
  return total;
}

// ساعات فرد في مجموعة سجلات يومٍ واحد (تُدمج الأوقات المتداخلة).
const unionHours = (recs) => round2(mergedMinutes(recs.map(recordInterval).filter(Boolean)) / 60);

// ---------------------------------------------------------------------------
// الأفراد (قائمة دائمة)
// ---------------------------------------------------------------------------

function mapEmployee(r) {
  return {
    id: r.id,
    name: r.name,
    employee_number: r.employee_number,
    department: r.department,
    hire_date: r.hire_date,
    start_date: r.start_date,
    created_at: r.created_at,
  };
}

// GET /api/overtime/employees
router.get('/employees', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, employee_number, department,
            to_char(hire_date, 'YYYY-MM-DD') AS hire_date, to_char(start_date, 'YYYY-MM-DD') AS start_date, created_at
       FROM overtime_employees ORDER BY name, id`
  );
  const employees = rows.map(mapEmployee).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  res.json({ employees });
});

function readEmployeeBody(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) throw badRequest('اسم الفرد إلزامي');
    out.name = name;
  }
  if (!partial || body.employeeNumber !== undefined) {
    out.employeeNumber = cleanText(body.employeeNumber, 40);
  }
  return out;
}

// POST /api/overtime/employees — { name, employeeNumber? }
router.post('/employees', async (req, res) => {
  let data;
  try {
    data = readEmployeeBody(req.body || {}, { partial: false });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const number = data.employeeNumber || null;

  // منع التكرار الواضح: نفس الرقم الوظيفي، أو نفس الاسم (بلا اعتبار الحالة) بلا رقم وظيفي لأي منهما
  if (number) {
    const dup = await pool.query('SELECT 1 FROM overtime_employees WHERE employee_number = $1', [number]);
    if (dup.rows.length > 0) return res.status(409).json({ error: 'هذا الرقم الوظيفي مسجَّل لفرد آخر' });
  } else {
    const dup = await pool.query(
      'SELECT 1 FROM overtime_employees WHERE lower(name) = lower($1) AND employee_number IS NULL',
      [data.name]
    );
    if (dup.rows.length > 0) return res.status(409).json({ error: 'هذا الفرد مضاف مسبقًا' });
  }

  const { rows } = await pool.query(
    `INSERT INTO overtime_employees (name, employee_number, created_by)
     VALUES ($1, $2, $3) RETURNING id, name, employee_number, created_at`,
    [data.name, number, req.user.name || null]
  );
  res.status(201).json({ employee: mapEmployee(rows[0]) });
});

// PATCH /api/overtime/employees/:id — تعديل الاسم و/أو الرقم الوظيفي، ويُحدَّث
// معه الاسم/الرقم المنسوخ داخل كل سجلات العمل الإضافي السابقة لنفس الفرد
// (تصحيح خطأ إملائي مثلًا ينعكس على التقارير القديمة).
router.patch('/employees/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let data;
  try {
    data = readEmployeeBody(req.body || {}, { partial: true });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  if (data.name === undefined && data.employeeNumber === undefined) {
    return res.status(400).json({ error: 'لا يوجد ما يُعدَّل' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT id, name, employee_number FROM overtime_employees WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الفرد غير موجود' });
    }
    const name = data.name !== undefined ? data.name : cur.rows[0].name;
    const number = data.employeeNumber !== undefined ? (data.employeeNumber || null) : cur.rows[0].employee_number;

    if (number) {
      const dup = await client.query(
        'SELECT 1 FROM overtime_employees WHERE employee_number = $1 AND id <> $2',
        [number, id]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'هذا الرقم الوظيفي مسجَّل لفرد آخر' });
      }
    }

    const { rows } = await client.query(
      `UPDATE overtime_employees SET name = $1, employee_number = $2, updated_at = now()
       WHERE id = $3 RETURNING id, name, employee_number, created_at`,
      [name, number, id]
    );
    await client.query(
      'UPDATE overtime_entries SET employee_name = $1, employee_number = $2 WHERE employee_id = $3',
      [name, number, id]
    );
    await client.query('COMMIT');
    res.json({ employee: mapEmployee(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/overtime/employees/:id — يُحذف من القائمة فقط؛ سجلاته السابقة
// تبقى في التقارير القديمة باسمه ورقمه كما كانا.
router.delete('/employees/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let rowCount;
  try {
    ({ rowCount } = await pool.query('DELETE FROM overtime_employees WHERE id = $1', [id]));
  } catch (err) {
    // 23503 = مخالفة مفتاح أجنبي: للموظف إجازات مسجَّلة في قسم «إجازات الموظفين» (employee_leaves)
    if (err && err.code === '23503') {
      return res.status(409).json({ error: 'لا يمكن حذف هذا الموظف لأن له إجازات مسجَّلة في قسم إجازات الموظفين — احذف إجازاته أولًا' });
    }
    throw err;
  }
  if (rowCount === 0) return res.status(404).json({ error: 'الفرد غير موجود' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// سجلات العمل الإضافي
// ---------------------------------------------------------------------------

const RECORD_COLUMNS = `
  r.id,
  to_char(r.work_date, 'YYYY-MM-DD') AS work_date,
  r.work_description, r.reason,
  to_char(r.start_time, 'HH24:MI') AS start_time,
  to_char(r.end_time, 'HH24:MI') AS end_time,
  r.location, r.lines, r.product, r.batch, r.workers_count,
  r.created_by, r.created_at`;

async function loadRecords(clientOrPool, whereSql, params) {
  const { rows } = await clientOrPool.query(
    `SELECT ${RECORD_COLUMNS} FROM overtime_records r ${whereSql} ORDER BY r.work_date, r.id`,
    params
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const entries = await clientOrPool.query(
    `SELECT id, record_id, employee_id, employee_name, employee_number
       FROM overtime_entries WHERE record_id = ANY($1::bigint[]) ORDER BY id`,
    [ids]
  );
  const byRecord = new Map();
  for (const e of entries.rows) {
    if (!byRecord.has(e.record_id)) byRecord.set(e.record_id, []);
    byRecord.get(e.record_id).push({
      id: e.id,
      employee_id: e.employee_id,
      name: e.employee_name,
      employee_number: e.employee_number,
    });
  }
  return rows.map((r) => {
    const list = (byRecord.get(r.id) || []).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const hours = computeHours(r.start_time, r.end_time);
    return {
      ...r,
      hours,
      entries: list,
      employees_count: list.length,
      person_hours: hours === null ? null : round2(hours * list.length),
    };
  });
}

// يقرأ ويتحقق من جسم سجل (إنشاء أو تعديل كامل). يرمي badRequest عند أي خطأ.
function readRecordBody(body) {
  const b = body || {};
  if (!isValidDate(b.workDate)) throw badRequest('تاريخ العمل الإضافي إلزامي وبصيغة صحيحة');
  const workDescription = cleanText(b.workDescription, 1000);
  if (!workDescription) throw badRequest('وصف العمل إلزامي');

  const startTime = b.startTime ? String(b.startTime) : null;
  const endTime = b.endTime ? String(b.endTime) : null;
  if ((startTime && !isValidTime(startTime)) || (endTime && !isValidTime(endTime))) {
    throw badRequest('وقت غير صحيح (الصيغة المطلوبة ٢٤ ساعة مثل 17:30)');
  }
  if ((startTime && !endTime) || (!startTime && endTime)) {
    throw badRequest('حدّد وقت البداية ووقت النهاية معًا أو اتركهما فارغين');
  }
  if (startTime && startTime === endTime) throw badRequest('وقت النهاية يساوي وقت البداية');

  let workersCount = null;
  if (b.workersCount !== undefined && b.workersCount !== null && String(b.workersCount).trim() !== '') {
    const n = Number(b.workersCount);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw badRequest('عدد العمال يجب أن يكون رقمًا صحيحًا موجبًا');
    workersCount = n;
  }

  let employeeIds = [];
  if (b.employeeIds !== undefined && b.employeeIds !== null) {
    if (!Array.isArray(b.employeeIds)) throw badRequest('قائمة الأفراد غير صحيحة');
    if (b.employeeIds.length > 300) throw badRequest('عدد الأفراد كبير جدًا');
    const seen = new Set();
    for (const raw of b.employeeIds) {
      const id = parseId(raw);
      if (!id) throw badRequest('معرّف فرد غير صحيح');
      if (!seen.has(id)) { seen.add(id); employeeIds.push(id); }
    }
  }

  return {
    workDate: b.workDate,
    workDescription,
    reason: cleanText(b.reason, 1000),
    startTime,
    endTime,
    location: cleanText(b.location, 120),
    lines: cleanText(b.lines, 200),
    product: cleanText(b.product, 200),
    batch: cleanText(b.batch, 100),
    workersCount,
    employeeIds,
  };
}

async function writeEntries(client, recordId, employeeIds) {
  if (employeeIds.length === 0) return;
  const { rows } = await client.query(
    'SELECT id, name, employee_number FROM overtime_employees WHERE id = ANY($1::bigint[])',
    [employeeIds]
  );
  if (rows.length !== employeeIds.length) {
    throw badRequest('أحد الأفراد المختارين لم يعد موجودًا في القائمة — حدّث الصفحة وأعد الاختيار');
  }
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of employeeIds) {
    const e = byId.get(id);
    await client.query(
      `INSERT INTO overtime_entries (record_id, employee_id, employee_name, employee_number)
       VALUES ($1, $2, $3, $4)`,
      [recordId, id, e.name, e.employee_number]
    );
  }
}

// GET /api/overtime/records?date=YYYY-MM-DD | month=YYYY-MM | from=&to=
router.get('/records', async (req, res) => {
  let range;
  try {
    range = resolveRange(req.query || {});
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const records = await loadRecords(pool, 'WHERE r.work_date BETWEEN $1 AND $2', [range.from, range.to]);
  res.json({ from: range.from, to: range.to, records });
});

// POST /api/overtime/records
router.post('/records', async (req, res) => {
  let d;
  try {
    d = readRecordBody(req.body);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO overtime_records
         (work_date, work_description, reason, start_time, end_time, location, lines, product, batch,
          workers_count, created_by, created_by_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [d.workDate, d.workDescription, d.reason, d.startTime, d.endTime, d.location, d.lines, d.product,
        d.batch, d.workersCount, req.user.name || null, req.user.id || null]
    );
    const id = ins.rows[0].id;
    await writeEntries(client, id, d.employeeIds);
    await client.query('COMMIT');
    const [record] = await loadRecords(pool, 'WHERE r.id = $1', [id]);
    res.status(201).json({ record });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/overtime/records/:id — تعديل كامل (نفس حقول الإنشاء؛ قائمة الأفراد
// تُستبدل بالقائمة المُرسَلة).
router.patch('/records/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let d;
  try {
    d = readRecordBody(req.body);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE overtime_records SET work_date = $1, work_description = $2, reason = $3, start_time = $4,
         end_time = $5, location = $6, lines = $7, product = $8, batch = $9, workers_count = $10,
         updated_at = now()
       WHERE id = $11 RETURNING id`,
      [d.workDate, d.workDescription, d.reason, d.startTime, d.endTime, d.location, d.lines, d.product,
        d.batch, d.workersCount, id]
    );
    if (upd.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'السجل غير موجود' });
    }
    await client.query('DELETE FROM overtime_entries WHERE record_id = $1', [id]);
    await writeEntries(client, id, d.employeeIds);
    await client.query('COMMIT');
    const [record] = await loadRecords(pool, 'WHERE r.id = $1', [id]);
    res.json({ record });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/overtime/records/:id
router.delete('/records/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const { rowCount } = await pool.query('DELETE FROM overtime_records WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'السجل غير موجود' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// التقرير (يوم / شهر / مدة) + ملخص واتساب
// ---------------------------------------------------------------------------

// إحصاء الأيام لسجلات فرد واحد: لكل يوم عدد الأعمال وساعاته (مرتّبة بالتاريخ). لو تداخلت
// أوقات عملين لنفس الفرد في اليوم حُسب الوقت المتداخل مرة واحدة.
function dayStats(records) {
  const byDay = new Map();
  for (const r of records) {
    let d = byDay.get(r.work_date);
    if (!d) {
      d = { date: r.work_date, recs: [] };
      byDay.set(r.work_date, d);
    }
    d.recs.push(r);
  }
  return Array.from(byDay.values())
    .map((d) => ({ date: d.date, records_count: d.recs.length, hours: unionHours(d.recs) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ملخص: لكل فرد (عدد مرات العمل الإضافي، عدد الأيام + قائمة الأيام بساعات كل يوم،
// إجمالي الساعات) + إجماليات.
function summarize(records) {
  const people = new Map();
  const dates = new Set();
  let totalHours = 0;
  let withoutHours = 0;

  for (const r of records) {
    dates.add(r.work_date);
    if (r.hours === null) withoutHours += 1;
    else totalHours += r.hours;

    for (const e of r.entries) {
      const key = e.employee_id !== null ? `id:${e.employee_id}` : `n:${e.name.toLowerCase()}|${e.employee_number || ''}`;
      let p = people.get(key);
      if (!p) {
        p = { employee_id: e.employee_id, name: e.name, employee_number: e.employee_number, records_count: 0, recs: [] };
        people.set(key, p);
      }
      p.records_count += 1;
      p.recs.push(r);
    }
  }

  const employees = Array.from(people.values())
    .map((p) => {
      const days = dayStats(p.recs);
      return {
        employee_id: p.employee_id,
        name: p.name,
        employee_number: p.employee_number,
        records_count: p.records_count,
        days_count: days.length,
        hours: round2(days.reduce((sum, d) => sum + d.hours, 0)),
        days,
      };
    })
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'ar'));

  // إجمالي ساعات الأفراد = مجموع ساعات كل فرد بعد دمج الأوقات المتداخلة.
  const personHours = employees.reduce((sum, p) => sum + p.hours, 0);

  return {
    records_count: records.length,
    days_count: dates.size,
    employees_count: employees.length,
    total_hours: round2(totalHours),
    person_hours: round2(personHours),
    records_without_hours: withoutHours,
    employees,
  };
}

async function buildReport(query) {
  const range = resolveRange(query);
  const records = await loadRecords(pool, 'WHERE r.work_date BETWEEN $1 AND $2', [range.from, range.to]);
  return { mode: range.mode, from: range.from, to: range.to, records, summary: summarize(records) };
}

// GET /api/overtime/report?date=… | month=… | from=&to=
router.get('/report', async (req, res) => {
  try {
    res.json(await buildReport(req.query || {}));
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
});

// مدى تقرير الفرد: شهر (month) أو سنة كاملة (year) أو مدة (from/to).
function resolvePersonRange(q) {
  if (q.year) {
    const y = Number(q.year);
    if (!/^\d{4}$/.test(String(q.year)) || y < 2000 || y > 2100) throw badRequest('سنة غير صحيحة');
    return { mode: 'year', from: `${q.year}-01-01`, to: `${q.year}-12-31` };
  }
  return resolveRange(q);
}

// GET /api/overtime/employees/:id/report?month=YYYY-MM | year=YYYY | from=&to=
// كشف فرد واحد: أيام مشاركته في العمل الإضافي، وساعات كل يوم، وإجمالي مرّاته وساعاته.
router.get('/employees/:id/report', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let range;
  try {
    range = resolvePersonRange(req.query || {});
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const emp = await pool.query('SELECT id, name, employee_number FROM overtime_employees WHERE id = $1::bigint', [id]);
  if (emp.rows.length === 0) return res.status(404).json({ error: 'الفرد غير موجود في القائمة' });

  const records = await loadRecords(
    pool,
    'WHERE r.work_date BETWEEN $1 AND $2 AND EXISTS (SELECT 1 FROM overtime_entries x WHERE x.record_id = r.id AND x.employee_id = $3::bigint)',
    [range.from, range.to, id]
  );
  const days = dayStats(records);
  const hours = days.reduce((sum, d) => sum + d.hours, 0);
  res.json({
    employee: { id: emp.rows[0].id, name: emp.rows[0].name, employee_number: emp.rows[0].employee_number },
    mode: range.mode,
    from: range.from,
    to: range.to,
    records,
    summary: {
      records_count: records.length,
      days_count: days.length,
      hours: round2(hours),
      records_without_hours: records.filter((r) => r.hours === null).length,
      days,
    },
  });
});

const EASTERN = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const ar = (v) => String(v).replace(/\d/g, (d) => EASTERN[Number(d)]);
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return ar(`${y}/${m}/${d}`);
}
function fmtHours(h) {
  if (h === null || h === undefined) return '';
  const s = Number.isInteger(h) ? String(h) : String(h).replace('.', '٫');
  return `${ar(s)} ساعة`;
}
function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const WHATSAPP_MAX = 3800;

function buildWhatsappText(report) {
  const { mode, from, to, records, summary } = report;
  const lines = [];
  if (mode === 'day') {
    lines.push(`🕒 تقرير العمل الإضافي — ${weekdayOf(from)} ${fmtDate(from)}`);
  } else if (mode === 'month') {
    const [y, m] = from.split('-').map(Number);
    lines.push(`🕒 تقرير العمل الإضافي — شهر ${MONTHS[m - 1]} ${ar(y)}`);
  } else {
    lines.push(`🕒 تقرير العمل الإضافي — من ${fmtDate(from)} إلى ${fmtDate(to)}`);
  }
  const totals = [`عدد الأعمال: ${ar(summary.records_count)}`, `عدد الأفراد: ${ar(summary.employees_count)}`];
  if (mode !== 'day') totals.push(`عدد الأيام: ${ar(summary.days_count)}`);
  if (summary.total_hours > 0) totals.push(`إجمالي ساعات الأعمال: ${fmtHours(summary.total_hours)}`);
  if (summary.person_hours > 0) totals.push(`إجمالي ساعات الأفراد: ${fmtHours(summary.person_hours)}`);
  lines.push(totals.join(' | '));
  lines.push('');

  if (mode === 'day') {
    records.forEach((r, i) => {
      lines.push(`${ar(i + 1)}) ${r.work_description}`);
      if (r.reason) lines.push(`   السبب: ${r.reason}`);
      const info = [];
      if (r.location) info.push(`الموقع: ${r.location}`);
      if (r.lines) info.push(`الخطوط: ${r.lines}`);
      if (r.product) info.push(`المنتج: ${r.product}`);
      if (r.batch) info.push(`الباتش: ${r.batch}`);
      if (info.length) lines.push(`   ${info.join(' | ')}`);
      if (r.start_time && r.end_time) lines.push(`   الوقت: ${ar(r.start_time)} إلى ${ar(r.end_time)} (${fmtHours(r.hours)})`);
      const count = r.workers_count || r.employees_count;
      if (count) lines.push(`   عدد العمال: ${ar(count)}`);
      if (r.entries.length) {
        lines.push(`   الأفراد: ${r.entries.map((e) => (e.employee_number ? `${e.name} (${e.employee_number})` : e.name)).join('، ')}`);
      }
      lines.push('');
    });
  } else {
    if (summary.employees.length) {
      lines.push('ملخص الأفراد:');
      summary.employees.forEach((p) => {
        const num = p.employee_number ? ` (${p.employee_number})` : '';
        const hrs = p.hours > 0 ? ` — ${fmtHours(p.hours)}` : '';
        // أيام الفرد: أرقام الأيام فقط في تقرير الشهر، وشهر/يوم في تقرير المدة
        // مع ساعات كل يوم بين قوسين: «٦ (٤٫٥ س)، ١٣ (٣ س)»
        const dayLabels = (p.days || []).map((d) => {
          const label = mode === 'month' ? ar(Number(d.date.slice(8))) : fmtDate(d.date).slice(5);
          return d.hours > 0 ? `${label} (${fmtHours(d.hours).replace(' ساعة', ' س')})` : label;
        });
        const daysTxt = dayLabels.length ? ` — الأيام: ${dayLabels.join('، ')}` : '';
        lines.push(`• ${p.name}${num}: ${ar(p.records_count)} مرة${hrs}${daysTxt}`);
      });
      lines.push('');
    }
    lines.push('الأعمال:');
    records.forEach((r) => {
      const d = fmtDate(r.work_date).slice(5); // شهر/يوم
      const why = r.reason ? ` — ${r.reason}` : '';
      lines.push(`• ${d}: ${r.work_description}${why}`);
    });
  }

  let text = lines.join('\n').trim();
  if (text.length > WHATSAPP_MAX) text = `${text.slice(0, WHATSAPP_MAX).trimEnd()}\n… (الملخص طويل — التفاصيل الكاملة في تقرير PDF من التطبيق)`;
  return text;
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0] && rows[0].value ? rows[0].value : null;
}

// POST /api/overtime/report/whatsapp — { date | month | from+to, target: 'me' | 'group' }
// 'me': لجوال الطالب نفسه (المسجَّل في حسابه)؛ 'group': لجروب العمل الإضافي
// (textmebot_group_overtime) وإن لم يُضبط فجروب الصيانة (textmebot_group_maintenance).
router.post('/report/whatsapp', async (req, res) => {
  const body = req.body || {};
  const target = body.target === 'group' ? 'group' : 'me';
  let report;
  try {
    report = await buildReport(body);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
  if (report.records.length === 0) {
    return res.status(404).json({ error: 'لا توجد أعمال إضافية مسجَّلة في هذه الفترة لإرسالها' });
  }

  let recipient;
  if (target === 'me') {
    if (!req.user.phone) {
      return res.status(400).json({ error: 'رقم جوالك غير مسجَّل في حسابك — أضفه من الإدارة أو اختر الإرسال للجروب' });
    }
    recipient = req.user.phone;
  } else {
    recipient = (await getSetting('textmebot_group_overtime')) || (await getSetting('textmebot_group_maintenance'));
    if (!recipient) {
      return res.status(400).json({ error: 'لا يوجد جروب واتساب مضبوط للصيانة في إعدادات الموقع' });
    }
  }

  const result = await sendWhatsappText(recipient, buildWhatsappText(report));
  if (!result || !result.ok) {
    return res.status(502).json({ error: 'تعذّر إرسال رسالة واتساب (تحقق من مفتاح TextMeBot في إعدادات الموقع)' });
  }
  res.json({ ok: true, target, records_count: report.records.length });
});

module.exports = router;
module.exports._test = { cleanText, computeHours, isValidDate, resolveRange, buildWhatsappText, summarize, unionHours, mergedMinutes };
