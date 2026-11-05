'use strict';
// ============================================================================
// مراقبة مكينة المعمول (البخور) — طلب 2026-10-07
//
// تبويب في التطبيق لمراقبة منطقة المعمول: ثلاثة محركات (السير، دفع المعمول،
// الدوار للتكوير) + بستونات وحساسات. الغاية ضبط الوزن بين ٦٫٠ و٦٫٦ جرام بأقل
// عيوب (توائم، زوائد، مرفوض) ومعرفة أي سرعات تعطي أفضل وزن.
//
// الصلاحيات (بقرار الإدارة 2026-10-07):
//   مدير النظام + مسؤول الصيانة + الفنيون + مسؤول المخزون + المصمم (أفراد
//   الصيانة) + موظفو/مسؤول الإنتاج المقيَّدون بـ"مصنع النساء" (أو بلا تقييد
//   مصنع). موظف إنتاج مقيَّد بمصنع الرجال → 403. الحذف النهائي لمسؤول الصيانة
//   ومدير النظام فقط. الفاصل الملزم هنا؛ إخفاء التبويب في التطبيق للمظهر فقط
//   (canOpenMamoulMonitor في mamoul_home_screen.dart — يجب أن تبقى متطابقة).
//
// الجداول تُنشأ تلقائيًا عند أول استخدام (CREATE TABLE IF NOT EXISTS) — لا حاجة
// لأي أمر ترحيل يدوي؛ يلزم فقط إعادة تشغيل خدمة SayanatiServer بعد التحديث.
//
// البنية: تشغيلة (run) فيها سرعات المحركات الحالية → عيّنات وزن (samples) كل
// عيّنة تنسخ السرعات السارية وقت أخذها (لتحليل العلاقة بين السرعة والوزن) →
// عدّادات عيوب (defects) → أعطال البستونات والحساسات (faults) → سجل تغييرات
// السرعة (speed_changes) → سجل التدخل البشري (interventions).
//
// تطوير 2026-10-07 (الغاية: رفع إنتاجية المكينة مع بقاء الوزن بين ٦٫٠ و٦٫٤):
//   • كل عيّنة تسجّل (اختياريًا) عدد القطع في الدقيقة ومستوى ضغط اليد على
//     المكينة (بدون/خفيف/متوسط/قوي) وحرارة العجينة. العيّنات التي فيها ضغط يد
//     تُستبعد من التوصيات وتُعرض في قسم منفصل (assisted_speeds / by_pressure).
//   • سجل التدخل البشري (ضغط يدوي، فك توائم، تعديل العجينة، تنظيف، ضبط يدوي…).
//   • التحليل يعيد "الأسرع داخل النطاق" لكل مكينة (أعلى قطع/دقيقة بلا خروج عن
//     الحدّين) + تحليل بحسب الضغط وحرارة العجينة + عدد/مدة التدخل لكل مكينة.
// ============================================================================

const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const {
  requireAuth, requireApproved, requireRole,
  MAINTENANCE_ROLES, TECHNICIAN_ROLES, PRODUCTION_ROLES,
} = require('../middleware/auth');

const router = new Router();

const WOMEN_FACILITY = 'مصنع النساء';
const MONITOR_ROLES = Array.from(new Set([...MAINTENANCE_ROLES, ...TECHNICIAN_ROLES, ...PRODUCTION_ROLES]));
const TZ = 'Asia/Riyadh';

// حدود الوزن المقبولة وأهدافه (جرام) — بقرار الإدارة (2026-10-20): مقبول من ٦٫٠ إلى ٦٫٦
// (كان ٦٫٤ قبل هذا التاريخ)، والأهداف ٦٫٢ و٦٫٤ و٦٫٦. تُنسخ لكل تشغيلة عند إنشائها فلا تتغير
// تقاريرها القديمة (حدّها ٦٫٤) لو عُدّلت الحدود لاحقًا.
const WEIGHT_MIN = 6.0;
const WEIGHT_MAX = 6.6;
const TARGETS = [6.2, 6.4, 6.6];
// تنبيه مبكر: متوسط العيّنة أقرب من هذا الهامش (جرام) لأحد الحدّين.
const WARN_MARGIN = 0.05;
// أقل عدد قطع مقاسة لسرعات معيّنة حتى نعتمدها في "أفضل ضبط".
const MIN_PIECES_FOR_RECOMMENDATION = 20;
const SPEED_UNITS = ['Hz', '%', 'RPM'];
const MOISTURE_LEVELS = ['dry', 'medium', 'wet'];
const FAULT_COMPONENTS = ['piston', 'sensor', 'motor_belt', 'motor_push', 'motor_rotary', 'other'];
// مستوى ضغط يد العامل على المكينة وقت أخذ العيّنة (بدون = لا يضغط). ضغط اليد لا يمكن
// التحكم فيه ولا قياسه، فالتوصيات (أفضل ضبط/الأسرع داخل النطاق) تُبنى على العيّنات
// التي بدون ضغط يد فقط (بدون، أو غير مسجَّل)؛ أما ضغط محرك الدفع فهو سرعة الدفع نفسها.
const PRESSURE_LEVELS = ['none', 'light', 'medium', 'strong'];
// أنواع التدخل البشري: ضغط يدوي، فك توائم، تعديل العجينة، تنظيف، ضبط يدوي، أخرى.
const INTERVENTION_KINDS = ['pressure', 'twins', 'dough', 'clean', 'adjust', 'other'];
// عيّنة "نظيفة" = بلا ضغط يد (بدون، أو لم يُسجَّل — كل البيانات القديمة قبل هذه الميزة).
const isCleanSample = (it) => !it.pressure || it.pressure === 'none';
// "الأسرع داخل النطاق": أقصى نسبة قطع خارج الحدّين تُقبل (٠ = كل القطع داخل النطاق).
const FASTEST_MAX_OUT_PCT = 0;
// عرض حرارة العجينة في تحليلها بشرائح (درجة مئوية).
const TEMP_BAND = 5;

