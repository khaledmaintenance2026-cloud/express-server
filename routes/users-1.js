const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved, requireRole, TECHNICIAN_ROLES } = require('../middleware/auth');
const bcrypt = require('../lib/passwordHash');
const phoneAuth = require('../lib/phoneAuth');
const { sendWhatsappText } = require('../services/textmebot');

const router = new Router();
// إدارة المستخدمين (اعتماد/تغيير دور/تقييد مصنع/جوال/إلغاء اعتماد/حذف) متاحة
// لمدير النظام (admin — يمر دائمًا من requireRole) ولمسؤول الصيانة
// (maintenance_manager) فقط، بقرار صريح من الإدارة (2026-10-04): الفني العادي
// وبقية الأدوار يُرفضون بـ403. مسؤول الصيانة مقيَّد بحمايات أدناه (guardTarget
// وmanagerCannotGrantAdmin) حتى لا يمس حساب مدير النظام ولا يرفع أحدًا (ولا
// نفسه) إلى admin — فلا يتحول هذا التفويض لثغرة تصعيد صلاحيات.
router.use(requireAuth, requireApproved, requireRole('maintenance_manager'));

const NOT_FOUND = { error: 'المستخدم غير موجود' };

/// حماية الحساب المستهدَف (يُطبَّق على كل مسار يحمل :id). مدير النظام يمر بلا
/// قيود (السلوك القديم كما هو). لغير المدير (أي مسؤول الصيانة):
///  - لا يقدر على أي تعديل لحساب دوره admin (دور/اعتماد/جوال/مصنع/إلغاء/حذف).
///  - و[blockSelf] = true: لا يقدر على تغيير دوره أو إلغاء اعتماده أو حذف
///    حسابه هو نفسه (يمنع إغلاق باب الإدارة على نفسه أو تعديل صلاحيته ذاتيًا).
function guardTarget({ blockSelf = false } = {}) {
  return async (req, res, next) => {
    if (req.user.role === 'admin') return next();
    const id = String(req.params.id || '');
    if (!/^\d+$/.test(id)) return res.status(404).json(NOT_FOUND);
    const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json(NOT_FOUND);
    if (rows[0].role === 'admin') {
      return res.status(403).json({ error: 'لا يمكنك تعديل حساب مدير النظام' });
    }
    if (blockSelf && String(rows[0].id) === String(req.user.id)) {
      return res.status(403).json({ error: 'لا يمكنك تغيير صلاحية حسابك أو إلغاء اعتماده أو حذفه بنفسك' });
    }
    next();
  };
}

/// مسؤول الصيانة لا يمنح دور "مدير النظام" لأحد (تصعيد صلاحيات). يعيد true
/// لو رفض الطلب (الرد أُرسل فعلًا).
function managerCannotGrantAdmin(req, res, role) {
  if (role === 'admin' && req.user.role !== 'admin') {
    res.status(403).json({ error: 'منح دور مدير النظام من صلاحية مدير النظام فقط' });
    return true;
  }
  return false;
}

// المصانع المتاحة لتقييد وصول مستخدمي قسم الإنتاج بها (راجع نفس القيم على
// عمود location في جدول production_lines وعمود production_facility الجديد
// في جدول users، schema.sql).
const PRODUCTION_FACILITIES = ['مصنع الرجال', 'مصنع النساء', 'المستودع العام'];

// نفس القيم تمامًا تُستخدم لتقييد وصول مسؤولي قسم السلامة بقسم واحد (رجال أو
// نساء) — عمود مستقل (safety_facility) عن عمود الإنتاج أعلاه، حتى لا يتقاطع
// تقييد دور مع الآخر. راجع routes/safetyPermits.js لكيفية تطبيق هذا التقييد
// فعليًا عند عرض/مراجعة/حذف تصاريح العمل.
const SAFETY_FACILITIES = ['مصنع الرجال', 'مصنع النساء', 'المستودع العام'];

// الأدوار الصحيحة القابلة للاختيار عند الاعتماد أو تغيير الدور — دور
// "الصيانة" العام انقسم إلى فني صيانة ومسؤول صيانة، وأُضيف لاحقًا دور
// "مسؤول إنتاج" (production_manager) يملك كل صلاحيات "إنتاج" العادي بالإضافة
// لصلاحية تعديل/حذف باتشات قديمة (راجع schema.sql وmiddleware/auth.js).
// "مسؤول المخزون" (inventory_manager) و"مصمم" (designer): دوران جديدان لقسم
// "المخزون والقطع" بالصيانة (راجع routes/inventory.js). بقرار من الإدارة
// (2026-10-03) أصبح الاثنان أيضًا يُعتبران أفراد صيانة قابلين للتكليف —
// راجع TECHNICIAN_ROLES في middleware/auth.js وensureTechnicianForUser تحت.
const VALID_ROLES = ['admin', 'maintenance_technician', 'maintenance_manager', 'production', 'production_manager', 'safety', 'contractor', 'general', 'inventory_manager', 'designer'];

