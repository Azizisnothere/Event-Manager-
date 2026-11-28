'use strict';
const config = require('./config');

const cache = new Map();

function baseOptions() {
  const opts = { region: config.awsRegion };
  if (config.awsEndpointUrl) {
    opts.endpoint = config.awsEndpointUrl;
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

function resetClients() {
  cache.clear();
}

module.exports = { s3, s3Presigner, sqs, sns, dynamo, secretsManager, resetClients };
