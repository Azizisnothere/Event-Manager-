// shared/db.js  Neon PostgreSQL pool, one per Lambda container.
// - TLS always on with the certificate verified (DB_SSL=disable is allowed ONLY for a local Postgres).
// - Connects as the restricted role em_app (db/migrations/002_app_role.sql).
// - Parameterized queries only: callers pass SQL with $1..$n and a params array.  [Threat 5]
// - On Lambda the connection string comes from Secrets Manager (DB_URL_SECRET_NAME); on the PC from DATABASE_URL.
// Decision D-01 (docs/spikes.md): the pg driver, because the capacity rule needs SELECT ... FOR UPDATE.
const { Pool } = require('pg');
const { logger } = require('./logger');
const { getSecret } = require('./secrets');

let poolPromise;

function sslDisabled() {
  return process.env.DB_SSL === 'disable' && process.env.NODE_ENV !== 'production';
}

function buildPoolConfig(connectionString) {
  const url = new URL(connectionString);
  // TLS is set explicitly below; pg would otherwise re-read sslmode etc. from the URL.
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'channel_binding']) url.searchParams.delete(p);
  return {
    connectionString: url.toString(),
    ssl: sslDisabled() ? false : { rejectUnauthorized: true }, // Neon: TLS, certificate verified
    max: Number(process.env.DB_POOL_MAX) || 2,                 // Lambda handles one request at a time
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,                            // Neon may need a few seconds to wake up
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
    application_name: String(process.env.SERVICE_NAME || 'event-manager').slice(0, 60)
  };
}

async function createPool() {
  const pool = new Pool(buildPoolConfig(await getSecret('dbUrl')));
  // Neon closes idle connections; that must not crash the container.
  pool.on('error', (error) => logger.warn('db idle client error', { error }));
  return pool;
}

function getPool() {
  if (!poolPromise) {
    poolPromise = createPool();
    poolPromise.catch(() => { poolPromise = undefined; }); // rebuilt on the next call
  }
  return poolPromise;
}

async function query(text, params = []) {
  return (await getPool()).query(text, params);
}

// fn(client) runs inside BEGIN/COMMIT on ONE connection; any error -> ROLLBACK.
async function withTransaction(fn, { isolationLevel = 'READ COMMITTED' } = {}) {
  const level = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolationLevel) ? isolationLevel : 'READ COMMITTED';
  const client = await (await getPool()).connect();
  let broken = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${level}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw error;
  } finally {
    client.release(broken);
  }
}

// Anything that accepts "a client or the pool" can take db.pool.
const pool = { query };

// pg error codes mapped to 409 by the services
const PG_ERRORS = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03'
});

function isUniqueViolation(error, constraintName) {
  return Boolean(error && error.code === PG_ERRORS.UNIQUE_VIOLATION && (!constraintName || error.constraint === constraintName));
}

async function checkDatabase() {
  await query('SELECT 1');
  return 'ok';
}

async function closePool() {
  if (!poolPromise) return;
  const p = await poolPromise.catch(() => null);
  poolPromise = undefined;
  if (p) await p.end();
}

module.exports = { query, withTransaction, pool, getPool, checkDatabase, closePool, PG_ERRORS, isUniqueViolation, buildPoolConfig };
