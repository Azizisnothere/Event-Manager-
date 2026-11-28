'use strict';
const crypto = require('crypto');
const config = require('./config');
const { logger } = require('./logger');
const aws = require('./awsClients');
const { EMAIL_TEMPLATES } = require('./constants');
const { dispatchLocal } = require('./messaging');
const { EMAIL_PATTERN } = require('./validation');
const { chunk } = require('./utils');

const VALID_TEMPLATES = new Set(Object.values(EMAIL_TEMPLATES));
const MAX_JOB_BYTES = 200 * 1024;

function buildEmailJob({ template, to, params = {} }) {
  if (!VALID_TEMPLATES.has(template)) throw new Error(`Unknown email template: ${template}`);
  if (!to || typeof to.email !== 'string' || !EMAIL_PATTERN.test(to.email)) {
    throw new Error('Email job requires a valid recipient');
  }
  const job = {
    job_id: crypto.randomUUID(),
    template,
    to: { email: to.email.trim(), name: to.name ? String(to.name).slice(0, 100) : '' },
    params,
    created_at: new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(job), 'utf8') > MAX_JOB_BYTES) throw new Error('Email job is too large');
  return job;
}

async function enqueueEmails(inputs) {
  const jobs = inputs.map(buildEmailJob);
  if (!jobs.length) return 0;
  const queueUrl = config.notificationsQueueUrl;

  if (!queueUrl) {
    if (config.isProduction) throw new Error('NOTIFICATIONS_QUEUE_URL must be set in production.');
    for (const job of jobs) {
      if (!dispatchLocal('email', job)) {
        logger.info('email_suppressed_local', { template: job.template, job_id: job.job_id });
      }
    }
    return jobs.length;
  }

  const { SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
  for (const group of chunk(jobs, 10)) {
    const out = await aws.sqs().send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: group.map((job, i) => ({
          Id: String(i),
          MessageBody: JSON.stringify(job),
          MessageAttributes: { template: { DataType: 'String', StringValue: job.template } },
        })),
      }),
    );
    if (out.Failed && out.Failed.length) {
      throw new Error(`Failed to queue ${out.Failed.length} email job(s)`);
    }
  }
  logger.info('email_jobs_queued', { count: jobs.length, templates: [...new Set(jobs.map((j) => j.template))] });
  return jobs.length;
}

async function enqueueEmail(input) {
  return enqueueEmails([input]);
}

function parseEmailJob(record) {
  const job = JSON.parse(record.body);
  if (!job || typeof job !== 'object') throw new Error('Email job is not an object');
  if (typeof job.job_id !== 'string' || !job.job_id) throw new Error('Email job has no job_id');
  if (!VALID_TEMPLATES.has(job.template)) throw new Error('Email job has an unknown template');
  if (!job.to || typeof job.to.email !== 'string' || !EMAIL_PATTERN.test(job.to.email)) {
    throw new Error('Email job has an invalid recipient');
  }
  if (job.params !== undefined && (typeof job.params !== 'object' || job.params === null)) {
    throw new Error('Email job params must be an object');
  }
  return { ...job, params: job.params || {} };
}

module.exports = { enqueueEmail, enqueueEmails, buildEmailJob, parseEmailJob, EMAIL_TEMPLATES };
