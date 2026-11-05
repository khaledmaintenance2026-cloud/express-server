const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
  const match = line.match(/^([^=#]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
});

const { pool } = require('./config/db');
const { sendPushToUsers } = require('./services/push');

(async () => {
  const { rows } = await pool.query(
    'SELECT id, user_id, token, platform, created_at FROM device_tokens ORDER BY created_at DESC'
  );
  console.log('=== التوكنات المسجّلة حالياً ===');
  console.log(JSON.stringify(rows, null, 2));

  if (rows.length === 0) {
    console.log('=== لا يوجد أي توكن مسجَّل — التوقف هنا ===');
    process.exit(0);
  }

  const userId = rows[0].user_id;
  console.log('=== إرسال إشعار Push تجريبي حقيقي للمستخدم رقم', userId, '===');
  await sendPushToUsers([userId], { title: 'اختبار من السيرفر', body: 'هذه رسالة اختبار حقيقية' });
  console.log('=== انتهى الإرسال (راجع أي رسائل [push] أعلاه) ===');
  process.exit(0);
})().catch((e) => {
  console.error('=== خطأ غير متوقع ===', e);
  process.exit(1);
});