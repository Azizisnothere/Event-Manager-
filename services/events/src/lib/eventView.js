'use strict';
/**
 * Response shaping for events: explicit fields only, ISO dates, numeric coordinates.
 */
const { utils } = require('../../../../shared');

function toEventResponse(row, extra = {}) {
  return {
    event_id: row.event_id,
    organizer_id: row.organizer_id,
    title: row.title,
    description: row.description,
    venue_address: row.venue_address,
    venue_lat: row.venue_lat === null || row.venue_lat === undefined ? null : Number(row.venue_lat),
    venue_lng: row.venue_lng === null || row.venue_lng === undefined ? null : Number(row.venue_lng),
    venue_verified: row.venue_verified,
    start_time: utils.toIso(row.start_time),
    end_time: utils.toIso(row.end_time),
    rsvp_deadline: utils.toIso(row.rsvp_deadline),
    capacity: row.capacity,
    invite_limit: row.invite_limit,
    status: row.status,
    cancel_reason: row.cancel_reason,
    completed_at: utils.toIso(row.completed_at),
    created_at: utils.toIso(row.created_at),
    updated_at: utils.toIso(row.updated_at),
    ...extra,
  };
}

/** Headcount figures used by the dashboard, the event page and the capacity rules. */
async function eventStats(client, eventId) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*)::int FROM invitations WHERE event_id = $1 AND status <> 'revoked') AS invited_count,
       (SELECT COALESCE(sum(1 + plus_one_allowance), 0)::int FROM invitations WHERE event_id = $1 AND status <> 'revoked') AS invited_headcount,
       (SELECT COALESCE(sum(party_size), 0)::int FROM rsvps WHERE event_id = $1 AND status = 'confirmed') AS confirmed_headcount,
       (SELECT COALESCE(sum(party_size), 0)::int FROM rsvps WHERE event_id = $1 AND status = 'waitlisted') AS waitlisted_headcount,
       (SELECT count(*)::int FROM invitations WHERE event_id = $1 AND status = 'pending') AS pending_invitations,
       (SELECT count(*)::int FROM event_staff WHERE event_id = $1) AS staff_count,
       (SELECT count(*)::int FROM plus_one_requests p JOIN invitations i ON i.invitation_id = p.invitation_id
         WHERE i.event_id = $1 AND p.status = 'pending') AS pending_plus_one_requests`,
    [eventId],
  );
  return rows[0];
}

module.exports = { toEventResponse, eventStats };
