'use strict';
/**
 * حماية بسيطة من هجمات "التخمين المتكرر" (brute-force) على تسجيل الدخول —
 * بلا أي حزمة خارجية (الخادم خفيف بدون Express أصلًا)، وبلا حاجة لقاعدة
 * بيانات إضافية لهذا الغرض المؤقت بطبيعته: عدّاد في الذاكرة (Map) يُصفَّر
 * تلقائيًا عند إعادة تشغيل الخدمة — مقبول تمامًا لحجم هذا النظام (خادم واحد،
 * بلا موازنة أحمال بين عدة نسخ تحتاج مشاركة نفس العدّاد).
 *
 * يُحسب المفتاح من أمرين معًا (IP الزائر + البريد المُدخَل)، وليس أحدهما فقط:
 *  - عنوان IP وحده غير كافٍ: مهاجم يبدّل عنوانه (شبكة VPN/بروكسي) يتجاوزه.
 *  - البريد وحده غير كافٍ أيضًا: يسمح لأي عدد من الأجهزة بمهاجمة حسابات
 *    مختلفة معًا من نفس الشبكة دون أي رادع.
 * تتبّع الاثنين معًا يعني: تجاوز محاولات كثيرة على نفس الحساب (من أي عنوان)
 * يُرفض، وتجاوز محاولات كثيرة من نفس العنوان (على أي حساب) يُرفض أيضًا.
 */

const WINDOW_MS = 15 * 60 * 1000; // نافذة العدّ: ١٥ دقيقة
const MAX_ATTEMPTS = 8; // ٨ محاولات فاشلة خلال النافذة تكفي لرفض ما بعدها مؤقتًا

const attempts = new Map(); // key ('ip:x' أو 'email:y') -> { count, firstAttemptAt }

/// يُعيد عنوان IP الحقيقي للزائر. خلف Cloudflare Tunnel (طريقة الوصول من
/// خارج شبكة المصنع الموثّقة في README) تضبط Cloudflare نفسها ترويسة
/// cf-connecting-ip من اتصالها الحقيقي بحافتها (Edge) — أي قيمة يحاول
/// المتصفح إرسالها فيها تُستبدَل قبل وصول الطلب هنا، فلا يمكن لزائر خارجي
/// تزويرها. البديل (x-forwarded-for ثم عنوان الاتصال المباشر) يغطي الوصول
/// من داخل شبكة المصنع محليًا (بلا Cloudflare بينهما أصلًا).
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function pruneAndGet(key) {
  const rec = attempts.get(key);
  if (!rec) return null;
  if (Date.now() - rec.firstAttemptAt > WINDOW_MS) {
    attempts.delete(key);
    return null;
  }
  return rec;
}

// تنظيف دوري (كل ساعة) للمفاتيح منتهية الصلاحية — بدل الاعتماد فقط على
// pruneAndGet عند محاولة دخول جديدة بنفس المفتاح، حتى لا يتضخم الـ Map بلا
// حدود لمفاتيح لن تُستخدَم مجددًا. unref() حتى لا يمنع هذا المؤقّت وحده
// الخدمة من الإغلاق النظيف لو احتاج الأمر يومًا.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.firstAttemptAt > WINDOW_MS) attempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

/// Middleware يُطبَّق قبل منطق تسجيل الدخول نفسه — يرفض الطلب فورًا (429) لو
/// كان أي من مفتاحَي (IP، البريد المُرسَل) قد تجاوز الحد، بدل حتى محاولة
/// التحقق من كلمة المرور. يحفظ المفاتيح على req لاستخدامها لاحقًا في نفس
/// الطلب (تسجيل فشل أو مسح العدّاد عند النجاح) دون إعادة حسابها.
function checkLoginRateLimit(req, res, next) {
  const ip = getClientIp(req);
  // المُعرِّف قد يكون بريدًا أو رقم جوال (حقل identifier الجديد، أو email/phone
  // كما ترسلها النسخ القديمة). الرقم يُختزل لآخر ٩ أرقام فتُحتسب كل صيغ
  // كتابته كحساب واحد، ولا يتجاوز المهاجم الحد بتغيير شكل الرقم.
  const body = req.body || {};
  const rawId = body.identifier || body.email || body.phone;
  let email = null;
  if (typeof rawId === 'string' && rawId.trim()) {
    const t = rawId.trim().toLowerCase();
    if (t.includes('@')) email = t.slice(0, 200);
    else {
      const d = t.replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\D/g, '');
      email = d ? `phone-${d.slice(-9)}` : t.slice(0, 200);
    }
  }
  const keys = [`ip:${ip}`];
  if (email) keys.push(`email:${email}`);
  req._rateLimitKeys = keys;

  for (const key of keys) {
    const rec = pruneAndGet(key);
    if (rec && rec.count >= MAX_ATTEMPTS) {
      const retryAfterSec = Math.max(1, Math.ceil((rec.firstAttemptAt + WINDOW_MS - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'محاولات دخول فاشلة كثيرة جدًا — حاول مرة أخرى بعد قليل' });
    }
  }
  next();
}

/// يُستدعى عند فشل محاولة الدخول فعليًا (بريد غير موجود أو كلمة مرور خاطئة)
/// — يزيد عدّاد كل مفتاح من مفاتيح هذا الطلب (أو ينشئه بعدّاد ١ إن لم يوجد
/// أو انتهت صلاحية نافذته السابقة).
function recordFailedLogin(req) {
  const keys = req._rateLimitKeys || [`ip:${getClientIp(req)}`];
  const now = Date.now();
  for (const key of keys) {
    const rec = attempts.get(key);
    if (!rec || now - rec.firstAttemptAt > WINDOW_MS) {
      attempts.set(key, { count: 1, firstAttemptAt: now });
    } else {
      rec.count += 1;
    }
  }
}

/// يُستدعى عند نجاح الدخول — يمسح عدّادات هذا الطلب حتى لا يبقى مستخدم شرعي
/// نسي كلمة مروره عدة مرات ثم تذكّرها مقيَّدًا بلا داعٍ لبقية النافذة الزمنية.
function clearLoginRateLimit(req) {
  const keys = req._rateLimitKeys || [];
  for (const key of keys) attempts.delete(key);
}

/// عدّاد عام لمسارات أخرى (طلب رمز الاستعادة...): يسجّل محاولة جديدة على
/// المفتاح ويُعيد false لو تجاوز الحد خلال النافذة (والمحاولة المرفوضة لا
/// تُعدّ). يستخدم نفس خريطة الذاكرة، ومفاتيحه تبدأ ببادئة خاصة بكل مسار.
function consumeLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.firstAttemptAt > windowMs) {
    attempts.set(key, { count: 1, firstAttemptAt: now, windowMs });
    return true;
  }
  if (rec.count >= max) return false;
  rec.count += 1;
  return true;
}

module.exports = { checkLoginRateLimit, recordFailedLogin, clearLoginRateLimit, getClientIp, consumeLimit };
