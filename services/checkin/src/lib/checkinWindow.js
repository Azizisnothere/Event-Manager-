'use strict';
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
