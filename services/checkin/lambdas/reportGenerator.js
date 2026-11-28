'use strict';
const { db, messaging, sqsHandler, s3, config, constants, crypto: emCrypto, logger } = require('../../../shared');
const { loadReportRows, computeTotals, buildCsv, reportKey } = require('../src/lib/reportBuilder');

const M = constants.MESSAGE_TYPES;
const log = logger.child({ function_role: 'report-generator' });

async function generateReport(eventId) {
  const { rows: evRows } = await db.query(
    `SELECT event_id, organizer_id, title, start_time, rsvp_deadline, status FROM events WHERE event_id = $1`,
    [eventId],
  );
  const ev = evRows[0];
  if (!ev || ev.status !== 'completed') {
    log.warn('report_skipped', { event_id: eventId, reason: ev ? `status_${ev.status}` : 'missing_event' });
    return 'skipped';
  }
  const { rowCount: exists } = await db.query(`SELECT 1 FROM attendance_reports WHERE event_id = $1`, [eventId]);
  if (exists) return 'exists';

  return db.withTransaction(
    async (client) => {
      const rows = await loadReportRows(client, eventId);
      const totals = computeTotals(rows);
      const key = reportKey(eventId);

      if (config.reportsBucket) {
        await s3.putObject({ bucket: config.reportsBucket, key, body: buildCsv(ev, rows, totals) });
      } else if (config.isProduction) {
        throw new Error('REPORTS_BUCKET must be set in production.');
      } else {
        log.warn('report_csv_not_stored', { event_id: eventId, note: 'REPORTS_BUCKET not set (local dev)' });
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO attendance_reports (event_id, invited, confirmed, attended, no_shows, late_cancellations,
                                         waitlist_promoted, attendance_rate, s3_report_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING report_id`,
        [
          eventId,
          totals.invited,
          totals.confirmed,
          totals.attended,
          totals.no_shows,
          totals.late_cancellations,
          totals.waitlist_promoted,
          totals.attendance_rate,
          key,
        ],
      );
      if (!inserted.length) return 'exists';

      const perGuest = new Map();
      for (const r of rows.filter((x) => x.rsvp_status === 'confirmed')) {
        const email = emCrypto.normalizeEmail(r.guest_email);
        const attended = r.people_arrived !== null && r.people_arrived !== undefined;
        const cur = perGuest.get(email) || { confirmed: 0, attended: 0, noShows: 0 };
        cur.confirmed += 1;
        if (attended) cur.attended += 1;
        else cur.noShows += 1;
        perGuest.set(email, cur);
      }
      if (perGuest.size) {
        const emails = [...perGuest.keys()];
        await client.query(
          `INSERT INTO guest_history (organizer_id, guest_email_lower, events_confirmed, events_attended, no_shows, last_event_id)
           SELECT $1, g.email, g.confirmed, g.attended, g.no_shows, $2
             FROM unnest($3::text[], $4::int[], $5::int[], $6::int[]) AS g(email, confirmed, attended, no_shows)
           ON CONFLICT (organizer_id, guest_email_lower) DO UPDATE
             SET events_confirmed = guest_history.events_confirmed + EXCLUDED.events_confirmed,
                 events_attended  = guest_history.events_attended + EXCLUDED.events_attended,
                 no_shows         = guest_history.no_shows + EXCLUDED.no_shows,
                 last_event_id    = EXCLUDED.last_event_id`,
          [
            ev.organizer_id,
            eventId,
            emails,
            emails.map((e) => perGuest.get(e).confirmed),
            emails.map((e) => perGuest.get(e).attended),
            emails.map((e) => perGuest.get(e).noShows),
          ],
        );
      }
      log.info('report_generated', {
        event_id: eventId,
        invited: totals.invited,
        confirmed: totals.confirmed,
        attended: totals.attended,
        no_shows: totals.no_shows,
      });
      return 'generated';
    },
    { isolationLevel: 'REPEATABLE READ' },
  );
}

const consumer = messaging.createDomainEventConsumer({
  name: 'checkin',
  handlers: {
    [M.EVENT_COMPLETED]: async (envelope) => {
      await generateReport(envelope.event_id);
    },
  },
});

exports.generateReport = generateReport;
exports.processEnvelope = consumer.processEnvelope;
exports.handler = sqsHandler.createSqsHandler(consumer.processRecord, { name: 'report-generator' });
