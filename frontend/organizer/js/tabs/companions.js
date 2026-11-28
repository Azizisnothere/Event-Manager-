(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  window.EMTabs.companions = {
    mount: function (container, ctx) {
      var state = { offset: 0, limit: 50, total: 0, status: 'pending' };
      var listBox = el('div');
      var msg = el('div', { attrs: { hidden: true } });

      async function decide(r, decision) {
        try {
          var data = await EM.api(ctx.base + '/plus-one-requests/' + encodeURIComponent(r.request_id), { method: 'PATCH', body: { decision: decision } });
          ui.toast(decision === 'approved' ? r.guest_name + ' may now bring ' + data.invitation.plus_one_allowance + ' companion(s).' : 'Request declined.', 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function load() {
        EM.showError(msg, null);
        try {
          var data = await EM.api(ctx.base + '/plus-one-requests', { query: { status: state.status, limit: state.limit, offset: state.offset } });
          state.total = data.total;
          ui.clear(listBox);
          listBox.appendChild(
            ui.table(
              [
                { label: 'Guest', render: function (r) { return r.guest_name; } },
                { label: 'Email', render: function (r) { return r.guest_email; } },
                { label: 'Allowed now', render: function (r) { return String(r.current_allowance); } },
                { label: 'Companion', render: function (r) { return r.companion_name; } },
                { label: 'Note', render: function (r) { return r.note; } },
                { label: 'Status', render: function (r) { return ui.badge(r.status); } },
                { label: 'Requested', render: function (r) { return ui.fmtDateTime(r.created_at); } },
                { label: 'Actions', render: function (r) {
                  if (r.status !== 'pending') return null;
                  return el('div', { class: 'actions' },
                    el('button', { class: 'btn btn-small btn-ok', text: 'Approve', attrs: { type: 'button' }, on: { click: function () { decide(r, 'approved'); } } }),
                    el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Deny', attrs: { type: 'button' }, on: { click: function () { decide(r, 'denied'); } } }));
                } },
              ],
              data.requests,
              'No requests.',
            ),
          );
          listBox.appendChild(ui.pager(state, function (o) { state.offset = o; load(); }));
        } catch (err) {
          EM.showError(msg, err);
        }
      }

      var statusSel = el('select', { attrs: { 'aria-label': 'Request status' } },
        el('option', { text: 'Pending', attrs: { value: 'pending' } }),
        el('option', { text: 'Approved', attrs: { value: 'approved' } }),
        el('option', { text: 'Denied', attrs: { value: 'denied' } }),
        el('option', { text: 'All', attrs: { value: '' } }));
      statusSel.addEventListener('change', function () { state.status = statusSel.value; state.offset = 0; load(); });

      ui.append(container, msg,
        el('p', { class: 'small muted', text: 'Approving adds one to the guest\'s allowance, up to 3, and only if the invite limit allows it.' }),
        el('div', { class: 'row' }, statusSel), listBox);
      load();
      return null;
    },
  };
})();
