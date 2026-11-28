'use strict';
const config = require('./config');
const { logger } = require('./logger');
const aws = require('./awsClients');
const { nowSeconds } = require('./utils');
const { IDEMPOTENCY_TTL_SECONDS, IDEMPOTENCY_PROCESSING_TTL_SECONDS } = require('./constants');

const memory = new Map();
let warnedMemory = false;

function useMemory() {
  if (config.requestGuardTable) return false;
  if (config.isProduction) throw new Error('REQUEST_GUARD_TABLE must be set in production.');
  if (!warnedMemory) {
    logger.warn('request_guard_in_memory', { note: 'REQUEST_GUARD_TABLE not set; using in-memory counters (local dev only)' });
    warnedMemory = true;
  }
  return true;
}

function ddb() {
  return require('@aws-sdk/client-dynamodb');
}

async function increment(key, windowSeconds) {
  const now = nowSeconds();
  const exp = now + windowSeconds;

  if (useMemory()) {
    const cur = memory.get(key);
    if (!cur || cur.expiresAt <= now) {
      memory.set(key, { count: 1, expiresAt: exp });
      return { count: 1, expiresAt: exp };
    }
    cur.count += 1;
    return { count: cur.count, expiresAt: cur.expiresAt };
  }

  const { UpdateItemCommand, PutItemCommand } = ddb();
  const TableName = config.requestGuardTable;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const out = await aws.dynamo().send(
        new UpdateItemCommand({
          TableName,
          Key: { pk: { S: key } },
          UpdateExpression: 'SET #c = if_not_exists(#c, :zero) + :one, #e = if_not_exists(#e, :exp)',
          ConditionExpression: 'attribute_not_exists(#pk) OR #e > :now',
          ExpressionAttributeNames: { '#c': 'hit_count', '#e': 'expires_at', '#pk': 'pk' },
          ExpressionAttributeValues: {
            ':zero': { N: '0' },
            ':one': { N: '1' },
            ':exp': { N: String(exp) },
            ':now': { N: String(now) },
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { count: Number(out.Attributes.hit_count.N), expiresAt: Number(out.Attributes.expires_at.N) };
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      try {
        await aws.dynamo().send(
          new PutItemCommand({
            TableName,
            Item: { pk: { S: key }, hit_count: { N: '1' }, expires_at: { N: String(exp) } },
            ConditionExpression: 'attribute_not_exists(#pk) OR #e <= :now',
            ExpressionAttributeNames: { '#pk': 'pk', '#e': 'expires_at' },
            ExpressionAttributeValues: { ':now': { N: String(now) } },
          }),
        );
        return { count: 1, expiresAt: exp };
      } catch (putErr) {
        if (putErr.name !== 'ConditionalCheckFailedException') throw putErr;
      }
    }
  }
  throw new Error('Could not update request counter');
}

async function peek(key) {
  const now = nowSeconds();
  if (useMemory()) {
    const cur = memory.get(key);
    return cur && cur.expiresAt > now ? { count: cur.count, expiresAt: cur.expiresAt } : { count: 0, expiresAt: 0 };
  }
  const { GetItemCommand } = ddb();
  const out = await aws.dynamo().send(
    new GetItemCommand({ TableName: config.requestGuardTable, Key: { pk: { S: key } }, ConsistentRead: true }),
  );
  const item = out.Item;
  if (!item || !item.expires_at || Number(item.expires_at.N) <= now) return { count: 0, expiresAt: 0 };
  return { count: Number(item.hit_count ? item.hit_count.N : 0), expiresAt: Number(item.expires_at.N) };
}

async function reset(key) {
  if (useMemory()) {
    memory.delete(key);
    return;
  }
  const { DeleteItemCommand } = ddb();
  await aws.dynamo().send(new DeleteItemCommand({ TableName: config.requestGuardTable, Key: { pk: { S: key } } }));
}

async function hit(key, limit, windowSeconds) {
  const { count, expiresAt } = await increment(key, windowSeconds);
  return {
    allowed: count <= limit,
    count,
    retryAfterSeconds: Math.max(1, expiresAt - nowSeconds()),
    firstRejection: count === limit + 1,
  };
}

async function claimIdempotencyKey(id) {
  const key = `idem#${id}`;
  const now = nowSeconds();
  if (useMemory()) {
    const cur = memory.get(key);
    if (cur && cur.expiresAt > now) return cur.status === 'done' ? 'duplicate' : 'in_progress';
    memory.set(key, { status: 'processing', expiresAt: now + IDEMPOTENCY_PROCESSING_TTL_SECONDS });
    return 'claimed';
  }
  const { PutItemCommand, GetItemCommand } = ddb();
  try {
    await aws.dynamo().send(
      new PutItemCommand({
        TableName: config.requestGuardTable,
        Item: {
          pk: { S: key },
          status: { S: 'processing' },
          expires_at: { N: String(now + IDEMPOTENCY_PROCESSING_TTL_SECONDS) },
        },
        ConditionExpression: 'attribute_not_exists(#pk) OR #e <= :now',
        ExpressionAttributeNames: { '#pk': 'pk', '#e': 'expires_at' },
        ExpressionAttributeValues: { ':now': { N: String(now) } },
      }),
    );
    return 'claimed';
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    const out = await aws.dynamo().send(
      new GetItemCommand({ TableName: config.requestGuardTable, Key: { pk: { S: key } }, ConsistentRead: true }),
    );
    return out.Item && out.Item.status && out.Item.status.S === 'done' ? 'duplicate' : 'in_progress';
  }
}

async function completeIdempotencyKey(id) {
  const key = `idem#${id}`;
  const exp = nowSeconds() + IDEMPOTENCY_TTL_SECONDS;
  if (useMemory()) {
    memory.set(key, { status: 'done', expiresAt: exp });
    return;
  }
  const { PutItemCommand } = ddb();
  await aws.dynamo().send(
    new PutItemCommand({
      TableName: config.requestGuardTable,
      Item: { pk: { S: key }, status: { S: 'done' }, expires_at: { N: String(exp) } },
    }),
  );
}

async function releaseIdempotencyKey(id) {
  await reset(`idem#${id}`);
}

function clearMemoryStore() {
  memory.clear();
}

module.exports = {
  increment,
  peek,
  reset,
  hit,
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
  clearMemoryStore,
};
