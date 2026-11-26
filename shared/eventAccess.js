'use strict';
/**
 * Event-level authorization used by every service.
 * Threat 3 (IDOR): ownership is enforced INSIDE the SQL WHERE clause
 *   (WHERE event_id = $1 AND organizer_id = $2), never by comparing after a fetch.
 * Threat 4: staff access requires a row in event_staff for (event_id, caller).
 * If the scoped query finds nothing, a second query distinguishes "exists but not yours" (403,
 * audited by the error handler) from "does not exist" (404) (A3).
 */
const db = require('./db');
const { forbidden, notFound } = require('./errors');
const { isUuid } = require('./utils');

const EVENT_COLUMNS = Object.freeze([
  'event_id',
  'organizer_id',
  'title',
  'description',
  'venue_address',
  'venue_lat',
  'venue_lng',
  'venue_verified',
  'start_time',
  'end_time',
  'rsvp_deadline',
  'capacity',
  'invite_limit',
  'status',
  'cancel_reason',
  'completed_at',
  'created_at',
  'updated_at',
]);
const EVENT_SELECT = EVENT_COLUMNS.map((c) => `e.${c}`).join(', ');

function eventNotFound() {
  return notFound('Event not found.', 'EVENT_NOT_FOUND');
}

async function throwForbiddenOrNotFound(client, eventId, reason) {
  const { rowCount } = await client.query('SELECT 1 FROM events WHERE event_id = $1', [eventId]);
  if (rowCount > 0) throw forbidden(undefined, { auditDetail: { reason } });
  throw eventNotFound();
}

/**
 * Loads an event owned by the organizer, optionally locking the row (inside a transaction).
 * @param {{ query: Function }} client pool or transaction client
 * @param {string} eventId
 * @param {string} organizerId
 * @param {{ forUpdate?: boolean }} [opts]
 */
async function findOwnedEvent(client, eventId, organizerId, opts = {}) {
  if (!isUuid(eventId)) throw eventNotFound();
  const lock = opts.forUpdate ? ' FOR UPDATE' : '';
  // Threat 3: ownership enforced in WHERE.
  const { rows } = await client.query(
    `SELECT ${EVENT_SELECT} FROM events e WHERE e.event_id = $1 AND e.organizer_id = $2${lock}`,
    [eventId, organizerId],
  );
  if (rows.length) return rows[0];
  return throwForbiddenOrNotFound(client, eventId, 'not_event_owner');
}

/**
 * Loads an event the staff member is assigned to.
 * Threat 4: assignment checked against event_staff on every staff action.
 */
async function findAssignedEvent(client, eventId, staffUserId, opts = {}) {
  if (!isUuid(eventId)) throw eventNotFound();
  const lock = opts.forUpdate ? ' FOR UPDATE OF e' : '';
  const { rows } = await client.query(
    `SELECT ${EVENT_SELECT}
       FROM events e
       JOIN event_staff es ON es.event_id = e.event_id AND es.user_id = $2
      WHERE e.event_id = $1${lock}`,
    [eventId, staffUserId],
  );
  if (rows.length) return rows[0];
  return throwForbiddenOrNotFound(client, eventId, 'staff_not_assigned');
}

/**
 * Organizer -> must own the event; staff -> must be assigned (only if allowStaff).
 * @param {{ query: Function }} client
 * @param {string} eventId
 * @param {{ user_id: string, role: 'organizer'|'staff' }} user
 * @param {{ allowStaff?: boolean, forUpdate?: boolean }} [opts]
 */
async function findAccessibleEvent(client, eventId, user, opts = {}) {
  if (!user) throw new Error('findAccessibleEvent requires an authenticated user');
  if (user.role === 'organizer') return findOwnedEvent(client, eventId, user.user_id, opts);
  if (user.role === 'staff' && opts.allowStaff) return findAssignedEvent(client, eventId, user.user_id, opts);
  throw forbidden(undefined, { auditDetail: { reason: 'role_not_allowed' } });
}

/** Lightweight assignment check used inside transactions that already hold the event row. */
async function isStaffAssigned(client, eventId, staffUserId) {
  const { rowCount } = await client.query('SELECT 1 FROM event_staff WHERE event_id = $1 AND user_id = $2', [
    eventId,
    staffUserId,
  ]);
  return rowCount > 0;
}

module.exports = {
  EVENT_COLUMNS,
  EVENT_SELECT,
  findOwnedEvent,
  findAssignedEvent,
  findAccessibleEvent,
  isStaffAssigned,
  defaultClient: db.pool,
};
