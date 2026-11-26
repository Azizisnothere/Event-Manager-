#!/usr/bin/env node
'use strict';
/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * and records them in schema_migrations with a SHA-256 checksum so an edited
 * migration is detected instead of silently re-run.
 *
 * Runs with the Neon OWNER connection (MIGRATION_DATABASE_URL), never with the
 * restricted em_app role used by the Lambdas.
 *
 * Usage:
 *   npm run migrate            apply pending migrations   (node db/migrate.js)
 *   npm run migrate:status     list applied / pending migrations
 *
 * Environment:
 *   MIGRATION_DATABASE_URL   owner connection string (required)
 *   EM_APP_DB_PASSWORD       optional; sets the em_app role password after migrating
 *   DB_SSL                   "disable" only for a local, non-Neon Postgres
 */
require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ADVISORY_LOCK_ID = 610_2026; // any constant; prevents two runners migrating at once

function buildClientConfig(connectionString) {
  const url = new URL(connectionString);
  // TLS is configured explicitly below; drop libpq-style params pg would otherwise reinterpret.
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(p);
  const disableSsl = process.env.DB_SSL === 'disable';
  return {
    connectionString: url.toString(),
    ssl: disableSsl ? false : { rejectUnauthorized: true }, // Neon over TLS (sslmode=require)
    application_name: 'em-migrate',
  };
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function ensureBookkeeping(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    varchar(200) PRIMARY KEY,
      checksum    char(64)     NOT NULL,
      applied_at  timestamptz  NOT NULL DEFAULT now()
    )`);
}

async function appliedMigrations(client) {
  const { rows } = await client.query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename');
  return new Map(rows.map((r) => [r.filename, r]));
}

async function run() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error('MIGRATION_DATABASE_URL is not set.');
    process.exit(2);
  }
  const statusOnly = process.argv.includes('--status');
  const client = new Client(buildClientConfig(connectionString));
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await ensureBookkeeping(client);
    const applied = await appliedMigrations(client);
    const files = listMigrationFiles();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksum(sql);
      const prior = applied.get(file);
      if (prior) {
        if (prior.checksum !== sum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        if (statusOnly) console.log(`applied  ${file}  ${prior.applied_at.toISOString()}`);
        continue;
      }
      if (statusOnly) {
        console.log(`pending  ${file}`);
        continue;
      }
      console.log(`applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      console.log(`applied  ${file}`);
    }

    if (!statusOnly && process.env.EM_APP_DB_PASSWORD) {
      const password = process.env.EM_APP_DB_PASSWORD;
      if (password.length < 16) throw new Error('EM_APP_DB_PASSWORD must be at least 16 characters.');
      // DDL cannot take bind parameters; escapeLiteral quotes the value safely.
      await client.query(`ALTER ROLE em_app WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      console.log('em_app password updated.');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
