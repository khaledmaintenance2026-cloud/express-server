const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// GET /api/technicians — لأي مستخدم معتمد (يحتاجه مثلاً شاشة تعيين فني)
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM technicians ORDER BY name');
  res.json({ technicians: rows });
});

// إدارة قائمة الفنيين (إضافة/تعديل/حذف) لمدير النظام ومسؤول الصيانة فقط —
// منذ 2026-10-04 لا يشمل الفني العادي (maintenance_technician) بقرار الإدارة
// (requireRole يمرّر admin دائمًا). القراءة GET تبقى مفتوحة لكل مستخدم معتمد.
// POST /api/technicians — إضافة فني (مدير النظام أو مسؤول الصيانة)
router.post('/', requireRole('maintenance_manager'), async (req, res) => {
  const { name, phone, specialty } = req.body;
  if (!name) return res.status(400).json({ error: 'الاسم إلزامي' });
  const { rows } = await pool.query(
    'INSERT INTO technicians (name, phone, specialty) VALUES ($1, $2, $3) RETURNING *',
    [name.trim(), phone || null, specialty || 'عام']
  );
  res.status(201).json({ technician: rows[0] });
});

// PATCH /api/technicians/:id — تعديل بيانات فني أو حالته (متاح/مشغول/إجازة)
router.patch('/:id', requireRole('maintenance_manager'), async (req, res) => {
  const { name, phone, specialty, status } = req.body;
  const { rows } = await pool.query(
    `UPDATE technicians SET
       name = COALESCE($1, name),
       phone = COALESCE($2, phone),
       specialty = COALESCE($3, specialty),
       status = COALESCE($4, status),
       updated_at = now()
     WHERE id = $5 RETURNING *`,
    [name, phone, specialty, status, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'الفني غير موجود' });
  res.json({ technician: rows[0] });
});

// DELETE /api/technicians/:id
router.delete('/:id', requireRole('maintenance_manager'), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM technicians WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'الفني غير موجود' });
  res.status(204).end();
});

// GET /api/technicians/:id/performance — كفاءة الفني: زمن الاستجابة وعدد الأعطال المنجزة
router.get('/:id/performance', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'completed') AS completed_count,
       avg(EXTRACT(EPOCH FROM (completed_at - assigned_at)) / 60) FILTER (WHERE status = 'completed') AS avg_minutes
     FROM work_orders WHERE assigned_technician_id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  res.json({
    completedCount: Number(row.completed_count) || 0,
    avgResolutionMinutes: row.avg_minutes ? Math.round(row.avg_minutes) : null,
  });
});

module.exports = router;