-- =============================================================================
-- Event Manager (Group 6) - 001_schema.sql
-- Tables, CHECK / UNIQUE / FK constraints and indexes for Neon PostgreSQL (16).
-- Column names follow the ER diagram in Section 5.3 of the design document.
-- Database constraints are the second line of defence behind server-side
-- validation (Section 6.2 "Input validation"; Threat 5).
-- =============================================================================

-- Keeps updated_at current on every UPDATE without trusting application code.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- users (Shared: Authentication)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  user_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(100) NOT NULL,
  email             varchar(254) NOT NULL,
  password_hash     varchar(100),                        -- bcrypt; NULL until staff setup
  role              varchar(20)  NOT NULL,
  created_by        uuid REFERENCES users (user_id),     -- organizer who created a staff account
  status            varchar(20)  NOT NULL DEFAULT 'active',
  setup_token_hash  char(64),                            -- SHA-256 of single-use staff setup token
  setup_expires_at  timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT users_name_not_blank      CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT users_email_format        CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT users_role_valid          CHECK (role IN ('organizer', 'staff')),
  CONSTRAINT users_status_valid        CHECK (status IN ('active', 'pending_setup', 'disabled')),
  -- Staff accounts are only created by organizers (Section 6.1); organizers have no creator.
  CONSTRAINT users_creator_matches_role CHECK ((role = 'staff') = (created_by IS NOT NULL)),
  CONSTRAINT users_active_has_password CHECK (status <> 'active' OR password_hash IS NOT NULL),
  CONSTRAINT users_password_hash_bcrypt CHECK (password_hash IS NULL OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'),
  CONSTRAINT users_setup_token_pair    CHECK ((setup_token_hash IS NULL) = (setup_expires_at IS NULL)),
  CONSTRAINT users_setup_token_format  CHECK (setup_token_hash IS NULL OR setup_token_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE UNIQUE INDEX users_setup_token_hash_uq ON users (setup_token_hash) WHERE setup_token_hash IS NOT NULL;
CREATE INDEX users_created_by_idx ON users (created_by) WHERE created_by IS NOT NULL;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- events (Event & Guest List - Osama)
-- -----------------------------------------------------------------------------
CREATE TABLE events (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id    uuid NOT NULL REFERENCES users (user_id),
  title           varchar(120)  NOT NULL,
  description     varchar(2000),
  venue_address   varchar(300)  NOT NULL,
  venue_lat       double precision,
  venue_lng       double precision,
  venue_verified  boolean       NOT NULL DEFAULT false,
  start_time      timestamptz   NOT NULL,
  end_time        timestamptz   NOT NULL,
  rsvp_deadline   timestamptz   NOT NULL,
  capacity        integer       NOT NULL,
  invite_limit    integer       NOT NULL,
  status          varchar(20)   NOT NULL DEFAULT 'draft',
  cancel_reason   varchar(300),
  completed_at    timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT events_title_not_blank    CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT events_venue_not_blank    CHECK (length(btrim(venue_address)) BETWEEN 1 AND 300),
  CONSTRAINT events_lat_range          CHECK (venue_lat IS NULL OR venue_lat BETWEEN -90 AND 90),
  CONSTRAINT events_lng_range          CHECK (venue_lng IS NULL OR venue_lng BETWEEN -180 AND 180),
  -- A venue is only "verified" when Geoapify returned coordinates (publish rule).
  CONSTRAINT events_verified_has_coords CHECK (NOT venue_verified OR (venue_lat IS NOT NULL AND venue_lng IS NOT NULL)),
  CONSTRAINT events_end_after_start    CHECK (end_time > start_time),
  CONSTRAINT events_deadline_before_start CHECK (rsvp_deadline <= start_time),
  CONSTRAINT events_capacity_positive  CHECK (capacity BETWEEN 1 AND 100000),
  CONSTRAINT events_invite_limit_positive CHECK (invite_limit BETWEEN 1 AND 100000),
  CONSTRAINT events_status_valid       CHECK (status IN ('draft', 'published', 'rsvp_closed', 'completed', 'cancelled')),
  CONSTRAINT events_completed_at_matches CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT events_cancel_reason_only_cancelled CHECK (cancel_reason IS NULL OR status = 'cancelled')
);
CREATE INDEX events_organizer_status_idx ON events (organizer_id, status, start_time);
-- Scheduler scans (every 5 minutes): published past deadline, rsvp_closed past end_time + 30 min.
CREATE INDEX events_due_close_idx    ON events (rsvp_deadline) WHERE status = 'published';
CREATE INDEX events_due_complete_idx ON events (end_time)      WHERE status = 'rsvp_closed';
CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- event_staff (Event & Guest List - Osama) - staff assignment, checked on every staff action (Threat 4)
-- -----------------------------------------------------------------------------
CREATE TABLE event_staff (
  event_id     uuid NOT NULL REFERENCES events (event_id),
  user_id      uuid NOT NULL REFERENCES users (user_id),
  assigned_by  uuid NOT NULL REFERENCES users (user_id),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_staff_user_idx ON event_staff (user_id);

-- -----------------------------------------------------------------------------
-- invitations (Event & Guest List - Osama)
-- -----------------------------------------------------------------------------
CREATE TABLE invitations (
  invitation_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events (event_id),
  guest_name          varchar(100) NOT NULL,
  guest_email         varchar(254) NOT NULL,
  category            varchar(50),
  plus_one_allowance  smallint     NOT NULL DEFAULT 0,
  token_hash          char(64),                          -- SHA-256 of the 256-bit token; raw token only in the email link (Threat 2)
  status              varchar(20)  NOT NULL DEFAULT 'pending',
  last_sent_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT invitations_name_not_blank  CHECK (length(btrim(guest_name)) BETWEEN 1 AND 100),
  CONSTRAINT invitations_email_format    CHECK (guest_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT invitations_allowance_range CHECK (plus_one_allowance BETWEEN 0 AND 3),
  CONSTRAINT invitations_status_valid    CHECK (status IN ('pending', 'sent', 'responded', 'revoked')),
  CONSTRAINT invitations_token_format    CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_sent_has_token  CHECK (status IN ('pending', 'revoked') OR token_hash IS NOT NULL),
  CONSTRAINT invitations_revoked_at_matches CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT invitations_token_hash_uq   UNIQUE (token_hash),
  -- Target for composite FKs so an RSVP can never point at another event's invitation.
  CONSTRAINT invitations_id_event_uq     UNIQUE (invitation_id, event_id)
);
-- Duplicate emails within an event are rejected case-insensitively.
CREATE UNIQUE INDEX invitations_event_email_uq ON invitations (event_id, lower(guest_email));
CREATE INDEX invitations_event_status_idx ON invitations (event_id, status);
CREATE TRIGGER invitations_set_updated_at BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- guest_list_imports (Event & Guest List - Osama)
-- -----------------------------------------------------------------------------
CREATE TABLE guest_list_imports (
  import_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events (event_id),
  s3_key          varchar(300) NOT NULL,
  status          varchar(20)  NOT NULL DEFAULT 'pending',
  rows_added      integer      NOT NULL DEFAULT 0,
  rows_skipped    integer      NOT NULL DEFAULT 0,
  row_errors      jsonb        NOT NULL DEFAULT '[]'::jsonb,
  failure_reason  varchar(300),
  created_by      uuid NOT NULL REFERENCES users (user_id),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT guest_list_imports_status_valid CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT guest_list_imports_counts_nonneg CHECK (rows_added >= 0 AND rows_skipped >= 0),
  CONSTRAINT guest_list_imports_errors_array CHECK (jsonb_typeof(row_errors) = 'array'),
  CONSTRAINT guest_list_imports_s3_key_uq UNIQUE (s3_key)
);
CREATE INDEX guest_list_imports_event_idx ON guest_list_imports (event_id, created_at DESC);
CREATE TRIGGER guest_list_imports_set_updated_at BEFORE UPDATE ON guest_list_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- plus_one_requests (Event & Guest List - Osama)
-- -----------------------------------------------------------------------------
CREATE TABLE plus_one_requests (
  request_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id   uuid NOT NULL REFERENCES invitations (invitation_id),
  companion_name  varchar(100) NOT NULL,
  note            varchar(300),
  status          varchar(20)  NOT NULL DEFAULT 'pending',
  decided_by      uuid REFERENCES users (user_id),
  decided_at      timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT plus_one_requests_name_not_blank CHECK (length(btrim(companion_name)) BETWEEN 1 AND 100),
  CONSTRAINT plus_one_requests_status_valid   CHECK (status IN ('pending', 'approved', 'denied')),
  CONSTRAINT plus_one_requests_decision_pair  CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by IS NULL))
);
-- At most one pending request per invitation.
CREATE UNIQUE INDEX plus_one_requests_one_pending_uq ON plus_one_requests (invitation_id) WHERE status = 'pending';
CREATE INDEX plus_one_requests_invitation_idx ON plus_one_requests (invitation_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- rsvps (RSVP & Waitlist - Abdelaziz)
-- -----------------------------------------------------------------------------
CREATE TABLE rsvps (
  rsvp_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id          uuid NOT NULL,
  event_id               uuid NOT NULL REFERENCES events (event_id),
  status                 varchar(30)  NOT NULL,
  party_size             smallint     NOT NULL,
  dietary_notes          varchar(300),
  check_in_code          char(6),
  waitlisted_at          timestamptz,
  promoted_at            timestamptz,
  cancelled_at           timestamptz,
  cancelled_from_status  varchar(20),
  cancel_reason          varchar(300),
  responded_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  -- One RSVP per invitation: a second first-reply is a 409.
  CONSTRAINT rsvps_invitation_uq        UNIQUE (invitation_id),
  CONSTRAINT rsvps_invitation_event_fk  FOREIGN KEY (invitation_id, event_id)
                                        REFERENCES invitations (invitation_id, event_id),
  CONSTRAINT rsvps_id_event_uq          UNIQUE (rsvp_id, event_id),
  CONSTRAINT rsvps_status_valid         CHECK (status IN ('confirmed', 'waitlisted', 'declined',
                                                          'cancelled_by_guest', 'cancelled_by_organizer', 'event_cancelled')),
  -- party_size is 1..(1 + allowance) with allowance <= 3; the per-invitation bound is enforced in the RSVP service.
  CONSTRAINT rsvps_party_size_range     CHECK (party_size BETWEEN 1 AND 4),
  CONSTRAINT rsvps_check_in_code_format CHECK (check_in_code IS NULL OR check_in_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$'),
  CONSTRAINT rsvps_confirmed_has_code   CHECK (status <> 'confirmed' OR check_in_code IS NOT NULL),
  CONSTRAINT rsvps_waitlisted_has_time  CHECK (status <> 'waitlisted' OR waitlisted_at IS NOT NULL),
  CONSTRAINT rsvps_cancelled_at_matches CHECK ((status IN ('cancelled_by_guest', 'cancelled_by_organizer', 'event_cancelled'))
                                               = (cancelled_at IS NOT NULL)),
  CONSTRAINT rsvps_cancelled_from_valid CHECK (cancelled_from_status IS NULL OR cancelled_from_status IN ('confirmed', 'waitlisted')),
  CONSTRAINT rsvps_cancelled_from_pair  CHECK ((cancelled_at IS NULL) = (cancelled_from_status IS NULL)),
  CONSTRAINT rsvps_organizer_cancel_has_reason CHECK (status <> 'cancelled_by_organizer' OR cancel_reason IS NOT NULL)
);
-- Check-in codes are unique within an event (typed at the door).
CREATE UNIQUE INDEX rsvps_event_code_uq ON rsvps (event_id, check_in_code) WHERE check_in_code IS NOT NULL;
CREATE INDEX rsvps_event_status_idx ON rsvps (event_id, status);
-- Waitlist order: first-come by waitlisted_at.
CREATE INDEX rsvps_waitlist_order_idx ON rsvps (event_id, waitlisted_at, rsvp_id) WHERE status = 'waitlisted';
CREATE TRIGGER rsvps_set_updated_at BEFORE UPDATE ON rsvps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- check_ins (Check-in & Analytics - Adham)
-- -----------------------------------------------------------------------------
CREATE TABLE check_ins (
  checkin_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rsvp_id         uuid NOT NULL,
  event_id        uuid NOT NULL REFERENCES events (event_id),
  checked_in_by   uuid NOT NULL REFERENCES users (user_id),
  people_arrived  smallint    NOT NULL,
  checked_in_at   timestamptz NOT NULL DEFAULT now(),
  status          varchar(20) NOT NULL DEFAULT 'active',
  voided_by       uuid REFERENCES users (user_id),
  voided_at       timestamptz,
  void_reason     varchar(300),
  CONSTRAINT check_ins_rsvp_event_fk     FOREIGN KEY (rsvp_id, event_id) REFERENCES rsvps (rsvp_id, event_id),
  CONSTRAINT check_ins_people_range      CHECK (people_arrived BETWEEN 1 AND 4),
  CONSTRAINT check_ins_status_valid      CHECK (status IN ('active', 'voided')),
  -- Threat 9: an undo keeps the record and must say who, when and why.
  CONSTRAINT check_ins_void_fields       CHECK ((status = 'voided')
                                                = (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT check_ins_void_reason_len   CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300)
);
-- Only one active check-in per RSVP; a duplicate violates this index -> 409.
CREATE UNIQUE INDEX check_ins_one_active_per_rsvp ON check_ins (rsvp_id) WHERE status = 'active';
CREATE INDEX check_ins_event_status_idx ON check_ins (event_id, status, checked_in_at DESC);

-- -----------------------------------------------------------------------------
-- attendance_reports (Check-in & Analytics - Adham)
-- -----------------------------------------------------------------------------
CREATE TABLE attendance_reports (
  report_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events (event_id),
  invited             integer NOT NULL,
  confirmed           integer NOT NULL,
  attended            integer NOT NULL,
  no_shows            integer NOT NULL,
  late_cancellations  integer NOT NULL,
  waitlist_promoted   integer NOT NULL,
  attendance_rate     numeric(5, 4) NOT NULL,
  s3_report_key       varchar(300) NOT NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_reports_event_uq UNIQUE (event_id),
  CONSTRAINT attendance_reports_counts_nonneg CHECK (invited >= 0 AND confirmed >= 0 AND attended >= 0 AND no_shows >= 0
                                                     AND late_cancellations >= 0 AND waitlist_promoted >= 0),
  -- A no-show is a confirmed RSVP without an active check-in, so the two always add up to confirmed.
  CONSTRAINT attendance_reports_totals_match CHECK (attended + no_shows = confirmed),
  CONSTRAINT attendance_reports_rate_range CHECK (attendance_rate BETWEEN 0 AND 1)
);

-- -----------------------------------------------------------------------------
-- guest_history (Check-in & Analytics - Adham) - read by Event service for repeat no-show flag
-- -----------------------------------------------------------------------------
CREATE TABLE guest_history (
  organizer_id       uuid NOT NULL REFERENCES users (user_id),
  guest_email_lower  varchar(254) NOT NULL,
  events_confirmed   integer NOT NULL DEFAULT 0,
  events_attended    integer NOT NULL DEFAULT 0,
  no_shows           integer NOT NULL DEFAULT 0,
  last_event_id      uuid REFERENCES events (event_id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_id, guest_email_lower),
  CONSTRAINT guest_history_email_is_lower CHECK (guest_email_lower = lower(guest_email_lower)),
  CONSTRAINT guest_history_counts_nonneg CHECK (events_confirmed >= 0 AND events_attended >= 0 AND no_shows >= 0),
  CONSTRAINT guest_history_counts_consistent CHECK (events_attended + no_shows <= events_confirmed)
);
CREATE TRIGGER guest_history_set_updated_at BEFORE UPDATE ON guest_history
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- audit_log (Shared: Logging) - insert-only for the application (Threat 9)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  log_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type  varchar(40) NOT NULL,
  actor_type  varchar(20) NOT NULL,
  actor_id    uuid,              -- user_id for users, invitation_id for guests; no FK so audit writes never fail
  event_id    uuid,
  target_id   uuid,
  ip_hash     char(64),          -- HMAC-SHA256 of the client IP; raw IPs are never stored
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_event_type_valid CHECK (event_type IN (
    'login_failed', 'login_locked', 'auth_failed', 'access_denied', 'turnstile_failed', 'rate_limited',
    'duplicate_checkin', 'rsvp_cancelled', 'rsvp_promoted', 'invitation_revoked', 'checkin_voided')),
  CONSTRAINT audit_log_actor_type_valid CHECK (actor_type IN ('user', 'guest', 'system', 'anonymous')),
  CONSTRAINT audit_log_ip_hash_format   CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_log_detail_object    CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX audit_log_type_time_idx ON audit_log (event_type, created_at DESC);
CREATE INDEX audit_log_event_idx     ON audit_log (event_id, created_at DESC) WHERE event_id IS NOT NULL;

-- Threat 9: even a role that was accidentally granted UPDATE/DELETE cannot rewrite history.
CREATE OR REPLACE FUNCTION audit_log_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is insert-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_changes();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_changes();
