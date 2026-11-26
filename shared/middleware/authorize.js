'use strict';
/**
 * Middleware step 4: authorization.
 * - requireRole: role check from the verified JWT (Section 6.1).
 * - authorizeEvent: ownership in the SQL WHERE clause for organizers (Threat 3) or an
 *   event_staff assignment check for staff (Threat 4). Sets req.event.
 * Authenticated callers without permission -> 403 (audited centrally); unauthenticated -> 401.
 * Handlers that modify an event re-lock it inside their transaction with the same
 * ownership condition (see eventAccess.findOwnedEvent with forUpdate).
 */
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

/**
 * @param {{ allowStaff?: boolean, param?: string }} [opts]
 */
function authorizeEvent(opts = {}) {
  const param = opts.param || 'eventId';
  return async (req, res, next) => {
    if (!req.user) throw unauthenticated();
    req.event = await findAccessibleEvent(db.pool, req.params[param], req.user, { allowStaff: Boolean(opts.allowStaff) });
    return next();
  };
}

module.exports = { requireRole, authorizeEvent };
