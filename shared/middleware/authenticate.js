'use strict';
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

async function verifyAccessToken(token) {
  const secret = await getSecret('jwtSecret');
  const payload = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] });
  if (!payload || !isUuid(payload.user_id) || !ROLES.includes(payload.role)) {
    throw new Error('Token payload is invalid');
  }
  return { user_id: payload.user_id, role: payload.role };
}

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
