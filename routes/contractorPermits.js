'use strict';
/**
 * طلب تصريح عمل من مقاول خارجي عبر رمز QR — بلا حساب وبلا تسجيل دخول.
 *
 * المقاول يمسح الـ QR فتفتح له صفحة public/contractor-permit.html (نفس حقول
 * استمارة طلب التصريح في التطبيق)، وعند الإرسال يصل الطلب إلى هنا. بعدها يسير
 * الطلب بنفس مسار طلبات التطبيق بالضبط:
 *   1) يُحفظ في جدول safety_permits فيظهر لقسم السلامة داخل التطبيق (بطاقة
 *      "بانتظار الاعتماد") ويُقبل أو يُرفض من هناك (PATCH /api/safety-permits/:id/review).
 *   2) يصل جروب السلامة ولكل مستخدمي السلامة إشعار "هناك طلب تصريح عمل".
 *   3) يصل رقم المقاول (المكتوب في الاستمارة) رسالة واتساب فورية "تم استلام طلبك رقم X".
 *   4) عند قرار السلامة (قبول/رفض) يصل الرد لجروب السلامة ولنفس رقم المقاول
 *      تلقائيًا — لأن إشعار safety_permit_reviewed يرسل أصلًا لعمود
 *      responsible_phone (راجع services/notifications.js)، ولا يحتاج هذا الملف
 *      لأي كود إضافي لذلك.
 *
 * بما أن هذا المسار مفتوح للعموم (بلا requireAuth) وكل طلب ناجح يُرسل رسالة
 * واتساب لرقم يكتبه الزائر، فهو محميّ بطبقات (وراجعتها مراجعة أمنية مستقلة):
 *   - الرقم يجب أن يكون جوالًا سعوديًا صحيحًا (05xxxxxxxx) — قرار صاحب النظام.
 *   - حدود إرسال: لكل عنوان IP، ولكل رقم جوال (حتى لا يُستخدم النظام لإزعاج
 *     رقم بعينه)، وحد إجمالي يومي كصمّام أمان. تُحجز الحصة فورًا وبشكل متزامن
 *     قبل أي عملية غير متزامنة، فلا يمكن تجاوزها بإرسال طلبات متوازية.
 *   - رسالة الاستلام للمقاول ثابتة النص (رقم الطلب + الموقع من القائمة المغلقة
 *     فقط) — لا تُكرِّر أي نص كتبه الزائر، فلا تصلح لإرسال رسائل مضلِّلة
 *     لأرقام الغير. وعدد رسائل الاستلام المنتظرة في الطابور محدود حتى لا
 *     تؤخر تنبيهات الصيانة والسلامة العاجلة.
 *   - حقل مصيدة مخفي (honeypot) يملؤه الروبوتات فقط.
 *   - تحقق صارم من كل حقل (قائمة مغلقة للموقع وأنواع العمل، حدود أطوال النصوص،
 *     إزالة رموز < و > من النصوص الحرة حتى لا يصل HTML إلى أي تقرير لاحق).
 *   - الصورة: png/jpeg فقط، بالتحقق من بصمة الملف الفعلية وأبعاده (حماية من
 *     "قنبلة الصور")، بحد أقصى ٦ ميجابايت، وتُكتب على القرص بعد اجتياز كل
 *     التحققات، وتُحذف لو فشل الحفظ في قاعدة البيانات.
 *   - الاستجابة لا تُرجع إلا رقم الطلب — لا بيانات تصاريح أخرى إطلاقًا.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { fireWebhook } = require('../services/webhooks');
const { withLock } = require('../lib/keyedLock');
const { notifyEvent } = require('../services/notifications');
const { sendWhatsappText } = require('../services/textmebot');
const { getClientIp } = require('../lib/rateLimit');

const router = new Router();

// نفس القوائم تمامًا في routes/safetyPermits.js وتطبيق صيانتي (constants.dart).
const OPERATION_TYPES = ['hot_work', 'confined_space', 'height', 'electrical', 'excavation', 'lifting', 'other'];
const FACILITY_LOCATIONS = ['المستودع العام', 'مصنع الرجال', 'مصنع النساء'];

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'safety-permits');
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_PHOTO_SIDE = 8000; // بكسل (الصفحة ترسل ≤ ١٢٨٠)
const MAX_PHOTO_PIXELS = 40 * 1000 * 1000;

// اسم حقل المصيدة: عمدًا ليس اسمًا مألوفًا (website/url/phone...) حتى لا
// تملأه خاصية الإكمال التلقائي في المتصفح فيُرفض مستخدم حقيقي.
const HONEYPOT_FIELD = 'zqNote';

// ---------------------------------------------------------------------------
// حدود الإرسال (في الذاكرة — تُصفَّر مع إعادة تشغيل الخدمة، مقبول لحجم النظام)
// ---------------------------------------------------------------------------
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = {
  ip: { max: 6, windowMs: HOUR, message: 'عدد كبير من الطلبات من هذا الجهاز — حاول بعد ساعة أو تواصل مع قسم السلامة' },
  phone: { max: 5, windowMs: DAY, message: 'تم تقديم عدة طلبات لهذا الرقم اليوم — تواصل مع قسم السلامة مباشرة' },
  global: { max: 100, windowMs: DAY, message: 'الخدمة مشغولة حاليًا — تواصل مع قسم السلامة مباشرة' },
};
const hits = new Map(); // key -> number[] (أوقات الحجز)

function recentHits(key, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length > 0) hits.set(key, list);
  else hits.delete(key);
  return list;
}

/// يحجز حصة الطلب فورًا (متزامنًا تمامًا — بلا أي await بين الفحص والحجز) —
/// يُعيد { message } لو تجاوز أي حد، وإلا { release } لإلغاء الحجز عند فشل
/// الحفظ بسبب خطأ من جهتنا (حتى لا يُحرم المقاول من حصته بلا ذنب).
function reserveQuota(keys) {
  for (const [kind, key] of keys) {
    const { max, windowMs, message } = LIMITS[kind];
    if (recentHits(key, windowMs).length >= max) return { message };
  }
  const stamp = Date.now() + Math.random(); // طابع فريد لهذا الحجز
  for (const [, key] of keys) {
    const list = hits.get(key) || [];
    list.push(stamp);
    hits.set(key, list);
  }
  return {
    release() {
      for (const [, key] of keys) {
        const list = (hits.get(key) || []).filter((t) => t !== stamp);
        if (list.length > 0) hits.set(key, list);
        else hits.delete(key);
      }
    },
  };
}

// تنظيف دوري حتى لا يتضخم الـ Map (unref لا يمنع إغلاق الخدمة).
setInterval(() => {
  for (const key of Array.from(hits.keys())) recentHits(key, DAY);
}, HOUR).unref();

// مفتاح الجهاز: IPv6 يُجمَّع على مستوى /64 (مستخدم واحد قد يملك آلاف
// العناوين داخل نفس الـ/64 فيتحايل على الحد بتبديلها).
function clientKey(req) {
  const ip = String(getClientIp(req) || 'unknown').toLowerCase();
  if (ip.includes(':') && !ip.startsWith('::ffff:')) {
    const parts = ip.split(':');
    if (parts.length >= 4) return parts.slice(0, 4).join(':');
  }
  return ip;
}

// عدد رسائل الاستلام المنتظرة في طابور واتساب — سقف صغير حتى لا يُغرق
// المقاولون الطابور المشترك فتتأخر تنبيهات الصيانة والسلامة العاجلة.
const MAX_PENDING_RECEIPTS = 10;
let pendingReceipts = 0;

// ---------------------------------------------------------------------------
// أدوات التحقق
// ---------------------------------------------------------------------------

// يحوّل الأرقام العربية-الهندية والفارسية (٠١٢...) إلى 0123 — المقاول قد يكتب
// رقمه بلوحة مفاتيح عربية.
function toAsciiDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/// يقبل جوالًا سعوديًا بأي من الصيغ: 05xxxxxxxx / 5xxxxxxxx / 9665xxxxxxxx /
/// +9665xxxxxxxx / 009665xxxxxxxx (مع مسافات أو شرطات) ويعيده بصيغة محلية
/// موحّدة 05xxxxxxxx، أو null لو الرقم ليس جوالًا سعوديًا صحيحًا.
function parseSaudiMobile(raw) {
  if (raw === undefined || raw === null) return null;
  let d = toAsciiDigits(raw).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `0${d}` : null;
}

// نص حر: يجب أن يكون نصًا؛ يُزال منه رموز التحكم و< و> وأي نصف زوج
// "surrogate" يتيم (يُسقط encodeURIComponent عند إرسال واتساب)، ثم يُقصّ
// بحد أقصى بعدد الأحرف الفعلية (code points) لا وحدات UTF-16.
function cleanText(value, { max, multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const controls = multiline ? /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  const cleaned = value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(controls, ' ')
    .replace(/[<>]/g, '')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('').trim() : cleaned;
}

// تاريخ/وقت اختياري بصيغة datetime-local (YYYY-MM-DDTHH:mm[:ss]) أو ISO كامل
// — null لو فارغ، undefined لو غير صالح. الصيغة صارمة عمدًا: Date.parse في
// Node يقبل نصوصًا فضفاضة ("2026" أو "Oct 5 2026") ترفضها PostgreSQL.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
function parseOptionalDateTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  const now = Date.now();
  if (t < now - 366 * DAY || t > now + 2 * 366 * DAY) return undefined;
  return value;
}

// يقرأ أبعاد PNG/JPEG من ترويسة الملف (بلا فك ضغط الصورة نفسها).
function imageSize(buf, ext) {
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  } catch (_) { /* يُعامَل كصورة غير صالحة */ }
  return null;
}

