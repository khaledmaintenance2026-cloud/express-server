// أداة فحص (للقراءة فقط — لا تغيّر ولا تحذف شيئًا): تكشف الحسابات التي تشترك في نفس رقم الجوال،
// وتبيّن لكل حساب: الاسم والبريد والدور والحالة ومتى سُجّل، وكم سجلًا مرتبطًا به في النظام
// (أوامر عمل، بلاغات، تصاريح، باتشات...)، وهل هو مربوط بسجل فني — حتى تعرف أيها تحذف وأيها تُبقي.
//
// تكتب النتيجة على الشاشة وفي الملف duplicate-phones-report.txt بجانب هذا الملف.
//
// الاستخدام (من مجلد السيرفر، عبر نافذة cmd):
//   node check-duplicate-phones.js
'use strict';
const fs = require('fs');
const path = require('path');
require('./lib/loadEnv').loadEnv(path.join(__dirname, '.env'));
const { pool } = require('./config/db');
const { phoneKey } = require('./lib/phoneAuth');

const REPORT_FILE = path.join(__dirname, 'duplicate-phones-report.txt');
const lines = [];
function out(s = '') {
  console.log(s);
  lines.push(String(s));
}

const ROLE_LABELS = {
  admin: 'مدير النظام', maintenance_manager: 'مسؤول صيانة', maintenance_technician: 'فني صيانة', production: 'إنتاج',
  production_manager: 'مسؤول إنتاج', safety: 'سلامة', contractor: 'مقاول', general: 'قسم عام',
  inventory_manager: 'مسؤول مخزون', designer: 'مصمم',
};
const STATUS_LABELS = { approved: 'معتمد', pending: 'بانتظار الاعتماد', revoked: 'ملغى' };
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');

// كل الجداول/الأعمدة التي تشير لجدول users (لحساب نشاط كل حساب). أعمدة CASCADE (مثل
// الإشعارات) لا تُعدّ نشاطًا لأنها تُحذف مع الحساب ولا تفقد شيئًا مهمًا.
async function referencingColumns() {
  const { rows } = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS del
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`
  );
  return rows.filter((r) => r.del !== 'c' && /^[a-z_][a-z0-9_.]*$/i.test(r.tbl) && /^[a-z_][a-z0-9_]*$/i.test(r.col));
}

async function activityOf(userId, refs) {
  const parts = [];
  let total = 0;
  for (const r of refs) {
    try {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${r.tbl} WHERE ${r.col} = $1`, [userId]);
      const n = Number(rows[0].n) || 0;
      if (n > 0) { parts.push(`${r.tbl.replace(/^public\./, '')}.${r.col}=${n}`); total += n; }
    } catch (_) { /* جدول غير متاح — نتجاهله */ }
  }
  let assignments = 0;
  try {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM work_order_technicians wot JOIN technicians t ON t.id = wot.technician_id WHERE t.user_id = $1',
      [userId]
    );
    assignments = Number(rows[0].n) || 0;
  } catch (_) { /* لا جدول */ }
  if (assignments > 0) { parts.push(`مهام مُسنَدة له كفني=${assignments}`); total += assignments; }
  return { total, detail: parts.join('، ') };
}

