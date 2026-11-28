'use strict';

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

  get frontendBaseUrl() {
    return env('FRONTEND_BASE_URL', '').replace(/\/+$/, '');
  },

  get awsRegion() {
    return env('AWS_REGION', env('AWS_DEFAULT_REGION', 'us-east-1'));
  },
  get awsEndpointUrl() {
    return env('AWS_ENDPOINT_URL');
  },
  get s3PublicEndpoint() {
    return env('S3_PUBLIC_ENDPOINT');
  },

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

  get brevoSenderEmail() {
    return env('BREVO_SENDER_EMAIL');
  },
  get brevoSenderName() {
    return env('BREVO_SENDER_NAME', 'Event Manager');
  },

  get turnstileExpectedHostname() {
    return env('TURNSTILE_EXPECTED_HOSTNAME');
  },

  get dbPoolMax() {
    const n = Number.parseInt(env('DB_POOL_MAX', '3'), 10);
    return Number.isInteger(n) && n > 0 ? n : 3;
  },
  get dbSslDisabled() {
    return env('DB_SSL') === 'disable' && env('NODE_ENV', 'development') !== 'production';
  },

  get secretsCacheTtlSeconds() {
    const n = Number.parseInt(env('SECRETS_CACHE_TTL_SECONDS', '3600'), 10);
    return Number.isInteger(n) && n >= 0 ? n : 3600;
  },
};

module.exports = config;
