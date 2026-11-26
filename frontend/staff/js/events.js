(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;

  var user = EM.requireLogin(['staff', 'organizer'], '../index.html');
  if (!user) return;
  if (user.role === 'organizer') {
    window.location.replace('../organizer/dashboard.html');
    return;
  }

  var area = ui.$('#user-area');
  ui.append(area, el('span', { class: 'muted', text: user.name || '' }),
    el('button', { class: 'btn btn-small btn-ghost', text: 'Log out', attrs: { type: 'button' }, on: { click: function () { EM.logout('../index.html'); } } }));

  var list = ui.$('#events');
  var errorBox = ui.$('#events-error');

  async function load() {
    try {
      var data = await EM.api('/api/events', { query: { limit: 100 } });
      ui.clear(list);
      if (!data.events.length) {
        list.appendChild(el('div', { class: 'card' }, el('p', { text: 'You are not assigned to any events yet. Ask the organizer to assign you.' })));
      }
      data.events.forEach(function (ev) {
        var doorOpen = ['published', 'rsvp_closed'].indexOf(ev.status) !== -1;
        list.appendChild(
          el(
            doorOpen ? 'a' : 'div',
            { class: 'card' + (doorOpen ? ' card-link' : ''), attrs: doorOpen ? { href: 'door.html?id=' + encodeURIComponent(ev.event_id) } : {} },
            el('div', { class: 'row row-between' }, el('h3', { text: ev.title }), ui.badge(ev.status)),
            el('p', { class: 'small muted', text: ui.fmtDateTime(ev.start_time) + ' (' + ui.relTime(ev.start_time) + ')' }),
            el('p', { class: 'small', text: ev.venue_address }),
            doorOpen ? el('span', { class: 'btn btn-small', text: 'Open door app' }) : el('p', { class: 'small muted', text: 'The door app is not available for this event.' }),
          ),
        );
      });
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }
  load();
})();
