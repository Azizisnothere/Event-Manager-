require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
const {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, PutBucketWebsiteCommand, PutBucketPolicyCommand,
  PutPublicAccessBlockCommand, DeletePublicAccessBlockCommand, PutBucketCorsCommand, PutBucketNotificationConfigurationCommand,
  ListObjectsV2Command, DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, CreateTopicCommand, SubscribeCommand, ListSubscriptionsByTopicCommand } = require('@aws-sdk/client-sns');
const { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { IAMClient, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
const {
  LambdaClient, CreateFunctionCommand, GetFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
  AddPermissionCommand, ListEventSourceMappingsCommand, CreateEventSourceMappingCommand
} = require('@aws-sdk/client-lambda');
const {
  APIGatewayClient, CreateRestApiCommand, GetRestApisCommand, GetResourcesCommand, CreateResourceCommand,
  PutMethodCommand, PutIntegrationCommand, CreateDeploymentCommand
} = require('@aws-sdk/client-api-gateway');
const { EventBridgeClient, PutRuleCommand, PutTargetsCommand } = require('@aws-sdk/client-eventbridge');
const { CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand, PutMetricFilterCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, PutMetricAlarmCommand } = require('@aws-sdk/client-cloudwatch');

const ROOT = path.join(__dirname, '..');
const REGION = process.env.AWS_REGION || 'us-east-1';
const ENDPOINT = process.env.DEPLOY_AWS_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';
const LAMBDA_AWS_ENDPOINT = process.env.LAMBDA_AWS_ENDPOINT || 'http://floci:4566';
const RUNTIME = process.env.LAMBDA_RUNTIME || 'nodejs22.x';
const STAGE = 'prod';
const P = 'em';

const clientOpts = {
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test' }
};
const sm = new SecretsManagerClient(clientOpts);
const s3 = new S3Client(clientOpts);
const ddb = new DynamoDBClient(clientOpts);
const sns = new SNSClient(clientOpts);
const sqs = new SQSClient(clientOpts);
const iam = new IAMClient(clientOpts);
const lambda = new LambdaClient(clientOpts);
const apigw = new APIGatewayClient(clientOpts);
const events = new EventBridgeClient(clientOpts);
const cwLogs = new CloudWatchLogsClient(clientOpts);
const cloudwatch = new CloudWatchClient(clientOpts);

const log = (msg) => console.log(`[deploy] ${msg}`);
const isMissing = (e) => ['ResourceNotFoundException', 'NotFound', 'NoSuchEntity', 'NoSuchEntityException', 'NoSuchBucket', '404'].includes(e.name) ||
  (e.$metadata && e.$metadata.httpStatusCode === 404);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

function databaseForLambda() {
  const raw = required('DATABASE_URL');
  const url = new URL(raw);
  if (['localhost', '127.0.0.1'].includes(url.hostname)) {
    url.hostname = process.env.LAMBDA_DB_HOST || 'host.docker.internal';
    url.searchParams.delete('host');
    log(`WARNING: DATABASE_URL is a local Postgres; Lambdas use ${url.hostname} without TLS. The real deployment must use Neon.`);
    return { url: url.toString(), local: true };
  }
  return { url: raw, local: false };
}

async function putSecret(name, value) {
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: name }));
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  } catch (e) {
    if (!isMissing(e)) throw e;
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: value }));
  }
}

async function deploySecrets(db) {
  const secrets = {
    [`${P}/db-url`]: db.url,
    [`${P}/jwt-secret`]: required('JWT_SECRET'),
    [`${P}/turnstile-secret`]: required('TURNSTILE_SECRET_KEY'),
    [`${P}/geoapify-api-key`]: required('GEOAPIFY_API_KEY'),
    [`${P}/brevo-api-key`]: process.env.BREVO_API_KEY || 'not-configured'
  };
  for (const [name, value] of Object.entries(secrets)) await putSecret(name, value);
  log(`secrets: ${Object.keys(secrets).join(', ')}`);
}

