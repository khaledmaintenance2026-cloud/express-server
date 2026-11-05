'use strict';
/**
 * توليد والتحقق من رموز JWT (HMAC-SHA256) بدون حزمة jsonwebtoken الخارجية.
 * يدعم فقط ما يحتاجه هذا النظام: payload بسيط + expiresIn بالأيام/الثواني.
 */
const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}
function sign(payload, secret, { expiresIn } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now };
  if (expiresIn) fullPayload.exp = now + parseExpiry(expiresIn);

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('رمز غير صالح');
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('توقيع الرمز غير صحيح');
  }
  const payload = JSON.parse(base64urlDecode(encodedPayload));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('انتهت صلاحية رمز الدخول');
  }
  return payload;
}

function parseExpiry(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return n * mult;
}

module.exports = { sign, verify };
