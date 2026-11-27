'use strict';
/**
 * Event endpoints (Section 5.1, owner: Osama):
 *   POST  /api/events            create a draft event (venue geocoded)          201 | 400, 401, 403, 422
 *   GET   /api/events            own events (organizer) / assigned (staff)      200 | 401
 *   GET   /api/events/:eventId   event details                                  200 | 401, 403, 404
 *   PATCH /api/events/:eventId   edit details or capacity                       200 | 400, 401, 403, 404, 409, 422
 */
const express = require('express');
const {
  db,
  errors,
  eventAccess,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas, assertEventTimes } = require('../validators');
const { geocodeAddress } = require('../lib/geoapify');
const { EDITABLE_STATUSES } = require('../lib/statusMachine');
const { toEventResponse, eventStats } = require('../lib/eventView');
const { invitedHeadcount } = require('../lib/invitationService');
const { publishCapacityChanged, publishEventUpdated } = require('../lib/domainEvents');

const NOTIFY_FIELDS = ['title', 'description', 'venue_address', 'start_time', 'end_time', 'rsvp_deadline'];

/** Geocodes and converts the result into column values + warnings (A6). */
async function resolveVenue(address) {
  const geo = await geocodeAddress(address);
  if (geo.status === 'not_found') {
    throw errors.unprocessable('The venue address could not be found. Please check it and try again.', 'VENUE_NOT_FOUND', [
      { field: 'venue_address', message: 'address not found' },
    ]);
  }
  if (geo.status === 'found') {
    return { venue_lat: geo.lat, venue_lng: geo.lng, venue_verified: true, warnings: [], formatted: geo.formatted };
  }
  return {
    venue_lat: null,
    venue_lng: null,
    venue_verified: false,
    formatted: null,
    warnings: [
      {
        code: 'VENUE_NOT_VERIFIED',
        message: 'The address service is unavailable, so the venue is not verified yet. Save the event again later to verify it; it cannot be published until then.',
      },
    ],
  };
}

function sameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

