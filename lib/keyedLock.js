'use strict';
/**
 * قفل بسيط بمفتاح (داخل عملية السيرفر الواحدة): الطلبات التي تحمل نفس المفتاح
 * تُنفَّذ واحدًا بعد الآخر بدل التوازي. يُستخدم لمنع "السباق" عند ضغطة مزدوجة
 * على زر قبول/تعيين/تحويل/إنجاز — فالطلب الثاني ينتظر الأول ثم يرى نتيجته
 * (تم القبول مسبقًا) بدل أن يكرّر العملية والإشعارات.
 */
const tails = new Map();

async function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

module.exports = { withLock };
