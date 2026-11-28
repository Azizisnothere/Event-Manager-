'use strict';
const db = require('../db');
const { unauthenticated, forbidden } = require('../errors');
const { findAccessibleEvent } = require('../eventAccess');

function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(undefined, { auditDetail: { reason: 'role_not_allowed', required: roles } }));
    }
    return next();
  };
}

function authorizeEvent(opts = {}) {
  const param = opts.param || 'eventId';
  return async (req, res, next) => {
    if (!req.user) throw unauthenticated();
    req.event = await findAccessibleEvent(db.pool, req.params[param], req.user, { allowStaff: Boolean(opts.allowStaff) });
    return next();
  };
}

module.exports = { requireRole, authorizeEvent };
