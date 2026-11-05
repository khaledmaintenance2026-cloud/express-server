// الدردشة داخل التطبيق — محادثات خاصة بين شخصين ومجموعات، برسائل نصية وصور
// وتسجيلات صوتية. الجداول: chat_rooms / chat_members / chat_messages (راجع
// migrate-chat.js). كل مستخدم يرى فقط الغرف التي هو عضو فيها.
//
// الوسائط (صور وصوت) تُرسل كنص base64 (data URL) داخل جسم JSON — نفس أسلوب صور
// تصاريح السلامة وبلاغات الأعطال (لا يوجد رفع multipart في هذا الخادم الخفيف)،
// وتُحفظ كملفات تحت public/uploads/chat/ بأسماء عشوائية غير قابلة للتخمين.
//
// التنبيه بالرسائل الجديدة: شارة غير مقروء داخل التطبيق (unread_count لكل غرفة،
// يستطلعها التطبيق دوريًا) + إشعار Push عبر Firebase (services/push.js) — دون
// حفظه في جدول notifications حتى لا تزدحم قائمة الإشعارات برسائل الدردشة.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('../lib/http/router');
const { pool } = require('../config/db');
const { requireAuth, requireApproved } = require('../middleware/auth');
const { sendPushToUsers } = require('../services/push');
const { ensureChatSchema } = require('../migrate-chat');

const router = new Router();
router.use(requireAuth, requireApproved);

// ينشئ جداول الدردشة تلقائيًا عند أول طلب بعد تشغيل السيرفر لو لم تكن موجودة
// (نفس أوامر migrate-chat.js، كلها IF NOT EXISTS) — فلا يتعطل شيء لو نُسي تشغيله.
let schemaReady = null;
router.use(async (req, res, next) => {
  if (!schemaReady) {
    schemaReady = ensureChatSchema().catch((err) => {
      schemaReady = null; // نعيد المحاولة عند الطلب التالي
      throw err;
    });
  }
  await schemaReady;
  next();
});

// حسابات "قسم عام" و"مقاول" لا تستخدم الدردشة (لا تظهر لها في التطبيق أصلًا)،
// ولا تظهر في قائمة اختيار الأشخاص لغيرها. لتغيير هذا القرار عدّلوا هذه القائمة فقط.
const CHAT_EXCLUDED_ROLES = ['general', 'contractor'];

const MAX_TEXT_LENGTH = 4000;
const MAX_CAPTION_LENGTH = 1000;
const MAX_GROUP_NAME_LENGTH = 60;
const MAX_GROUP_MEMBERS = 100;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 900; // ١٥ دقيقة كحد أقصى لتسجيل واحد
const PAGE_SIZE = 50;

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'chat');

router.use((req, res, next) => {
  if (CHAT_EXCLUDED_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'الدردشة غير متاحة لهذا النوع من الحسابات' });
  }
  next();
});

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// حد بسيط لمنع إغراق الدردشة بالرسائل (٤٠ رسالة في الدقيقة لكل مستخدم) —
// في الذاكرة فقط، يكفي لحماية السيرفر من خطأ برمجي أو تلاعب بسيط.
const recentSends = new Map();
function sendingTooFast(userId) {
  const now = Date.now();
  const recent = (recentSends.get(userId) || []).filter((t) => now - t < 60 * 1000);
  if (recent.length >= 40) {
    recentSends.set(userId, recent);
    return true;
  }
  recent.push(now);
  recentSends.set(userId, recent);
  return false;
}

const IMAGE_EXT = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg', webp: 'webp' };
const AUDIO_EXT = {
  webm: 'webm', ogg: 'ogg', mp4: 'm4a', 'x-m4a': 'm4a', m4a: 'm4a', aac: 'aac',
  mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav',
};

