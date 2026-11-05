'use strict';
require('./lib/loadEnv').loadEnv(require('path').join(__dirname, '.env'));

const path = require('path');
const { App } = require('./lib/http/app');
const { pool } = require('./config/db');
const { startReportScheduler } = require('./services/reportScheduler');
const { startMaintenanceReportScheduler } = require('./services/maintenanceReportScheduler');
const { startSafetyReportScheduler } = require('./services/safetyReportScheduler');

const app = new App();

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/technicians', require('./routes/technicians'));
app.use('/api/production', require('./routes/production'));
app.use('/api/work-orders', require('./routes/workOrders'));
app.use('/api/safety-permits', require('./routes/safetyPermits'));
app.use('/api/loto', require('./routes/loto'));
app.use('/api/near-miss', require('./routes/nearMiss'));
app.use('/api/injury-reports', require('./routes/injuryReports'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/maintenance-analysis', require('./routes/maintenanceAnalysis'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/custody', require('./routes/custody'));
// الدردشة داخل التطبيق (محادثات خاصة + مجموعات، نص/صور/صوت) — راجع
// routes/chat.js وmigrate-chat.js.
app.use('/api/chat', require('./routes/chat'));
// طلب تصريح عمل من مقاول خارجي عبر رمز QR — مسار عام بلا تسجيل دخول (محميّ
// بحدود إرسال وتحقق صارم) — راجع routes/contractorPermits.js والصفحة
// public/contractor-permit.html.
app.use('/api/contractor-permits', require('./routes/contractorPermits'));
// العمل الإضافي (ساعات العمل الإضافي): أفراد دائمون + سجلات يومية + تقارير يوم/شهر
// + ملخص واتساب — للإداريين فقط (مدير النظام ومسؤول الصيانة) — راجع
// routes/overtime.js. جداوله تُنشأ تلقائيًا عند أول استخدام.
app.use('/api/overtime', require('./routes/overtime'));
// مراقبة مكينة المعمول (البخور): تشغيلات + عيّنات وزن + عيوب + أعطال بستونات/حساسات +
// تحليل أفضل سرعات — لفريق الصيانة وإنتاج مصنع النساء — راجع routes/mamoulMonitor.js.
// جداوله تُنشأ تلقائيًا عند أول استخدام.
app.use('/api/mamoul-monitor', require('./routes/mamoulMonitor'));

// لوحة التحكم (Frontend) — ملف واحد يُخدم مباشرة من public/
app.serveStatic(path.join(__dirname, 'public'));

// نسخة الويب (PWA) من تطبيق صيانتي — تُخدم من public-app/ تحت المسار
// /app (مثال: https://app.almas2.com/app/). هذا المجلد لا يُنشأ تلقائيًا:
// حمّل sayanati-web.zip من رابط الإصدار الثابت على GitHub وفكّه داخل مجلد
// باسم public-app بجانب مجلد public نفسه، ثم أعد تشغيل الخدمة. إن لم يكن
// المجلد موجودًا بعد فلن يحدث أي خطأ — فقط لن تفتح صفحة /app إلى أن يُضاف.
app.serveStaticAt('/app', path.join(__dirname, 'public-app'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ready - listening on port ${PORT}`);
  console.log(`Open in browser: http://localhost:${PORT}`);
});

// جدولة تقارير الإنتاج الأسبوعية/الشهرية التلقائية (بدون أي ضغط زر) —
// راجع services/reportScheduler.js.
startReportScheduler();
startMaintenanceReportScheduler();
startSafetyReportScheduler();

// اختبار اتصال فوري بقاعدة البيانات عند بدء التشغيل — بالإنجليزية بالكامل
// عمدًا (بدون أي حرف عربي) لتفادي مشكلة تشوّه النص العربي في نافذة
// Windows PowerShell القديمة (bidi) لما يُخلط مع نص إنجليزي بنفس السطر.
// هذا يعطي جوابًا فوريًا وواضحًا (نجح/فشل) بدل انتظار تجربة التسجيل من المتصفح.
pool
  .query('SELECT 1')
  .then(() => {
    console.log('[db-check] SUCCESS - connected to PostgreSQL with the current .env credentials.');
  })
  .catch((err) => {
    console.log('==================================================================');
    console.log('[db-check] FAILED - could not connect to PostgreSQL.');
    console.log('[db-check] Error message: ' + (err && err.message ? err.message : String(err)));
    console.log('[db-check] This almost always means DB_PASSWORD in .env does not match');
    console.log('[db-check] the real PostgreSQL password for the DB_USER shown above.');
    console.log('==================================================================');
  });

// لا نريد أن يتوقف السيرفر بالكامل بسبب خطأ غير متوقع في أي مكان
process.on('unhandledRejection', (err) => {
  console.error('خطأ غير متوقع (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  console.error('خطأ غير متوقع (uncaughtException):', err);
});