async function ensureBucket(Bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch (e) {
    if (!isMissing(e) && e.name !== 'NotFound') throw e;
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
}

async function deployBuckets(origins) {
  for (const b of [`${P}-frontend`, `${P}-guest-imports`, `${P}-reports`, `${P}-deployments`]) await ensureBucket(b);
  for (const b of [`${P}-guest-imports`, `${P}-reports`, `${P}-deployments`]) {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: b,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }
    }));
  }
  await s3.send(new PutBucketCorsCommand({
    Bucket: `${P}-guest-imports`,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT'], AllowedHeaders: ['Content-Type'], MaxAgeSeconds: 600 }] }
  }));
  log('buckets: em-frontend, em-guest-imports, em-reports, em-deployments');
}

async function deployTable() {
  const TableName = `${P}-request-guard`;
  try {
    await ddb.send(new DescribeTableCommand({ TableName }));
  } catch (e) {
    if (!isMissing(e)) throw e;
    await ddb.send(new CreateTableCommand({
      TableName,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST'
    }));
  }
  await ddb.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: 'expires_at' } }))
    .catch((e) => { if (!/already/i.test(e.message)) throw e; });
  log(`table: ${TableName}`);
  return TableName;
}

async function queue(name, attrs = {}) {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  if (Object.keys(attrs).length) await sqs.send(new SetQueueAttributesCommand({ QueueUrl, Attributes: attrs }));
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  return { url: QueueUrl, arn: Attributes.QueueArn };
}

async function queueWithDlq(name, visibilityTimeout) {
  const dlq = await queue(`${name}-dlq`, { MessageRetentionPeriod: String(14 * 24 * 3600) });
  return queue(name, {
    VisibilityTimeout: String(visibilityTimeout),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: '5' })
  });
}

async function deployMessaging() {
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `${P}-domain-events` }));
  const rsvpQ = await queueWithDlq(`${P}-rsvp-events`, 180);
  const checkinQ = await queueWithDlq(`${P}-checkin-events`, 180);
  const notifyQ = await queueWithDlq(`${P}-notifications`, 180);

  const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }));
  const subscribe = async (q, types) => {
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: q.url,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: q.arn,
            Condition: { ArnEquals: { 'aws:SourceArn': TopicArn } }
          }]
        })
      }
    }));
    if (Subscriptions.some((s) => s.Endpoint === q.arn)) return;
    await sns.send(new SubscribeCommand({
      TopicArn, Protocol: 'sqs', Endpoint: q.arn,
      Attributes: { RawMessageDelivery: 'true', FilterPolicy: JSON.stringify({ type: types }) }
    }));
  };
  await subscribe(rsvpQ, ['event.capacity_changed', 'event.updated', 'event.cancelled', 'invitation.revoked']);
  await subscribe(checkinQ, ['event.completed']);
  log('messaging: em-domain-events -> em-rsvp-events, em-checkin-events; em-notifications (+ DLQs)');
  return { TopicArn, rsvpQ, checkinQ, notifyQ };
}

async function ensureRole(fn) {
  const RoleName = `${fn}-role`;
  let arn;
  try {
    arn = (await iam.send(new GetRoleCommand({ RoleName }))).Role.Arn;
  } catch (e) {
    if (!isMissing(e)) throw e;
    const trust = fs.readFileSync(path.join(__dirname, 'iam', 'lambda-trust-policy.json'), 'utf8');
    arn = (await iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: trust }))).Role.Arn;
  }
  const policyFile = path.join(__dirname, 'iam', 'policies', `${fn}.json`);
  if (fs.existsSync(policyFile)) {
    await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: `${fn}-policy`, PolicyDocument: fs.readFileSync(policyFile, 'utf8') }));
  } else {
    log(`WARNING: infra/iam/policies/${fn}.json is missing; ${RoleName} has no permissions policy yet`);
  }
  return arn;
}

