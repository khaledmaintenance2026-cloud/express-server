'use strict';
/**
 * أدوات الدخول والتسجيل برقم الجوال + استعادة كلمة المرور عبر واتساب.
 *
 * الفكرة: رقم الجوال في جدول users نص حر كما كتبه المستخدم ("0501234567" أو
 * "+966 50 123 4567"...). للمطابقة عند الدخول نقارن "مفتاح الرقم" = آخر ٩
 * أرقام (الرقم الوطني السعودي بلا الصفر ولا مفتاح الدولة)، فتتطابق كل صيغ
 * الكتابة لنفس الجوال.
 *
 * عمود email في users إلزامي وفريد (NOT NULL UNIQUE) وتعتمد عليه نسخ التطبيق
 * القديمة، فالحساب المسجَّل برقم الجوال فقط يأخذ بريدًا اصطلاحيًا لا يُستخدم
 * للمراسلة أبدًا: phone-966501234567@phone.sayanati.local — فلا نغيّر بنية
 * الجدول ولا نكسر أي شاشة.
 */
const crypto = require('crypto');

const PLACEHOLDER_EMAIL_DOMAIN = 'phone.sayanati.local';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/// يحوّل الأرقام العربية/الفارسية إلى لاتينية ويُبقي الأرقام فقط.
function digitsOnly(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  s = s.replace(/[٠-٩]/g, (c) => String(ARABIC_DIGITS.indexOf(c)));
  s = s.replace(/[۰-۹]/g, (c) => String(PERSIAN_DIGITS.indexOf(c)));
  return s.replace(/\D/g, '');
}

/// هل المُدخَل يبدو رقم جوال (بلا @ وفيه ٨ أرقام على الأقل)؟
function looksLikePhone(raw) {
  if (typeof raw !== 'string') return false;
  if (raw.includes('@')) return false;
  const d = digitsOnly(raw);
  return d.length >= 8 && d.length <= 15;
}

/// مفتاح المطابقة: آخر ٩ أرقام. null لو الرقم قصير جدًا أو طويل جدًا.
function phoneKey(raw) {
  const d = digitsOnly(raw);
  if (d.length < 8 || d.length > 15) return null;
  return d.slice(-9);
}

/// الرقم بصيغته المخزَّنة للحسابات الجديدة: للأرقام السعودية الصيغة المحلية
/// المألوفة 05xxxxxxxx (تفهمها normalizePhoneNumber في textmebot.js وتحوّلها
/// إلى +9665xxxxxxxx)، وغير ذلك تبقى الأرقام فقط.
function canonicalStoredPhone(raw) {
  let d = digitsOnly(raw);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966') && d.length === 12) d = d.slice(3);
  if (d.length === 9 && d.startsWith('5')) d = `0${d}`;
  return d;
}

/// البريد الاصطلاحي لحساب مسجَّل برقم الجوال فقط.
function placeholderEmailFor(raw) {
  const d = digitsOnly(raw);
  const national = d.startsWith('966') && d.length === 12 ? d : d.length === 10 && d.startsWith('05') ? `966${d.slice(1)}` : d.length === 9 && d.startsWith('5') ? `966${d}` : d;
  return `phone-${national}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/// مفتاح عدّادات الحماية لمُعرِّف الدخول (بريد أو جوال) — نفس المنطق في rateLimit.js.
function identifierKey(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t.includes('@')) return t.slice(0, 200);
  const k = phoneKey(t);
  return k ? `phone-${k}` : t.slice(0, 200);
}

/// آخر ٤ أرقام للعرض ("••••4567") حتى يتأكد المستخدم من الرقم دون كشفه كاملًا.
function maskPhone(raw) {
  const d = digitsOnly(raw);
  return d.length >= 4 ? `••••${d.slice(-4)}` : '••••';
}

// ---- تعبير SQL موحّد لمفتاح الرقم المخزَّن (يتعامل مع الأرقام العربية أيضًا) ----
const SQL_PHONE_KEY =
  "right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\\D', '', 'g'), 9)";

/// كل المستخدمين الذين رقمهم يطابق المُدخَل (قد يكون أكثر من حساب لو تشارك
/// شخصان نفس الرقم في حسابات قديمة). الأحدث أولًا للمعتمدين.
async function findUsersByPhone(pool, raw) {
  const key = phoneKey(raw);
  if (!key) return [];
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE ${SQL_PHONE_KEY} = $1
     ORDER BY (status = 'approved') DESC, id ASC LIMIT 10`,
    [key]
  );
  return rows;
}

async function findUsersByEmail(pool, raw) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(raw).trim().toLowerCase()]);
  return rows;
}

/// يحدّد المستخدمين المطابقين لمُعرِّف الدخول (بريد أو جوال).
async function findUsersByIdentifier(pool, identifier) {
  if (typeof identifier !== 'string') return [];
  const trimmed = identifier.trim();
  if (!trimmed) return [];
  if (trimmed.includes('@')) return findUsersByEmail(pool, trimmed);
  // بلا @: رقم جوال، أو "بريد" قديم مسجَّل بلا @ (كان التطبيق يقبل أي نص، وفي النظام
  // حسابات فعلية بريدها كلمة مثل khaled) — نجمع الاثنين حتى لا ينقطع دخول أحد.
  const byPhone = await findUsersByPhone(pool, trimmed);
  const byEmail = await findUsersByEmail(pool, trimmed);
  const seen = new Set();
  return [...byPhone, ...byEmail].filter((u) => !seen.has(String(u.id)) && seen.add(String(u.id)));
}

/// هل رقم الجوال هذا مستخدم في حساب آخر غير [exceptUserId]؟ يُرجِع أول حساب مطابق أو null.
/// الرقم هو هوية الدخول، فلا نسمح لحسابين جديدين/معدَّلين بنفس الرقم.
async function phoneTakenByOther(pool, raw, exceptUserId) {
  const users = await findUsersByPhone(pool, raw);
  return users.find((u) => String(u.id) !== String(exceptUserId)) || null;
}

// ---- رموز استعادة كلمة المرور ----
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

let resetTableReady = null;
function ensurePasswordResets(pool) {
  if (!resetTableReady) {
    resetTableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS password_resets (
           user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
           code_hash  TEXT NOT NULL,
           expires_at TIMESTAMPTZ NOT NULL,
           attempts   INT NOT NULL DEFAULT 0,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .catch((err) => {
        resetTableReady = null; // نعيد المحاولة في الطلب التالي
        throw err;
      });
  }
  return resetTableReady;
}

function codeHash(secret, userId, code) {
  return crypto.createHmac('sha256', secret).update(`${userId}:${code}`).digest('hex');
}

function newResetCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/// كلمة مرور مؤقتة سهلة القراءة والنقل شفهيًا: بلا I/l/O/o/0/1، فيها حرف ورقم
/// دائمًا (تجتاز isPasswordStrongEnough)، طولها ١٠.
function generateTemporaryPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < 10) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

module.exports = {
  PLACEHOLDER_EMAIL_DOMAIN,
  digitsOnly,
  looksLikePhone,
  phoneKey,
  canonicalStoredPhone,
  placeholderEmailFor,
  isPlaceholderEmail,
  maskPhone,
  findUsersByPhone,
  findUsersByEmail,
  findUsersByIdentifier,
  phoneTakenByOther,
  ensurePasswordResets,
  codeHash,
  newResetCode,
  identifierKey,
  generateTemporaryPassword,
  RESET_CODE_TTL_MS,
  RESET_MAX_ATTEMPTS,
  RESET_RESEND_COOLDOWN_MS,
};