// ---------------------------------------------------------------------------
// إنشاء الجداول (مرة واحدة لكل تشغيل، آمن للتكرار)
// ---------------------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS mamoul_machines (
     id          BIGSERIAL PRIMARY KEY,
     name        TEXT NOT NULL,
     code        TEXT,
     active      BOOLEAN NOT NULL DEFAULT true,
     sort_order  INT NOT NULL DEFAULT 0,
     created_by  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mamoul_machines_name_uq ON mamoul_machines (lower(name))`,
  `CREATE TABLE IF NOT EXISTS mamoul_runs (
     id                    BIGSERIAL PRIMARY KEY,
     machine_id            BIGINT REFERENCES mamoul_machines(id) ON DELETE RESTRICT,
     run_date              DATE NOT NULL,
     shift                 TEXT,
     target_weight         NUMERIC(6,2) NOT NULL,
     weight_min            NUMERIC(6,2) NOT NULL,
     weight_max            NUMERIC(6,2) NOT NULL,
     start_time            TIME,
     end_time              TIME,
     status                TEXT NOT NULL DEFAULT 'open',
     operator_name         TEXT,
     paste_batch           TEXT,
     paste_moisture_level  TEXT,
     paste_moisture_pct    NUMERIC(5,2),
     speed_unit            TEXT NOT NULL DEFAULT 'Hz',
     speed_belt            NUMERIC(8,2),
     speed_push            NUMERIC(8,2),
     speed_rotary          NUMERIC(8,2),
     produced_count        INT,
     notes                 TEXT,
     created_by            TEXT,
     created_by_user       BIGINT,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_runs_date_idx ON mamoul_runs (run_date)`,
  `CREATE INDEX IF NOT EXISTS mamoul_runs_machine_idx ON mamoul_runs (machine_id)`,
  `CREATE INDEX IF NOT EXISTS mamoul_runs_status_idx ON mamoul_runs (status)`,
  `CREATE TABLE IF NOT EXISTS mamoul_speed_changes (
     id            BIGSERIAL PRIMARY KEY,
     run_id        BIGINT NOT NULL REFERENCES mamoul_runs(id) ON DELETE CASCADE,
     change_time   TIME NOT NULL,
     speed_belt    NUMERIC(8,2),
     speed_push    NUMERIC(8,2),
     speed_rotary  NUMERIC(8,2),
     reason        TEXT,
     created_by    TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_speed_changes_run_idx ON mamoul_speed_changes (run_id)`,
  `CREATE TABLE IF NOT EXISTS mamoul_samples (
     id            BIGSERIAL PRIMARY KEY,
     run_id        BIGINT NOT NULL REFERENCES mamoul_runs(id) ON DELETE CASCADE,
     sample_time   TIME NOT NULL,
     speed_belt    NUMERIC(8,2),
     speed_push    NUMERIC(8,2),
     speed_rotary  NUMERIC(8,2),
     note          TEXT,
     created_by    TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_samples_run_idx ON mamoul_samples (run_id)`,
  `ALTER TABLE mamoul_samples ADD COLUMN IF NOT EXISTS pieces_per_min NUMERIC(8,2)`,
  `ALTER TABLE mamoul_samples ADD COLUMN IF NOT EXISTS pressure_level TEXT`,
  `ALTER TABLE mamoul_samples ADD COLUMN IF NOT EXISTS dough_temp NUMERIC(5,2)`,
  `CREATE TABLE IF NOT EXISTS mamoul_sample_weights (
     id         BIGSERIAL PRIMARY KEY,
     sample_id  BIGINT NOT NULL REFERENCES mamoul_samples(id) ON DELETE CASCADE,
     weight     NUMERIC(6,2) NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_sample_weights_sample_idx ON mamoul_sample_weights (sample_id)`,
  `CREATE TABLE IF NOT EXISTS mamoul_defects (
     id          BIGSERIAL PRIMARY KEY,
     run_id      BIGINT NOT NULL REFERENCES mamoul_runs(id) ON DELETE CASCADE,
     event_time  TIME NOT NULL,
     twins       INT NOT NULL DEFAULT 0,
     flash       INT NOT NULL DEFAULT 0,
     rejected    INT NOT NULL DEFAULT 0,
     note        TEXT,
     created_by  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_defects_run_idx ON mamoul_defects (run_id)`,
  `CREATE TABLE IF NOT EXISTS mamoul_interventions (
     id          BIGSERIAL PRIMARY KEY,
     run_id      BIGINT NOT NULL REFERENCES mamoul_runs(id) ON DELETE CASCADE,
     event_time  TIME NOT NULL,
     kind        TEXT NOT NULL,
     minutes     INT,
     note        TEXT,
     created_by  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_interventions_run_idx ON mamoul_interventions (run_id)`,
  `CREATE TABLE IF NOT EXISTS mamoul_faults (
     id               BIGSERIAL PRIMARY KEY,
     machine_id       BIGINT REFERENCES mamoul_machines(id) ON DELETE RESTRICT,
     run_id           BIGINT REFERENCES mamoul_runs(id) ON DELETE SET NULL,
     fault_date       DATE NOT NULL,
     fault_time       TIME,
     component        TEXT NOT NULL,
     part_label       TEXT,
     description      TEXT NOT NULL,
     downtime_minutes INT,
     action_taken     TEXT,
     status           TEXT NOT NULL DEFAULT 'open',
     resolved_at      TIMESTAMPTZ,
     resolved_by      TEXT,
     created_by       TEXT,
     created_by_user  BIGINT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_faults_date_idx ON mamoul_faults (fault_date)`,
  `CREATE INDEX IF NOT EXISTS mamoul_faults_machine_idx ON mamoul_faults (machine_id)`,
  `CREATE INDEX IF NOT EXISTS mamoul_faults_run_idx ON mamoul_faults (run_id)`,
  `CREATE TABLE IF NOT EXISTS mamoul_rate_readings (
     id              BIGSERIAL PRIMARY KEY,
     machine_id      BIGINT NOT NULL REFERENCES mamoul_machines(id) ON DELETE CASCADE,
     run_id          BIGINT REFERENCES mamoul_runs(id) ON DELETE SET NULL,
     pieces_per_min  NUMERIC(8,2) NOT NULL,
     weight_g        NUMERIC(6,2) NOT NULL,
     work_hours      NUMERIC(5,2),
     created_by      TEXT,
     created_by_user BIGINT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mamoul_rate_readings_machine_idx ON mamoul_rate_readings (machine_id, id DESC)`,
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

// موظف الإنتاج المقيَّد بمصنع غير مصنع النساء (مصنع الرجال) لا يدخل. من بلا
// تقييد (null = كل المصانع) يدخل لأن مصنع النساء ضمن نطاقه.
function requireFacility(req, res, next) {
  const u = req.user;
  if (PRODUCTION_ROLES.includes(u.role) && u.production_facility && u.production_facility !== WOMEN_FACILITY) {
    return res.status(403).json({ error: 'هذا القسم خاص بمصنع النساء والصيانة' });
  }
  return next();
}

router.use(requireAuth, requireApproved, requireRole(...MONITOR_ROLES), requireFacility, async (req, res, next) => {
  try {
    await ensureTables();
  } catch (err) {
    console.error('تعذّر تجهيز جداول مراقبة المعمول:', err.message);
    return res.status(500).json({ error: 'تعذّر تجهيز قاعدة بيانات مراقبة المعمول، حاول مرة أخرى' });
  }
  return next();
});

// ---------------------------------------------------------------------------
// أدوات التحقق والتنسيق
// ---------------------------------------------------------------------------

function badRequest(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

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

// رقم عشري اختياري بمنزلتين: فارغ/غائب → null. خارج المدى أو غير رقم → 400.
function readDecimal(v, label, { min, max, required = false } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw badRequest(`${label} إلزامي`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${label} غير صحيح (من ${min} إلى ${max})`);
  return round2(n);
}

// عدد صحيح غير سالب. فارغ → 0.
function readCount(v, label, max = 1000000) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} يجب أن يكون عددًا صحيحًا من 0 إلى ${max}`);
  return n;
}

function readTime(v, label) {
  if (v === undefined || v === null || v === '') return null;
  if (!isValidTime(String(v))) throw badRequest(`${label} غير صحيح (الصيغة المطلوبة ٢٤ ساعة مثل 17:30)`);
  return String(v);
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
  return null;
}

// ---------------------------------------------------------------------------
// الحسابات (مصدَّرة في _test)
// ---------------------------------------------------------------------------

const EPS = 1e-9;

// إحصاءات مجموعة أوزان بالنسبة لحدّي الوزن: المتوسط وأقل وأعلى وزن والانحراف
// المعياري (التذبذب) وعدد/نسبة القطع خارج الحدّين، ومستوى الحالة:
//   bad  = وُجدت قطعة خارج الحدّين
//   warn = كل القطع داخل الحدّين لكن المتوسط قريب (≤ WARN_MARGIN) من أحدهما
//   ok   = غير ذلك
// trend: 'high' / 'low' لو المتوسط يميل لأحد الحدّين (حتى لو level = bad).
function weightStats(weights, min = WEIGHT_MIN, max = WEIGHT_MAX, target = null) {
  const n = weights.length;
  if (n === 0) {
    return {
      count: 0, avg: null, min: null, max: null, std: null,
      low_count: 0, high_count: 0, out_count: 0, out_pct: null,
      deviation: null, trend: null, level: 'none',
    };
  }
  const sum = weights.reduce((a, w) => a + w, 0);
  const avg = sum / n;
  const std = n > 1 ? Math.sqrt(weights.reduce((a, w) => a + (w - avg) * (w - avg), 0) / (n - 1)) : 0;
  const low = weights.filter((w) => w < min - EPS).length;
  const high = weights.filter((w) => w > max + EPS).length;
  const out = low + high;
  let trend = null;
  if (avg >= max - WARN_MARGIN - EPS) trend = 'high';
  else if (avg <= min + WARN_MARGIN + EPS) trend = 'low';
  let level = 'ok';
  if (out > 0) level = 'bad';
  else if (trend) level = 'warn';
  return {
    count: n,
    avg: round3(avg),
    min: Math.min(...weights),
    max: Math.max(...weights),
    std: round3(std),
    low_count: low,
    high_count: high,
    out_count: out,
    out_pct: round1((out / n) * 100),
    deviation: target === null || target === undefined ? null : round3(avg - target),
    trend,
    level,
  };
}

// ---------------------------------------------------------------------------
// قراءة وتجميع البيانات
// ---------------------------------------------------------------------------

const RUN_COLUMNS = `
  r.id, r.machine_id, m.name AS machine_name, m.code AS machine_code,
  to_char(r.run_date, 'YYYY-MM-DD') AS run_date,
  r.shift, r.target_weight, r.weight_min, r.weight_max,
  to_char(r.start_time, 'HH24:MI') AS start_time,
  to_char(r.end_time, 'HH24:MI') AS end_time,
  r.status, r.operator_name, r.paste_batch, r.paste_moisture_level, r.paste_moisture_pct,
  r.speed_unit, r.speed_belt, r.speed_push, r.speed_rotary,
  r.produced_count, r.notes, r.created_by, r.created_at, r.updated_at`;

async function loadSamples(runIds) {
  if (runIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT s.id, s.run_id, to_char(s.sample_time, 'HH24:MI') AS sample_time,
            s.speed_belt, s.speed_push, s.speed_rotary, s.pieces_per_min, s.pressure_level, s.dough_temp,
            s.note, s.created_by, s.created_at
       FROM mamoul_samples s WHERE s.run_id = ANY($1::bigint[]) ORDER BY s.run_id, s.id`,
    [runIds]
  );
  if (rows.length === 0) return [];
  const w = await pool.query(
    'SELECT sample_id, weight FROM mamoul_sample_weights WHERE sample_id = ANY($1::bigint[]) ORDER BY id',
    [rows.map((r) => r.id)]
  );
  const bySample = new Map();
  for (const x of w.rows) {
    if (!bySample.has(x.sample_id)) bySample.set(x.sample_id, []);
    bySample.get(x.sample_id).push(x.weight);
  }
  return rows.map((s) => ({ ...s, weights: bySample.get(s.id) || [] }));
}

async function loadDefects(runIds) {
  if (runIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, run_id, to_char(event_time, 'HH24:MI') AS event_time, twins, flash, rejected, note, created_by, created_at
       FROM mamoul_defects WHERE run_id = ANY($1::bigint[]) ORDER BY run_id, id`,
    [runIds]
  );
  return rows;
}

const INTERVENTION_COLUMNS = `id, run_id, to_char(event_time, 'HH24:MI') AS event_time, kind, minutes, note, created_by, created_at`;

async function loadInterventions(runIds) {
  if (runIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT ${INTERVENTION_COLUMNS} FROM mamoul_interventions WHERE run_id = ANY($1::bigint[]) ORDER BY run_id, id`,
    [runIds]
  );
  return rows;
}

const FAULT_COLUMNS = `
  f.id, f.machine_id, m.name AS machine_name, f.run_id, to_char(f.fault_date, 'YYYY-MM-DD') AS fault_date,
  to_char(f.fault_time, 'HH24:MI') AS fault_time,
  f.component, f.part_label, f.description, f.downtime_minutes, f.action_taken,
  f.status, f.resolved_at, f.resolved_by, f.created_by, f.created_at`;

// متوسط قطع/دقيقة للعيّنات التي سُجّلت فيها (غير المسجّلة لا تُحسب). null لو لا شيء.
function avgOf(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number);
  return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
}

function runSummary(run, samples, defects, faults, interventions = []) {
  const sampleList = samples.map((s) => ({
    ...s,
    stats: weightStats(s.weights, run.weight_min, run.weight_max, run.target_weight),
  }));
  const allWeights = sampleList.flatMap((s) => s.weights);
  const d = defects.reduce(
    (a, x) => ({ twins: a.twins + x.twins, flash: a.flash + x.flash, rejected: a.rejected + x.rejected }),
    { twins: 0, flash: 0, rejected: 0 }
  );
  const defectsTotal = d.twins + d.flash + d.rejected;
  const last = sampleList.length ? sampleList[sampleList.length - 1] : null;
  const ppm = avgOf(sampleList.map((s) => s.pieces_per_min));
  return {
    samples: sampleList,
    summary: {
      samples_count: sampleList.length,
      pieces_count: allWeights.length,
      avg_pieces_per_min: ppm === null ? null : round1(ppm),
      interventions_count: interventions.length,
      interventions_minutes: interventions.reduce((a, x) => a + (x.minutes || 0), 0),
      stats: weightStats(allWeights, run.weight_min, run.weight_max, run.target_weight),
      last_sample_level: last ? last.stats.level : null,
      last_sample_avg: last ? last.stats.avg : null,
      last_sample_trend: last ? last.stats.trend : null,
      defects: {
        twins: d.twins,
        flash: d.flash,
        rejected: d.rejected,
        total: defectsTotal,
        pct_of_produced: run.produced_count > 0 ? round1((defectsTotal / run.produced_count) * 100) : null,
      },
      faults_total: faults.length,
      faults_open: faults.filter((f) => f.status === 'open').length,
    },
  };
}

async function loadFaultsForRuns(runIds) {
  if (runIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT ${FAULT_COLUMNS} FROM mamoul_faults f LEFT JOIN mamoul_machines m ON m.id = f.machine_id WHERE f.run_id = ANY($1::bigint[]) ORDER BY f.id`,
    [runIds]
  );
  return rows;
}

// يحمّل التشغيلات المطابقة مع ملخص كل واحدة (بلا تفاصيل العيّنات) + إجماليات.
async function loadRunsWithSummary(whereSql, params, suffixSql = 'ORDER BY r.run_date, r.id') {
  const { rows: runs } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM mamoul_runs r LEFT JOIN mamoul_machines m ON m.id = r.machine_id ${whereSql} ${suffixSql}`,
    params
  );
  const ids = runs.map((r) => r.id);
  const [samples, defects, faults, interventions] = await Promise.all([
    loadSamples(ids), loadDefects(ids), loadFaultsForRuns(ids), loadInterventions(ids),
  ]);
  const out = runs.map((run) => {
    const built = runSummary(
      run,
      samples.filter((s) => s.run_id === run.id),
      defects.filter((d) => d.run_id === run.id),
      faults.filter((f) => f.run_id === run.id),
      interventions.filter((x) => x.run_id === run.id)
    );
    return { ...run, summary: built.summary };
  });
  return { runs: out, samples, defects };
}

function totalsOf(runs, samples) {
  // الإجماليات تحسب القطع كلها (وزن كل قطعة بحسب حدّي تشغيلتها).
  const runById = new Map(runs.map((r) => [r.id, r]));
  let pieces = 0;
  let out = 0;
  let sum = 0;
  for (const s of samples) {
    const run = runById.get(s.run_id);
    if (!run) continue;
    for (const w of s.weights) {
      pieces += 1;
      sum += w;
      if (w < Number(run.weight_min) - EPS || w > Number(run.weight_max) + EPS) out += 1;
    }
  }
  const d = runs.reduce(
    (a, r) => ({
      twins: a.twins + r.summary.defects.twins,
      flash: a.flash + r.summary.defects.flash,
      rejected: a.rejected + r.summary.defects.rejected,
      produced: a.produced + (r.produced_count || 0),
      faults: a.faults + r.summary.faults_total,
      faultsOpen: a.faultsOpen + r.summary.faults_open,
      interventions: a.interventions + r.summary.interventions_count,
      interventionsMinutes: a.interventionsMinutes + r.summary.interventions_minutes,
    }),
    { twins: 0, flash: 0, rejected: 0, produced: 0, faults: 0, faultsOpen: 0, interventions: 0, interventionsMinutes: 0 }
  );
  const ppm = avgOf(samples.filter((s) => runById.has(s.run_id)).map((s) => s.pieces_per_min));
  const defectsTotal = d.twins + d.flash + d.rejected;
  return {
    runs_count: runs.length,
    open_runs_count: runs.filter((r) => r.status === 'open').length,
    samples_count: samples.filter((s) => runById.has(s.run_id)).length,
    pieces_count: pieces,
    avg_weight: pieces ? round3(sum / pieces) : null,
    out_count: out,
    out_pct: pieces ? round1((out / pieces) * 100) : null,
    produced_count: d.produced,
    defects: {
      twins: d.twins,
      flash: d.flash,
      rejected: d.rejected,
      total: defectsTotal,
      pct_of_produced: d.produced > 0 ? round1((defectsTotal / d.produced) * 100) : null,
    },
    faults_total: d.faults,
    faults_open: d.faultsOpen,
    avg_pieces_per_min: ppm === null ? null : round1(ppm),
    interventions_count: d.interventions,
    interventions_minutes: d.interventionsMinutes,
  };
}

async function loadRunDetail(id) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM mamoul_runs r LEFT JOIN mamoul_machines m ON m.id = r.machine_id WHERE r.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const run = rows[0];
  const [samples, defects, faults, interventions, changes] = await Promise.all([
    loadSamples([id]),
    loadDefects([id]),
    loadFaultsForRuns([id]),
    loadInterventions([id]),
    pool.query(
      `SELECT id, to_char(change_time, 'HH24:MI') AS change_time, speed_belt, speed_push, speed_rotary, reason, created_by
         FROM mamoul_speed_changes WHERE run_id = $1 ORDER BY id`,
      [id]
    ),
  ]);
  const built = runSummary(run, samples, defects, faults, interventions);
  return {
    run: { ...run, summary: built.summary },
    samples: built.samples,
    defects,
    interventions,
    faults,
    speed_changes: changes.rows,
  };
}

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------

// GET /api/mamoul-monitor/config
router.get('/config', (req, res) => {
  res.json({
    weight_min: WEIGHT_MIN,
    weight_max: WEIGHT_MAX,
    targets: TARGETS,
    warn_margin: WARN_MARGIN,
    speed_units: SPEED_UNITS,
    moisture_levels: MOISTURE_LEVELS,
    fault_components: FAULT_COMPONENTS,
    pressure_levels: PRESSURE_LEVELS,
    intervention_kinds: INTERVENTION_KINDS,
    min_pieces_for_recommendation: MIN_PIECES_FOR_RECOMMENDATION,
  });
});

// ---------------------------------------------------------------------------
// المكائن (أكثر من مكينة في منطقة المعمول — لكل مكينة تشغيلاتها وأعطالها وتحليلها)
// ---------------------------------------------------------------------------

const MACHINE_COLUMNS = `
  m.id, m.name, m.code, m.active, m.sort_order,
  (SELECT count(*) FROM mamoul_runs r WHERE r.machine_id = m.id) AS runs_count,
  (SELECT count(*) FROM mamoul_faults f WHERE f.machine_id = m.id) AS faults_count,
  (SELECT count(*) FROM mamoul_faults f WHERE f.machine_id = m.id AND f.status = 'open') AS faults_open`;

async function loadMachines() {
  const { rows } = await pool.query(`SELECT ${MACHINE_COLUMNS} FROM mamoul_machines m ORDER BY m.sort_order, m.id`);
  return rows;
}

// GET /api/mamoul-monitor/machines — كل المكائن (المعطّلة أيضًا، بعلامة active)
router.get('/machines', async (req, res) => {
  res.json({ machines: await loadMachines() });
});

function readMachineBody(body, { create }) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  const out = {};
  if (create || has('name')) {
    const name = cleanText(b.name, 80);
    if (!name) throw badRequest('اسم المكينة إلزامي');
    out.name = name;
  }
  if (create || has('code')) out.code = cleanText(b.code, 40);
  if (has('active')) {
    if (typeof b.active !== 'boolean') throw badRequest('قيمة التفعيل غير صحيحة');
    out.active = b.active;
  }
  return out;
}