function buildZip() {
  const zip = new AdmZip();
  const addDir = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) addDir(rel);
      else zip.addFile(rel.split(path.sep).join('/'), fs.readFileSync(path.join(ROOT, rel)));
    }
  };
  addDir('shared');
  addDir('services');
  zip.addFile('package.json', fs.readFileSync(path.join(ROOT, 'package.json')));
  const out = execSync('npm ls --omit=dev --all --parseable', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dirs = [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && path.resolve(l) !== path.resolve(ROOT)))];
  for (const d of dirs) addDir(path.relative(ROOT, d));
  const buf = zip.toBuffer();
  log(`code zip: ${(buf.length / 1024 / 1024).toFixed(1)} MB, ${dirs.length} packages`);
  return buf;
}

async function uploadCode() {
  const Key = `lambda/event-manager-${Date.now()}.zip`;
  await s3.send(new PutObjectCommand({ Bucket: `${P}-deployments`, Key, Body: buildZip() }));
  return { S3Bucket: `${P}-deployments`, S3Key: Key };
}

async function waitActive(FunctionName) {
  for (let i = 0; i < 60; i++) {
    const { Configuration: c } = await lambda.send(new GetFunctionCommand({ FunctionName }));
    if ((c.State === 'Active' || !c.State) && c.LastUpdateStatus !== 'InProgress') return c;
    if (c.State === 'Failed') throw new Error(`${FunctionName} failed: ${c.StateReason}`);
    await sleep(1000);
  }
  throw new Error(`${FunctionName} did not become active`);
}

async function deployFunction({ name, handler, timeout = 30, memory = 512, env }, code) {
  const Role = await ensureRole(name);
  const Environment = { Variables: { ...env, SERVICE_NAME: name } };
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ...code }));
    await waitActive(name);
    await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: name, Role, Handler: handler, Runtime: RUNTIME, Timeout: timeout, MemorySize: memory, Environment
    }));
  } catch (e) {
    if (!isMissing(e)) throw e;
    await lambda.send(new CreateFunctionCommand({
      FunctionName: name, Role, Handler: handler, Runtime: RUNTIME, Timeout: timeout, MemorySize: memory,
      Code: code, Environment, Description: 'Event Manager'
    }));
  }
  const c = await waitActive(name);
  return c.FunctionArn;
}

async function allow(FunctionName, StatementId, Principal, SourceArn) {
  await lambda.send(new AddPermissionCommand({ FunctionName, StatementId, Action: 'lambda:InvokeFunction', Principal, SourceArn }))
    .catch((e) => { if (e.name !== 'ResourceConflictException') throw e; });
}

async function ensureSqsTrigger(FunctionName, queueArn) {
  const { EventSourceMappings = [] } = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName }));
  if (EventSourceMappings.some((m) => m.EventSourceArn === queueArn)) return;
  await lambda.send(new CreateEventSourceMappingCommand({
    FunctionName, EventSourceArn: queueArn, BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'], Enabled: true
  }));
}

const ROUTES = [
  ['/api/health', 'auth'],
  ['/api/auth/{proxy+}', 'auth'],
  ['/api/staff', 'events'],
  ['/api/staff/{proxy+}', 'events'],
  ['/api/events', 'events'],
  ['/api/events/{eventId}', 'events'],
  ['/api/events/{eventId}/{proxy+}', 'events'],
  ['/api/invitations/{token}/plus-one-requests', 'events'],
  ['/api/invitations/{token}', 'rsvp'],
  ['/api/invitations/{token}/rsvp', 'rsvp'],
  ['/api/events/{eventId}/rsvps', 'rsvp'],
  ['/api/events/{eventId}/rsvps/{proxy+}', 'rsvp'],
  ['/api/events/{eventId}/waitlist', 'rsvp'],
  ['/api/events/{eventId}/capacity', 'rsvp'],
  ['/api/events/{eventId}/door-list', 'checkin'],
  ['/api/events/{eventId}/check-ins', 'checkin'],
  ['/api/events/{eventId}/check-ins/{proxy+}', 'checkin'],
  ['/api/events/{eventId}/attendance/{proxy+}', 'checkin']
];

