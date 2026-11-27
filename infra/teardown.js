// infra/teardown.js  Removes everything infra/deploy.js created (design 6: "resources are removed after the
// assessment with infra/teardown"). Neon is not touched.   npm run teardown
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });

const { SecretsManagerClient, DeleteSecretCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, ListTopicsCommand, DeleteTopicCommand } = require('@aws-sdk/client-sns');
const { SQSClient, GetQueueUrlCommand, DeleteQueueCommand } = require('@aws-sdk/client-sqs');
const { IAMClient, DeleteRolePolicyCommand, DeleteRoleCommand } = require('@aws-sdk/client-iam');
const { LambdaClient, DeleteFunctionCommand, ListEventSourceMappingsCommand, DeleteEventSourceMappingCommand } = require('@aws-sdk/client-lambda');
const { APIGatewayClient, GetRestApisCommand, DeleteRestApiCommand } = require('@aws-sdk/client-api-gateway');
const { EventBridgeClient, RemoveTargetsCommand, DeleteRuleCommand } = require('@aws-sdk/client-eventbridge');
const { CloudWatchLogsClient, DeleteLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, DeleteAlarmsCommand } = require('@aws-sdk/client-cloudwatch');

const opts = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.DEPLOY_AWS_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://localhost:4566',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test' }
};
const P = 'em';
const FUNCTIONS = ['auth', 'events', 'rsvp', 'checkin', 'import', 'scheduler', 'notifier', 'rsvp-consumer', 'report'].map((f) => `${P}-${f}-fn`);
const quiet = (promise) => promise.catch(() => {});

async function main() {
  const lambda = new LambdaClient(opts);
  const iam = new IAMClient(opts);
  const s3 = new S3Client(opts);
  const sqs = new SQSClient(opts);
  const sns = new SNSClient(opts);
  const apigw = new APIGatewayClient(opts);
  const events = new EventBridgeClient(opts);

  await quiet(new CloudWatchClient(opts).send(new DeleteAlarmsCommand({ AlarmNames: ['em-repeated-failed-logins', 'em-repeated-access-denied'] })));
  for (const fn of FUNCTIONS) await quiet(new CloudWatchLogsClient(opts).send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${fn}` })));

  await quiet(events.send(new RemoveTargetsCommand({ Rule: `${P}-scheduler-every-5-min`, Ids: ['scheduler'] })));
  await quiet(events.send(new DeleteRuleCommand({ Name: `${P}-scheduler-every-5-min` })));

  const { items = [] } = await apigw.send(new GetRestApisCommand({ limit: 500 })).catch(() => ({}));
  for (const a of items.filter((x) => x.name === `${P}-api`)) await quiet(apigw.send(new DeleteRestApiCommand({ restApiId: a.id })));

  for (const fn of FUNCTIONS) {
    const { EventSourceMappings = [] } = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: fn })).catch(() => ({}));
    for (const m of EventSourceMappings) await quiet(lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID })));
    await quiet(lambda.send(new DeleteFunctionCommand({ FunctionName: fn })));
    await quiet(iam.send(new DeleteRolePolicyCommand({ RoleName: `${fn}-role`, PolicyName: `${fn}-policy` })));
    await quiet(iam.send(new DeleteRoleCommand({ RoleName: `${fn}-role` })));
  }

  for (const q of ['rsvp-events', 'checkin-events', 'notifications'].flatMap((n) => [`${P}-${n}`, `${P}-${n}-dlq`])) {
    const out = await sqs.send(new GetQueueUrlCommand({ QueueName: q })).catch(() => null);
    if (out) await quiet(sqs.send(new DeleteQueueCommand({ QueueUrl: out.QueueUrl })));
  }
  const { Topics = [] } = await sns.send(new ListTopicsCommand({})).catch(() => ({}));
  for (const t of Topics.filter((x) => x.TopicArn.endsWith(`:${P}-domain-events`) || x.TopicArn.endsWith(`:${P}-security-alerts`))) await quiet(sns.send(new DeleteTopicCommand({ TopicArn: t.TopicArn })));

  await quiet(new DynamoDBClient(opts).send(new DeleteTableCommand({ TableName: `${P}-request-guard` })));

  for (const Bucket of [`${P}-frontend`, `${P}-guest-imports`, `${P}-reports`, `${P}-deployments`]) {
    for (;;) {
      const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket })).catch(() => ({}));
      if (!Contents.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: Contents.map((o) => ({ Key: o.Key })) } }));
    }
    await quiet(s3.send(new DeleteBucketCommand({ Bucket })));
  }

  const smc = new SecretsManagerClient(opts);
  for (const s of ['db-url', 'jwt-secret', 'turnstile-secret', 'brevo-api-key', 'geoapify-api-key']) {
    await quiet(smc.send(new DeleteSecretCommand({ SecretId: `${P}/${s}`, ForceDeleteWithoutRecovery: true })));
  }
  console.log('[teardown] done: Lambdas, API, schedule, queues, topic, table, buckets, secrets and roles removed');
}

main().catch((e) => {
  console.error(`[teardown] FAILED: ${e.name}: ${e.message}`);
  process.exit(1);
});
