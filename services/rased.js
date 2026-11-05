'use strict';
/**
 * ربط صيانتي مع نظام «راصد» (تصاريح العمل لقسم السلامة).
 *
 *   صيانتي ──(طلب تصريح)──▶ راصد ──(اعتماد / رفض / إغلاق / إيقاف)──▶ صيانتي
 *
 * - الإرسال: كل تصريح جديد (من التطبيق أو من المقاول عبر QR) يُرسَل من السيرفر
 *   إلى دالة permit_inbound في راصد. المفتاحان السريان (rased_key للإرسال،
 *   rased_secret للتحقق من الرد) يُحفظان في site_settings من لوحة الويب ←
 *   إعدادات الموقع ← "ربط راصد"، ولا يظهران لغير المدير (راجع routes/settings.js).
 * - الاستقبال: routes/rasedIntegration.js (POST /api/integrations/rased/status)
 *   يستدعي applyRasedStatus هنا.
 * - الاعتماد بعد الربط في راصد فقط: التصريح المسجَّل في راصد (له rased_ref_no) لا
 *   يُراجَع من داخل التطبيق (راجع PATCH /:id/review في routes/safetyPermits.js).
 * - حالات صيانتي (pending/approved/rejected) لم تتغير حتى لا ينكسر تطبيق الجوال:
 *     approved  → approved
 *     rejected  → rejected
 *     cancelled → rejected (سبب الرفض يبدأ بـ "أُوقف التصريح من قسم السلامة")
 *     closed    → تبقى approved ويُسجَّل rased_status = 'closed' وملاحظة الإغلاق
 *   والحالة الأصلية من راصد محفوظة دائمًا في العمود rased_status.
 * - أعمدة rased_* تُنشأ تلقائيًا عند تشغيل السيرفر (ensureSchema) — لا ترحيل يدوي.
 */

const { pool } = require('../config/db');
const { withLock } = require('../lib/keyedLock');

// عنوان راصد ومفتاح apikey العام (anon) من ملف الربط — مفتاح عام عادي يظهر في أي
// تطبيق، والسرّ الحقيقي هو rased_key. يمكن تجاوزهما من site_settings (rased_api_url
// / rased_apikey) لو غيّرهما فريق راصد يومًا بلا تعديل الكود.
const DEFAULT_API_URL = 'https://aaceqzitawcailracbvk.supabase.co/rest/v1/rpc/permit_inbound';
const DEFAULT_APIKEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhY2Vxeml0YXdjYWlscmFjYnZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNjQyNzksImV4cCI6MjEwNzY0MDI3OX0.b9ZV0tenhpBfqqL10nI-_W5Lkn8yqm_TWemXfgS30r0';

const SEND_TIMEOUT_MS = Number(process.env.RASED_TIMEOUT_MS) || 15000; // قابل للضبط للاختبار فقط
const MAX_ATTEMPTS = 12; // محاولات الإرسال التلقائية لكل تصريح (كل ٥ دقائق ≈ ساعة)
const RETRY_EVERY_MS = 5 * 60 * 1000;
const RETRY_SPACING_MIN = 4;
const RETRY_WINDOW_DAYS = 3;

// أنواع العمل في صيانتي ← رموز راصد.
const TYPE_MAP = {
  hot_work: 'hot',
  confined_space: 'confined',
  height: 'height',
  electrical: 'electrical',
  excavation: 'excavation',
  lifting: 'lifting',
  other: 'general',
};

// ───────────────────────── المخطط (أعمدة جديدة) ─────────────────────────
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(
        `ALTER TABLE safety_permits
           ADD COLUMN IF NOT EXISTS rased_queued          BOOLEAN NOT NULL DEFAULT false,
           ADD COLUMN IF NOT EXISTS rased_ref_no          TEXT,
           ADD COLUMN IF NOT EXISTS rased_id              TEXT,
           ADD COLUMN IF NOT EXISTS rased_status          TEXT,
           ADD COLUMN IF NOT EXISTS rased_sent_at         TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rased_attempts        INT NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS rased_last_attempt_at TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rased_error           TEXT,
           ADD COLUMN IF NOT EXISTS rased_review_note     TEXT,
           ADD COLUMN IF NOT EXISTS rased_valid_from      TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rased_valid_until     TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rased_pdf_url         TEXT,
           ADD COLUMN IF NOT EXISTS rased_closed_at       TIMESTAMPTZ,
           ADD COLUMN IF NOT EXISTS rased_closed_note     TEXT,
           ADD COLUMN IF NOT EXISTS rased_updated_at      TIMESTAMPTZ`
      )
      .catch((err) => {
        schemaPromise = null; // يُعاد المحاولة لاحقًا
        console.error('[rased] تعذّر تجهيز أعمدة الربط:', err.message);
        throw err;
      });
  }
  return schemaPromise;
}

