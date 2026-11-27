'use strict';
/**
 * Access token issuing (Section 6.2): HS256, 1-hour expiry, payload { user_id, role } only.
 * Verification lives in shared/middleware/authenticate.js (algorithms: ['HS256'] only, Threat 4).
 */
const jwt = require('jsonwebtoken');
const { secrets, constants } = require('../../../shared');

async function signAccessToken({ user_id, role }) {
  const secret = await secrets.getSecret('jwtSecret');
  return jwt.sign({ user_id, role }, secret, {
    algorithm: constants.JWT_ALGORITHM,
    expiresIn: constants.JWT_EXPIRES_IN_SECONDS,
  });
}

module.exports = { signAccessToken };
