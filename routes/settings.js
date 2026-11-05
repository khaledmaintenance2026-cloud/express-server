const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole } = require('../middleware/auth');

const router = new Router();
router.use(requireAuth, requireApproved);

// أي مفتاح إعداد يحمل اسمًا يوحي بأنه سرّي (مفتاح API، توكن، كلمة مرور...)
// يُستثنى من الاستجابة لغير المدير. اكتُشف أثناء مراجعة أمنية (17 سبتمبر
// 2026) أن هذه النقطة كانت تُعيد site_settings كاملة — بما فيها
// "textmebot_api_key" (مفتاح إرسال رسائل واتساب الحقيقي المستخدم في
// services/textmebot.js) — لأي حساب معتمَد من أي دور (إنتاج/صيانة/مقاول/عام
// وغيرهم)، رغم أن الجدول نفسه مصمَّم أصلًا لقيم عامة غير حساسة فقط
// (factory_name, report_footer — راجع بيانات schema.sql الابتدائية). أي شخص
// يملك هذا المفتاح يقدر يرسل رسائل واتساب باسم رقم الشركة المسجَّل في
// TextMeBot. نمط الاستثناء عام (regex) بدل تعداد "textmebot_api_key" فقط،
// حتى يغطّي تلقائيًا أي مفتاح سرّي مشابه يُضاف لاحقًا لنفس الجدول العام.
const SENSITIVE_SETTING_KEY = /key|secret|token|password/i;

// GET /api/settings — لأي مستخدم معتمد (يحتاجه ترويسة التقارير مثلاً، مثل
// factory_name وreport_footer) — لكن المفاتيح السرّية تظهر فقط لمدير النظام.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM site_settings');
  const settings = {};
  for (const row of rows) {
    if (req.user.role !== 'admin' && SENSITIVE_SETTING_KEY.test(row.key)) continue;
    settings[row.key] = row.value;
  }
  res.json({ settings });
});

// PUT /api/settings/:key — المدير فقط
router.put('/:key', requireRole('admin'), async (req, res) => {
  const { value } = req.body;
  if (typeof value !== 'string') return res.status(400).json({ error: 'القيمة يجب أن تكون نصًا' });
  await pool.query(
    'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [req.params.key, value]
  );
  res.json({ key: req.params.key, value });
});

module.exports = router;
