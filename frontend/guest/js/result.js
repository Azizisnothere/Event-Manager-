(function () {
  'use strict';
  var EM = window.EM;
  var G = window.EMGuest;
  var ui = EM.ui;
  var el = ui.el;
  var page = ui.$('#page');

  if (!G.token) {
    G.noTokenMessage(page);
    return;
  }

  async function init() {
    var data;
    try {
      data = await G.loadInvitation();
    } catch (err) {
      G.invalidMessage(page, err);
      return;
    }
    ui.clear(page);
    ui.append(page, G.eventHeader(data), G.nav('result.html'));
    var r = data.rsvp;
    var card = el('div', { class: 'card stack' });
    if (!r) {
      ui.append(card, el('p', { class: 'big-status', text: 'You have not replied yet.' }),
        data.actions.can_reply ? el('a', { class: 'btn', text: 'Reply now', attrs: { href: 'invitation.html' } }) : null);
    } else if (r.status === 'confirmed') {
      ui.append(card,
        el('p', { class: 'big-status', text: 'You are confirmed!' }),
        el('p', { text: 'Party of ' + r.party_size + '. Show this code at the door:' }),
        el('div', { class: 'code-display', text: r.check_in_code, attrs: { 'aria-label': 'Check-in code ' + r.check_in_code.split('').join(' ') } }),
        el('p', { class: 'small muted', text: 'The code was also sent to your email.' }));
    } else if (r.status === 'waitlisted') {
      ui.append(card,
        el('p', { class: 'big-status', text: 'You are on the waitlist' }),
        el('div', { class: 'code-display', text: '#' + r.waitlist_position }),
        el('p', { text: 'Party of ' + r.party_size + '. The event is full right now. If seats become free you will be confirmed automatically and receive your check-in code by email.' }));
    } else {
      ui.append(card, el('p', { class: 'big-status', text: G.statusText(r) }));
    }
    if (r && r.dietary_notes) card.appendChild(el('p', { class: 'small muted', text: 'Dietary notes: ' + r.dietary_notes }));
    if (data.actions.can_change || data.actions.can_cancel) {
      card.appendChild(el('a', { class: 'btn btn-ghost', text: 'Change or cancel my reply', attrs: { href: 'manage.html' } }));
    }
    page.appendChild(card);
  }
  init();
})();
