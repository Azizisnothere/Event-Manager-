// shared/errors.js  One error shape everywhere: { "error": { "code", "message" } }  [Lab 3 Part 4]
class AppError extends Error {
  // opts: { headers, audited, auditDetail }
  //   headers     extra response headers (Retry-After on 429)
  //   audited     true when the route already wrote its own audit_log entry
  //   auditDetail extra, non-sensitive fields for the audit_log entry of a 401/403
  constructor(status, code, message, details, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // optional, safe-to-show detail; never secrets
    this.headers = opts.headers;
    this.audited = Boolean(opts.audited);
    this.auditDetail = opts.auditDetail;
  }
}

const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
// details: [{ field, message }] from shared/validation.js
const validationError = (details) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', details);
const unauthenticated = (message = 'Authentication required.', opts = {}) =>
  new AppError(401, 'UNAUTHENTICATED', message, undefined, opts);
const forbidden = (message = 'You do not have permission to do this.', opts = {}) =>
  new AppError(403, opts.code || 'FORBIDDEN', message, undefined, opts);
const notFound = (message = 'Not found.', code = 'NOT_FOUND') => new AppError(404, code, message);
const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details);
const unprocessable = (message, code = 'UNPROCESSABLE', details) => new AppError(422, code, message, details);
const tooManyRequests = (message = 'Too many requests. Please wait and try again.', retryAfterSeconds = 60, opts = {}) =>
  new AppError(429, 'RATE_LIMITED', message, undefined, {
    ...opts,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds || 60))) }
  });
const serviceUnavailable = (message = 'Service temporarily unavailable.') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);

function sendError(res, error) {
  if (error.headers) res.set(error.headers);
  const body = { error: { code: error.code, message: error.message } };
  if (error.details) body.error.details = error.details;
  return res.status(error.status).json(body);
}

// The route PATTERN (/api/invitations/:token), never the real URL, so tokens are not logged.
function routePattern(req) {
  return req.route && req.route.path ? `${req.baseUrl || ''}${req.route.path}` : '(unmatched)';
}

module.exports = {
  AppError,
  badRequest,
  validationError,
  unauthenticated,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  serviceUnavailable,
  sendError,
  routePattern
};
