'use strict';
/**
 * Check-in window (A23): opens CHECKIN_OPENS_MINUTES_BEFORE_START before start_time and closes
 * CHECKIN_CLOSES_MINUTES_AFTER_END after end_time, and only while the event is published or
 * rsvp_closed (never draft, completed or cancelled).
 */
const { constants, utils } = require('../../../../shared');

const { CHECKIN_OPENS_MINUTES_BEFORE_START, CHECKIN_CLOSES_MINUTES_AFTER_END } = constants;

function checkinWindow(event) {
  return {
    opens_at: utils.addMinutes(event.start_time, -CHECKIN_OPENS_MINUTES_BEFORE_START),
    closes_at: utils.addMinutes(event.end_time, CHECKIN_CLOSES_MINUTES_AFTER_END),
  };
}

function isCheckinOpen(event, now = new Date()) {
  if (!['published', 'rsvp_closed'].includes(event.status)) return false;
  const w = checkinWindow(event);
  return now.getTime() >= w.opens_at.getTime() && now.getTime() <= w.closes_at.getTime();
}

module.exports = { checkinWindow, isCheckinOpen };