function looksLikeImage(buf, ext) {
  if (ext === 'png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

// يتحقق من ملف الوسائط (data URL) ويحفظه على القرص. يعيد { path } عند النجاح
// أو { error } برسالة عربية جاهزة للعرض.
function saveMedia(kind, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return { error: 'الملف المرفق مفقود' };
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return { error: 'صيغة الملف المرفق غير صحيحة' };
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const m = /^data:(image|audio)\/([a-z0-9.+-]+)((?:;[^;,]*)*);base64$/i.exec(header);
  if (!m || m[1].toLowerCase() !== kind) return { error: 'نوع الملف المرفق غير مدعوم' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { error: 'محتوى الملف المرفق غير صالح' };

  const subtype = m[2].toLowerCase();
  const ext = (kind === 'image' ? IMAGE_EXT : AUDIO_EXT)[subtype];
  if (!ext) return { error: 'صيغة الملف المرفق غير مدعومة' };

  const buf = Buffer.from(data, 'base64');
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (buf.length === 0) return { error: 'الملف المرفق فارغ' };
  if (buf.length > limit) {
    return { error: kind === 'image' ? 'حجم الصورة كبير (الحد ٨ ميجابايت)' : 'حجم التسجيل كبير (الحد ٦ ميجابايت)' };
  }
  if (kind === 'image' && !looksLikeImage(buf, ext)) return { error: 'الملف المرفق ليس صورة صالحة' };

  const filename = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { path: `/uploads/chat/${filename}` };
}

// يحذف ملف صورة/صوت من القرص عند "حذف عند الجميع" (المسار يُبنى من الاسم فقط
// داخل مجلد الدردشة، فلا يمكن الخروج منه).
function removeMediaFile(mediaPath) {
  if (typeof mediaPath !== 'string' || !mediaPath.startsWith('/uploads/chat/')) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(mediaPath)));
  } catch (_) {
    // الملف محذوف مسبقًا — لا مشكلة
  }
}

function previewText(kind, body) {
  if (kind === 'image') return body ? `📷 ${body}` : '📷 صورة';
  if (kind === 'audio') return '🎤 رسالة صوتية';
  return body || '';
}

// عناصر الاستعلام المشترك لقائمة الغرف: آخر رسالة، عدد غير المقروء، الطرف
// الآخر في المحادثة الخاصة. $1 دائمًا = معرّف المستخدم الحالي.
const ROOM_SELECT = `
  SELECT r.id, r.kind, r.name, r.created_by, r.created_at, r.last_message_at,
         m.is_admin,
         (SELECT COUNT(*) FROM chat_members cm WHERE cm.room_id = r.id) AS member_count,
         (SELECT COUNT(*) FROM chat_messages x
           WHERE x.room_id = r.id AND x.id > m.last_read_message_id
             AND x.sender_id IS DISTINCT FROM $1 AND x.kind <> 'system'
             AND x.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id = x.id AND h.user_id = $1)) AS unread_count,
         lm.id AS last_id, lm.kind AS last_kind, lm.body AS last_body, lm.deleted_at AS last_deleted_at,
         lm.sender_id AS last_sender_id, ls.name AS last_sender_name,
         lm.created_at AS last_created_at,
         ou.id AS other_user_id, ou.name AS other_user_name
    FROM chat_members m
    JOIN chat_rooms r ON r.id = m.room_id
    LEFT JOIN LATERAL (
      SELECT z.* FROM chat_messages z
       WHERE z.room_id = r.id
         AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id = z.id AND h.user_id = $1)
       ORDER BY z.id DESC LIMIT 1
    ) lm ON true
    LEFT JOIN users ls ON ls.id = lm.sender_id
    LEFT JOIN chat_members om ON om.room_id = r.id AND r.kind = 'direct' AND om.user_id <> $1
    LEFT JOIN users ou ON ou.id = om.user_id
   WHERE m.user_id = $1`;

function mapRoom(r) {
  return {
    id: r.id,
    kind: r.kind,
    // اسم المحادثة الخاصة = اسم الطرف الآخر، واسم المجموعة كما حُفظ
    name: r.kind === 'direct' ? (r.other_user_name || 'مستخدم محذوف') : (r.name || 'مجموعة'),
    other_user_id: r.other_user_id || null,
    is_admin: !!r.is_admin,
    member_count: r.member_count,
    unread_count: r.unread_count,
    created_by: r.created_by,
    created_at: r.created_at,
    last_message_at: r.last_message_at,
    last_message: r.last_id
      ? {
          id: r.last_id,
          kind: r.last_kind,
          body: r.last_body,
          deleted: !!r.last_deleted_at,
          sender_id: r.last_sender_id,
          sender_name: r.last_sender_name,
          created_at: r.last_created_at,
        }
      : null,
  };
}

async function loadRoomForUser(roomId, userId) {
  const { rows } = await pool.query(`${ROOM_SELECT} AND r.id = $2`, [userId, roomId]);
  return rows.length > 0 ? mapRoom(rows[0]) : null;
}

