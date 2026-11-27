'use strict';
/**
 * Live attendance and final report (Section 5.1, owner: Adham):
 *   GET /api/events/:eventId/attendance/live              arrivals vs expected, occupancy   200 | 401, 403, 404   organizer, staff (counts only)
 *   GET /api/events/:eventId/attendance/report            final report                      200 | 401, 403, 404, 409 organizer
 *   GET /api/events/:eventId/attendance/report/download   5-minute CSV download link        200 | 401, 403, 404, 409 organizer
 * Report endpoints return 409 before the event is completed (and while it is being generated).
 * Threat 7: the report file is private and reached only through a 5-minute presigned link.
 */
const express = require('express');
const {
  db,
  errors,
  constants,
  config,
  s3,
  utils,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { checkinWindow, isCheckinOpen } = require('../lib/checkinWindow');
const { loadReportRows, computeTotals } = require('../lib/reportBuilder');

const { OCCUPANCY_WARNING_RATIO } = constants;

async function loadReport(event) {
  if (event.status !== 'completed') {
    throw errors.conflict('The report is available after the event is completed.', 'REPORT_NOT_AVAILABLE', {
      event_status: event.status,
    });
  }
  const { rows } = await db.query(
    `SELECT report_id, invited, confirmed, attended, no_shows, late_cancellations, waitlist_promoted,
            attendance_rate, s3_report_key, generated_at
       FROM attendance_reports WHERE event_id = $1`,
    [event.event_id],
  );
  if (!rows.length) {
    throw errors.conflict('The report is being generated. Please try again in a moment.', 'REPORT_PENDING');
  }
  return rows[0];
}

function attendanceRoutes() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/attendance/live
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/attendance/live',
    authenticate(),
    requireRole('organizer', 'staff'),
    authorizeEvent({ allowStaff: true }),
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const ev = req.event;
      const { rows } = await db.query(
        `SELECT
           (SELECT COALESCE(sum(party_size), 0)::int FROM rsvps WHERE event_id = $1 AND status = 'confirmed') AS expected,
           (SELECT count(*)::int FROM rsvps WHERE event_id = $1 AND status = 'confirmed') AS confirmed_parties,
           (SELECT COALESCE(sum(people_arrived), 0)::int FROM check_ins WHERE event_id = $1 AND status = 'active') AS arrived,
           (SELECT count(*)::int FROM check_ins WHERE event_id = $1 AND status = 'active') AS checked_in_parties`,
        [ev.event_id],
      );
      const s = rows[0];
      const occupancy = ev.capacity > 0 ? Math.round((s.arrived / ev.capacity) * 10000) / 10000 : 0;
      const w = checkinWindow(ev);
      const live = {
        event_id: ev.event_id,
        status: ev.status,
        capacity: ev.capacity,
        expected: s.expected, // confirmed headcount
        arrived: s.arrived,
        remaining_expected: Math.max(0, s.expected - s.arrived),
        confirmed_parties: s.confirmed_parties,
        checked_in_parties: s.checked_in_parties,
        occupancy_ratio: occupancy,
        warning: occupancy >= OCCUPANCY_WARNING_RATIO, // warning flag at 90% or more
        warning_threshold: OCCUPANCY_WARNING_RATIO,
        checkin_window: { opens_at: w.opens_at.toISOString(), closes_at: w.closes_at.toISOString(), open: isCheckinOpen(ev) },
        generated_at: new Date().toISOString(),
      };
      if (req.user.role === 'organizer') {
        // Staff get counts only.
        const { rows: recent } = await db.query(
          `SELECT c.checkin_id, i.guest_name, c.people_arrived, c.checked_in_at, u.name AS checked_in_by_name
             FROM check_ins c
             JOIN rsvps r ON r.rsvp_id = c.rsvp_id
             JOIN invitations i ON i.invitation_id = r.invitation_id
             JOIN users u ON u.user_id = c.checked_in_by
            WHERE c.event_id = $1 AND c.status = 'active'
            ORDER BY c.checked_in_at DESC
            LIMIT 20`,
          [ev.event_id],
        );
        live.recent_arrivals = recent.map((r) => ({
          checkin_id: r.checkin_id,
          guest_name: r.guest_name,
          people_arrived: r.people_arrived,
          checked_in_at: utils.toIso(r.checked_in_at),
          checked_in_by_name: r.checked_in_by_name,
        }));
      }
      res.json({ live });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/attendance/report
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/attendance/report',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(), // Threat 3: own events only
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const report = await loadReport(req.event);
      const rows = await loadReportRows(db.pool, req.event.event_id);
      const totals = computeTotals(rows);
      res.json({
        report: {
          event_id: req.event.event_id,
          title: req.event.title,
          invited: report.invited,
          confirmed: report.confirmed,
          attended: report.attended,
          no_shows: report.no_shows,
          late_cancellations: report.late_cancellations,
          waitlist_promoted: report.waitlist_promoted,
          attendance_rate: Number(report.attendance_rate),
          people_confirmed: totals.people_confirmed,
          people_arrived: totals.people_arrived,
          generated_at: utils.toIso(report.generated_at),
          csv_available: Boolean(report.s3_report_key) && Boolean(config.reportsBucket),
        },
        no_shows: rows
          .filter((r) => r.no_show)
          .map((r) => ({ guest_name: r.guest_name, guest_email: r.guest_email, party_size: r.party_size })),
        late_cancellations: rows
          .filter((r) => r.late_cancellation)
          .map((r) => ({ guest_name: r.guest_name, guest_email: r.guest_email, cancelled_at: utils.toIso(r.cancelled_at) })),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/events/:eventId/attendance/report/download
  // ---------------------------------------------------------------------------
  router.get(
    '/api/events/:eventId/attendance/report/download',
    authenticate(),
    requireRole('organizer'),
    authorizeEvent(),
    validateRequest(schemas.eventParams),
    async (req, res) => {
      const report = await loadReport(req.event);
      if (!config.reportsBucket) throw errors.serviceUnavailable('Report storage is not configured.');
      const link = await s3.presignGet({
        bucket: config.reportsBucket,
        key: report.s3_report_key,
        downloadName: `attendance-${req.event.event_id}.csv`,
      });
      res.json({ download: link }); // { url, expires_in: 300 }
    },
  );

  return router;
}

module.exports = { attendanceRoutes };
