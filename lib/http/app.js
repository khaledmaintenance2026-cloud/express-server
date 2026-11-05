'use strict';
/**
 * تطبيق HTTP خفيف (بدون Express) يجمع: تحليل JSON، CORS، تركيب الراوترات
 * تحت بادئات مسار (mount)، تقديم ملفات ثابتة (لوحة التحكم)، ومعالج 404/أخطاء.
 * راجع lib/http/router.js لسبب عدم استخدام Express مباشرة.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleError } = require('./router');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  // أُضيفت لأجل نسخة الويب (PWA) من تطبيق صيانتي — متصفحات مثل Safari على
  // آيفون صارمة في اشتراط نوع MIME الصحيح لملفات .wasm (محرك عرض فلتر على
  // الويب)، وبدونه قد لا يعمل التطبيق إطلاقًا على الويب رغم عمله في بقية
  // المتصفحات.
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  // تسجيلات الدردشة الصوتية (public/uploads/chat) — بدون نوع MIME صحيح قد
  // ترفض بعض المتصفحات تشغيلها.
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
};

// الملفات الصوتية فقط تدعم طلبات النطاق (Range) — متصفح سفاري على آيفون
// يشترط ذلك لتشغيل أي ملف صوتي، ويستخدمه غيره للتقديم/التأخير. باقي الملفات
// الثابتة (صفحات، صور، ملفات التطبيق) تبقى تُخدم كما كانت بلا أي تغيير.
const RANGE_EXTENSIONS = new Set(['.m4a', '.aac', '.mp3', '.ogg', '.webm', '.wav']);

// يحلّل ترويسة Range من الشكل "bytes=start-end" لحجم ملف معيّن. يعيد
// { start, end } أو null لو الترويسة غير صالحة (فيُخدم الملف كاملًا كالمعتاد)
// أو 'unsatisfiable' لو النطاق خارج حجم الملف (ردّ 416).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (!(suffix > 0)) return 'unsatisfiable';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) return resolve({});

    let data = '';
    let size = 0;
    // 12MB — رُفع الحد من 5MB إلى 12MB لاستيعاب صورة معدات مضغوطة (JPEG) تُرسل
    // كنص base64 ضمن طلب تصريح السلامة (لا يوجد رفع ملفات multipart في هذا
    // الخادم الخفيف، فالصورة تُرسل داخل جسم JSON نفسه).
    //
    // تعديل 2026-10-05: المسار العام لطلب تصريح المقاول عبر QR (بلا تسجيل دخول)
    // سقفه ٣ ميجابايت فقط — صفحته تضغط الصورة وترسل أقل من ٥٠٠ كيلوبايت أصلًا،
    // فلا داعي لقبول ١٢ ميجابايت يُحلَّل كلها في الذاكرة من أي زائر مجهول.
    // وsetEncoding يضمن فك الحروف العربية متعددة البايتات بشكل سليم حتى لو
    // قُطعت بين دفعتَي بيانات (بدونه قد يتشوّه حرف عند حدّ الدفعة).
    const isPublicIntake = typeof req.url === 'string' && req.url.startsWith('/api/contractor-permits');
    const MAX_SIZE = (isPublicIntake ? 3 : 12) * 1024 * 1024;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        req.destroy();
        reject(new Error('حجم الطلب كبير جدًا'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(Object.assign(new Error('صيغة JSON غير صحيحة في الطلب'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function decorateResponse(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function json(obj) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  res.send = function send(data) {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(data);
  };
  return res;
}

class App {
  constructor() {
    this.mounts = []; // { prefix, router }
    this.staticDir = null;
    this.staticMounts = []; // { prefix, dir } — مسارات ثابتة إضافية تحت بادئة (راجع serveStaticAt)
  }

  use(prefix, router) {
    this.mounts.push({ prefix, router });
    return this;
  }

  serveStatic(dir) {
    this.staticDir = dir;
    return this;
  }

  // يخدم مجلدًا ثابتًا تحت بادئة مسار محدّدة (مثل /app لنسخة الويب PWA)،
  // بمعزل عن لوحة التحكم الرئيسية المخدومة من serveStatic على الجذر "/".
  // يمكن استدعاؤها أكثر من مرة لإضافة أكثر من مسار ثابت.
  serveStaticAt(prefix, dir) {
    this.staticMounts.push({ prefix, dir });
    return this;
  }

  // ملفات "إقلاع" تطبيق الويب (PWA) — لازم تُفحص من جديد مع كل زيارة حتى
  // ينتشر أي تحديث فورًا لكل الأجهزة، بدل أن يعلّق المتصفح على نسخة قديمة
  // محفوظة عنده لساعات أو أيام بلا داعٍ (هذا كان سبب ظهور نموذج تصاريح
  // السلامة القديم عند بعض الأجهزة رغم رفع الملفات الجديدة فعليًا على السيرفر).
  static get NO_CACHE_FILES() {
    return new Set(['index.html', 'flutter_service_worker.js', 'version.json', 'flutter_bootstrap.js']);
  }

  // alwaysNoCache: true لكل ملفات مسار PWA (راجع serveStaticAt/staticMounts
  // أدناه) — وليس فقط ملفات الإقلاع المذكورة في NO_CACHE_FILES. السبب:
  // main.dart.js (وأي ملفات JS/Wasm أخرى يولّدها فلاتر) لا يتغيّر اسمها بين
  // نسخة وأخرى (--pwa-strategy=none في build-web.yml لا يضيف بصمة/hash لاسم
  // الملف)، فكانت متصفحات آيفون/سفاري تحديدًا (تخزين مؤقت أكثر عدوانية من
  // غيرها، خصوصًا في وضع "إضافة للشاشة الرئيسية") تحتفظ بنسخة قديمة من كود
  // التطبيق نفسه لفترة طويلة رغم تحديث index.html بنجاح — فتظهر ميزات جديدة
  // (مثل تسجيل الدخول بالبصمة) لبعض الأجهزة ولا تظهر لمستخدمي آيفون. الاعتماد
  // على Last-Modified/If-Modified-Since أدناه (304 سريع بلا إعادة تنزيل فعلي
  // عند عدم التغيير) يعوّض تكلفة الأداء بالكامل، فلا داعٍ لقصر no-cache على
  // مجموعة أسماء محدودة هنا. تبقى القاعدة العامة (serveStatic للجذر) على
  // سلوكها القديم (أسماء NO_CACHE_FILES فقط) لأنها تخدم أيضًا ملفات أخرى
  // (صورًا مرفوعة، تقارير HTML) يفيدها تخزين المتصفح الطويل.
  async _tryStatic(req, res, urlPath, dir = this.staticDir, alwaysNoCache = false) {
    if (!dir) return false;
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.normalize(path.join(dir, rel));
    if (!filePath.startsWith(path.normalize(dir))) return false; // منع الخروج من المجلد
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return false;
      const ext = path.extname(filePath);
      const base = path.basename(filePath);

      if (alwaysNoCache || App.NO_CACHE_FILES.has(base)) {
        // يجبر المتصفح على مراجعة السيرفر مع كل زيارة بدل الاعتماد على نسخته
        // المحفوظة محليًا مهما كان عمرها.
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }

      // يسمح للمتصفح بإرسال If-Modified-Since والحصول على ردّ 304 سريع (بلا
      // إعادة تنزيل الملف) عند عدم تغيّره — يعوّض عن no-cache أعلاه بدون
      // التضحية بسرعة اكتشاف التحديثات الفعلية.
      const mtimeRounded = Math.floor(stat.mtimeMs / 1000) * 1000;
      res.setHeader('Last-Modified', new Date(mtimeRounded).toUTCString());
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince) {
        const since = Date.parse(ifModifiedSince);
        if (!Number.isNaN(since) && since >= mtimeRounded) {
          res.statusCode = 304;
          res.end();
          return true;
        }
      }

      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');

      if (RANGE_EXTENSIONS.has(ext.toLowerCase())) {
        res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
        if (range === 'unsatisfiable') {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.end();
          return true;
        }
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
          res.setHeader('Content-Length', range.end - range.start + 1);
          fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
          return true;
        }
      }

      fs.createReadStream(filePath).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  listen(port, cb) {
    const server = http.createServer(async (req, res) => {
      decorateResponse(res);

      // CORS — يسمح للوحة التحكم بالاتصال حتى لو خُدمت من مصدر مختلف مستقبلاً
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }

      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      req.query = Object.fromEntries(urlObj.searchParams);

      try {
        req.body = await readJsonBody(req);
      } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }

      for (const { prefix, router } of this.mounts) {
        if (urlObj.pathname === prefix || urlObj.pathname.startsWith(prefix + '/')) {
          const subPath = urlObj.pathname.slice(prefix.length) || '/';
          const matched = await router.handle(req, res, subPath);
          if (matched) return;
        }
      }

      // مسارات ثابتة إضافية تحت بادئة (مثل /app لنسخة الويب PWA) — تُفحص
      // قبل لوحة التحكم الرئيسية على الجذر حتى لا يتعارض المساران.
      for (const { prefix, dir } of this.staticMounts) {
        if (urlObj.pathname === prefix || urlObj.pathname.startsWith(prefix + '/')) {
          const subPath = urlObj.pathname.slice(prefix.length) || '/';
          // alwaysNoCache=true — راجع التعليق فوق _tryStatic أعلاه لسبب معاملة
          // كل ملفات مسار PWA هذا (وليس فقط index.html/flutter_bootstrap.js)
          // كـ"no-cache" دائمًا.
          if (await this._tryStatic(req, res, subPath, dir, true)) return;
        }
      }

      if (await this._tryStatic(req, res, urlObj.pathname)) return;

      res.status(404).json({ error: 'المسار غير موجود' });
    });

    server.on('clientError', (err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    server.listen(port, cb);
    return server;
  }
}

module.exports = { App };
