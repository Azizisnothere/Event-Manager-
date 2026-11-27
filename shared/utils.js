'use strict';
/** Small pure helpers shared by all services. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Escapes LIKE/ILIKE wildcards so user search text is matched literally.
 * Use with:  col ILIKE $n ESCAPE '\'   and pass  `%${escapeLike(term)}%`.
 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 'YYYY-MM-DD' for the UTC day of `date`. */
function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight (minimum 1). */
function secondsUntilNextUtcMidnight(date = new Date()) {
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - date.getTime()) / 1000));
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60_000);
}

function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 3_600_000);
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Splits an array into chunks of `size`. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  isUuid,
  escapeLike,
  nowSeconds,
  utcDayKey,
  secondsUntilNextUtcMidnight,
  addMinutes,
  addHours,
  toIso,
  chunk,
};
