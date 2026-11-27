'use strict';
/**
 * Middleware step 3b: guest authentication by personal invitation token (Threat 2).
 * The raw token from the URL is hashed with SHA-256 and looked up; only the hash is stored.
 * Guests never use numeric or UUID ids (Section 6.2 "Authorization").
 * Unknown, malformed, superseded (after a resend) or revoked tokens -> 404.
 * The token itself is never logged (route patterns only).
 */
const db = require('../db');
const { notFound } = require('../errors');
const { isTokenFormat, hashToken } = require('../crypto');

function invitationNotFound() {
  return notFound('This invitation link is not valid.', 'INVITATION_NOT_FOUND');
}

/**
 * @param {{ param?: string }} [opts] route parameter that holds the token (default "token")
 */
function authenticateInvitation(opts = {}) {
  const param = opts.param || 'token';
  return async (req, res, next) => {
    const raw = req.params[param];
    if (!isTokenFormat(raw)) throw invitationNotFound();
    const tokenHash = hashToken(raw);
    const { rows } = await db.query(
      `SELECT i.invitation_id, i.event_id, i.guest_name, i.guest_email, i.category,
              i.plus_one_allowance, i.status
         FROM invitations i
        WHERE i.token_hash = $1
          AND i.status <> 'revoked'`,
      [tokenHash],
    );
    if (!rows.length) throw invitationNotFound();
    req.invitation = rows[0];
    req.tokenHash = tokenHash; // used as the per-token rate-limit key; the raw token is not kept
    return next();
  };
}

module.exports = { authenticateInvitation, invitationNotFound };
