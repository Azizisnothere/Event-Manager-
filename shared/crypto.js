'use strict';
/**
 * Token, hashing and code helpers.
 * - Invitation and staff-setup tokens: 256 bits from the CSPRNG, base64url (43 chars).
 *   Only the SHA-256 hash is stored (Section 6.2 "Authentication", Threat 2).
 * - Client IPs are stored as an HMAC so they cannot be reversed by brute force (A33).
 * - Check-in codes: 6 chars from an unambiguous alphabet using crypto.randomInt (A21).
 */
const crypto = require('crypto');
const { TOKEN_BYTES, CHECK_IN_CODE_ALPHABET, CHECK_IN_CODE_LENGTH } = require('./constants');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHECK_IN_CODE_PATTERN = new RegExp(`^[${CHECK_IN_CODE_ALPHABET}]{${CHECK_IN_CODE_LENGTH}}$`);

/** New 256-bit random token, URL-safe. The raw value must only ever go into an emailed link. */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Cheap syntactic check before any hashing / DB lookup. */
function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Hash stored in invitations.token_hash / users.setup_token_hash. */
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

/** Key for per-email counters (login throttle) so DynamoDB never holds a plain email. */
function emailKeyHash(email) {
  return sha256Hex(`email:${normalizeEmail(email)}`);
}

let ipKeyPromise = null;
async function ipHashKey() {
  if (!ipKeyPromise) {
    // Lazy require: secrets -> logger -> ... must not load at module init for pure helpers.
    const { getSecret } = require('./secrets');
    ipKeyPromise = getSecret('jwtSecret').then((secret) => crypto.createHmac('sha256', secret).update('ip-hash-v1').digest());
    ipKeyPromise.catch(() => {
      ipKeyPromise = null;
    });
  }
  return ipKeyPromise;
}

/** HMAC-SHA256 of the client IP, or null when unknown. */
async function hashIp(ip) {
  if (!ip) return null;
  const key = await ipHashKey();
  return hmacHex(key, ip);
}

/** Random 6-character check-in code. Uniqueness per event is enforced by rsvps_event_code_uq. */
function generateCheckInCode() {
  let code = '';
  for (let i = 0; i < CHECK_IN_CODE_LENGTH; i += 1) {
    code += CHECK_IN_CODE_ALPHABET[crypto.randomInt(CHECK_IN_CODE_ALPHABET.length)];
  }
  return code;
}

/** Upper-cases and strips spaces/dashes typed at the door; returns null if not a valid code. */
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
