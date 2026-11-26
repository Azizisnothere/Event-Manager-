'use strict';
/**
 * CSV guest-list import (Section 5.1, owner: Osama):
 *   POST /api/events/:eventId/invitations/imports             5-minute presigned PUT URL   201 | 400, 401, 403, 404, 409
 *   GET  /api/events/:eventId/invitations/imports/:importId   import status and row errors 200 | 401, 403, 404
 *   POST /api/events/:eventId/invitations/bulk                pasted CSV (64 KB), processed now 201 | 400, 401, 403, 404, 409, 413
 * An uploaded file is processed in the background by lambdas/importProcessor.js (S3 ObjectCreated);
 * both paths use src/lib/csvImport.js, so the rules and the result format are the same.
 * Threat 7: the bucket is private; the upload URL expires after 5 minutes and is for one key.
 */
const express = require('express');
const crypto = require('crypto');
const {
  db,
  errors,
  config,
  s3,
  utils,
  middleware: { authenticate, requireRole, authorizeEvent, validateRequest },
} = require('../../../../shared');
const { schemas } = require('../validators');
const { GUEST_LIST_OPEN_STATUSES } = require('../lib/statusMachine');
const { importCsvText, markFailed } = require('../lib/csvImport');

const IMPORT_COLUMNS = 'import_id, event_id, status, rows_added, rows_skipped, row_errors, failure_reason, created_at, updated_at';

function toImportResponse(r) {
  return {
    import_id: r.import_id,
    event_id: r.event_id,
    status: r.status,
    rows_added: r.rows_added,
    rows_skipped: r.rows_skipped,
    row_errors: r.row_errors,
    failure_reason: r.failure_reason,
    created_at: utils.toIso(r.created_at),
    updated_at: utils.toIso(r.updated_at),
  };
}

function importRoutes() {
  const router = express.Router();
  const organizerOnly = [authenticate(), requireRole('organizer'), authorizeEvent()];

  router.post(
    '/api/events/:eventId/invitations/imports',
    ...organizerOnly,
    validateRequest(schemas.createImport),
    async (req, res) => {
      if (!GUEST_LIST_OPEN_STATUSES.includes(req.event.status)) {
        throw errors.conflict(`Guests cannot be imported into a ${req.event.status} event.`, 'GUEST_LIST_CLOSED');
      }
      if (!config.importsBucket) throw errors.serviceUnavailable('CSV import is not configured.');
      const importId = crypto.randomUUID();
      const key = `imports/${req.event.event_id}/${importId}.csv`;
      const { rows } = await db.query(
        `INSERT INTO guest_list_imports (import_id, event_id, s3_key, status, created_by)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING ${IMPORT_COLUMNS}`,
        [importId, req.event.event_id, key, req.user.user_id],
      );
      const upload = await s3.presignPut({ bucket: config.importsBucket, key, contentType: 'text/csv' });
      res.status(201).json({
        import: toImportResponse(rows[0]),
        upload, // { url, method: 'PUT', headers: { 'Content-Type': 'text/csv' }, expires_in: 300 }
        csv_format: {
          header: 'guest_name,guest_email,plus_one_allowance,category',
          required_columns: ['guest_name', 'guest_email'],
          optional_columns: ['plus_one_allowance', 'category'],
        },
      });
    },
  );

  router.post(
    '/api/events/:eventId/invitations/bulk',
    ...organizerOnly,
    validateRequest(schemas.bulkImport),
    async (req, res) => {
      if (!GUEST_LIST_OPEN_STATUSES.includes(req.event.status)) {
        throw errors.conflict(`Guests cannot be imported into a ${req.event.status} event.`, 'GUEST_LIST_CLOSED');
      }
      const importId = crypto.randomUUID();
      // No file in S3: the key only records where the list came from and keeps s3_key unique.
      await db.query(
        `INSERT INTO guest_list_imports (import_id, event_id, s3_key, status, created_by)
         VALUES ($1, $2, $3, 'processing', $4)`,
        [importId, req.event.event_id, `inline/${req.event.event_id}/${importId}.csv`, req.user.user_id],
      );
      try {
        await importCsvText(importId, req.event.event_id, req.valid.body.csv);
      } catch (err) {
        await markFailed(importId, 'Unexpected error while processing the list.').catch(() => {});
        throw err;
      }
      const { rows } = await db.query(`SELECT ${IMPORT_COLUMNS} FROM guest_list_imports WHERE import_id = $1`, [importId]);
      res.status(201).json({ import: toImportResponse(rows[0]) });
    },
  );

  router.get(
    '/api/events/:eventId/invitations/imports/:importId',
    ...organizerOnly,
    validateRequest(schemas.importParams),
    async (req, res) => {
      // Threat 3: the import must belong to this (already ownership-checked) event.
      const { rows } = await db.query(
        `SELECT ${IMPORT_COLUMNS} FROM guest_list_imports WHERE import_id = $1 AND event_id = $2`,
        [req.valid.params.importId, req.event.event_id],
      );
      if (!rows.length) throw errors.notFound('Import not found.', 'IMPORT_NOT_FOUND');
      res.json({ import: toImportResponse(rows[0]) });
    },
  );

  return router;
}

module.exports = { importRoutes };
