'use strict';
/**
 * Messages between services (Section 5.2).
 * The Event service publishes domain events to the SNS topic DOMAIN_EVENTS_TOPIC_ARN
 * (em-domain-events). Infra subscribes the queues em-rsvp-events and em-checkin-events,
 * filtering on the "type" message attribute.
 *
 * Envelope (A38):
 *   { message_id, type, event_id, occurred_at, data }
 *
 * Local development without SNS/SQS: messages are dispatched in-process to handlers that
 * the local dev server registers with registerLocalHandler('domain' | 'email', fn).
 */
const crypto = require('crypto');
const config = require('./config');
const { logger } = require('./logger');
const aws = require('./awsClients');
const { MESSAGE_TYPES } = require('./constants');
const requestGuard = require('./requestGuard');
const { isUuid } = require('./utils');

const VALID_TYPES = new Set(Object.values(MESSAGE_TYPES));
const localHandlers = new Map(); // channel -> Array<fn>

/** Registers an in-process handler (local dev server only). */
function registerLocalHandler(channel, fn) {
  if (!localHandlers.has(channel)) localHandlers.set(channel, []);
  localHandlers.get(channel).push(fn);
}

function hasLocalHandlers(channel) {
  return (localHandlers.get(channel) || []).length > 0;
}

/** Runs local handlers after the current request finishes (mimics async delivery). */
function dispatchLocal(channel, payload) {
  const handlers = localHandlers.get(channel) || [];
  if (!handlers.length) return false;
  setImmediate(() => {
    Promise.all(handlers.map((h) => Promise.resolve().then(() => h(payload)))).catch((err) => {
      logger.error('local_dispatch_failed', { channel, error: err });
    });
  });
  return true;
}

function buildEnvelope(type, eventId, data = {}) {
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown domain message type: ${type}`);
  if (!isUuid(eventId)) throw new Error('Domain message requires a valid event_id');
  return {
    message_id: crypto.randomUUID(),
    type,
    event_id: eventId,
    occurred_at: new Date().toISOString(),
    data,
  };
}

/**
 * Publishes a domain event. Call AFTER the database transaction has committed.
 * @param {string} type one of MESSAGE_TYPES
 * @param {string} eventId
 * @param {object} [data] must not contain emails, tokens or dietary notes
 */
async function publishDomainEvent(type, eventId, data = {}) {
  const envelope = buildEnvelope(type, eventId, data);
  const topicArn = config.domainEventsTopicArn;
  if (topicArn) {
    const { PublishCommand } = require('@aws-sdk/client-sns');
    await aws.sns().send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(envelope),
        MessageAttributes: { type: { DataType: 'String', StringValue: type } },
      }),
    );
  } else if (config.isProduction) {
    throw new Error('DOMAIN_EVENTS_TOPIC_ARN must be set in production.');
  } else if (!dispatchLocal('domain', envelope)) {
    logger.warn('domain_event_not_delivered', { type, event_id: eventId, note: 'no topic and no local handler' });
  }
  logger.info('domain_event_published', { type, event_id: eventId, message_id: envelope.message_id });
  return envelope;
}

/**
 * Extracts the envelope from an SQS record body. Supports raw message delivery and
 * the standard SNS notification wrapper.
 */
function parseDomainEnvelope(record) {
  let body = JSON.parse(record.body);
  if (body && body.Type === 'Notification' && typeof body.Message === 'string') {
    body = JSON.parse(body.Message);
  }
  if (!body || typeof body !== 'object') throw new Error('Message body is not an object');
  if (!VALID_TYPES.has(body.type)) throw new Error(`Unknown message type: ${String(body.type).slice(0, 60)}`);
  if (typeof body.message_id !== 'string' || !body.message_id) throw new Error('Message has no message_id');
  if (!isUuid(body.event_id)) throw new Error('Message has no valid event_id');
  if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null)) {
    throw new Error('Message data must be an object');
  }
  return { ...body, data: body.data || {} };
}

/**
 * Builds a consumer for domain events.
 * @param {{ name: string, handlers: Record<string, (envelope: object) => Promise<void>> }} opts
 * @returns {{ processEnvelope: (envelope: object) => Promise<'processed'|'duplicate'|'ignored'>,
 *             processRecord: (record: object) => Promise<string> }}
 */
function createDomainEventConsumer({ name, handlers }) {
  const log = logger.child({ consumer: name });

  async function processEnvelope(envelope) {
    const handler = handlers[envelope.type];
    if (!handler) {
      log.info('domain_event_ignored', { type: envelope.type, message_id: envelope.message_id });
      return 'ignored';
    }
    // SNS fans the same message_id out to several queues, so the key includes the consumer name.
    const idemKey = `${name}#${envelope.message_id}`;
    const claim = await requestGuard.claimIdempotencyKey(idemKey);
    if (claim === 'duplicate') {
      log.info('domain_event_duplicate', { type: envelope.type, message_id: envelope.message_id });
      return 'duplicate';
    }
    if (claim === 'in_progress') {
      throw new Error('Message is already being processed; retry later');
    }
    const started = Date.now();
    try {
      await handler(envelope);
      await requestGuard.completeIdempotencyKey(idemKey);
      log.info('domain_event_processed', {
        type: envelope.type,
        event_id: envelope.event_id,
        message_id: envelope.message_id,
        duration_ms: Date.now() - started,
      });
      return 'processed';
    } catch (err) {
      await requestGuard.releaseIdempotencyKey(idemKey).catch(() => {});
      throw err;
    }
  }

  async function processRecord(record) {
    return processEnvelope(parseDomainEnvelope(record));
  }

  return { processEnvelope, processRecord };
}

module.exports = {
  publishDomainEvent,
  parseDomainEnvelope,
  createDomainEventConsumer,
  registerLocalHandler,
  hasLocalHandlers,
  dispatchLocal,
  buildEnvelope,
  MESSAGE_TYPES,
};
