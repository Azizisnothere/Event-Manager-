'use strict';
const express = require('express');
const {
  db,
  errors,
  audit,
  constants,
  crypto: emCrypto,
  utils,
  middleware: { authenticateInvitation, rateLimit, validateRequest },
} = require('../../../../shared');
const { schemas, partySizeWithinAllowance } = require('../validators');
const { verifyTurnstile } = require('../lib/turnstile');
const { lockEvent, confirmedHeadcount, newCheckInCode, waitlistPosition, toGuestRsvp, RSVP_COLUMNS } = require('../lib/capacity');
const { promoteFromWaitlist } = require('../lib/waitlist');
const mail = require('../lib/rsvpEmails');

const { RSVP_RATE_LIMIT_PER_IP, RSVP_RATE_LIMIT_PER_TOKEN, AUDIT_EVENT_TYPES, PLUS_ONE_MAX } = constants;

const guestChain = [
  rateLimit({ name: 'guest-ip', ...RSVP_RATE_LIMIT_PER_IP, key: (req) => emCrypto.hashIp(req.clientIp) }),
  authenticateInvitation(),
  rateLimit({ name: 'guest-token', ...RSVP_RATE_LIMIT_PER_TOKEN, key: (req) => req.tokenHash }),
];

const LOCKED_STATUSES = ['cancelled_by_organizer', 'event_cancelled'];

async function requireTurnstile(req) {
  const token = req.get('X-Turnstile-Token');
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
    throw errors.validationError([{ field: 'X-Turnstile-Token', message: 'header is required (1-2048 characters)' }]);
  }
  const result = await verifyTurnstile(token, req.clientIp);
  if (result.success) return;
  if (result.unavailable) throw errors.serviceUnavailable('The bot check could not be completed. Please try again.');
  await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.TURNSTILE_FAILED, { detail: { codes: result.codes } });
  throw errors.forbidden('The bot check failed. Please reload the page and try again.', {
    code: 'TURNSTILE_FAILED',
    audited: true,
  });
}

async function lockInvitation(client, invitationId) {
  const { rows } = await client.query(
    `SELECT invitation_id, event_id, guest_name, guest_email, plus_one_allowance, status
       FROM invitations WHERE invitation_id = $1 FOR UPDATE`,
    [invitationId],
  );
  if (!rows.length || rows[0].status === 'revoked') {
    throw errors.notFound('This invitation link is not valid.', 'INVITATION_NOT_FOUND');
  }
  return rows[0];
}

