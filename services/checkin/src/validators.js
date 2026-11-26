'use strict';
/**
 * Request schemas for the Check-in service (Section 6.2 "Input validation").
 */
const { constants, validation, crypto: emCrypto } = require('../../../shared');

const { LIMITS } = constants;
const eventId = { type: 'uuid', required: true };

const schemas = {
  doorList: {
    params: { eventId },
    query: {
      search: validation.searchRule,
      checked_in: { type: 'boolean' },
      ...validation.paginationSchema,
    },
  },
  createCheckIn: {
    params: { eventId },
    body: {
      rsvp_id: { type: 'uuid' },
      check_in_code: {
        type: 'string',
        min: 6,
        max: 9,
        custom: (v) => (emCrypto.normalizeCheckInCode(v) ? null : 'must be a 6-character check-in code'),
      },
      people_arrived: { type: 'integer', min: 1, max: 1 + constants.PLUS_ONE_MAX },
    },
  },
  listCheckIns: {
    params: { eventId },
    query: {
      status: { type: 'enum', values: constants.CHECKIN_STATUSES },
      mine: { type: 'boolean' },
      ...validation.paginationSchema,
    },
  },
  voidCheckIn: {
    params: { eventId, checkinId: { type: 'uuid', required: true } },
    body: {
      status: { type: 'enum', required: true, values: ['voided'] },
      void_reason: { type: 'string', required: true, min: LIMITS.REASON_MIN, max: LIMITS.REASON_MAX, multiline: true },
    },
  },
  eventParams: { params: { eventId } },
};

module.exports = { schemas };
