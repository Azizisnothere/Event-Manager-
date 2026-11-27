'use strict';
/**
 * Companion (plus-one) requests (Section 5.1, owner: Osama):
 *   POST  /api/invitations/:token/plus-one-requests            guest asks for an extra companion   201 | 400, 404, 409, 429
 *   GET   /api/events/:eventId/plus-one-requests               organizer lists requests            200 | 401, 403, 404
 *   PATCH /api/events/:eventId/plus-one-requests/:requestId    approve or deny                     200 | 400, 401, 403, 404, 409
 * Approval raises that invitation's allowance by 1 only if both the 0-3 cap and the invite
 * limit allow it; otherwise 409.
 */
const express = require('express');
const {
  db,
  errors,
  eventAccess,
  emailQueue,
  constants,
  crypto: emCrypto,
  utils,
  logger,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest, authenticateInvitation, rateLimit },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { invitedHeadcount } = require('../lib/invitationService');

const { PLUS_ONE_MAX, RSVP_RATE_LIMIT_PER_IP, RSVP_RATE_LIMIT_PER_TOKEN, EMAIL_TEMPLATES } = constants;

function plusOneRoutes() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // POST /api/invitations/:token/plus-one-requests  (guest)
  // ---------------------------------------------------------------------------
  router.post(
    '/api/invitations/:token/plus-one-requests',
    // Threat 6: rate limits per IP and per token on guest routes (DynamoDB).
    rateLimit({ name: 'guest-ip', ...RSVP_RATE_LIMIT_PER_IP, key: (req) => emCrypto.hashIp(req.clientIp) }),
    authenticateInvitation(), // Threat 2: SHA-256 token lookup; revoked -> 404
    rateLimit({ name: 'guest-token', ...RSVP_RATE_LIMIT_PER_TOKEN, key: (req) => req.tokenHash }),
    validateRequest(schemas.plusOneRequest),
    async (req, res) => {
      const inv = req.invitation;
      const { companion_name: companionName, note } = req.valid.body;
      const created = await db.withTransaction(async (client) => {
        const { rows: evRows } = await client.query(
          `SELECT event_id, status, rsvp_deadline FROM events WHERE event_id = $1 FOR UPDATE`,
          [inv.event_id],
        );
        const ev = evRows[0];
        if (!ev || ev.status !== 'published' || new Date(ev.rsvp_deadline).getTime() <= Date.now()) {
          throw errors.conflict('Companion requests are closed for this event.', 'RSVP_CLOSED');
        }
        const { rows: invRows } = await client.query(
          `SELECT plus_one_allowance, status FROM invitations WHERE invitation_id = $1 FOR UPDATE`,
          [inv.invitation_id],
        );
        if (!invRows.length || invRows[0].status === 'revoked') {
          throw errors.notFound('This invitation link is not valid.', 'INVITATION_NOT_FOUND');
        }
        if (invRows[0].plus_one_allowance >= PLUS_ONE_MAX) {
          throw errors.conflict(`You can already bring the maximum of ${PLUS_ONE_MAX} companions.`, 'ALLOWANCE_AT_MAXIMUM');
        }
        try {
          const { rows } = await client.query(
            `INSERT INTO plus_one_requests (invitation_id, companion_name, note)
             VALUES ($1, $2, $3)
             RETURNING request_id, companion_name, note, status, created_at`,
            [inv.invitation_id, companionName, note === undefined ? null : note],
          );
          return rows[0];
        } catch (err) {
          if (db.isUniqueViolation(err, 'plus_one_requests_one_pending_uq')) {
            throw errors.conflict('You already have a companion request waiting for a decision.', 'REQUEST_PENDING');
          }
          throw err;
        }
      });
      res.status(201).json({
        request: {
          request_id: created.request_id,
          companion_name: created.companion_name,
          note: created.note,
          status: created.status,
          created_at: utils.toIso(created.created_at),
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/plus-one-requests  (organizer)
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/plus-one-requests',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.listPlusOne),
    async (req, res) => {
      const { status, limit, offset } = req.valid.query;
      const { rows } = await db.query(
        `SELECT p.request_id, p.invitation_id, p.companion_name, p.note, p.status, p.created_at, p.decided_at,
                i.guest_name, i.guest_email, i.plus_one_allowance,
                count(*) OVER ()::int AS total
           FROM plus_one_requests p
           JOIN invitations i ON i.invitation_id = p.invitation_id
           JOIN events e ON e.event_id = i.event_id
          WHERE i.event_id = $1 AND e.organizer_id = $2
            AND ($3::text IS NULL OR p.status = $3)
          ORDER BY (p.status = 'pending') DESC, p.created_at
          LIMIT $4 OFFSET $5`,
        [req.event.event_id, req.user.user_id, status || null, limit, offset],
      );
      res.json({
        requests: rows.map((r) => ({
          request_id: r.request_id,
          invitation_id: r.invitation_id,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          current_allowance: r.plus_one_allowance,
          companion_name: r.companion_name,
          note: r.note,
          status: r.status,
          created_at: utils.toIso(r.created_at),
          decided_at: utils.toIso(r.decided_at),
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/events/:eventId/plus-one-requests/:requestId  (organizer)
  // ---------------------------------------------------------------------------
  router.patch(
    '/api/events/:eventId/plus-one-requests/:requestId',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.decidePlusOne),
    async (req, res) => {
      const { requestId } = req.valid.params;
      const { decision } = req.valid.body;
      const outcome = await db.withTransaction(async (client) => {
        const ev = await eventAccess.findOwnedEvent(client, req.event.event_id, req.user.user_id, { forUpdate: true });
        if (!['draft', 'published', 'rsvp_closed'].includes(ev.status)) {
          throw errors.conflict(`Requests for a ${ev.status} event can no longer be decided.`, 'EVENT_CLOSED');
        }
        const { rows } = await client.query(
          `SELECT p.request_id, p.status, p.companion_name, i.invitation_id, i.plus_one_allowance,
                  i.status AS invitation_status, i.guest_name, i.guest_email
             FROM plus_one_requests p
             JOIN invitations i ON i.invitation_id = p.invitation_id
            WHERE p.request_id = $1 AND i.event_id = $2
            FOR UPDATE OF p, i`,
          [requestId, ev.event_id],
        );
        if (!rows.length) throw errors.notFound('Companion request not found.', 'REQUEST_NOT_FOUND');
        const r = rows[0];
        if (r.status !== 'pending') throw errors.conflict('This request has already been decided.', 'ALREADY_DECIDED');
        if (r.invitation_status === 'revoked') throw errors.conflict('The invitation has been revoked.', 'INVITATION_REVOKED');

        let newAllowance = r.plus_one_allowance;
        if (decision === 'approved') {
          // Rule: approve only if the 0-3 cap AND the invite limit allow one more person.
          if (r.plus_one_allowance + 1 > PLUS_ONE_MAX) {
            throw errors.conflict(`A guest can bring at most ${PLUS_ONE_MAX} companions.`, 'ALLOWANCE_AT_MAXIMUM');
          }
          const invited = await invitedHeadcount(client, ev.event_id);
          if (invited + 1 > ev.invite_limit) {
            throw errors.conflict('Approving would exceed the invite limit.', 'INVITE_LIMIT_EXCEEDED', {
              invite_limit: ev.invite_limit,
              invited_headcount: invited,
            });
          }
          newAllowance = r.plus_one_allowance + 1;
          await client.query(`UPDATE invitations SET plus_one_allowance = $2 WHERE invitation_id = $1`, [
            r.invitation_id,
            newAllowance,
          ]);
        }
        await client.query(
          `UPDATE plus_one_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
          [requestId, decision, req.user.user_id],
        );
        return { ev, r, newAllowance };
      });

      try {
        await emailQueue.enqueueEmail({
          template: EMAIL_TEMPLATES.PLUS_ONE_DECISION,
          to: { email: outcome.r.guest_email, name: outcome.r.guest_name },
          params: {
            guest_name: outcome.r.guest_name,
            event_title: outcome.ev.title,
            companion_name: outcome.r.companion_name,
            decision,
            plus_one_allowance: outcome.newAllowance,
          },
        });
      } catch (err) {
        logger.error('plus_one_email_not_queued', { request_id: requestId, error: err });
      }
      res.json({
        request: { request_id: requestId, status: decision },
        invitation: { invitation_id: outcome.r.invitation_id, plus_one_allowance: outcome.newAllowance },
      });
    },
  );

  return router;
}

module.exports = { plusOneRoutes };