async function getMembership(roomId, userId) {
  const { rows } = await pool.query(
    'SELECT room_id, user_id, is_admin, last_read_message_id FROM chat_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return rows[0] || null;
}

// المستخدمون المؤهلون للدردشة (معتمدون وليسوا من الأدوار المستثناة) من بين
// المعرّفات المعطاة.
async function eligibleUsers(ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, name FROM users WHERE id = ANY($1) AND status = 'approved' AND role <> ALL($2)`,
    [ids, CHAT_EXCLUDED_ROLES]
  );
  return rows;
}

async function addSystemMessage(client, roomId, actorId, text) {
  await client.query(
    `INSERT INTO chat_messages (room_id, sender_id, kind, body) VALUES ($1, $2, 'system', $3)`,
    [roomId, actorId, text]
  );
  await client.query('UPDATE chat_rooms SET last_message_at = now() WHERE id = $1', [roomId]);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // تجاهل — الخطأ الأصلي هو المهم
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /api/chat/users — قائمة الأشخاص الذين يمكن بدء محادثة أو إضافتهم لمجموعة
// (الاسم والدور فقط — بلا بريد أو جوال).
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, role FROM users
      WHERE status = 'approved' AND id <> $1 AND role <> ALL($2)
      ORDER BY name`,
    [req.user.id, CHAT_EXCLUDED_ROLES]
  );
  res.json({ users: rows });
});

// ---------------------------------------------------------------------------
// GET /api/chat/rooms — غرف المستخدم الحالي مرتبة بالأحدث، مع غير المقروء.
// ---------------------------------------------------------------------------
router.get('/rooms', async (req, res) => {
  const { rows } = await pool.query(`${ROOM_SELECT} ORDER BY r.last_message_at DESC LIMIT 200`, [req.user.id]);
  const rooms = rows.map(mapRoom);
  const totalUnread = rooms.reduce((sum, r) => sum + Number(r.unread_count || 0), 0);
  res.json({ rooms, unread_total: totalUnread });
});

// ---------------------------------------------------------------------------
// POST /api/chat/rooms — محادثة خاصة {kind:'direct', userId} (تُعاد الموجودة لو
// سبق فتحها) أو مجموعة {kind:'group', name, memberIds:[...]}.
// ---------------------------------------------------------------------------
router.post('/rooms', async (req, res) => {
  const me = req.user;
  const kind = req.body.kind;

  if (kind === 'direct') {
    const otherId = parseId(req.body.userId);
    if (!otherId || otherId === me.id) return fail(res, 400, 'اختر شخصًا آخر لبدء المحادثة');
    const others = await eligibleUsers([otherId]);
    if (others.length === 0) return fail(res, 404, 'هذا المستخدم غير متاح للدردشة');

    const directKey = [me.id, otherId].sort((a, b) => a - b).join(':');
    let roomId;
    let created = false;
    const existing = await pool.query('SELECT id FROM chat_rooms WHERE direct_key = $1', [directKey]);
    if (existing.rows.length > 0) {
      roomId = existing.rows[0].id;
    } else {
      roomId = await inTransaction(async (client) => {
        const ins = await client.query(
          `INSERT INTO chat_rooms (kind, direct_key, created_by) VALUES ('direct', $1, $2)
           ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
          [directKey, me.id]
        );
        if (ins.rows.length === 0) {
          // سبقنا طلب متزامن لنفس الشخصين — نستخدم الغرفة التي أنشأها
          const again = await client.query('SELECT id FROM chat_rooms WHERE direct_key = $1', [directKey]);
          return again.rows[0].id;
        }
        const id = ins.rows[0].id;
        await client.query(
          `INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [id, me.id, otherId]
        );
        created = true;
        return id;
      });
    }
    const room = await loadRoomForUser(roomId, me.id);
    return res.status(created ? 201 : 200).json({ room });
  }

  if (kind === 'group') {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return fail(res, 400, 'اسم المجموعة إلزامي');
    if (name.length > MAX_GROUP_NAME_LENGTH) return fail(res, 400, `اسم المجموعة طويل (الحد ${MAX_GROUP_NAME_LENGTH} حرفًا)`);

    const requested = Array.isArray(req.body.memberIds)
      ? Array.from(new Set(req.body.memberIds.map(parseId).filter((id) => id && id !== me.id)))
      : [];
    if (requested.length === 0) return fail(res, 400, 'اختر عضوًا واحدًا على الأقل');
    if (requested.length + 1 > MAX_GROUP_MEMBERS) return fail(res, 400, `الحد الأقصى ${MAX_GROUP_MEMBERS} عضو في المجموعة`);
    const members = await eligibleUsers(requested);
    if (members.length === 0) return fail(res, 400, 'لا يوجد أعضاء صالحون بين من اخترتهم');

    const roomId = await inTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO chat_rooms (kind, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
        [name, me.id]
      );
      const id = ins.rows[0].id;
      await client.query(`INSERT INTO chat_members (room_id, user_id, is_admin) VALUES ($1, $2, true)`, [id, me.id]);
      for (const member of members) {
        await client.query(`INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2)`, [id, member.id]);
      }
      await addSystemMessage(client, id, me.id, `${me.name} أنشأ المجموعة`);
      return id;
    });

    sendPushToUsers(members.map((m) => m.id), {
      title: name,
      body: `${me.name} أضافك إلى المجموعة`,
    });

    const room = await loadRoomForUser(roomId, me.id);
    return res.status(201).json({ room });
  }

  return fail(res, 400, 'نوع المحادثة غير صحيح');
});