function eventRoutes() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // POST /api/events
  // ---------------------------------------------------------------------------
  router.post(
    '/api/events',
    authenticate(),
    requireRole('organizer'), // Section 6.1: only organizers create events
    validateRequest(schemas.createEvent),
    async (req, res) => {
      const b = req.valid.body;
      assertEventTimes(b, { requireFutureStart: true, requireFutureDeadline: true });
      const venue = await resolveVenue(b.venue_address);
      const { rows } = await db.query(
        `INSERT INTO events (organizer_id, title, description, venue_address, venue_lat, venue_lng, venue_verified,
                             start_time, end_time, rsvp_deadline, capacity, invite_limit, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')
         RETURNING ${eventAccess.EVENT_COLUMNS.join(', ')}`,
        [
          req.user.user_id, // organizer_id always comes from the verified JWT, never the body (Threat 3)
          b.title,
          b.description === undefined ? null : b.description,
          b.venue_address,
          venue.venue_lat,
          venue.venue_lng,
          venue.venue_verified,
          b.start_time,
          b.end_time,
          b.rsvp_deadline,
          b.capacity,
          b.invite_limit,
        ],
      );
      res.status(201).json({ event: toEventResponse(rows[0]), venue_formatted: venue.formatted, warnings: venue.warnings });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events',
    authenticate(),
    requireRole('organizer', 'staff'),
    validateRequest(schemas.listEvents),
    async (req, res) => {
      const { status, limit, offset } = req.valid.query;
      if (req.user.role === 'organizer') {
        // Threat 3: ownership in WHERE.
        const { rows } = await db.query(
          `SELECT ${eventAccess.EVENT_SELECT},
                  COALESCE(inv.invited_count, 0)::int       AS invited_count,
                  COALESCE(inv.invited_headcount, 0)::int   AS invited_headcount,
                  COALESCE(r.confirmed_headcount, 0)::int   AS confirmed_headcount,
                  COALESCE(r.waitlisted_headcount, 0)::int  AS waitlisted_headcount,
                  count(*) OVER ()::int                     AS total
             FROM events e
             LEFT JOIN LATERAL (
               SELECT count(*) AS invited_count, sum(1 + plus_one_allowance) AS invited_headcount
                 FROM invitations WHERE event_id = e.event_id AND status <> 'revoked') inv ON true
             LEFT JOIN LATERAL (
               SELECT sum(party_size) FILTER (WHERE status = 'confirmed')  AS confirmed_headcount,
                      sum(party_size) FILTER (WHERE status = 'waitlisted') AS waitlisted_headcount
                 FROM rsvps WHERE event_id = e.event_id) r ON true
            WHERE e.organizer_id = $1
              AND ($2::text IS NULL OR e.status = $2)
            ORDER BY e.start_time DESC
            LIMIT $3 OFFSET $4`,
          [req.user.user_id, status || null, limit, offset],
        );
        return res.json({
          events: rows.map((r) =>
            toEventResponse(r, {
              invited_count: r.invited_count,
              invited_headcount: r.invited_headcount,
              confirmed_headcount: r.confirmed_headcount,
              waitlisted_headcount: r.waitlisted_headcount,
            }),
          ),
          total: rows.length ? rows[0].total : 0,
          limit,
          offset,
        });
      }
      // Staff: only events they are assigned to (Threat 4), reduced fields (no invite limit).
      const { rows } = await db.query(
        `SELECT e.event_id, e.title, e.venue_address, e.venue_lat, e.venue_lng, e.start_time, e.end_time,
                e.status, e.capacity, es.assigned_at, count(*) OVER ()::int AS total
           FROM events e
           JOIN event_staff es ON es.event_id = e.event_id AND es.user_id = $1
          WHERE ($2::text IS NULL OR e.status = $2)
          ORDER BY e.start_time ASC
          LIMIT $3 OFFSET $4`,
        [req.user.user_id, status || null, limit, offset],
      );
      return res.json({
        events: rows.map((r) => ({
          event_id: r.event_id,
          title: r.title,
          venue_address: r.venue_address,
          venue_lat: r.venue_lat === null ? null : Number(r.venue_lat),
          venue_lng: r.venue_lng === null ? null : Number(r.venue_lng),
          start_time: r.start_time.toISOString(),
          end_time: r.end_time.toISOString(),
          status: r.status,
          capacity: r.capacity,
          assigned_at: r.assigned_at.toISOString(),
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId',
    authenticate(),
    requireRole('organizer', 'staff'),
    authorizeEvent({ allowStaff: true }), // Threat 3 / 4: owner or assigned staff
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const ev = req.event;
      if (req.user.role === 'staff') {
        const full = toEventResponse(ev);
        delete full.invite_limit;
        delete full.organizer_id;
        return res.json({ event: full });
      }
      const stats = await eventStats(db.pool, ev.event_id);
      return res.json({ event: toEventResponse(ev), stats });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/events/:eventId
  // ---------------------------------------------------------------------------
  router.patch(
    '/api/events/:eventId',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.updateEvent),
    async (req, res) => {
      const patch = req.valid.body;
      const before = req.event;

      // Geocode outside the transaction (network call) when the address changes or is still unverified.
      let venue = null;
      const addressChanged = patch.venue_address !== undefined && patch.venue_address !== before.venue_address;
      if (patch.venue_address !== undefined && (addressChanged || !before.venue_verified)) {
        venue = await resolveVenue(patch.venue_address);
      }

      const result = await db.withTransaction(async (client) => {
        // Re-read and lock with ownership in WHERE (Threat 3).
        const ev = await eventAccess.findOwnedEvent(client, before.event_id, req.user.user_id, { forUpdate: true });
        if (!EDITABLE_STATUSES.includes(ev.status)) {
          throw errors.conflict(`A ${ev.status} event cannot be edited.`, 'EVENT_NOT_EDITABLE');
        }

        const next = {
          title: patch.title !== undefined ? patch.title : ev.title,
          description: patch.description !== undefined ? patch.description : ev.description,
          venue_address: patch.venue_address !== undefined ? patch.venue_address : ev.venue_address,
          start_time: patch.start_time !== undefined ? patch.start_time : new Date(ev.start_time),
          end_time: patch.end_time !== undefined ? patch.end_time : new Date(ev.end_time),
          rsvp_deadline: patch.rsvp_deadline !== undefined ? patch.rsvp_deadline : new Date(ev.rsvp_deadline),
          capacity: patch.capacity !== undefined ? patch.capacity : ev.capacity,
          invite_limit: patch.invite_limit !== undefined ? patch.invite_limit : ev.invite_limit,
          venue_lat: venue ? venue.venue_lat : ev.venue_lat,
          venue_lng: venue ? venue.venue_lng : ev.venue_lng,
          venue_verified: venue ? venue.venue_verified : ev.venue_verified,
        };

        const startChanged = !sameInstant(next.start_time, ev.start_time);
        const deadlineChanged = !sameInstant(next.rsvp_deadline, ev.rsvp_deadline);
        assertEventTimes(next, {
          requireFutureStart: startChanged,
          requireFutureDeadline: deadlineChanged && ev.status !== 'rsvp_closed',
        });

        // Capacity can never go below the confirmed headcount (409).
        if (next.capacity !== ev.capacity) {
          const { rows } = await client.query(
            `SELECT COALESCE(sum(party_size), 0)::int AS confirmed
               FROM rsvps WHERE event_id = $1 AND status = 'confirmed'`,
            [ev.event_id],
          );
          if (next.capacity < rows[0].confirmed) {
            throw errors.conflict('Capacity cannot be lower than the confirmed headcount.', 'CAPACITY_BELOW_CONFIRMED', {
              confirmed_headcount: rows[0].confirmed,
              requested_capacity: next.capacity,
            });
          }
        }
        // The invite limit cannot drop below the headcount already invited (A7).
        if (next.invite_limit !== ev.invite_limit) {
          const invited = await invitedHeadcount(client, ev.event_id);
          if (next.invite_limit < invited) {
            throw errors.conflict('The invite limit cannot be lower than the headcount already invited.', 'INVITE_LIMIT_BELOW_INVITED', {
              invited_headcount: invited,
              requested_invite_limit: next.invite_limit,
            });
          }
        }

        const { rows } = await client.query(
          `UPDATE events
              SET title = $2, description = $3, venue_address = $4, venue_lat = $5, venue_lng = $6, venue_verified = $7,
                  start_time = $8, end_time = $9, rsvp_deadline = $10, capacity = $11, invite_limit = $12
            WHERE event_id = $1 AND organizer_id = $13
            RETURNING ${eventAccess.EVENT_COLUMNS.join(', ')}`,
          [
            ev.event_id,
            next.title,
            next.description,
            next.venue_address,
            next.venue_lat,
            next.venue_lng,
            next.venue_verified,
            next.start_time,
            next.end_time,
            next.rsvp_deadline,
            next.capacity,
            next.invite_limit,
            req.user.user_id,
          ],
        );
        const changed = NOTIFY_FIELDS.filter((f) => {
          if (['start_time', 'end_time', 'rsvp_deadline'].includes(f)) return !sameInstant(rows[0][f], ev[f]);
          return rows[0][f] !== ev[f];
        });
        return { before: ev, after: rows[0], changed };
      });

      // Messages after COMMIT. Drafts have no guests yet, so nothing to notify.
      if (result.after.status !== 'draft') {
        if (result.after.capacity !== result.before.capacity) {
          await publishCapacityChanged(result.after.event_id, result.before.capacity, result.after.capacity);
        }
        if (result.changed.length) await publishEventUpdated(result.after.event_id, result.changed);
      }
      res.json({
        event: toEventResponse(result.after),
        changed_fields: result.changed,
        venue_formatted: venue ? venue.formatted : undefined,
        warnings: venue ? venue.warnings : [],
      });
    },
  );

  return router;
}

module.exports = { eventRoutes };
