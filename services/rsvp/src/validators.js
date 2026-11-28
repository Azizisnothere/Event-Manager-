'use strict';
const { constants, validation, errors } = require('../../../shared');

const { LIMITS, RSVP_STATUSES } = constants;

const partySize = { type: 'integer', min: 1, max: 1 + constants.PLUS_ONE_MAX };
const dietaryNotes = { type: 'string', max: LIMITS.DIETARY_NOTES_MAX, multiline: true, nullable: true };
const eventId = { type: 'uuid', required: true };
const rsvpId = { type: 'uuid', required: true };

const schemas = {
  postRsvp: {
    body: {
      response: { type: 'enum', required: true, values: ['accept', 'decline'] },
      party_size: partySize,
      dietary_notes: dietaryNotes,
    },
  },
  patchRsvp: {
    body: {
      response: { type: 'enum', values: ['accept', 'decline', 'cancel'] },
      party_size: partySize,
      dietary_notes: dietaryNotes,
    },
    bodyMinFields: 1,
  },
  guestView: { body: {} },
  listRsvps: {
    params: { eventId },
    query: {
      search: validation.searchRule,
      status: { type: 'enum', values: RSVP_STATUSES },
      ...validation.paginationSchema,
    },
  },
  eventParams: { params: { eventId } },
  promote: { params: { eventId, rsvpId }, body: {} },
  organizerCancel: {
    params: { eventId, rsvpId },
    body: {
      status: { type: 'enum', required: true, values: ['cancelled_by_organizer'] },
      reason: { type: 'string', required: true, min: LIMITS.REASON_MIN, max: LIMITS.REASON_MAX, multiline: true },
    },
  },
};

function partySizeWithinAllowance(req, res, next) {
  const b = req.valid.body;
  const max = 1 + req.invitation.plus_one_allowance;
  if (b.party_size !== undefined && b.party_size > max) {
    return next(errors.validationError([{ field: 'party_size', message: `must be between 1 and ${max} for this invitation` }]));
  }
  if (req.method === 'POST' && b.response === 'accept' && b.party_size === undefined) {
    return next(errors.validationError([{ field: 'party_size', message: 'is required when accepting' }]));
  }
  if (req.method === 'POST' && b.response === 'decline' && b.party_size !== undefined) {
    return next(errors.validationError([{ field: 'party_size', message: 'is not allowed when declining' }]));
  }
  return next();
}

module.exports = { schemas, partySizeWithinAllowance };
