'use strict';
/**
 * Email templates rendered by the notifier. Every parameter is HTML-escaped (Threat 5:
 * guest names and reasons are user input). Threat 2: every RSVP change is confirmed
 * to the invitee by email, so a misused link is noticed.
 *
 * Parameters per template (all times ISO 8601 strings):
 *   invitation         guest_name, event_title, host_name, start_time, end_time, venue_address,
 *                      rsvp_deadline, plus_one_allowance, invitation_url, resend
 *   event_updated      guest_name, event_title, changed_fields[], start_time, end_time, venue_address, rsvp_deadline
 *   event_cancelled    guest_name, event_title, reason
 *   rsvp_confirmed     guest_name, event_title, start_time, venue_address, party_size, check_in_code
 *   rsvp_waitlisted    guest_name, event_title, party_size, waitlist_position
 *   rsvp_declined      guest_name, event_title
 *   rsvp_updated       guest_name, event_title, status, party_size, check_in_code, waitlist_position
 *   rsvp_cancelled     guest_name, event_title, cancelled_by ('guest' | 'organizer')
 *   rsvp_promoted      guest_name, event_title, start_time, venue_address, party_size, check_in_code
 *   plus_one_decision  guest_name, event_title, companion_name, decision ('approved' | 'denied'), plus_one_allowance
 *   staff_setup        staff_name, organizer_name, setup_url, expires_hours
 */
const { constants } = require('../../../../shared');

