'use strict';
/**
 * Lazily created AWS SDK v3 clients, one per container (reused across invocations).
 * When AWS_ENDPOINT_URL is set (Floci emulator) every client points at it and S3
 * uses path-style addressing. SDK modules are required on first use to keep
 * cold starts small for functions that do not need them.
 */
const config = require('./config');

const cache = new Map();

function baseOptions() {
  const opts = { region: config.awsRegion };
  if (config.awsEndpointUrl) {
    opts.endpoint = config.awsEndpointUrl;
    // Emulator only (Floci): it accepts any credentials. Real AWS uses the Lambda role's credentials.
    if (!process.env.AWS_ACCESS_KEY_ID) opts.credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  }
  return opts;
}

function memo(key, factory) {
  if (!cache.has(key)) cache.set(key, factory());
  return cache.get(key);
}

function s3() {
  return memo('s3', () => {
    const { S3Client } = require('@aws-sdk/client-s3');
    return new S3Client({ ...baseOptions(), forcePathStyle: Boolean(config.awsEndpointUrl) });
  });
}

/**
 * Client used only to SIGN presigned URLs. The browser must reach the signed
 * host, so S3_PUBLIC_ENDPOINT (e.g. the HTTPS tunnel to Floci) is used when set.
 */
function s3Presigner() {
  return memo('s3Presigner', () => {
    const { S3Client } = require('@aws-sdk/client-s3');
    const endpoint = config.s3PublicEndpoint || config.awsEndpointUrl;
    const opts = { region: config.awsRegion, forcePathStyle: Boolean(endpoint) };
    if (endpoint) opts.endpoint = endpoint;
    return new S3Client(opts);
  });
}

function sqs() {
  return memo('sqs', () => {
    const { SQSClient } = require('@aws-sdk/client-sqs');
    return new SQSClient(baseOptions());
  });
}

function sns() {
  return memo('sns', () => {
    const { SNSClient } = require('@aws-sdk/client-sns');
    return new SNSClient(baseOptions());
  });
}

function dynamo() {
  return memo('dynamo', () => {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    return new DynamoDBClient(baseOptions());
  });
}

function secretsManager() {
  return memo('secretsManager', () => {
    const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    return new SecretsManagerClient(baseOptions());
  });
}

/** Test/dev helper: drop cached clients (e.g. after changing AWS_ENDPOINT_URL). */
function resetClients() {
  cache.clear();
}

module.exports = { s3, s3Presigner, sqs, sns, dynamo, secretsManager, resetClients };
