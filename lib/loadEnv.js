'use strict';
/**
 * قارئ بسيط لملف .env (بدون حزمة dotenv الخارجية) — يقرأ ملف .env من جذر
 * المشروع ويضبط process.env، بدون الكتابة فوق متغيرات مضبوطة مسبقًا فعليًا
 * (مثلاً عبر PowerShell $env:).
 */
const fs = require('fs');
const path = require('path');

function loadEnv(filePath = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  ملف الإعدادات غير موجود: ${filePath} — سيُستخدم القيم الافتراضية (قد تكون خاطئة).`);
    return;
  }
  const buf = fs.readFileSync(filePath);
  let content;
  // بعض برامج التحرير (مثل Notepad) قد تحفظ الملف بترميز UTF-16 بدل UTF-8
  // خصوصًا لو كان يحتوي نصًا عربيًا — لو قرأناه كـ UTF-8 مباشرة ستظهر بايتات
  // فارغة (\0) بين كل حرف وتفشل قراءة كل المتغيرات بصمت (بدون أي خطأ ظاهر).
  // نتحقق من BOM لتحديد الترميز الصحيح تلقائيًا:
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    content = buf.slice(2).toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    content = buf.slice(2).swap16().toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    content = buf.slice(3).toString('utf8');
  } else {
    content = buf.toString('utf8');
  }
  const loadedKeys = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
    loadedKeys.push(key);
  }

  // تشخيص سريع يظهر عند بدء السيرفر مباشرة: يؤكد أن الملف قُرئ بشكل صحيح
  // وأن كل متغير أساسي وصل بقيمة (بدون كشف كلمة المرور نفسها).
  const essential = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET', 'SEED_ADMIN_EMAILS'];
  const missing = essential.filter((k) => !loadedKeys.includes(k));
  console.log(`📄 تم قراءة .env من: ${filePath}`);
  console.log(
    `   DB_HOST=${process.env.DB_HOST || '(افتراضي: localhost)'} | DB_PORT=${process.env.DB_PORT || '(افتراضي: 5432)'} | ` +
      `DB_NAME=${process.env.DB_NAME || '(افتراضي: sayanati_db)'} | DB_USER=${process.env.DB_USER || '(افتراضي: postgres)'} | ` +
      `DB_PASSWORD=${process.env.DB_PASSWORD ? '(تم تحميلها، طولها ' + process.env.DB_PASSWORD.length + ' حرف)' : '⚠️ غير موجودة! سيُستخدم الافتراضي الخاطئ "postgres"'}`
  );
  if (missing.length) {
    console.warn(`⚠️  المتغيرات التالية غير موجودة في .env أو لم تُقرأ بشكل صحيح: ${missing.join(', ')}`);
  }
}

module.exports = { loadEnv };