async function machineNameTaken(name, exceptId) {
  const { rows } = await pool.query(
    'SELECT id FROM mamoul_machines WHERE lower(name) = lower($1)' + (exceptId ? ' AND id <> $2' : ''),
    exceptId ? [name, exceptId] : [name]
  );
  return rows.length > 0;
}

async function loadOneMachine(id) {
  const { rows } = await pool.query(`SELECT ${MACHINE_COLUMNS} FROM mamoul_machines m WHERE m.id = $1`, [id]);
  return rows[0] || null;
}

// POST /api/mamoul-monitor/machines — { name, code? } (مسؤول الصيانة / مدير النظام)
router.post('/machines', requireRole('maintenance_manager'), async (req, res) => {
  let d;
  try {
    d = readMachineBody(req.body, { create: true });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  if (await machineNameTaken(d.name)) return res.status(409).json({ error: 'يوجد مكينة بنفس الاسم' });
  const ins = await pool.query(
    `INSERT INTO mamoul_machines (name, code, sort_order, created_by)
     VALUES ($1, $2, COALESCE((SELECT max(sort_order) FROM mamoul_machines), 0) + 1, $3) RETURNING id`,
    [d.name, d.code, req.user.name || null]
  );
  res.status(201).json({ machine: await loadOneMachine(ins.rows[0].id) });
});

// PATCH /api/mamoul-monitor/machines/:id — { name?, code?, active? }
router.patch('/machines/:id', requireRole('maintenance_manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let d;
  try {
    d = readMachineBody(req.body, { create: false });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const keys = Object.keys(d);
  if (keys.length === 0) return res.status(400).json({ error: 'لا توجد حقول للتعديل' });
  if (d.name && (await machineNameTaken(d.name, id))) return res.status(409).json({ error: 'يوجد مكينة بنفس الاسم' });
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const { rowCount } = await pool.query(
    `UPDATE mamoul_machines SET ${sets.join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => d[k]), id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'المكينة غير موجودة' });
  res.json({ machine: await loadOneMachine(id) });
});

// DELETE /api/mamoul-monitor/machines/:id — يُمنع لو لها تشغيلات أو أعطال (عطّلها بدل حذفها)
router.delete('/machines/:id', requireRole('maintenance_manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const m = await loadOneMachine(id);
  if (!m) return res.status(404).json({ error: 'المكينة غير موجودة' });
  if (m.runs_count > 0 || m.faults_count > 0) {
    return res.status(409).json({ error: 'لا يمكن حذف مكينة لها تشغيلات أو أعطال مسجّلة — عطّلها بدلًا من حذفها' });
  }
  await pool.query('DELETE FROM mamoul_machines WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// التشغيلات
// ---------------------------------------------------------------------------

// GET /api/mamoul-monitor/runs?date= | month= | from=&to= | status=open [&machineId=3]
router.get('/runs', async (req, res) => {
  const q = req.query || {};
  let range;
  try {
    range = resolveRange(q);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  let machineId = null;
  if (q.machineId !== undefined && q.machineId !== '') {
    machineId = parseId(q.machineId);
    if (!machineId) return res.status(400).json({ error: 'معرّف المكينة غير صحيح' });
  }
  const conds = [];
  const params = [];
  let suffix = 'ORDER BY r.run_date, r.id';
  if (range) {
    params.push(range.from, range.to);
    conds.push(`r.run_date BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (q.status === 'open') {
    suffix = 'ORDER BY r.run_date DESC, r.id DESC LIMIT 50';
  } else {
    return res.status(400).json({ error: 'حدّد يومًا (date) أو شهرًا (month) أو مدة (from/to) أو status=open' });
  }
  if (q.status === 'open') conds.push("r.status = 'open'");
  if (machineId !== null) {
    params.push(machineId);
    conds.push(`r.machine_id = $${params.length}`);
  }
  const loaded = await loadRunsWithSummary(conds.length ? `WHERE ${conds.join(' AND ')}` : '', params, suffix);
  res.json({
    from: range ? range.from : null,
    to: range ? range.to : null,
    runs: loaded.runs,
    totals: totalsOf(loaded.runs, loaded.samples),
  });
});

// GET /api/mamoul-monitor/runs/:id — التشغيلة بكل تفاصيلها
router.get('/runs/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const detail = await loadRunDetail(id);
  if (!detail) return res.status(404).json({ error: 'التشغيلة غير موجودة' });
  res.json(detail);
});

// يقرأ حقول التشغيلة: create=true → كل الحقول الإلزامية، وإلا (تعديل) فقط ما أُرسل.
function readRunBody(body, { create }) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  const out = {};

  if (create || has('machineId')) {
    const mid = parseId(b.machineId);
    if (!mid) throw badRequest('اختر المكينة');
    out.machine_id = mid;
  }
  if (create || has('runDate')) {
    if ((b.runDate === undefined || b.runDate === null || b.runDate === '') && create) out.run_date = null;
    else if (!isValidDate(b.runDate)) throw badRequest('تاريخ التشغيلة غير صحيح');
    else out.run_date = b.runDate;
  }
  if (create || has('targetWeight')) {
    out.target_weight = readDecimal(b.targetWeight, 'الوزن المستهدف', { min: 1, max: 100, required: true });
  }
  if (create || has('shift')) out.shift = cleanText(b.shift, 40);
  if (create || has('startTime')) out.start_time = readTime(b.startTime, 'وقت البدء');
  if (has('endTime')) out.end_time = readTime(b.endTime, 'وقت الانتهاء');
  if (create || has('operatorName')) out.operator_name = cleanText(b.operatorName, 120);
  if (create || has('pasteBatch')) out.paste_batch = cleanText(b.pasteBatch, 80);
  if (create || has('pasteMoistureLevel')) {
    const v = b.pasteMoistureLevel === undefined || b.pasteMoistureLevel === '' ? null : b.pasteMoistureLevel;
    if (v !== null && !MOISTURE_LEVELS.includes(v)) throw badRequest('درجة رطوبة العجينة غير صحيحة (dry أو medium أو wet)');
    out.paste_moisture_level = v;
  }
  if (create || has('pasteMoisturePct')) {
    out.paste_moisture_pct = readDecimal(b.pasteMoisturePct, 'نسبة رطوبة العجينة', { min: 0, max: 100 });
  }
  if (create || has('speedUnit')) {
    const v = b.speedUnit === undefined || b.speedUnit === null || b.speedUnit === '' ? 'Hz' : b.speedUnit;
    if (!SPEED_UNITS.includes(v)) throw badRequest('وحدة السرعة غير صحيحة (Hz أو % أو RPM)');
    out.speed_unit = v;
  }
  if (create) {
    out.speed_belt = readDecimal(b.speedBelt, 'سرعة السير', { min: 0, max: 100000 });
    out.speed_push = readDecimal(b.speedPush, 'سرعة الدفع', { min: 0, max: 100000 });
    out.speed_rotary = readDecimal(b.speedRotary, 'سرعة الدوار', { min: 0, max: 100000 });
  }
  if (create || has('producedCount')) {
    out.produced_count = b.producedCount === undefined || b.producedCount === null || b.producedCount === ''
      ? null
      : readCount(b.producedCount, 'عدد المنتَج');
  }
  if (create || has('notes')) out.notes = cleanText(b.notes, 1000);
  return out;
}

// POST /api/mamoul-monitor/runs
router.post('/runs', async (req, res) => {
  let d;
  try {
    d = readRunBody(req.body, { create: true });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const machine = await pool.query('SELECT id, active FROM mamoul_machines WHERE id = $1', [d.machine_id]);
  if (machine.rows.length === 0 || !machine.rows[0].active) {
    return res.status(400).json({ error: 'المكينة المختارة غير موجودة أو معطّلة' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO mamoul_runs
         (machine_id, run_date, shift, target_weight, weight_min, weight_max, start_time, status, operator_name,
          paste_batch, paste_moisture_level, paste_moisture_pct, speed_unit, speed_belt, speed_push,
          speed_rotary, produced_count, notes, created_by, created_by_user)
       VALUES ($19, COALESCE($1::date, (now() AT TIME ZONE '${TZ}')::date), $2, $3, $4, $5,
               COALESCE($6::time, (now() AT TIME ZONE '${TZ}')::time), 'open', $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [d.run_date, d.shift, d.target_weight, WEIGHT_MIN, WEIGHT_MAX, d.start_time, d.operator_name,
        d.paste_batch, d.paste_moisture_level, d.paste_moisture_pct, d.speed_unit, d.speed_belt,
        d.speed_push, d.speed_rotary, d.produced_count, d.notes, req.user.name || null, req.user.id || null,
        d.machine_id]
    );
    const id = ins.rows[0].id;
    if (d.speed_belt !== null || d.speed_push !== null || d.speed_rotary !== null) {
      await client.query(
        `INSERT INTO mamoul_speed_changes (run_id, change_time, speed_belt, speed_push, speed_rotary, reason, created_by)
         VALUES ($1, COALESCE($2::time, (now() AT TIME ZONE '${TZ}')::time), $3, $4, $5, 'بداية التشغيلة', $6)`,
        [id, d.start_time, d.speed_belt, d.speed_push, d.speed_rotary, req.user.name || null]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(await loadRunDetail(id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/mamoul-monitor/runs/:id — تعديل بيانات التشغيلة (ليس السرعات ولا الحالة)
router.patch('/runs/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let d;
  try {
    d = readRunBody(req.body, { create: false });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const keys = Object.keys(d);
  if (keys.length === 0) return res.status(400).json({ error: 'لا توجد حقول للتعديل' });
  if (d.machine_id) {
    const mm = await pool.query('SELECT id FROM mamoul_machines WHERE id = $1', [d.machine_id]);
    if (mm.rows.length === 0) return res.status(400).json({ error: 'المكينة المختارة غير موجودة' });
  }
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const { rowCount } = await pool.query(
    `UPDATE mamoul_runs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => d[k]), id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'التشغيلة غير موجودة' });
  res.json(await loadRunDetail(id));
});

// POST /api/mamoul-monitor/runs/:id/close — { endTime?, producedCount? }
router.post('/runs/:id/close', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  let endTime;
  let produced;
  try {
    endTime = readTime((req.body || {}).endTime, 'وقت الانتهاء');
    const pc = (req.body || {}).producedCount;
    produced = pc === undefined || pc === null || pc === '' ? undefined : readCount(pc, 'عدد المنتَج');
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const { rowCount } = await pool.query(
    `UPDATE mamoul_runs SET status = 'closed',
            end_time = COALESCE($1::time, end_time, (now() AT TIME ZONE '${TZ}')::time),
            produced_count = CASE WHEN $2::int IS NULL THEN produced_count ELSE $2::int END,
            updated_at = now()
      WHERE id = $3`,
    [endTime, produced === undefined ? null : produced, id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'التشغيلة غير موجودة' });
  res.json(await loadRunDetail(id));
});

// POST /api/mamoul-monitor/runs/:id/reopen
router.post('/runs/:id/reopen', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const { rowCount } = await pool.query(
    "UPDATE mamoul_runs SET status = 'open', end_time = NULL, updated_at = now() WHERE id = $1",
    [id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'التشغيلة غير موجودة' });
  res.json(await loadRunDetail(id));
});

// DELETE /api/mamoul-monitor/runs/:id — مسؤول الصيانة / مدير النظام فقط
router.delete('/runs/:id', requireRole('maintenance_manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const { rowCount } = await pool.query('DELETE FROM mamoul_runs WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'التشغيلة غير موجودة' });
  res.json({ ok: true });
});

// يتأكد أن التشغيلة موجودة ومفتوحة (الإضافة على تشغيلة مغلقة مرفوضة بـ409).
async function requireOpenRun(client, id) {
  const { rows } = await client.query(
    'SELECT id, status, speed_belt, speed_push, speed_rotary FROM mamoul_runs WHERE id = $1',
    [id]
  );
  if (rows.length === 0) throw badRequest('التشغيلة غير موجودة', 404);
  if (rows[0].status !== 'open') throw badRequest('التشغيلة مغلقة — أعد فتحها أولًا لإضافة بيانات', 409);
  return rows[0];
}

function sendError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  throw err;
}

// ---------------------------------------------------------------------------
// تغيير السرعات
// ---------------------------------------------------------------------------

// POST /api/mamoul-monitor/runs/:id/speeds — { speedBelt?, speedPush?, speedRotary?, reason?, time? }
// ما لم يُرسَل يبقى كما هو؛ يُسجَّل السجل بالسرعات الثلاث السارية بعد التغيير.
router.post('/runs/:id/speeds', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let belt;
  let push;
  let rotary;
  let time;
  try {
    belt = readDecimal(b.speedBelt, 'سرعة السير', { min: 0, max: 100000 });
    push = readDecimal(b.speedPush, 'سرعة الدفع', { min: 0, max: 100000 });
    rotary = readDecimal(b.speedRotary, 'سرعة الدوار', { min: 0, max: 100000 });
    time = readTime(b.time, 'وقت التغيير');
    if (belt === null && push === null && rotary === null) throw badRequest('أدخل سرعة واحدة على الأقل');
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await requireOpenRun(client, id);
    const nb = belt === null ? run.speed_belt : belt;
    const np = push === null ? run.speed_push : push;
    const nr = rotary === null ? run.speed_rotary : rotary;
    await client.query(
      'UPDATE mamoul_runs SET speed_belt = $1, speed_push = $2, speed_rotary = $3, updated_at = now() WHERE id = $4',
      [nb, np, nr, id]
    );
    await client.query(
      `INSERT INTO mamoul_speed_changes (run_id, change_time, speed_belt, speed_push, speed_rotary, reason, created_by)
       VALUES ($1, COALESCE($2::time, (now() AT TIME ZONE '${TZ}')::time), $3, $4, $5, $6, $7)`,
      [id, time, nb, np, nr, cleanText(b.reason, 300), req.user.name || null]
    );
    await client.query('COMMIT');
    res.json(await loadRunDetail(id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// عيّنات الوزن
// ---------------------------------------------------------------------------

function readWeights(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('أدخل وزن قطعة واحدة على الأقل');
  if (raw.length > 100) throw badRequest('عدد القطع في العيّنة كبير جدًا (الحد الأقصى ١٠٠)');
  return raw.map((w, i) => {
    const n = readDecimal(w, `الوزن رقم ${i + 1}`, { min: 0.1, max: 500, required: true });
    return n;
  });
}

async function writeWeights(client, sampleId, weights) {
  for (const w of weights) {
    await client.query('INSERT INTO mamoul_sample_weights (sample_id, weight) VALUES ($1, $2)', [sampleId, w]);
  }
}

// حقول الأداء الاختيارية للعيّنة: قطع/دقيقة، ضغط اليد، حرارة العجينة.
// { has: true } تعني أن الحقل مُرسَل (فارغ ⇒ null يمسح القيمة السابقة).
function readSampleExtras(b) {
  const out = {};
  if (b.piecesPerMin !== undefined) {
    out.pieces_per_min = readDecimal(b.piecesPerMin, 'عدد القطع في الدقيقة', { min: 0.1, max: 5000 });
  }
  if (b.pressureLevel !== undefined) {
    const v = b.pressureLevel === '' ? null : b.pressureLevel;
    if (v !== null && !PRESSURE_LEVELS.includes(v)) throw badRequest('مستوى الضغط غير صحيح (none أو light أو medium أو strong)');
    out.pressure_level = v;
  }
  if (b.doughTemp !== undefined) {
    out.dough_temp = readDecimal(b.doughTemp, 'حرارة العجينة', { min: 0, max: 100 });
  }
  return out;
}

async function loadOneSample(sampleId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.run_id, to_char(s.sample_time, 'HH24:MI') AS sample_time,
            s.speed_belt, s.speed_push, s.speed_rotary, s.pieces_per_min, s.pressure_level, s.dough_temp,
            s.note, s.created_by, s.created_at,
            r.weight_min, r.weight_max, r.target_weight
       FROM mamoul_samples s JOIN mamoul_runs r ON r.id = s.run_id WHERE s.id = $1`,
    [sampleId]
  );
  if (rows.length === 0) return null;
  const s = rows[0];
  const w = await pool.query('SELECT weight FROM mamoul_sample_weights WHERE sample_id = $1 ORDER BY id', [sampleId]);
  const weights = w.rows.map((x) => x.weight);
  const { weight_min: mn, weight_max: mx, target_weight: tg, ...sample } = s;
  return { ...sample, weights, stats: weightStats(weights, mn, mx, tg) };
}

// POST /api/mamoul-monitor/runs/:id/samples
//   { weights: [..], time?, note?, piecesPerMin?, pressureLevel?, doughTemp? }
// تُنسخ السرعات السارية للتشغيلة وقت أخذ العيّنة.
router.post('/runs/:id/samples', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let weights;
  let time;
  let extras;
  try {
    weights = readWeights(b.weights);
    time = readTime(b.time, 'وقت العيّنة');
    extras = readSampleExtras(b);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await requireOpenRun(client, id);
    const ins = await client.query(
      `INSERT INTO mamoul_samples
         (run_id, sample_time, speed_belt, speed_push, speed_rotary, note, created_by,
          pieces_per_min, pressure_level, dough_temp)
       VALUES ($1, COALESCE($2::time, (now() AT TIME ZONE '${TZ}')::time), $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [id, time, run.speed_belt, run.speed_push, run.speed_rotary, cleanText(b.note, 300), req.user.name || null,
        extras.pieces_per_min === undefined ? null : extras.pieces_per_min,
        extras.pressure_level === undefined ? null : extras.pressure_level,
        extras.dough_temp === undefined ? null : extras.dough_temp]
    );
    await writeWeights(client, ins.rows[0].id, weights);
    await client.query('UPDATE mamoul_runs SET updated_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(201).json({ sample: await loadOneSample(ins.rows[0].id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err);
  } finally {
    client.release();
  }
});

// PATCH /api/mamoul-monitor/samples/:id — تصحيح أوزان/ملاحظة/وقت/قطع في الدقيقة/ضغط/حرارة العجينة
// (تُستبدل الأوزان المُرسَلة؛ إرسال قيمة فارغة لقطع/ضغط/حرارة يمسحها)
router.patch('/samples/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let weights = null;
  let time = null;
  let extras = {};
  try {
    if (b.weights !== undefined) weights = readWeights(b.weights);
    time = readTime(b.time, 'وقت العيّنة');
    extras = readSampleExtras(b);
    if (weights === null && time === null && b.note === undefined && Object.keys(extras).length === 0) {
      throw badRequest('لا توجد حقول للتعديل');
    }
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT s.id, s.run_id, r.status FROM mamoul_samples s JOIN mamoul_runs r ON r.id = s.run_id WHERE s.id = $1',
      [id]
    );
    if (cur.rows.length === 0) throw badRequest('العيّنة غير موجودة', 404);
    if (cur.rows[0].status !== 'open') throw badRequest('التشغيلة مغلقة — أعد فتحها أولًا للتعديل', 409);
    if (time !== null) await client.query('UPDATE mamoul_samples SET sample_time = $1::time WHERE id = $2', [time, id]);
    if (b.note !== undefined) await client.query('UPDATE mamoul_samples SET note = $1 WHERE id = $2', [cleanText(b.note, 300), id]);
    for (const col of ['pieces_per_min', 'pressure_level', 'dough_temp']) {
      if (extras[col] !== undefined) {
        await client.query(`UPDATE mamoul_samples SET ${col} = $1 WHERE id = $2`, [extras[col], id]);
      }
    }
    if (weights !== null) {
      await client.query('DELETE FROM mamoul_sample_weights WHERE sample_id = $1', [id]);
      await writeWeights(client, id, weights);
    }
    await client.query('UPDATE mamoul_runs SET updated_at = now() WHERE id = $1', [cur.rows[0].run_id]);
    await client.query('COMMIT');
    res.json({ sample: await loadOneSample(id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err);
  } finally {
    client.release();
  }
});

// DELETE /api/mamoul-monitor/samples/:id
router.delete('/samples/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const cur = await pool.query(
    'SELECT s.id, r.status FROM mamoul_samples s JOIN mamoul_runs r ON r.id = s.run_id WHERE s.id = $1',
    [id]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'العيّنة غير موجودة' });
  if (cur.rows[0].status !== 'open') return res.status(409).json({ error: 'التشغيلة مغلقة — أعد فتحها أولًا للحذف' });
  await pool.query('DELETE FROM mamoul_samples WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// عدّادات العيوب
// ---------------------------------------------------------------------------

// POST /api/mamoul-monitor/runs/:id/defects — { twins?, flash?, rejected?, time?, note? }
router.post('/runs/:id/defects', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let twins;
  let flash;
  let rejected;
  let time;
  try {
    twins = readCount(b.twins, 'عدد التوائم');
    flash = readCount(b.flash, 'عدد الزوائد');
    rejected = readCount(b.rejected, 'عدد المرفوض');
    time = readTime(b.time, 'وقت التسجيل');
    if (twins + flash + rejected === 0) throw badRequest('أدخل عددًا واحدًا على الأقل أكبر من صفر');
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOpenRun(client, id);
    const ins = await client.query(
      `INSERT INTO mamoul_defects (run_id, event_time, twins, flash, rejected, note, created_by)
       VALUES ($1, COALESCE($2::time, (now() AT TIME ZONE '${TZ}')::time), $3, $4, $5, $6, $7)
       RETURNING id, run_id, to_char(event_time, 'HH24:MI') AS event_time, twins, flash, rejected, note, created_by, created_at`,
      [id, time, twins, flash, rejected, cleanText(b.note, 300), req.user.name || null]
    );
    await client.query('UPDATE mamoul_runs SET updated_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(201).json({ defect: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err);
  } finally {
    client.release();
  }
});

// DELETE /api/mamoul-monitor/defects/:id
router.delete('/defects/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const cur = await pool.query(
    'SELECT d.id, r.status FROM mamoul_defects d JOIN mamoul_runs r ON r.id = d.run_id WHERE d.id = $1',
    [id]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'السجل غير موجود' });
  if (cur.rows[0].status !== 'open') return res.status(409).json({ error: 'التشغيلة مغلقة — أعد فتحها أولًا للحذف' });
  await pool.query('DELETE FROM mamoul_defects WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// سجل التدخل البشري (ضغط يدوي على المكينة، فك توائم، تعديل العجينة، تنظيف…)
// ---------------------------------------------------------------------------

// POST /api/mamoul-monitor/runs/:id/interventions — { kind, time?, minutes?, note? }
// (note إلزامية لنوع "other")
router.post('/runs/:id/interventions', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let kind;
  let time;
  let minutes = null;
  let note;
  try {
    if (!INTERVENTION_KINDS.includes(b.kind)) throw badRequest('نوع التدخل غير صحيح');
    kind = b.kind;
    time = readTime(b.time, 'وقت التدخل');
    if (b.minutes !== undefined && b.minutes !== null && b.minutes !== '') {
      minutes = readCount(b.minutes, 'مدة التدخل (دقائق)', 1000);
    }
    note = cleanText(b.note, 300);
    if (kind === 'other' && !note) throw badRequest('اكتب وصف التدخل');
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOpenRun(client, id);
    const ins = await client.query(
      `INSERT INTO mamoul_interventions (run_id, event_time, kind, minutes, note, created_by)
       VALUES ($1, COALESCE($2::time, (now() AT TIME ZONE '${TZ}')::time), $3, $4, $5, $6)
       RETURNING ${INTERVENTION_COLUMNS}`,
      [id, time, kind, minutes, note, req.user.name || null]
    );
    await client.query('UPDATE mamoul_runs SET updated_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(201).json({ intervention: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err);
  } finally {
    client.release();
  }
});

// DELETE /api/mamoul-monitor/interventions/:id
router.delete('/interventions/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const cur = await pool.query(
    'SELECT i.id, r.status FROM mamoul_interventions i JOIN mamoul_runs r ON r.id = i.run_id WHERE i.id = $1',
    [id]
  );
  if (cur.rows.length === 0) return res.status(404).json({ error: 'السجل غير موجود' });
  if (cur.rows[0].status !== 'open') return res.status(409).json({ error: 'التشغيلة مغلقة — أعد فتحها أولًا للحذف' });
  await pool.query('DELETE FROM mamoul_interventions WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// قراءات الإنتاج بالدقيقة (عدّاد الدقيقة): لكل مكينة قراءة = (عدد القطع في الدقيقة + وزن القطعة
// + ساعات العمل اختياريًا). آخر قراءة لكل مكينة تظهر تلقائيًا في جدول مقارنة المكائن
// (rate) فتُحسب منها: ثواني الكيلو، والإنتاج في الساعة، والإنتاج خلال ساعات العمل.
// ---------------------------------------------------------------------------

const READING_COLUMNS = 'id, machine_id, run_id, pieces_per_min, weight_g, work_hours, created_by, created_at';

function readingOut(r) {
  return {
    id: r.id,
    machine_id: r.machine_id,
    run_id: r.run_id,
    pieces_per_min: Number(r.pieces_per_min),
    weight_g: Number(r.weight_g),
    work_hours: r.work_hours === null || r.work_hours === undefined ? null : Number(r.work_hours),
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

// POST /api/mamoul-monitor/machines/:id/readings — { piecesPerMin, weightG, workHours?, runId? }
router.post('/machines/:id/readings', async (req, res) => {
  const machineId = parseId(req.params.id);
  if (!machineId) return res.status(400).json({ error: 'معرّف المكينة غير صحيح' });
  const b = req.body || {};
  let piecesPerMin;
  let weightG;
  let workHours;
  let runId = null;
  try {
    piecesPerMin = readDecimal(b.piecesPerMin, 'عدد القطع في الدقيقة', { min: 0.1, max: 5000, required: true });
    weightG = readDecimal(b.weightG, 'وزن القطعة', { min: 0.1, max: 500, required: true });
    workHours = readDecimal(b.workHours, 'ساعات العمل', { min: 0.1, max: 24 });
    if (b.runId !== undefined && b.runId !== null && b.runId !== '') {
      runId = parseId(b.runId);
      if (!runId) throw badRequest('معرّف التشغيلة غير صحيح');
    }
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const m = await pool.query('SELECT id FROM mamoul_machines WHERE id = $1', [machineId]);
  if (m.rows.length === 0) return res.status(404).json({ error: 'المكينة غير موجودة' });
  if (runId !== null) {
    const rr = await pool.query('SELECT id FROM mamoul_runs WHERE id = $1 AND machine_id = $2', [runId, machineId]);
    if (rr.rows.length === 0) runId = null; // تشغيلة لا تخص هذه المكينة: نحفظ القراءة بلا ربط
  }
  const ins = await pool.query(
    `INSERT INTO mamoul_rate_readings (machine_id, run_id, pieces_per_min, weight_g, work_hours, created_by, created_by_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${READING_COLUMNS}`,
    [machineId, runId, piecesPerMin, weightG, workHours, req.user.name || null, req.user.id || null]
  );
  res.status(201).json({ reading: readingOut(ins.rows[0]) });
});

// GET /api/mamoul-monitor/machines/:id/readings[?limit=20] — الأحدث أولًا
router.get('/machines/:id/readings', async (req, res) => {
  const machineId = parseId(req.params.id);
  if (!machineId) return res.status(400).json({ error: 'معرّف المكينة غير صحيح' });
  let limit = 20;
  if (req.query && req.query.limit !== undefined && req.query.limit !== '') {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'limit غير صحيح' });
  }
  const { rows } = await pool.query(
    `SELECT ${READING_COLUMNS} FROM mamoul_rate_readings WHERE machine_id = $1 ORDER BY id DESC LIMIT $2`,
    [machineId, limit]
  );
  res.json({ readings: rows.map(readingOut) });
});

// DELETE /api/mamoul-monitor/readings/:id — مسؤول الصيانة والمدير فقط
router.delete('/readings/:id', requireRole('maintenance_manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const del = await pool.query('DELETE FROM mamoul_rate_readings WHERE id = $1 RETURNING id', [id]);
  if (del.rows.length === 0) return res.status(404).json({ error: 'القراءة غير موجودة' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// أعطال البستونات والحساسات والمحركات
// ---------------------------------------------------------------------------

function readFaultBody(body, { create }) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  const out = {};
  if (create || has('machineId')) {
    if ((b.machineId === undefined || b.machineId === null || b.machineId === '') && create) out.machine_id = null;
    else {
      const mid = parseId(b.machineId);
      if (!mid) throw badRequest('معرّف المكينة غير صحيح');
      out.machine_id = mid;
    }
  }
  if (create || has('faultDate')) {
    if ((b.faultDate === undefined || b.faultDate === null || b.faultDate === '') && create) out.fault_date = null;
    else if (!isValidDate(b.faultDate)) throw badRequest('تاريخ العطل غير صحيح');
    else out.fault_date = b.faultDate;
  }
  if (create || has('faultTime')) out.fault_time = readTime(b.faultTime, 'وقت العطل');
  if (create || has('component')) {
    if (!FAULT_COMPONENTS.includes(b.component)) throw badRequest('نوع القطعة المعطّلة غير صحيح');
    out.component = b.component;
  }
  if (create || has('partLabel')) out.part_label = cleanText(b.partLabel, 120);
  if (create || has('description')) {
    const description = cleanText(b.description, 1000);
    if (!description) throw badRequest('وصف العطل إلزامي');
    out.description = description;
  }
  if (create || has('downtimeMinutes')) {
    out.downtime_minutes = b.downtimeMinutes === undefined || b.downtimeMinutes === null || b.downtimeMinutes === ''
      ? null
      : readCount(b.downtimeMinutes, 'مدة التوقف (دقائق)', 100000);
  }
  if (create || has('actionTaken')) out.action_taken = cleanText(b.actionTaken, 1000);
  if (create || has('runId')) {
    if (b.runId === undefined || b.runId === null || b.runId === '') out.run_id = null;
    else {
      const rid = parseId(b.runId);
      if (!rid) throw badRequest('معرّف التشغيلة غير صحيح');
      out.run_id = rid;
    }
  }
  return out;
}

async function loadOneFault(id) {
  const { rows } = await pool.query(`SELECT ${FAULT_COLUMNS} FROM mamoul_faults f LEFT JOIN mamoul_machines m ON m.id = f.machine_id WHERE f.id = $1`, [id]);
  return rows[0] || null;
}

// GET /api/mamoul-monitor/faults?date= | month= | from=&to= [&status=open|resolved] [&component=piston]
// بلا مدة → آخر ٩٠ يومًا.
router.get('/faults', async (req, res) => {
  const q = req.query || {};
  let range;
  try {
    range = resolveRange(q);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const conds = [];
  const params = [];
  if (range) {
    params.push(range.from, range.to);
    conds.push(`f.fault_date BETWEEN $${params.length - 1} AND $${params.length}`);
  } else {
    conds.push(`f.fault_date >= ((now() AT TIME ZONE '${TZ}')::date - 90)`);
  }
  if (q.status === 'open' || q.status === 'resolved') {
    params.push(q.status);
    conds.push(`f.status = $${params.length}`);
  } else if (q.status) {
    return res.status(400).json({ error: 'حالة غير صحيحة (open أو resolved)' });
  }
  if (q.component) {
    if (!FAULT_COMPONENTS.includes(q.component)) return res.status(400).json({ error: 'نوع القطعة غير صحيح' });
    params.push(q.component);
    conds.push(`f.component = $${params.length}`);
  }
  if (q.machineId !== undefined && q.machineId !== '') {
    const mid = parseId(q.machineId);
    if (!mid) return res.status(400).json({ error: 'معرّف المكينة غير صحيح' });
    params.push(mid);
    conds.push(`f.machine_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT ${FAULT_COLUMNS} FROM mamoul_faults f LEFT JOIN mamoul_machines m ON m.id = f.machine_id WHERE ${conds.join(' AND ')}
      ORDER BY (f.status = 'open') DESC, f.fault_date DESC, f.id DESC LIMIT 500`,
    params
  );
  // تكرار الأعطال لكل نوع قطعة (يكشف القطعة المتكررة العطل).
  const byComponent = {};
  for (const f of rows) byComponent[f.component] = (byComponent[f.component] || 0) + 1;
  res.json({
    faults: rows,
    open_count: rows.filter((f) => f.status === 'open').length,
    downtime_minutes: rows.reduce((a, f) => a + (f.downtime_minutes || 0), 0),
    by_component: byComponent,
  });
});

// POST /api/mamoul-monitor/faults
router.post('/faults', async (req, res) => {
  let d;
  try {
    d = readFaultBody(req.body, { create: true });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  let machineId = d.machine_id;
  if (d.run_id) {
    const r = await pool.query('SELECT id, machine_id FROM mamoul_runs WHERE id = $1', [d.run_id]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'التشغيلة المرتبطة غير موجودة' });
    if (machineId && r.rows[0].machine_id && machineId !== r.rows[0].machine_id) {
      return res.status(400).json({ error: 'التشغيلة المرتبطة على مكينة أخرى' });
    }
    if (!machineId) machineId = r.rows[0].machine_id;
  }
  if (!machineId) return res.status(400).json({ error: 'اختر المكينة المعطّلة' });
  const mm = await pool.query('SELECT id FROM mamoul_machines WHERE id = $1', [machineId]);
  if (mm.rows.length === 0) return res.status(400).json({ error: 'المكينة المختارة غير موجودة' });
  const ins = await pool.query(
    `INSERT INTO mamoul_faults
       (machine_id, run_id, fault_date, fault_time, component, part_label, description, downtime_minutes, action_taken,
        created_by, created_by_user)
     VALUES ($11, $1, COALESCE($2::date, (now() AT TIME ZONE '${TZ}')::date),
             COALESCE($3::time, (now() AT TIME ZONE '${TZ}')::time), $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [d.run_id, d.fault_date, d.fault_time, d.component, d.part_label, d.description, d.downtime_minutes,
      d.action_taken, req.user.name || null, req.user.id || null, machineId]
  );
  res.status(201).json({ fault: await loadOneFault(ins.rows[0].id) });
});

// PATCH /api/mamoul-monitor/faults/:id — تعديل حقول و/أو status ('open' | 'resolved')
router.patch('/faults/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const b = req.body || {};
  let d;
  let status = null;
  try {
    d = readFaultBody(b, { create: false });
    if (b.status !== undefined) {
      if (b.status !== 'open' && b.status !== 'resolved') throw badRequest('حالة غير صحيحة (open أو resolved)');
      status = b.status;
    }
    if (Object.keys(d).length === 0 && status === null) throw badRequest('لا توجد حقول للتعديل');
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  if (d.run_id) {
    const r = await pool.query('SELECT id FROM mamoul_runs WHERE id = $1', [d.run_id]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'التشغيلة المرتبطة غير موجودة' });
  }
  if (d.machine_id) {
    const mm = await pool.query('SELECT id FROM mamoul_machines WHERE id = $1', [d.machine_id]);
    if (mm.rows.length === 0) return res.status(400).json({ error: 'المكينة المختارة غير موجودة' });
  }
  const keys = Object.keys(d);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const params = keys.map((k) => d[k]);
  if (status === 'resolved') {
    params.push(req.user.name || null);
    sets.push(`status = 'resolved'`, 'resolved_at = now()', `resolved_by = $${params.length}`);
  } else if (status === 'open') {
    sets.push(`status = 'open'`, 'resolved_at = NULL', 'resolved_by = NULL');
  }
  params.push(id);
  const { rowCount } = await pool.query(
    `UPDATE mamoul_faults SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params
  );
  if (rowCount === 0) return res.status(404).json({ error: 'العطل غير موجود' });
  res.json({ fault: await loadOneFault(id) });
});

// DELETE /api/mamoul-monitor/faults/:id — مسؤول الصيانة / مدير النظام فقط
router.delete('/faults/:id', requireRole('maintenance_manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صحيح' });
  const { rowCount } = await pool.query('DELETE FROM mamoul_faults WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'العطل غير موجود' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// التحليل: أي سرعات تعطي أفضل وزن؟
// ---------------------------------------------------------------------------

function groupStats(items) {
  // items: [{ weights, min, max, target, ppm? }] — ppm = قطع/دقيقة المسجّلة للعيّنة (اختياري)
  const all = [];
  let out = 0;
  for (const it of items) {
    for (const w of it.weights) {
      all.push(w);
      if (w < it.min - EPS || w > it.max + EPS) out += 1;
    }
  }
  const n = all.length;
  if (n === 0) return null;
  const avg = all.reduce((a, w) => a + w, 0) / n;
  const std = n > 1 ? Math.sqrt(all.reduce((a, w) => a + (w - avg) * (w - avg), 0) / (n - 1)) : 0;
  const ppmValues = items.map((it) => it.ppm).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const ppm = ppmValues.length ? ppmValues.reduce((a, v) => a + v, 0) / ppmValues.length : null;
  return {
    pieces: n,
    avg: round3(avg),
    min: Math.min(...all),
    max: Math.max(...all),
    std: round3(std),
    out_count: out,
    out_pct: round1((out / n) * 100),
    avg_ppm: ppm === null ? null : round1(ppm),
    ppm_samples: ppmValues.length,
  };
}

// عدد العيّنات لكل مستوى ضغط (unknown = لم يُسجَّل) + المستوى الأكثر تكرارًا بين المسجَّلة.
function pressureMix(items) {
  const counts = { none: 0, light: 0, medium: 0, strong: 0, unknown: 0 };
  for (const it of items) {
    if (it.pressure && PRESSURE_LEVELS.includes(it.pressure)) counts[it.pressure] += 1;
    else counts.unknown += 1;
  }
  let main = null;
  let best = 0;
  for (const level of PRESSURE_LEVELS) {
    if (counts[level] > best) {
      best = counts[level];
      main = level;
    }
  }
  return { counts, main };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// يعيد تاريخ اليوم بتوقيت الرياض (YYYY-MM-DD) مطروحًا منه [minusDays] يومًا.
function riyadhDate(minusDays = 0) {
  const t = Date.now() + 3 * 3600 * 1000 - minusDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// GET /api/mamoul-monitor/analysis?from=&to=[&target=6.2][&machineId=3]  (بلا مدة: آخر ٩٠ يومًا)
// تحليل لكل مكينة على حدة: يجمّع كل العيّنات بحسب (المكينة + تركيبة السرعات الثلاث)،
// وبحسب دفعة العجينة ودرجة الرطوبة، ويقترح "أفضل ضبط" لكل مكينة من التركيبات التي
// قيست عليها قطع كافية. ويعيد أيضًا جدول مقارنة بين كل المكائن (machines).
router.get('/analysis', async (req, res) => {
  const q = req.query || {};
  let range;
  try {
    range = resolveRange(q);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const from = range ? range.from : riyadhDate(90);
  const to = range ? range.to : riyadhDate(0);
  let target = null;
  if (q.target !== undefined && q.target !== '') {
    const t = Number(q.target);
    if (!Number.isFinite(t) || t <= 0 || t > 100) return res.status(400).json({ error: 'هدف الوزن غير صحيح' });
    target = round2(t);
  }
  let machineId = null;
  if (q.machineId !== undefined && q.machineId !== '') {
    machineId = parseId(q.machineId);
    if (!machineId) return res.status(400).json({ error: 'معرّف المكينة غير صحيح' });
  }

  const params = [from, to];
  let runConds = 'r.run_date BETWEEN $1 AND $2';
  if (target !== null) {
    params.push(target);
    runConds += ` AND r.target_weight = $${params.length}`;
  }

  const [machineRows, sampleRows, defectRows, runRows, faultRows, interventionRows, readingRows] = await Promise.all([
    loadMachines(),
    pool.query(
      `SELECT s.id, s.run_id, r.machine_id, s.speed_belt, s.speed_push, s.speed_rotary,
              s.pieces_per_min, s.pressure_level, s.dough_temp, r.speed_unit, r.weight_min, r.weight_max, r.target_weight, r.paste_batch, r.paste_moisture_level
         FROM mamoul_samples s JOIN mamoul_runs r ON r.id = s.run_id
        WHERE ${runConds} ORDER BY s.id`,
      params
    ),
    pool.query(
      `SELECT r.machine_id, COALESCE(SUM(d.twins), 0) AS twins, COALESCE(SUM(d.flash), 0) AS flash,
              COALESCE(SUM(d.rejected), 0) AS rejected
         FROM mamoul_defects d JOIN mamoul_runs r ON r.id = d.run_id
        WHERE ${runConds} GROUP BY r.machine_id`,
      params
    ),
    pool.query(
      `SELECT r.machine_id, count(*) AS runs_count, COALESCE(SUM(r.produced_count), 0) AS produced
         FROM mamoul_runs r WHERE ${runConds} GROUP BY r.machine_id`,
      params
    ),
    pool.query(
      `SELECT f.machine_id, count(*) AS total, count(*) FILTER (WHERE f.status = 'open') AS open,
              COALESCE(SUM(f.downtime_minutes), 0) AS downtime
         FROM mamoul_faults f WHERE f.fault_date BETWEEN $1 AND $2 GROUP BY f.machine_id`,
      [from, to]
    ),
    pool.query(
      `SELECT r.machine_id, i.kind, count(*) AS total, COALESCE(SUM(i.minutes), 0) AS minutes
         FROM mamoul_interventions i JOIN mamoul_runs r ON r.id = i.run_id
        WHERE ${runConds} GROUP BY r.machine_id, i.kind`,
      params
    ),
    pool.query(
      `SELECT DISTINCT ON (machine_id) machine_id, pieces_per_min, weight_g, work_hours, created_at, created_by,
              count(*) OVER (PARTITION BY machine_id) AS readings_count
         FROM mamoul_rate_readings ORDER BY machine_id, id DESC`
    ),
  ]);

  const samples = sampleRows.rows;
  let weightsBySample = new Map();
  if (samples.length > 0) {
    const w = await pool.query(
      'SELECT sample_id, weight FROM mamoul_sample_weights WHERE sample_id = ANY($1::bigint[]) ORDER BY id',
      [samples.map((r) => r.id)]
    );
    weightsBySample = new Map();
    for (const x of w.rows) {
      if (!weightsBySample.has(x.sample_id)) weightsBySample.set(x.sample_id, []);
      weightsBySample.get(x.sample_id).push(x.weight);
    }
  }
  const items = samples.map((s) => ({
    ...s,
    weights: weightsBySample.get(s.id) || [],
    min: Number(s.weight_min),
    max: Number(s.weight_max),
    target: Number(s.target_weight),
    ppm: num(s.pieces_per_min),
    pressure: s.pressure_level || null,
    temp: num(s.dough_temp),
  }));
  const machineName = new Map(machineRows.map((m) => [m.id, m.name]));
  const scoped = machineId === null ? items : items.filter((it) => it.machine_id === machineId);

  // ضغط اليد لا يمكن التحكم فيه: التوصيات تُبنى على العيّنات التي بدون ضغط يد فقط،
  // والتي فيها ضغط يد تُعرض منفصلة (assisted_speeds) ولا تُوصى.
  const cleanItems = scoped.filter(isCleanSample);
  const assistedItems = scoped.filter((it) => !isCleanSample(it));

  // 1) تركيبات السرعات (لكل مكينة على حدة)
  const buildSpeeds = (list) => {
    const speedGroups = new Map();
    for (const it of list) {
      if (it.speed_belt === null && it.speed_push === null && it.speed_rotary === null) continue;
      const key = [it.machine_id, it.speed_unit, it.speed_belt, it.speed_push, it.speed_rotary, it.target].join('|');
      if (!speedGroups.has(key)) {
        speedGroups.set(key, {
          machine_id: it.machine_id,
          speed_unit: it.speed_unit,
          speed_belt: num(it.speed_belt),
          speed_push: num(it.speed_push),
          speed_rotary: num(it.speed_rotary),
          target_weight: it.target,
          items: [],
          runs: new Set(),
        });
      }
      const g = speedGroups.get(key);
      g.items.push(it);
      g.runs.add(it.run_id);
    }
    return Array.from(speedGroups.values())
      .map((g) => {
        const st = groupStats(g.items);
        if (!st) return null;
        const mix = pressureMix(g.items);
        return {
          machine_id: g.machine_id,
          machine_name: machineName.get(g.machine_id) || null,
          speed_unit: g.speed_unit,
          speed_belt: g.speed_belt,
          speed_push: g.speed_push,
          speed_rotary: g.speed_rotary,
          target_weight: g.target_weight,
          samples_count: g.items.length,
          runs_count: g.runs.size,
          ...st,
          pressure_counts: mix.counts,
          main_pressure: mix.main,
          enough_data: st.pieces >= MIN_PIECES_FOR_RECOMMENDATION,
          deviation: round3(st.avg - g.target_weight),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.machine_id - b.machine_id) || (b.pieces - a.pieces));
  };
  const speeds = buildSpeeds(cleanItems);
  const assistedSpeeds = buildSpeeds(assistedItems);

  // أفضل ضبط: لكل مكينة أفضل ٣ تركيبات (أقل نسبة خارج الحدّين، ثم أقرب لهدف الوزن، ثم أقل تذبذبًا).
  const recommended = [];
  const machineIdsWithSpeeds = Array.from(new Set(speeds.map((s) => s.machine_id)));
  for (const mid of machineIdsWithSpeeds) {
    speeds
      .filter((s) => s.machine_id === mid && s.enough_data)
      .sort((a, b) => a.out_pct - b.out_pct || Math.abs(a.deviation) - Math.abs(b.deviation) || a.std - b.std)
      .slice(0, 3)
      .forEach((s) => recommended.push(s));
  }

  // الأسرع داخل النطاق: لكل مكينة أعلى ٣ تركيبات في قطع/دقيقة من التي قطعها كلها داخل
  // حدّي الوزن (FASTEST_MAX_OUT_PCT) وقياساتها كافية. هذا هو "ارفع السرعة إلى هنا".
  const fastest = [];
  for (const mid of machineIdsWithSpeeds) {
    speeds
      .filter((s) => s.machine_id === mid && s.enough_data && s.avg_ppm !== null && s.out_pct <= FASTEST_MAX_OUT_PCT)
      .sort((a, b) => b.avg_ppm - a.avg_ppm || a.std - b.std)
      .slice(0, 3)
      .forEach((s) => fastest.push(s));
  }

  // 2) دفعات العجينة ودرجة الرطوبة (ضمن نطاق المكينة المختارة، أو الكل لو لم تُحدَّد)
  const groupBy = (keyFn, labelKey, source = cleanItems) => {
    const m = new Map();
    for (const it of source) {
      const k = keyFn(it);
      if (k === null) continue;
      if (!m.has(k)) m.set(k, { [labelKey]: k, items: [], runs: new Set() });
      const g = m.get(k);
      g.items.push(it);
      g.runs.add(it.run_id);
    }
    return Array.from(m.values())
      .map((g) => {
        const st = groupStats(g.items);
        if (!st) return null;
        return { [labelKey]: g[labelKey], runs_count: g.runs.size, samples_count: g.items.length, ...st };
      })
      .filter(Boolean)
      .sort((a, b) => b.pieces - a.pieces);
  };

  // 2-ب) ضغط اليد (كل العيّنات): ماذا يضيف الضغط اليدوي من قطع/دقيقة؟ وعلى حساب الوزن؟
  const byPressure = groupBy((it) => (PRESSURE_LEVELS.includes(it.pressure) ? it.pressure : null), 'pressure_level', scoped).sort(
    (a, b) => PRESSURE_LEVELS.indexOf(a.pressure_level) - PRESSURE_LEVELS.indexOf(b.pressure_level)
  );

  // 2-ج) حرارة العجينة بشرائح (٥ درجات): أي حرارة تعطي وزنًا أثبت؟
  const tempGroups = new Map();
  for (const it of cleanItems) {
    if (it.temp === null || !Number.isFinite(it.temp)) continue;
    const from = Math.floor(it.temp / TEMP_BAND) * TEMP_BAND;
    if (!tempGroups.has(from)) tempGroups.set(from, { temp_from: from, items: [], runs: new Set() });
    const g = tempGroups.get(from);
    g.items.push(it);
    g.runs.add(it.run_id);
  }
  const byDoughTemp = Array.from(tempGroups.values())
    .map((g) => {
      const st = groupStats(g.items);
      if (!st) return null;
      return {
        temp_from: g.temp_from,
        temp_to: g.temp_from + TEMP_BAND,
        runs_count: g.runs.size,
        samples_count: g.items.length,
        ...st,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.temp_from - b.temp_from);

  // 3) مقارنة بين المكائن (كل المكائن، بغض النظر عن فلتر machineId)
  const defectsBy = new Map(defectRows.rows.map((r) => [r.machine_id, r]));
  const runsBy = new Map(runRows.rows.map((r) => [r.machine_id, r]));
  const faultsBy = new Map(faultRows.rows.map((r) => [r.machine_id, r]));
  const readingsBy = new Map(readingRows.rows.map((r) => [r.machine_id, r]));
  const interventionsBy = new Map();
  for (const r of interventionRows.rows) {
    if (!interventionsBy.has(r.machine_id)) interventionsBy.set(r.machine_id, { total: 0, minutes: 0, by_kind: {} });
    const g = interventionsBy.get(r.machine_id);
    g.total += Number(r.total);
    g.minutes += Number(r.minutes);
    g.by_kind[r.kind] = Number(r.total);
  }
  const comparison = machineRows
    .map((m) => {
      const mItems = items.filter((it) => it.machine_id === m.id);
      const st = groupStats(mItems);
      const d = defectsBy.get(m.id);
      const r = runsBy.get(m.id);
      const f = faultsBy.get(m.id);
      const iv = interventionsBy.get(m.id);
      const lr = readingsBy.get(m.id);
      const twins = d ? Number(d.twins) : 0;
      const flash = d ? Number(d.flash) : 0;
      const rejected = d ? Number(d.rejected) : 0;
      const produced = r ? Number(r.produced) : 0;
      const defectsTotal = twins + flash + rejected;
      return {
        machine_id: m.id,
        machine_name: m.name,
        active: m.active,
        runs_count: r ? Number(r.runs_count) : 0,
        samples_count: mItems.length,
        assisted_samples: mItems.filter((x) => !isCleanSample(x)).length,
        pieces: st ? st.pieces : 0,
        avg: st ? st.avg : null,
        std: st ? st.std : null,
        out_pct: st ? st.out_pct : null,
        avg_ppm: st ? st.avg_ppm : null,
        interventions: iv
          ? { total: iv.total, minutes: iv.minutes, by_kind: iv.by_kind }
          : { total: 0, minutes: 0, by_kind: {} },
        defects: { twins, flash, rejected, total: defectsTotal },
        produced_count: produced,
        // آخر قراءة إنتاج بالدقيقة للمكينة (من عدّاد الدقيقة) — بلا تقييد بمدة التحليل.
        rate: lr
          ? {
              pieces_per_min: Number(lr.pieces_per_min),
              weight_g: Number(lr.weight_g),
              work_hours: lr.work_hours === null ? null : Number(lr.work_hours),
              at: lr.created_at,
              by: lr.created_by,
              readings_count: Number(lr.readings_count),
            }
          : null,
        defect_pct: produced > 0 ? round1((defectsTotal / produced) * 100) : null,
        faults_total: f ? Number(f.total) : 0,
        faults_open: f ? Number(f.open) : 0,
        downtime_minutes: f ? Number(f.downtime) : 0,
      };
    })
    .filter((c) => c.active || c.runs_count > 0 || c.faults_total > 0 || c.rate !== null);

  res.json({
    from,
    to,
    target_weight: target,
    machine_id: machineId,
    min_pieces_for_recommendation: MIN_PIECES_FOR_RECOMMENDATION,
    samples_count: scoped.length,
    clean_samples_count: cleanItems.length,
    assisted_samples_count: assistedItems.length,
    fastest_max_out_pct: FASTEST_MAX_OUT_PCT,
    speeds,
    assisted_speeds: assistedSpeeds,
    recommended,
    fastest,
    by_batch: groupBy((it) => it.paste_batch || null, 'paste_batch'),
    by_moisture: groupBy((it) => it.paste_moisture_level || null, 'paste_moisture_level'),
    by_pressure: byPressure,
    by_dough_temp: byDoughTemp,
    machines: comparison,
  });
});

module.exports = router;
module.exports._test = {
  weightStats, readWeights, groupStats, pressureMix, isCleanSample, readDecimal, readCount,
  WEIGHT_MIN, WEIGHT_MAX, WARN_MARGIN, PRESSURE_LEVELS, INTERVENTION_KINDS,
};
