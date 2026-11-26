'use strict';
/**
 * Request schemas for the Event & Guest List service (Section 6.2 "Input validation").
 * Unknown fields are rejected by the shared validator.
 */
const { constants, validation, errors } = require('../../../shared');

const { LIMITS, PLUS_ONE_MAX, MAX_GUESTS_PER_REQUEST, EVENT_STATUSES, INVITATION_STATUSES } = constants;

const eventId = { type: 'uuid', required: true };

const eventFields = {
  title: { type: 'string', max: LIMITS.TITLE_MAX },
  description: { type: 'string', max: LIMITS.DESCRIPTION_MAX, multiline: true, nullable: true },
  venue_address: { type: 'string', max: LIMITS.VENUE_ADDRESS_MAX },
  start_time: { type: 'datetime' },
  end_time: { type: 'datetime' },
  rsvp_deadline: { type: 'datetime' },
  capacity: { type: 'integer', min: 1, max: LIMITS.CAPACITY_MAX },
  invite_limit: { type: 'integer', min: 1, max: LIMITS.CAPACITY_MAX },
};

const required = (rule) => ({ ...rule, required: true });

const guestRule = {
  type: 'object',
  schema: {
    guest_name: { type: 'string', required: true, max: LIMITS.NAME_MAX },
    guest_email: { type: 'email', required: true },
    plus_one_allowance: { type: 'integer', min: 0, max: PLUS_ONE_MAX, default: 0 },
    category: { type: 'string', max: LIMITS.CATEGORY_MAX, nullable: true },
  },
};

const schemas = {
  createEvent: {
    body: {
      title: required(eventFields.title),
      description: eventFields.description,
      venue_address: required(eventFields.venue_address),
      start_time: required(eventFields.start_time),
      end_time: required(eventFields.end_time),
      rsvp_deadline: required(eventFields.rsvp_deadline),
      capacity: required(eventFields.capacity),
      invite_limit: required(eventFields.invite_limit),
    },
  },
  listEvents: {
    query: { status: { type: 'enum', values: EVENT_STATUSES }, ...validation.paginationSchema },
  },
  eventParams: { params: { eventId } },
  updateEvent: { params: { eventId }, body: eventFields, bodyMinFields: 1 },
  changeStatus: {
    params: { eventId },
    body: {
      status: { type: 'enum', required: true, values: ['published', 'rsvp_closed', 'completed', 'cancelled'] },
      reason: { type: 'string', min: LIMITS.REASON_MIN, max: LIMITS.REASON_MAX, multiline: true },
    },
  },
  addGuests: {
    params: { eventId },
    body: { guests: { type: 'array', required: true, min: 1, max: MAX_GUESTS_PER_REQUEST, items: guestRule } },
  },
  listInvitations: {
    params: { eventId },
    query: {
      search: validation.searchRule,
      status: { type: 'enum', values: INVITATION_STATUSES },
      repeat_no_show: { type: 'boolean' },
      ...validation.paginationSchema,
    },
  },
  invitationParams: { params: { eventId, invitationId: { type: 'uuid', required: true } } },
  createImport: { params: { eventId }, body: {} },
  // Pasted guest list: the same CSV format as the S3 upload; the route allows a 64 KB body.
  bulkImport: { params: { eventId }, body: { csv: { type: 'string', required: true, max: 60000, multiline: true, trim: false } } },
  importParams: { params: { eventId, importId: { type: 'uuid', required: true } } },
  plusOneRequest: {
    body: {
      companion_name: { type: 'string', required: true, max: LIMITS.NAME_MAX },
      note: { type: 'string', max: LIMITS.NOTE_MAX, multiline: true },
    },
  },
  listPlusOne: {
    params: { eventId },
    query: { status: { type: 'enum', values: constants.PLUS_ONE_STATUSES }, ...validation.paginationSchema },
  },
  decidePlusOne: {
    params: { eventId, requestId: { type: 'uuid', required: true } },
    body: { decision: { type: 'enum', required: true, values: ['approved', 'denied'] } },
  },
  createStaff: {
    body: {
      name: { type: 'string', required: true, max: LIMITS.NAME_MAX },
      email: { type: 'email', required: true },
    },
  },
  listStaff: { query: { ...validation.paginationSchema } },
  assignStaff: { params: { eventId }, body: { user_id: { type: 'uuid', required: true } } },
  unassignStaff: { params: { eventId, userId: { type: 'uuid', required: true } } },
};

/** Guest row schema reused by the CSV import processor (same rules as manual entry). */
const csvGuestSchema = guestRule.schema;

/**
 * Cross-field time rules (Section 6.2): start in the future, end after start,
 * RSVP deadline before start and in the future.
 * @param {{ start_time: Date, end_time: Date, rsvp_deadline: Date }} t final values
 * @param {{ requireFutureStart: boolean, requireFutureDeadline: boolean }} opts
 */
function assertEventTimes(t, opts) {
  const now = Date.now();
  const details = [];
  if (opts.requireFutureStart && t.start_time.getTime() <= now) {
    details.push({ field: 'start_time', message: 'must be in the future' });
  }
  if (t.end_time.getTime() <= t.start_time.getTime()) {
    details.push({ field: 'end_time', message: 'must be after start_time' });
  }
  if (t.rsvp_deadline.getTime() > t.start_time.getTime()) {
    details.push({ field: 'rsvp_deadline', message: 'must be on or before start_time' });
  }
  if (opts.requireFutureDeadline && t.rsvp_deadline.getTime() <= now) {
    details.push({ field: 'rsvp_deadline', message: 'must be in the future' });
  }
  if (details.length) throw errors.validationError(details);
}

module.exports = { schemas, csvGuestSchema, assertEventTimes };