async function deployApi(fnArns) {
  const name = `${P}-api`;
  const { items = [] } = await apigw.send(new GetRestApisCommand({ limit: 500 }));
  let api = items.find((a) => a.name === name);
  if (!api) api = await apigw.send(new CreateRestApiCommand({ name, description: 'Event Manager API', endpointConfiguration: { types: ['REGIONAL'] } }));
  const restApiId = api.id;

  const { items: resources = [] } = await apigw.send(new GetResourcesCommand({ restApiId, limit: 500 }));
  const byPath = new Map(resources.map((r) => [r.path, r]));
  async function ensurePath(p) {
    if (byPath.has(p)) return byPath.get(p);
    const parentPath = p.slice(0, p.lastIndexOf('/')) || '/';
    const parent = await ensurePath(parentPath);
    const r = await apigw.send(new CreateResourceCommand({ restApiId, parentId: parent.id, pathPart: p.slice(p.lastIndexOf('/') + 1) }));
    byPath.set(p, r);
    return r;
  }

  for (const [p, svc] of ROUTES) {
    const r = await ensurePath(p);
    const fnArn = fnArns[svc];
    if (!(r.resourceMethods && r.resourceMethods.ANY)) {
      await apigw.send(new PutMethodCommand({ restApiId, resourceId: r.id, httpMethod: 'ANY', authorizationType: 'NONE' }));
    }
    await apigw.send(new PutIntegrationCommand({
      restApiId, resourceId: r.id, httpMethod: 'ANY', type: 'AWS_PROXY', integrationHttpMethod: 'POST',
      uri: `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${fnArn}/invocations`
    }));
  }
  await apigw.send(new CreateDeploymentCommand({ restApiId, stageName: STAGE, description: `deploy ${new Date().toISOString()}` }));
  const account = fnArns.auth.split(':')[4];
  for (const svc of ['auth', 'events', 'rsvp', 'checkin']) {
    await allow(`${P}-${svc}-fn`, 'apigateway-invoke', 'apigateway.amazonaws.com', `arn:aws:execute-api:${REGION}:${account}:${restApiId}/*/*/*`);
  }
  log(`api: ${name} (${restApiId}), stage ${STAGE}, ${ROUTES.length} routes`);
  return restApiId;
}

const NAMESPACE = 'EventManager/Security';
const SECURITY_METRICS = [
  ['FailedLogins', 'login_failed', ['auth']],
  ['LockedAccounts', 'login_locked', ['auth']],
  ['AccessDenied', 'access_denied', ['auth', 'events', 'rsvp', 'checkin']],
  ['Unauthenticated', 'auth_failed', ['auth', 'events', 'rsvp', 'checkin']],
  ['RateLimited', 'rate_limited', ['auth', 'events', 'rsvp']],
  ['TurnstileFailed', 'turnstile_failed', ['rsvp']]
];
const ALARMS = [
  ['em-repeated-failed-logins', 'FailedLogins', 5, '5 or more failed logins in 5 minutes: possible password guessing (Threat 1)'],
  ['em-repeated-access-denied', 'AccessDenied', 10, '10 or more 403 responses in 5 minutes: someone probing other users\' records (Threat 3)']
];

