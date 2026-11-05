'use strict';
// إرسال إشعارات Push حقيقية عبر Firebase Cloud Messaging (FCM) — يكمّل
// الإشعار المحفوظ داخل التطبيق (جدول notifications، راجع services/notifications.js)
// بتنبيه فعلي على الجهاز (صوت + شريط إشعارات) حتى لو كان التطبيق مغلقًا
// تمامًا، بالاعتماد على توكنات الأجهزة المسجَّلة مسبقًا في جدول device_tokens
// (راجع routes/deviceTokens.js وlib/services/push_notification_service.dart في
// تطبيق الجوال/الويب — كلاهما جاهز فعليًا منذ فترة وينتظر فقط هذا الإرسال).
//
// بلا أي حزمة خارجية (لا firebase-admin ولا googleapis) — تمامًا بنفس فلسفة
// بقية السيرفر (راجع lib/jwtLite.js وlib/pgLite.js): نوقّع بأنفسنا طلب دخول
// OAuth2 القياسي لحسابات خدمة Google (JWT بتوقيع RS256 عبر وحدة crypto
// المدمجة في Node)، نستبدله بتوكن دخول من Google، ثم نستدعي مباشرة REST API
// الرسمي لـFCM (v1) عبر fetch المدمجة — بنفس أسلوب services/webhooks.js
// وservices/textmebot.js تمامًا.
//
// الإعداد المطلوب مرة واحدة فقط: نزّلوا ملف مفتاح حساب خدمة من إعدادات
// مشروع Firebase: ⚙️ إعدادات المشروع ← حسابات الخدمة (Service accounts) ←
// "إنشاء مفتاح خاص جديد" (Generate new private key) — يُنزَّل ملف JSON.
// احفظوه بالاسم التالي بالضبط في جذر مجلد السيرفر:
//   C:\sayanati-server\firebase-service-account.json
// بدون هذا الملف يستمر النظام بالعمل بشكل طبيعي تمامًا (واتساب + الإشعار
// داخل التطبيق) لكن بلا أي Push فعلي — نتجاهل الإرسال بصمت مع تسجيل ملاحظة
// واحدة فقط في اللوق.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');

