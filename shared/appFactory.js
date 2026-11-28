const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { requestLogger, logger } = require('./logger');
const { AppError, sendError, routePattern } = require('./errors');

function corsOrigins() {
  return (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((o) => o.trim()).filter(Boolean);
}

function clientIpFrom(req) {
  const rc = req.lambdaEvent && req.lambdaEvent.requestContext;
  const ip = (rc && rc.identity && rc.identity.sourceIp) || (rc && rc.http && rc.http.sourceIp) || (req.socket && req.socket.remoteAddress);
  return ip ? String(ip).replace(/^::ffff:/, '') : null;
}

function parseLambdaBody(req, limitBytes) {
  const raw = req.body;
  req.body = undefined;
  if (!raw.length || !req.is('application/json')) return undefined;
  if (raw.length > limitBytes) return Object.assign(new Error('too large'), { type: 'entity.too.large', status: 413 });
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    req.body = parsed;
    return undefined;
  } catch {
    return Object.assign(new Error('bad json'), { type: 'entity.parse.failed', status: 400 });
  }
}

async function auditDenied(req, error) {
  if (error.audited || (error.status !== 401 && error.status !== 403)) return;
  const { auditFromRequest } = require('./audit');
  const { AUDIT_EVENT_TYPES } = require('./constants');
  await auditFromRequest(req, error.status === 401 ? AUDIT_EVENT_TYPES.AUTH_FAILED : AUDIT_EVENT_TYPES.ACCESS_DENIED, {
    detail: { route: routePattern(req), method: req.method, code: error.code, ...(error.auditDetail || {}) }
  });
}

function createApp(routers, { largeBodyPaths = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    const rc = req.lambdaEvent && req.lambdaEvent.requestContext;
    req.id = (req.lambdaContext && req.lambdaContext.awsRequestId) || (rc && rc.requestId) || crypto.randomUUID();
    req.clientIp = clientIpFrom(req);
    req.valid = { body: {}, query: {}, params: {} };
    res.set('X-Request-Id', req.id);
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(requestLogger);
  app.use(helmet());
  app.use(cors({
    origin: corsOrigins(),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Turnstile-Token'],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600
  }));

  const smallJson = express.json({ limit: '10kb' });
  const largeJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => {
    const large = largeBodyPaths.some((re) => re.test(req.path));
    if (Buffer.isBuffer(req.body)) return next(parseLambdaBody(req, large ? 64 * 1024 : 10 * 1024));
    return (large ? largeJson : smallJson)(req, res, next);
  });

  app.use((req, res, next) => {
    const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && hasBody && !req.is('application/json')) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'));
    }
    if (req.body === undefined) req.body = {};
    return next();
  });

  for (const router of routers) app.use(router);

  app.use((req, res) => res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' } }));

  app.use(async (error, req, res, next) => {
    if (error instanceof AppError) {
      try {
        await auditDenied(req, error);
      } catch (auditError) {
        logger.error('audit write failed', { requestId: req.id, error: auditError });
      }
      if (error.status >= 500) logger.error('request failed', { requestId: req.id, route: routePattern(req), error });
      return sendError(res, error);
    }
    if (error.type === 'entity.parse.failed') {
      return sendError(res, new AppError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.'));
    }
    if (error.type === 'entity.too.large') {
      return sendError(res, new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
    }
    if (typeof error.type === 'string' && error.status && error.status < 500) {
      return sendError(res, new AppError(400, 'VALIDATION_ERROR', 'Request body could not be read.'));
    }
    logger.error('unhandled error', { requestId: req.id, route: routePattern(req), error });
    return sendError(res, new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.'));
  });

  return app;
}

module.exports = { createApp, clientIpFrom };