// عند اعتماد مستخدم بدور "فني صيانة" (maintenance_technician) لأول مرة، أو
// تغيير دور مستخدم موجود لهذا الدور لاحقًا، يجب أن يظهر رسميًا في جدول
// الفنيين (technicians) — وإلا يبقى بإمكانه الدخول للنظام والعمل كفني، لكن
// لا يظهر اسمه إطلاقًا في قائمة "تعيين فني" عند توزيع البلاغات (تلك القائمة
// تُقرأ من جدول technicians المنفصل تمامًا عن جدول users، ولم يكن هناك أي
// ربط تلقائي بينهما من قبل). منذ 2026-10-03 نفس الربط يحدث أيضًا لمسؤول
// المخزون (inventory_manager) والمصمم (designer) — راجع TECHNICIAN_ROLES
// في middleware/auth.js واستخدامها تحت.
//
// نحاول أولًا الربط باسم فني مُضاف يدويًا من قبل (بلا حساب مستخدم مرتبط
// بعد، user_id فارغ) بنفس الاسم تمامًا — يغطي حالة الفنيين الموجودين أصلًا
// في القائمة (مثل من أُضيفوا يدويًا قبل هذا التحديث) الذين ينشئون حسابًا
// الآن لأول مرة، فلا نكرر اسمه بسجل جديد منفصل. فإن لم يوجد تطابق، ننشئ
// سجل فني جديدًا ونربطه بحساب المستخدم مباشرة. لو كان مرتبطًا بالفعل
// (user_id يشير له سلفًا) لا نفعل شيئًا لتفادي التكرار عند اعتماد/تغيير
// دور نفس المستخدم أكثر من مرة.
//
// التخصص (specialty) في السجل الجديد عرض فقط (لا يؤثر على أي صلاحية) —
// نضعه مناسبًا لدور المستخدم فقط لتسهيل التمييز بينهم في قائمة "تعيين فني".
function specialtyForRole(role) {
  if (role === 'inventory_manager') return 'مخزون';
  if (role === 'designer') return 'تصميم';
  return 'عام';
}

async function ensureTechnicianForUser(user) {
  const linked = await pool.query('SELECT id FROM technicians WHERE user_id = $1', [user.id]);
  if (linked.rows.length > 0) return;

  const byName = await pool.query(
    'SELECT id FROM technicians WHERE user_id IS NULL AND trim(name) = trim($1) LIMIT 1',
    [user.name]
  );
  if (byName.rows.length > 0) {
    await pool.query('UPDATE technicians SET user_id = $1, updated_at = now() WHERE id = $2', [user.id, byName.rows[0].id]);
    return;
  }

  await pool.query(
    'INSERT INTO technicians (name, phone, specialty, user_id) VALUES ($1, $2, $3, $4)',
    [user.name, user.phone || null, specialtyForRole(user.role), user.id]
  );
}

// GET /api/users — كل المستخدمين (بانتظار الاعتماد + المعتمدون)
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, status, production_facility, safety_facility, phone, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ users: rows });
});

