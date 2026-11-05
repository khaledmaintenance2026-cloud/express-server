const jwt = require('../lib/jwtLite');
const { pool } = require('../config/db');

// لا نسمح إطلاقًا بمفتاح JWT افتراضي مكتوب في الكود نفسه (كان سابقًا
// 'change-this-secret-in-env-file') — لو غاب JWT_SECRET من .env لأي سبب
// (ملف مفقود، سطر محذوف بالخطأ، نسخة جديدة من السيرفر بلا إعداد كامل)
// فأي شخص يقرأ الكود المصدري يقدر يُوقّع توكن دخول صالح لحساب admin. نوقف
// السيرفر فورًا برسالة واضحة بدل العمل بصمت بمفتاح معروف للجميع — راجع
// lib/loadEnv.js الذي كان يكتفي بتحذير في اللوق فقط لهذه الحالة تحديدًا.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET غير مضبوط في ملف .env — السيرفر يرفض العمل بدونه لأنه كان سابقًا يستخدم مفتاحًا افتراضيًا غير آمن. ' +
    'أضيفوا سطر JWT_SECRET=<نص عشوائي طويل> في C:\\sayanati-server\\.env ثم أعيدوا تشغيل الخدمة.'
  );
}

// دور "الصيانة" العام انقسم إلى دورين محددين (راجع schema.sql وroutes/users.js):
// فني صيانة (maintenance_technician) ومسؤول صيانة (maintenance_manager). كل
// المسارات التي كانت تتحقق من requireRole('maintenance') يجب أن تقبل
// الاثنين معًا الآن، لذا نصدّر هذه القائمة الجاهزة لاستخدامها في كل مكان
// بدل تكرار الاسمين يدويًا (...MAINTENANCE_ROLES).
const MAINTENANCE_ROLES = ['maintenance_technician', 'maintenance_manager'];

// دور جديد "مسؤول إنتاج" (production_manager) يملك كل صلاحيات "إنتاج" العادي
// (production) بالإضافة لصلاحيات إضافية خاصة به فقط (تعديل/حذف باتش قديم —
// راجع routes/production.js). أي مسار كان يتحقق من requireRole('production')
// فقط ويُفترض أن يقبل المسؤول أيضًا بنفس صلاحيات الموظف العادي، يستخدم هذه
// القائمة الجاهزة (...PRODUCTION_ROLES) بدل تكرار الاسمين يدويًا.
const PRODUCTION_ROLES = ['production', 'production_manager'];

// قسم "المخزون والقطع" الجديد بالصيانة — إدارة الكتالوج نفسه (إضافة/تعديل
// أصناف، تعديل كمية مباشرة، تأكيد صرف/إرجاع طلب قطعة) محصورة بمسؤول الصيانة
// (maintenance_manager) ومسؤول المخزون (inventory_manager) معًا — قرار صريح
// من الإدارة، وليس أي فني. راجع routes/inventory.js.
const INVENTORY_MANAGE_ROLES = ['maintenance_manager', 'inventory_manager'];

// أدوار "تُعامَل كفرد صيانة قابل للتكليف" فعليًا — قرار صريح من الإدارة
// 2026-10-03: مسؤول المخزون (inventory_manager) والمصمم (designer) يُعتبران
// الآن أفراد صيانة بهذا المعنى التحديد (بالإضافة لصلاحياتهما الأصلية في قسم
// المخزون نفسه، التي لا علاقة لها بهذه القائمة). هذا يعني: (أ) حسابهما يُربط
// تلقائيًا بسجل في جدول الفنيين (technicians) عند الاعتماد/تغيير الدور —
// راجع ensureTechnicianForUser في routes/users.js، فيظهر اسمهما في قائمة
// "تعيين فني" كأي فني عادي؛ (ب) يخضعان لنفس تقييد رؤية "أوامر العمل الخاصة
// بي فقط" المطبَّق على الفني العادي — راجع GET /api/work-orders؛ (ج) يقدران
// يحدّثان حالة أو يُنجزان أي أمر عمل مُسنَد إليهما فعليًا تمامًا كالفني
// العادي — راجع PATCH /:id/status و/:id/close في routes/workOrders.js. لا
// يشمل مسؤول الصيانة (maintenance_manager) نفسه — هو من يُكلّف الفنيين، لا
// يُكلَّف كأحدهم. تنبيه مهم: عمدًا لا يقدران على PATCH /:id/assign (إضافة
// فني آخر لمهمة) — قرار صريح 2026-10-03 رفضتم فيه هذه الصلاحية تحديدًا لهما،
// فتبقى محصورة بأدوار الصيانة الأصلية (MAINTENANCE_ROLES) فقط.
const TECHNICIAN_ROLES = ['maintenance_technician', 'inventory_manager', 'designer'];

/// يتحقق من رمز الدخول (JWT) ويجلب أحدث بيانات المستخدم من قاعدة البيانات
/// (بدل الاعتماد على بيانات الرمز القديمة) — مهم لأن حالة الاعتماد أو
/// الصلاحية قد تتغيّر من لوحة الإدارة بعد إصدار الرمز.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // رابط تنزيل مباشر (مثال: تصدير CSV يُفتح عبر متصفح خارجي بـurl_launcher
  // من التطبيق) لا يقدر يُرسل ترويسة Authorization — لذلك نقبل الرمز كبديل
  // عبر ?token= في الرابط نفسه فقط لو غابت الترويسة، بلا أي إضعاف لتقييد
  // الترويسة العادي (كل الطلبات العادية من التطبيق/لوحة التحكم تستمر
  // بالترويسة كما هي). نفس الرمز (JWT) المستخدم فعليًا في كل مكان آخر —
  // ليس رمزًا أضعف أو منفصلًا.
  const token = header.startsWith('Bearer ') ? header.slice(7) : (typeof req.query?.token === 'string' ? req.query.token : null);
  if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, name, email, role, status, production_facility, safety_facility, phone FROM users WHERE id = $1',
      [payload.userId]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'المستخدم غير موجود' });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
  }
}

/// يمنع أي مستخدم لم يُعتمد بعد من قبل مدير النظام من استخدام أي مسار محمي.
function requireApproved(req, res, next) {
  if (req.user.status !== 'approved') {
    return res.status(403).json({ error: 'حسابك بانتظار اعتماد مدير النظام' });
  }
  next();
}

/// يقيّد المسار على أدوار محددة — المدير (admin) يمر دائمًا بغض النظر عن القائمة.
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'ليست لديك صلاحية الوصول لهذا القسم' });
  };
}

module.exports = {
  requireAuth, requireApproved, requireRole, JWT_SECRET,
  MAINTENANCE_ROLES, PRODUCTION_ROLES, INVENTORY_MANAGE_ROLES, TECHNICIAN_ROLES,
};
