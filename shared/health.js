const express = require('express');
const { checkDatabase } = require('./db');
const { checkSecretsManager } = require('./secrets');
const { logger } = require('./logger');

const TIMEOUT_MS = 3000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); })
  ]).finally(() => clearTimeout(timer));
}

const router = express.Router();

router.get('/api/health', async (req, res) => {
  const checks = { api: 'ok', database: 'unknown', secrets: 'unknown' };
  const [dbResult, secretsResult] = await Promise.allSettled([withTimeout(checkDatabase()), withTimeout(checkSecretsManager())]);
  checks.database = dbResult.status === 'fulfilled' ? 'ok' : 'error';
  checks.secrets = secretsResult.status === 'fulfilled' ? secretsResult.value : 'error';
  if (dbResult.status === 'rejected') logger.error('health database failed', { error: dbResult.reason });
  if (secretsResult.status === 'rejected') logger.error('health secrets failed', { error: secretsResult.reason });

  const healthy = checks.database === 'ok' && checks.secrets !== 'error';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc'
  });
});

module.exports = router;
