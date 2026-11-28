'use strict';
const bcrypt = require('bcryptjs');
const { constants } = require('../../../shared');

const { BCRYPT_COST, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES } = constants;

let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('timing-equalizer-not-a-real-password', BCRYPT_COST);
  return dummyHashPromise;
}

function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'must be a string';
  if ([...password].length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `must be at most ${PASSWORD_MAX_BYTES} bytes`;
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, hash) {
  const ok = await bcrypt.compare(password, hash || (await dummyHash()));
  return Boolean(hash) && ok;
}

module.exports = { passwordPolicyError, hashPassword, verifyPassword };
