'use strict';
const { logger } = require('./logger');

function createSqsHandler(processRecord, { name }) {
  const log = logger.child({ consumer: name });
  return async function handler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    const records = (event && event.Records) || [];
    const batchItemFailures = [];
    for (const record of records) {
      try {
        await processRecord(record, context);
      } catch (err) {
        log.error('sqs_record_failed', {
          message_id: record.messageId,
          receive_count: record.attributes && record.attributes.ApproximateReceiveCount,
          error: err,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    log.info('sqs_batch_done', { received: records.length, failed: batchItemFailures.length });
    return { batchItemFailures };
  };
}

module.exports = { createSqsHandler };