// PATCH /api/users/:id/approve — اعتماد مستخدم وتحديد دوره
router.patch('/:id/approve', guardTarget({ blockSelf: true }), async (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'دور غير صحيح' });
  }
  if (managerCannotGrantAdmin(req, res, role)) return;
  const { rows } = await pool.query(
    `UPDATE users SET status = 'approved', role = $1, updated_at = now() WHERE id = $2
     RETURNING id, name, email, role, status, phone`,
    [role, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (TECHNICIAN_ROLES.includes(rows[0].role)) await ensureTechnicianForUser(rows[0]);
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id/role — تغيير دور مستخدم معتمد
router.patch('/:id/role', guardTarget({ blockSelf: true }), async (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'دور غير صحيح' });
  }
  if (managerCannotGrantAdmin(req, res, role)) return;
  const { rows } = await pool.query(
    'UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, phone',
    [role, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (TECHNICIAN_ROLES.includes(rows[0].role)) await ensureTechnicianForUser(rows[0]);
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id/production-facility — تحديد أو إزالة تقييد وصول
// مستخدم قسم الإنتاج بمصنع واحد فقط (facility: null يعني إزالة التقييد،
// فيرى المستخدم كل المصانع كما كان الوضع سابقًا).
router.patch('/:id/production-facility', guardTarget(), async (req, res) => {
  const { facility } = req.body;
  if (facility !== null && facility !== undefined && !PRODUCTION_FACILITIES.includes(facility)) {
    return res.status(400).json({ error: 'قسم إنتاج غير صحيح' });
  }
  const { rows } = await pool.query(
    'UPDATE users SET production_facility = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, production_facility',
    [facility ?? null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id/safety-facility — تحديد أو إزالة تقييد وصول مسؤول
// قسم السلامة بقسم واحد فقط (facility: null يعني إزالة التقييد، فيرى
// المستخدم تصاريح كل الأقسام كما كان الوضع سابقًا) — نفس فكرة
// production-facility أعلاه تمامًا لكن بعمود مستقل خاص بدور "السلامة".
router.patch('/:id/safety-facility', guardTarget(), async (req, res) => {
  const { facility } = req.body;
  if (facility !== null && facility !== undefined && !SAFETY_FACILITIES.includes(facility)) {
    return res.status(400).json({ error: 'قسم سلامة غير صحيح' });
  }
  const { rows } = await pool.query(
    'UPDATE users SET safety_facility = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, safety_facility',
    [facility ?? null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id/phone — تعديل رقم هاتف مستخدم (مدير النظام أو مسؤول الصيانة) —
// يُستخدم لتصحيح الرقم أو إضافته لمن سجّل قبل إضافة هذا الحقل. phone: null
// يعني حذف الرقم المسجَّل صراحةً (بدل تجاهل التحديث كما تفعل COALESCE).
router.patch('/:id/phone', guardTarget(), async (req, res) => {
  const { phone } = req.body;
  const { rows } = await pool.query(
    'UPDATE users SET phone = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, production_facility, safety_facility, phone',
    [phone ? String(phone).trim() : null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id/reset-password — لمن نسي كلمة مروره (الفني مثلًا) ولم
// ينجح معه "نسيت كلمة المرور" على واتساب: مدير النظام أو مسؤول الصيانة يعيّن له
// كلمة مرور مؤقتة جديدة. تظهر للمسؤول مرة واحدة في الرد (لا تُخزَّن إلا مجزَّأة)،
// وتُرسَل أيضًا إلى واتساب صاحب الحساب إن كان له رقم (sendWhatsapp: false لإلغاء ذلك).
// مسؤول الصيانة لا يلمس حساب مدير النظام (guardTarget)، ولا حسابه هو
// (يستخدم "تغيير كلمة المرور" من إعداداته). الجلسات الحالية للمستخدم تبقى صالحة
// حتى انتهائها (توكن بلا إبطال)، لكن الدخول الجديد يتطلب كلمة المرور الجديدة.
router.patch('/:id/reset-password', guardTarget(), async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) return res.status(404).json(NOT_FOUND);
  if (id === String(req.user.id)) {
    return res.status(400).json({ error: 'لتغيير كلمة مرورك أنت استخدم "تغيير كلمة المرور" من إعدادات حسابك' });
  }
  const temporaryPassword = phoneAuth.generateTemporaryPassword();
  const { rows } = await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, phone',
    [bcrypt.hash(temporaryPassword), id]
  );
  if (rows.length === 0) return res.status(404).json(NOT_FOUND);
  const user = rows[0];

  // أي رمز استعادة معلّق لهذا الحساب لم يعد له معنى.
  try {
    await phoneAuth.ensurePasswordResets(pool);
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
  } catch (err) {
    console.error('reset-password: تعذّر مسح رمز الاستعادة المعلّق:', err.message);
  }

  let whatsapp = 'no_phone';
  if (user.phone && phoneAuth.phoneKey(user.phone)) {
    if (req.body && req.body.sendWhatsapp === false) {
      whatsapp = 'skipped';
    } else {
      whatsapp = 'queued';
      const text =
        'صيانتي — تم تعيين كلمة مرور مؤقتة لحسابك:\n' +
        `${temporaryPassword}\n` +
        'سجّل الدخول بها ثم غيّرها من «الحساب والأمان» في التطبيق.';
      Promise.resolve()
        .then(() => sendWhatsappText(user.phone, text))
        .catch((err) => console.error(`reset-password: فشل إرسال واتساب للمستخدم ${user.id}:`, err && err.message ? err.message : err));
    }
  }
  res.json({ temporaryPassword, whatsapp, user });
});

// PATCH /api/users/:id/revoke — إلغاء اعتماد مستخدم (يرجع لحالة "بانتظار الاعتماد")
router.patch('/:id/revoke', guardTarget({ blockSelf: true }), async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE users SET status = 'revoked', updated_at = now() WHERE id = $1 RETURNING id, name, email, role, status",
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ user: rows[0] });
});

// DELETE /api/users/:id — حذف طلب حساب (عادة يُستخدم لرفض طلب بانتظار الاعتماد)
router.delete('/:id', guardTarget({ blockSelf: true }), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.status(204).end();
});

module.exports = router;
