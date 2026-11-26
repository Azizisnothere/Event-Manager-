'use strict';
/**
 * Guest list and personal invitations (Section 5.1, owner: Osama):
 *   POST   /api/events/:eventId/invitations                        add guests             201 | 400, 401, 403, 404, 409
 *   GET    /api/events/:eventId/invitations                        list (?search, ?status) 200 | 400, 401, 403, 404
 *   DELETE /api/events/:eventId/invitations/:invitationId          revoke                 200 | 401, 403, 404, 409
 *   POST   /api/events/:eventId/invitations/:invitationId/resend   resend (3 per day)     202 | 401, 403, 404, 409, 429
 */
const express = require('express');
const {
  db,
  errors,
  eventAccess,
  emailQueue,
  requestGuard,
  audit,
  constants,
  utils,
  logger,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { GUEST_LIST_OPEN_STATUSES } = require('../lib/statusMachine');
const { addGuests, issueTokens, organizerName, invitationEmailJobs } = require('../lib/invitationService');
const { publishInvitationRevoked } = require('../lib/domainEvents');

const { INVITATION_RESEND_DAILY_LIMIT, REPEAT_NO_SHOW_THRESHOLD, AUDIT_EVENT_TYPES } = constants;

const organizerOnly = [authenticate(), requireRole('organizer'), authorizeEvent()];

function invitationRoutes() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // POST /api/events/:eventId/invitations
  // ---------------------------------------------------------------------------
  router.post(
    '/api/events/:eventId/invitations',
    ...organizerOnly,
    validateRequest(schemas.addGuests),
    async (req, res) => {
      const { guests } = req.valid.body;
      const outcome = await db.withTransaction(async (client) => {
        // Lock the event so the invite-limit check cannot race (Threat 3: ownership in WHERE).
        const ev = await eventAccess.findOwnedEvent(client, req.event.event_id, req.user.user_id, { forUpdate: true });
        if (!GUEST_LIST_OPEN_STATUSES.includes(ev.status)) {
          throw errors.conflict(`Guests cannot be added to a ${ev.status} event.`, 'GUEST_LIST_CLOSED');
        }
        const result = await addGuests(client, ev, guests, { mode: 'all_or_nothing' });
        let emailJobs = [];
        if (ev.status === 'published' && result.added.length) {
          // Added after publishing: email immediately.
          const issued = await issueTokens(client, result.added.map((r) => r.invitation_id));
          emailJobs = invitationEmailJobs(ev, await organizerName(client, ev.organizer_id), issued);
        }
        return { ev, result, emailJobs };
      });

      if (outcome.emailJobs.length) {
        try {
          await emailQueue.enqueueEmails(outcome.emailJobs);
        } catch (err) {
          logger.error('invitation_emails_not_queued', { event_id: outcome.ev.event_id, error: err });
        }
      }
      res.status(201).json({
        added: outcome.result.added.map((r) => ({
          invitation_id: r.invitation_id,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          plus_one_allowance: r.plus_one_allowance,
          category: r.category,
          status: outcome.emailJobs.length ? 'sent' : r.status,
        })),
        skipped: outcome.result.skipped.map((s) => ({ guest_email: s.guest_email, reason: s.reason })),
        invited_headcount: outcome.result.invitedHeadcount,
        invite_limit: outcome.ev.invite_limit,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/invitations
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/invitations',
    ...organizerOnly,
    validateRequest(schemas.listInvitations),
    async (req, res) => {
      const { search, status, repeat_no_show: repeatOnly, limit, offset } = req.valid.query;
      const pattern = search ? `%${utils.escapeLike(search)}%` : null;
      // guest_history is per organizer; the repeat no-show flag compares with the named threshold (A28).
      const { rows } = await db.query(
        `SELECT i.invitation_id, i.guest_name, i.guest_email, i.category, i.plus_one_allowance, i.status,
                i.last_sent_at, i.created_at,
                r.rsvp_id, r.status AS rsvp_status, r.party_size,
                EXISTS (SELECT 1 FROM check_ins c WHERE c.rsvp_id = r.rsvp_id AND c.status = 'active') AS checked_in,
                COALESCE(gh.no_shows, 0)::int AS previous_no_shows,
                (COALESCE(gh.no_shows, 0) >= $6) AS repeat_no_show,
                count(*) OVER ()::int AS total
           FROM invitations i
           JOIN events e ON e.event_id = i.event_id
           LEFT JOIN rsvps r ON r.invitation_id = i.invitation_id
           LEFT JOIN guest_history gh ON gh.organizer_id = e.organizer_id AND gh.guest_email_lower = lower(i.guest_email)
          WHERE i.event_id = $1 AND e.organizer_id = $2
            AND ($3::text IS NULL OR i.guest_name ILIKE $3 ESCAPE '\\' OR i.guest_email ILIKE $3 ESCAPE '\\')
            AND ($4::text IS NULL OR i.status = $4)
            AND ($5::boolean IS NULL OR $5 = false OR COALESCE(gh.no_shows, 0) >= $6)
          ORDER BY i.created_at, i.guest_name
          LIMIT $7 OFFSET $8`,
        [
          req.event.event_id,
          req.user.user_id,
          pattern,
          status || null,
          repeatOnly === undefined ? null : repeatOnly,
          REPEAT_NO_SHOW_THRESHOLD,
          limit,
          offset,
        ],
      );
      res.json({
        invitations: rows.map((r) => ({
          invitation_id: r.invitation_id,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          category: r.category,
          plus_one_allowance: r.plus_one_allowance,
          status: r.status,
          last_sent_at: utils.toIso(r.last_sent_at),
          created_at: utils.toIso(r.created_at),
          rsvp_id: r.rsvp_id,
          rsvp_status: r.rsvp_status,
          party_size: r.party_size,
          checked_in: r.checked_in,
          previous_no_shows: r.previous_no_shows,
          repeat_no_show: r.repeat_no_show,
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
        repeat_no_show_threshold: REPEAT_NO_SHOW_THRESHOLD,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/events/:eventId/invitations/:invitationId  (revoke)
  // ---------------------------------------------------------------------------
  router.delete(
    '/api/events/:eventId/invitations/:invitationId',
    ...organizerOnly,
    validateRequest(schemas.invitationParams),
    async (req, res) => {
      const { invitationId } = req.valid.params;
      const revoked = await db.withTransaction(async (client) => {
        const ev = await eventAccess.findOwnedEvent(client, req.event.event_id, req.user.user_id, { forUpdate: true });
        if (['completed', 'cancelled'].includes(ev.status)) {
          throw errors.conflict(`Invitations of a ${ev.status} event cannot be revoked.`, 'EVENT_CLOSED');
        }
        const { rows } = await client.query(
          `SELECT invitation_id, status FROM invitations WHERE invitation_id = $1 AND event_id = $2 FOR UPDATE`,
          [invitationId, ev.event_id],
        );
        if (!rows.length) throw errors.notFound('Invitation not found.', 'INVITATION_NOT_FOUND');
        if (rows[0].status === 'revoked') throw errors.conflict('This invitation is already revoked.', 'ALREADY_REVOKED');
        // An invitation cannot be revoked after check-in.
        const { rowCount: checkedIn } = await client.query(
          `SELECT 1 FROM rsvps r JOIN check_ins c ON c.rsvp_id = r.rsvp_id AND c.status = 'active'
            WHERE r.invitation_id = $1`,
          [invitationId],
        );
        if (checkedIn) throw errors.conflict('This guest has already checked in, so the invitation cannot be revoked.', 'GUEST_CHECKED_IN');

        await client.query(
          `UPDATE invitations SET status = 'revoked', revoked_at = now() WHERE invitation_id = $1 AND event_id = $2`,
          [invitationId, ev.event_id],
        );
        // Threat 9: who revoked which invitation is kept in the insert-only audit log.
        await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.INVITATION_REVOKED, {
          eventId: ev.event_id,
          targetId: invitationId,
          client,
        });
        return { eventId: ev.event_id };
      });
      // The RSVP service frees the seat and promotes from the waitlist (A1, A14).
      await publishInvitationRevoked(revoked.eventId, invitationId);
      res.json({ invitation_id: invitationId, status: 'revoked' });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/events/:eventId/invitations/:invitationId/resend
  // ---------------------------------------------------------------------------
  router.post(
    '/api/events/:eventId/invitations/:invitationId/resend',
    ...organizerOnly,
    validateRequest({ ...schemas.invitationParams, body: {} }),
    async (req, res) => {
      const { invitationId } = req.valid.params;
      const ev = req.event;
      if (ev.status !== 'published') {
        throw errors.conflict('Invitations can only be resent while the event is published.', 'EVENT_NOT_PUBLISHED');
      }
      const { rows: invRows } = await db.query(
        `SELECT status FROM invitations WHERE invitation_id = $1 AND event_id = $2`,
        [invitationId, ev.event_id],
      );
      if (!invRows.length) throw errors.notFound('Invitation not found.', 'INVITATION_NOT_FOUND');
      if (invRows[0].status === 'revoked') throw errors.conflict('A revoked invitation cannot be resent.', 'ALREADY_REVOKED');

      // Threat 6: at most 3 resends per invitation per UTC day (DynamoDB counter, fail closed).
      let limit;
      try {
        limit = await requestGuard.hit(
          `resend#${invitationId}#${utils.utcDayKey()}`,
          INVITATION_RESEND_DAILY_LIMIT,
          utils.secondsUntilNextUtcMidnight() + 60,
        );
      } catch (err) {
        logger.error('resend_counter_unavailable', { error: err });
        throw errors.serviceUnavailable('Resending is temporarily unavailable.');
      }
      if (!limit.allowed) {
        throw errors.tooManyRequests(`An invitation can be resent at most ${INVITATION_RESEND_DAILY_LIMIT} times per day.`, limit.retryAfterSeconds);
      }

      const jobs = await db.withTransaction(async (client) => {
        const locked = await eventAccess.findOwnedEvent(client, ev.event_id, req.user.user_id, { forUpdate: true });
        if (locked.status !== 'published') {
          throw errors.conflict('Invitations can only be resent while the event is published.', 'EVENT_NOT_PUBLISHED');
        }
        // A new token replaces the old one, so a leaked earlier link stops working (Threat 2, A9).
        const issued = await issueTokens(client, [invitationId]);
        if (!issued.length) throw errors.conflict('A revoked invitation cannot be resent.', 'ALREADY_REVOKED');
        return invitationEmailJobs(locked, await organizerName(client, locked.organizer_id), issued, { resend: true });
      });
      await emailQueue.enqueueEmails(jobs);
      res.status(202).json({
        invitation_id: invitationId,
        status: 'queued',
        resends_remaining_today: Math.max(0, INVITATION_RESEND_DAILY_LIMIT - limit.count),
      });
    },
  );

  return router;
}

module.exports = { invitationRoutes };
