const { PgLitePool } = require('../lib/pgLite');

// يقرأ إعدادات الاتصال من متغيرات البيئة (.env) — راجع .env.example
// ملاحظة: نستخدم عميل PostgreSQL خفيف بدون اعتماديات خارجية (lib/pgLite.js)
// بدل حزمة "pg" — راجع التعليق أعلى ذلك الملف لسبب هذا الاختيار. الواجهة
// (pool.query / pool.connect) مطابقة لحزمة pg تمامًا.
const pool = new PgLitePool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'sayanati_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

module.exports = { pool };
