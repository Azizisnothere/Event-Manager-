'use strict';
const db = require('../db');
const { notFound } = require('../errors');
const { isTokenFormat, hashToken } = require('../crypto');

function invitationNotFound() {
  return notFound('This invitation link is not valid.', 'INVITATION_NOT_FOUND');
}

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
    req.tokenHash = tokenHash;
    return next();
  };
}

module.exports = { authenticateInvitation, invitationNotFound };
