'use strict';
/**
 * Middleware step 3a: JWT authentication for organizers and staff.
 * Threat 4: the signature is verified with HS256 ONLY (algorithms: ['HS256']), so "alg: none"
 * or RS/HS confusion tokens are rejected, and an edited role invalidates the signature.
 * Threat 1: 1-hour expiry is checked by jsonwebtoken.
 * The user row is re-read so disabled accounts and role changes take effect immediately (A30).
 * Missing / invalid credentials -> 401 (audited by the error handler).
 */
const jwt = require('jsonwebtoken');
const db = require('../db');
const { getSecret } = require('../secrets');
const { unauthenticated } = require('../errors');
const { isUuid } = require('../utils');
const { ROLES, JWT_ALGORITHM } = require('../constants');

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * Verifies a JWT and returns { user_id, role } or throws.
 * Exported for the auth service and tests.
 */
async function verifyAccessToken(token) {
  const secret = await getSecret('jwtSecret');
  const payload = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] }); // HS256 only (Threat 4)
  if (!payload || !isUuid(payload.user_id) || !ROLES.includes(payload.role)) {
    throw new Error('Token payload is invalid');
  }
  return { user_id: payload.user_id, role: payload.role };
}

/**
 * @param {{ optional?: boolean }} [opts] optional: continue without req.user when no token is sent
 */
function authenticate(opts = {}) {
  return async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      if (opts.optional && !req.headers.authorization) return next();
      throw unauthenticated();
    }
    let claims;
    try {
      claims = await verifyAccessToken(token);
    } catch (err) {
      throw unauthenticated('Your session is invalid or has expired. Please log in again.', {
        auditDetail: { reason: err.name === 'TokenExpiredError' ? 'token_expired' : 'token_invalid' },
      });
    }
    const { rows } = await db.query('SELECT user_id, role, status, created_by FROM users WHERE user_id = $1', [
      claims.user_id,
    ]);
    const user = rows[0];
    if (!user || user.status !== 'active' || user.role !== claims.role) {
      throw unauthenticated('Your session is invalid or has expired. Please log in again.', {
        auditDetail: { reason: 'account_inactive_or_changed' },
      });
    }
    req.user = { user_id: user.user_id, role: user.role, created_by: user.created_by };
    return next();
  };
}

module.exports = { authenticate, verifyAccessToken, bearerToken };
