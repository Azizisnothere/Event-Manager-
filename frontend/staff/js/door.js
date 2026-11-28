(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;

  var user = EM.requireLogin(['staff', 'organizer'], '../index.html');
  if (!user) return;
  var eventId = ui.param('id');
  if (!eventId) {
    window.location.replace('events.html');
    return;
  }
  var base = '/api/events/' + encodeURIComponent(eventId);
  if (user.role === 'organizer') {
    ui.$('#home-link').setAttribute('href', '../organizer/event.html?id=' + encodeURIComponent(eventId));
  }

  ui.append(ui.$('#user-area'), el('span', { class: 'muted', text: user.name || '' }),
    el('button', { class: 'btn btn-small btn-ghost', text: 'Log out', attrs: { type: 'button' }, on: { click: function () { EM.logout('../index.html'); } } }));

  var liveBox = ui.$('#live');
  var resultBox = ui.$('#result');
  var errorBox = ui.$('#door-error');
  var searchResults = ui.$('#search-results');
  var recentBox = ui.$('#recent');
  var pollTimer = null;

  function stat(label, value, warn) {
    return el('div', { class: 'stat' + (warn ? ' stat-warn' : '') }, el('div', { class: 'stat-value', text: String(value) }), el('div', { class: 'stat-label', text: label }));
  }

  function showResult(ok, text) {
    ui.clear(resultBox);
    resultBox.appendChild(el('p', { class: 'alert big-status ' + (ok ? 'alert-success' : 'alert-error'), text: text }));
  }

  async function refreshLive() {
    try {
      var data = await EM.api(base + '/attendance/live');
      var l = data.live;
      var pct = Math.round(l.occupancy_ratio * 100);
      ui.clear(liveBox);
      ui.append(liveBox,
        stat('Arrived', l.arrived + ' / ' + l.expected),
        stat('Occupancy', pct + '%', l.warning),
        stat('Parties in', l.checked_in_parties + ' / ' + l.confirmed_parties),
        stat('Still expected', l.remaining_expected));
      ui.$('#window-info').textContent = 'Check-in ' + (l.checkin_window.open ? 'open' : 'closed') + ': ' +
        ui.fmtDateTime(l.checkin_window.opens_at) + ' - ' + ui.fmtDateTime(l.checkin_window.closes_at);
      if (l.warning) ui.$('#window-info').textContent += ' | Occupancy at ' + pct + '%: near capacity.';
      EM.showError(errorBox, null);
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }

  async function refreshRecent() {
    try {
      var data = await EM.api(base + '/check-ins', { query: { mine: 'true', limit: 15 } });
      ui.clear(recentBox);
      recentBox.appendChild(
        ui.table(
          [
            { label: 'Guest', render: function (c) { return c.guest_name; } },
            { label: 'People', render: function (c) { return c.people_arrived + ' / ' + c.party_size; } },
            { label: 'Time', render: function (c) { return new Date(c.checked_in_at).toLocaleTimeString(); } },
            { label: 'Status', render: function (c) { return ui.badge(c.status); } },
            { label: 'Actions', render: function (c) {
              return c.can_undo ? el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Undo', attrs: { type: 'button' }, on: { click: function () { undo(c); } } }) : null;
            } },
          ],
          data.check_ins,
          'No check-ins by you yet.',
        ),
      );
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }

  async function refreshAll() {
    clearTimeout(pollTimer);
    await Promise.all([refreshLive(), refreshRecent()]);
    pollTimer = setTimeout(refreshAll, window.EM_CONFIG.POLL_INTERVAL_MS);
  }

  async function checkIn(body) {
    try {
      var data = await EM.api(base + '/check-ins', { method: 'POST', body: body });
      var c = data.check_in;
      showResult(true, 'Welcome, ' + c.guest_name + ' - ' + c.people_arrived + ' of ' + c.party_size + ' checked in.');
      refreshAll();
      return true;
    } catch (err) {
      showResult(false, err.code === 'ALREADY_CHECKED_IN' ? 'Already checked in - do not admit twice.' : EM.errorText(err));
      return false;
    }
  }

  async function undo(c) {
    var reason = ui.askReason('Why are you undoing the check-in of ' + c.guest_name + '?', 3);
    if (!reason) return;
    try {
      await EM.api(base + '/check-ins/' + encodeURIComponent(c.checkin_id), { method: 'PATCH', body: { status: 'voided', void_reason: reason } });
      ui.toast('Check-in undone.', 'success');
      refreshAll();
    } catch (err) {
      ui.toast(EM.errorText(err), 'error');
    }
  }

  var codeForm = ui.$('#code-form');
  codeForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = codeForm.code.value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      showResult(false, 'Enter the 6-character code from the guest\'s email.');
      return;
    }
    var body = { check_in_code: code };
    if (codeForm.people.value) body.people_arrived = Number.parseInt(codeForm.people.value, 10);
    var button = codeForm.querySelector('button[type="submit"]');
    ui.setBusy(button, true, 'Checking...');
    var ok = await checkIn(body);
    ui.setBusy(button, false);
    if (ok) codeForm.reset();
    codeForm.code.focus();
  });

  var searchForm = ui.$('#search-form');
  async function search() {
    var q = searchForm.search.value.trim();
    ui.clear(searchResults);
    if (!q) return;
    try {
      var data = await EM.api(base + '/door-list', { query: { search: q, limit: 25 } });
      if (!data.guests.length) {
        searchResults.appendChild(el('p', { class: 'muted', text: 'No confirmed guest matches "' + q + '".' }));
        return;
      }
      data.guests.forEach(function (g) {
        var people = el('input', { class: 'num', attrs: { type: 'number', min: 1, max: g.party_size, value: g.party_size, 'aria-label': 'People arrived for ' + g.guest_name } });
        var btn = el('button', { class: 'btn btn-small', text: 'Check in', attrs: { type: 'button' } });
        btn.addEventListener('click', async function () {
          ui.setBusy(btn, true, '...');
          await checkIn({ rsvp_id: g.rsvp_id, people_arrived: Number.parseInt(people.value, 10) || g.party_size });
          ui.setBusy(btn, false);
          search();
        });
        searchResults.appendChild(
          el('div', { class: 'guest-row' },
            el('div', null, el('strong', { text: g.guest_name }), el('div', { class: 'small muted', text: 'Party of ' + g.party_size })),
            g.checked_in
              ? el('span', { class: 'badge badge-active', text: 'In (' + g.people_arrived + ')' })
              : el('div', { class: 'row' }, people, btn)),
        );
      });
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }
  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    search();
  });

  EM.api(base)
    .then(function (data) {
      ui.$('#event-title').textContent = data.event.title;
      document.title = 'Door - ' + data.event.title;
    })
    .catch(function (err) { EM.showError(errorBox, err); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAll();
  });
  refreshAll();
})();