function guestRsvpRoutes() {
  const router = express.Router();

  router.get(
    '/api/invitations/:token',
    ...guestChain,
    validateRequest(schemas.guestView),
    async (req, res) => {
      const inv = req.invitation;
      const { rows: evRows } = await db.query(
        `SELECT e.event_id, e.title, e.description, e.venue_address, e.venue_lat, e.venue_lng, e.venue_verified,
                e.start_time, e.end_time, e.rsvp_deadline, e.status, e.cancel_reason, u.name AS host_name
           FROM events e JOIN users u ON u.user_id = e.organizer_id
          WHERE e.event_id = $1`,
        [inv.event_id],
      );
      const ev = evRows[0];
      if (!ev || ev.status === 'draft') throw errors.notFound('This invitation link is not valid.', 'INVITATION_NOT_FOUND');
      const { rows: rsvpRows } = await db.query(`SELECT ${RSVP_COLUMNS} FROM rsvps WHERE invitation_id = $1`, [
        inv.invitation_id,
      ]);
      const rsvp = rsvpRows[0] || null;
      const position = await waitlistPosition(db.pool, ev.event_id, rsvp);
      const { rows: requests } = await db.query(
        `SELECT request_id, companion_name, status, created_at, decided_at
           FROM plus_one_requests WHERE invitation_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [inv.invitation_id],
      );

      const now = Date.now();
      const beforeDeadline = ev.status === 'published' && new Date(ev.rsvp_deadline).getTime() > now;
      const beforeStart = new Date(ev.start_time).getTime() > now;
      const lat = ev.venue_lat === null ? null : Number(ev.venue_lat);
      const lng = ev.venue_lng === null ? null : Number(ev.venue_lng);
      const hasPending = requests.some((r) => r.status === 'pending');

      res.json({
        invitation: {
          guest_name: inv.guest_name,
          plus_one_allowance: inv.plus_one_allowance,
          max_party_size: 1 + inv.plus_one_allowance,
          status: inv.status,
        },
        event: {
          title: ev.title,
          description: ev.description,
          host_name: ev.host_name,
          venue_address: ev.venue_address,
          venue_lat: lat,
          venue_lng: lng,
          map_url:
            ev.venue_verified && lat !== null && lng !== null
              ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
              : null,
          start_time: utils.toIso(ev.start_time),
          end_time: utils.toIso(ev.end_time),
          rsvp_deadline: utils.toIso(ev.rsvp_deadline),
          status: ev.status,
          cancel_reason: ev.status === 'cancelled' ? ev.cancel_reason : null,
        },
        rsvp: toGuestRsvp(rsvp, position),
        plus_one_requests: requests.map((r) => ({
          request_id: r.request_id,
          companion_name: r.companion_name,
          status: r.status,
          created_at: utils.toIso(r.created_at),
          decided_at: utils.toIso(r.decided_at),
        })),
        actions: {
          can_reply: !rsvp && beforeDeadline,
          can_change: Boolean(rsvp) && beforeDeadline && !LOCKED_STATUSES.includes(rsvp.status),
          can_cancel:
            Boolean(rsvp) &&
            ['confirmed', 'waitlisted'].includes(rsvp.status) &&
            ['published', 'rsvp_closed'].includes(ev.status) &&
            beforeStart,
          can_request_companion: beforeDeadline && inv.plus_one_allowance < PLUS_ONE_MAX && !hasPending,
        },
      });
    },
  );

  router.post(
    '/api/invitations/:token/rsvp',
    ...guestChain,
    validateRequest(schemas.postRsvp),
    partySizeWithinAllowance,
    async (req, res) => {
      await requireTurnstile(req);

      const { response, party_size: partySize, dietary_notes: dietaryNotes } = req.valid.body;
      const outcome = await db.withTransaction(async (client) => {
        const ev = await lockEvent(client, req.invitation.event_id);
        if (!ev || ev.status !== 'published' || new Date(ev.rsvp_deadline).getTime() <= Date.now()) {
          throw errors.conflict('Replies are closed for this event.', 'RSVP_CLOSED');
        }
        const inv = await lockInvitation(client, req.invitation.invitation_id);
        const { rowCount: already } = await client.query(`SELECT 1 FROM rsvps WHERE invitation_id = $1`, [inv.invitation_id]);
        if (already) throw errors.conflict('You have already replied. Use "manage my reply" to change it.', 'ALREADY_RESPONDED');

        let status;
        let code = null;
        let size = 1;
        if (response === 'accept') {
          size = partySize;
          const confirmed = await confirmedHeadcount(client, ev.event_id);
          if (confirmed + size <= ev.capacity) {
            status = 'confirmed';
            code = await newCheckInCode(client, ev.event_id);
          } else {
            status = 'waitlisted';
          }
        } else {
          status = 'declined';
        }

        let inserted;
        try {
          ({ rows: [inserted] } = await client.query(
            `INSERT INTO rsvps (invitation_id, event_id, status, party_size, dietary_notes, check_in_code, waitlisted_at)
             VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() ELSE NULL END)
             RETURNING ${RSVP_COLUMNS}`,
            [inv.invitation_id, ev.event_id, status, size, dietaryNotes === undefined ? null : dietaryNotes, code, status === 'waitlisted'],
          ));
        } catch (err) {
          if (db.isUniqueViolation(err, 'rsvps_invitation_uq')) {
            throw errors.conflict('You have already replied. Use "manage my reply" to change it.', 'ALREADY_RESPONDED');
          }
          throw err;
        }
        await client.query(`UPDATE invitations SET status = 'responded' WHERE invitation_id = $1 AND status = 'sent'`, [
          inv.invitation_id,
        ]);
        const position = await waitlistPosition(client, ev.event_id, inserted);
        return { ev, inv, rsvp: inserted, position };
      });

      const { ev, inv, rsvp, position } = outcome;
      if (rsvp.status === 'confirmed') await mail.queue([mail.confirmedJob(ev, inv, rsvp)]);
      else if (rsvp.status === 'waitlisted') await mail.queue([mail.waitlistedJob(ev, inv, rsvp, position)]);
      else await mail.queue([mail.declinedJob(ev, inv)]);

      res.status(201).json({ rsvp: toGuestRsvp(rsvp, position) });
    },
  );

  router.patch(
    '/api/invitations/:token/rsvp',
    ...guestChain,
    validateRequest(schemas.patchRsvp),
    partySizeWithinAllowance,
    async (req, res) => {
      await requireTurnstile(req);

      const body = req.valid.body;
      const outcome = await db.withTransaction(async (client) => {
        const ev = await lockEvent(client, req.invitation.event_id);
        if (!ev || !['published', 'rsvp_closed'].includes(ev.status)) {
          throw errors.conflict('This event no longer accepts changes.', 'EVENT_CLOSED');
        }
        const inv = await lockInvitation(client, req.invitation.invitation_id);
        const { rows } = await client.query(`SELECT ${RSVP_COLUMNS} FROM rsvps WHERE invitation_id = $1 FOR UPDATE`, [
          inv.invitation_id,
        ]);
        const r = rows[0];
        if (!r) throw errors.notFound('You have not replied yet.', 'RSVP_NOT_FOUND');
        if (LOCKED_STATUSES.includes(r.status)) {
          throw errors.conflict('This reply was cancelled by the organizer and can no longer be changed.', 'RSVP_LOCKED');
        }

        const now = Date.now();
        const beforeDeadline = ev.status === 'published' && new Date(ev.rsvp_deadline).getTime() > now;
        const beforeStart = new Date(ev.start_time).getTime() > now;
        const active = ['confirmed', 'waitlisted'].includes(r.status);
        const wantsCancel = body.response === 'cancel' || (body.response === 'decline' && active);

        if (!beforeDeadline) {
          if (!wantsCancel || body.party_size !== undefined || body.dietary_notes !== undefined) {
            throw errors.conflict('The reply deadline has passed. You can only cancel your attendance.', 'RSVP_DEADLINE_PASSED');
          }
          if (!beforeStart) throw errors.conflict('The event has already started.', 'EVENT_STARTED');
        }

        const maxSize = 1 + inv.plus_one_allowance;
        let template = 'updated';
        let freedSeats = false;
        let auditCancel = false;

        if (wantsCancel) {
          if (!active) throw errors.conflict('There is no attendance to cancel.', 'NOTHING_TO_CANCEL');
          await client.query(
            `UPDATE rsvps SET status = 'cancelled_by_guest', cancelled_at = now(), cancelled_from_status = $2
              WHERE rsvp_id = $1`,
            [r.rsvp_id, r.status],
          );
          freedSeats = r.status === 'confirmed';
          template = 'cancelled';
          auditCancel = true;
        } else if (body.response === 'decline') {
          await client.query(
            `UPDATE rsvps SET status = 'declined', cancelled_at = NULL, cancelled_from_status = NULL,
                    dietary_notes = COALESCE($2, dietary_notes), responded_at = now()
              WHERE rsvp_id = $1`,
            [r.rsvp_id, body.dietary_notes === undefined ? null : body.dietary_notes],
          );
          template = 'declined';
        } else if (body.response === 'accept' && !active) {
          const size = body.party_size !== undefined ? body.party_size : Math.min(r.party_size, maxSize);
          const confirmed = await confirmedHeadcount(client, ev.event_id);
          const fits = confirmed + size <= ev.capacity;
          const code = fits ? r.check_in_code || (await newCheckInCode(client, ev.event_id)) : r.check_in_code;
          await client.query(
            `UPDATE rsvps
                SET status = $2::text, party_size = $3, check_in_code = $4,
                    waitlisted_at = CASE WHEN $2::text = 'waitlisted' THEN now() ELSE waitlisted_at END,
                    dietary_notes = CASE WHEN $5::boolean THEN $6 ELSE dietary_notes END,
                    cancelled_at = NULL, cancelled_from_status = NULL, cancel_reason = NULL, responded_at = now()
              WHERE rsvp_id = $1`,
            [r.rsvp_id, fits ? 'confirmed' : 'waitlisted', size, code, body.dietary_notes !== undefined, body.dietary_notes === undefined ? null : body.dietary_notes],
          );
          template = fits ? 'confirmed' : 'waitlisted';
        } else {
          if (body.party_size !== undefined && !active) {
            throw errors.conflict('Accept the invitation before choosing a party size.', 'NOT_ATTENDING');
          }
          const size = body.party_size !== undefined ? body.party_size : r.party_size;
          if (size > maxSize) {
            throw errors.validationError([{ field: 'party_size', message: `must be between 1 and ${maxSize} for this invitation` }]);
          }
          if (r.status === 'confirmed' && size > r.party_size) {
            const others = await confirmedHeadcount(client, ev.event_id, r.rsvp_id);
            if (others + size > ev.capacity) {
              throw errors.conflict('There are not enough free seats for a larger party.', 'CAPACITY_EXCEEDED', {
                seats_available_for_you: Math.max(0, ev.capacity - others),
              });
            }
          }
          if (r.status === 'confirmed' && size < r.party_size) freedSeats = true;
          await client.query(
            `UPDATE rsvps
                SET party_size = $2,
                    dietary_notes = CASE WHEN $3::boolean THEN $4 ELSE dietary_notes END
              WHERE rsvp_id = $1`,
            [r.rsvp_id, size, body.dietary_notes !== undefined, body.dietary_notes === undefined ? null : body.dietary_notes],
          );
        }

        if (auditCancel) {
          await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.RSVP_CANCELLED, {
            eventId: ev.event_id,
            targetId: r.rsvp_id,
            detail: { cancelled_by: 'guest', from_status: r.status, after_deadline: !beforeDeadline },
            client,
          });
        }

        const promoted = freedSeats || r.status === 'waitlisted' || template === 'waitlisted' ? await promoteFromWaitlist(client, ev) : [];
        const { rows: after } = await client.query(`SELECT ${RSVP_COLUMNS} FROM rsvps WHERE rsvp_id = $1`, [r.rsvp_id]);
        const position = await waitlistPosition(client, ev.event_id, after[0]);
        return { ev, inv, rsvp: after[0], position, promoted, template };
      });

      const { ev, inv, rsvp, position, promoted, template } = outcome;
      const selfPromoted = promoted.some((p) => p.rsvp_id === rsvp.rsvp_id);
      const jobs = mail.promotedJobs(ev, promoted);
      if (!selfPromoted) {
        if (template === 'cancelled') jobs.push(mail.cancelledJob(ev, inv, 'guest'));
        else if (template === 'declined') jobs.push(mail.declinedJob(ev, inv));
        else if (template === 'confirmed') jobs.push(mail.confirmedJob(ev, inv, rsvp));
        else if (template === 'waitlisted') jobs.push(mail.waitlistedJob(ev, inv, rsvp, position));
        else jobs.push(mail.updatedJob(ev, inv, rsvp, position));
      }
      await mail.queue(jobs);
      res.json({ rsvp: toGuestRsvp(rsvp, position) });
    },
  );

  return router;
}

module.exports = { guestRsvpRoutes };
