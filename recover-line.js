// أداة فحص واسترجاع خط إنتاج حُذف بالخطأ (وبياناته: معدات، بلاغات أعطال، أوامر صيانة، باتشات).
//
// لماذا البيانات غالبًا موجودة؟ حذف الخط من قاعدة البيانات لا يحذف الباتشات/البلاغات/
// أوامر الصيانة/المعدات المرتبطة به — فقط يمسح عمود "line_id" منها (ON DELETE SET NULL).
// فتختفي من شاشات الخطوط لأنها لم تعد مربوطة بأي خط، لكنها ما زالت في الجداول.
//
// الاستخدام (من مجلد السيرفر، عبر نافذة cmd):
//   node recover-line.js                              ← فحص فقط (للقراءة فقط، لا يغيّر شيئًا) ويكتب تقريرًا في
//                                                        recover-line-report.txt
//   node recover-line.js restore --xid=N --line=ID    ← الاسترجاع: يربط صفوف الخط المحذوف (التي رقم عملية حذفها N)
//                                                        بالخط الحالي رقم ID. يضيف اختياريًا:
//                                                        --rename="line 8"  --location="مصنع الرجال"  --code=LINE-08  --dry (تجربة بلا حفظ)
//   node recover-line.js undo recover-line-backup-....json  ← تراجع عن عملية استرجاع سابقة
'use strict';
const fs = require('fs');
const path = require('path');
require('./lib/loadEnv').loadEnv(path.join(__dirname, '.env'));
const { pool } = require('./config/db');

const REPORT_FILE = path.join(__dirname, 'recover-line-report.txt');
const reportLines = [];
function out(s = '') {
  console.log(s);
  reportLines.push(String(s));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) args[a.slice(2)] = true;
      else args[a.slice(2, eq)] = a.slice(eq + 1);
    } else args._.push(a);
  }
  return args;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const DEL_RULES = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE (يحذف الصفوف!)', n: 'SET NULL (يفكّ الارتباط فقط)', d: 'SET DEFAULT' };

// عيّنة نصية قصيرة من كل جدول لمساعدتنا على فهم محتوى كل مجموعة صفوف
const SAMPLE_EXPR = {
  equipment: `name`,
  incident_reports: `description`,
  work_orders: `description`,
  production_batches: `coalesce(batch_number, '') || ' / ' || coalesce(product_name, '')`,
};

