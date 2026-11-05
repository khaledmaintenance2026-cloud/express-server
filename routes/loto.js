const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, blockContractor, blockGeneral, MAINTENANCE_ROLES } = require('../middleware/auth');

const router = new Router();
// لا المقاول ولا موظف القسم العام يحتاج الوصول لسجلات العزل (راجع تعليقي
// blockContractor وblockGeneral في middleware/auth.js).
router.use(requireAuth, requireApproved, blockContractor, blockGeneral);

// GET /api/loto/work-order/:workOrderId — كل خطوات العزل لأمر عمل معيّن
router.get('/work-order/:workOrderId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM loto_logs WHERE work_order_id = $1 ORDER BY created_at',
    [req.params.workOrderId]
  );
  res.json({ lotoLogs: rows });
});

// POST /api/loto — إضافة خطوة عزل طاقة (كهربائي / هيدروليكي / ميكانيكي / هوائي)
router.post('/', requireRole(...MAINTENANCE_ROLES, 'safety'), async (req, res) => {
  const { workOrderId, energyType, isolationPoint } = req.body;
  const validTypes = ['electrical', 'hydraulic', 'mechanical', 'pneumatic'];
  if (!workOrderId || !validTypes.includes(energyType) || !isolationPoint) {
    return res.status(400).json({ error: 'بيانات ناقصة أو نوع طاقة غير صحيح' });
  }
  const { rows } = await pool.query(
    'INSERT INTO loto_logs (work_order_id, energy_type, isolation_point) VALUES ($1, $2, $3) RETURNING *',
    [workOrderId, energyType, isolationPoint.trim()]
  );
  res.status(201).json({ lotoLog: rows[0] });
});

// PATCH /api/loto/:id/lock — تنفيذ العزل
router.patch('/:id/lock', requireRole(...MAINTENANCE_ROLES, 'safety'), async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE loto_logs SET status = 'locked', locked_by = $1, locked_at = now() WHERE id = $2 RETURNING *",
    [req.user.name, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'السجل غير موجود' });
  res.json({ lotoLog: rows[0] });
});

// PATCH /api/loto/:id/verify — التحقق من العزل (يفضّل من قسم السلامة)
router.patch('/:id/verify', requireRole('safety'), async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE loto_logs SET status = 'verified', verified_by = $1, verified_at = now() WHERE id = $2 RETURNING *",
    [req.user.name, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'السجل غير موجود' });

  // إذا كل خطوات العزل لنفس أمر العمل تحققت، ينتقل الأمر تلقائيًا لحالة "قيد التنفيذ"
  const woId = (await pool.query('SELECT work_order_id FROM loto_logs WHERE id = $1', [req.params.id])).rows[0].work_order_id;
  const pending = await pool.query(
    "SELECT count(*) FROM loto_logs WHERE work_order_id = $1 AND status != 'verified'",
    [woId]
  );
  if (Number(pending.rows[0].count) === 0) {
    await pool.query(
      "UPDATE work_orders SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'waiting_loto'",
      [woId]
    );
  }
  res.json({ lotoLog: rows[0] });
});

// PATCH /api/loto/:id/release — رفع العزل بعد انتهاء العمل
router.patch('/:id/release', requireRole(...MAINTENANCE_ROLES, 'safety'), async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE loto_logs SET status = 'released', released_by = $1, released_at = now() WHERE id = $2 RETURNING *",
    [req.user.name, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'السجل غير موجود' });
  res.json({ lotoLog: rows[0] });
});

module.exports = router;
