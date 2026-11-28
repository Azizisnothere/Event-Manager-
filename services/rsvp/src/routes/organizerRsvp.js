'use strict';
const express = require('express');
const {
  db,
  errors,
  audit,
  constants,
  eventAccess,
  utils,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { RSVP_COLUMNS } = require('../lib/capacity');
const { promoteFromWaitlist, promoteOne, promotionAllowed } = require('../lib/waitlist');
const mail = require('../lib/rsvpEmails');

const { AUDIT_EVENT_TYPES } = constants;

async function capacitySummary(client, event) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(sum(party_size) FILTER (WHERE status = 'confirmed'), 0)::int  AS confirmed_headcount,
       COALESCE(sum(party_size) FILTER (WHERE status = 'waitlisted'), 0)::int AS waitlisted_headcount,
       count(*) FILTER (WHERE status = 'confirmed')::int                      AS confirmed_count,
       count(*) FILTER (WHERE status = 'waitlisted')::int                     AS waitlisted_count,
       count(*) FILTER (WHERE status = 'declined')::int                       AS declined_count
     FROM rsvps WHERE event_id = $1`,
    [event.event_id],
  );
  const s = rows[0];
  return {
    event_id: event.event_id,
    capacity: event.capacity,
    confirmed_headcount: s.confirmed_headcount,
    waitlisted_headcount: s.waitlisted_headcount,
    remaining_seats: Math.max(0, event.capacity - s.confirmed_headcount),
    confirmed_count: s.confirmed_count,
    waitlisted_count: s.waitlisted_count,
    declined_count: s.declined_count,
  };
}

async function lockOwnedRsvp(client, req, rsvpId) {
  const ev = await eventAccess.findOwnedEvent(client, req.event.event_id, req.user.user_id, { forUpdate: true });
  const { rows } = await client.query(
    `SELECT r.rsvp_id, r.invitation_id, r.event_id, r.status, r.party_size, r.check_in_code, r.waitlisted_at,
            i.guest_name, i.guest_email
       FROM rsvps r JOIN invitations i ON i.invitation_id = r.invitation_id
      WHERE r.rsvp_id = $1 AND r.event_id = $2
      FOR UPDATE OF r`,
    [rsvpId, ev.event_id],
  );
  if (!rows.length) throw errors.notFound('RSVP not found.', 'RSVP_NOT_FOUND');
  return { ev, r: rows[0] };
}

function organizerRsvpRoutes() {
  const router = express.Router();

  router.get(
    '/api/events/:eventId/rsvps',
    authenticate(),
    requireRole('organizer', 'staff'),
    authorizeEvent({ allowStaff: true }),
    validateRequest(schemas.listRsvps),
    async (req, res) => {
      const { search, status, limit, offset } = req.valid.query;
      const pattern = search ? `%${utils.escapeLike(search)}%` : null;
      const isStaff = req.user.role === 'staff';
      const columns = isStaff
        ? 'r.rsvp_id, i.guest_name, r.party_size, r.status'
        : `r.rsvp_id, r.invitation_id, i.guest_name, i.guest_email, r.status, r.party_size, r.dietary_notes,
           r.check_in_code, r.waitlisted_at, r.promoted_at, r.cancelled_at, r.cancel_reason, r.responded_at, r.updated_at`;
      const searchCond = isStaff
        ? `($3::text IS NULL OR i.guest_name ILIKE $3 ESCAPE '\\')`
        : `($3::text IS NULL OR i.guest_name ILIKE $3 ESCAPE '\\' OR i.guest_email ILIKE $3 ESCAPE '\\')`;
      const { rows } = await db.query(
        `SELECT ${columns}, count(*) OVER ()::int AS total
           FROM rsvps r JOIN invitations i ON i.invitation_id = r.invitation_id
          WHERE r.event_id = $1
            AND ($2::text IS NULL OR r.status = $2)
            AND ${searchCond}
          ORDER BY r.responded_at DESC
          LIMIT $4 OFFSET $5`,
        [req.event.event_id, status || null, pattern, limit, offset],
      );
      const total = rows.length ? rows[0].total : 0;
      const list = rows.map((r) => {
        const { total: _t, ...rest } = r;
        ['waitlisted_at', 'promoted_at', 'cancelled_at', 'responded_at', 'updated_at'].forEach((k) => {
          if (k in rest) rest[k] = utils.toIso(rest[k]);
        });
        return rest;
      });
      res.json({ rsvps: list, total, limit, offset });
    },
  );

  router.get(
    '/api/events/:eventId/waitlist',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const summary = await capacitySummary(db.pool, req.event);
      const { rows } = await db.query(
        `SELECT r.rsvp_id, i.guest_name, i.guest_email, r.party_size, r.waitlisted_at,
                row_number() OVER (ORDER BY r.waitlisted_at, r.rsvp_id)::int AS position
           FROM rsvps r JOIN invitations i ON i.invitation_id = r.invitation_id
          WHERE r.event_id = $1 AND r.status = 'waitlisted'
          ORDER BY r.waitlisted_at, r.rsvp_id`,
        [req.event.event_id],
      );
      res.json({
        capacity: summary,
        waitlist: rows.map((r) => ({
          position: r.position,
          rsvp_id: r.rsvp_id,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          party_size: r.party_size,
          waitlisted_at: utils.toIso(r.waitlisted_at),
          fits_now: r.party_size <= summary.remaining_seats,
        })),
      });
    },
  );

  router.post(
    '/api/events/:eventId/rsvps/:rsvpId/promote',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.promote),
    async (req, res) => {
      const { rsvpId } = req.valid.params;
      const outcome = await db.withTransaction(async (client) => {
        const { ev, r } = await lockOwnedRsvp(client, req, rsvpId);
        if (!promotionAllowed(ev)) {
          throw errors.conflict('Guests can only be promoted before the event starts.', 'PROMOTION_CLOSED');
        }
        if (r.status !== 'waitlisted') throw errors.conflict('Only waitlisted guests can be promoted.', 'NOT_WAITLISTED');
        const promoted = await promoteOne(client, ev, r);
        if (!promoted) throw errors.conflict('There are not enough free seats for this party.', 'NO_SEATS');
        await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.RSVP_PROMOTED, {
          eventId: ev.event_id,
          targetId: r.rsvp_id,
          detail: { party_size: r.party_size },
          client,
        });
        return { ev, promoted };
      });
      await mail.queue(mail.promotedJobs(outcome.ev, [outcome.promoted]));
      res.json({ rsvp: { rsvp_id: rsvpId, status: 'confirmed', party_size: outcome.promoted.party_size } });
    },
  );

  router.patch(
    '/api/events/:eventId/rsvps/:rsvpId',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.organizerCancel),
    async (req, res) => {
      const { rsvpId } = req.valid.params;
      const { reason } = req.valid.body;
      const outcome = await db.withTransaction(async (client) => {
        const { ev, r } = await lockOwnedRsvp(client, req, rsvpId);
        if (['completed', 'cancelled'].includes(ev.status)) {
          throw errors.conflict(`RSVPs of a ${ev.status} event cannot be changed.`, 'EVENT_CLOSED');
        }
        if (!['confirmed', 'waitlisted'].includes(r.status)) {
          throw errors.conflict(`An RSVP with status "${r.status}" cannot be cancelled.`, 'NOT_CANCELLABLE');
        }
        const { rowCount: checkedIn } = await client.query(
          `SELECT 1 FROM check_ins WHERE rsvp_id = $1 AND status = 'active'`,
          [r.rsvp_id],
        );
        if (checkedIn) throw errors.conflict('This guest has already checked in.', 'GUEST_CHECKED_IN');
        await client.query(
          `UPDATE rsvps SET status = 'cancelled_by_organizer', cancelled_at = now(), cancelled_from_status = $2, cancel_reason = $3
            WHERE rsvp_id = $1`,
          [r.rsvp_id, r.status, reason],
        );
        await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.RSVP_CANCELLED, {
          eventId: ev.event_id,
          targetId: r.rsvp_id,
          detail: { cancelled_by: 'organizer', from_status: r.status, reason },
          client,
        });
        const promoted = r.status === 'confirmed' ? await promoteFromWaitlist(client, ev) : [];
        return { ev, r, promoted };
      });
      const jobs = [mail.cancelledJob(outcome.ev, outcome.r, 'organizer'), ...mail.promotedJobs(outcome.ev, outcome.promoted)];
      await mail.queue(jobs);
      res.json({
        rsvp: { rsvp_id: rsvpId, status: 'cancelled_by_organizer', cancel_reason: reason },
        promoted: outcome.promoted.map((p) => ({ rsvp_id: p.rsvp_id, guest_name: p.guest_name, party_size: p.party_size })),
      });
    },
  );

  router.get(
    '/api/events/:eventId/capacity',
    authenticate(),
    requireRole('organizer', 'staff'),
    authorizeEvent({ allowStaff: true }),
    validateRequest(schemas.eventParams),
    async (req, res) => {
      res.json({ capacity: await capacitySummary(db.pool, req.event) });
    },
  );

  return router;
}

module.exports = { organizerRsvpRoutes, capacitySummary, RSVP_COLUMNS };
