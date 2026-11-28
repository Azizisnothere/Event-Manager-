(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  function stat(label, value, warn) {
    return el('div', { class: 'stat' + (warn ? ' stat-warn' : '') }, el('div', { class: 'stat-value', text: String(value) }), el('div', { class: 'stat-label', text: label }));
  }

  window.EMTabs.live = {
    mount: function (container, ctx) {
      var liveBox = el('div', { class: 'stack', attrs: { 'aria-live': 'polite' } });
      var historyBox = el('div');
      var msg = el('div', { attrs: { hidden: true } });
      var timer = null;
      var alive = true;

      async function undo(c) {
        var reason = ui.askReason('Why are you undoing the check-in of ' + c.guest_name + '?', 3);
        if (!reason) return;
        try {
          await EM.api(ctx.base + '/check-ins/' + encodeURIComponent(c.checkin_id), { method: 'PATCH', body: { status: 'voided', void_reason: reason } });
          ui.toast('Check-in undone. The record is kept with your reason.', 'success');
          refresh();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function refresh() {
        if (!alive) return;
        try {
          var data = await EM.api(ctx.base + '/attendance/live');
          var l = data.live;
          var pct = Math.round(l.occupancy_ratio * 100);
          var fill = el('div', { class: 'bar-fill' + (l.warning ? ' warn' : '') });
          fill.style.width = Math.min(100, pct) + '%';
          ui.clear(liveBox);
          ui.append(
            liveBox,
            l.warning ? el('p', { class: 'alert alert-warn', text: 'Occupancy is at ' + pct + '% of capacity (warning at ' + Math.round(l.warning_threshold * 100) + '%).' }) : null,
            el('div', { class: 'grid-stats' },
              stat('Arrived', l.arrived + ' / ' + l.expected + ' expected'),
              stat('Occupancy', pct + '% of ' + l.capacity, l.warning),
              stat('Parties checked in', l.checked_in_parties + ' / ' + l.confirmed_parties),
              stat('Still expected', l.remaining_expected)),
            el('div', { class: 'bar', attrs: { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Occupancy' } }, fill),
            el('p', { class: 'small muted', text: 'Check-in window: ' + ui.fmtDateTime(l.checkin_window.opens_at) + ' - ' + ui.fmtDateTime(l.checkin_window.closes_at) +
              (l.checkin_window.open ? ' (open now)' : ' (closed)') + '. Updated ' + new Date(l.generated_at).toLocaleTimeString() + '.' }),
          );
          var hist = await EM.api(ctx.base + '/check-ins', { query: { limit: 100 } });
          ui.clear(historyBox);
          historyBox.appendChild(
            ui.table(
              [
                { label: 'Guest', render: function (c) { return c.guest_name; } },
                { label: 'People', render: function (c) { return c.people_arrived + ' / ' + c.party_size; } },
                { label: 'Time', render: function (c) { return ui.fmtDateTime(c.checked_in_at); } },
                { label: 'By', render: function (c) { return c.checked_in_by_name; } },
                { label: 'Status', render: function (c) { return ui.badge(c.status); } },
                { label: 'Undo reason', render: function (c) { return c.void_reason ? c.void_reason + ' (' + c.voided_by_name + ')' : null; } },
                { label: 'Actions', render: function (c) {
                  return c.can_undo ? el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Undo', attrs: { type: 'button' }, on: { click: function () { undo(c); } } }) : null;
                } },
              ],
              hist.check_ins,
              'No check-ins yet.',
            ),
          );
          EM.showError(msg, null);
        } catch (err) {
          EM.showError(msg, err);
        }
        clearTimeout(timer);
        if (alive) timer = setTimeout(refresh, window.EM_CONFIG.POLL_INTERVAL_MS);
      }

      ui.append(container, msg, liveBox, el('h2', { text: 'Check-in history' }), historyBox);
      refresh();
      return function () {
        alive = false;
        clearTimeout(timer);
      };
    },
  };
})();
