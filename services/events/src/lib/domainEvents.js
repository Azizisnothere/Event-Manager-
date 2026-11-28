'use strict';
const { messaging, constants, logger } = require('../../../../shared');

const M = constants.MESSAGE_TYPES;

async function safePublish(type, eventId, data) {
  try {
    return await messaging.publishDomainEvent(type, eventId, data);
  } catch (err) {
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
