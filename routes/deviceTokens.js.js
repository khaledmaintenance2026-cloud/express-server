const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// POST /api/device-tokens — يسجّل (أو يحدّث) توكن إشعارات Push الخاص بالجهاز
// الحالي، مرتبطًا بالمستخدم المسجّل دخوله الآن. يستدعيه تطبيق الجوال/الويب
// تلقائيًا عند بدء التشغيل (lib/services/push_notification_service.dart)
// وعند تجدد التوكن. راجع services/push.js لكيفية استخدام هذا الجدول لاحقًا
// عند إرسال أي إشعار.
router.post('/', async (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'التوكن إلزامي' });
  // لو نفس التوكن كان مسجَّلاً سابقًا لمستخدم آخر (تسجيل خروج/دخول بحساب
  // مختلف على نفس الجهاز)، نُحدِّث ربطه للمستخدم الحالي بدل رفض الإدخال
  // (التوكن نفسه UNIQUE في الجدول).
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
    [req.user.id, token, platform || null]
  );
  res.status(201).json({ ok: true });
});

// DELETE /api/device-tokens — يُزال عند تسجيل الخروج حتى لا يستمر جهاز خرج
// منه المستخدم في استقبال إشعارات باسمه (اختياري الاستخدام من التطبيق).
router.delete('/', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'التوكن إلزامي' });
  await pool.query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  res.status(204).end();
});

module.exports = router;