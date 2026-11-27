-- =============================================================================
-- Event Manager (Group 6) - 002_app_role.sql
-- Restricted database role used by every Lambda function (Section 6.2 "Least
-- privilege"): no schema changes, no hard deletes (except staff unassignment),
-- column-level UPDATE rights, and insert-only access to audit_log.
-- The role's password is set by db/migrate.js from EM_APP_DB_PASSWORD (never
-- committed) or by the team in the Neon console.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'em_app') THEN
    CREATE ROLE em_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Start from nothing, then grant only what the application needs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM em_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM em_app;
REVOKE CREATE ON SCHEMA public FROM em_app;   -- no DDL (Section 6.2)
GRANT USAGE ON SCHEMA public TO em_app;

-- users: role, email and created_by can never be changed by the application,
-- so a SQL bug cannot turn a staff account into an organizer (Threat 4).
GRANT SELECT, INSERT ON users TO em_app;
GRANT UPDATE (name, password_hash, status, setup_token_hash, setup_expires_at, updated_at) ON users TO em_app;

-- events: organizer_id is immutable (Threat 3); no DELETE (no hard delete per Section 5.3).
GRANT SELECT, INSERT ON events TO em_app;
GRANT UPDATE (title, description, venue_address, venue_lat, venue_lng, venue_verified,
              start_time, end_time, rsvp_deadline, capacity, invite_limit,
              status, cancel_reason, completed_at, updated_at) ON events TO em_app;

-- event_staff: the only table the application may DELETE from (unassign staff).
GRANT SELECT, INSERT, DELETE ON event_staff TO em_app;

-- invitations: guest identity (event_id, guest_email) is immutable once created.
GRANT SELECT, INSERT ON invitations TO em_app;
GRANT UPDATE (plus_one_allowance, token_hash, status, last_sent_at, revoked_at, updated_at) ON invitations TO em_app;

GRANT SELECT, INSERT ON guest_list_imports TO em_app;
GRANT UPDATE (status, rows_added, rows_skipped, row_errors, failure_reason, updated_at) ON guest_list_imports TO em_app;

GRANT SELECT, INSERT ON plus_one_requests TO em_app;
GRANT UPDATE (status, decided_by, decided_at) ON plus_one_requests TO em_app;

-- rsvps: invitation_id and event_id are immutable (an RSVP cannot be moved to another event).
GRANT SELECT, INSERT ON rsvps TO em_app;
GRANT UPDATE (status, party_size, dietary_notes, check_in_code, waitlisted_at, promoted_at,
              cancelled_at, cancelled_from_status, cancel_reason, responded_at, updated_at) ON rsvps TO em_app;

-- check_ins: only the void fields can change; who/when/how many is permanent (Threat 9).
GRANT SELECT, INSERT ON check_ins TO em_app;
GRANT UPDATE (status, voided_by, voided_at, void_reason) ON check_ins TO em_app;

-- attendance_reports: written once at completion, never updated.
GRANT SELECT, INSERT ON attendance_reports TO em_app;

-- guest_history: upserted by the report generator.
GRANT SELECT, INSERT ON guest_history TO em_app;
GRANT UPDATE (events_confirmed, events_attended, no_shows, last_event_id, updated_at) ON guest_history TO em_app;

-- audit_log: INSERT only - the application cannot read, change or delete entries (Threat 9).
GRANT INSERT ON audit_log TO em_app;
DO $$
DECLARE
  seq text := pg_get_serial_sequence('public.audit_log', 'log_id');
BEGIN
  IF seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO em_app', seq);
  END IF;
END
$$;

-- The migration bookkeeping table is never visible to the application.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.schema_migrations FROM em_app';
  END IF;
END
$$;

-- Defaults for the session (also enforced per connection by shared/db.js).
ALTER ROLE em_app SET statement_timeout = '10s';
ALTER ROLE em_app SET idle_in_transaction_session_timeout = '15s';