async function discoverRefs(run) {
  const rows = (
    await run(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS del
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'production_lines'::regclass
        ORDER BY 1, 2`,
    )
  ).rows;
  return rows.filter((r) => IDENT.test(r.tbl) && IDENT.test(r.col));
}

// ----- فك ترميز صف قديم (محذوف) من سجلات PostgreSQL الداخلية -----
function decodeText(b) {
  const h = b[0];
  if (h & 1) {
    if (h === 1) return '<toast>';
    return b.slice(1, h >> 1).toString('utf8');
  }
  const w = b.readUInt32LE(0);
  if ((w & 3) === 2) return '<compressed>';
  return b.slice(4, w >>> 2).toString('utf8');
}
function decodeAttr(hex, typid) {
  if (hex === 'NULL') return null;
  const b = Buffer.from(hex, 'hex');
  try {
    switch (typid) {
      case 20: return b.readBigInt64LE(0).toString();
      case 23: return b.readInt32LE(0);
      case 21: return b.readInt16LE(0);
      case 16: return b[0] !== 0;
      case 25: case 1043: case 1042: return decodeText(b);
      case 1184: case 1114: return new Date(Number(b.readBigInt64LE(0) / 1000n) + Date.UTC(2000, 0, 1)).toISOString();
      default: return `<نوع ${typid}: ${hex.slice(0, 24)}>`;
    }
  } catch (e) {
    return `<تعذّر الفك: ${hex.slice(0, 24)}>`;
  }
}

async function inspect() {
  out('==================== فحص خط الإنتاج المحذوف (للقراءة فقط) ====================');
  out(`وقت الفحص: ${new Date().toISOString()}`);
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  const info = (await q(`SELECT version() AS v, current_database() AS db, current_user AS usr,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, pg_postmaster_start_time()::text AS started`))[0];
  out(`قاعدة البيانات: ${info.db} | المستخدم: ${info.usr} | مدير عام: ${info.su} | بدأ التشغيل: ${info.started}`);
  out(String(info.v).slice(0, 60));

  // 1) الخطوط الحالية
  out('\n[1] الخطوط الموجودة الآن في قاعدة البيانات:');
  const curLines = await q('SELECT id, name, location, active, created_at::text AS created_at FROM production_lines ORDER BY id');
  for (const l of curLines) out(`  رقم ${l.id} | الاسم: "${l.name}" | الموقع: ${l.location} | نشط: ${l.active} | أُنشئ: ${l.created_at}`);

  // 2) قواعد الحذف للجداول المرتبطة
  out('\n[2] الجداول المرتبطة بالخط وقاعدة الحذف الفعلية في قاعدتك:');
  const refs = await discoverRefs((s, p) => pool.query(s, p));
  for (const r of refs) out(`  ${r.tbl}.${r.col} → ${DEL_RULES[r.del] || r.del}`);
  const lineCols = await q(
    `SELECT table_name::text AS tbl, column_name::text AS col FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('line_id', 'production_line_id') ORDER BY 1`,
  );
  const refKey = new Set(refs.map((r) => `${r.tbl}.${r.col}`));
  const noFk = lineCols.filter((c) => !refKey.has(`${c.tbl}.${c.col}`) && IDENT.test(c.tbl) && IDENT.test(c.col));
  for (const c of noFk) {
    out(`  (بدون قيد ربط) ${c.tbl}.${c.col}`);
    const orphans = await q(
      `SELECT ${c.col} AS lid, count(*)::int AS n FROM ${c.tbl}
        WHERE ${c.col} IS NOT NULL AND ${c.col} NOT IN (SELECT id FROM production_lines) GROUP BY 1`,
    );
    for (const o of orphans) out(`     ⚠ ${o.n} صف يشير إلى خط رقم ${o.lid} غير موجود`);
  }

  // 3) مجموعات الصفوف "اليتيمة" (line_id فارغ) مجمّعة برقم العملية التي أفرغتها
  out('\n[3] الصفوف التي أصبح line_id فيها فارغًا، مجمّعة بحسب رقم العملية (xid):');
  out('    (كل عملية حذف خط تترك مجموعة واحدة بنفس الرقم)');
  const groups = {}; // xid -> { tbl: n }
  for (const r of refs) {
    const total = (await q(`SELECT count(*)::int AS n FROM ${r.tbl}`))[0].n;
    const nulls = (await q(`SELECT count(*)::int AS n FROM ${r.tbl} WHERE ${r.col} IS NULL`))[0].n;
    out(`  ${r.tbl}: المجموع ${total} | بدون خط ${nulls}`);
    const gs = await q(
      `SELECT xmin::text AS xid, count(*)::int AS n, min(id) AS min_id, max(id) AS max_id
         FROM ${r.tbl} WHERE ${r.col} IS NULL GROUP BY xmin::text ORDER BY count(*) DESC`,
    );
    for (const g of gs) {
      groups[g.xid] = groups[g.xid] || {};
      groups[g.xid][r.tbl] = g.n;
      let sampleTxt = '';
      const expr = SAMPLE_EXPR[r.tbl];
      if (expr) {
        const sm = await q(
          `SELECT left(${expr}, 60) AS s FROM ${r.tbl} WHERE ${r.col} IS NULL AND xmin::text = $1::text ORDER BY id LIMIT 3`,
          [g.xid],
        );
        sampleTxt = ' | أمثلة: ' + sm.map((x) => `«${x.s}»`).join(' ، ');
      }
      out(`     عملية ${g.xid}: ${g.n} صف (ids ${g.min_id}..${g.max_id})${sampleTxt}`);
    }
  }

  // 4) إحصاءات التنظيف التلقائي (autovacuum) — هو الذي قد يمسح الصفوف القديمة نهائيًا
  out('\n[4] حالة التنظيف التلقائي (تأثيره على إمكانية قراءة الخط المحذوف):');
  const names = ['production_lines', ...refs.map((r) => r.tbl)];
  const stat = await q(
    `SELECT relname::text AS t, n_live_tup::int AS live, n_dead_tup::int AS dead,
            coalesce(last_vacuum::text, '-') AS lv, coalesce(last_autovacuum::text, '-') AS lav
       FROM pg_stat_user_tables WHERE relname = ANY ($1::text[]) ORDER BY 1`,
    [Array.from(new Set(names))],
  );
  for (const s of stat) out(`  ${s.t}: حيّة ${s.live} | ميتة ${s.dead} | آخر vacuum: ${s.lv} | آخر autovacuum: ${s.lav}`);

  // 5) قراءة الخط المحذوف من سجلات PostgreSQL الداخلية (pageinspect) داخل معاملة تُلغى في النهاية
  out('\n[5] محاولة قراءة بيانات الخط المحذوف نفسه (اسمه وموقعه) من سجلات قاعدة البيانات الداخلية:');
  const cols = await q(
    `SELECT attnum::int AS n, attname::text AS name, atttypid::int AS typid, attisdropped AS dropped
       FROM pg_attribute WHERE attrelid = 'production_lines'::regclass AND attnum > 0 ORDER BY attnum`,
  );
  const client = await pool.connect();
  let deleted = [];
  let extOk = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pageinspect');
      extOk = true;
    } catch (e) {
      out(`  ⚠ تعذّر تفعيل أداة الفحص الداخلية pageinspect: ${e.message}`);
      await client.query('ROLLBACK');
    }
    if (extOk) {
      const tuples = (
        await client.query(
          `SELECT g.pg::int AS pg, i.lp::int AS lp, i.t_xmin::text AS xmin, i.t_xmax::text AS xmax, i.t_ctid::text AS ctid,
                  i.t_infomask::int AS im, i.t_infomask2::int AS im2,
                  (SELECT string_agg(coalesce(encode(a, 'hex'), 'NULL'), ',' ORDER BY ord)
                     FROM unnest(i.t_attrs) WITH ORDINALITY AS u(a, ord)) AS attrs
             FROM generate_series(0, greatest(pg_relation_size('production_lines'::regclass) / 8192 - 1, 0)) AS g(pg),
                  LATERAL heap_page_item_attrs(get_raw_page('production_lines', g.pg::int), 'production_lines'::regclass) AS i
            WHERE i.lp_flags = 1`,
        )
      ).rows;
      out(`  عدد النسخ المخزّنة للصفوف في جدول الخطوط (حيّة + قديمة): ${tuples.length}`);
      for (const t of tuples) {
        const xmaxSet = t.xmax !== '0' && (t.im & 0x0800) === 0 && (t.im & 0x0080) === 0;
        const selfCtid = t.ctid === `(${t.pg},${t.lp})`;
        const state = !xmaxSet ? 'حيّ' : selfCtid ? 'محذوف' : 'نسخة قديمة بعد تعديل';
        const parts = String(t.attrs).split(',');
        const rec = {};
        cols.forEach((c, idx) => {
          if (!c.dropped && parts[idx] !== undefined) rec[c.name] = decodeAttr(parts[idx], c.typid);
        });
        const row = { state, xmin: t.xmin, xmax: t.xmax, rec };
        if (state === 'محذوف') deleted.push(row);
        out(`  [${state}] ${JSON.stringify(rec)}${xmaxSet ? ` | رقم عملية الحذف/التعديل (xmax): ${t.xmax}` : ''}`);
      }

      // عدّ النسخ القديمة في الجداول المرتبطة لكل عملية حذف مرشّحة
      const xids = new Set(deleted.map((d) => d.xmax));
      for (const xid of xids) {
        out(`\n  — الصفوف التي كانت مرتبطة بالخط وقت العملية ${xid} (عدد النسخ القديمة المتبقية):`);
        for (const r of refs) {
          const n = (
            await client.query(
              `SELECT count(*)::int AS n
                 FROM generate_series(0, greatest(pg_relation_size($1::regclass) / 8192 - 1, 0)) AS g(pg),
                      LATERAL heap_page_items(get_raw_page($2::text, g.pg::int)) AS i
                WHERE i.lp_flags = 1 AND i.t_xmax::text = $3::text AND (i.t_infomask & 2048) = 0 AND (i.t_infomask & 128) = 0`,
              [r.tbl, r.tbl, xid],
            )
          ).rows[0].n;
          const live = (groups[xid] && groups[xid][r.tbl]) || 0;
          out(`     ${r.tbl}: نسخ قديمة ${n} | صفوف حيّة بدون خط من نفس العملية ${live}${r.del === 'c' ? ' | ⚠ هذه الجدول CASCADE: الصفوف حُذفت فعليًا' : ''}`);
        }
      }
    }
  } catch (e) {
    out(`  ⚠ خطأ أثناء القراءة الداخلية: ${e.message}`);
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) { /* لا شيء */ }
    client.release();
  }

  if (!extOk) {
    out('  محاولة بديلة: قراءة نصوص ملف الجدول مباشرة...');
    try {
      const raw = (await q(`SELECT encode(pg_read_binary_file(pg_relation_filepath('production_lines')), 'hex') AS h`))[0].h;
      const txt = Buffer.from(raw, 'hex').toString('utf8');
      const found = Array.from(new Set(txt.match(/[\p{L}\p{N}][\p{L}\p{N} _\-.]{1,40}/gu) || [])).slice(0, 80);
      out(`  نصوص موجودة بملف الجدول: ${JSON.stringify(found)}`);
    } catch (e) {
      out(`  ⚠ تعذّرت القراءة البديلة: ${e.message}`);
    }
  }

  // 6) الخلاصة
  out('\n==================== الخلاصة ====================');
  if (deleted.length) {
    for (const d of deleted) {
      const g = groups[d.xmax] || {};
      out(`خط محذوف: رقم ${d.rec.id} | "${d.rec.name}" | ${d.rec.location} | عملية الحذف ${d.xmax}`);
      out(`  صفوف يمكن إعادة ربطها: ${JSON.stringify(g)}`);
    }
  } else {
    out('لم أجد الخط المحذوف نفسه في السجلات الداخلية (ربما نُظّفت)، لكن مجموعات الصفوف اليتيمة أعلاه تدل عليه.');
  }
  out('انتهى الفحص. لم يتغيّر أي شيء في قاعدة البيانات.');
  fs.writeFileSync(REPORT_FILE, reportLines.join('\n') + '\n', 'utf8');
  console.log(`\n(حُفظ التقرير الكامل في الملف: ${REPORT_FILE})`);
}

// ---------------------------------------------------------------------------
async function restore(args) {
  const xid = String(args.xid || '');
  const lineId = String(args.line || '');
  if (!/^\d+$/.test(xid) || !/^\d+$/.test(lineId)) {
    throw new Error('الصيغة: node recover-line.js restore --xid=رقم_العملية --line=رقم_الخط_الحالي');
  }
  const refs = (await discoverRefs((s, p) => pool.query(s, p))).filter((r) => r.del === 'n');
  const client = await pool.connect();
  const dry = !!args.dry;
  try {
    await client.query('BEGIN');
    const line = (await client.query('SELECT id, name, location FROM production_lines WHERE id = $1::bigint', [lineId])).rows[0];
    if (!line) throw new Error(`لا يوجد خط حالي برقم ${lineId}`);
    out(`الخط المستهدف: رقم ${line.id} | "${line.name}" | ${line.location}`);

    const plan = {};
    for (const r of refs) {
      const ids = (
        await client.query(`SELECT id FROM ${r.tbl} WHERE ${r.col} IS NULL AND xmin::text = $1::text ORDER BY id`, [xid])
      ).rows.map((x) => x.id);
      plan[`${r.tbl}.${r.col}`] = ids;
    }
    const total = Object.values(plan).reduce((s, a) => s + a.length, 0);
    if (total === 0) throw new Error(`لا توجد صفوف بدون خط لهذه العملية (${xid}) — لن أغيّر شيئًا`);

    // نسخة احتياطية بأرقام الصفوف قبل أي تعديل (للتراجع)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backupFile = path.join(__dirname, `recover-line-backup-${stamp}.json`);
    const backup = { lineId, xid, tables: { ...plan }, chain: {} };

    for (const r of refs) {
      const key = `${r.tbl}.${r.col}`;
      const ids = plan[key];
      if (!ids.length) { out(`  ${r.tbl}: 0`); continue; }
      await client.query(`UPDATE ${r.tbl} SET ${r.col} = $1::bigint WHERE ${r.col} IS NULL AND id = ANY ($2::bigint[])`, [lineId, ids]);
      out(`  ${r.tbl}: أُعيد ربط ${ids.length} صف`);
    }

    // مرور ثانٍ: صفوف عُدّلت بعد الحذف فاختلف رقم عمليتها، تُربط عبر المعدة/البلاغ المرتبط بالخط
    const chainSteps = [
      ['incident_reports', 'معدة الخط', `UPDATE incident_reports SET line_id = $1::bigint WHERE line_id IS NULL AND equipment_id IN (SELECT id FROM equipment WHERE line_id = $1::bigint) RETURNING id`],
      ['work_orders', 'معدة الخط', `UPDATE work_orders SET line_id = $1::bigint WHERE line_id IS NULL AND equipment_id IN (SELECT id FROM equipment WHERE line_id = $1::bigint) RETURNING id`],
      ['work_orders', 'بلاغ الخط', `UPDATE work_orders SET line_id = $1::bigint WHERE line_id IS NULL AND incident_report_id IN (SELECT id FROM incident_reports WHERE line_id = $1::bigint) RETURNING id`],
    ];
    for (const [tbl, why, sql] of chainSteps) {
      try {
        await client.query('SAVEPOINT chain_step');
        const rows = (await client.query(sql, [lineId])).rows;
        await client.query('RELEASE SAVEPOINT chain_step');
        if (rows.length) {
          out(`  ${tbl}: ${rows.length} صف إضافي ربطته عبر ${why}`);
          backup.chain[tbl] = (backup.chain[tbl] || []).concat(rows.map((x) => x.id));
        }
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT chain_step');
        out(`  (تخطّيت خطوة ${tbl}: ${e.message})`);
      }
    }

    if (args.rename || args.location || args.code) {
      const sets = []; const vals = [lineId]; const shown = [];
      if (args.rename && args.rename !== true) { vals.push(String(args.rename)); sets.push(`name = $${vals.length}`); shown.push(`الاسم ← "${args.rename}"`); }
      if (args.location && args.location !== true) { vals.push(String(args.location)); sets.push(`location = $${vals.length}`); shown.push(`الموقع ← "${args.location}"`); }
      if (args.code && args.code !== true) { vals.push(String(args.code)); sets.push(`code = $${vals.length}`); shown.push(`الكود ← "${args.code}"`); }
      if (sets.length) {
        await client.query(`UPDATE production_lines SET ${sets.join(', ')} WHERE id = $1::bigint`, vals);
        out(`  تم تعديل بيانات الخط: ${shown.join(' ، ')}`);
      }
    }

    if (dry) {
      await client.query('ROLLBACK');
      out('\n(تجربة فقط --dry: لم يُحفظ أي تغيير)');
    } else {
      fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1), 'utf8');
      await client.query('COMMIT');
      out(`\n✅ تم الاسترجاع وحُفظت التغييرات. ملف التراجع: ${path.basename(backupFile)}`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* لا شيء */ }
    throw e;
  } finally {
    client.release();
  }
  fs.writeFileSync(path.join(__dirname, 'recover-line-report.txt'), reportLines.join('\n') + '\n', 'utf8');
}

async function undo(args) {
  const file = args._[1];
  if (!file) throw new Error('الصيغة: node recover-line.js undo اسم_ملف_التراجع.json');
  const backup = JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf8').replace(/^﻿/, ''));
  const refs = await discoverRefs((s, p) => pool.query(s, p));
  const colOf = {};
  for (const r of refs) colOf[r.tbl] = r.col;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, ids] of Object.entries(backup.tables || {})) {
      const tbl = key.split('.')[0];
      if (!ids.length || !IDENT.test(tbl) || !colOf[tbl]) continue;
      const rows = (await client.query(`UPDATE ${tbl} SET ${colOf[tbl]} = NULL WHERE ${colOf[tbl]} = $1::bigint AND id = ANY ($2::bigint[]) RETURNING id`, [backup.lineId, ids])).rows;
      out(`  ${tbl}: تراجعت عن ${rows.length} صف`);
    }
    for (const [tbl, ids] of Object.entries(backup.chain || {})) {
      if (!ids.length || !IDENT.test(tbl) || !colOf[tbl]) continue;
      const rows = (await client.query(`UPDATE ${tbl} SET ${colOf[tbl]} = NULL WHERE ${colOf[tbl]} = $1::bigint AND id = ANY ($2::bigint[]) RETURNING id`, [backup.lineId, ids])).rows;
      out(`  ${tbl} (إضافي): تراجعت عن ${rows.length} صف`);
    }
    await client.query('COMMIT');
    out('✅ تم التراجع.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* لا شيء */ }
    throw e;
  } finally {
    client.release();
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0] || 'inspect';
  if (mode === 'inspect') await inspect();
  else if (mode === 'restore') await restore(args);
  else if (mode === 'undo') await undo(args);
  else throw new Error(`أمر غير معروف: ${mode}`);
  process.exit(0);
})().catch((err) => {
  console.error('\nفشلت العملية:', err.message || err);
  try { fs.writeFileSync(REPORT_FILE, reportLines.join('\n') + `\nفشلت العملية: ${err.message || err}\n`, 'utf8'); } catch (_) { /* لا شيء */ }
  process.exit(1);
});
