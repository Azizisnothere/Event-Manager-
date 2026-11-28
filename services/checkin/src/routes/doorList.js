'use strict';
const express = require('express');
const {
  db,
  utils,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { checkinWindow, isCheckinOpen } = require('../lib/checkinWindow');

function doorListRoutes() {
  const router = express.Router();

  router.get(
    '/api/events/:eventId/door-list',
    authenticate(),
    requireRole('organizer', 'staff'),
    authorizeEvent({ allowStaff: true }),
    validateRequest(schemas.doorList),
    async (req, res) => {
      const { search, checked_in: checkedIn, limit, offset } = req.valid.query;
      const pattern = search ? `%${utils.escapeLike(search)}%` : null;
      const { rows } = await db.query(
        `SELECT r.rsvp_id, i.guest_name, r.party_size,
                c.checkin_id, c.people_arrived, c.checked_in_at,
                count(*) OVER ()::int AS total
           FROM rsvps r
           JOIN invitations i ON i.invitation_id = r.invitation_id
           LEFT JOIN check_ins c ON c.rsvp_id = r.rsvp_id AND c.status = 'active'
          WHERE r.event_id = $1 AND r.status = 'confirmed'
            AND ($2::text IS NULL OR i.guest_name ILIKE $2 ESCAPE '\\')
            AND ($3::boolean IS NULL OR (c.checkin_id IS NOT NULL) = $3)
          ORDER BY i.guest_name, r.rsvp_id
          LIMIT $4 OFFSET $5`,
        [req.event.event_id, pattern, checkedIn === undefined ? null : checkedIn, limit, offset],
      );
      const w = checkinWindow(req.event);
      res.json({
        event: { event_id: req.event.event_id, title: req.event.title, status: req.event.status },
        checkin_window: { opens_at: w.opens_at.toISOString(), closes_at: w.closes_at.toISOString(), open: isCheckinOpen(req.event) },
        guests: rows.map((r) => ({
          rsvp_id: r.rsvp_id,
          guest_name: r.guest_name,
          party_size: r.party_size,
          checked_in: Boolean(r.checkin_id),
          checkin_id: r.checkin_id,
          people_arrived: r.people_arrived,
          checked_in_at: utils.toIso(r.checked_in_at),
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
      });
    },
  );

  return router;
}

module.exports = { doorListRoutes };
