'use strict';
/**
 * Audit log helper (Section 6.2 "Logging and monitoring", Threat 9).
 * Every security event is written twice:
 *   1. a row in audit_log (insert-only for em_app, IP stored as an HMAC), and
 *   2. a structured logger.security() line ({"msg":"security","event":...}) for CloudWatch metric filters.
 * `detail` must never contain passwords, tokens, JWTs, emails or dietary notes;
 * it is passed through the logger's sanitizer before storage as a safeguard.
 */
const db = require('./db');
const { logger } = require('./logger');
const { hashIp } = require('./crypto');
const { isUuid } = require('./utils');
const { AUDIT_EVENT_TYPES, AUDIT_ACTOR_TYPES } = require('./constants');

const VALID_TYPES = new Set(Object.values(AUDIT_EVENT_TYPES));
const VALID_ACTORS = new Set(AUDIT_ACTOR_TYPES);

const INSERT_SQL = `INSERT INTO audit_log (event_type, actor_type, actor_id, event_id, target_id, ip_hash, detail)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

/**
 * @param {object} entry
 * @param {string} entry.eventType one of AUDIT_EVENT_TYPES
 * @param {'user'|'guest'|'system'|'anonymous'} entry.actorType
 * @param {string|null} [entry.actorId] user_id or invitation_id
 * @param {string|null} [entry.eventId]
 * @param {string|null} [entry.targetId]
 * @param {string|null} [entry.ip] raw client IP (hashed here, never stored)
 * @param {object} [entry.detail]
 * @param {object} [opts] { client } to write inside an open transaction (errors then propagate)
 */
async function writeAudit(entry, opts = {}) {
  const eventType = entry.eventType;
  if (!VALID_TYPES.has(eventType)) throw new Error(`Unknown audit event type: ${eventType}`);
  const actorType = VALID_ACTORS.has(entry.actorType) ? entry.actorType : 'anonymous';
  const actorId = isUuid(entry.actorId) ? entry.actorId : null;
  const eventId = isUuid(entry.eventId) ? entry.eventId : null;
  const targetId = isUuid(entry.targetId) ? entry.targetId : null;
  const detail = logger.sanitize(entry.detail && typeof entry.detail === 'object' ? entry.detail : {});

  let ipHash = null;
  try {
    ipHash = await hashIp(entry.ip);
  } catch (err) {
    logger.warn('audit_ip_hash_unavailable', { error: err });
  }

  logger.security(eventType, {
    event_type: eventType,
    actor_type: actorType,
    actor_id: actorId,
    event_id: eventId,
    target_id: targetId,
    ip_hash: ipHash,
    detail,
  });

  const params = [eventType, actorType, actorId, eventId, targetId, ipHash, JSON.stringify(detail)];
  if (opts.client) {
    await opts.client.query(INSERT_SQL, params);
    return;
  }
  try {
    await db.query(INSERT_SQL, params);
  } catch (err) {
    // The request outcome must not depend on the audit table being reachable; the
    // security_event log line above is still in CloudWatch.
    logger.error('audit_write_failed', { event_type: eventType, error: err });
  }
}

/** Derives actor/event fields from an Express request. */
function actorFromRequest(req) {
  if (req.user) return { actorType: 'user', actorId: req.user.user_id };
  if (req.invitation) return { actorType: 'guest', actorId: req.invitation.invitation_id };
  return { actorType: 'anonymous', actorId: null };
}

function eventIdFromRequest(req) {
  if (req.event && req.event.event_id) return req.event.event_id;
  if (req.invitation && req.invitation.event_id) return req.invitation.event_id;
  const p = req.params && req.params.eventId;
  return isUuid(p) ? p : null;
}

/**
 * Writes an audit entry for the current request.
 * @param {import('express').Request} req
 * @param {string} eventType
 * @param {{ eventId?: string, targetId?: string, detail?: object, client?: object }} [extra]
 */
async function auditFromRequest(req, eventType, extra = {}) {
  const { actorType, actorId } = actorFromRequest(req);
  return writeAudit(
    {
      eventType,
      actorType,
      actorId,
      eventId: extra.eventId || eventIdFromRequest(req),
      targetId: extra.targetId || null,
      ip: req.clientIp,
      detail: { request_id: req.id, ...(extra.detail || {}) },
    },
    { client: extra.client },
  );
}

module.exports = { writeAudit, auditFromRequest, actorFromRequest, AUDIT_EVENT_TYPES };
