'use strict';
/**
 * راوتر خفيف بواجهة شبيهة بـ Express (بدون أي اعتمادية خارجية) — لنفس
 * السبب الموضّح في lib/pgLite.js: تعذّر الوصول لسجل npm أثناء التطوير هنا.
 * الواجهة (router.get/post/patch/put/delete, router.use, req.body/params/query,
 * res.status().json()) قريبة جدًا من Express عمدًا، بحيث لو رغبتم لاحقًا
 * بالتبديل لحزمة Express الرسمية، منطق المسارات في routes/ لن يحتاج تغييرًا.
 */

function compilePath(path) {
  const keys = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), keys };
}

function handleError(err, res) {
  console.error('خطأ غير متوقع:', err);
  if (!res.headersSent) res.status(500).json({ error: 'حدث خطأ غير متوقع في السيرفر' });
}

function runChain(chain, req, res) {
  return new Promise((resolve) => {
    let i = 0;
    function next(err) {
      if (err) return handleError(err, res);
      if (res.writableEnded) return resolve();
      const fn = chain[i++];
      if (!fn) return resolve();
      try {
        const result = fn(req, res, next);
        if (result && typeof result.catch === 'function') result.catch((e) => handleError(e, res));
      } catch (e) {
        handleError(e, res);
      }
    }
    next();
  });
}

class Router {
  constructor() {
    this.middlewares = [];
    this.routes = [];
  }

  use(...fns) {
    this.middlewares.push(...fns);
    return this;
  }

  _add(method, path, handlers) {
    const { regex, keys } = compilePath(path);
    this.routes.push({ method, regex, keys, handlers });
  }

  get(path, ...h) { this._add('GET', path, h); return this; }
  post(path, ...h) { this._add('POST', path, h); return this; }
  patch(path, ...h) { this._add('PATCH', path, h); return this; }
  put(path, ...h) { this._add('PUT', path, h); return this; }
  delete(path, ...h) { this._add('DELETE', path, h); return this; }

  /** يحاول معالجة الطلب على مسار نسبي (subPath). يعيد true لو وُجد مسار مطابق. */
  async handle(req, res, subPath) {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(subPath);
      if (!m) continue;
      req.params = {};
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      await runChain([...this.middlewares, ...route.handlers], req, res);
      return true;
    }
    return false;
  }
}

module.exports = { Router, runChain, handleError };
