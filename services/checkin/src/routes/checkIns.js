'use strict';
/**
 * Door check-in and corrections (Section 5.1, owner: Adham):
 *   POST  /api/events/:eventId/check-ins              record arrival (rsvp_id or code)  201 | 400, 401, 403, 404, 409
 *   GET   /api/events/:eventId/check-ins              history incl. voided ones        200 | 401, 403, 404
 *   PATCH /api/events/:eventId/check-ins/:checkinId   undo (soft void) with a reason   200 | 400, 401, 403, 404, 409
 * Rules: only confirmed RSVPs of this event; only the owning organizer or assigned staff
 * (Threat 4); only inside the check-in window; people_arrived <= party_size; one active
 * check-in per RSVP (partial unique index -> 409, audited); staff undo only their own
 * check-ins within 15 minutes, organizers until the event is completed (Threat 9).
 */
const express = require('express');
const {
  db,
  errors,
  audit,
  constants,
  eventAccess,
  crypto: emCrypto,
  utils,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { isCheckinOpen, checkinWindow } = require('../lib/checkinWindow');

const { VOID_WINDOW_MINUTES, AUDIT_EVENT_TYPES } = constants;

class DuplicateCheckIn extends Error {
  constructor(rsvpId, existingCheckinId) {
    super('duplicate check-in');
    this.rsvpId = rsvpId;
    this.existingCheckinId = existingCheckinId;
  }
}

function staffCanUndo(row, user, now = Date.now()) {
  return (
    row.status === 'active' &&
    row.checked_in_by === user.user_id &&
    now - new Date(row.checked_in_at).getTime() <= VOID_WINDOW_MINUTES * 60_000
  );
}

function checkInRoutes() {
  const router = express.Router();
  const doorAccess = [authenticate(), requireRole('organizer', 'staff'), authorizeEvent({ allowStaff: true })];

  // ---------------------------------------------------------------------------
  // POST /api/events/:eventId/check-ins
  // ---------------------------------------------------------------------------
  router.post(
    '/api/events/:eventId/check-ins',
    ...doorAccess,
    validateRequest(schemas.createCheckIn),
    async (req, res) => {
      const b = req.valid.body;
      if ((b.rsvp_id ? 1 : 0) + (b.check_in_code ? 1 : 0) !== 1) {
        throw errors.validationError([{ field: 'body', message: 'provide exactly one of rsvp_id or check_in_code' }]);
      }
      const code = b.check_in_code ? emCrypto.normalizeCheckInCode(b.check_in_code) : null;

      let created;
      try {
        created = await db.withTransaction(async (client) => {
          // Re-check access while locking the event row (owner in WHERE / event_staff join).
          const ev = await eventAccess.findAccessibleEvent(client, req.event.event_id, req.user, {
            allowStaff: true,
            forUpdate: true,
          });
          if (!isCheckinOpen(ev)) {
            const w = checkinWindow(ev);
            throw errors.conflict('Check-in is not open for this event right now.', 'OUTSIDE_CHECKIN_WINDOW', {
              opens_at: w.opens_at.toISOString(),
              closes_at: w.closes_at.toISOString(),
              event_status: ev.status,
            });
          }
          // Only RSVPs of THIS event can be found (event_id in WHERE).
          const { rows } = await client.query(
            `SELECT r.rsvp_id, r.status, r.party_size, i.guest_name
               FROM rsvps r JOIN invitations i ON i.invitation_id = r.invitation_id
              WHERE r.event_id = $1 AND ${b.rsvp_id ? 'r.rsvp_id = $2' : 'r.check_in_code = $2'}
              FOR UPDATE OF r`,
            [ev.event_id, b.rsvp_id || code],
          );
          if (!rows.length) {
            throw errors.notFound(b.rsvp_id ? 'Guest not found for this event.' : 'No guest with this check-in code.', 'RSVP_NOT_FOUND');
          }
          const r = rows[0];
          if (r.status !== 'confirmed') {
            throw errors.conflict(`This guest's reply is "${r.status.replace(/_/g, ' ')}", so they cannot be checked in.`, 'RSVP_NOT_CONFIRMED');
          }
          const people = b.people_arrived !== undefined ? b.people_arrived : r.party_size;
          if (people > r.party_size) {
            throw errors.validationError([{ field: 'people_arrived', message: `must be at most the party size (${r.party_size})` }]);
          }
          const { rows: existing } = await client.query(
            `SELECT checkin_id FROM check_ins WHERE rsvp_id = $1 AND status = 'active'`,
            [r.rsvp_id],
          );
          if (existing.length) throw new DuplicateCheckIn(r.rsvp_id, existing[0].checkin_id);
          try {
            const { rows: ins } = await client.query(
              `INSERT INTO check_ins (rsvp_id, event_id, checked_in_by, people_arrived)
               VALUES ($1, $2, $3, $4)
               RETURNING checkin_id, rsvp_id, people_arrived, checked_in_at, status`,
              [r.rsvp_id, ev.event_id, req.user.user_id, people],
            );
            return { ...ins[0], guest_name: r.guest_name, party_size: r.party_size };
          } catch (err) {
            // Backstop: the partial unique index check_ins_one_active_per_rsvp.
            if (db.isUniqueViolation(err, 'check_ins_one_active_per_rsvp')) throw new DuplicateCheckIn(r.rsvp_id, null);
            throw err;
          }
        });
      } catch (err) {
        if (err instanceof DuplicateCheckIn) {
          // Written after the rollback so the audit row is kept.
          await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.DUPLICATE_CHECKIN, {
            targetId: err.rsvpId,
            detail: { existing_checkin_id: err.existingCheckinId },
          });
          throw errors.conflict('This guest is already checked in.', 'ALREADY_CHECKED_IN');
        }
        throw err;
      }
      res.status(201).json({
        check_in: {
          checkin_id: created.checkin_id,
          rsvp_id: created.rsvp_id,
          guest_name: created.guest_name,
          party_size: created.party_size,
          people_arrived: created.people_arrived,
          checked_in_at: utils.toIso(created.checked_in_at),
          status: created.status,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/check-ins
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/check-ins',
    ...doorAccess,
    validateRequest(schemas.listCheckIns),
    async (req, res) => {
      const { status, mine, limit, offset } = req.valid.query;
      const { rows } = await db.query(
        `SELECT c.checkin_id, c.rsvp_id, i.guest_name, r.party_size, c.people_arrived, c.checked_in_at, c.status,
                c.checked_in_by, cb.name AS checked_in_by_name,
                c.voided_at, c.void_reason, vb.name AS voided_by_name,
                count(*) OVER ()::int AS total
           FROM check_ins c
           JOIN rsvps r ON r.rsvp_id = c.rsvp_id
           JOIN invitations i ON i.invitation_id = r.invitation_id
           JOIN users cb ON cb.user_id = c.checked_in_by
           LEFT JOIN users vb ON vb.user_id = c.voided_by
          WHERE c.event_id = $1
            AND ($2::text IS NULL OR c.status = $2)
            AND ($3::boolean IS NULL OR $3 = false OR c.checked_in_by = $4)
          ORDER BY c.checked_in_at DESC
          LIMIT $5 OFFSET $6`,
        [req.event.event_id, status || null, mine === undefined ? null : mine, req.user.user_id, limit, offset],
      );
      const now = Date.now();
      const eventCompleted = req.event.status === 'completed';
      res.json({
        check_ins: rows.map((r) => ({
          checkin_id: r.checkin_id,
          rsvp_id: r.rsvp_id,
          guest_name: r.guest_name,
          party_size: r.party_size,
          people_arrived: r.people_arrived,
          checked_in_at: utils.toIso(r.checked_in_at),
          checked_in_by_name: r.checked_in_by_name,
          is_mine: r.checked_in_by === req.user.user_id,
          status: r.status,
          voided_at: utils.toIso(r.voided_at),
          void_reason: r.void_reason,
          voided_by_name: r.voided_by_name,
          can_undo:
            req.user.role === 'organizer'
              ? r.status === 'active' && !eventCompleted
              : !eventCompleted && staffCanUndo(r, req.user, now),
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
        void_window_minutes: VOID_WINDOW_MINUTES,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/events/:eventId/check-ins/:checkinId  (undo = soft void)
  // ---------------------------------------------------------------------------
  router.patch(
    '/api/events/:eventId/check-ins/:checkinId',
    ...doorAccess,
    validateRequest(schemas.voidCheckIn),
    async (req, res) => {
      const { checkinId } = req.valid.params;
      const { void_reason: reason } = req.valid.body;
      const voided = await db.withTransaction(async (client) => {
        const ev = await eventAccess.findAccessibleEvent(client, req.event.event_id, req.user, {
          allowStaff: true,
          forUpdate: true,
        });
        const { rows } = await client.query(
          `SELECT checkin_id, rsvp_id, checked_in_by, checked_in_at, status
             FROM check_ins WHERE checkin_id = $1 AND event_id = $2 FOR UPDATE`,
          [checkinId, ev.event_id],
        );
        if (!rows.length) throw errors.notFound('Check-in not found.', 'CHECKIN_NOT_FOUND');
        const c = rows[0];
        if (c.status === 'voided') throw errors.conflict('This check-in has already been undone.', 'ALREADY_VOIDED');
        // Organizers may undo until the event is completed (staff too are bound by this).
        if (ev.status === 'completed') throw errors.conflict('Check-ins of a completed event cannot be changed.', 'EVENT_COMPLETED');
        if (req.user.role === 'staff') {
          // Threat 9: staff may undo only their own check-ins, within 15 minutes.
          if (c.checked_in_by !== req.user.user_id) {
            throw errors.forbidden('Staff can only undo their own check-ins.', { auditDetail: { reason: 'not_own_checkin' } });
          }
          if (Date.now() - new Date(c.checked_in_at).getTime() > VOID_WINDOW_MINUTES * 60_000) {
            throw errors.conflict(`Check-ins can only be undone within ${VOID_WINDOW_MINUTES} minutes. Ask the organizer.`, 'VOID_WINDOW_EXPIRED');
          }
        }
        const { rows: upd } = await client.query(
          `UPDATE check_ins SET status = 'voided', voided_by = $2, voided_at = now(), void_reason = $3
            WHERE checkin_id = $1 AND status = 'active'
            RETURNING checkin_id, rsvp_id, status, voided_at, void_reason`,
          [checkinId, req.user.user_id, reason],
        );
        // Undo keeps the record and is written to the insert-only audit log (Threat 9).
        await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.CHECKIN_VOIDED, {
          eventId: ev.event_id,
          targetId: checkinId,
          detail: { reason, rsvp_id: c.rsvp_id },
          client,
        });
        return upd[0];
      });
      res.json({
        check_in: {
          checkin_id: voided.checkin_id,
          rsvp_id: voided.rsvp_id,
          status: voided.status,
          voided_at: utils.toIso(voided.voided_at),
          void_reason: voided.void_reason,
        },
      });
    },
  );

  return router;
}

module.exports = { checkInRoutes };
