// تكامل مباشر مع TextMeBot (api.textmebot.com) لإرسال رسائل واتساب فورية —
// بديل أبسط عن تمرير الإشعارات عبر أتمتة خارجية (n8n) لمن لا يملك "ويبهوك
// استقبال" جاهزًا هناك؛ يُستخدم حاليًا فقط لروابط تقارير الإنتاج (المخصص/
// الأسبوعي/الشهري) — راجع routes/production.js و services/reportScheduler.js.
//
// صيغة نداء TextMeBot (موثّقة من api.textmebot.com/web_send.php):
//   https://api.textmebot.com/send.php?recipient=[رقم]&apikey=[المفتاح]&text=[نص]
// مثال رسمي من توثيقهم: recipient=+9665XXXXXXXX — يعني الرقم الفردي يحتاج
// صيغة دولية بعلامة + في البداية (بلا صفر بداية الرقم المحلي). أما الجروبات
// فمعرّفها رقمي منتهٍ بـ @g.us (كما هو ظاهر في أتمتة n8n السابقة للعميل).
'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return rows[0] && rows[0].value ? rows[0].value : null;
}

/// يحوّل رقم جوال سعودي محلي (مثل 05XXXXXXXX) لصيغة دولية بعلامة + في
/// البداية (مثل +9665XXXXXXXX) وهي الصيغة التي يطلبها TextMeBot بالضبط.
/// أرقام مُدخلة أصلاً بصيغة دولية (966... أو +966... أو حتى 00966...) تُعاد
/// لنفس الصيغة الصحيحة دون تكرار مفتاح الدولة.
function normalizePhoneNumber(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, ''); // إزالة كل شيء عدا الأرقام (بما فيها +)
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2); // 00966... -> 966...
  if (digits.startsWith('0') && digits.length === 10) digits = `966${digits.slice(1)}`; // 05xxxxxxxx -> 966 5xxxxxxxx
  if (!digits.startsWith('966')) digits = `966${digits}`; // رقم بلا مفتاح دولة أصلًا (افتراض سعودي)
  return `+${digits}`;
}

/// معرّفات الجروبات (تنتهي بـ @g.us) أو أي معرّف واتساب جاهز آخر (@c.us) تُترك
/// كما هي دون أي تعديل — التطبيع أعلاه مخصص للأرقام الفردية فقط.
function resolveRecipient(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/@g\.us$/i.test(trimmed) || /@c\.us$/i.test(trimmed)) return trimmed;
  return normalizePhoneNumber(trimmed);
}

// ---------------------------------------------------------------------------
// طابور إرسال: رسالة واحدة في كل مرة، بفاصل زمني بين كل رسالتين.
// السبب: حدث واحد (إسناد أمر عمل لعدة فنيين مثلًا) كان يُطلق عدة رسائل
// واتساب في نفس اللحظة تقريبًا (جروب + كل فني + رافع البلاغ)، وسجل السيرفر
// أظهر أن رفض TextMeBot (403) يقع غالبًا على الرسائل المتزامنة هذه. الطابور
// يفرّقها زمنيًا.
//
// تصحيح (2026-10-12): رد TextMeBot الفعلي في السجل على كل رفض هو
//   {"status":"error","comment":"8 sec. Delay needed"}
// أي أن الخدمة تشترط ٨ ثوانٍ على الأقل بين كل رسالتين، بينما كان الفاصل ٣
// ثوانٍ فقط — فكانت كل رسالة تقريبًا تُرفض ثم تُعاد بعد مهلة، فتتأخر الرسائل
// وتتراكم. الفاصل الافتراضي الآن ٨٫٥ ثانية (قابل للضبط من .env عبر
// TEXTMEBOT_MIN_GAP_MS)، وعند الرفض ننتظر المدة التي تذكرها الخدمة نفسها.
// وللحماية من التكرار: نفس الرسالة لنفس المستلم خلال ١٢٠ ثانية تُرسَل مرة واحدة.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function minGapMs() {
  const n = Number(process.env.TEXTMEBOT_MIN_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 8500;
}

// مهلة طلب واحد لـ TextMeBot — بدونها يبقى طلب معلّق يسدّ الطابور كله حتى
// تنتهي مهلة النظام الطويلة (دقائق) فتتأخر كل الرسائل خلفه.
const REQUEST_TIMEOUT_MS = 20000;