// ويندوز يُخفي امتداد الملف افتراضيًا، فيُحفظ الملف أحيانًا باسم
// firebase-service-account.json.json بدل الاسم الصحيح — نقبل الاسمين معًا
// حتى لا يتعطّل Push بسبب هذا الخطأ الشائع.
const SERVICE_ACCOUNT_CANDIDATES = [
  path.join(__dirname, '..', 'firebase-service-account.json'),
  path.join(__dirname, '..', 'firebase-service-account.json.json'),
];
function findServiceAccountPath() {
  return SERVICE_ACCOUNT_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let serviceAccount = null;
let serviceAccountLoadAttempted = false;
let warnedMissing = false;

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0; // Date.now() بالمللي ثانية

function loadServiceAccount() {
  if (serviceAccountLoadAttempted) return serviceAccount;
  serviceAccountLoadAttempted = true;
  const SERVICE_ACCOUNT_PATH = findServiceAccountPath();
  if (!SERVICE_ACCOUNT_PATH) {
    if (!warnedMissing) {
      console.log(
        '[push] لم يُعثر على firebase-service-account.json في جذر مجلد السيرفر — ' +
        'سيتم تجاهل إرسال إشعارات Push الحقيقية (الإشعار داخل التطبيق وواتساب يستمران كالمعتاد بلا تأثر).'
      );
      warnedMissing = true;
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key || !json.project_id) {
      console.error('[push] ملف firebase-service-account.json ناقص (يلزم client_email وprivate_key وproject_id).');
      return null;
    }
    serviceAccount = json;
    return serviceAccount;
  } catch (err) {
    console.error('[push] تعذّر قراءة firebase-service-account.json:', err.message);
    return null;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// يوقّع JWT بمعيار RS256 (المطلوب لحسابات خدمة Google) باستخدام المفتاح
// الخاص من ملف حساب الخدمة — بديل يدوي بسيط عن مكتبة googleapis.
function signServiceAccountJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(account.private_key).toString('base64url');
  return `${signingInput}.${signature}`;
}

// يستبدل JWT الموقَّع بتوكن دخول (Access Token) صالح لساعة واحدة من Google —
// يُخزَّن مؤقتًا (Cache) ويُجدَّد فقط عند اقترابه من الانتهاء، بدل طلب جديد
// مع كل إشعار.
async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }
  const account = loadServiceAccount();
  if (!account) return null;

  const assertion = signServiceAccountJwt(account);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`تعذّر الحصول على توكن دخول Google (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  // نجدّد قبل الانتهاء الفعلي بخمس دقائق احتياطًا لفروق التوقيت.
  cachedAccessTokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedAccessToken;
}

// يرسل رسالة Push واحدة لتوكن جهاز واحد عبر REST API الرسمي لـFCM (v1).
// يُعيد 'invalid' لو رفضتها Firebase نهائيًا (توكن منتهي/تطبيق مُزال) حتى
// نحذفه من device_tokens ولا نحاول إرساله للأبد بلا فائدة.
async function sendToToken(projectId, accessToken, token, { title, body }) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: body || '' },
      },
    }),
  });
  if (res.ok) return 'ok';

  const data = await res.json().catch(() => null);
  const status = data && data.error && data.error.status;
  if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
    return 'invalid';
  }
  console.error(`[push] فشل إرسال Push (${res.status}, ${status || 'بلا تفاصيل'})`);
  return 'error';
}

// نقطة الدخول الرئيسية — تُستدعى بجانب insertNotificationForUsers في
// services/notifications.js. لا ترمي أبدًا؛ أي تعذّر (ملف إعداد ناقص، لا
// توكنات مسجَّلة، خطأ شبكة) يُسجَّل فقط في اللوق ولا يوقف أي مسار آخر —
// تمامًا كإرسال واتساب.
async function sendPushToUsers(userIds, { title, body }) {
  try {
    const ids = Array.from(new Set((userIds || []).filter(Boolean)));
    if (ids.length === 0) return;

    const account = loadServiceAccount();
    if (!account) return;

    const { rows } = await pool.query('SELECT token FROM device_tokens WHERE user_id = ANY($1)', [ids]);
    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
      // إعداد Firebase سليم، لكن لا يوجد جهاز مسجَّل بعد لأي من هؤلاء
      // المستخدمين (لم يفتحوا التطبيق منذ التفعيل مثلًا، أو لم يمنحوا إذن
      // الإشعارات) — نسجّلها للتشخيص بدل الصمت الكامل.
      console.log(`[push] لا توجد أجهزة مسجَّلة حاليًا للمستخدمين المستهدفين (${ids.length}) — تم تجاهل إرسال "${title}".`);
      return;
    }

    const accessToken = await getAccessToken();
    if (!accessToken) return;

    const results = await Promise.all(
      tokens.map((token) => sendToToken(account.project_id, accessToken, token, { title, body }))
    );

    const okCount = results.filter((r) => r === 'ok').length;
    const invalidTokens = tokens.filter((_, i) => results[i] === 'invalid');
    if (invalidTokens.length > 0) {
      await pool.query('DELETE FROM device_tokens WHERE token = ANY($1)', [invalidTokens]);
    }
    console.log(
      `[push] "${title}" → أُرسل بنجاح لـ${okCount}/${tokens.length} جهاز` +
      (invalidTokens.length > 0 ? ` (${invalidTokens.length} توكن منتهي/غير صالح حُذف)` : '')
    );
  } catch (err) {
    console.error('[push] تعذّر إرسال إشعار Push:', err.message);
  }
}

module.exports = { sendPushToUsers };