// ---------------------------------------------------------------------------
// GET /api/chat/rooms/:id — تفاصيل الغرفة وأعضاؤها (لأعضائها فقط).
// ---------------------------------------------------------------------------
router.get('/rooms/:id', async (req, res) => {
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const room = await loadRoomForUser(roomId, req.user.id);
  if (!room) return fail(res, 404, 'المحادثة غير موجودة');
  const { rows } = await pool.query(
    `SELECT m.user_id, m.is_admin, m.joined_at, u.name, u.role
       FROM chat_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
      ORDER BY m.is_admin DESC, u.name`,
    [roomId]
  );
  res.json({ room, members: rows });
});

// ---------------------------------------------------------------------------
// GET /api/chat/rooms/:id/messages
//   بدون معاملات: آخر ٥٠ رسالة.
//   ?afterId=N : الرسائل الأحدث من N (للاستطلاع الدوري، حتى ٢٠٠).
//   ?beforeId=N : ٥٠ رسالة أقدم من N (تحميل المزيد عند التمرير للأعلى).
// الرسائل مرتبة من الأقدم للأحدث دائمًا. read_up_to = آخر رسالة قرأها كل
// الأعضاء الآخرين (لعلامة "تمت القراءة" على رسائلك).
// ---------------------------------------------------------------------------
router.get('/rooms/:id/messages', async (req, res) => {
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, req.user.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');

  const afterId = parseId(req.query.afterId);
  const beforeId = parseId(req.query.beforeId);
  const select = `SELECT m.id, m.room_id, m.sender_id, u.name AS sender_name, m.kind, m.body,
                         m.media_path, m.duration_sec, m.created_at, m.deleted_at
                    FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id`;
  // الرسائل التي أخفاها هذا المستخدم ("حذف عندي") لا تُعاد له أبدًا
  const notHidden = (p) =>
    `AND NOT EXISTS (SELECT 1 FROM chat_message_hidden h WHERE h.message_id = m.id AND h.user_id = $${p})`;

  let messages;
  let hasMore = false;
  let deletedIds = [];
  if (afterId) {
    const { rows } = await pool.query(
      `${select} WHERE m.room_id = $1 AND m.id > $2 ${notHidden(3)} ORDER BY m.id ASC LIMIT 200`,
      [roomId, afterId, req.user.id]
    );
    messages = rows;
    // الاستطلاع الدوري يحمل أيضًا معرّفات الرسائل التي حُذفت عند الجميع منذ
    // آخر مرة (من checkFrom فصاعدًا) ليحدّثها التطبيق عند من حمّلها مسبقًا.
    const checkFrom = parseId(req.query.checkFrom);
    if (checkFrom) {
      const del = await pool.query(
        'SELECT id FROM chat_messages WHERE room_id = $1 AND id >= $2 AND deleted_at IS NOT NULL ORDER BY id LIMIT 500',
        [roomId, checkFrom]
      );
      deletedIds = del.rows.map((r) => Number(r.id));
    }
  } else {
    const params = beforeId ? [roomId, beforeId, PAGE_SIZE + 1, req.user.id] : [roomId, PAGE_SIZE + 1, req.user.id];
    const sql = beforeId
      ? `${select} WHERE m.room_id = $1 AND m.id < $2 ${notHidden(4)} ORDER BY m.id DESC LIMIT $3`
      : `${select} WHERE m.room_id = $1 ${notHidden(3)} ORDER BY m.id DESC LIMIT $2`;
    const { rows } = await pool.query(sql, params);
    hasMore = rows.length > PAGE_SIZE;
    messages = rows.slice(0, PAGE_SIZE).reverse();
  }

  const read = await pool.query(
    'SELECT MIN(last_read_message_id) AS read_up_to FROM chat_members WHERE room_id = $1 AND user_id <> $2',
    [roomId, req.user.id]
  );
  res.json({
    messages,
    has_more: hasMore,
    read_up_to: read.rows[0] ? Number(read.rows[0].read_up_to || 0) : 0,
    deleted_ids: deletedIds,
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat/rooms/:id/messages
//   {kind:'text', body}
//   {kind:'image', media:'data:image/jpeg;base64,...', body?: تعليق}
//   {kind:'audio', media:'data:audio/mp4;base64,...', durationSec}
// ---------------------------------------------------------------------------
router.post('/rooms/:id/messages', async (req, res) => {
  const me = req.user;
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, me.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');
  if (sendingTooFast(me.id)) return fail(res, 429, 'ترسل رسائل بسرعة كبيرة، انتظر قليلًا');

  const kind = req.body.kind || 'text';
  let body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  let mediaPath = null;
  let durationSec = null;

  if (kind === 'text') {
    if (!body) return fail(res, 400, 'الرسالة فارغة');
    if (body.length > MAX_TEXT_LENGTH) return fail(res, 400, `الرسالة طويلة (الحد ${MAX_TEXT_LENGTH} حرف)`);
  } else if (kind === 'image' || kind === 'audio') {
    if (body.length > MAX_CAPTION_LENGTH) return fail(res, 400, `التعليق طويل (الحد ${MAX_CAPTION_LENGTH} حرف)`);
    if (kind === 'audio') {
      body = '';
      const d = Number(req.body.durationSec);
      durationSec = Number.isFinite(d) && d >= 0 ? Math.min(Math.round(d), MAX_AUDIO_SECONDS) : null;
    }
    const saved = saveMedia(kind, req.body.media);
    if (saved.error) return fail(res, 400, saved.error);
    mediaPath = saved.path;
  } else {
    return fail(res, 400, 'نوع الرسالة غير صحيح');
  }

  const message = await inTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO chat_messages (room_id, sender_id, kind, body, media_path, duration_sec)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [roomId, me.id, kind, body || null, mediaPath, durationSec]
    );
    const row = ins.rows[0];
    await client.query('UPDATE chat_rooms SET last_message_at = $2 WHERE id = $1', [roomId, row.created_at]);
    // رسالتك نفسها تُعتبر مقروءة عندك
    await client.query(
      `UPDATE chat_members SET last_read_message_id = GREATEST(last_read_message_id, $3)
        WHERE room_id = $1 AND user_id = $2`,
      [roomId, me.id, row.id]
    );
    return row;
  });

  res.status(201).json({
    message: {
      id: message.id,
      room_id: roomId,
      sender_id: me.id,
      sender_name: me.name,
      kind,
      body: body || null,
      media_path: mediaPath,
      duration_sec: durationSec,
      created_at: message.created_at,
      deleted_at: null,
    },
  });

  // إشعار Push لبقية الأعضاء — بعد الردّ، بلا انتظار، ولا يرمي أبدًا.
  notifyOtherMembers(roomId, me, kind, body).catch((err) => {
    console.error('[chat] تعذّر إرسال إشعار رسالة جديدة:', err.message);
  });
});

async function notifyOtherMembers(roomId, sender, kind, body) {
  const roomRes = await pool.query('SELECT kind, name FROM chat_rooms WHERE id = $1', [roomId]);
  if (roomRes.rows.length === 0) return;
  const room = roomRes.rows[0];
  const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE room_id = $1 AND user_id <> $2', [roomId, sender.id]);
  const ids = membersRes.rows.map((r) => r.user_id);
  if (ids.length === 0) return;
  let preview = previewText(kind, body);
  if (preview.length > 120) preview = `${preview.slice(0, 117)}...`;
  if (room.kind === 'group') {
    sendPushToUsers(ids, { title: room.name || 'مجموعة', body: `${sender.name}: ${preview}` });
  } else {
    sendPushToUsers(ids, { title: sender.name, body: preview });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/chat/rooms/:id/messages/:msgId?scope=me|all
//   me  (الافتراضي): "حذف عندي" — تختفي الرسالة من شاشتك فقط، ويراها الباقون.
//   all: "حذف عند الجميع" — لصاحب الرسالة فقط وبلا مهلة زمنية؛ يُمسح محتواها
//        (النص/الصورة/الصوت) وتبقى لدى الجميع كأثر "تم حذف هذه الرسالة".
//        رسائل النظام (إنشاء مجموعة/إضافة/مغادرة) لا تُحذف عند الجميع.
// ---------------------------------------------------------------------------
router.delete('/rooms/:id/messages/:msgId', async (req, res) => {
  const me = req.user;
  const roomId = parseId(req.params.id);
  const msgId = parseId(req.params.msgId);
  if (!roomId || !msgId) return fail(res, 404, 'الرسالة غير موجودة');
  const membership = await getMembership(roomId, me.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');

  const found = await pool.query(
    'SELECT id, sender_id, kind, media_path, deleted_at FROM chat_messages WHERE id = $1 AND room_id = $2',
    [msgId, roomId]
  );
  if (found.rows.length === 0) return fail(res, 404, 'الرسالة غير موجودة');
  const msg = found.rows[0];

  if (req.query.scope !== 'all') {
    await pool.query(
      'INSERT INTO chat_message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [msgId, me.id]
    );
    return res.json({ ok: true, scope: 'me' });
  }

  if (msg.kind === 'system') return fail(res, 400, 'لا يمكن حذف رسائل النظام عند الجميع');
  if (msg.sender_id === null || Number(msg.sender_id) !== Number(me.id)) {
    return fail(res, 403, 'يمكنك حذف رسائلك أنت فقط عند الجميع');
  }
  if (!msg.deleted_at) {
    await pool.query(
      'UPDATE chat_messages SET deleted_at = now(), body = NULL, media_path = NULL, duration_sec = NULL WHERE id = $1',
      [msgId]
    );
    removeMediaFile(msg.media_path);
  }
  res.json({ ok: true, scope: 'all' });
});

// ---------------------------------------------------------------------------
// POST /api/chat/rooms/:id/read — تحديد المحادثة كمقروءة (حتى آخر رسالة، أو
// حتى upToId لو أُرسل).
// ---------------------------------------------------------------------------
router.post('/rooms/:id/read', async (req, res) => {
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, req.user.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');

  const maxRes = await pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM chat_messages WHERE room_id = $1', [roomId]);
  const maxId = Number(maxRes.rows[0].max_id);
  const requested = parseId(req.body.upToId);
  const target = requested ? Math.min(requested, maxId) : maxId;
  await pool.query(
    `UPDATE chat_members SET last_read_message_id = GREATEST(last_read_message_id, $3)
      WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id, target]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PATCH /api/chat/rooms/:id — تغيير اسم المجموعة (مشرف المجموعة فقط).
// ---------------------------------------------------------------------------
router.patch('/rooms/:id', async (req, res) => {
  const me = req.user;
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, me.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');
  const roomRes = await pool.query('SELECT kind, name FROM chat_rooms WHERE id = $1', [roomId]);
  if (roomRes.rows[0].kind !== 'group') return fail(res, 400, 'لا يمكن تسمية محادثة خاصة');
  if (!membership.is_admin) return fail(res, 403, 'تغيير اسم المجموعة لمشرف المجموعة فقط');

  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return fail(res, 400, 'اسم المجموعة إلزامي');
  if (name.length > MAX_GROUP_NAME_LENGTH) return fail(res, 400, `اسم المجموعة طويل (الحد ${MAX_GROUP_NAME_LENGTH} حرفًا)`);

  await inTransaction(async (client) => {
    await client.query('UPDATE chat_rooms SET name = $2 WHERE id = $1', [roomId, name]);
    await addSystemMessage(client, roomId, me.id, `${me.name} غيّر اسم المجموعة إلى "${name}"`);
  });
  const room = await loadRoomForUser(roomId, me.id);
  res.json({ room });
});

// ---------------------------------------------------------------------------
// POST /api/chat/rooms/:id/members {userIds:[...]} — إضافة أعضاء لمجموعة
// (مشرف المجموعة فقط).
// ---------------------------------------------------------------------------
router.post('/rooms/:id/members', async (req, res) => {
  const me = req.user;
  const roomId = parseId(req.params.id);
  if (!roomId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, me.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');
  const roomRes = await pool.query('SELECT kind, name FROM chat_rooms WHERE id = $1', [roomId]);
  const room = roomRes.rows[0];
  if (room.kind !== 'group') return fail(res, 400, 'لا يمكن إضافة أعضاء لمحادثة خاصة');
  if (!membership.is_admin) return fail(res, 403, 'إضافة الأعضاء لمشرف المجموعة فقط');

  const requested = Array.isArray(req.body.userIds)
    ? Array.from(new Set(req.body.userIds.map(parseId).filter(Boolean)))
    : [];
  if (requested.length === 0) return fail(res, 400, 'اختر عضوًا واحدًا على الأقل');

  const eligible = await eligibleUsers(requested);
  const currentRes = await pool.query('SELECT user_id FROM chat_members WHERE room_id = $1', [roomId]);
  const currentIds = new Set(currentRes.rows.map((r) => Number(r.user_id)));
  const toAdd = eligible.filter((u) => !currentIds.has(Number(u.id)));
  if (toAdd.length === 0) return fail(res, 400, 'كل من اخترتهم أعضاء في المجموعة بالفعل أو غير متاحين');
  if (currentIds.size + toAdd.length > MAX_GROUP_MEMBERS) return fail(res, 400, `الحد الأقصى ${MAX_GROUP_MEMBERS} عضو في المجموعة`);

  await inTransaction(async (client) => {
    for (const user of toAdd) {
      await client.query(
        `INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roomId, user.id]
      );
    }
    await addSystemMessage(client, roomId, me.id, `${me.name} أضاف ${toAdd.map((u) => u.name).join('، ')}`);
  });

  sendPushToUsers(toAdd.map((u) => u.id), { title: room.name || 'مجموعة', body: `${me.name} أضافك إلى المجموعة` });
  res.status(201).json({ ok: true, added: toAdd.length });
});

