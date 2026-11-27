'use strict';
/**
 * Staff accounts and assignments (Section 5.1, owner: Osama):
 *   POST   /api/staff                         create a staff account, email a setup link   201 | 400, 401, 403, 409
 *   GET    /api/staff                         organizer's own staff                        200 | 401, 403
 *   POST   /api/events/:eventId/staff         assign one of the organizer's staff          201 | 400, 401, 403, 404, 409
 *   GET    /api/events/:eventId/staff         staff assigned to the event                  200 | 401, 403, 404
 *   DELETE /api/events/:eventId/staff/:userId remove an assignment                         200 | 401, 403, 404, 409
 * Section 6.1: staff accounts are only created by organizers; an organizer may only assign
 * staff they created (staff.created_by = caller).
 */
const express = require('express');
const {
  db,
  errors,
  emailQueue,
  constants,
  crypto: emCrypto,
  utils,
  logger,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { staffSetupUrl } = require('../lib/invitationService');

const { STAFF_SETUP_TOKEN_TTL_HOURS, EMAIL_TEMPLATES } = constants;

function staffRoutes() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // POST /api/staff
  // ---------------------------------------------------------------------------
  router.post(
    '/api/staff',
    authenticate(),
    requireRole('organizer'),
    validateRequest(schemas.createStaff),
    async (req, res) => {
      const { name, email } = req.valid.body;
      // Single-use setup token, valid 48 hours, stored only as a SHA-256 hash.
      const rawToken = emCrypto.generateToken();
      const expiresAt = utils.addHours(new Date(), STAFF_SETUP_TOKEN_TTL_HOURS);
      let staff;
      try {
        const { rows } = await db.query(
          `INSERT INTO users (name, email, role, created_by, status, setup_token_hash, setup_expires_at)
           VALUES ($1, $2, 'staff', $3, 'pending_setup', $4, $5)
           RETURNING user_id, name, email, role, status, created_at`,
          [name, email, req.user.user_id, emCrypto.hashToken(rawToken), expiresAt],
        );
        staff = rows[0];
      } catch (err) {
        if (db.isUniqueViolation(err, 'users_email_lower_uq')) {
          throw errors.conflict('An account with this email already exists.', 'EMAIL_TAKEN');
        }
        throw err;
      }
      const { rows: org } = await db.query('SELECT name FROM users WHERE user_id = $1', [req.user.user_id]);
      try {
        await emailQueue.enqueueEmail({
          template: EMAIL_TEMPLATES.STAFF_SETUP,
          to: { email: staff.email, name: staff.name },
          params: {
            staff_name: staff.name,
            organizer_name: org.length ? org[0].name : null,
            setup_url: staffSetupUrl(rawToken),
            expires_hours: STAFF_SETUP_TOKEN_TTL_HOURS,
          },
        });
      } catch (err) {
        logger.error('staff_setup_email_not_queued', { user_id: staff.user_id, error: err });
      }
      res.status(201).json({
        staff: {
          user_id: staff.user_id,
          name: staff.name,
          email: staff.email,
          role: staff.role,
          status: staff.status,
          setup_expires_at: expiresAt.toISOString(),
          created_at: utils.toIso(staff.created_at),
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/staff
  // ---------------------------------------------------------------------------
  router.get(
    '/api/staff',
    authenticate(),
    requireRole('organizer'),
    validateRequest(schemas.listStaff),
    async (req, res) => {
      const { limit, offset } = req.valid.query;
      const { rows } = await db.query(
        `SELECT u.user_id, u.name, u.email, u.status, u.created_at, u.setup_expires_at,
                (SELECT count(*)::int FROM event_staff es WHERE es.user_id = u.user_id) AS assigned_events,
                count(*) OVER ()::int AS total
           FROM users u
          WHERE u.role = 'staff' AND u.created_by = $1
          ORDER BY u.name
          LIMIT $2 OFFSET $3`,
        [req.user.user_id, limit, offset],
      );
      res.json({
        staff: rows.map((r) => ({
          user_id: r.user_id,
          name: r.name,
          email: r.email,
          status: r.status,
          setup_expires_at: utils.toIso(r.setup_expires_at),
          assigned_events: r.assigned_events,
          created_at: utils.toIso(r.created_at),
        })),
        total: rows.length ? rows[0].total : 0,
        limit,
        offset,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/events/:eventId/staff
  // ---------------------------------------------------------------------------
  router.post(
    '/api/events/:eventId/staff',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(), // Threat 3: own event
    validateRequest(schemas.assignStaff),
    async (req, res) => {
      const { user_id: staffId } = req.valid.body;
      if (['completed', 'cancelled'].includes(req.event.status)) {
        throw errors.conflict(`Staff cannot be assigned to a ${req.event.status} event.`, 'EVENT_CLOSED');
      }
      // Ownership check: staff.created_by = caller (Section 6.1).
      const { rows: staffRows } = await db.query(
        `SELECT user_id, name, status FROM users WHERE user_id = $1 AND role = 'staff' AND created_by = $2`,
        [staffId, req.user.user_id],
      );
      if (!staffRows.length || staffRows[0].status === 'disabled') {
        throw errors.notFound('Staff member not found.', 'STAFF_NOT_FOUND');
      }
      try {
        const { rows } = await db.query(
          `INSERT INTO event_staff (event_id, user_id, assigned_by) VALUES ($1, $2, $3)
           RETURNING event_id, user_id, assigned_at`,
          [req.event.event_id, staffId, req.user.user_id],
        );
        res.status(201).json({
          assignment: {
            event_id: rows[0].event_id,
            user_id: rows[0].user_id,
            name: staffRows[0].name,
            status: staffRows[0].status,
            assigned_at: utils.toIso(rows[0].assigned_at),
          },
        });
      } catch (err) {
        if (db.isUniqueViolation(err)) throw errors.conflict('This staff member is already assigned.', 'ALREADY_ASSIGNED');
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/staff
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/staff',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const { rows } = await db.query(
        `SELECT u.user_id, u.name, u.email, u.status, es.assigned_at
           FROM event_staff es
           JOIN users u ON u.user_id = es.user_id
          WHERE es.event_id = $1
          ORDER BY u.name`,
        [req.event.event_id],
      );
      res.json({
        staff: rows.map((r) => ({
          user_id: r.user_id,
          name: r.name,
          email: r.email,
          status: r.status,
          assigned_at: utils.toIso(r.assigned_at),
        })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/events/:eventId/staff/:userId
  // ---------------------------------------------------------------------------
  router.delete(
    '/api/events/:eventId/staff/:userId',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.unassignStaff),
    async (req, res) => {
      if (['completed', 'cancelled'].includes(req.event.status)) {
        // Assignments are kept as a record once the event is over (A32).
        throw errors.conflict(`Assignments of a ${req.event.status} event cannot be changed.`, 'EVENT_CLOSED');
      }
      const result = await db.query(`DELETE FROM event_staff WHERE event_id = $1 AND user_id = $2`, [
        req.event.event_id,
        req.valid.params.userId,
      ]);
      if (!result.rowCount) throw errors.notFound('This staff member is not assigned to the event.', 'ASSIGNMENT_NOT_FOUND');
      res.json({ event_id: req.event.event_id, user_id: req.valid.params.userId, status: 'unassigned' });
    },
  );

  return router;
}

module.exports = { staffRoutes };
