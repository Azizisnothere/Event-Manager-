'use strict';
/**
 * scheduler-fn: EventBridge rule rate(5 minutes).
 *  1. published events whose rsvp_deadline has passed  -> rsvp_closed
 *  2. rsvp_closed events 30 minutes after end_time      -> completed (+ event.completed message)
 *  3. repair: completed events that still have no attendance report after 10 minutes get
 *     event.completed re-published (the report generator is idempotent), so a lost message
 *     never leaves an event without its report.
 * Each UPDATE locks the rows it changes, so it serialises with RSVP transactions that hold
 * SELECT ... FOR UPDATE on the same event.
 */
const { db, constants, logger } = require('../../../shared');
const { publishEventCompleted } = require('../src/lib/domainEvents');

const log = logger.child({ function_role: 'scheduler' });
const REPAIR_AFTER_MINUTES = 10;
const REPAIR_WINDOW_DAYS = 7;
const REPAIR_BATCH = 20;

async function runScheduler() {
  const closed = await db.query(
    `UPDATE events SET status = 'rsvp_closed'
      WHERE status = 'published' AND rsvp_deadline <= now()
      RETURNING event_id`,
  );

  const completed = await db.query(
    `UPDATE events SET status = 'completed', completed_at = now()
      WHERE status = 'rsvp_closed' AND end_time + make_interval(mins => $1) <= now()
      RETURNING event_id`,
    [constants.AUTO_COMPLETE_MINUTES_AFTER_END],
  );
  for (const row of completed.rows) {
    await publishEventCompleted(row.event_id, 'scheduler');
  }

  const missing = await db.query(
    `SELECT e.event_id
       FROM events e
       LEFT JOIN attendance_reports ar ON ar.event_id = e.event_id
      WHERE e.status = 'completed'
        AND ar.report_id IS NULL
        AND e.completed_at <= now() - make_interval(mins => $1)
        AND e.completed_at >= now() - make_interval(days => $2)
      ORDER BY e.completed_at
      LIMIT $3`,
    [REPAIR_AFTER_MINUTES, REPAIR_WINDOW_DAYS, REPAIR_BATCH],
  );
  for (const row of missing.rows) {
    await publishEventCompleted(row.event_id, 'scheduler_repair');
  }

  const summary = {
    closed: closed.rowCount,
    completed: completed.rowCount,
    report_retries: missing.rowCount,
  };
  log.info('scheduler_run', summary);
  return summary;
}

exports.runScheduler = runScheduler;

exports.handler = async (event, context) => {
  if (context) context.callbackWaitsForEmptyEventLoop = false;
  return runScheduler();
};