// منع تكرار الرسالة نفسها لنفس المستلم (ضغطة مزدوجة، إعادة إرسال من التطبيق،
// إعادة محاولة...). المفتاح = بصمة المستلم + النص.
const DEDUPE_WINDOW_MS = 120000;
const recentMessages = new Map(); // بصمة → وقت أول إرسال
function messageKey(recipient, text) {
  return crypto.createHash('sha1').update(`${recipient}\n${text}`).digest('hex');
}
function isRecentDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of recentMessages) {
    if (now - t > DEDUPE_WINDOW_MS) recentMessages.delete(k);
  }
  return recentMessages.has(key);
}

// مدة الانتظار قبل إعادة المحاولة بعد رفض 403/429: نقرأ الرقم من رد الخدمة
// ("8 sec. Delay needed") ونضيف ثانية أمان، وإلا ضعف الفاصل.
function retryDelayMs(result) {
  const m = /(\d+)\s*sec/i.exec((result && result.body) || '');
  if (m) return Math.max(minGapMs(), (Number(m[1]) + 1) * 1000);
  return Math.max(minGapMs(), 6000);
}
function isDelayRejection(result) {
  return /delay|sec\./i.test((result && result.body) || '');
}

let queueTail = Promise.resolve();
let lastSentAt = 0;

function enqueue(task) {
  const run = queueTail.then(async () => {
    const wait = lastSentAt + minGapMs() - Date.now();
    if (wait > 0) await sleep(wait);
    let sent = true;
    try {
      const out = await task();
      if (out && out.noSend) sent = false; // لم يخرج أي طلب فعلي (مثل غياب المفتاح): لا نبدأ فاصلًا جديدًا
      return out;
    } finally {
      if (sent) lastSentAt = Date.now();
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function fetchOnce(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const bodyText = await response.text().catch(() => '');
    return { ok: response.ok, statusCode: response.status, body: bodyText };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/// يرسل رسالة نصية عبر واتساب مباشرة (بدون أي وسيط) لرقم فردي أو جروب.
/// يرجع {ok, statusCode?, body?, error?} دائمًا (لا يرمي استثناءً أبدًا) حتى
/// يسهل على المستدعي عرض تحذير للمستخدم بدل فشل الطلب بالكامل.
async function sendWhatsappText(rawRecipient, text) {
  const recipient = resolveRecipient(rawRecipient);
  if (!recipient) {
    return { ok: false, error: 'missing_recipient' };
  }
  // نفس الرسالة لنفس المستلم أُرسلت/تنتظر الإرسال قبل لحظات → نتجاهلها (لا نكرّرها).
  const key = messageKey(recipient, text);
  if (isRecentDuplicate(key)) {
    console.log(`[textmebot] تجاهل رسالة مكررة لنفس المستلم خلال ${DEDUPE_WINDOW_MS / 1000} ثانية.`);
    return { ok: true, skipped: 'duplicate' };
  }
  recentMessages.set(key, Date.now());
  // الدخول للطابور يتم فورًا وبترتيب الاستدعاء (قراءة المفتاح من القاعدة داخل
  // المهمة نفسها) — حتى تخرج الرسائل بنفس ترتيب طلبها: مقدّم التصريح أولًا ثم
  // الجروب مثلًا، لا بترتيب انتهاء استعلامات القاعدة العشوائي.
  const result = await enqueue(async () => {
    const apiKey = await getSetting('textmebot_api_key');
    if (!apiKey) {
      return { ok: false, error: 'missing_api_key', noSend: true };
    }
    const url =
      `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(recipient)}` +
      `&apikey=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(text)}&json=yes`;
    let r = await fetchOnce(url);
    // رفض بسبب الفاصل الزمني: نعيد حتى مرتين بعد المدة التي تطلبها الخدمة؛
    // أي رفض 403/429 آخر نعيده مرة واحدة فقط.
    let retries = 0;
    const maxRetries = (res) => (isDelayRejection(res) ? 2 : 1);
    while (!r.ok && (r.statusCode === 403 || r.statusCode === 429) && retries < maxRetries(r)) {
      retries += 1;
      await sleep(retryDelayMs(r));
      r = await fetchOnce(url);
    }
    return r;
  });
  // فشل نهائي (غير مهلة): نسمح بإعادة إرسال نفس الرسالة لاحقًا. المهلة قد تكون
  // وصلت فعلًا فنُبقي البصمة لمنع التكرار.
  if (!result.ok && (result.statusCode !== undefined || result.noSend)) recentMessages.delete(key);
  return result;
}

module.exports = { sendWhatsappText, normalizePhoneNumber, resolveRecipient };
