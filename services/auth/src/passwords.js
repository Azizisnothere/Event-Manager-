'use strict';
/**
 * Password hashing and policy (Section 6.2 "Authentication", Threat 1).
 * bcryptjs with cost factor 12; minimum 10 characters; at most 72 UTF-8 bytes because
 * bcrypt silently ignores anything longer (A29).
 */
const bcrypt = require('bcryptjs');
const { constants } = require('../../../shared');

const { BCRYPT_COST, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES } = constants;

// Hash used when the email does not exist, so the response time of a login for an unknown
// email matches a wrong password (no account enumeration by timing). Computed once per container.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('timing-equalizer-not-a-real-password', BCRYPT_COST);
  return dummyHashPromise;
}

/** Returns an error message or null. */
function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'must be a string';
  if ([...password].length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `must be at most ${PASSWORD_MAX_BYTES} bytes`;
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Constant-work comparison; pass hash = null for an unknown user. */
async function verifyPassword(password, hash) {
  const ok = await bcrypt.compare(password, hash || (await dummyHash()));
  return Boolean(hash) && ok;
}

module.exports = { passwordPolicyError, hashPassword, verifyPassword };
