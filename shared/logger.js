// shared/logger.js  Structured JSON logs -> stdout -> CloudWatch Logs on Lambda
// Never log passwords, JWTs, invitation tokens, emails, dietary notes or request bodies.  [Threat 8]
// Requests are logged by ROUTE PATTERN (/api/invitations/:token), never by the real URL.
// Two layers of protection:
//   1. a field whose KEY looks sensitive is replaced with '[redacted]';
//   2. string VALUES are scrubbed of email addresses, JWTs and Bearer tokens.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /pass|token|secret|authorization|cookie|email|dietary|api[-_]?key|jwt|check_in_code|setup_link|link|url|signature|turnstile/i;
const EMAIL_IN_TEXT = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[A-Za-z]{2,}/g;
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER_IN_TEXT = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_STRING = 1000;

const service = () => process.env.SERVICE_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME || 'local';
const threshold = () => LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function scrub(text) {
  let out = text.replace(JWT_IN_TEXT, '[jwt]').replace(BEARER_IN_TEXT, 'Bearer [redacted]').replace(EMAIL_IN_TEXT, '[email]');
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}...[truncated]`;
  return out;
}

// Errors: name, message, code and a short stack only. pg's err.detail can hold row values
// (an email in a unique violation), so it is never logged.
function serializeError(error) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const out = {
    name: error.name,
    message: typeof error.message === 'string' ? scrub(error.message) : undefined,
    code: error.code,
    status: error.status || error.statusCode,
    constraint: error.constraint
  };
  if (typeof error.stack === 'string') out.stack = scrub(error.stack.split('\n').slice(0, 8).join('\n'));
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function write(level, msg, fields = {}, base = {}) {
  if (LEVELS[level] < threshold()) return;
  let text;
  try {
    text = JSON.stringify({ level, msg, service: service(), time: new Date().toISOString(), ...redact(base), ...redact(fields) });
  } catch {
    text = JSON.stringify({ level, msg, service: service(), time: new Date().toISOString(), note: 'unserializable fields' });
  }
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

function createLogger(base = {}) {
  return {
    debug: (msg, fields) => write('debug', msg, fields, base),
    info: (msg, fields) => write('info', msg, fields, base),
    warn: (msg, fields) => write('warn', msg, fields, base),
    error: (msg, fields) => write('error', msg, fields, base),
    // Security events get a fixed "event" key so a CloudWatch metric filter can count them.
    security: (event, fields) => write('warn', 'security', { event, ...fields }, base),
    // child({ consumer: 'rsvp' }) adds fixed fields to every line (background functions)
    child: (more) => createLogger({ ...base, ...more }),
    sanitize: redact,
    serializeError
  };
}

const logger = createLogger();

function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : '(unmatched)';
    write(res.statusCode >= 500 ? 'error' : 'info', 'request', {
      requestId: req.id,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
      userId: req.user ? req.user.user_id : undefined,
      role: req.user ? req.user.role : undefined
    });
  });
  next();
}

module.exports = { logger, requestLogger, redact, serializeError };
