'use strict';
const { emailQueue, requestGuard, sqsHandler, logger } = require('../../../shared');
const { renderEmail } = require('../src/lib/emailTemplates');
const { sendEmail } = require('../src/lib/brevo');

const log = logger.child({ function_role: 'notifier' });

const brevoTransport = { send: sendEmail };

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