// ───────────────────────── الإعدادات ─────────────────────────
async function getSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM site_settings
      WHERE key IN ('rased_enabled','rased_key','rased_secret','rased_api_url','rased_apikey','public_base_url')`
  );
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    enabled: s.rased_enabled === 'true' && !!(s.rased_key && s.rased_key.trim()),
    flagOn: s.rased_enabled === 'true',
    key: (s.rased_key || '').trim(),
    secret: (s.rased_secret || '').trim(),
    apiUrl: (s.rased_api_url || '').trim() || DEFAULT_API_URL,
    apikey: (s.rased_apikey || '').trim() || DEFAULT_APIKEY,
    publicBaseUrl: (s.public_base_url || '').trim().replace(/\/+$/, ''),
  };
}

// ───────────────────────── بناء الطلب ─────────────────────────
function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clean(v, max = 2000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function httpsUrlOrNull(v) {
  const s = clean(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

async function buildPayload(permit, cfg) {
  const types = (Array.isArray(permit.operation_types) ? permit.operation_types : [])
    .map((t) => TYPE_MAP[t] || 'general')
    .filter((t, i, a) => a.indexOf(t) === i);

  let task = null;
  if (permit.related_work_order_id) {
    try {
      const { rows } = await pool.query(
        `SELECT wo.description, COALESCE(wo.equipment_name, e.name) AS equipment_name, wo.equipment_code, wo.facility
           FROM work_orders wo LEFT JOIN equipment e ON e.id = wo.equipment_id WHERE wo.id = $1`,
        [permit.related_work_order_id]
      );
      task = rows[0] || null;
    } catch (err) {
      console.error('[rased] تعذّر جلب أمر العمل المرتبط:', err.message);
    }
  }

  const notes = [];
  if (task) {
    notes.push(
      `مرتبط بأمر عمل صيانة رقم ${permit.related_work_order_id}: ${task.description || ''}` +
        `${task.equipment_name ? ` — المعدة: ${task.equipment_name}` : ''}` +
        `${task.equipment_code ? ` (${task.equipment_code})` : ''}`
    );
  }

  const attachments = [];
  if (permit.equipment_photo && cfg.publicBaseUrl && /^https:\/\//i.test(cfg.publicBaseUrl)) {
    attachments.push(`${cfg.publicBaseUrl}${permit.equipment_photo}`);
  }

  const isQrContractor = /\(مقاول عبر QR\)\s*$/.test(permit.requested_by || '');
  const description = clean(permit.description, 4000) || '';
  const payload = {
    external_id: String(permit.id),
    external_ref: `SP-${permit.id}`,
    title: description.split('\n')[0].slice(0, 150),
    description,
    types,
    location: clean(permit.location, 300),
    equipment: clean(permit.equipment_used, 500),
    requester_name: clean(permit.requested_by, 200),
    requester_phone: clean(permit.responsible_phone, 40),
    workers_count: Number(permit.workers_count) || 1,
    start_at: toIso(permit.start_at),
    end_at: toIso(permit.end_at),
    notes: notes.join('\n') || null,
    attachments,
    office_name: clean(permit.office_name, 200),
    requested_at: toIso(permit.requested_at),
    source_system: 'sayanati',
  };
  if (isQrContractor) payload.contractor = clean(permit.office_name, 200);
  if (permit.related_work_order_id) payload.work_order_id = String(permit.related_work_order_id);
  // لا نرسل حقولًا فارغة
  for (const k of Object.keys(payload)) {
    if (payload[k] === null || payload[k] === undefined || (Array.isArray(payload[k]) && payload[k].length === 0)) {
      delete payload[k];
    }
  }
  return payload;
}

// ───────────────────────── الإرسال إلى راصد ─────────────────────────
async function postToRased(cfg, permitPayload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { apikey: cfg.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: cfg.key, p_permit: permitPayload }),
      signal: ctrl.signal,
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { /* نص غير JSON */ }
    return { httpOk: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/// يرسل تصريحًا واحدًا لراصد (آمن للاستدعاء المتكرر). لا يرمي أبدًا.
async function sendPermit(permitId, { force = false } = {}) {
  try {
    await ensureSchema();
    return await withLock(`rased-send:${permitId}`, async () => {
      const cfg = await getSettings();
      if (!cfg.enabled) return { skipped: 'disabled' };
      const { rows } = await pool.query('SELECT * FROM safety_permits WHERE id = $1', [permitId]);
      const permit = rows[0];
      if (!permit) return { skipped: 'missing' };
      if (permit.rased_ref_no) return { skipped: 'already-sent', refNo: permit.rased_ref_no };
      if (permit.status !== 'pending' && !force) return { skipped: 'already-decided' };

      let failure = null;
      try {
        const payload = await buildPayload(permit, cfg);
        const r = await postToRased(cfg, payload);
        const refNo = r.data && (r.data.ref_no || (Array.isArray(r.data) && r.data[0] && r.data[0].ref_no));
        const okFlag = r.data && !Array.isArray(r.data) ? r.data.ok !== false : true;
        if (r.httpOk && refNo && okFlag) {
          const body = Array.isArray(r.data) ? r.data[0] : r.data;
          await pool.query(
            `UPDATE safety_permits SET rased_queued = true, rased_ref_no = $1, rased_id = $2,
               rased_status = COALESCE($3, 'pending'), rased_sent_at = now(), rased_error = NULL,
               rased_attempts = rased_attempts + 1, rased_last_attempt_at = now(), rased_updated_at = now()
             WHERE id = $4`,
            [String(refNo), body && body.id !== undefined ? String(body.id) : null, body && body.status ? String(body.status) : null, permit.id]
          );
          console.log(`[rased] أُرسل التصريح ${permit.id} إلى راصد — رقمه ${refNo}`);
          return { ok: true, refNo: String(refNo) };
        }
        const detail = (r.data && (r.data.message || r.data.error || r.data.hint)) || r.text || `HTTP ${r.status}`;
        failure = `HTTP ${r.status}: ${String(detail).slice(0, 300)}`;
      } catch (err) {
        failure = err && err.name === 'AbortError' ? 'انتهت مهلة الاتصال براصد' : String((err && err.message) || err).slice(0, 300);
      }
      await pool.query(
        `UPDATE safety_permits SET rased_queued = true, rased_error = $1, rased_attempts = rased_attempts + 1,
           rased_last_attempt_at = now(), rased_updated_at = now() WHERE id = $2`,
        [failure, permit.id]
      );
      console.error(`[rased] فشل إرسال التصريح ${permit.id}: ${failure}`);
      return { ok: false, error: failure };
    });
  } catch (err) {
    console.error('[rased] خطأ غير متوقع أثناء الإرسال:', err.message);
    return { ok: false, error: err.message };
  }
}

/// يُستدعى من fireWebhook عند حدث safety_permit_requested (تصريح جديد فعليًا).
async function onPermitRequested(permit) {
  try {
    await ensureSchema();
    const cfg = await getSettings();
    if (!cfg.enabled) return;
    await pool.query('UPDATE safety_permits SET rased_queued = true WHERE id = $1', [permit.id]);
    await sendPermit(permit.id);
  } catch (err) {
    console.error('[rased] onPermitRequested:', err.message);
  }
}

/// إعادة المحاولة التلقائية لما فشل إرساله (راصد متوقف مؤقتًا مثلًا).
async function retrySweep() {
  try {
    await ensureSchema();
    const cfg = await getSettings();
    if (!cfg.enabled) return;
    const { rows } = await pool.query(
      `SELECT id FROM safety_permits
        WHERE rased_queued = true AND rased_ref_no IS NULL AND status = 'pending'
          AND rased_attempts < $1
          AND requested_at > now() - interval '${RETRY_WINDOW_DAYS} days'
          AND (rased_last_attempt_at IS NULL OR rased_last_attempt_at < now() - interval '${RETRY_SPACING_MIN} minutes')
        ORDER BY id LIMIT 20`,
      [MAX_ATTEMPTS]
    );
    for (const r of rows) await sendPermit(r.id);
  } catch (err) {
    console.error('[rased] retrySweep:', err.message);
  }
}
const sweepTimer = setInterval(retrySweep, RETRY_EVERY_MS);
if (sweepTimer.unref) sweepTimer.unref();
// تجهيز الأعمدة فور تحميل الوحدة (عند تشغيل السيرفر)
ensureSchema().catch(() => {});

/// للمدير: إعادة محاولة تصريح بعينه (يصفّر عدّاد المحاولات).
async function resendPermit(permitId) {
  await ensureSchema();
  await pool.query(
    `UPDATE safety_permits SET rased_queued = true, rased_attempts = 0, rased_last_attempt_at = NULL WHERE id = $1 AND rased_ref_no IS NULL`,
    [permitId]
  );
  return sendPermit(permitId);
}

// ───────────────────────── استقبال رد راصد ─────────────────────────
/// يطبّق رد راصد على التصريح. يعيد { code, body }. آمن للتكرار (راصد قد يعيد الإرسال).
async function applyRasedStatus(input) {
  await ensureSchema();
  const b = input && typeof input === 'object' ? input : {};
  const extId = String(b.external_id === undefined || b.external_id === null ? '' : b.external_id).trim();
  if (!/^\d{1,18}$/.test(extId)) return { code: 400, body: { error: 'external_id غير صالح' } };
  const status = String(b.status || '').trim().toLowerCase();
  if (!['approved', 'rejected', 'closed', 'cancelled'].includes(status)) {
    return { code: 400, body: { error: 'status غير معروف (المتوقع approved أو rejected أو closed أو cancelled)' } };
  }

  const { rows: found } = await pool.query('SELECT * FROM safety_permits WHERE id = $1', [extId]);
  const permit = found[0];
  if (!permit) return { code: 404, body: { error: 'لا يوجد تصريح بهذا الرقم في صيانتي' } };

  const refNo = clean(b.ref_no, 60);
  if (permit.rased_ref_no && refNo && permit.rased_ref_no !== refNo) {
    return { code: 409, body: { error: 'رقم راصد لا يطابق المسجَّل لهذا التصريح' } };
  }

  const note = clean(b.review_note);
  const reviewedBy = clean(b.reviewed_by, 200) || 'قسم السلامة (راصد)';
  const reviewedAt = toIso(b.reviewed_at);
  const validFrom = toIso(b.valid_from);
  const validUntil = toIso(b.valid_until);
  const pdfUrl = httpsUrlOrNull(b.pdf_url);
  const closedAt = toIso(b.closed_at);
  const closedNote = clean(b.closed_note);

  let changed = null; // الصف بعد تغيير حالة صيانتي (يستوجب إشعارًا)
  let duplicate = false;

  if (status === 'approved') {
    const { rows } = await pool.query(
      `UPDATE safety_permits SET status = 'approved', reviewed_by = $1, reviewed_at = COALESCE($2::timestamptz, now()),
         precautions = $3, rejection_reason = NULL,
         rased_ref_no = COALESCE(rased_ref_no, $4), rased_status = 'approved',
         rased_valid_from = COALESCE($5::timestamptz, rased_valid_from), rased_valid_until = COALESCE($6::timestamptz, rased_valid_until),
         rased_pdf_url = COALESCE($7, rased_pdf_url), rased_review_note = COALESCE($3, rased_review_note), rased_updated_at = now()
       WHERE id = $8 AND status = 'pending' RETURNING *`,
      [reviewedBy, reviewedAt, note, refNo, validFrom, validUntil, pdfUrl, permit.id]
    );
    changed = rows[0] || null;
  } else if (status === 'rejected') {
    const { rows } = await pool.query(
      `UPDATE safety_permits SET status = 'rejected', reviewed_by = $1, reviewed_at = COALESCE($2::timestamptz, now()),
         rejection_reason = $3,
         rased_ref_no = COALESCE(rased_ref_no, $4), rased_status = 'rejected',
         rased_pdf_url = COALESCE($5, rased_pdf_url), rased_review_note = COALESCE($6, rased_review_note), rased_updated_at = now()
       WHERE id = $7 AND status = 'pending' RETURNING *`,
      [reviewedBy, reviewedAt, note || 'لم يُذكر سبب في راصد', refNo, pdfUrl, note, permit.id]
    );
    changed = rows[0] || null;
  } else if (status === 'cancelled') {
    const { rows } = await pool.query(
      `UPDATE safety_permits SET status = 'rejected', reviewed_by = $1, reviewed_at = COALESCE($2::timestamptz, now()),
         rejection_reason = $3,
         rased_ref_no = COALESCE(rased_ref_no, $4), rased_status = 'cancelled',
         rased_pdf_url = COALESCE($5, rased_pdf_url), rased_review_note = COALESCE($6, rased_review_note), rased_updated_at = now()
       WHERE id = $7 AND status IN ('pending', 'approved') RETURNING *`,
      [reviewedBy, reviewedAt, `أُوقف التصريح من قسم السلامة — ${note || 'بدون سبب مذكور'}`, refNo, pdfUrl, note, permit.id]
    );
    changed = rows[0] || null;
  } else {
    // closed: لا يغيّر حالة صيانتي (تبقى مقبولًا)، يسجّل الإغلاق فقط.
    const { rows } = await pool.query(
      `UPDATE safety_permits SET rased_status = 'closed', rased_closed_at = COALESCE($1::timestamptz, now()),
         rased_closed_note = $2, rased_ref_no = COALESCE(rased_ref_no, $3),
         rased_pdf_url = COALESCE($4, rased_pdf_url), rased_updated_at = now()
       WHERE id = $5 AND rased_status IS DISTINCT FROM 'closed' RETURNING *`,
      [closedAt, closedNote, refNo, pdfUrl, permit.id]
    );
    if (rows[0]) return { code: 200, body: { ok: true, applied: true, status: 'closed' } };
    duplicate = true;
  }

  if (status !== 'closed') {
    if (!changed) {
      // لم يتغير شيء: إما تكرار لنفس الرد، أو تعارض مع حالة سابقة
      const { rows: cur } = await pool.query('SELECT status, rased_status FROM safety_permits WHERE id = $1', [permit.id]);
      const c = cur[0];
      const same =
        (status === 'approved' && c.status === 'approved') ||
        (status === 'rejected' && c.status === 'rejected') ||
        (status === 'cancelled' && c.rased_status === 'cancelled');
      if (same) {
        // نحدّث بيانات راصد الإضافية (صلاحية/PDF) بلا إشعار جديد
        await pool.query(
          `UPDATE safety_permits SET rased_ref_no = COALESCE(rased_ref_no, $1),
             rased_valid_from = COALESCE($2::timestamptz, rased_valid_from), rased_valid_until = COALESCE($3::timestamptz, rased_valid_until),
             rased_pdf_url = COALESCE($4, rased_pdf_url), rased_updated_at = now() WHERE id = $5`,
          [refNo, validFrom, validUntil, pdfUrl, permit.id]
        );
        return { code: 200, body: { ok: true, applied: false, duplicate: true } };
      }
      console.warn(`[rased] تجاهل رد "${status}" للتصريح ${permit.id} لأن حالته في صيانتي "${c.status}"`);
      return { code: 200, body: { ok: true, applied: false, ignored: `حالة التصريح في صيانتي "${c.status}"` } };
    }
    // تغيّرت الحالة فعلًا → إشعارات واتساب/داخل التطبيق/ويبهوك كما لو راجعه قسم السلامة
    try {
      const { fireWebhook } = require('./webhooks');
      const { notifyEvent } = require('./notifications');
      let full = changed;
      try {
        const sp = require('../routes/safetyPermits');
        if (sp && typeof sp.loadPermitWithTask === 'function') full = (await sp.loadPermitWithTask(changed.id)) || changed;
      } catch (_) { /* نكتفي بالصف نفسه */ }
      fireWebhook('safety_permit_reviewed', full);
      Promise.resolve(notifyEvent('safety_permit_reviewed', full)).catch((err) => console.error('[rased] notifyEvent:', err.message));
    } catch (err) {
      console.error('[rased] تعذّر إطلاق الإشعارات:', err.message);
    }
    return { code: 200, body: { ok: true, applied: true, status: changed.status, rasedStatus: changed.rased_status } };
  }
  return { code: 200, body: { ok: true, applied: false, duplicate } };
}

module.exports = {
  ensureSchema, getSettings, buildPayload, sendPermit, onPermitRequested, retrySweep, resendPermit, applyRasedStatus,
  TYPE_MAP,
};
