'use strict';
/**
 * Rate limiting backed by DynamoDB (Threat 6). Keys are hashes, never raw tokens or IPs.
 * When a limit is first exceeded in a window, one rate_limited audit entry is written.
 * By default, if DynamoDB is unreachable the request is allowed (fail-open) and the error is logged,
 * so an AWS hiccup does not take guest replies offline; Turnstile and API Gateway
 * throttling still apply.
 */
const requestGuard = require('../requestGuard');
const { logger } = require('../logger');
const { tooManyRequests, serviceUnavailable } = require('../errors');
const { auditFromRequest } = require('../audit');
const { AUDIT_EVENT_TYPES } = require('../constants');

/**
 * @param {{ name: string, limit: number, windowSeconds: number, failOpen?: boolean,
 *           key: (req) => (string|null|Promise<string|null>) }} opts
 *   key returns the identity to count (e.g. req.tokenHash or the hashed IP); null skips the check.
 *   failOpen (default true): allow the request if DynamoDB is unreachable; false -> 503.
 */
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
