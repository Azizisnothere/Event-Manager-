'use strict';
/**
 * Server-side input validation (Section 6.2 "Input validation", Threat 5).
 * Declarative schemas check types, lengths, ranges, enums and formats, and
 * REJECT UNKNOWN FIELDS (also blocks __proto__ / constructor injection).
 *
 * Rule shape:
 *   { type: 'string'|'email'|'uuid'|'integer'|'number'|'boolean'|'datetime'|'enum'|'array'|'object',
 *     required?: boolean, nullable?: boolean, default?: any,
 *     min?, max?            // string length, number value, array length
 *     values?: string[]     // enum
 *     pattern?: RegExp, patternMessage?: string,
 *     multiline?: boolean   // allow \n \r \t in strings
 *     trim?: boolean        // default true for strings
 *     lowercase?: boolean,
 *     items?: rule          // array element rule
 *     schema?: object, minFields?: number  // nested object
 *     custom?: (value) => string|null }   // extra check, returns an error message
 *
 * Options: { coerce: true } converts query-string values ('5', 'true') to numbers/booleans.
 */
const { validationError } = require('./errors');
const { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, LIMITS } = require('./constants');

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO 8601 with an explicit offset, so a value can never be interpreted in the server's local time.
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_CHARS = /[\r\n\t]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  // querystring.parse (Express "simple" query parser) returns null-prototype objects.
  return proto === Object.prototype || proto === null;
}

function checkValue(rule, raw, path, errors, opts) {
  let value = raw;

  if (value === undefined) {
    if (rule.required) errors.push({ field: path, message: 'is required' });
    else if (Object.prototype.hasOwnProperty.call(rule, 'default')) return { set: true, value: rule.default };
    return { set: false };
  }
  if (value === null) {
    if (rule.nullable) return { set: true, value: null };
    errors.push({ field: path, message: 'must not be null' });
    return { set: false };
  }

  const fail = (message) => {
    errors.push({ field: path, message });
    return { set: false };
  };

  switch (rule.type) {
    case 'string':
    case 'email': {
      if (typeof value !== 'string') return fail('must be a string');
      if (rule.trim !== false) value = value.trim();
      if (CONTROL_CHARS.test(value)) return fail('contains invalid characters');
      if (!rule.multiline && LINE_CHARS.test(value)) return fail('must be a single line');
      if (rule.lowercase) value = value.toLowerCase();
      const min = rule.min !== undefined ? rule.min : rule.required ? 1 : 0;
      if (value.length < min) return fail(min === 1 ? 'must not be empty' : `must be at least ${min} characters`);
      const max = rule.type === 'email' ? Math.min(rule.max || LIMITS.EMAIL_MAX, LIMITS.EMAIL_MAX) : rule.max;
      if (max !== undefined && value.length > max) return fail(`must be at most ${max} characters`);
      if (rule.type === 'email' && !EMAIL_PATTERN.test(value)) return fail('must be a valid email address');
      if (rule.pattern && !rule.pattern.test(value)) return fail(rule.patternMessage || 'has an invalid format');
      break;
    }
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return fail('must be a valid id');
      value = value.toLowerCase();
      break;
    }
    case 'integer':
    case 'number': {
      if (opts.coerce && typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        value = Number(value.trim());
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`must be a ${rule.type}`);
      if (rule.type === 'integer' && !Number.isInteger(value)) return fail('must be an integer');
      if (rule.min !== undefined && value < rule.min) return fail(`must be at least ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) return fail(`must be at most ${rule.max}`);
      break;
    }
    case 'boolean': {
      if (opts.coerce && (value === 'true' || value === 'false')) value = value === 'true';
      if (typeof value !== 'boolean') return fail('must be true or false');
      break;
    }
    case 'datetime': {
      if (typeof value !== 'string' || !DATETIME_PATTERN.test(value)) {
        return fail('must be an ISO 8601 date-time with a time zone, e.g. 2026-12-01T18:00:00Z');
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return fail('is not a valid date-time');
      value = d;
      break;
    }
    case 'enum': {
      if (typeof value !== 'string' || !rule.values.includes(value)) {
        return fail(`must be one of: ${rule.values.join(', ')}`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('must be an array');
      if (rule.min !== undefined && value.length < rule.min) return fail(`must contain at least ${rule.min} item(s)`);
      if (rule.max !== undefined && value.length > rule.max) return fail(`must contain at most ${rule.max} item(s)`);
      if (rule.items) {
        const out = [];
        value.forEach((item, i) => {
          const r = checkValue({ required: true, ...rule.items }, item, `${path}[${i}]`, errors, opts);
          if (r.set) out.push(r.value);
        });
        value = out;
      }
      break;
    }
    case 'object': {
      if (!isPlainObject(value)) return fail('must be an object');
      value = validateObject(rule.schema || {}, value, path, errors, { ...opts, minFields: rule.minFields });
      break;
    }
    default:
      throw new Error(`Unknown validation rule type "${rule.type}" at ${path}`);
  }

  if (rule.custom) {
    const msg = rule.custom(value);
    if (msg) return fail(msg);
  }
  return { set: true, value };
}

function validateObject(schema, input, basePath, errors, opts) {
  const out = {};
  const source = input === undefined || input === null ? {} : input;
  if (!isPlainObject(source)) {
    errors.push({ field: basePath || 'body', message: 'must be a JSON object' });
    return out;
  }
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key) || !Object.prototype.hasOwnProperty.call(schema, key)) {
      if (!opts.allowUnknown || FORBIDDEN_KEYS.has(key)) {
        errors.push({ field: basePath ? `${basePath}.${key}` : key, message: 'is not allowed' });
      }
    }
  }
  let provided = 0;
  for (const [key, rule] of Object.entries(schema)) {
    const path = basePath ? `${basePath}.${key}` : key;
    if (source[key] !== undefined) provided += 1;
    const r = checkValue(rule, source[key], path, errors, opts);
    if (r.set) out[key] = r.value;
  }
  if (opts.minFields && provided < opts.minFields) {
    errors.push({ field: basePath || 'body', message: `must contain at least ${opts.minFields} field(s)` });
  }
  return out;
}

/**
 * Validates `input` against `schema`; returns the cleaned value or throws a 400 VALIDATION_ERROR.
 * Only fields declared in the schema are returned.
 * @param {object} schema
 * @param {any} input
 * @param {{ coerce?: boolean, allowUnknown?: boolean, minFields?: number }} [opts]
 */
function validate(schema, input, opts = {}) {
  const errors = [];
  const value = validateObject(schema, input, '', errors, opts);
  if (errors.length) throw validationError(errors.slice(0, 50));
  return value;
}

/** Common query fragments. */
const paginationSchema = Object.freeze({
  limit: { type: 'integer', min: 1, max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT },
  offset: { type: 'integer', min: 0, max: 1_000_000, default: 0 },
});

const searchRule = Object.freeze({ type: 'string', min: 1, max: LIMITS.SEARCH_MAX });

const eventIdParams = Object.freeze({ eventId: { type: 'uuid', required: true } });

module.exports = {
  validate,
  validateObject,
  isPlainObject,
  paginationSchema,
  searchRule,
  eventIdParams,
  EMAIL_PATTERN,
  DATETIME_PATTERN,
};
