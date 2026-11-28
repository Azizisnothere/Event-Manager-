'use strict';
const { csv, utils } = require('../../../../shared');

async function loadReportRows(client, eventId) {
  const { rows } = await client.query(
    `SELECT i.invitation_id, i.guest_name, i.guest_email, i.category, i.plus_one_allowance, i.status AS invitation_status,
            r.rsvp_id, r.status AS rsvp_status, r.party_size, r.promoted_at, r.cancelled_at, r.cancelled_from_status,
            c.people_arrived, c.checked_in_at,
            (r.status = 'confirmed' AND c.checkin_id IS NULL) AS no_show,
            (r.status = 'cancelled_by_guest' AND r.cancelled_from_status = 'confirmed' AND r.cancelled_at > e.rsvp_deadline) AS late_cancellation
       FROM invitations i
       JOIN events e ON e.event_id = i.event_id
       LEFT JOIN rsvps r ON r.invitation_id = i.invitation_id
       LEFT JOIN check_ins c ON c.rsvp_id = r.rsvp_id AND c.status = 'active'
      WHERE i.event_id = $1
      ORDER BY i.guest_name, i.invitation_id`,
    [eventId],
  );
  return rows;
}

function computeTotals(rows) {
  const active = rows.filter((r) => r.invitation_status !== 'revoked');
  const confirmedRows = rows.filter((r) => r.rsvp_status === 'confirmed');
  const attendedRows = confirmedRows.filter((r) => r.people_arrived !== null && r.people_arrived !== undefined);
  const confirmed = confirmedRows.length;
  const attended = attendedRows.length;
  const rate = confirmed === 0 ? 0 : Math.round((attended / confirmed) * 10000) / 10000;
  return {
    invited: active.length,
    confirmed,
    attended,
    no_shows: confirmed - attended,
    late_cancellations: rows.filter((r) => r.late_cancellation === true).length,
    waitlist_promoted: rows.filter((r) => r.promoted_at).length,
    attendance_rate: rate,
    people_confirmed: confirmedRows.reduce((s, r) => s + r.party_size, 0),
    people_arrived: attendedRows.reduce((s, r) => s + r.people_arrived, 0),
  };
}

function yesNo(v) {
  return v ? 'yes' : 'no';
}

function buildCsv(event, rows, totals) {
  const lines = [
    ['Event', event.title],
    ['Start', utils.toIso(event.start_time)],
    ['Invited', totals.invited],
    ['Confirmed', totals.confirmed],
    ['Attended', totals.attended],
    ['No-shows', totals.no_shows],
    ['Late cancellations', totals.late_cancellations],
    ['Attendance rate', totals.attendance_rate],
    [],
    [
      'guest_name',
      'guest_email',
      'category',
      'plus_one_allowance',
      'invitation_status',
      'rsvp_status',
      'party_size',
      'checked_in',
      'people_arrived',
      'checked_in_at',
      'no_show',
      'late_cancellation',
      'promoted_from_waitlist',
    ],
    ...rows.map((r) => [
      r.guest_name,
      r.guest_email,
      r.category,
      r.plus_one_allowance,
      r.invitation_status,
      r.rsvp_status || 'no_reply',
      r.party_size,
      yesNo(r.people_arrived !== null && r.people_arrived !== undefined),
      r.people_arrived,
      utils.toIso(r.checked_in_at),
      yesNo(r.no_show),
      yesNo(r.late_cancellation),
      yesNo(r.promoted_at),
    ]),
  ];
  return csv.toCsv(lines);
}

function reportKey(eventId) {
  return `reports/${eventId}.csv`;
}

module.exports = { loadReportRows, computeTotals, buildCsv, reportKey };
