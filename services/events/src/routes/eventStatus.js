'use strict';
/**
 * PATCH /api/events/:eventId/status   publish, close RSVPs, complete or cancel   200 | 400, 401, 403, 404, 409
 * Rules (Section 1.2 / 5.1):
 *  - invalid transitions -> 409 (statusMachine)
 *  - publish needs at least one invitation and a verified venue, and a future RSVP deadline (A5)
 *  - manual completion only after start_time (A4)
 *  - cancel cascades to RSVPs through event.cancelled; complete triggers the report through event.completed
 */
const express = require('express');
const {
  db,
  errors,
  eventAccess,
  emailQueue,
  logger,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { assertTransition } = require('../lib/statusMachine');
const { toEventResponse } = require('../lib/eventView');
const { issueTokens, organizerName, invitationEmailJobs } = require('../lib/invitationService');
const { publishEventCancelled, publishEventCompleted } = require('../lib/domainEvents');

const RETURNING = eventAccess.EVENT_COLUMNS.join(', ');

function eventStatusRoutes() {
  const router = express.Router();

  router.patch(
    '/api/events/:eventId/status',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.changeStatus),
    async (req, res) => {
      const { status: target, reason } = req.valid.body;
      if (reason !== undefined && target !== 'cancelled') {
        throw errors.validationError([{ field: 'reason', message: 'is only allowed when cancelling' }]);
      }

      const outcome = await db.withTransaction(async (client) => {
        const ev = await eventAccess.findOwnedEvent(client, req.event.event_id, req.user.user_id, { forUpdate: true });
        assertTransition(ev.status, target); // invalid transition -> 409
        const now = Date.now();
        let emailJobs = [];
        let updated;

        if (target === 'published') {
          if (!ev.venue_verified) {
            throw errors.conflict('The venue must be verified before publishing. Edit the event to verify the address.', 'VENUE_NOT_VERIFIED');
          }
          if (new Date(ev.rsvp_deadline).getTime() <= now) {
            throw errors.conflict('The RSVP deadline has passed. Move it to the future before publishing.', 'RSVP_DEADLINE_PASSED');
          }
          const { rows: pending } = await client.query(
            `SELECT invitation_id FROM invitations WHERE event_id = $1 AND status <> 'revoked' ORDER BY created_at`,
            [ev.event_id],
          );
          if (!pending.length) {
            throw errors.conflict('Add at least one guest before publishing.', 'NO_INVITATIONS');
          }
          ({ rows: [updated] } = await client.query(
            `UPDATE events SET status = 'published' WHERE event_id = $1 AND organizer_id = $2 RETURNING ${RETURNING}`,
            [ev.event_id, req.user.user_id],
          ));
          // Issue tokens for invitations that were never emailed and queue the invitations.
          const { rows: unsent } = await client.query(
            `SELECT invitation_id FROM invitations WHERE event_id = $1 AND status = 'pending'`,
            [ev.event_id],
          );
          const issued = await issueTokens(client, unsent.map((r) => r.invitation_id));
          const host = await organizerName(client, ev.organizer_id);
          emailJobs = invitationEmailJobs(updated, host, issued);
        } else if (target === 'rsvp_closed') {
          ({ rows: [updated] } = await client.query(
            `UPDATE events SET status = 'rsvp_closed' WHERE event_id = $1 AND organizer_id = $2 RETURNING ${RETURNING}`,
            [ev.event_id, req.user.user_id],
          ));
        } else if (target === 'completed') {
          // The organizer may complete manually any time after start_time.
          if (new Date(ev.start_time).getTime() > now) {
            throw errors.conflict('An event can only be completed after it has started.', 'EVENT_NOT_STARTED');
          }
          ({ rows: [updated] } = await client.query(
            `UPDATE events SET status = 'completed', completed_at = now()
              WHERE event_id = $1 AND organizer_id = $2 RETURNING ${RETURNING}`,
            [ev.event_id, req.user.user_id],
          ));
        } else {
          ({ rows: [updated] } = await client.query(
            `UPDATE events SET status = 'cancelled', cancel_reason = $3
              WHERE event_id = $1 AND organizer_id = $2 RETURNING ${RETURNING}`,
            [ev.event_id, req.user.user_id, reason || null],
          ));
        }
        return { updated, emailJobs };
      });

      // After COMMIT: emails and cross-service messages.
      let emailsQueued = 0;
      if (outcome.emailJobs.length) {
        try {
          emailsQueued = await emailQueue.enqueueEmails(outcome.emailJobs);
        } catch (err) {
          logger.error('invitation_emails_not_queued', { event_id: outcome.updated.event_id, error: err });
        }
      }
      if (target === 'cancelled') await publishEventCancelled(outcome.updated.event_id, reason);
      if (target === 'completed') await publishEventCompleted(outcome.updated.event_id, 'organizer');

      res.json({ event: toEventResponse(outcome.updated), invitations_emailed: emailsQueued });
    },
  );

  return router;
}

module.exports = { eventStatusRoutes };
