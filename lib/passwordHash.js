'use strict';
/**
 * تجزئة والتحقق من كلمات المرور باستخدام scrypt (مدمجة في Node.js نفسه —
 * لا حاجة لحزمة bcryptjs الخارجية). scrypt خوارزمية معتمدة وآمنة لهذا الغرض
 * (موصى بها من OWASP كبديل لـ bcrypt).
 */
const crypto = require('crypto');

const KEY_LEN = 64;

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

function verify(password, storedHash) {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, keyHex] = parts;
  const derivedKey = crypto.scryptSync(password, salt, KEY_LEN);
  const storedKey = Buffer.from(keyHex, 'hex');
  if (derivedKey.length !== storedKey.length) return false;
  return crypto.timingSafeEqual(derivedKey, storedKey);
}

module.exports = { hash, verify };
