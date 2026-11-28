'use strict';
const { db, csv, validation, emailQueue, constants, logger } = require('../../../../shared');
const { csvGuestSchema } = require('../validators');
const { GUEST_LIST_OPEN_STATUSES } = require('./statusMachine');
const { addGuests, issueTokens, organizerName, invitationEmailJobs } = require('./invitationService');

const { CSV_IMPORT_MAX_ROWS, CSV_IMPORT_MAX_STORED_ERRORS } = constants;
const KNOWN_COLUMNS = ['guest_name', 'guest_email', 'plus_one_allowance', 'category'];
const log = logger.child({ component: 'csv-import' });

async function markFailed(importId, reason) {
  await db.query(
    `UPDATE guest_list_imports SET status = 'failed', failure_reason = $2 WHERE import_id = $1 AND status = 'processing'`,
    [importId, String(reason).slice(0, 300)],
  );
  log.warn('import_failed', { import_id: importId, reason });
}

function validateRows(rows) {
  if (!rows.length) return { fatal: 'The file is empty.' };
  const header = rows[0].cells.map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !KNOWN_COLUMNS.includes(h));
  if (unknown.length) return { fatal: `Unknown column(s): ${unknown.slice(0, 5).join(', ')}` };
  if (!header.includes('guest_name') || !header.includes('guest_email')) {
    return { fatal: 'The header must contain guest_name and guest_email.' };
  }
  if (new Set(header).size !== header.length) return { fatal: 'The header contains duplicate columns.' };

  const guests = [];
  const rowErrors = [];
  for (const row of rows.slice(1)) {
    if (row.cells.length !== header.length) {
      rowErrors.push({ line: row.line, errors: [`expected ${header.length} columns, found ${row.cells.length}`] });
      continue;
    }
    const obj = {};
    header.forEach((h, i) => {
      const v = row.cells[i];
      if (v !== '') obj[h] = v;
    });
    try {
      const g = validation.validate(csvGuestSchema, obj, { coerce: true });
      guests.push({ ...g, line: row.line });
    } catch (err) {
      const msgs = (err.details || []).map((d) => `${d.field} ${d.message}`);
      rowErrors.push({ line: row.line, errors: msgs.length ? msgs : ['invalid row'] });
    }
  }
  return { guests, rowErrors };
}

async function importCsvText(importId, eventId, text) {
  let parsed;
  try {
    parsed = csv.parseCsv(text, { maxRows: CSV_IMPORT_MAX_ROWS + 1, maxFieldLength: 400 });
  } catch (err) {
    const where = err.line ? ` (line ${err.line})` : '';
    await markFailed(importId, err.name === 'CsvParseError' ? `${err.message}${where}` : 'The file is not valid CSV.');
    return 'failed';
  }

  const checked = validateRows(parsed.rows);
  if (checked.fatal) {
    await markFailed(importId, checked.fatal);
    return 'failed';
  }

  const outcome = await db.withTransaction(async (client) => {
    const { rows: evRows } = await client.query(
      `SELECT event_id, organizer_id, title, venue_address, start_time, end_time, rsvp_deadline, invite_limit, status
         FROM events WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    const ev = evRows[0];
    if (!ev || !GUEST_LIST_OPEN_STATUSES.includes(ev.status)) {
      await client.query(
        `UPDATE guest_list_imports SET status = 'failed', failure_reason = $2 WHERE import_id = $1`,
        [importId, `Guests cannot be imported into a ${ev ? ev.status : 'missing'} event.`],
      );
      return { failed: true };
    }
    const result = await addGuests(client, ev, checked.guests, { mode: 'partial' });
    const skippedErrors = result.skipped.map((s) => ({ line: s.line, errors: [s.reason.replace(/_/g, ' ')] }));
    const allErrors = [...checked.rowErrors, ...result.rowErrors, ...skippedErrors].sort((a, b) => a.line - b.line);
    const rowsSkipped = checked.rowErrors.length + result.rowErrors.length + result.skipped.length;

    let emailJobs = [];
    if (ev.status === 'published' && result.added.length) {
      const issued = await issueTokens(client, result.added.map((r) => r.invitation_id));
      emailJobs = invitationEmailJobs(ev, await organizerName(client, ev.organizer_id), issued);
    }
    await client.query(
      `UPDATE guest_list_imports
          SET status = 'completed', rows_added = $2, rows_skipped = $3, row_errors = $4::jsonb
        WHERE import_id = $1`,
      [importId, result.added.length, rowsSkipped, JSON.stringify(allErrors.slice(0, CSV_IMPORT_MAX_STORED_ERRORS))],
    );
    return { failed: false, added: result.added.length, skipped: rowsSkipped, emailJobs };
  });

  if (outcome.failed) return 'failed';
  if (outcome.emailJobs.length) {
    try {
      await emailQueue.enqueueEmails(outcome.emailJobs);
    } catch (err) {
      log.error('import_invitation_emails_not_queued', { import_id: importId, error: err });
    }
  }
  log.info('import_completed', { import_id: importId, rows_added: outcome.added, rows_skipped: outcome.skipped });
  return 'processed';
}

module.exports = { importCsvText, markFailed, validateRows };