const T = constants.EMAIL_TEMPLATES;

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayTimeZone() {
  return process.env.DISPLAY_TIME_ZONE || 'UTC';
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const tz = displayTimeZone();
  try {
    return `${new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: tz,
    }).format(d)} (${tz})`;
  } catch (e) {
    return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

function safeUrl(url) {
  // Only http(s) links are ever placed in an email.
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

const FIELD_LABELS = {
  title: 'title',
  description: 'description',
  venue_address: 'venue',
  start_time: 'start time',
  end_time: 'end time',
  rsvp_deadline: 'reply deadline',
};

/**
 * Builds { subject, text, html } from a list of paragraphs.
 * Each block: string (paragraph), { code }, { button: { label, url } }, { list: [] }.
 */
function layout(subject, greetingName, blocks) {
  const textParts = [`Hello ${greetingName || ''},`.replace(' ,', ',')];
  const htmlParts = [`<p>Hello ${esc(greetingName)},</p>`];
  for (const b of blocks) {
    if (typeof b === 'string') {
      textParts.push(b);
      htmlParts.push(`<p>${esc(b)}</p>`);
    } else if (b.code) {
      textParts.push(`Your check-in code: ${b.code}`);
      htmlParts.push(
        `<p style="font-size:28px;letter-spacing:6px;font-weight:bold;font-family:monospace;">${esc(b.code)}</p>`,
      );
    } else if (b.button) {
      const url = safeUrl(b.button.url);
      textParts.push(`${b.button.label}: ${url}`);
      htmlParts.push(
        `<p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(b.button.label)}</a></p>` +
          `<p style="font-size:12px;color:#555;">If the button does not work, copy this link into your browser:<br>${esc(url)}</p>`,
      );
    } else if (b.list) {
      textParts.push(b.list.map((x) => `- ${x}`).join('\n'));
      htmlParts.push(`<ul>${b.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
    }
  }
  textParts.push('Event Manager');
  htmlParts.push('<p style="color:#555;font-size:12px;">Event Manager - this is a transactional message about one invitation.</p>');
  return {
    subject,
    text: textParts.join('\n\n'),
    html: `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5;">${htmlParts.join('')}</body></html>`,
  };
}

const renderers = {
  [T.INVITATION]: (p) =>
    layout(`${p.resend ? 'Reminder: ' : ''}You are invited: ${p.event_title}`, p.guest_name, [
      `${p.host_name || 'The organizer'} has invited you to "${p.event_title}".`,
      { list: [`When: ${fmt(p.start_time)}`, `Where: ${p.venue_address || ''}`, `Please reply by: ${fmt(p.rsvp_deadline)}`] },
      Number(p.plus_one_allowance) > 0
        ? `You may bring up to ${p.plus_one_allowance} companion(s).`
        : 'This invitation is for you only.',
      { button: { label: 'View invitation and reply', url: p.invitation_url } },
      'This link is personal. Please do not forward it.' +
        (p.resend ? ' Any earlier invitation link for this event no longer works.' : ''),
    ]),

  [T.EVENT_UPDATED]: (p) =>
    layout(`Update: ${p.event_title}`, p.guest_name, [
      `The organizer has changed details of "${p.event_title}".`,
      ...(Array.isArray(p.changed_fields) && p.changed_fields.length
        ? [`Changed: ${p.changed_fields.map((f) => FIELD_LABELS[f] || f).join(', ')}.`]
        : []),
      { list: [`When: ${fmt(p.start_time)} - ${fmt(p.end_time)}`, `Where: ${p.venue_address || ''}`, `Reply deadline: ${fmt(p.rsvp_deadline)}`] },
      'Use the link in your original invitation email to view or change your reply.',
    ]),

  [T.EVENT_CANCELLED]: (p) =>
    layout(`Cancelled: ${p.event_title}`, p.guest_name, [
      `We are sorry to tell you that "${p.event_title}" has been cancelled.`,
      ...(p.reason ? [`Reason given by the organizer: ${p.reason}`] : []),
      'Your reply has been cancelled automatically. No action is needed.',
    ]),

  [T.RSVP_CONFIRMED]: (p) =>
    layout(`Confirmed: ${p.event_title}`, p.guest_name, [
      `Your place at "${p.event_title}" is confirmed for ${p.party_size} ${Number(p.party_size) === 1 ? 'person' : 'people'}.`,
      { list: [`When: ${fmt(p.start_time)}`, `Where: ${p.venue_address || ''}`] },
      'Show this code at the door:',
      { code: p.check_in_code },
      'If you did not make this reply, contact the organizer.',
    ]),

  [T.RSVP_WAITLISTED]: (p) =>
    layout(`Waitlist: ${p.event_title}`, p.guest_name, [
      `The event "${p.event_title}" is currently full, so your reply for ${p.party_size} ${Number(p.party_size) === 1 ? 'person' : 'people'} is on the waitlist.`,
      p.waitlist_position ? `Your current position: ${p.waitlist_position}.` : 'You are on the waitlist.',
      'If a seat becomes free we will confirm you automatically and email your check-in code.',
    ]),

  [T.RSVP_DECLINED]: (p) =>
    layout(`Reply received: ${p.event_title}`, p.guest_name, [
      `You have declined the invitation to "${p.event_title}".`,
      'You can change your reply before the deadline using the link in your invitation email.',
      'If you did not make this reply, contact the organizer.',
    ]),

  [T.RSVP_UPDATED]: (p) => {
    const blocks = [`Your reply to "${p.event_title}" has been updated.`];
    if (p.status === 'confirmed') {
      blocks.push(`Status: confirmed for ${p.party_size} ${Number(p.party_size) === 1 ? 'person' : 'people'}.`);
      if (p.check_in_code) blocks.push('Your check-in code:', { code: p.check_in_code });
    } else if (p.status === 'waitlisted') {
      blocks.push(`Status: on the waitlist for ${p.party_size}${p.waitlist_position ? `, position ${p.waitlist_position}` : ''}.`);
    } else if (p.status === 'declined') {
      blocks.push('Status: declined.');
    } else {
      blocks.push(`Status: ${String(p.status || '').replace(/_/g, ' ')}.`);
    }
    blocks.push('If you did not make this change, contact the organizer.');
    return layout(`Reply updated: ${p.event_title}`, p.guest_name, blocks);
  },

  [T.RSVP_CANCELLED]: (p) =>
    layout(`Reply cancelled: ${p.event_title}`, p.guest_name, [
      p.cancelled_by === 'organizer'
        ? `The organizer has cancelled your reply to "${p.event_title}". Please contact the organizer if you think this is a mistake.`
        : `Your attendance at "${p.event_title}" has been cancelled as you requested.`,
      ...(p.cancelled_by === 'organizer' ? [] : ['If you did not make this change, contact the organizer.']),
    ]),

  [T.RSVP_PROMOTED]: (p) =>
    layout(`A seat is free - you are confirmed: ${p.event_title}`, p.guest_name, [
      `Good news: a seat became available and your place at "${p.event_title}" is now confirmed for ${p.party_size} ${Number(p.party_size) === 1 ? 'person' : 'people'}.`,
      { list: [`When: ${fmt(p.start_time)}`, `Where: ${p.venue_address || ''}`] },
      'Show this code at the door:',
      { code: p.check_in_code },
    ]),

  [T.PLUS_ONE_DECISION]: (p) =>
    layout(`Companion request ${p.decision === 'approved' ? 'approved' : 'declined'}: ${p.event_title}`, p.guest_name, [
      p.decision === 'approved'
        ? `The organizer approved your request to bring ${p.companion_name}. You may now bring up to ${p.plus_one_allowance} companion(s).`
        : `The organizer could not approve your request to bring ${p.companion_name}.`,
      ...(p.decision === 'approved'
        ? ['If you have already replied, update your party size using the link in your invitation email.']
        : []),
    ]),

  [T.STAFF_SETUP]: (p) =>
    layout('Set up your Event Manager staff account', p.staff_name, [
      `${p.organizer_name || 'An organizer'} has created a door-staff account for you.`,
      { button: { label: 'Set your password', url: p.setup_url } },
      `This link can be used once and expires in ${p.expires_hours || 48} hours.`,
    ]),
};

/**
 * @param {string} template one of EMAIL_TEMPLATES
 * @param {object} params
 * @returns {{ subject: string, text: string, html: string }}
 */
function renderEmail(template, params) {
  const render = renderers[template];
  if (!render) throw new Error(`No renderer for template ${template}`);
  return render(params || {});
}

module.exports = { renderEmail, esc, fmt };
