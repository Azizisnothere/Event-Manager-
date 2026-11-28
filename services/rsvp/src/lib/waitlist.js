'use strict';
const { confirmedHeadcount, newCheckInCode } = require('./capacity');

function promotionAllowed(event) {
  return ['published', 'rsvp_closed'].includes(event.status) && new Date(event.start_time).getTime() > Date.now();
}

async function confirmPromotion(client, event, row) {
  const code = row.check_in_code || (await newCheckInCode(client, event.event_id));
  await client.query(
    `UPDATE rsvps SET status = 'confirmed', check_in_code = $2, promoted_at = now()
      WHERE rsvp_id = $1 AND status = 'waitlisted'`,
    [row.rsvp_id, code],
  );
  return {
    rsvp_id: row.rsvp_id,
    invitation_id: row.invitation_id,
    party_size: row.party_size,
    check_in_code: code,
    guest_name: row.guest_name,
    guest_email: row.guest_email,
  };
}

async function promoteFromWaitlist(client, event) {
  if (!promotionAllowed(event)) return [];
  let free = event.capacity - (await confirmedHeadcount(client, event.event_id));
  if (free <= 0) return [];
  const { rows } = await client.query(
    `SELECT r.rsvp_id, r.invitation_id, r.party_size, r.check_in_code, i.guest_name, i.guest_email
       FROM rsvps r
       JOIN invitations i ON i.invitation_id = r.invitation_id
      WHERE r.event_id = $1 AND r.status = 'waitlisted' AND i.status <> 'revoked'
      ORDER BY r.waitlisted_at, r.rsvp_id
      FOR UPDATE OF r`,
    [event.event_id],
  );
  const promoted = [];
  for (const row of rows) {
    if (free <= 0) break;
    if (row.party_size <= free) {
      promoted.push(await confirmPromotion(client, event, row));
      free -= row.party_size;
    }
  }
  return promoted;
}

async function promoteOne(client, event, rsvpRow) {
  const free = event.capacity - (await confirmedHeadcount(client, event.event_id));
  if (rsvpRow.party_size > free) return null;
  return confirmPromotion(client, event, rsvpRow);
}

module.exports = { promoteFromWaitlist, promoteOne, promotionAllowed };
