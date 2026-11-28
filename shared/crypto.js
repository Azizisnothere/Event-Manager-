'use strict';
const crypto = require('crypto');
const { TOKEN_BYTES, CHECK_IN_CODE_ALPHABET, CHECK_IN_CODE_LENGTH } = require('./constants');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHECK_IN_CODE_PATTERN = new RegExp(`^[${CHECK_IN_CODE_ALPHABET}]{${CHECK_IN_CODE_LENGTH}}$`);

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashToken(rawToken) {
  return sha256Hex(rawToken);
}

function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(String(value), 'utf8').digest('hex');
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function emailKeyHash(email) {
  return sha256Hex(`email:${normalizeEmail(email)}`);
}

let ipKeyPromise = null;
async function ipHashKey() {
  if (!ipKeyPromise) {
    const { getSecret } = require('./secrets');
    ipKeyPromise = getSecret('jwtSecret').then((secret) => crypto.createHmac('sha256', secret).update('ip-hash-v1').digest());
    ipKeyPromise.catch(() => {
      ipKeyPromise = null;
    });
  }
  return ipKeyPromise;
}

async function hashIp(ip) {
  if (!ip) return null;
  const key = await ipHashKey();
  return hmacHex(key, ip);
}

function generateCheckInCode() {
  let code = '';
  for (let i = 0; i < CHECK_IN_CODE_LENGTH; i += 1) {
    code += CHECK_IN_CODE_ALPHABET[crypto.randomInt(CHECK_IN_CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeCheckInCode(value) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/[\s-]/g, '').toUpperCase();
  return CHECK_IN_CODE_PATTERN.test(v) ? v : null;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function resetIpKeyCache() {
  ipKeyPromise = null;
}

module.exports = {
  generateToken,
  isTokenFormat,
  sha256Hex,
  hashToken,
  hmacHex,
  normalizeEmail,
  emailKeyHash,
  hashIp,
  generateCheckInCode,
  normalizeCheckInCode,
  timingSafeEqualHex,
  resetIpKeyCache,
  CHECK_IN_CODE_PATTERN,
};