// ---------------------------------------------------------------------------
// DELETE /api/chat/rooms/:id/members/:userId — مغادرة المجموعة (أنت) أو إزالة
// عضو (مشرف المجموعة فقط). المحادثة الخاصة لا تُغادَر.
// ---------------------------------------------------------------------------
router.delete('/rooms/:id/members/:userId', async (req, res) => {
  const me = req.user;
  const roomId = parseId(req.params.id);
  const targetId = parseId(req.params.userId);
  if (!roomId || !targetId) return fail(res, 404, 'المحادثة غير موجودة');
  const membership = await getMembership(roomId, me.id);
  if (!membership) return fail(res, 404, 'المحادثة غير موجودة');
  const roomRes = await pool.query('SELECT kind FROM chat_rooms WHERE id = $1', [roomId]);
  if (roomRes.rows[0].kind !== 'group') return fail(res, 400, 'لا يمكن مغادرة محادثة خاصة');

  const leaving = targetId === me.id;
  if (!leaving && !membership.is_admin) return fail(res, 403, 'إزالة الأعضاء لمشرف المجموعة فقط');
  const target = leaving ? membership : await getMembership(roomId, targetId);
  if (!target) return fail(res, 404, 'هذا الشخص ليس عضوًا في المجموعة');

  const nameRes = await pool.query('SELECT name FROM users WHERE id = $1', [targetId]);
  const targetName = nameRes.rows[0] ? nameRes.rows[0].name : 'عضو';

  await inTransaction(async (client) => {
    await client.query('DELETE FROM chat_members WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
    const left = await client.query('SELECT user_id, is_admin FROM chat_members WHERE room_id = $1 ORDER BY joined_at, user_id', [roomId]);
    if (left.rows.length === 0) {
      // آخر عضو غادر — تُحذف الغرفة ورسائلها (ON DELETE CASCADE)
      await client.query('DELETE FROM chat_rooms WHERE id = $1', [roomId]);
      return;
    }
    if (!left.rows.some((r) => r.is_admin)) {
      // لا يجوز أن تبقى مجموعة بلا مشرف — يُرقّى أقدم الأعضاء انضمامًا
      await client.query('UPDATE chat_members SET is_admin = true WHERE room_id = $1 AND user_id = $2', [roomId, left.rows[0].user_id]);
    }
    await addSystemMessage(
      client,
      roomId,
      me.id,
      leaving ? `${me.name} غادر المجموعة` : `${me.name} أزال ${targetName} من المجموعة`
    );
  });
  res.json({ ok: true });
});

module.exports = router;
