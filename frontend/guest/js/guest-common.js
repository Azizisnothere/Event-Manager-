/*
 * Guest pages: the personal invitation token comes from the URL fragment (#t=...), which is
 * never sent to the web server or in Referer headers (A36). It is moved to sessionStorage and
 * removed from the address bar so it does not linger in screenshots or shared screens.
 * Guests never use ids: every API call uses the token (Threat 2).
 */
(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  var KEY = 'em_guest_token';

  function readToken() {
    var m = /(?:^#|&)t=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
    if (m) {
      sessionStorage.setItem(KEY, m[1]);
      history.replaceState(null, '', window.location.pathname);
      return m[1];
    }
    return sessionStorage.getItem(KEY);
  }

  var token = readToken();

  function apiPath(suffix) {
    return '/api/invitations/' + encodeURIComponent(token) + (suffix || '');
  }

  async function loadInvitation() {
    return EM.api(apiPath(), { auth: false });
  }

  function noTokenMessage(container) {
    ui.clear(container);
    container.appendChild(
      el('div', { class: 'card' }, el('h1', { text: 'Invitation link needed' }),
        el('p', { text: 'Please open the personal link from your invitation email. Links cannot be shared and stop working if the invitation is revoked or re-sent.' })),
    );
  }

  function invalidMessage(container, err) {
    ui.clear(container);
    var text = err && err.status === 404
      ? 'This invitation link is not valid. It may have been replaced by a newer email or revoked by the organizer.'
      : EM.errorText(err);
    container.appendChild(el('div', { class: 'card' }, el('h1', { text: 'Invitation not available' }), el('p', { class: 'alert alert-error', text: text })));
  }

  /** Event header used by every guest page. */
  function eventHeader(data) {
    var ev = data.event;
    return el(
      'section',
      { class: 'hero' },
      el('p', { class: 'muted', text: (ev.host_name ? ev.host_name + ' invites ' : 'Invitation for ') + data.invitation.guest_name }),
      el('h1', { text: ev.title }),
      el('p', null, ui.fmtDateTime(ev.start_time) + ' - ' + ui.fmtDateTime(ev.end_time)),
      el('p', null, ev.venue_address, ' ', ev.map_url ? ui.externalLink(ev.map_url, '(map)') : null),
      ev.status === 'cancelled' ? el('p', { class: 'alert alert-error', text: 'This event has been cancelled.' + (ev.cancel_reason ? ' ' + ev.cancel_reason : '') }) : null,
    );
  }

  function nav(current) {
    var links = [
      ['invitation.html', 'Invitation'],
      ['result.html', 'My status'],
      ['manage.html', 'Manage my reply'],
      ['companion.html', 'Bring a companion'],
    ];
    return el('nav', { class: 'row small', attrs: { 'aria-label': 'Invitation pages' } },
      links.map(function (l) {
        return l[0] === current ? el('strong', { text: l[1] }) : el('a', { text: l[1], attrs: { href: l[0] } });
      }));
  }

  /**
   * Renders the Turnstile widget (explicit mode) and returns { getToken, reset }.
   * The server verifies the token before doing anything else (Threat 6).
   */
  function mountTurnstile(container) {
    var state = { token: null, widgetId: null };
    var box = el('div', { class: 'turnstile-box' });
    container.appendChild(box);
    function render() {
      if (!window.turnstile) {
        setTimeout(render, 200);
        return;
      }
      state.widgetId = window.turnstile.render(box, {
        sitekey: window.EM_CONFIG.TURNSTILE_SITE_KEY,
        callback: function (t) { state.token = t; },
        'expired-callback': function () { state.token = null; },
        'error-callback': function () { state.token = null; },
      });
    }
    render();
    return {
      getToken: function () { return state.token; },
      reset: function () {
        state.token = null;
        if (window.turnstile && state.widgetId !== null) window.turnstile.reset(state.widgetId);
      },
    };
  }

  function statusText(rsvp) {
    if (!rsvp) return 'You have not replied yet.';
    switch (rsvp.status) {
      case 'confirmed': return 'You are confirmed for ' + rsvp.party_size + (rsvp.party_size === 1 ? ' person.' : ' people.');
      case 'waitlisted': return 'You are on the waitlist (position ' + rsvp.waitlist_position + ') for ' + rsvp.party_size + '.';
      case 'declined': return 'You declined this invitation.';
      case 'cancelled_by_guest': return 'You cancelled your attendance.';
      case 'cancelled_by_organizer': return 'Your reply was cancelled by the organizer.';
      case 'event_cancelled': return 'The event was cancelled.';
      default: return ui.statusLabel(rsvp.status);
    }
  }

  window.EMGuest = {
    token: token,
    apiPath: apiPath,
    loadInvitation: loadInvitation,
    noTokenMessage: noTokenMessage,
    invalidMessage: invalidMessage,
    eventHeader: eventHeader,
    nav: nav,
    mountTurnstile: mountTurnstile,
    statusText: statusText,
  };
})();
