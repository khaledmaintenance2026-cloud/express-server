// ترحيل: الدردشة داخل التطبيق (محادثات خاصة بين شخصين + مجموعات، نص وصور
// وتسجيلات صوتية). يمكن تشغيله يدويًا من مجلد السيرفر:
//   node migrate-chat.js
// آمن للتشغيل أكثر من مرة (كل الأوامر IF NOT EXISTS) ولا يمس أي جدول موجود.
//
// ملاحظة: routes/chat.js يستدعي ensureChatSchema() أدناه تلقائيًا عند أول طلب
// دردشة بعد تشغيل السيرفر، فلا يتعطل شيء لو نُسي تشغيل هذا الملف يدويًا.

//
// الجداول:
//   chat_rooms    — غرفة واحدة لكل محادثة: kind = 'direct' (خاصة بين شخصين، ولا
//                   تتكرر لنفس الشخصين بفضل direct_key) أو 'group' (مجموعة لها اسم).
//   chat_members  — أعضاء كل غرفة + آخر رسالة قرأها كل عضو (لحساب غير المقروء).
//   chat_messages — الرسائل: text / image / audio، أو system (إضافة/مغادرة عضو...).
//                   العمود deleted_at يُملأ عند "حذف عند الجميع" (تبقى الصفّة كأثر
//                   "تم حذف هذه الرسالة" بلا محتواها).
//   chat_message_hidden — "حذف عندي": رسائل أخفاها مستخدم عن شاشته فقط.
const { pool } = require('./config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS chat_rooms (
    id               BIGSERIAL PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    name             TEXT,
    direct_key       TEXT UNIQUE,
    created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS chat_members (
    room_id               BIGINT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_admin              BOOLEAN NOT NULL DEFAULT false,
    last_read_message_id  BIGINT NOT NULL DEFAULT 0,
    joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id            BIGSERIAL PRIMARY KEY,
    room_id       BIGINT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'audio', 'system')),
    body          TEXT,
    media_path    TEXT,
    duration_sec  INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
  `CREATE TABLE IF NOT EXISTS chat_message_hidden (
    message_id  BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_chat_message_hidden_user ON chat_message_hidden(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)',
];

async function ensureChatSchema() {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}

module.exports = { ensureChatSchema };

// التشغيل المباشر (node migrate-chat.js) فقط — لا يعمل عند استدعائه من chat.js
if (require.main === module) {
  (async () => {
    try {
      await ensureChatSchema();
      console.log('OK');
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