async function deployMonitoring(functionNames) {
  for (const fn of functionNames) {
    const logGroupName = `/aws/lambda/${fn}`;
    await cwLogs.send(new CreateLogGroupCommand({ logGroupName })).catch((e) => { if (e.name !== 'ResourceAlreadyExistsException') throw e; });
    await cwLogs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays: 14 })).catch(() => {});
  }
  for (const [metricName, eventType, fns] of SECURITY_METRICS) {
    for (const key of fns) {
      await cwLogs.send(new PutMetricFilterCommand({
        logGroupName: `/aws/lambda/${P}-${key}-fn`,
        filterName: `${P}-${eventType}`,
        filterPattern: `"${eventType}"`,
        metricTransformations: [{ metricName, metricNamespace: NAMESPACE, metricValue: '1', defaultValue: 0 }]
      }));
    }
  }
  const { TopicArn: alertTopic } = await sns.send(new CreateTopicCommand({ Name: `${P}-security-alerts` }));
  if (process.env.ALERT_EMAIL) {
    const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: alertTopic }));
    if (!Subscriptions.some((x) => x.Endpoint === process.env.ALERT_EMAIL)) {
      await sns.send(new SubscribeCommand({ TopicArn: alertTopic, Protocol: 'email', Endpoint: process.env.ALERT_EMAIL }));
    }
  }
  for (const [AlarmName, MetricName, Threshold, AlarmDescription] of ALARMS) {
    await cloudwatch.send(new PutMetricAlarmCommand({
      AlarmName, AlarmDescription, Namespace: NAMESPACE, MetricName,
      Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
      AlarmActions: [alertTopic]
    }));
  }
  log(`monitoring: ${SECURITY_METRICS.length} security metrics in ${NAMESPACE}, alarms ${ALARMS.map((a) => a[0]).join(', ')} -> ${P}-security-alerts`);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function deployFrontend(apiBaseUrl) {
  const Bucket = `${P}-frontend`;
  const base = path.join(ROOT, 'frontend');
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket }));
  if (Contents.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: Contents.map((o) => ({ Key: o.Key })) } }));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(base);
  for (const full of files) {
    const Key = path.relative(base, full).split(path.sep).join('/');
    let Body = fs.readFileSync(full);
    if (Key === 'shared/config.js') {
      Body = Buffer.from(Body.toString('utf8').replace(/API_BASE_URL:\s*'[^']*'/, `API_BASE_URL: '${apiBaseUrl}'`)
        .replace(/TURNSTILE_SITE_KEY:\s*'[^']*'/, `TURNSTILE_SITE_KEY: '${process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA'}'`));
    }
    await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: TYPES[path.extname(Key)] || 'application/octet-stream', CacheControl: 'no-cache' }));
  }
  await s3.send(new PutBucketWebsiteCommand({ Bucket, WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' }, ErrorDocument: { Key: 'index.html' } } }));
  await s3.send(new DeletePublicAccessBlockCommand({ Bucket })).catch(() => {});
  await s3.send(new PutBucketPolicyCommand({
    Bucket,
    Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadWebsite', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${Bucket}/*` }] })
  }));
  log(`frontend: ${files.length} files -> ${Bucket} (API_BASE_URL ${apiBaseUrl})`);
}

