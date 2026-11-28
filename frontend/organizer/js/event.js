(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  if (!EM.currentUser) return;

  var eventId = ui.param('id');
  var summary = ui.$('#event-summary');
  var panel = ui.$('#tab-panel');
  var errorBox = ui.$('#page-error');
  var current = { event: null, stats: null };
  var activeTab = null;
  var cleanup = null;

  if (!eventId) {
    window.location.replace('dashboard.html');
    return;
  }
  var base = '/api/events/' + encodeURIComponent(eventId);

  var flash = sessionStorage.getItem('em_flash');
  if (flash) {
    sessionStorage.removeItem('em_flash');
    var fbox = ui.$('#flash');
    fbox.textContent = flash;
    fbox.hidden = false;
  }

  async function changeStatus(target, label) {
    var body = { status: target };
    if (target === 'cancelled') {
      if (!window.confirm('Cancel this event? All replies will be cancelled and guests will be emailed. This cannot be undone.')) return;
      var reason = window.prompt('Reason shown to guests (optional, at least 3 characters):', '');
      if (reason === null) return;
      reason = reason.trim();
      if (reason.length >= 3) body.reason = reason.slice(0, 300);
    } else if (target === 'published') {
      if (!window.confirm('Publish the event and email every invitation now?')) return;
    } else if (target === 'completed') {
      if (!window.confirm('Mark the event as completed? Check-ins are then closed and the report is generated.')) return;
    } else if (!window.confirm(label + '?')) {
      return;
    }
    try {
      var data = await EM.api(base + '/status', { method: 'PATCH', body: body });
      ui.toast(
        target === 'published' ? 'Published. ' + data.invitations_emailed + ' invitation(s) queued for email.' : 'Status changed to ' + ui.statusLabel(data.event.status) + '.',
        'success',
      );
      await loadEvent();
      showTab(activeTab);
    } catch (err) {
      ui.toast(EM.errorText(err), 'error');
    }
  }

  function renderSummary() {
    var ev = current.event;
    var s = current.stats;
    ui.clear(summary);
    var actions = el('div', { class: 'row' });
    var addAction = function (label, cls, fn) {
      actions.appendChild(el('button', { class: 'btn btn-small ' + (cls || ''), text: label, attrs: { type: 'button' }, on: { click: fn } }));
    };
    if (['draft', 'published', 'rsvp_closed'].indexOf(ev.status) !== -1) {
      actions.appendChild(el('a', { class: 'btn btn-small btn-ghost', text: 'Edit', attrs: { href: 'event-form.html?id=' + encodeURIComponent(eventId) } }));
    }
    if (ev.status === 'draft') addAction('Publish', 'btn-ok', function () { changeStatus('published'); });
    if (ev.status === 'published') addAction('Close RSVPs', '', function () { changeStatus('rsvp_closed', 'Close RSVPs now'); });
    if (ev.status === 'rsvp_closed') addAction('Complete event', '', function () { changeStatus('completed'); });
    if (['draft', 'published', 'rsvp_closed'].indexOf(ev.status) !== -1) {
      addAction('Cancel event', 'btn-danger-ghost', function () { changeStatus('cancelled'); });
    }
    if (['published', 'rsvp_closed'].indexOf(ev.status) !== -1) {
      actions.appendChild(el('a', { class: 'btn btn-small btn-ghost', text: 'Open door app', attrs: { href: '../staff/door.html?id=' + encodeURIComponent(eventId) } }));
    }

    var mapLink = ev.venue_verified ? ui.mapUrl(ev.venue_lat, ev.venue_lng) : null;
    ui.append(
      summary,
      el('div', { class: 'row row-between' }, el('div', null, el('h1', { text: ev.title }), ui.badge(ev.status)), actions),
      ev.description ? el('p', { class: 'muted', text: ev.description }) : null,
      el(
        'dl',
        { class: 'meta' },
        el('dt', { text: 'When' }),
        el('dd', { text: ui.fmtDateTime(ev.start_time) + ' - ' + ui.fmtDateTime(ev.end_time) }),
        el('dt', { text: 'RSVP deadline' }),
        el('dd', { text: ui.fmtDateTime(ev.rsvp_deadline) + ' (' + ui.relTime(ev.rsvp_deadline) + ')' }),
        el('dt', { text: 'Venue' }),
        el(
          'dd',
          null,
          ev.venue_address + ' ',
          ev.venue_verified ? (mapLink ? ui.externalLink(mapLink, 'map') : null) : el('span', { class: 'badge badge-flag', text: 'not verified' }),
        ),
        ev.cancel_reason ? el('dt', { text: 'Cancel reason' }) : null,
        ev.cancel_reason ? el('dd', { text: ev.cancel_reason }) : null,
      ),
      el(
        'div',
        { class: 'grid-stats' },
        stat('Confirmed', s.confirmed_headcount + ' / ' + ev.capacity),
        stat('Waitlisted', s.waitlisted_headcount),
        stat('Invited people', s.invited_headcount + ' / ' + ev.invite_limit),
        stat('Invitations', s.invited_count + (s.pending_invitations ? ' (' + s.pending_invitations + ' not sent)' : '')),
        stat('Companion requests', s.pending_plus_one_requests + ' pending'),
        stat('Staff assigned', s.staff_count),
      ),
    );
  }

  function stat(label, value) {
    return el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: String(value) }), el('div', { class: 'stat-label', text: label }));
  }

  async function loadEvent() {
    try {
      var data = await EM.api(base);
      current.event = data.event;
      current.stats = data.stats;
      document.title = data.event.title + ' - Event Manager';
      renderSummary();
    } catch (err) {
      EM.showError(errorBox, err);
      throw err;
    }
  }

  var ctx = {
    eventId: eventId,
    base: base,
    getEvent: function () { return current.event; },
    refreshSummary: function () { return loadEvent().catch(function () {}); },
  };

  function showTab(name) {
    if (typeof cleanup === 'function') cleanup();
    cleanup = null;
    activeTab = name;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    });
    ui.clear(panel);
    var tab = window.EMTabs && window.EMTabs[name];
    if (tab) cleanup = tab.mount(panel, ctx) || null;
  }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });

  loadEvent().then(function () { showTab('guests'); }).catch(function () {});
})();
