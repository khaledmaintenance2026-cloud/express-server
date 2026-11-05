// إشعارات داخل التطبيق — كل مستخدم يرى إشعاراته الخاصة فقط (راجع جدول
// notifications في schema.sql وservices/notifications.js حيث تُحفظ هذه
// الصفوف عند كل حدث معنيّ: بلاغ عطل، إسناد أمر عمل، إنجازه، طلب/مراجعة
// تصريح سلامة). بديل خفيف الوزن عن إشعارات نظام Push الحقيقية.
'use strict';

const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// GET /api/notifications — آخر إشعارات المستخدم الحالي فقط (حتى ١٠٠)، مع
// عدد غير المقروء لعرضه كرقم صغير على أيقونة الجرس في التطبيق.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, body, event_type, ref_id, is_read, created_at
       FROM notifications WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  const unreadCount = rows.filter((r) => !r.is_read).length;
  res.json({ notifications: rows, unreadCount });
});

// PATCH /api/notifications/:id/read — تحديد إشعار واحد كمقروء (لصاحبه فقط).
router.patch('/:id/read', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الإشعار غير موجود' });
  res.json({ ok: true });
});

// PATCH /api/notifications/read-all — تحديد كل إشعارات المستخدم الحالي كمقروءة دفعة واحدة.
router.patch('/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
