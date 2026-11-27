// infra/iam-report.js  Lists the IAM permissions Floci DENIED in the last N minutes, per Lambda function.
// Use with IAM enforcement on (em-iam-test.bat / infra/README.md):  node infra/iam-report.js [minutes]
// Each line = something one of your policies in infra/iam/policies/ does not allow yet.
const { spawnSync } = require('child_process');

const minutes = Number(process.argv[2]) || 10;
// Floci may log to stdout or stderr, so read both.
const run = spawnSync('docker', ['logs', 'floci', '--since', `${minutes}m`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (run.error) {
  console.error(`Could not read the Floci log: ${run.error.message}`);
  process.exit(1);
}
const text = `${run.stdout || ''}\n${run.stderr || ''}`;
const lines = text.split(/\r?\n/);

// Floci prints "IAM enforcement DENY: akid=<key> action=<action> resource=<arn>"; the function shows up on the
// Lambda log line with the same access key's error just after it, so map each key to the nearest function name.
const denies = [];
const keyToFn = new Map();
let lastDenyKeys = [];
for (const line of lines) {
  const d = /IAM enforcement DENY: akid=(\S+) action=(\S+) resource=(\S+)/.exec(line);
  if (d) {
    denies.push({ key: d[1], action: d[2], resource: d[3] });
    lastDenyKeys.push(d[1]);
    continue;
  }
  const fn = /\[lambda:([^\]]+)\].*AccessDenied/.exec(line);
  if (fn && lastDenyKeys.length) {
    for (const k of lastDenyKeys) if (!keyToFn.has(k)) keyToFn.set(k, fn[1]);
    lastDenyKeys = [];
  }
}

if (!denies.length) {
  console.log(`No IAM denials in the last ${minutes} minutes. Every call was allowed.`);
  process.exit(0);
}
const byFn = new Map();
for (const d of denies) {
  const fn = keyToFn.get(d.key) || '(function not identified)';
  // Drop the random suffix AWS adds to secret ARNs so repeated denials group together.
  const resource = d.resource.includes(':secret:') ? d.resource.replace(/-[A-Za-z0-9]{6}$/, '*') : d.resource;
  if (!byFn.has(fn)) byFn.set(fn, new Set());
  byFn.get(fn).add(`${d.action}  on  ${resource}`);
}
console.log(`IAM denials in the last ${minutes} minutes (add these to the function's policy if it really needs them):\n`);
for (const [fn, set] of [...byFn].sort()) {
  console.log(fn);
  for (const s of [...set].sort()) console.log(`  - ${s}`);
}
