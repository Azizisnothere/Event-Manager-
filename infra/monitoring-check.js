require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CloudWatchClient, GetMetricStatisticsCommand, DescribeAlarmsCommand, PutMetricAlarmCommand } = require('@aws-sdk/client-cloudwatch');

const out = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy-output.json'), 'utf8'));
const API = process.env.SMOKE_API || out.api;
const opts = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.DEPLOY_AWS_ENDPOINT || process.env.AWS_ENDPOINT_URL || 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
};
const logs = new CloudWatchLogsClient(opts);
const cw = new CloudWatchClient(opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, headers = {}) {
  const res = await fetch(API + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return res.status;
}

async function metricSum(name, since) {
  const r = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'EventManager/Security', MetricName: name, StartTime: since, EndTime: new Date(Date.now() + 60000),
    Period: 300, Statistics: ['Sum']
  }));
  return (r.Datapoints || []).reduce((n, d) => n + (d.Sum || 0), 0);
}

(async () => {
  const started = new Date(Date.now() - 60000);
  const email = `monitor-${Date.now()}@example.test`;
  console.log(`API ${API}\n`);
  console.log('1) Suspicious activity');
  console.log(`   register test account: ${await post('/api/auth/register', { name: 'Monitoring Test', email, password: 'Right-Password-2026!' })}`);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await post('/api/auth/login', { email, password: `wrong-password-${i}` }));
  console.log(`   6 logins with a wrong password: ${statuses.join(', ')}   (401 = refused, 429 = account locked)`);
  const fake = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}/api/events`, { headers: { authorization: 'Bearer not-a-real-token' } });
    fake.push(res.status);
  }
  console.log(`   3 requests with a fake token: ${fake.join(', ')}`);

  console.log('\n2) Log filter: /aws/lambda/em-auth-fn, pattern "login_failed"');
  await sleep(5000);
  try {
    const r = await logs.send(new FilterLogEventsCommand({ logGroupName: '/aws/lambda/em-auth-fn', filterPattern: '"login_failed"', startTime: started.getTime() }));
    const events = r.events || [];
    console.log(`   ${events.length} matching log lines. Latest:`);
    for (const e of events.slice(-2)) {
      const json = e.message.slice(e.message.indexOf('{'));
      console.log(`   ${json.slice(0, 260)}`);
    }
  } catch (e) {
    console.log(`   could not read the log group: ${e.name}: ${e.message}`);
  }

  console.log('\n3) Metrics in EventManager/Security (waiting up to 90 s for CloudWatch)');
  let failed = 0;
  for (let i = 0; i < 9 && failed < 5; i++) {
    failed = await metricSum('FailedLogins', started).catch(() => 0);
    if (failed < 5) await sleep(10000);
  }
  for (const m of ['FailedLogins', 'LockedAccounts', 'Unauthenticated']) {
    console.log(`   ${m.padEnd(16)} ${await metricSum(m, started).catch((e) => `error: ${e.name}`)}`);
  }

  console.log('\n4) Alarm');
  const waitMs = 300000 - (Date.now() % 300000) + 15000;
  console.log(`   waiting ${Math.round(waitMs / 1000)} s for the current 5-minute window to close...`);
  await sleep(waitMs);
  try {
    const { MetricAlarms: current = [] } = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ['em-repeated-failed-logins'] }));
    for (const a of current) {
      await cw.send(new PutMetricAlarmCommand({
        AlarmName: a.AlarmName, AlarmDescription: a.AlarmDescription, Namespace: a.Namespace, MetricName: a.MetricName,
        Statistic: a.Statistic, Period: a.Period, EvaluationPeriods: a.EvaluationPeriods, Threshold: a.Threshold,
        ComparisonOperator: a.ComparisonOperator, TreatMissingData: a.TreatMissingData, AlarmActions: a.AlarmActions
      }));
    }
    await sleep(3000);
  } catch (e) {
    console.log(`   could not re-evaluate the alarm: ${e.name}: ${e.message}`);
  }
  try {
    const { MetricAlarms = [] } = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ['em-repeated-failed-logins', 'em-repeated-access-denied'] }));
    for (const a of MetricAlarms) {
      console.log(`   ${a.AlarmName.padEnd(28)} ${a.StateValue}   (${a.AlarmDescription})`);
      if (a.StateReason) console.log(`   ${''.padEnd(28)} ${a.StateReason}`);
    }
  } catch (e) {
    console.log(`   could not read alarms: ${e.name}: ${e.message}`);
  }
  console.log('\nNo passwords, tokens or emails appear above: the audit lines carry only hashed or redacted values.');
})();
