(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  if (!EM.currentUser) return;

  var list = ui.$('#events');
  var pagerBox = ui.$('#events-pager');
  var errorBox = ui.$('#dashboard-error');
  var filter = ui.$('#status-filter');
  var state = { offset: 0, limit: 24, total: 0 };

  function eventCard(ev) {
    return el(
      'a',
      { class: 'card card-link', attrs: { href: 'event.html?id=' + encodeURIComponent(ev.event_id) } },
      el('div', { class: 'row row-between' }, el('h3', { text: ev.title }), ui.badge(ev.status)),
      el('p', { class: 'muted small', text: ui.fmtDateTime(ev.start_time) + ' (' + ui.relTime(ev.start_time) + ')' }),
      el('p', { class: 'small', text: ev.venue_address }),
      el(
        'dl',
        { class: 'meta small' },
        el('dt', { text: 'Confirmed' }),
        el('dd', { text: ev.confirmed_headcount + ' / ' + ev.capacity + ' seats' }),
        el('dt', { text: 'Waitlisted' }),
        el('dd', { text: String(ev.waitlisted_headcount) }),
        el('dt', { text: 'Invited' }),
        el('dd', { text: ev.invited_headcount + ' / ' + ev.invite_limit + ' people (' + ev.invited_count + ' invitations)' }),
      ),
      ev.venue_verified ? null : el('p', { class: 'small badge badge-flag', text: 'Venue not verified' }),
    );
  }

  async function load() {
    EM.showError(errorBox, null);
    try {
      var data = await EM.api('/api/events', { query: { status: filter.value, limit: state.limit, offset: state.offset } });
      state.total = data.total;
      ui.clear(list);
      if (!data.events.length) {
        list.appendChild(
          el('div', { class: 'card' }, el('p', { text: filter.value ? 'No events with this status.' : 'You have no events yet.' }), el('a', { class: 'btn', text: 'Create your first event', attrs: { href: 'event-form.html' } })),
        );
      }
      data.events.forEach(function (ev) {
        list.appendChild(eventCard(ev));
      });
      ui.clear(pagerBox);
      if (state.total > state.limit) {
        pagerBox.appendChild(ui.pager(state, function (o) { state.offset = o; load(); }));
      }
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }

  filter.addEventListener('change', function () {
    state.offset = 0;
    load();
  });
  load();
})();
