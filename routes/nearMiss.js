const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, blockContractor, blockGeneral } = require('../middleware/auth');
const { fireWebhook } = require('../services/webhooks');
const { notifyEvent } = require('../services/notifications');

const router = new Router();
// كلاهما خارج نطاق دوره الموثّق (المقاول: تصاريح العمل فقط، القسم العام:
// بلاغ عطل الصيانة فقط) — راجع تعليقي blockContractor وblockGeneral في
// middleware/auth.js.
router.use(requireAuth, requireApproved, blockContractor, blockGeneral);

// GET /api/near-miss — بلاغات السلامة والحوادث الوشيكة
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM near_miss_reports ORDER BY reported_at DESC');
  res.json({ reports: rows });
});

// POST /api/near-miss
router.post('/', async (req, res) => {
  const { location, hazardType, description } = req.body;
  if (!location || !hazardType || !description) {
    return res.status(400).json({ error: 'الموقع ونوع الخطر والوصف كلها إلزامية' });
  }
  const { rows } = await pool.query(
    `INSERT INTO near_miss_reports (location, hazard_type, description, reported_by, reported_by_user)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [location.trim(), hazardType.trim(), description.trim(), req.user.name, req.user.id]
  );
  fireWebhook('near_miss_reported', rows[0]);
  notifyEvent('near_miss_reported', rows[0]);
  res.status(201).json({ report: rows[0] });
});

// PATCH /api/near-miss/:id/status
router.patch('/:id/status', requireRole('safety'), async (req, res) => {
  const { status } = req.body;
  if (!['open', 'reviewed', 'closed'].includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });
  const { rows } = await pool.query(
    'UPDATE near_miss_reports SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'البلاغ غير موجود' });
  res.json({ report: rows[0] });
});

module.exports = router;
