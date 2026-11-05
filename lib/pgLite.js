'use strict';
/**
 * عميل PostgreSQL بسيط بدون أي اعتمادية خارجية (zero-dependency).
 *
 * لماذا هذا الملف موجود: بيئة بناء هذا الكود لا تملك وصولًا لسجل npm،
 * فتعذّر استخدام حزمة "pg" الشهيرة أثناء التطوير والاختبار. بدل تسليم كود
 * غير مُجرَّب، كُتب عميل PostgreSQL مباشر (بروتوكول السلكي الرسمي، إصدار 3.0)
 * يدعم SCRAM-SHA-256 (طريقة المصادقة الافتراضية في PostgreSQL 16) والاستعلامات
 * المُعامَلة (Parameterized Queries) بأمان كامل ضد حقن SQL — وتم اختباره
 * فعليًا هنا ضد قاعدة بيانات PostgreSQL 16 حقيقية قبل التسليم.
 *
 * الواجهة (API) مطابقة عمدًا لحزمة "pg" الشهيرة (pool.query(sql, params) و
 * pool.connect() لعميل معاملات/transactions) — لو رغبتم لاحقًا بالتبديل
 * لحزمة pg الرسمية (بعد توفر إنترنت أوسع)، الكود في routes/ لن يحتاج أي تعديل.
 */

const net = require('net');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// ترميز/فك ترميز رسائل بروتوكول PostgreSQL السلكي
// ---------------------------------------------------------------------------

function buildMessage(type, payload) {
  // type: حرف واحد أو null (رسالة StartupMessage ليس لها حرف نوع)
  const len = Buffer.byteLength(payload) + 4;
  const header = Buffer.alloc(type ? 5 : 4);
  let offset = 0;
  if (type) {
    header.write(type, 0, 'ascii');
    offset = 1;
  }
  header.writeInt32BE(len, offset);
  return Buffer.concat([header, payload]);
}

function cstr(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function int32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function int16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}

// ---------------------------------------------------------------------------
// تحويل أنواع الأعمدة من نص PostgreSQL إلى قيم JavaScript مناسبة
// ---------------------------------------------------------------------------
const OID_BOOL = 16;
const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
const OID_TEXT_ARRAY = 1009;
const OID_VARCHAR_ARRAY = 1015;