(async () => {
  out('فحص الحسابات المشتركة في رقم الجوال — للقراءة فقط، لا يتغير شيء في النظام');
  out(`وقت الفحص: ${fmt(new Date())}`);
  out('');
  const { rows: users } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.phone, u.created_at, u.updated_at,
            (u.google_sub IS NOT NULL) AS has_google,
            (SELECT t.id FROM technicians t WHERE t.user_id = u.id LIMIT 1) AS technician_id
       FROM users u ORDER BY u.id`
  );
  out(`عدد كل الحسابات: ${users.length}`);
  const withPhone = users.filter((u) => phoneKey(u.phone));
  out(`حسابات لها رقم جوال صالح: ${withPhone.length} | بلا رقم أو برقم غير صالح: ${users.length - withPhone.length}`);
  out('');

  const groups = new Map();
  for (const u of withPhone) {
    const k = phoneKey(u.phone);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  const dups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

  const refs = await referencingColumns();

  if (dups.length === 0) {
    out('لا توجد حسابات تشترك في نفس رقم الجوال.');
  } else {
    out(`وُجد ${dups.length} رقم/أرقام مشتركة بين أكثر من حساب:`);
    let n = 0;
    for (const [key, arr] of dups) {
      n += 1;
      out('');
      out(`==== المجموعة ${n} — الرقم المنتهي بـ ${key.slice(-4)} (${arr.length} حسابات) ====`);
      const detailed = [];
      for (const u of arr) detailed.push({ u, act: await activityOf(u.id, refs) });
      const best = detailed.reduce((a, b) => (b.act.total > a.act.total ? b : a), detailed[0]);
      for (const { u, act } of detailed) {
        const keep = u.id === best.u.id && act.total > 0 ? '   ← الأكثر نشاطًا (الأنسب للإبقاء)' : '';
        out(`  [رقم الحساب ${u.id}] ${u.name}${keep}`);
        out(`     البريد: ${u.email}${u.has_google ? ' (مربوط بجوجل)' : ''}`);
        out(`     الجوال المسجَّل: ${u.phone}`);
        out(`     الدور: ${ROLE_LABELS[u.role] || u.role} | الحالة: ${STATUS_LABELS[u.status] || u.status}`);
        out(`     سُجّل: ${fmt(u.created_at)} | آخر تعديل: ${fmt(u.updated_at)}`);
        out(`     مربوط بسجل فني: ${u.technician_id ? `نعم (فني رقم ${u.technician_id})` : 'لا'}`);
        out(`     السجلات المرتبطة به: ${act.total}${act.detail ? ` — ${act.detail}` : ''}`);
      }
      const idle = detailed.filter((d) => d.act.total === 0 && !d.u.technician_id);
      if (idle.length > 0 && idle.length < detailed.length) {
        out(`  >> بلا أي نشاط ولا ربط بفني (أقل خطرًا عند الحذف): ${idle.map((d) => `${d.u.id} (${d.u.name})`).join('، ')}`);
      } else if (idle.length === detailed.length) {
        out('  >> كل الحسابات بلا نشاط — احذف المكرر حسب الاسم/تاريخ التسجيل.');
      } else {
        out('  >> أكثر من حساب له نشاط — لا تحذف قبل المراجعة (الحذف يفكّ ارتباط سجلاته باسم صاحبها).');
      }
    }
  }

  // أسماء متطابقة بأرقام مختلفة (غالبًا مستخدم سجّل مرة ثانية بعد نسيان كلمة المرور)
  const byName = new Map();
  for (const u of users) {
    const nm = String(u.name || '').trim().replace(/\s+/g, ' ');
    if (!nm) continue;
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push(u);
  }
  const sameName = [...byName.entries()].filter(([, arr]) => arr.length > 1 && new Set(arr.map((u) => phoneKey(u.phone) || `x${u.id}`)).size > 1);
  if (sameName.length > 0) {
    out('');
    out('==== أسماء متطابقة بأرقام جوال مختلفة (للعلم فقط — قد يكون نفس الشخص سجّل مرتين) ====');
    for (const [nm, arr] of sameName) {
      out(`  ${nm}: ` + arr.map((u) => `[${u.id}] ${u.phone || 'بلا رقم'} / ${u.email} / ${STATUS_LABELS[u.status] || u.status}`).join('  |  '));
    }
  }

  out('');
  out('انتهى الفحص. لم يُحذف أو يُعدَّل أي شيء.');
  fs.writeFileSync(REPORT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`\nحُفظ التقرير في: ${REPORT_FILE}`);
  process.exit(0);
})().catch((err) => {
  console.error('فشل الفحص:', err && err.message ? err.message : err);
  try { fs.writeFileSync(REPORT_FILE, `فشل الفحص: ${err && err.stack ? err.stack : err}\n`, 'utf8'); } catch (_) {}
  process.exit(1);
});
