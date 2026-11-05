const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const bcrypt = require('../lib/passwordHash');
const jwt = require('../lib/jwtLite');
const { pool } = require('../config/db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { notifyEvent } = require('../services/notifications');
const { checkLoginRateLimit, recordFailedLogin, clearLoginRateLimit, getClientIp, consumeLimit } = require('../lib/rateLimit');
const phoneAuth = require('../lib/phoneAuth');
const { sendWhatsappText } = require('../services/textmebot');

const router = new Router();

/// عدّلوا هذه القائمة لتضم بريدكم الإلكتروني — أول حساب يُنشأ بأحد هذه
/// العناوين يُعتمد تلقائيًا كـ"مدير نظام" بدون انتظار موافقة أحد.
const SEED_ADMIN_EMAILS = (process.env.SEED_ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function signToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

// الحد الأدنى المطلوب لقوة الباسورد: ٨ أحرف على الأقل، وتنوّع بين رقم واحد
// على الأقل وحرف واحد على الأقل (وليس أرقامًا فقط، وليس مجرد طول بلا أي
// تنوع). الحد السابق كان "٦ أحرف" بلا أي شرط تنوع — يسمح بباسورد مثل
// "111111" أو "aaaaaa". اشتراط "حرف" هنا لا يقتصر على الحروف اللاتينية
// (لا نفرض a-z تحديدًا) حتى لا نستبعد من يفضّل باسورد بحروف عربية — يكفي أي
// محرف واحد على الأقل ليس رقمًا ولا فراغًا، بجانب رقم واحد على الأقل.
function isPasswordStrongEnough(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  const hasDigit = /\d/.test(pw);
  const hasNonDigit = /[^\d\s]/.test(pw);
  return hasDigit && hasNonDigit;
}
const PASSWORD_STRENGTH_ERROR = 'كلمة المرور يجب أن تكون ٨ أحرف على الأقل، وتحتوي على حرف ورقم معًا على الأقل';
const PHONE_ONLY_ERROR = 'الدخول الآن برقم الجوال فقط — اكتب رقم جوالك المسجَّل (مثال: 0501234567)';

/// معرّف عميل جوجل (Web Client ID) المُفعِّل لتسجيل الدخول عبر جوجل — يُضبط
/// من قاعدة البيانات مباشرة (site_settings، المفتاح google_web_client_id)
/// عبر pgAdmin، بدل تعديل كود السيرفر أو إعادة بناء التطبيق كل مرة. هذا
/// المعرّف ليس سرًّا (Client ID وليس Client Secret) — يظهر علنًا داخل أي
/// تطبيق يستخدمه، فلا خطورة من كشفه في استجابة API عامة.
async function getGoogleClientId() {
  const { rows } = await pool.query("SELECT value FROM site_settings WHERE key = 'google_web_client_id'");
  return rows[0] && rows[0].value ? rows[0].value : null;
}

// ملاحظة مهمة: هذه الدالة هي الشكل الوحيد الذي يصل به المستخدم لبيانات نفسه
// (تسجيل الدخول، التسجيل، /me) — أي عمود على جدول users يحتاجه التطبيق
// (مثل production_facility أو phone) يجب إضافته هنا صراحة، وإلا سيصل
// للتطبيق كـ null دائمًا حتى لو كانت القيمة الحقيقية محفوظة في قاعدة البيانات.
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
        production_facility: u.production_facility ?? null,
    safety_facility: u.safety_facility ?? null,
    general_facility: u.general_facility ?? null,
    phone: u.phone ?? null,
    // false = حساب مسجَّل برقم الجوال فقط (البريد اصطلاحي داخلي لا يُعرض للمستخدم)
    has_real_email: !phoneAuth.isPlaceholderEmail(u.email),
  };
}

