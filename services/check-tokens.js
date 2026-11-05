const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split(/\r?\n/).forEach((line) => {
  const match = line.match(/^([^=#]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim();
  }
});

const { pool } = require('./config/db');
pool.query('SELECT id, user_id, token, platform, created_at FROM device_tokens ORDER BY created_at DESC')
  .then((r) => {
    console.log(JSON.stringify(r.rows, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });