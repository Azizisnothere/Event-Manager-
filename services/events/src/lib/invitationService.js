'use strict';
/**
 * Guest-list rules shared by manual entry, CSV import, publishing and resending.
 *  - Duplicate emails within an event are skipped and reported; (event_id, lower(email)) is unique.
 *  - plus_one_allowance is 0..3 (validator + DB CHECK).
 *  - Total invited headcount = sum(1 + allowance) over non-revoked invitations <= invite_limit.
 *  - Tokens: 256-bit random, only the SHA-256 hash is stored; the raw token goes only into
 *    the email job (Threat 2). A token is issued when the invitation is emailed, and a resend
 *    issues a new one so the previous link stops working (A9).
 * Callers hold the event row lock (SELECT ... FOR UPDATE) for the whole transaction, so the
 * headcount check cannot race with another insert.
 */
const { errors, crypto: emCrypto, config, constants, utils } = require('../../../../shared');

const T = constants.EMAIL_TEMPLATES;

async function invitedHeadcount(client, eventId) {
  const { rows } = await client.query(
    `SELECT COALESCE(sum(1 + plus_one_allowance), 0)::int AS headcount
       FROM invitations
      WHERE event_id = $1 AND status <> 'revoked'`,
    [eventId],
  );
  return rows[0].headcount;
}

/**
 * Adds guests to a locked event.
 * @param {import('pg').PoolClient} client transaction client holding the event row lock
 * @param {object} event locked event row
 * @param {Array<{ guest_name: string, guest_email: string, plus_one_allowance: number, category?: string|null, line?: number }>} guests
 * @param {{ mode: 'all_or_nothing'|'partial' }} opts
 *   all_or_nothing (manual entry): exceeding invite_limit rejects the whole request with 409.
 *   partial (CSV import): rows that would exceed the limit are reported as row errors.
 */
async function addGuests(client, event, guests, { mode }) {
  const skipped = [];
  const rowErrors = [];

  // 1. Duplicates inside the request itself.
  const seen = new Set();
  const unique = [];
  for (const g of guests) {
    const key = emCrypto.normalizeEmail(g.guest_email);
    if (seen.has(key)) {
      skipped.push({ line: g.line, guest_email: g.guest_email, reason: 'duplicate_in_request' });
      continue;
    }
    seen.add(key);
    unique.push({ ...g, email_key: key });
  }

  // 2. Duplicates against the existing guest list (including revoked invitations).
  const existing = new Map();
  if (unique.length) {
    const { rows } = await client.query(
      `SELECT lower(guest_email) AS email_key, status
         FROM invitations
        WHERE event_id = $1 AND lower(guest_email) = ANY($2::text[])`,
      [event.event_id, unique.map((g) => g.email_key)],
    );
    rows.forEach((r) => existing.set(r.email_key, r.status));
  }
  let candidates = [];
  for (const g of unique) {
    if (existing.has(g.email_key)) {
      skipped.push({
        line: g.line,
        guest_email: g.guest_email,
        reason: existing.get(g.email_key) === 'revoked' ? 'previously_revoked' : 'already_invited',
      });
    } else {
      candidates.push(g);
    }
  }

  // 3. Invite limit on total invited headcount.
  const current = await invitedHeadcount(client, event.event_id);
  if (mode === 'all_or_nothing') {
    const requested = candidates.reduce((sum, g) => sum + 1 + g.plus_one_allowance, 0);
    if (current + requested > event.invite_limit) {
      throw errors.conflict('Adding these guests would exceed the invite limit.', 'INVITE_LIMIT_EXCEEDED', {
        invite_limit: event.invite_limit,
        invited_headcount: current,
        requested_headcount: requested,
      });
    }
  } else {
    let running = current;
    const fitting = [];
    for (const g of candidates) {
      const need = 1 + g.plus_one_allowance;
      if (running + need > event.invite_limit) {
        rowErrors.push({ line: g.line, errors: ['invite limit reached'] });
      } else {
        running += need;
        fitting.push(g);
      }
    }
    candidates = fitting;
  }

  // 4. Insert (parameterized arrays; ON CONFLICT covers a concurrent insert of the same email).
  let added = [];
  if (candidates.length) {
    const { rows } = await client.query(
      `INSERT INTO invitations (event_id, guest_name, guest_email, plus_one_allowance, category)
       SELECT $1, g.guest_name, g.guest_email, g.plus_one_allowance, g.category
         FROM unnest($2::text[], $3::text[], $4::smallint[], $5::text[])
              AS g(guest_name, guest_email, plus_one_allowance, category)
       ON CONFLICT DO NOTHING
       RETURNING invitation_id, guest_name, guest_email, plus_one_allowance, category, status`,
      [
        event.event_id,
        candidates.map((g) => g.guest_name),
        candidates.map((g) => g.guest_email),
        candidates.map((g) => g.plus_one_allowance),
        candidates.map((g) => (g.category === undefined || g.category === '' ? null : g.category)),
      ],
    );
    added = rows;
    if (rows.length !== candidates.length) {
      const insertedKeys = new Set(rows.map((r) => emCrypto.normalizeEmail(r.guest_email)));
      candidates
        .filter((g) => !insertedKeys.has(g.email_key))
        .forEach((g) => skipped.push({ line: g.line, guest_email: g.guest_email, reason: 'already_invited' }));
    }
  }

  return {
    added,
    skipped,
    rowErrors,
    invitedHeadcount: current + added.reduce((s, r) => s + 1 + r.plus_one_allowance, 0),
  };
}

/**
 * Issues a fresh token for each invitation (publish, add-after-publish, resend).
 * Returns the rows plus raw_token for building the email; the raw token is not stored.
 */
async function issueTokens(client, invitationIds) {
  if (!invitationIds.length) return [];
  const tokens = invitationIds.map(() => emCrypto.generateToken()); // 256-bit (Threat 2)
  const { rows } = await client.query(
    `UPDATE invitations AS i
        SET token_hash = v.token_hash,
            status = CASE WHEN i.status = 'pending' THEN 'sent' ELSE i.status END,
            last_sent_at = now()
       FROM unnest($1::uuid[], $2::text[]) AS v(invitation_id, token_hash)
      WHERE i.invitation_id = v.invitation_id AND i.status <> 'revoked'
      RETURNING i.invitation_id, i.guest_name, i.guest_email, i.plus_one_allowance`,
    [invitationIds, tokens.map((t) => emCrypto.hashToken(t))],
  );
  const rawById = new Map(invitationIds.map((id, i) => [id, tokens[i]]));
  return rows.map((r) => ({ ...r, raw_token: rawById.get(r.invitation_id) }));
}

function frontendBaseUrl() {
  const base = config.frontendBaseUrl;
  if (base) return base;
  if (config.isProduction) throw new Error('FRONTEND_BASE_URL must be set in production.');
  return 'http://localhost:8080';
}

/** Guest link: the token travels in the URL fragment so it is not sent to S3 logs or in Referer (A36). */
function invitationUrl(rawToken) {
  return `${frontendBaseUrl()}/guest/invitation.html#t=${rawToken}`;
}

function staffSetupUrl(rawToken) {
  return `${frontendBaseUrl()}/staff/setup.html#t=${rawToken}`;
}

async function organizerName(client, organizerId) {
  const { rows } = await client.query('SELECT name FROM users WHERE user_id = $1', [organizerId]);
  return rows.length ? rows[0].name : null;
}

/** Email job inputs for issued invitations (queued after COMMIT). */
function invitationEmailJobs(event, hostName, issued, { resend = false } = {}) {
  return issued.map((inv) => ({
    template: T.INVITATION,
    to: { email: inv.guest_email, name: inv.guest_name },
    params: {
      guest_name: inv.guest_name,
      event_title: event.title,
      host_name: hostName,
      start_time: utils.toIso(event.start_time),
      end_time: utils.toIso(event.end_time),
      venue_address: event.venue_address,
      rsvp_deadline: utils.toIso(event.rsvp_deadline),
      plus_one_allowance: inv.plus_one_allowance,
      invitation_url: invitationUrl(inv.raw_token),
      resend,
    },
  }));
}

module.exports = {
  invitedHeadcount,
  addGuests,
  issueTokens,
  invitationUrl,
  staffSetupUrl,
  organizerName,
  invitationEmailJobs,
};