// POST /api/auth/register — إنشاء حساب جديد (يبقى "بانتظار الاعتماد").
// التسجيل والدخول برقم الجوال فقط: phone إلزامي وهو هوية الدخول واستعادة كلمة
// المرور وإشعارات واتساب. لا يُقبل بريد إلكتروني (يُتجاهل لو أرسلته نسخة قديمة من
// التطبيق)، ويأخذ الحساب بريدًا اصطلاحيًا داخليًا (lib/phoneAuth.js) لأن عمود email
// في الجدول إلزامي وفريد وتعتمد عليه أجزاء أخرى — لا يُعرض ولا يُراسَل أبدًا.
router.post('/register', async (req, res) => {
  const { name, password, phone } = req.body;
  // تحقق من النوع (وليس فقط "موجود/غير فارغ") قبل استخدام .trim()/.length —
  // بدونه، إرسال رقم أو كائن بدل نص يسبب استثناء غير متوقع. وحدّ أقصى لطول
  // كلمة المرور لأن scryptSync (lib/passwordHash.js) متزامنة وتحجب حلقة
  // الأحداث الوحيدة للسيرفر طوال معالجتها (DoS بكلمة مرور ضخمة).
  if (typeof name !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'الاسم وكلمة المرور يجب أن تكونا نصوصًا' });
  }
  if (!name.trim()) {
    return res.status(400).json({ error: 'الاسم إلزامي' });
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'الاسم أطول من الحد المسموح' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'كلمة المرور أطول من الحد المسموح (٢٠٠ حرف)' });
  }
  if (!isPasswordStrongEnough(password)) {
    return res.status(400).json({ error: PASSWORD_STRENGTH_ERROR });
  }
  if (!phone || (typeof phone !== 'string' && typeof phone !== 'number') || !String(phone).trim()) {
    return res.status(400).json({ error: 'رقم الجوال إلزامي' });
  }
  if (String(phone).trim().length > 20) {
    return res.status(400).json({ error: 'رقم الجوال أطول من الحد المسموح' });
  }
  if (!phoneAuth.phoneKey(phone)) {
    return res.status(400).json({ error: 'رقم الجوال غير صحيح — اكتبه بالأرقام فقط (مثال: 0501234567)' });
  }
  const PHONE_TAKEN =
    'رقم الجوال هذا مسجّل مسبقًا — سجّل الدخول به، أو اضغط "نسيت كلمة المرور" إن نسيتها';
  try {
    // الرقم هو هوية الدخول، فلا نقبل رقمًا مستخدمًا في أي حساب آخر (وإلا صار
    // الدخول به ملتبسًا بين شخصين).
    const existing = await phoneAuth.findUsersByPhone(pool, phone);
    if (existing.length > 0) {
      return res.status(409).json({ error: PHONE_TAKEN });
    }
    const emailLower = phoneAuth.placeholderEmailFor(phone);
    const storedPhone = phoneAuth.canonicalStoredPhone(phone);
    const passwordHash = bcrypt.hash(password);

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, status, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, status, production_facility, safety_facility, phone`,
      [name.trim(), emailLower, passwordHash, 'production', 'pending', storedPhone]
    );
    const user = rows[0];
    notifyEvent('user_registered', user);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: PHONE_TAKEN });
    }
    // نسجّل تفاصيل الخطأ الحقيقية في سجل الخادم فقط ونعيد رسالة عامة بلا تفاصيل تقنية.
    console.error('POST /api/auth/register:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء إنشاء الحساب، حاول مرة أخرى' });
  }
});

// GET /api/auth/google-config — بلا حاجة لتسجيل دخول (تُستدعى من شاشة الدخول
// نفسها قبل أي مصادقة) لمعرفة هل تسجيل الدخول عبر جوجل مفعَّل، وما معرّف
// العميل الذي يجب على التطبيق استخدامه. القيمة null تعني غير مفعَّل بعد —
// التطبيق يخفي زر جوجل تمامًا في هذه الحالة بدل زر لا يعمل.
router.get('/google-config', async (req, res) => {
  const clientId = await getGoogleClientId();
  res.json({ clientId });
});

// POST /api/auth/google — تسجيل الدخول أو إنشاء حساب جديد عبر جوجل. يستقبل
// idToken الصادر من حزمة google_sign_in داخل التطبيق، ويتحقق منه مباشرة مع
// جوجل عبر نقطة tokeninfo الرسمية (بدون أي مكتبة خارجية، فقط fetch المدمجة
// في Node) — فلا نثق بأي بيانات قادمة من التطبيق نفسه دون تأكيد من جوجل.
router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'رمز جوجل (idToken) مطلوب' });
  }

  const expectedClientId = await getGoogleClientId();
  if (!expectedClientId) {
    return res.status(500).json({ error: 'تسجيل الدخول عبر جوجل غير مُفعَّل على السيرفر بعد' });
  }

  let payload;
  try {
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'تعذّر التحقق من حساب جوجل (رمز غير صالح أو منتهي الصلاحية)' });
    }
    payload = await verifyRes.json();
  } catch (err) {
    console.error('POST /api/auth/google (tokeninfo):', err);
    return res.status(502).json({ error: 'تعذّر الاتصال بخوادم جوجل للتحقق من الحساب، حاول مرة أخرى' });
  }

  // aud يجب أن يطابق معرّف العميل المضبوط تحديدًا — وإلا فالرمز صادر لتطبيق
  // آخر (احتيال أو خطأ إعداد)، ونرفضه فورًا مهما بدا صالحًا لدى جوجل نفسها.
  if (payload.aud !== expectedClientId) {
    return res.status(401).json({ error: 'رمز جوجل غير صادر لهذا التطبيق' });
  }
  if (!payload.email || payload.email_verified !== 'true') {
    return res.status(401).json({ error: 'حساب جوجل بلا بريد إلكتروني موثّق' });
  }

  const emailLower = String(payload.email).trim().toLowerCase();
  const sub = String(payload.sub);
  const name = payload.name || emailLower.split('@')[0];

  try {
    // أولًا: هل هذا الحساب مربوط مسبقًا بهذا معرّف جوجل من دخول سابق؟
    let { rows } = await pool.query('SELECT * FROM users WHERE google_sub = $1', [sub]);
    let user = rows[0];

    if (!user) {
      // ثانيًا: هل يوجد حساب بنفس البريد أُنشئ سابقًا ببريد/كلمة مرور عادية؟
      // نربطه تلقائيًا بحساب جوجل هذا (البريد موثّق من جوجل نفسها، فالربط آمن).
      ({ rows } = await pool.query('SELECT * FROM users WHERE email = $1', [emailLower]));
      user = rows[0];
      if (user) {
        ({ rows } = await pool.query(
          'UPDATE users SET google_sub = $1, updated_at = now() WHERE id = $2 RETURNING *',
          [sub, user.id]
        ));
        user = rows[0];
      }
    }

    let isNewUser = false;
    if (!user) {
      // حساب جديد كليًا — نفس دورة الاعتماد المعتادة (بانتظار موافقة المدير
      // إلا لو كان البريد ضمن SEED_ADMIN_EMAILS)، برقم جوال فارغ مؤقتًا (جوجل
      // لا يوفّره) — يُطلب من المستخدم مباشرة بعد أول دخول قبل إكمال أي شيء
      // آخر (راجع PATCH /api/auth/phone وشاشة "استكمال البيانات" في التطبيق).
      isNewUser = true;
      const isSeedAdmin = SEED_ADMIN_EMAILS.includes(emailLower);
      // كلمة مرور عشوائية غير قابلة للاستخدام أبدًا (المستخدم لن يعرفها) —
      // فقط لتفادي كسر قيد password_hash NOT NULL دون تغيير بنية الجدول.
      const placeholderHash = bcrypt.hash(crypto.randomBytes(32).toString('hex'));
      ({ rows } = await pool.query(
        `INSERT INTO users (name, email, password_hash, role, status, google_sub, phone)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         RETURNING *`,
        [String(name).trim(), emailLower, placeholderHash, isSeedAdmin ? 'admin' : 'production', isSeedAdmin ? 'approved' : 'pending', sub]
      ));
      user = rows[0];
      if (user.status === 'pending') {
        notifyEvent('user_registered', user);
      }
    }

    res.json({ token: signToken(user), user: publicUser(user), isNewUser, needsPhone: !user.phone });
  } catch (err) {
    console.error('POST /api/auth/google:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء الدخول عبر جوجل، حاول مرة أخرى' });
  }
});

// POST /api/auth/login
// الدخول برقم الجوال فقط. الحقل identifier، والنسخ القديمة من التطبيق ترسل
// الرقم داخل حقل email — نقبل الحقول الثلاثة لكن المحتوى يجب أن يكون رقم جوال.
// checkLoginRateLimit
// (راجع lib/rateLimit.js) يرفض الطلب فورًا بـ429 لو تجاوز عدد المحاولات
// الفاشلة الحد المسموح (بالـIP أو بالمُعرِّف)، قبل قراءة المستخدم — حماية من
// التخمين المتكرر (brute-force) بما أن الخادم مكتوب يدويًا بلا مكتبات جاهزة.
router.post('/login', checkLoginRateLimit, async (req, res) => {
  const { password } = req.body;
  const identifier = [req.body.identifier, req.body.email, req.body.phone]
    .find((v) => typeof v === 'string' && v.trim());
  // نفس تحقق النوع والحد الأقصى لطول كلمة المرور المُضاف في /register: verify
  // أدناه يستدعي scryptSync المتزامنة قبل أي تحقق آخر — قبول كلمة مرور ضخمة هنا
  // يحجب حلقة الأحداث لكل المستخدمين. نقطة الدخول هذه الأخطر لأنها بلا تسجيل.
  if (!identifier || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'رقم الجوال وكلمة المرور إلزاميان' });
  }
  if (identifier.length > 200 || password.length > 200) {
    return res.status(400).json({ error: 'البيانات المُدخَلة أطول من الحد المسموح' });
  }
  if (!phoneAuth.looksLikePhone(identifier)) {
    return res.status(400).json({ error: PHONE_ONLY_ERROR });
  }

  try {
    const candidates = (await phoneAuth.findUsersByPhone(pool, identifier)).slice(0, 5);
    // قد يتشارك حسابان قديمان نفس رقم الجوال: نجرّب كلمة المرور على كل منهما
    // ويدخل صاحب الكلمة المطابقة (المعتمَد أولًا).
    const user = candidates.find((u) => bcrypt.verify(password, u.password_hash));
    if (!user) {
      recordFailedLogin(req);
      return res.status(401).json({ error: 'رقم الجوال أو كلمة المرور غير صحيحة' });
    }

    clearLoginRateLimit(req);
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء تسجيل الدخول، حاول مرة أخرى' });
  }
});

// ---------------------------------------------------------------------------
// استعادة كلمة المرور عبر واتساب (للفني ولأي مستخدم نسيها):
//   1) POST /forgot-password {identifier}  → رمز من ٦ أرقام على واتساب الحساب
//   2) POST /reset-password {identifier, code, newPassword} → كلمة مرور جديدة
// الرمز يُخزَّن مجزَّأً (HMAC) صالحًا ١٥ دقيقة، ٥ محاولات خاطئة تُبطله، ويُستهلك
// مرة واحدة. تُحمى الطلبات بعدّادات لكل IP ولكل حساب، لأن كل رمز = رسالة واتساب
// في طابور مشترك بين كل النظام (فاصل ~٨ ثوانٍ بين الرسائل).
// ---------------------------------------------------------------------------
const FORGOT_NO_PHONE =
  'لا يوجد رقم جوال مسجّل لهذا الحساب — اطلب من مسؤول الصيانة أن يعيّن لك كلمة مرور مؤقتة';

function pickIdentifier(body) {
  const b = body || {};
  return [b.identifier, b.email, b.phone].find((v) => typeof v === 'string' && v.trim());
}

router.post('/forgot-password', async (req, res) => {
  const identifier = pickIdentifier(req.body);
  if (!identifier) return res.status(400).json({ error: 'أدخل رقم جوالك المسجَّل' });
  if (identifier.length > 200) return res.status(400).json({ error: 'البيانات المُدخَلة أطول من الحد المسموح' });
  if (!phoneAuth.looksLikePhone(identifier)) return res.status(400).json({ error: PHONE_ONLY_ERROR });

  const idKey = phoneAuth.identifierKey(identifier);
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (!consumeLimit(`fp-ip:${getClientIp(req)}`, 10, FIFTEEN_MIN) || !consumeLimit(`fp-id:${idKey}`, 3, FIFTEEN_MIN)) {
    return res.status(429).json({ error: 'طلبات استعادة كثيرة — حاول مرة أخرى بعد قليل' });
  }

  try {
    const users = await phoneAuth.findUsersByPhone(pool, identifier);
    if (users.length === 0) {
      return res.status(404).json({ error: 'لا يوجد حساب بهذا الرقم' });
    }
    const eligible = users.filter((u) => u.status !== 'revoked');
    if (eligible.length === 0) {
      return res.status(403).json({ error: 'هذا الحساب موقوف — تواصل مع الإدارة' });
    }
    if (eligible.length > 1) {
      return res.status(409).json({ error: 'هذا الرقم مرتبط بأكثر من حساب — اطلب من مسؤول الصيانة أن يعيّن لك كلمة مرور مؤقتة' });
    }
    const user = eligible[0];
    if (!user.phone || !phoneAuth.phoneKey(user.phone)) {
      return res.status(400).json({ error: FORGOT_NO_PHONE });
    }
    const keyRow = await pool.query("SELECT value FROM site_settings WHERE key = 'textmebot_api_key'");
    if (!keyRow.rows[0] || !String(keyRow.rows[0].value || '').trim()) {
      return res.status(503).json({ error: 'خدمة واتساب غير مفعّلة حاليًا — اطلب من مسؤول الصيانة كلمة مرور مؤقتة' });
    }

    await phoneAuth.ensurePasswordResets(pool);
    pool.query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'").catch(() => {});

    const prev = await pool.query(
      'SELECT EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS age_ms FROM password_resets WHERE user_id = $1',
      [user.id]
    );
    if (prev.rows.length > 0 && Number(prev.rows[0].age_ms) < phoneAuth.RESET_RESEND_COOLDOWN_MS) {
      const waitSec = Math.max(1, Math.ceil((phoneAuth.RESET_RESEND_COOLDOWN_MS - Number(prev.rows[0].age_ms)) / 1000));
      res.setHeader('Retry-After', String(waitSec));
      return res.status(429).json({ error: `أُرسل لك رمز قبل قليل — انتظر ${waitSec} ثانية ثم اطلب رمزًا جديدًا إن لم يصل` });
    }

    const code = phoneAuth.newResetCode();
    const hash = phoneAuth.codeHash(JWT_SECRET, user.id, code);
    await pool.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 0, now())
       ON CONFLICT (user_id) DO UPDATE
         SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
      [user.id, hash, String(phoneAuth.RESET_CODE_TTL_MS)]
    );

    // الإرسال في الخلفية (طابور واتساب قد يتأخر ثوانٍ): الرد للمستخدم فوري، وإن
    // فشل الإرسال نمسح الرمز فيستطيع الطلب من جديد مباشرة بلا انتظار الدقيقة.
    const text =
      `صيانتي — رمز استعادة كلمة المرور: ${code}\n` +
      `صالح لمدة ${phoneAuth.RESET_CODE_TTL_MS / 60000} دقيقة. لا تشاركه مع أحد.\n` +
      'إن لم تطلبه أنت فتجاهل هذه الرسالة.';
    Promise.resolve()
      .then(() => sendWhatsappText(user.phone, text))
      .then((r) => {
        if (r && r.ok === false) throw new Error(r.error || `status ${r.statusCode || '?'}`);
      })
      .catch((err) => {
        console.error(`forgot-password: فشل إرسال الرمز للمستخدم ${user.id}:`, err && err.message ? err.message : err);
        return pool.query('DELETE FROM password_resets WHERE user_id = $1 AND code_hash = $2', [user.id, hash]).catch(() => {});
      });

    res.json({
      ok: true,
      maskedPhone: phoneAuth.maskPhone(user.phone),
      expiresInMinutes: phoneAuth.RESET_CODE_TTL_MS / 60000,
      message: `أرسلنا رمزًا من ٦ أرقام إلى واتساب الرقم ${phoneAuth.maskPhone(user.phone)} — قد يستغرق وصوله دقيقة`,
    });
  } catch (err) {
    console.error('POST /api/auth/forgot-password:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع، حاول مرة أخرى' });
  }
});

router.post('/reset-password', async (req, res) => {
  const identifier = pickIdentifier(req.body);
  const { code, newPassword } = req.body || {};
  if (!identifier || (typeof code !== 'string' && typeof code !== 'number') || typeof newPassword !== 'string' || !newPassword) {
    return res.status(400).json({ error: 'رقم الجوال والرمز وكلمة المرور الجديدة إلزامية' });
  }
  if (identifier.length > 200) return res.status(400).json({ error: 'البيانات المُدخَلة أطول من الحد المسموح' });
  if (!phoneAuth.looksLikePhone(identifier)) return res.status(400).json({ error: PHONE_ONLY_ERROR });
  if (newPassword.length > 200) {
    return res.status(400).json({ error: 'كلمة المرور أطول من الحد المسموح (٢٠٠ حرف)' });
  }
  const codeDigits = phoneAuth.digitsOnly(code);
  if (!/^\d{6}$/.test(codeDigits)) {
    return res.status(400).json({ error: 'الرمز مكوّن من ٦ أرقام' });
  }
  if (!isPasswordStrongEnough(newPassword)) {
    return res.status(400).json({ error: PASSWORD_STRENGTH_ERROR });
  }

  const idKey = phoneAuth.identifierKey(identifier);
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (!consumeLimit(`rp-ip:${getClientIp(req)}`, 30, FIFTEEN_MIN) || !consumeLimit(`rp-id:${idKey}`, 10, FIFTEEN_MIN)) {
    return res.status(429).json({ error: 'محاولات كثيرة — حاول مرة أخرى بعد قليل' });
  }

  try {
    await phoneAuth.ensurePasswordResets(pool);
    const users = (await phoneAuth.findUsersByPhone(pool, identifier)).filter((u) => u.status !== 'revoked');
    let target = null;
    for (const u of users) {
      const hash = phoneAuth.codeHash(JWT_SECRET, u.id, codeDigits);
      // استهلاك ذرّي: الحذف الناجح = الرمز صحيح وغير منتهٍ ومحاولاته لم تُستنفد
      // (فلا يُستخدم الرمز مرتين حتى مع طلبين متزامنين).
      const used = await pool.query(
        'DELETE FROM password_resets WHERE user_id = $1 AND code_hash = $2 AND expires_at > now() AND attempts < $3 RETURNING user_id',
        [u.id, hash, phoneAuth.RESET_MAX_ATTEMPTS]
      );
      if (used.rows.length > 0) { target = u; break; }
      await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = $1', [u.id]);
    }
    if (!target) {
      return res.status(400).json({ error: 'الرمز غير صحيح أو منتهي — اطلب رمزًا جديدًا' });
    }
    await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [bcrypt.hash(newPassword), target.id]);
    res.json({ ok: true, message: 'تم تغيير كلمة المرور — سجّل الدخول بها الآن' });
  } catch (err) {
    console.error('POST /api/auth/reset-password:', err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع، حاول مرة أخرى' });
  }
});

// GET /api/auth/me — بيانات المستخدم الحالي (لتحديث الحالة بعد الاعتماد مثلاً)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// PATCH /api/auth/phone — يستخدمه المستخدم لإدخال رقم جواله بعد أول دخول عبر
// جوجل (حين يكون phone فارغًا — جوجل لا توفّره)، أو لتحديثه لاحقًا من إعداداته.
router.patch('/phone', requireAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone || typeof phone !== 'string' && typeof phone !== 'number' || !String(phone).trim()) {
    return res.status(400).json({ error: 'رقم الجوال إلزامي' });
  }
  if (String(phone).trim().length > 20) {
    return res.status(400).json({ error: 'رقم الجوال أطول من الحد المسموح' });
  }
  if (!phoneAuth.phoneKey(phone)) {
    return res.status(400).json({ error: 'رقم الجوال غير صحيح — اكتبه بالأرقام فقط (مثال: 0501234567)' });
  }
  // الرقم هو هوية الدخول: لا نسمح بأخذ رقم مستخدم في حساب آخر.
  if (await phoneAuth.phoneTakenByOther(pool, phone, req.user.id)) {
    return res.status(409).json({ error: 'رقم الجوال هذا مسجّل في حساب آخر' });
  }
  const { rows } = await pool.query(
    'UPDATE users SET phone = $1, updated_at = now() WHERE id = $2 RETURNING id, name, email, role, status, production_facility, safety_facility, phone',
    [String(phone).trim(), req.user.id]
  );
  res.json({ user: publicUser(rows[0]) });
});

// PATCH /api/auth/change-password — يغيّر المستخدم كلمة مروره بنفسه من داخل
// التطبيق (يجب معرفة كلمة المرور الحالية أولًا كإجراء أمان أساسي).
router.patch('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة يجب أن تكونا نصًا' });
  }
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة إلزاميتان' });
  }
  if (currentPassword.length > 200 || newPassword.length > 200) {
    return res.status(400).json({ error: 'كلمة المرور أطول من الحد المسموح (٢٠٠ حرف)' });
  }
  if (!isPasswordStrongEnough(newPassword)) {
    return res.status(400).json({ error: PASSWORD_STRENGTH_ERROR });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (!bcrypt.verify(currentPassword, rows[0].password_hash)) {
    return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
    [bcrypt.hash(newPassword), req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
