'use strict';
/**
 * notifier-fn: consumes email jobs from SQS em-notifications and sends them through Brevo.
 * - Only this function reads the Brevo API key (Section 6.2 "Least privilege", Threat 8).
 * - Jobs are idempotent by job_id, so an SQS redelivery does not send the same email twice.
 * - Transient failures are retried by SQS and end in the DLQ; permanent rejections are logged
 *   and dropped. Recipient addresses and links are never logged.
 */
const { emailQueue, requestGuard, sqsHandler, logger } = require('../../../shared');
const { renderEmail } = require('../src/lib/emailTemplates');
const { sendEmail } = require('../src/lib/brevo');

const log = logger.child({ function_role: 'notifier' });

/** Default transport: Brevo. The local dev server passes a file transport instead. */
const brevoTransport = { send: sendEmail };

/**
 * Renders and sends one job.
 * @param {object} job parsed email job
 * @param {{ transport?: { send: Function }, idempotent?: boolean }} [opts]
 */
async function processJob(job, opts = {}) {
  const transport = opts.transport || brevoTransport;
  const idempotent = opts.idempotent !== false;
  const idemKey = `notifier#${job.job_id}`;
  if (idempotent) {
    const claim = await requestGuard.claimIdempotencyKey(idemKey);
    if (claim === 'duplicate') {
      log.info('email_duplicate_skipped', { job_id: job.job_id, template: job.template });
      return 'duplicate';
    }
    if (claim === 'in_progress') throw new Error('Email job is already being sent; retry later');
  }
  try {
    const message = renderEmail(job.template, job.params);
    await transport.send({ to: job.to, subject: message.subject, html: message.html, text: message.text, template: job.template });
    if (idempotent) await requestGuard.completeIdempotencyKey(idemKey);
    log.info('email_sent', { job_id: job.job_id, template: job.template });
    return 'sent';
  } catch (err) {
    if (err && err.permanent) {
      if (idempotent) await requestGuard.completeIdempotencyKey(idemKey).catch(() => {});
      log.error('email_dropped_permanent_failure', { job_id: job.job_id, template: job.template, status: err.status });
      return 'dropped';
    }
    if (idempotent) await requestGuard.releaseIdempotencyKey(idemKey).catch(() => {});
    throw err;
  }
}

exports.processJob = processJob;

exports.handler = sqsHandler.createSqsHandler(async (record) => processJob(emailQueue.parseEmailJob(record)), {
  name: 'notifier',
});