async function main() {
  const started = Date.now();
  log(`target ${ENDPOINT}, region ${REGION}, runtime ${RUNTIME}`);
  const localWeb = `http://${P}-frontend.s3-website-${REGION}.localhost:4566`;
  const publicWeb = (process.env.PUBLIC_WEB_URL || '').replace(/\/+$/, '');
  const publicApi = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  const webUrl = publicWeb || localWeb;
  const origins = [localWeb, publicWeb].filter(Boolean);

  const db = databaseForLambda();
  await deploySecrets(db);
  await deployBuckets(origins);
  const table = await deployTable();
  const msg = await deployMessaging();
  const code = await uploadCode();

  const env = {
    NODE_ENV: db.local ? 'development' : 'production',
    LOG_LEVEL: process.env.LAMBDA_LOG_LEVEL || 'info',
    AWS_ENDPOINT_URL: LAMBDA_AWS_ENDPOINT,
    S3_PUBLIC_ENDPOINT: publicApi ? new URL(publicApi).origin : 'http://localhost:4566',
    DB_URL_SECRET_NAME: `${P}/db-url`,
    JWT_SECRET_NAME: `${P}/jwt-secret`,
    TURNSTILE_SECRET_NAME: `${P}/turnstile-secret`,
    BREVO_API_KEY_SECRET_NAME: `${P}/brevo-api-key`,
    GEOAPIFY_API_KEY_SECRET_NAME: `${P}/geoapify-api-key`,
    IMPORTS_BUCKET: `${P}-guest-imports`,
    REPORTS_BUCKET: `${P}-reports`,
    REQUEST_GUARD_TABLE: table,
    DOMAIN_EVENTS_TOPIC_ARN: msg.TopicArn,
    NOTIFICATIONS_QUEUE_URL: msg.notifyQ.url,
    CORS_ORIGINS: origins.join(','),
    FRONTEND_BASE_URL: webUrl,
    BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL || '',
    BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME || 'Event Manager',
    DISPLAY_TIME_ZONE: process.env.DISPLAY_TIME_ZONE || 'Africa/Cairo',
    DB_POOL_MAX: '2',
    ...(db.local ? { DB_SSL: 'disable' } : {})
  };
  if (process.env.TURNSTILE_EXPECTED_HOSTNAME) env.TURNSTILE_EXPECTED_HOSTNAME = process.env.TURNSTILE_EXPECTED_HOSTNAME;
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];

  const FUNCTIONS = [
    { key: 'auth', name: `${P}-auth-fn`, handler: 'services/auth/lambdas/api.handler' },
    { key: 'events', name: `${P}-events-fn`, handler: 'services/events/lambdas/api.handler' },
    { key: 'rsvp', name: `${P}-rsvp-fn`, handler: 'services/rsvp/lambdas/api.handler' },
    { key: 'checkin', name: `${P}-checkin-fn`, handler: 'services/checkin/lambdas/api.handler' },
    { key: 'import', name: `${P}-import-fn`, handler: 'services/events/lambdas/importProcessor.handler', timeout: 120 },
    { key: 'scheduler', name: `${P}-scheduler-fn`, handler: 'services/events/lambdas/scheduler.handler', timeout: 120 },
    { key: 'notifier', name: `${P}-notifier-fn`, handler: 'services/events/lambdas/notifier.handler', timeout: 60 },
    { key: 'rsvpConsumer', name: `${P}-rsvp-consumer-fn`, handler: 'services/rsvp/lambdas/consumer.handler', timeout: 60 },
    { key: 'report', name: `${P}-report-fn`, handler: 'services/checkin/lambdas/reportGenerator.handler', timeout: 60 }
  ];
  const arns = {};
  for (const f of FUNCTIONS) {
    arns[f.key] = await deployFunction({ ...f, env }, code);
    log(`lambda: ${f.name}`);
  }

  await ensureSqsTrigger(arns.rsvpConsumer, msg.rsvpQ.arn);
  await ensureSqsTrigger(arns.report, msg.checkinQ.arn);
  await ensureSqsTrigger(arns.notifier, msg.notifyQ.arn);
  log('sqs triggers: rsvp-events -> rsvp-consumer, checkin-events -> report, notifications -> notifier');

  await allow(arns.import, 's3-imports', 's3.amazonaws.com', `arn:aws:s3:::${P}-guest-imports`);
  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: `${P}-guest-imports`,
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [{
        LambdaFunctionArn: arns.import, Events: ['s3:ObjectCreated:*'],
        Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'imports/' }, { Name: 'suffix', Value: '.csv' }] } }
      }]
    }
  }));
  log('s3 trigger: em-guest-imports/imports/*.csv -> import');

  const rule = await events.send(new PutRuleCommand({ Name: `${P}-scheduler-every-5-min`, ScheduleExpression: 'rate(5 minutes)', State: 'ENABLED' }));
  await allow(arns.scheduler, 'eventbridge-schedule', 'events.amazonaws.com', rule.RuleArn);
  await events.send(new PutTargetsCommand({ Rule: `${P}-scheduler-every-5-min`, Targets: [{ Id: 'scheduler', Arn: arns.scheduler }] }));
  log('schedule: rate(5 minutes) -> scheduler');

  await deployMonitoring(FUNCTIONS.map((f) => f.name));

  const apiId = await deployApi({ auth: arns.auth, events: arns.events, rsvp: arns.rsvp, checkin: arns.checkin });
  const apiBase = `${publicApi || ENDPOINT.replace(/\/+$/, '')}/restapis/${apiId}/${STAGE}/_user_request_`;
  await deployFrontend(apiBase);

  const summary = { website: webUrl, api: apiBase, health: `${apiBase}/api/health`, apiId };
  fs.writeFileSync(path.join(__dirname, 'deploy-output.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`\n  Website: ${summary.website}/\n  API:     ${summary.api}\n  Health:  ${summary.health}\n`);
}

main().catch((e) => {
  console.error(`[deploy] FAILED: ${e.name}: ${e.message}`);
  process.exit(1);
});