function parsePgArray(text) {
  // صيغة PostgreSQL النصية للمصفوفات: {a,b,"c d"} — تحليل مبسّط يكفي لمصفوفات نصية بسيطة
  if (text === null) return null;
  const inner = text.slice(1, -1);
  if (inner.length === 0) return [];
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuotes) {
      if (ch === '\\') {
        current += inner[++i];
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function coerce(value, oid) {
  if (value === null) return null;
  switch (oid) {
    case OID_BOOL:
      return value === 't';
    case OID_INT2:
    case OID_INT4:
      return parseInt(value, 10);
    case OID_INT8:
    case OID_NUMERIC:
      return Number(value);
    case OID_TIMESTAMP:
    case OID_TIMESTAMPTZ:
      return new Date(value);
    case OID_TEXT_ARRAY:
    case OID_VARCHAR_ARRAY:
      return parsePgArray(value);
    default:
      return value;
  }
}

function encodeParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const escaped = value.map((v) => {
      const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${s}"`;
    });
    return `{${escaped.join(',')}}`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

// ---------------------------------------------------------------------------
// SCRAM-SHA-256 (RFC 5802) — طريقة المصادقة الافتراضية في PostgreSQL 16
// ---------------------------------------------------------------------------
function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}
function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

class PgConnection {
  constructor({ host, port, database, user, password }) {
    this.host = host;
    this.port = port;
    this.database = database;
    this.user = user;
    this.password = password;
    this._buffer = Buffer.alloc(0);
    this._pending = [];
    // حالة تتبّع للاستخدام مع مجموعة الاتصالات (Pool) أدناه: هل الاتصال حاليًا
    // داخل معاملة (BEGIN بلا COMMIT/ROLLBACK بعد)، وهل تعطّل (فيُستبعد من
    // إعادة الاستخدام بدل تسليمه لطلب لاحق فيفشل بغرابة).
    this._inTransaction = false;
    this._broken = false;
    this._closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port }, () => {
        this._sendStartup();
      });
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.once('error', reject);
      this._authResolve = resolve;
      this._authReject = reject;
    }).then((conn) => {
      // بعد نجاح المصادقة، نستبدل معالج الخطأ المؤقت (الخاص بالاتصال الأول
      // فقط) بمعالج دائم. بدون هذا، أي انقطاع لاحق في الشبكة (والاتصال الآن
      // يعيش لفترة أطول بكثير بفضل التجميع في Pool بدل فتح/إغلاق لكل استعلام)
      // كان سيرمي استثناء غير مُمسوك يوقف السيرفر بالكامل، بدل أن يُستبعد هذا
      // الاتصال بهدوء من المجموعة ويُفتح غيره عند الحاجة.
      this.socket.removeAllListeners('error');
      this.socket.on('error', (err) => {
        this._broken = true;
        if (this._queryReject) {
          const reject2 = this._queryReject;
          this._queryDone = null;
          this._queryReject = null;
          reject2(err);
        }
      });
      this.socket.on('close', () => {
        this._broken = true;
        this._closed = true;
      });
      return conn;
    });
  }

  _sendStartup() {
    const params = Buffer.concat([
      cstr('user'), cstr(this.user),
      cstr('database'), cstr(this.database),
      cstr('client_encoding'), cstr('UTF8'),
      Buffer.from([0]),
    ]);
    const payload = Buffer.concat([int32(196608), params]); // protocol version 3.0
    this.socket.write(buildMessage(null, payload));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 5) {
      const type = String.fromCharCode(this._buffer[0]);
      const len = this._buffer.readInt32BE(1);
      if (this._buffer.length < len + 1) break; // رسالة غير مكتملة بعد
      const payload = this._buffer.slice(5, 1 + len);
      this._buffer = this._buffer.slice(1 + len);
      this._handleMessage(type, payload);
    }
  }

  _handleMessage(type, payload) {
    switch (type) {
      case 'R':
        this._handleAuth(payload);
        break;
      case 'S': // ParameterStatus
      case 'K': // BackendKeyData
      case 'N': // NoticeResponse
        break;
      case 'Z': // ReadyForQuery
        if (this._authResolve) {
          const resolve = this._authResolve;
          this._authResolve = null;
          resolve(this);
        } else if (this._queryDone) {
          this._queryDone();
        }
        break;
      case 'E': {
        const err = this._parseError(payload);
        if (this._authReject && !this._ready) {
          const reject = this._authReject;
          this._authReject = null;
          reject(err);
        } else {
          this._queryError = err;
        }
        break;
      }
      case 'T':
        this._rowFields = this._parseRowDescription(payload);
        break;
      case 'D':
        this._rows.push(this._parseDataRow(payload));
        break;
      case 'C':
        this._commandTag = payload.toString('utf8').replace(/\0$/, '');
        break;
      case '1': // ParseComplete
      case '2': // BindComplete
      case 'n': // NoData
      case 't': // ParameterDescription
      case '3': // CloseComplete
        break;
      default:
        break;
    }
  }

  _parseError(payload) {
    const str = payload.toString('utf8');
    const fields = {};
    for (const part of str.split('\0')) {
      if (!part) continue;
      fields[part[0]] = part.slice(1);
    }
    const err = new Error(fields.M || 'خطأ غير معروف من قاعدة البيانات');
    err.code = fields.C;
    err.detail = fields.D;
    return err;
  }

  _parseRowDescription(payload) {
    let offset = 0;
    const count = payload.readInt16BE(offset);
    offset += 2;
    const fields = [];
    for (let i = 0; i < count; i++) {
      const nameEnd = payload.indexOf(0, offset);
      const name = payload.slice(offset, nameEnd).toString('utf8');
      offset = nameEnd + 1;
      offset += 4; // table OID
      offset += 2; // column attr number
      const dataTypeOid = payload.readInt32BE(offset);
      offset += 4;
      offset += 2; // type size
      offset += 4; // type modifier
      offset += 2; // format code
      fields.push({ name, dataTypeOid });
    }
    return fields;
  }

  _parseDataRow(payload) {
    let offset = 0;
    const count = payload.readInt16BE(offset);
    offset += 2;
    const row = {};
    for (let i = 0; i < count; i++) {
      const len = payload.readInt32BE(offset);
      offset += 4;
      let raw = null;
      if (len >= 0) {
        raw = payload.slice(offset, offset + len).toString('utf8');
        offset += len;
      }
      const field = this._rowFields[i];
      row[field.name] = coerce(raw, field.dataTypeOid);
    }
    return row;
  }

  // ---- المصادقة (SCRAM-SHA-256 / MD5 / نص صريح) ----
  async _handleAuth(payload) {
    const authType = payload.readInt32BE(0);
    if (authType === 0) {
      this._ready = true; // AuthenticationOk
      return;
    }
    if (authType === 3) {
      // AuthenticationCleartextPassword
      this._send('p', cstr(this.password));
      return;
    }
    if (authType === 5) {
      // AuthenticationMD5Password
      const salt = payload.slice(4);
      const inner = crypto.createHash('md5').update(this.password + this.user).digest('hex');
      const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this._send('p', cstr(outer));
      return;
    }
    if (authType === 10) {
      // AuthenticationSASL — نبدأ SCRAM-SHA-256
      this._clientNonce = crypto.randomBytes(18).toString('base64');
      this._clientFirstBare = `n=,r=${this._clientNonce}`;
      const clientFirstMessage = `n,,${this._clientFirstBare}`;
      const body = Buffer.concat([
        cstr('SCRAM-SHA-256'),
        int32(Buffer.byteLength(clientFirstMessage)),
        Buffer.from(clientFirstMessage, 'utf8'),
      ]);
      this._send('p', body);
      return;
    }
    if (authType === 11) {
      // AuthenticationSASLContinue — server-first-message
      const serverFirstMessage = payload.slice(4).toString('utf8');
      const parts = Object.fromEntries(
        serverFirstMessage.split(',').map((kv) => [kv[0], kv.slice(2)])
      );
      const serverNonce = parts.r;
      const salt = Buffer.from(parts.s, 'base64');
      const iterations = parseInt(parts.i, 10);

      const saltedPassword = crypto.pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');
      const clientKey = hmac(saltedPassword, 'Client Key');
      const storedKey = sha256(clientKey);
      const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
      const authMessage = `${this._clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
      const clientSignature = hmac(storedKey, authMessage);
      const clientProof = xorBuffers(clientKey, clientSignature).toString('base64');
      const clientFinalMessage = `${clientFinalWithoutProof},p=${clientProof}`;

      // نحفظ لاحقًا للتحقق من توقيع السيرفر (AuthenticationSASLFinal)
      this._serverKey = hmac(saltedPassword, 'Server Key');
      this._authMessage = authMessage;

      this._send('p', Buffer.from(clientFinalMessage, 'utf8'));
      return;
    }
    if (authType === 12) {
      // AuthenticationSASLFinal — تحقق اختياري من توقيع السيرفر
      const serverFinalMessage = payload.slice(4).toString('utf8');
      const v = serverFinalMessage.startsWith('v=') ? serverFinalMessage.slice(2) : '';
      const expected = hmac(this._serverKey, this._authMessage).toString('base64');
      if (v && v !== expected) {
        this._authReject?.(new Error('فشل التحقق من هوية خادم قاعدة البيانات (SCRAM)'));
      }
      return;
    }
    // أنواع مصادقة أخرى غير مدعومة حاليًا
    this._authReject?.(new Error(`طريقة مصادقة PostgreSQL غير مدعومة (رمز ${authType})`));
  }

  _send(type, payload) {
    this.socket.write(buildMessage(type, payload));
  }

  /** ينفّذ استعلامًا معامَلًا بأمان (Extended Query Protocol) ويعيد {rows, rowCount}. */
  query(sql, params = []) {
    // تتبّع بسيط لحالة المعاملة (Transaction) — يُستخدم من PgLitePool أدناه
    // ليقرر عند "release()" هل من الآمن إعادة استخدام هذا الاتصال لطلب آخر،
    // أو أنه تُرك بمنتصف معاملة مفتوحة (BEGIN بلا COMMIT/ROLLBACK) فيُغلَق
    // بدل تسليمه لعملية أخرى بحالة غير متوقعة.
    const head = String(sql).trim().slice(0, 10).toUpperCase();
    if (head.startsWith('BEGIN')) this._inTransaction = true;
    else if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) this._inTransaction = false;

    return new Promise((resolve, reject) => {
      this._rows = [];
      this._rowFields = [];
      this._commandTag = '';
      this._queryError = null;
      this._queryReject = reject;

      const paramValues = params.map(encodeParam);
      const bindPayload = Buffer.concat([
        cstr(''), // portal
        cstr(''), // statement
        int16(0), // param format codes count (0 = كلها نص)
        int16(paramValues.length),
        ...paramValues.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v, 'utf8')), Buffer.from(v, 'utf8')]))),
        int16(0), // result format codes (0 = كلها نص)
      ]);

      const parsePayload = Buffer.concat([cstr(''), cstr(sql), int16(0)]);
      const describePayload = Buffer.concat([Buffer.from('S', 'ascii'), cstr('')]);
      const executePayload = Buffer.concat([cstr(''), int32(0)]);

      this.socket.write(buildMessage('P', parsePayload));
      this.socket.write(buildMessage('D', describePayload));
      this.socket.write(buildMessage('B', bindPayload));
      this.socket.write(buildMessage('E', executePayload));
      this.socket.write(buildMessage('S', Buffer.alloc(0)));

      this._queryDone = () => {
        this._queryDone = null;
        this._queryReject = null;
        if (this._queryError) return reject(this._queryError);
        const match = /^(\w+) ?(\d+)? ?(\d+)?$/.exec(this._commandTag || '');
        const rowCount = match ? parseInt(match[3] || match[2] || '0', 10) || 0 : 0;
        resolve({ rows: this._rows, rowCount: rowCount || this._rows.length });
      };
    });
  }

  end() {
    return new Promise((resolve) => {
      this.socket.end(buildMessage('X', Buffer.alloc(0)), resolve);
    });
  }
}

// الحد الأقصى الافتراضي لعدد اتصالات قاعدة البيانات المفتوحة في آن واحد.
// قابل للتعديل من .env بمتغيّر DB_POOL_MAX لو احتجتم رفعه لاحقًا (مثلاً لو
// زاد عدد المستخدمين المتزامنين كثيرًا) دون تعديل أي كود.
const DEFAULT_POOL_MAX = Number(process.env.DB_POOL_MAX) || 15;
// مدة بقاء الاتصال الخامل (بلا استخدام) قبل إغلاقه فعليًا — يمنع إبقاء عشرات
// الاتصالات مفتوحة على قاعدة البيانات بلا داعٍ في أوقات الهدوء (ليلًا مثلاً).
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * مجموعة اتصالات (Pool) حقيقية بواجهة مطابقة لحزمة "pg": تُعيد استخدام
 * اتصالات قاعدة البيانات المفتوحة بدل فتح اتصال TCP + مصادقة SCRAM كاملة من
 * الصفر لكل استعلام (كما كانت النسخة السابقة من هذا الملف تفعل) — وهو ما كان
 * يجعل كل طلب أبطأ من اللازم، ويصبح عنق زجاجة حقيقيًا مع ازدياد عدد
 * المستخدمين المتزامنين (كل طلب كان يفتح اتصال Postgres جديدًا بالكامل).
 *
 * الفكرة: نحتفظ بحد أقصى (DEFAULT_POOL_MAX) من الاتصالات الحيّة معًا. أي طلب
 * يأخذ اتصالًا خاملًا جاهزًا إن وُجد، أو يفتح واحدًا جديدًا إن كان هناك متسع،
 * أو ينتظر في طابور حتى يتحرر اتصال لو وصلنا الحد الأقصى (بدل رفض الطلب أو
 * إغراق قاعدة البيانات باتصالات غير محدودة).
 */
class PgLitePool {
  constructor(config) {
    this.config = config;
    this.max = (config && config.max) || DEFAULT_POOL_MAX;
    this._idle = []; // { conn, timer } — اتصالات جاهزة الآن لإعادة الاستخدام
    this._total = 0; // كل اتصال حيّ حاليًا (خامل + قيد الاستخدام)
    this._waiters = []; // طلبات تنتظر دورها لاتصال حين نصل الحد الأقصى
  }

  // نحجز مكانًا في العداد الكلي (this._total += 1) بشكل متزامن قبل أي await،
  // ثم نفتح الاتصال فعليًا. لو حجزنا بعد await (كما في نسخة سابقة من هذا
  // الكود) فطلبات متزامنة كثيرة (مثلًا 10 طلبات وصلت بنفس اللحظة) قد تقرأ كلها
  // this._total بقيمته القديمة قبل أن يزيدها أي منها، فتتجاوز الحد الأقصى
  // بالكامل رغم وجوده — وهذا بالضبط ما يفشل فيه سباق التزامن (race condition).
  async _reserveAndConnect() {
    this._total += 1;
    try {
      const conn = new PgConnection(this.config);
      await conn.connect();
      return conn;
    } catch (err) {
      this._total -= 1; // فشل الاتصال — نُعيد المكان المحجوز لغيره
      throw err;
    }
  }

  async _acquire() {
    // نتجاهل أي اتصالات خاملة تعطّلت (مثلاً انقطع الاتصال بقاعدة البيانات
    // وهي خاملة بالمجموعة) بدل تسليمها لطلب سيفشل بغرابة.
    while (this._idle.length) {
      const item = this._idle.pop();
      clearTimeout(item.timer);
      if (!item.conn._broken && !item.conn._closed) return item.conn;
      this._total -= 1;
    }
    if (this._total < this.max) {
      return this._reserveAndConnect();
    }
    // وصلنا الحد الأقصى من الاتصالات المفتوحة — ننتظر في الطابور حتى يتحرر
    // اتصال (عبر release أدناه) بدل رفض الطلب فورًا.
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  _release(conn) {
    // اتصال معطوب، أو تُرك بمنتصف معاملة لم تُغلق (BEGIN بلا COMMIT/ROLLBACK
    // — عادة بسبب استثناء غير متوقع لم يُعالَج بشكل كامل) لا يُعاد للمجموعة؛
    // نتخلص منه ونفتح غيره لاحقًا عند الحاجة بدل تسليم اتصال بحالة غير مضمونة.
    if (conn._broken || conn._closed || conn._inTransaction) {
      this._total -= 1;
      if (!conn._broken && !conn._closed) conn.end().catch(() => {});
    } else if (this._waiters.length) {
      const waiter = this._waiters.shift();
      waiter.resolve(conn);
      return;
    } else {
      const timer = setTimeout(() => {
        const idx = this._idle.findIndex((it) => it.conn === conn);
        if (idx !== -1) {
          this._idle.splice(idx, 1);
          this._total -= 1;
          conn.end().catch(() => {});
        }
      }, IDLE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this._idle.push({ conn, timer });
    }

    // لو تخلّصنا من اتصال معطوب وفي طلبات منتظرة، نفتح اتصالًا جديدًا لأولها
    // بدل تركه ينتظر بلا داعٍ رغم توفر مكان الآن.
    if (this._waiters.length && this._total < this.max) {
      const waiter = this._waiters.shift();
      this._reserveAndConnect().then(waiter.resolve, waiter.reject);
    }
  }

  /** استعلام واحد سريع: يأخذ اتصالًا من المجموعة وينفّذ الاستعلام ويعيده فورًا. */
  async query(sql, params) {
    const conn = await this._acquire();
    try {
      return await conn.query(sql, params);
    } finally {
      this._release(conn);
    }
  }

  /** لعمليات المعاملات (Transactions): استخدموا client.query('BEGIN')...('COMMIT') ثم client.release(). */
  async connect() {
    const conn = await this._acquire();
    let released = false;
    conn.release = () => {
      if (released) return; // حماية من استدعاء release أكثر من مرة بالخطأ
      released = true;
      this._release(conn);
    };
    return conn;
  }

  on() {
    // متوافق مع pool.on('error', ...) في حزمة pg — غير مُستخدم فعليًا هنا.
  }
}

module.exports = { PgLitePool };
