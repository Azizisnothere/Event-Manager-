const fs = require('fs');
const path = require('path');

const out = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy-output.json'), 'utf8'));
const API = process.env.SMOKE_API || out.api;
const results = [];

async function call(name, fn, method, url, body, token, expect) {
  let status;
  let json = null;
  try {
    const res = await fetch(API + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch (e) {
    status = `network error: ${e.message}`;
  }
  const ok = Array.isArray(expect) ? expect.includes(status) : status === expect;
  results.push({ ok, fn, name, status, expect });
  return json;
}

(async () => {
  const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const email = `smoke-${Date.now()}@example.test`;
  const password = 'Smoke-Test-Password-2026!';

  await call('health (db + secrets)', 'auth', 'GET', '/api/health', null, null, 200);
  await call('register organizer', 'auth', 'POST', '/api/auth/register', { name: 'Smoke Test', email, password }, null, 201);
  const login = await call('login', 'auth', 'POST', '/api/auth/login', { email, password }, null, 200);
  const token = login && login.token;
  await call('me', 'auth', 'GET', '/api/auth/me', null, token, 200);

  const ev = await call('create event (Geoapify, secrets)', 'events', 'POST', '/api/events', {
    title: 'Smoke test', venue_address: 'Tahrir Square, Cairo, Egypt',
    start_time: at(48), end_time: at(50), rsvp_deadline: at(24), capacity: 5, invite_limit: 10
  }, token, 201);
  const id = ev && ev.event && ev.event.event_id;
  await call('add guest', 'events', 'POST', `/api/events/${id}/invitations`, { guests: [{ guest_name: 'Guest', guest_email: 'guest@example.test', plus_one_allowance: 0 }] }, token, 201);
  await call('pasted CSV import', 'events', 'POST', `/api/events/${id}/invitations/bulk`, { csv: 'guest_name,guest_email\nCsv Guest,csv@example.test\n' }, token, 201);
  await call('S3 upload link (presigned PUT)', 'events', 'POST', `/api/events/${id}/invitations/imports`, {}, token, 201);
  await call('staff list', 'events', 'GET', '/api/staff', null, token, 200);
  await call('RSVP list', 'rsvp', 'GET', `/api/events/${id}/rsvps`, null, token, 200);
  await call('waitlist', 'rsvp', 'GET', `/api/events/${id}/waitlist`, null, token, 200);
  await call('guest link with bad token', 'rsvp', 'GET', '/api/invitations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null, null, 404);
  await call('live attendance', 'checkin', 'GET', `/api/events/${id}/attendance/live`, null, token, 200);
  await call('check-in list', 'checkin', 'GET', `/api/events/${id}/check-ins`, null, token, 200);
  await call('cancel event (SNS publish)', 'events', 'PATCH', `/api/events/${id}/status`, { status: 'cancelled' }, token, 200);
  await call('no token -> 401', 'events', 'GET', '/api/events', null, null, 401);

  console.log(`API ${API}\n`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.fn.padEnd(8)} ${r.name.padEnd(36)} got ${r.status}${r.ok ? '' : `, expected ${r.expect}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
