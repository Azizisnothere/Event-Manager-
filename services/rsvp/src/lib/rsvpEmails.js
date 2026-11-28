'use strict';
const { constants, utils, emailQueue, logger } = require('../../../../shared');

const T = constants.EMAIL_TEMPLATES;

function job(template, event, guest, params = {}) {
  return {
    template,
    to: { email: guest.guest_email, name: guest.guest_name },
    params: { guest_name: guest.guest_name, event_title: event.title, ...params },
  };
}

function confirmedJob(event, guest, rsvp) {
  return job(T.RSVP_CONFIRMED, event, guest, {
    start_time: utils.toIso(event.start_time),
    venue_address: event.venue_address,
    party_size: rsvp.party_size,
    check_in_code: rsvp.check_in_code,
  });
}

function waitlistedJob(event, guest, rsvp, position) {
  return job(T.RSVP_WAITLISTED, event, guest, { party_size: rsvp.party_size, waitlist_position: position });
}

function declinedJob(event, guest) {
  return job(T.RSVP_DECLINED, event, guest);
}

function updatedJob(event, guest, rsvp, position) {
  return job(T.RSVP_UPDATED, event, guest, {
    status: rsvp.status,
    party_size: rsvp.party_size,
    check_in_code: rsvp.status === 'confirmed' ? rsvp.check_in_code : null,
    waitlist_position: rsvp.status === 'waitlisted' ? position : null,
  });
}

function cancelledJob(event, guest, cancelledBy) {
  return job(T.RSVP_CANCELLED, event, guest, { cancelled_by: cancelledBy });
}

function promotedJobs(event, promoted) {
  return promoted.map((p) =>
    job(T.RSVP_PROMOTED, event, p, {
      start_time: utils.toIso(event.start_time),
      venue_address: event.venue_address,
      party_size: p.party_size,
      check_in_code: p.check_in_code,
    }),
  );
}

async function queue(jobs) {
  if (!jobs.length) return 0;
  try {
    return await emailQueue.enqueueEmails(jobs);
  } catch (err) {
    logger.error('rsvp_emails_not_queued', { count: jobs.length, error: err });
    return 0;
  }
}

module.exports = { confirmedJob, waitlistedJob, declinedJob, updatedJob, cancelledJob, promotedJobs, queue, job };
