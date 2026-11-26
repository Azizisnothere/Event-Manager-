'use strict';
/**
 * Non-secret configuration. Every value is read from process.env at access time
 * (getters), so the local dev server can set variables before first use.
 * Secret VALUES never live here: see secrets.js (Section 6.2 "Secrets handling").
 */

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function list(name) {
  const v = env(name, '');
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  get nodeEnv() {
    return env('NODE_ENV', 'development');
  },
  get isProduction() {
    return env('NODE_ENV', 'development') === 'production';
  },
  get serviceName() {
    return env('SERVICE_NAME', env('AWS_LAMBDA_FUNCTION_NAME', 'event-manager'));
  },
  get logLevel() {
    return env('LOG_LEVEL', 'info');
  },

  // Frontend (links in emails). The CORS allow-list is CORS_ORIGINS, read by appFactory.js.
  get frontendBaseUrl() {
    return env('FRONTEND_BASE_URL', '').replace(/\/+$/, '');
  },

  // AWS / Floci
  get awsRegion() {
    return env('AWS_REGION', env('AWS_DEFAULT_REGION', 'us-east-1'));
  },
  get awsEndpointUrl() {
    return env('AWS_ENDPOINT_URL');
  },
  get s3PublicEndpoint() {
    return env('S3_PUBLIC_ENDPOINT');
  },

  // Resource names (created by infra/deploy.sh; only names are passed in)
  get importsBucket() {
    return env('IMPORTS_BUCKET');
  },
  get reportsBucket() {
    return env('REPORTS_BUCKET');
  },
  get requestGuardTable() {
    return env('REQUEST_GUARD_TABLE');
  },
  get domainEventsTopicArn() {
    return env('DOMAIN_EVENTS_TOPIC_ARN');
  },
  get notificationsQueueUrl() {
    return env('NOTIFICATIONS_QUEUE_URL');
  },

  // Email sender identity (not secret)
  get brevoSenderEmail() {
    return env('BREVO_SENDER_EMAIL');
  },
  get brevoSenderName() {
    return env('BREVO_SENDER_NAME', 'Event Manager');
  },

  // Optional extra Turnstile check
  get turnstileExpectedHostname() {
    return env('TURNSTILE_EXPECTED_HOSTNAME');
  },

  // Database pool
  get dbPoolMax() {
    const n = Number.parseInt(env('DB_POOL_MAX', '3'), 10);
    return Number.isInteger(n) && n > 0 ? n : 3;
  },
  get dbSslDisabled() {
    // TLS may only be turned off for a local Postgres; never in production.
    return env('DB_SSL') === 'disable' && env('NODE_ENV', 'development') !== 'production';
  },

  get secretsCacheTtlSeconds() {
    const n = Number.parseInt(env('SECRETS_CACHE_TTL_SECONDS', '3600'), 10);
    return Number.isInteger(n) && n >= 0 ? n : 3600;
  },
};

module.exports = config;
