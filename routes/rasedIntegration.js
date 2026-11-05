'use strict';
/**
 * ربط راصد — المسارات (راجع services/rased.js للشرح الكامل).
 *
 *  POST /api/integrations/rased/status     ← راصد يرسل نتيجة التصريح (عام بلا تسجيل دخول،
 *                                            محمي بالسر x-rased-secret المحفوظ في الإعدادات)
 *  GET  /api/integrations/rased/info       ← للمدير: حالة الربط والإحصاءات (بطاقة لوحة الويب)
 *  POST /api/integrations/rased/resend/:id ← للمدير: إعادة إرسال تصريح لم يصل
 *  POST /api/integrations/rased/resend-failed ← للمدير: إعادة إرسال كل ما فشل
 *
 * المفتاحان rased_key وrased_secret يُحفظان عبر PUT /api/settings/:key (للمدير فقط).
 */

const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');
const { getClientIp, consumeLimit } = require('../lib/rateLimit');
const rased = require('../services/rased');

const router = new Router();
const adminOnly = [requireAuth, requireApproved, requireRole('admin')];

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// POST /status — عام (راصد ليس مستخدمًا في صيانتي) لكن لا يمرّ إلا بالسر الصحيح.
router.post('/status', async (req, res) => {
  const ip = getClientIp(req);
  if (!consumeLimit(`rased-cb:ip:${ip}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'طلبات كثيرة، حاول بعد دقيقة' });
  }
  const cfg = await rased.getSettings();
  if (!cfg.secret) return res.status(503).json({ error: 'ربط راصد غير مُعدّ في صيانتي (لا يوجد سر)' });
  const given = req.headers['x-rased-secret'];
  if (!given || !safeEqual(given, cfg.secret)) {
    // بعد ١٠ محاولات سر خاطئة من نفس العنوان خلال ١٥ دقيقة نردّ 429 بدل 403
    const allowed = consumeLimit(`rased-cb:bad:${ip}`, 10, 15 * 60 * 1000);
    return res.status(allowed ? 403 : 429).json({ error: 'forbidden' });
  }
  const result = await rased.applyRasedStatus(req.body);
  res.status(result.code).json(result.body);
});

// GET /info — حالة الربط للوحة الويب
router.get('/info', ...adminOnly, async (req, res) => {
  await rased.ensureSchema();
  const cfg = await rased.getSettings();
  const { rows: c } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE rased_ref_no IS NOT NULL) AS registered,
       COUNT(*) FILTER (WHERE rased_queued AND rased_ref_no IS NULL AND status = 'pending') AS waiting,
       COUNT(*) FILTER (WHERE rased_queued AND rased_ref_no IS NULL AND status = 'pending' AND rased_error IS NOT NULL) AS failing
       FROM safety_permits`
  );
  const { rows: recent } = await pool.query(
    `SELECT id, location, status, requested_at, rased_ref_no, rased_status, rased_sent_at, rased_attempts, rased_error
       FROM safety_permits WHERE rased_queued = true ORDER BY id DESC LIMIT 8`
  );
  res.json({
    enabled: cfg.enabled,
    flagOn: cfg.flagOn,
    hasKey: !!cfg.key,
    hasSecret: !!cfg.secret,
    keyTail: cfg.key ? cfg.key.slice(-4) : null,
    callbackUrl: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/api/integrations/rased/status` : null,
    publicBaseUrlSet: !!cfg.publicBaseUrl,
    counts: {
      registered: Number(c[0].registered),
      waiting: Number(c[0].waiting),
      failing: Number(c[0].failing),
    },
    recent,
  });
});

// POST /resend/:id
router.post('/resend/:id', ...adminOnly, async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'رقم تصريح غير صالح' });
  const result = await rased.resendPermit(req.params.id);
  res.json({ result });
});

// POST /resend-failed
router.post('/resend-failed', ...adminOnly, async (req, res) => {
  await rased.ensureSchema();
  const { rows } = await pool.query(
    `SELECT id FROM safety_permits WHERE rased_queued = true AND rased_ref_no IS NULL AND status = 'pending' ORDER BY id LIMIT 50`
  );
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const out = await rased.resendPermit(r.id);
    if (out && out.ok) sent += 1; else failed += 1;
  }
  res.json({ total: rows.length, sent, failed });
});

module.exports = router;
