const { pool } = require('../config/db');

/// يستبدل كل {{field}} في القالب بقيمة الحقل المقابل من حمولة الحدث الخام
/// (raw payload) — مثال: قالب "بلاغ عطل: {{description}}" مع حمولة
/// {description: "تسريب زيت"} يصبح "بلاغ عطل: تسريب زيت". حقل غير موجود
/// بالحمولة يُستبدل بنص فارغ بدل ترك {{...}} كما هي. يُرجع null إن لم يوجد
/// قالب أصلًا (الويبهوك يعتمد حينها على data الخام بالكامل في الطرف المستقبِل).
function renderTemplate(template, payload) {
  if (!template) return null;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const val = payload ? payload[key] : undefined;
    return val === undefined || val === null ? '' : String(val);
  });
}

/// يرسل إشعارًا لكل الويبهوكات المفعّلة المطابقة لنوع الحدث (مثال: عند إنشاء
/// بلاغ، أو إسناد أمر عمل). يُستخدم هذا لربط واتساب أو أي نظام خارجي —
/// راجع تبويب "إعدادات الموقع" في لوحة التحكم لإضافة/تعديل الويبهوكات.
/// لا يوقف الطلب الأصلي أبدًا حتى لو فشل الإرسال (fire-and-forget).
///
/// [facility] اختياري: مصنع الحدث نفسه إن كان مرتبطًا بخط إنتاج (بلاغات
/// الإنتاج فقط حاليًا). الويبهوك بلا مصنع محدد (facility = NULL في قاعدة
/// البيانات) يستقبل كل أحداث نوعه دائمًا؛ أما الويبهوك المقيَّد بمصنع فلن
/// يستقبل إلا الأحداث التي تحمل نفس المصنع بالضبط.
async function fireWebhook(eventType, payload, facility = null) {
  try {
    const { rows } = await pool.query(
      'SELECT id, url, message_template FROM webhooks WHERE event_type = $1 AND enabled = true AND (facility IS NULL OR facility = $2)',
      [eventType, facility]
    );
    for (const hook of rows) {
      // renderedText: نص جاهز مصاغ حسب قالب الويبهوك (إن وُجد) — تقدر أتمتة
      // واتساب (n8n مثلاً) على استخدامه مباشرة كنص الرسالة بدل بناء تنسيق
      // خاص بها من data الخام في كل مرة.
      const renderedText = renderTemplate(hook.message_template, payload);
      fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventType, data: payload, renderedText, sentAt: new Date().toISOString() }),
      }).catch((err) => {
        console.error(`فشل إرسال ويبهوك (${hook.url}):`, err.message);
      });
    }
  } catch (err) {
    console.error('خطأ أثناء جلب الويبهوكات:', err.message);
  }
}

module.exports = { fireWebhook, renderTemplate };
