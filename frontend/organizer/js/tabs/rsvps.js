(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  window.EMTabs.rsvps = {
    mount: function (container, ctx) {
      var state = { offset: 0, limit: 50, total: 0, search: '', status: '' };
      var listBox = el('div');
      var msg = el('div', { attrs: { hidden: true } });

      async function cancelRsvp(r) {
        var reason = ui.askReason('Why are you cancelling the reply from ' + r.guest_name + '? (kept in the audit log)', 3);
        if (!reason) return;
        try {
          var data = await EM.api(ctx.base + '/rsvps/' + encodeURIComponent(r.rsvp_id), {
            method: 'PATCH',
            body: { status: 'cancelled_by_organizer', reason: reason },
          });
          ui.toast('Reply cancelled.' + (data.promoted.length ? ' ' + data.promoted.length + ' guest(s) promoted from the waitlist.' : ''), 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function load() {
        EM.showError(msg, null);
        try {
          var data = await EM.api(ctx.base + '/rsvps', { query: { search: state.search, status: state.status, limit: state.limit, offset: state.offset } });
          state.total = data.total;
          var ev = ctx.getEvent();
          ui.clear(listBox);
          listBox.appendChild(
            ui.table(
              [
                { label: 'Name', render: function (r) { return r.guest_name; } },
                { label: 'Email', render: function (r) { return r.guest_email; } },
                { label: 'Status', render: function (r) { return ui.badge(r.status); } },
                { label: 'Party', render: function (r) { return String(r.party_size); } },
                { label: 'Dietary notes', render: function (r) { return r.dietary_notes; } },
                { label: 'Code', render: function (r) { return r.status === 'confirmed' ? el('code', { text: r.check_in_code }) : null; } },
                { label: 'Replied', render: function (r) { return ui.fmtDateTime(r.responded_at); } },
                { label: 'Note', render: function (r) { return r.cancel_reason; } },
                { label: 'Actions', render: function (r) {
                  if (['confirmed', 'waitlisted'].indexOf(r.status) === -1 || ['completed', 'cancelled'].indexOf(ev.status) !== -1) return null;
                  return el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Cancel reply', attrs: { type: 'button' }, on: { click: function () { cancelRsvp(r); } } });
                } },
              ],
              data.rsvps,
              'No replies match.',
            ),
          );
          listBox.appendChild(ui.pager(state, function (o) { state.offset = o; load(); }));
        } catch (err) {
          EM.showError(msg, err);
        }
      }

      var searchIn = el('input', { attrs: { type: 'search', placeholder: 'Search name or email', maxlength: 100, 'aria-label': 'Search replies' } });
      var statusSel = el('select', { attrs: { 'aria-label': 'Reply status' } },
        el('option', { text: 'All replies', attrs: { value: '' } }),
        ['confirmed', 'waitlisted', 'declined', 'cancelled_by_guest', 'cancelled_by_organizer', 'event_cancelled'].map(function (s) {
          return el('option', { text: ui.statusLabel(s), attrs: { value: s } });
        }));
      searchIn.addEventListener('input', ui.debounce(function () { state.search = searchIn.value.trim(); state.offset = 0; load(); }, 300));
      statusSel.addEventListener('change', function () { state.status = statusSel.value; state.offset = 0; load(); });

      ui.append(container, msg, el('div', { class: 'row' }, el('div', { class: 'field' }, searchIn), statusSel), listBox);
      load();
      return null;
    },
  };
})();
