'use strict';
const { errors } = require('../../../../shared');

const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['published', 'cancelled']),
  published: Object.freeze(['rsvp_closed', 'cancelled']),
  rsvp_closed: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const EDITABLE_STATUSES = Object.freeze(['draft', 'published', 'rsvp_closed']);
const GUEST_LIST_OPEN_STATUSES = Object.freeze(['draft', 'published']);

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw errors.conflict(`An event cannot move from "${from}" to "${to}".`, 'INVALID_STATUS_TRANSITION', {
      from,
      to,
      allowed: TRANSITIONS[from] || [],
    });
  }
}

module.exports = { TRANSITIONS, EDITABLE_STATUSES, GUEST_LIST_OPEN_STATUSES, canTransition, assertTransition };
