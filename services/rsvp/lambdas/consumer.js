'use strict';
const { db, messaging, sqsHandler, constants, utils, logger } = require('../../../shared');
const { lockEvent } = require('../src/lib/capacity');
const { promoteFromWaitlist } = require('../src/lib/waitlist');
const mail = require('../src/lib/rsvpEmails');

const M = constants.MESSAGE_TYPES;
const T = constants.EMAIL_TEMPLATES;
const log = logger.child({ function_role: 'rsvp-consumer' });

async function notifiableGuests(eventId, excludeStatuses) {
  const { rows } = await db.query(
    `SELECT i.invitation_id, i.guest_name, i.guest_email
       FROM invitations i
       LEFT JOIN rsvps r ON r.invitation_id = i.invitation_id
      WHERE i.event_id = $1
        AND i.status IN ('sent', 'responded')
        AND (r.status IS NULL OR NOT (r.status = ANY($2::text[])))`,
    [eventId, excludeStatuses],
  );
  return rows;
}

async function onCapacityChanged(envelope) {
  const outcome = await db.withTransaction(async (client) => {
    const ev = await lockEvent(client, envelope.event_id);
    if (!ev) return null;
    return { ev, promoted: await promoteFromWaitlist(client, ev) };
  });
  if (outcome && outcome.promoted.length) {
    await mail.queue(mail.promotedJobs(outcome.ev, outcome.promoted));
    log.info('waitlist_promoted_after_capacity_change', { event_id: envelope.event_id, promoted: outcome.promoted.length });
  }
}

async function onEventUpdated(envelope) {
  const { rows } = await db.query(
    `SELECT event_id, title, venue_address, start_time, end_time, rsvp_deadline, status FROM events WHERE event_id = $1`,
    [envelope.event_id],
  );
  const ev = rows[0];
  if (!ev || !['published', 'rsvp_closed'].includes(ev.status)) return;
  const guests = await notifiableGuests(ev.event_id, ['declined', 'cancelled_by_guest', 'cancelled_by_organizer', 'event_cancelled']);
  const changed = Array.isArray(envelope.data.changed_fields) ? envelope.data.changed_fields.slice(0, 10) : [];
  await mail.queue(
    guests.map((g) =>
      mail.job(T.EVENT_UPDATED, ev, g, {
        changed_fields: changed,
        start_time: utils.toIso(ev.start_time),
        end_time: utils.toIso(ev.end_time),
        venue_address: ev.venue_address,
        rsvp_deadline: utils.toIso(ev.rsvp_deadline),
      }),
    ),
  );
}

async function onEventCancelled(envelope) {
  const ev = await db.withTransaction(async (client) => {
    const locked = await lockEvent(client, envelope.event_id);
    if (!locked || locked.status !== 'cancelled') return null;
    await client.query(
      `UPDATE rsvps
          SET status = 'event_cancelled', cancelled_at = now(), cancelled_from_status = status
        WHERE event_id = $1 AND status IN ('confirmed', 'waitlisted')`,
      [locked.event_id],
    );
    return locked;
  });
  if (!ev) return;
  const guests = await notifiableGuests(ev.event_id, ['declined', 'cancelled_by_guest', 'cancelled_by_organizer']);
  const reason = typeof envelope.data.reason === 'string' ? envelope.data.reason.slice(0, 300) : null;
  await mail.queue(guests.map((g) => mail.job(T.EVENT_CANCELLED, ev, g, { reason })));
}

async function onInvitationRevoked(envelope) {
  const invitationId = envelope.data.invitation_id;
  if (!utils.isUuid(invitationId)) throw new Error('invitation.revoked without a valid invitation_id');
  const outcome = await db.withTransaction(async (client) => {
    const ev = await lockEvent(client, envelope.event_id);
    if (!ev) return null;
    const { rows } = await client.query(
      `SELECT r.rsvp_id, r.status, i.guest_name, i.guest_email
         FROM rsvps r JOIN invitations i ON i.invitation_id = r.invitation_id
        WHERE r.invitation_id = $1 AND r.event_id = $2
        FOR UPDATE OF r`,
      [invitationId, ev.event_id],
    );
    const r = rows[0];
    if (!r || !['confirmed', 'waitlisted'].includes(r.status)) return { ev, r: null, promoted: [] };
    await client.query(
      `UPDATE rsvps SET status = 'cancelled_by_organizer', cancelled_at = now(), cancelled_from_status = $2,
              cancel_reason = 'invitation_revoked'
        WHERE rsvp_id = $1`,
      [r.rsvp_id, r.status],
    );
    const promoted = r.status === 'confirmed' ? await promoteFromWaitlist(client, ev) : [];
    return { ev, r, promoted };
  });
  if (!outcome) return;
  const jobs = mail.promotedJobs(outcome.ev, outcome.promoted);
  if (outcome.r) jobs.push(mail.cancelledJob(outcome.ev, outcome.r, 'organizer'));
  await mail.queue(jobs);
}

const consumer = messaging.createDomainEventConsumer({
  name: 'rsvp',
  handlers: {
    [M.EVENT_CAPACITY_CHANGED]: onCapacityChanged,
    [M.EVENT_UPDATED]: onEventUpdated,
    [M.EVENT_CANCELLED]: onEventCancelled,
    [M.INVITATION_REVOKED]: onInvitationRevoked,
  },
});

exports.processEnvelope = consumer.processEnvelope;
exports.handler = sqsHandler.createSqsHandler(consumer.processRecord, { name: 'rsvp-consumer' });
