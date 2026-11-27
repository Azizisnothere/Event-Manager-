'use strict';
/**
 * import-fn: triggered by S3 ObjectCreated on the imports bucket (em-guest-imports).
 * Reads the uploaded file (max 1 MB) and hands it to src/lib/csvImport.js, which validates every
 * row and records the result in guest_list_imports (Section 5.3, Threat 5).
 */
const { db, s3, constants, logger, config } = require('../../../shared');
const { importCsvText, markFailed } = require('../src/lib/csvImport');

const { CSV_IMPORT_MAX_BYTES } = constants;
const log = logger.child({ function_role: 'import-processor' });

/**
 * Processes one uploaded object. Exported for the local dev server.
 * @returns {Promise<'processed'|'ignored'|'failed'>}
 */
async function processImportObject(bucket, key) {
  // Claim the import: only a pending import is processed (S3 can deliver an event twice).
  const { rows: claimed } = await db.query(
    `UPDATE guest_list_imports SET status = 'processing'
      WHERE s3_key = $1 AND status = 'pending'
      RETURNING import_id, event_id`,
    [key],
  );
  if (!claimed.length) {
    log.info('import_ignored', { reason: 'no pending import for key' });
    return 'ignored';
  }
  const { import_id: importId, event_id: eventId } = claimed[0];

  let text;
  try {
    const head = await s3.headObject({ bucket, key });
    if (Number(head.ContentLength) > CSV_IMPORT_MAX_BYTES) {
      await markFailed(importId, `The file is larger than ${CSV_IMPORT_MAX_BYTES / 1024} KB.`);
      return 'failed';
    }
    text = await s3.getObjectText({ bucket, key });
  } catch (err) {
    log.error('import_read_failed', { import_id: importId, error: err });
    await markFailed(importId, 'The uploaded file could not be read.');
    return 'failed';
  }

  return importCsvText(importId, eventId, text);
}

exports.processImportObject = processImportObject;

exports.handler = async (event, context) => {
  if (context) context.callbackWaitsForEmptyEventLoop = false;
  const records = (event && event.Records) || [];
  for (const record of records) {
    const bucket = record.s3 && record.s3.bucket && record.s3.bucket.name;
    const rawKey = record.s3 && record.s3.object && record.s3.object.key;
    if (!bucket || !rawKey) continue;
    if (config.importsBucket && bucket !== config.importsBucket) {
      log.warn('import_unexpected_bucket');
      continue;
    }
    // S3 event keys are URL-encoded with '+' for spaces.
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    if (!/^imports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.csv$/.test(key)) {
      log.warn('import_unexpected_key');
      continue;
    }
    try {
      await processImportObject(bucket, key);
    } catch (err) {
      log.error('import_processing_error', { error: err });
      const { rows } = await db.query(`SELECT import_id FROM guest_list_imports WHERE s3_key = $1`, [key]).catch(() => ({ rows: [] }));
      if (rows.length) await markFailed(rows[0].import_id, 'Unexpected error while processing the file.').catch(() => {});
    }
  }
  return { processed: records.length };
};
