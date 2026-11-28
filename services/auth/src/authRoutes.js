'use strict';
const express = require('express');
const {
  db,
  errors,
  constants,
  crypto: emCrypto,
  requestGuard,
  audit,
  logger,
  middleware: { authenticate, validateRequest, rateLimit },
} = require('../../../shared');
const { passwordPolicyError, hashPassword, verifyPassword } = require('./passwords');
const { signAccessToken } = require('./jwt');

const { LIMITS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS, REGISTER_RATE_LIMIT_PER_IP, AUDIT_EVENT_TYPES } = constants;

const passwordRule = {
  type: 'string',
  required: true,
  trim: false,
  min: 1,
  max: LIMITS.PASSWORD_INPUT_MAX,
  custom: passwordPolicyError,
};

const schemas = {
  register: {
    body: {
      name: { type: 'string', required: true, max: LIMITS.NAME_MAX },
      email: { type: 'email', required: true },
      password: passwordRule,
    },
  },
  login: {
    body: {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, trim: false, min: 1, max: LIMITS.PASSWORD_INPUT_MAX },
    },
  },
  staffSetup: {
    body: {
      token: { type: 'string', required: true, min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ },
      password: passwordRule,
    },
  },
};

const ipKey = (req) => emCrypto.hashIp(req.clientIp);

function invalidCredentials() {
  return errors.unauthenticated('Email or password is incorrect.', { audited: true });
}

function authRoutes() {
  const router = express.Router();

  router.post(
    '/api/auth/register',
    rateLimit({ name: 'register-ip', ...REGISTER_RATE_LIMIT_PER_IP, key: ipKey }),
    validateRequest(schemas.register),
    async (req, res) => {
      const { name, email, password } = req.valid.body;
      const passwordHash = await hashPassword(password);
      let user;
      try {
        const { rows } = await db.query(
          `INSERT INTO users (name, email, password_hash, role, status)
           VALUES ($1, $2, $3, 'organizer', 'active')
           RETURNING user_id, name, email, role, status, created_at`,
          [name, email, passwordHash],
        );
        user = rows[0];
      } catch (err) {
        if (db.isUniqueViolation(err, 'users_email_lower_uq')) {
          throw errors.conflict('An account with this email already exists.', 'EMAIL_TAKEN');
        }
        throw err;
      }
      const token = await signAccessToken(user);
      res.status(201).json({
        user: { user_id: user.user_id, name: user.name, email: user.email, role: user.role },
        token,
        token_type: 'Bearer',
        expires_in: constants.JWT_EXPIRES_IN_SECONDS,
      });
    },
  );

  router.post(
    '/api/auth/login',
    validateRequest(schemas.login),
    async (req, res) => {
      const { email, password } = req.valid.body;
      const counterKey = `login#${emCrypto.emailKeyHash(email)}`;

      let failures;
      try {
        failures = await requestGuard.peek(counterKey);
      } catch (err) {
        logger.error('login_throttle_unavailable', { error: err });
        throw errors.serviceUnavailable('Login is temporarily unavailable. Please try again shortly.');
      }
      if (failures.count >= LOGIN_MAX_FAILURES) {
        await audit.auditFromRequest(req, AUDIT_EVENT_TYPES.LOGIN_LOCKED, { detail: { reason: 'too_many_failures' } });
        throw errors.tooManyRequests(undefined, Math.max(1, failures.expiresAt - Math.floor(Date.now() / 1000)), {
          audited: true,
        });
      }

      const { rows } = await db.query(
        `SELECT user_id, name, role, status, password_hash
           FROM users
          WHERE lower(email) = lower($1)`,
        [email],
      );
      const user = rows[0];
      const passwordOk = await verifyPassword(password, user ? user.password_hash : null);

      if (!user || !passwordOk || user.status !== 'active') {
        let count = 0;
        try {
          ({ count } = await requestGuard.increment(counterKey, LOGIN_WINDOW_SECONDS));
        } catch (err) {
          logger.error('login_throttle_unavailable', { error: err });
        }
        await audit.writeAudit({
          eventType: AUDIT_EVENT_TYPES.LOGIN_FAILED,
          actorType: user ? 'user' : 'anonymous',
          actorId: user ? user.user_id : null,
          ip: req.clientIp,
          detail: {
            request_id: req.id,
            reason: !user ? 'unknown_account' : !passwordOk ? 'bad_password' : `status_${user.status}`,
            failures_in_window: count,
          },
        });
        throw invalidCredentials();
      }

      await requestGuard.reset(counterKey).catch((err) => logger.warn('login_counter_reset_failed', { error: err }));
      const token = await signAccessToken(user);
      res.status(200).json({
        token,
        token_type: 'Bearer',
        expires_in: constants.JWT_EXPIRES_IN_SECONDS,
        user: { user_id: user.user_id, name: user.name, role: user.role },
      });
    },
  );

  router.post(
    '/api/auth/staff-setup',
    rateLimit({ name: 'staff-setup-ip', ...REGISTER_RATE_LIMIT_PER_IP, key: ipKey }),
    validateRequest(schemas.staffSetup),
    async (req, res) => {
      const { token, password } = req.valid.body;
      const tokenHash = emCrypto.hashToken(token);
      const notFound = () => errors.notFound('This setup link is invalid or has expired.', 'SETUP_TOKEN_INVALID');

      const { rows } = await db.query(
        `SELECT user_id, status, setup_expires_at
           FROM users
          WHERE setup_token_hash = $1 AND role = 'staff'`,
        [tokenHash],
      );
      const staff = rows[0];
      if (!staff) throw notFound();
      if (!staff.setup_expires_at || new Date(staff.setup_expires_at).getTime() <= Date.now()) throw notFound();
      if (staff.status !== 'pending_setup') {
        throw errors.conflict('This account has already been set up or is disabled.', 'ACCOUNT_NOT_PENDING');
      }

      const passwordHash = await hashPassword(password);
      const result = await db.query(
        `UPDATE users
            SET password_hash = $1, status = 'active', setup_token_hash = NULL, setup_expires_at = NULL
          WHERE user_id = $2 AND setup_token_hash = $3 AND status = 'pending_setup' AND setup_expires_at > now()`,
        [passwordHash, staff.user_id, tokenHash],
      );
      if (result.rowCount !== 1) throw notFound();
      res.status(200).json({ message: 'Password set. You can now log in.' });
    },
  );

  router.get(
    '/api/auth/me',
    authenticate(),
    validateRequest({}),
    async (req, res) => {
      const { rows } = await db.query(
        'SELECT user_id, name, email, role, status, created_at FROM users WHERE user_id = $1',
        [req.user.user_id],
      );
      if (!rows.length) throw errors.unauthenticated();
      res.json({ user: rows[0] });
    },
  );

  return router;
}

module.exports = { authRoutes };
