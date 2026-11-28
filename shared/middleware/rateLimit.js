'use strict';
const requestGuard = require('../requestGuard');
const { logger } = require('../logger');
const { tooManyRequests, serviceUnavailable } = require('../errors');
const { auditFromRequest } = require('../audit');
const { AUDIT_EVENT_TYPES } = require('../constants');

function rateLimit({ name, limit, windowSeconds, key, failOpen = true }) {
  return async (req, res, next) => {
    const identity = await key(req);
    if (!identity) return next();
    let result;
    try {
      result = await requestGuard.hit(`rl#${name}#${identity}`, limit, windowSeconds);
    } catch (err) {
      logger.error('rate_limit_store_unavailable', { limiter: name, error: err });
      if (!failOpen) throw serviceUnavailable();
      return next();
    }
    if (!result.allowed) {
      if (result.firstRejection) {
        await auditFromRequest(req, AUDIT_EVENT_TYPES.RATE_LIMITED, { detail: { limiter: name } });
      }
      throw tooManyRequests(undefined, result.retryAfterSeconds);
    }
    return next();
  };
}

module.exports = { rateLimit };
