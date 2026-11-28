'use strict';
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
