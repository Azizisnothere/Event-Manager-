'use strict';
const config = require('./config');
const { logger } = require('./logger');
const aws = require('./awsClients');
const { JWT_SECRET_MIN_LENGTH } = require('./constants');

const SECRET_DEFS = Object.freeze({
  dbUrl: { nameEnv: 'DB_URL_SECRET_NAME', localEnv: 'DATABASE_URL' },
  jwtSecret: { nameEnv: 'JWT_SECRET_NAME', localEnv: 'JWT_SECRET' },
  turnstileSecret: { nameEnv: 'TURNSTILE_SECRET_NAME', localEnv: 'TURNSTILE_SECRET_KEY' },
  brevoApiKey: { nameEnv: 'BREVO_API_KEY_SECRET_NAME', localEnv: 'BREVO_API_KEY' },
  geoapifyApiKey: { nameEnv: 'GEOAPIFY_API_KEY_SECRET_NAME', localEnv: 'GEOAPIFY_API_KEY' },
});

const cache = new Map();

class SecretConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

function validateSecret(key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SecretConfigError(`Secret "${key}" is empty.`);
  }
  const v = value.trim();
  if (key === 'jwtSecret' && v.length < JWT_SECRET_MIN_LENGTH) {
    throw new SecretConfigError(`Secret "jwtSecret" must be at least ${JWT_SECRET_MIN_LENGTH} characters.`);
  }
  return v;
}

async function fetchSecret(key) {
  const def = SECRET_DEFS[key];
  if (!def) throw new SecretConfigError(`Unknown secret "${key}".`);
  const secretName = process.env[def.nameEnv];

  if (secretName) {
    const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const out = await aws.secretsManager().send(new GetSecretValueCommand({ SecretId: secretName }));
    if (typeof out.SecretString !== 'string') {
      throw new SecretConfigError(`Secret "${secretName}" has no SecretString value.`);
    }
    logger.debug('secret_loaded', { secret_key: key, source: 'secrets_manager' });
    return validateSecret(key, out.SecretString);
  }

  if (config.isProduction) {
    throw new SecretConfigError(`${def.nameEnv} must be set in production.`);
  }
  const local = process.env[def.localEnv];
  if (!local) {
    throw new SecretConfigError(`Secret "${key}" is not configured: set ${def.nameEnv} or (local only) ${def.localEnv}.`);
  }
  logger.debug('secret_loaded', { secret_key: key, source: 'local_env' });
  return validateSecret(key, local);
}

async function getSecret(key) {
  const ttlMs = config.secretsCacheTtlSeconds * 1000;
  const hit = cache.get(key);
  if (hit && (ttlMs === 0 || Date.now() - hit.fetchedAt < ttlMs)) return hit.promise;
  const promise = fetchSecret(key);
  cache.set(key, { promise, fetchedAt: Date.now() });
  promise.catch(() => {
    if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key);
  });
  return promise;
}

function isSecretConfigured(key) {
  const def = SECRET_DEFS[key];
  if (!def) return false;
  if (process.env[def.nameEnv]) return true;
  return !config.isProduction && Boolean(process.env[def.localEnv]);
}

async function checkSecretsManager() {
  const name = process.env[SECRET_DEFS.jwtSecret.nameEnv];
  if (!name) {
    if (config.isProduction) throw new SecretConfigError('JWT_SECRET_NAME must be set in production.');
    return 'local-env';
  }
  const { DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
  await aws.secretsManager().send(new DescribeSecretCommand({ SecretId: name }));
  return 'ok';
}

function clearSecretCache() {
  cache.clear();
}

module.exports = { getSecret, isSecretConfigured, checkSecretsManager, clearSecretCache, SECRET_DEFS, SecretConfigError };
