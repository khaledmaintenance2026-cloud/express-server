const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

router.post('/', async (req, res) => {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'التوكن إلزامي' });
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
    [req.user.id, token, platform || null]
  );
  res.status(201).json({ ok: true });
});

router.delete('/', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'التوكن إلزامي' });
  await pool.query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  res.status(204).end();
});

module.exports = router;