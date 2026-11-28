'use strict';
// tests/security/abdelaziz-security-tests.js
// Security tests for the Auth and RSVP services against the DEPLOYED API (API Gateway -> Lambda -> Neon).
// Usage:  node tests/security/abdelaziz-security-tests.js
// Reads the API address from infra/deploy-output.json ({"api": "..."}). Prints no secrets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'deploy-output.json'), 'utf8')).api;
const stamp = Date.now();
const results = [];

async function call(method, url, { body, token, headers = {} } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

function record(id, test, expected, actual, pass) {
  results.push({ id, test, expected, actual, result: pass ? 'PASS' : 'FAIL' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${test}\n      expected: ${expected}\n      actual:   ${actual}\n`);
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  console.log(`API ${API}\n`);

  // Two organizer accounts
  const pw = 'Correct-Horse-2026!';
  const emailA = `sec-a-${stamp}@example.test`;
  const emailB = `sec-b-${stamp}@example.test`;
  const regA = await call('POST', '/api/auth/register', { body: { name: 'Security Test A', email: emailA, password: pw } });
  const regB = await call('POST', '/api/auth/register', { body: { name: 'Security Test B', email: emailB, password: pw } });
  console.log(`setup: register A ${regA.status}, register B ${regB.status}\n`);
  const tokenA = regA.json && regA.json.token;
  const tokenB = regB.json && regB.json.token;

  // ST-02: unknown email vs known email + wrong password -> identical 401
  const known = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'Wrong-Password-1!' } });
  const unknown = await call('POST', '/api/auth/login', { body: { email: `nobody-${stamp}@example.test`, password: 'Wrong-Password-1!' } });
  const same = known.status === 401 && unknown.status === 401 && JSON.stringify(known.json) === JSON.stringify(unknown.json);
  record('ST-02', 'Login: unknown email vs known email + wrong password', 'both 401 with identical body',
    `${known.status} / ${unknown.status}, bodies ${same ? 'identical' : 'DIFFERENT'}: ${JSON.stringify(known.json)}`, same);

  // ST-04: forged / edited JWTs
  const [h, p] = (tokenA || 'x.x.x').split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const algNone = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...payload, role: 'organizer' })}.`;
  const wrongKey = (() => {
    const head = b64url({ alg: 'HS256', typ: 'JWT' });
    const body = b64url({ ...payload });
    const sig = crypto.createHmac('sha256', 'attacker-guessed-secret-attacker-guessed').update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  })();
  const edited = `${h}.${b64url({ ...payload, role: 'staff', sub: 'someone-else' })}.${(tokenA || 'x.x.x').split('.')[2]}`;
  const r1 = await call('GET', '/api/auth/me', { token: algNone });
  const r2 = await call('GET', '/api/auth/me', { token: wrongKey });
  const r3 = await call('GET', '/api/auth/me', { token: edited });
  const r0 = await call('GET', '/api/auth/me', { token: tokenA });
  record('ST-04', 'JWT with alg "none" / signed with a wrong key / payload edited after signing', '401 for all three (real token: 200)',
    `alg none ${r1.status}, wrong key ${r2.status}, edited payload ${r3.status}; real token ${r0.status}`,
    r1.status === 401 && r2.status === 401 && r3.status === 401 && r0.status === 200);

  // ST-06: random invitation token -> 404
  const fakeToken = crypto.randomBytes(32).toString('base64url');
  const r6 = await call('GET', `/api/invitations/${fakeToken}`);
  record('ST-06', 'Open an invitation with a random 256-bit token', '404', `${r6.status}`, r6.status === 404);

  // ST-11: organizer B reads organizer A's RSVP data
  const start = new Date(Date.now() + 7 * 864e5);
  const ev = await call('POST', '/api/events', {
    token: tokenA,
    body: {
      title: `Security test event ${stamp}`,
      venue_address: 'Tahrir Square, Cairo, Egypt',
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3 * 36e5).toISOString(),
      rsvp_deadline: new Date(start.getTime() - 864e5).toISOString(),
      capacity: 10,
      invite_limit: 50,
    },
  });
  const eventId = ev.json && (ev.json.event_id || (ev.json.event && ev.json.event.event_id));
  console.log(`setup: organizer A creates event -> ${ev.status}${eventId ? '' : ' ' + JSON.stringify(ev.json)}\n`);
  if (eventId) {
    const own = await call('GET', `/api/events/${eventId}/capacity`, { token: tokenA });
    const paths = ['rsvps', 'waitlist', 'capacity'];
    const other = [];
    for (const p2 of paths) other.push((await call('GET', `/api/events/${eventId}/${p2}`, { token: tokenB })).status);
    const ok = own.status === 200 && other.every((s) => s === 403 || s === 404);
    record('ST-11', "Organizer B reads organizer A's RSVPs, waitlist, capacity", '403 or 404 for B (A gets 200)',
      `A capacity ${own.status}; B rsvps/waitlist/capacity ${other.join(', ')}`, ok);
    const evB = await call('GET', `/api/events/${eventId}`, { token: tokenB });
    record('ST-15', "Organizer B reads organizer A's event", '403 or 404', `${evB.status}`, evB.status === 403 || evB.status === 404);
  } else {
    record('ST-11', "Organizer B reads organizer A's RSVP data", '403/404', 'NOT RUN: event could not be created (see setup line)', false);
  }

  // No-auth request to a protected route
  const noAuth = await call('GET', '/api/events');
  record('ST-04b', 'Protected route with no token', '401', `${noAuth.status}`, noAuth.status === 401);

  const passed = results.filter((r) => r.result === 'PASS').length;
  console.log(`${passed} passed, ${results.length - passed} failed  (${new Date().toISOString()})`);
})().catch((e) => { console.error('Test run failed:', e.message); process.exit(1); });
