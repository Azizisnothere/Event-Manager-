'use strict';
/**
 * Named constants for every business and security rule that has a number in it.
 * Values marked (A#) come from the numbered assumptions agreed before coding.
 */

const EVENT_STATUSES = Object.freeze(['draft', 'published', 'rsvp_closed', 'completed', 'cancelled']);
const INVITATION_STATUSES = Object.freeze(['pending', 'sent', 'responded', 'revoked']);
const RSVP_STATUSES = Object.freeze([
  'confirmed',
  'waitlisted',
  'declined',
  'cancelled_by_guest',
  'cancelled_by_organizer',
  'event_cancelled',
]);
const RSVP_CANCELLED_STATUSES = Object.freeze(['cancelled_by_guest', 'cancelled_by_organizer', 'event_cancelled']);
const CHECKIN_STATUSES = Object.freeze(['active', 'voided']);
const ROLES = Object.freeze(['organizer', 'staff']);
const USER_STATUSES = Object.freeze(['active', 'pending_setup', 'disabled']);
const PLUS_ONE_STATUSES = Object.freeze(['pending', 'approved', 'denied']);
const IMPORT_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'failed']);

// SNS message types (Section 5.2). Never rename: infra filters subscriptions on these.
const MESSAGE_TYPES = Object.freeze({
  EVENT_CAPACITY_CHANGED: 'event.capacity_changed',
  EVENT_UPDATED: 'event.updated',
  EVENT_CANCELLED: 'event.cancelled',
  INVITATION_REVOKED: 'invitation.revoked',
  EVENT_COMPLETED: 'event.completed',
});

// Email templates rendered by the notifier (services/events/lambdas/notifier.js).
const EMAIL_TEMPLATES = Object.freeze({
  INVITATION: 'invitation',
  EVENT_UPDATED: 'event_updated',
  EVENT_CANCELLED: 'event_cancelled',
  RSVP_CONFIRMED: 'rsvp_confirmed',
  RSVP_WAITLISTED: 'rsvp_waitlisted',
  RSVP_DECLINED: 'rsvp_declined',
  RSVP_UPDATED: 'rsvp_updated',
  RSVP_CANCELLED: 'rsvp_cancelled',
  RSVP_PROMOTED: 'rsvp_promoted',
  PLUS_ONE_DECISION: 'plus_one_decision',
  STAFF_SETUP: 'staff_setup',
});

// audit_log.event_type values (must match the CHECK constraint in 001_schema.sql).
const AUDIT_EVENT_TYPES = Object.freeze({
  LOGIN_FAILED: 'login_failed',
  LOGIN_LOCKED: 'login_locked',
  AUTH_FAILED: 'auth_failed',
  ACCESS_DENIED: 'access_denied',
  TURNSTILE_FAILED: 'turnstile_failed',
  RATE_LIMITED: 'rate_limited',
  DUPLICATE_CHECKIN: 'duplicate_checkin',
  RSVP_CANCELLED: 'rsvp_cancelled',
  RSVP_PROMOTED: 'rsvp_promoted',
  INVITATION_REVOKED: 'invitation_revoked',
  CHECKIN_VOIDED: 'checkin_voided',
});
const AUDIT_ACTOR_TYPES = Object.freeze(['user', 'guest', 'system', 'anonymous']);

// Unambiguous alphabet for typed check-in codes: no 0/O, 1/I/L (A21).
const CHECK_IN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

module.exports = Object.freeze({
  // Authentication (Section 6.2, Threat 1)
  BCRYPT_COST: 12,
  PASSWORD_MIN_LENGTH: 10,
  PASSWORD_MAX_BYTES: 72, // bcrypt ignores bytes beyond 72 (A29)
  JWT_ALGORITHM: 'HS256',
  JWT_EXPIRES_IN_SECONDS: 3600,
  JWT_SECRET_MIN_LENGTH: 32,
  LOGIN_MAX_FAILURES: 5,
  LOGIN_WINDOW_SECONDS: 15 * 60,
  STAFF_SETUP_TOKEN_TTL_HOURS: 48,
  TOKEN_BYTES: 32, // 256-bit invitation and setup tokens

  // Request handling
  JSON_BODY_LIMIT: '10kb',
  // Routes allowed a 64 KB body instead of 10 KB (pasted CSV guest list)
  LARGE_BODY_PATHS: [/^\/api\/events\/[^/]+\/invitations\/bulk$/],
  PRESIGNED_URL_TTL_SECONDS: 5 * 60, // Threat 7
  DEFAULT_PAGE_LIMIT: 50,
  MAX_PAGE_LIMIT: 200,

  // Rate limits stored in DynamoDB (Threat 6, A22)
  RSVP_RATE_LIMIT_PER_TOKEN: Object.freeze({ limit: 20, windowSeconds: 10 * 60 }),
  RSVP_RATE_LIMIT_PER_IP: Object.freeze({ limit: 300, windowSeconds: 10 * 60 }), // many guests can share one NAT (campus wifi)
  REGISTER_RATE_LIMIT_PER_IP: Object.freeze({ limit: 30, windowSeconds: 60 * 60 }),
  INVITATION_RESEND_DAILY_LIMIT: 3,

  // Guest list
  PLUS_ONE_MAX: 3,
  MAX_GUESTS_PER_REQUEST: 100,
  CSV_IMPORT_MAX_BYTES: 1024 * 1024,
  CSV_IMPORT_MAX_ROWS: 1000,
  CSV_IMPORT_MAX_STORED_ERRORS: 200,

  // Event timing
  SCHEDULER_INTERVAL_MINUTES: 5,
  AUTO_COMPLETE_MINUTES_AFTER_END: 30,

  // Check-in (A23, A24)
  CHECKIN_OPENS_MINUTES_BEFORE_START: 120,
  CHECKIN_CLOSES_MINUTES_AFTER_END: 30,
  VOID_WINDOW_MINUTES: 15,
  CHECK_IN_CODE_LENGTH: 6,
  CHECK_IN_CODE_ALPHABET,

  // Attendance (A25, A28)
  OCCUPANCY_WARNING_RATIO: 0.9,
  REPEAT_NO_SHOW_THRESHOLD: 2,

  // Messaging
  IDEMPOTENCY_TTL_SECONDS: 24 * 60 * 60,
  IDEMPOTENCY_PROCESSING_TTL_SECONDS: 5 * 60,

  // Field limits (Section 6.2 "Input validation")
  LIMITS: Object.freeze({
    TITLE_MAX: 120,
    DESCRIPTION_MAX: 2000,
    VENUE_ADDRESS_MAX: 300,
    NAME_MAX: 100,
    EMAIL_MAX: 254,
    DIETARY_NOTES_MAX: 300,
    REASON_MIN: 3,
    REASON_MAX: 300,
    CATEGORY_MAX: 50,
    NOTE_MAX: 300,
    SEARCH_MAX: 100,
    CAPACITY_MAX: 100000,
    PASSWORD_INPUT_MAX: 200,
  }),

  EVENT_STATUSES,
  INVITATION_STATUSES,
  RSVP_STATUSES,
  RSVP_CANCELLED_STATUSES,
  CHECKIN_STATUSES,
  ROLES,
  USER_STATUSES,
  PLUS_ONE_STATUSES,
  IMPORT_STATUSES,
  MESSAGE_TYPES,
  EMAIL_TEMPLATES,
  AUDIT_EVENT_TYPES,
  AUDIT_ACTOR_TYPES,
});
