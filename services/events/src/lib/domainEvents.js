'use strict';
/**
 * Messages the Event service publishes to SNS em-domain-events (Section 5.2).
 *   event.capacity_changed, event.updated, event.cancelled, invitation.revoked -> RSVP service
 *   event.completed                                                         -> Check-in service
 * Always called AFTER the database transaction has committed. Payloads carry ids only:
 * no emails, tokens or dietary notes.
 */
const { messaging, constants, logger } = require('../../../../shared');

const M = constants.MESSAGE_TYPES;

async function safePublish(type, eventId, data) {
  try {
    return await messaging.publishDomainEvent(type, eventId, data);
  } catch (err) {
    // The DB change is committed; the scheduler's repair pass re-publishes event.completed,
    // and the error is visible in CloudWatch for the other types.
    logger.error('domain_event_publish_failed', { type, event_id: eventId, error: err });
    return null;
  }
}

const publishCapacityChanged = (eventId, oldCapacity, newCapacity) =>
  safePublish(M.EVENT_CAPACITY_CHANGED, eventId, { old_capacity: oldCapacity, new_capacity: newCapacity });

const publishEventUpdated = (eventId, changedFields) =>
  safePublish(M.EVENT_UPDATED, eventId, { changed_fields: changedFields });

const publishEventCancelled = (eventId, reason) => safePublish(M.EVENT_CANCELLED, eventId, { reason: reason || null });

const publishInvitationRevoked = (eventId, invitationId) =>
  safePublish(M.INVITATION_REVOKED, eventId, { invitation_id: invitationId });

const publishEventCompleted = (eventId, completedBy) =>
  safePublish(M.EVENT_COMPLETED, eventId, { completed_by: completedBy });

module.exports = {
  publishCapacityChanged,
  publishEventUpdated,
  publishEventCancelled,
  publishInvitationRevoked,
  publishEventCompleted,
};
