'use strict';
/**
 * Capacity helpers. Every capacity decision runs inside ONE transaction that first locks the
 * event row with SELECT ... FOR UPDATE, so two guests cannot take the same last seat
 * (Section 5.2 step 4). Headcount = party_size; capacity is compared with the sum of
 * party_size over confirmed RSVPs.
 */
const { crypto: emCrypto, utils } = require('../../../../shared');

const EVENT_LOCK_COLUMNS =
  'event_id, organizer_id, title, venue_address, start_time, end_time, rsvp_deadline, capacity, status';

const RSVP_COLUMNS = `rsvp_id, invitation_id, event_id, status, party_size, dietary_notes, check_in_code,
  waitlisted_at, promoted_at, cancelled_at, cancelled_from_status, cancel_reason, responded_at, updated_at`;

/** Locks the event row for the rest of the transaction. */
async function lockEvent(client, eventId) {
  const { rows } = await client.query(`SELECT ${EVENT_LOCK_COLUMNS} FROM events WHERE event_id = $1 FOR UPDATE`, [eventId]);
  return rows[0] || null;
}

/** Sum of party_size over confirmed RSVPs (optionally excluding one RSVP being resized). */
async function confirmedHeadcount(client, eventId, excludeRsvpId = null) {
  const { rows } = await client.query(
    `SELECT COALESCE(sum(party_size), 0)::int AS headcount
       FROM rsvps
      WHERE event_id = $1 AND status = 'confirmed' AND ($2::uuid IS NULL OR rsvp_id <> $2)`,
    [eventId, excludeRsvpId],
  );
  return rows[0].headcount;
}

/**
 * New check-in code unique within the event. The caller holds the event lock, so no other
 * transaction can insert a code for this event concurrently; rsvps_event_code_uq is the backstop.
 */
async function newCheckInCode(client, eventId) {
  for (let i = 0; i < 25; i += 1) {
    const code = emCrypto.generateCheckInCode();
    const { rowCount } = await client.query(`SELECT 1 FROM rsvps WHERE event_id = $1 AND check_in_code = $2`, [eventId, code]);
    if (!rowCount) return code;
  }
  throw new Error('Could not generate a unique check-in code');
}

/** 1-based waitlist position (first-come by waitlisted_at, ties by rsvp_id). */
async function waitlistPosition(client, eventId, rsvp) {
  if (!rsvp || rsvp.status !== 'waitlisted') return null;
  const { rows } = await client.query(
    `SELECT count(*)::int + 1 AS position
       FROM rsvps
      WHERE event_id = $1 AND status = 'waitlisted'
        AND (waitlisted_at, rsvp_id) < ($2::timestamptz, $3::uuid)`,
    [eventId, rsvp.waitlisted_at, rsvp.rsvp_id],
  );
  return rows[0].position;
}

/** Guest-facing RSVP view; the check-in code is only shown while confirmed. */
function toGuestRsvp(r, position) {
  if (!r) return null;
  return {
    rsvp_id: r.rsvp_id,
    status: r.status,
    party_size: r.party_size,
    dietary_notes: r.dietary_notes,
    check_in_code: r.status === 'confirmed' ? r.check_in_code : null,
    waitlist_position: r.status === 'waitlisted' ? position : null,
    responded_at: utils.toIso(r.responded_at),
    updated_at: utils.toIso(r.updated_at),
  };
}

module.exports = {
  EVENT_LOCK_COLUMNS,
  RSVP_COLUMNS,
  lockEvent,
  confirmedHeadcount,
  newCheckInCode,
  waitlistPosition,
  toGuestRsvp,
};
