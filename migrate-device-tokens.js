const { pool } = require('./config/db');

pool.query(
  "CREATE TABLE IF NOT EXISTS device_tokens (" +
  "id SERIAL PRIMARY KEY, " +
  "user_id INTEGER NOT NULL, " +
  "token TEXT NOT NULL UNIQUE, " +
  "platform VARCHAR(20) NOT NULL DEFAULT 'android', " +
  "created_at TIMESTAMP NOT NULL DEFAULT NOW())"
)
  .then(() => {
    console.log('OK');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });