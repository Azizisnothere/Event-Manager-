/* Staff tab: create staff accounts (setup link by email), assign and unassign. */
(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  window.EMTabs.staff = {
    mount: function (container, ctx) {
      var msg = el('div', { attrs: { hidden: true } });
      var assignedBox = el('div');
      var allBox = el('div');
      var assignedIds = new Set();

      var nameIn = el('input', { attrs: { type: 'text', id: 's-name', maxlength: 100, required: true } });
      var emailIn = el('input', { attrs: { type: 'email', id: 's-email', maxlength: 254, required: true } });
      var createForm = el(
        'form',
        { class: 'inline-form', attrs: { novalidate: true } },
        el('div', { class: 'field' }, el('label', { text: 'Name', attrs: { for: 's-name' } }), nameIn),
        el('div', { class: 'field' }, el('label', { text: 'Email', attrs: { for: 's-email' } }), emailIn),
        el('button', { class: 'btn', text: 'Create staff account', attrs: { type: 'submit' } }),
      );
      createForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        EM.showError(msg, null);
        if (!nameIn.value.trim() || !emailIn.value.trim()) {
          EM.showError(msg, new EM.ApiError(400, 'VALIDATION', 'Enter the staff member\'s name and email.'));
          return;
        }
        try {
          await EM.api('/api/staff', { method: 'POST', body: { name: nameIn.value.trim(), email: emailIn.value.trim() } });
          ui.toast('Staff account created. A one-time setup link (valid 48 hours) was emailed.', 'success');
          createForm.reset();
          load();
        } catch (err) {
          EM.showError(msg, err);
        }
      });

      async function assign(s) {
        try {
          await EM.api(ctx.base + '/staff', { method: 'POST', body: { user_id: s.user_id } });
          ui.toast(s.name + ' assigned to this event.', 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function unassign(s) {
        if (!window.confirm('Remove ' + s.name + ' from this event?')) return;
        try {
          await EM.api(ctx.base + '/staff/' + encodeURIComponent(s.user_id), { method: 'DELETE' });
          ui.toast(s.name + ' unassigned.', 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function load() {
        try {
          var ev = ctx.getEvent();
          var closed = ['completed', 'cancelled'].indexOf(ev.status) !== -1;
          var assigned = await EM.api(ctx.base + '/staff');
          var all = await EM.api('/api/staff', { query: { limit: 200 } });
          assignedIds = new Set(assigned.staff.map(function (s) { return s.user_id; }));
          ui.clear(assignedBox);
          assignedBox.appendChild(
            ui.table(
              [
                { label: 'Name', render: function (s) { return s.name; } },
                { label: 'Email', render: function (s) { return s.email; } },
                { label: 'Account', render: function (s) { return ui.badge(s.status); } },
                { label: 'Assigned', render: function (s) { return ui.fmtDateTime(s.assigned_at); } },
                { label: 'Actions', render: function (s) {
                  return closed ? null : el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Unassign', attrs: { type: 'button' }, on: { click: function () { unassign(s); } } });
                } },
              ],
              assigned.staff,
              'No staff assigned yet.',
            ),
          );
          ui.clear(allBox);
          allBox.appendChild(
            ui.table(
              [
                { label: 'Name', render: function (s) { return s.name; } },
                { label: 'Email', render: function (s) { return s.email; } },
                { label: 'Account', render: function (s) { return ui.badge(s.status); } },
                { label: 'Events', render: function (s) { return String(s.assigned_events); } },
                { label: 'Actions', render: function (s) {
                  if (closed || assignedIds.has(s.user_id) || s.status === 'disabled') return null;
                  return el('button', { class: 'btn btn-small', text: 'Assign to this event', attrs: { type: 'button' }, on: { click: function () { assign(s); } } });
                } },
              ],
              all.staff,
              'You have not created any staff accounts yet.',
            ),
          );
        } catch (err) {
          EM.showError(msg, err);
        }
      }

      ui.append(
        container,
        msg,
        el('div', { class: 'card stack' }, el('h2', { text: 'Create a staff account' }),
          el('p', { class: 'small muted', text: 'Staff only see the events you assign them to, and never see guest emails or dietary notes.' }), createForm),
        el('h2', { text: 'Assigned to this event' }),
        assignedBox,
        el('h2', { text: 'Your staff' }),
        allBox,
      );
      load();
      return null;
    },
  };
})();
