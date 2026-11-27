'use strict';
/**
 * Event status workflow (Section 1.2 / 5.1, A4):
 *   draft -> published -> rsvp_closed -> completed
 *   draft | published | rsvp_closed -> cancelled
 * Anything else is an invalid transition and returns 409.
 */
const { errors } = require('../../../../shared');

const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['published', 'cancelled']),
  published: Object.freeze(['rsvp_closed', 'cancelled']),
  rsvp_closed: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** Statuses in which event details may still be edited (A7). */
const EDITABLE_STATUSES = Object.freeze(['draft', 'published', 'rsvp_closed']);
/** Statuses in which guests can still be added or imported (A11, A12). */
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