// يتحقق من صورة المعدات (data URL) ويعيد { buf, ext } أو null — بلا أي كتابة
// على القرص (الكتابة لاحقًا بعد اجتياز كل التحققات والحجز).
function decodePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length < 100) return null;
  if (buf.length > MAX_PHOTO_BYTES) {
    throw Object.assign(new Error('حجم الصورة غير مقبول (الحد الأقصى ٦ ميجابايت)'), { statusCode: 400 });
  }
  let ext = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = 'png';
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpeg';
  if (!ext) return null;
  const size = imageSize(buf, ext);
  if (!size || size.w < 1 || size.h < 1) return null;
  if (size.w > MAX_PHOTO_SIDE || size.h > MAX_PHOTO_SIDE || size.w * size.h > MAX_PHOTO_PIXELS) {
    throw Object.assign(new Error('أبعاد الصورة كبيرة جدًا — صغّر الصورة أو التقط صورة جديدة'), { statusCode: 400 });
  }
  return { buf, ext };
}

function writePhoto({ buf, ext }) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { publicPath: `/uploads/safety-permits/${filename}`, filePath: path.join(UPLOAD_DIR, filename) };
}

function bad(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// POST /api/contractor-permits
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // حقل المصيدة: بشر لا يرونه (مخفي بالـCSS) فلا يملؤونه — أي قيمة = روبوت.
  // نردّ بنجاح وهمي (permitId: null) بلا أي حفظ أو إرسال حتى لا يعرف الروبوت
  // أنه كُشف. صفحة المقاول تعامل الاستجابة بلا permitId كخطأ ولا تعرض "نجاحًا".
  if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
    return res.status(201).json({ ok: true, permitId: null });
  }

  const contractorName = cleanText(body.contractorName, { max: 80 });
  const officeName = cleanText(body.officeName, { max: 120 });
  const location = FACILITY_LOCATIONS.includes(body.location) ? body.location : null;
  const locationDetail = cleanText(body.locationDetail, { max: 150 });
  const description = cleanText(body.description, { max: 1000, multiline: true });
  const equipmentUsed = cleanText(body.equipmentUsed, { max: 300 });
  const phone = parseSaudiMobile(body.phone);
  const types = Array.isArray(body.operationTypes)
    ? Array.from(new Set(body.operationTypes.filter((t) => OPERATION_TYPES.includes(t))))
    : [];

  if (contractorName.length < 3) return bad(res, 'اكتب اسم المسؤول عن العمل (٣ أحرف على الأقل)');
  if (officeName.length < 2) return bad(res, 'اكتب اسم الشركة أو المؤسسة');
  if (!location) return bad(res, 'اختر موقع العمل');
  if (description.length < 5) return bad(res, 'اكتب وصفًا واضحًا للعمل (٥ أحرف على الأقل)');
  if (types.length === 0) return bad(res, 'اختر نوع عمل واحدًا على الأقل');
  if (!phone) return bad(res, 'اكتب رقم جوال سعودي صحيح يبدأ بـ 05 ليصلك الرد على واتساب');

  let workersCount = 1;
  if (body.workersCount !== undefined && body.workersCount !== null && body.workersCount !== '') {
    workersCount = Number(toAsciiDigits(body.workersCount));
    if (!Number.isInteger(workersCount) || workersCount < 1 || workersCount > 500) {
      return bad(res, 'عدد العمال يجب أن يكون رقمًا صحيحًا بين ١ و٥٠٠');
    }
  }

  const startAt = parseOptionalDateTime(body.startAt);
  const endAt = parseOptionalDateTime(body.endAt);
  if (startAt === undefined || endAt === undefined) return bad(res, 'تاريخ ووقت العمل غير صحيح');
  if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) {
    return bad(res, 'وقت نهاية العمل يجب أن يكون بعد وقت البداية');
  }

  if (!body.equipmentPhoto) return bad(res, 'صورة المعدات أو موقع العمل إلزامية');
  let photo;
  try {
    photo = decodePhoto(body.equipmentPhoto);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
  if (!photo) return bad(res, 'صيغة الصورة غير مقبولة — استخدم صورة JPG أو PNG');

  // كل التحققات اجتازت — نحجز الحصة الآن (متزامنًا) قبل أي عملية غير متزامنة.
  const quota = reserveQuota([['ip', `ip:${clientKey(req)}`], ['phone', `phone:${phone}`], ['global', 'global']]);
  if (quota.message) return res.status(429).json({ error: quota.message });

  let saved = null;
  let permit;
  try {
    const fullLocation = locationDetail ? `${location} — ${locationDetail}` : location;
    // حماية من تكرار الإرسال: المقاول بلا حساب فيضغط "إرسال" عدة مرات حين تبطؤ
    // الشبكة (فتصل الطلبات نفسها وتصل رسائل واتساب مكررة). الفحص والإدخال داخل
    // قفل لكل رقم جوال، وإن وُجد طلب مطابق (نفس الرقم والموقع والوصف) خلال آخر
    // ١٠ دقائق نعيد رقمه نفسه بنجاح بدون إنشاء تصريح جديد ولا إشعارات جديدة.
    const result = await withLock(`contractor-permit:${phone}`, async () => {
      const dup = await pool.query(
        `SELECT id FROM safety_permits
          WHERE requested_by_user IS NULL AND responsible_phone = $1
            AND location = $2 AND description = $3
            AND requested_at > now() - interval '10 minutes'
          ORDER BY id DESC LIMIT 1`,
        [phone, fullLocation, description]
      );
      if (dup.rows.length > 0) return { duplicateOf: dup.rows[0].id };

      saved = writePhoto(photo);
      const { rows } = await pool.query(
        `INSERT INTO safety_permits
           (office_name, location, description, requested_by, requested_by_user, start_at, end_at,
            workers_count, responsible_phone, operation_types, equipment_used, equipment_photo, related_work_order_id)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,NULL) RETURNING *`,
        [
          officeName,
          fullLocation,
          description,
          `${contractorName} (مقاول عبر QR)`,
          startAt,
          endAt,
          workersCount,
          phone,
          types,
          equipmentUsed || null,
          saved.publicPath,
        ]
      );
      return { permit: rows[0] };
    });
    if (result.duplicateOf) {
      quota.release();
      return res.status(201).json({ ok: true, permitId: result.duplicateOf });
    }
    permit = result.permit;
  } catch (err) {
    // فشل الحفظ (تاريخ غير منطقي مثل 31 فبراير، قاعدة البيانات...): نحذف الصورة
    // اليتيمة ونرجع الحصة ثم نترك الراوتر يرد 500 العادي.
    if (saved) fs.unlink(saved.filePath, () => {});
    quota.release();
    // 22007/22008: تاريخ لا وجود له (مثل 31 فبراير) مرّ من فحص الصيغة — خطأ إدخال لا خطأ سيرفر.
    if (err && (err.code === '22007' || err.code === '22008')) return bad(res, 'تاريخ ووقت العمل غير صحيح');
    throw err;
  }

  // نفس إشعارات طلب التصريح من التطبيق: ويبهوك + جروب السلامة + إشعار داخلي
  // لكل مستخدمي السلامة. notifyEvent لا يرمي أبدًا، والـcatch للاحتياط فقط.
  try { fireWebhook('safety_permit_requested', permit); } catch (err) { console.error('[contractorPermits] webhook:', err.message); }
  Promise.resolve(notifyEvent('safety_permit_requested', permit)).catch((err) => {
    console.error('[contractorPermits] notifyEvent:', err.message);
  });

  // رسالة الاستلام الفورية للمقاول (تمر عبر طابور الإرسال في textmebot.js).
  // نصها ثابت عمدًا: رقم الطلب + الموقع من القائمة المغلقة فقط، بلا أي نص
  // كتبه الزائر (راجع تعليق أعلى الملف).
  if (pendingReceipts < MAX_PENDING_RECEIPTS) {
    pendingReceipts += 1;
    const receipt =
      `✅ تم استلام طلب تصريح العمل — مصنع الماس الوطنية\n` +
      `رقم الطلب: ${permit.id}\n` +
      `الموقع: ${location}\n\n` +
      `سيراجع قسم السلامة طلبك، وسيصلك الرد (قبول أو رفض) على هذا الرقم.\n` +
      `⚠️ لا تبدأ العمل قبل وصول رسالة القبول.`;
    sendWhatsappText(phone, receipt)
      .then((r) => {
        if (!r.ok) console.error(`[contractorPermits] تعذّر إرسال رسالة الاستلام للتصريح ${permit.id}:`, r.error || r.statusCode);
      })
      .catch((err) => console.error('[contractorPermits] receipt:', err.message))
      .then(() => { pendingReceipts -= 1; });
  } else {
    console.log(`[contractorPermits] طابور رسائل الاستلام ممتلئ — لم تُرسَل رسالة الاستلام للتصريح ${permit.id} (الطلب نفسه حُفظ).`);
  }

  res.status(201).json({ ok: true, permitId: permit.id });
});

module.exports = router;
module.exports._test = { parseSaudiMobile, cleanText, hits, clientKey };
