(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  window.EMTabs.guests = {
    mount: function (container, ctx) {
      var ev = ctx.getEvent();
      var open = ['draft', 'published'].indexOf(ev.status) !== -1;
      var state = { offset: 0, limit: 50, total: 0, search: '', status: '', repeat: false };
      var listBox = el('div');
      var msg = el('div', { attrs: { hidden: true } });
      var pollTimer = null;
      var alive = true;

      var nameIn = el('input', { attrs: { type: 'text', id: 'g-name', maxlength: 100, required: true } });
      var emailIn = el('input', { attrs: { type: 'email', id: 'g-email', maxlength: 254, required: true } });
      var allowIn = el('select', { attrs: { id: 'g-allow' } }, [0, 1, 2, 3].map(function (n) { return el('option', { text: String(n), attrs: { value: n } }); }));
      var catIn = el('input', { attrs: { type: 'text', id: 'g-cat', maxlength: 50, placeholder: 'e.g. VIP' } });
      var addForm = el(
        'form',
        { class: 'inline-form', attrs: { novalidate: true } },
        el('div', { class: 'field' }, el('label', { text: 'Name', attrs: { for: 'g-name' } }), nameIn),
        el('div', { class: 'field' }, el('label', { text: 'Email', attrs: { for: 'g-email' } }), emailIn),
        el('div', { class: 'field' }, el('label', { text: 'Companions allowed', attrs: { for: 'g-allow' } }), allowIn),
        el('div', { class: 'field' }, el('label', { text: 'Category (optional)', attrs: { for: 'g-cat' } }), catIn),
        el('button', { class: 'btn', text: 'Add guest', attrs: { type: 'submit' } }),
      );
      addForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        EM.showError(msg, null);
        var guest = { guest_name: nameIn.value.trim(), guest_email: emailIn.value.trim(), plus_one_allowance: Number(allowIn.value) };
        if (catIn.value.trim()) guest.category = catIn.value.trim();
        if (!guest.guest_name || !guest.guest_email) {
          EM.showError(msg, new EM.ApiError(400, 'VALIDATION', 'Enter the guest name and email.'));
          return;
        }
        try {
          var data = await EM.api(ctx.base + '/invitations', { method: 'POST', body: { guests: [guest] } });
          if (data.added.length) {
            ui.toast('Guest added' + (ev.status === 'published' ? ' and invitation emailed.' : '.'), 'success');
            addForm.reset();
          } else if (data.skipped.length) {
            EM.showError(msg, new EM.ApiError(409, 'DUPLICATE', 'Not added: ' + data.skipped[0].reason.replace(/_/g, ' ') + '.'));
          }
          load();
          ctx.refreshSummary();
        } catch (err) {
          EM.showError(msg, err);
        }
      });

      var fileIn = el('input', { attrs: { type: 'file', accept: '.csv,text/csv', id: 'g-file' } });
      var importStatus = el('div', { class: 'small', attrs: { 'aria-live': 'polite' } });
      var uploadBtn = el('button', { class: 'btn btn-ghost', text: 'Upload CSV', attrs: { type: 'button' } });

      function renderImport(imp) {
        ui.clear(importStatus);
        ui.append(importStatus, el('p', null, 'Import status: ', ui.badge(imp.status)));
        if (imp.status === 'completed') {
          ui.append(importStatus, el('p', { text: imp.rows_added + ' guest(s) added, ' + imp.rows_skipped + ' row(s) skipped.' }));
        }
        if (imp.failure_reason) ui.append(importStatus, el('p', { class: 'alert alert-error', text: imp.failure_reason }));
        if (imp.row_errors && imp.row_errors.length) {
          ui.append(
            importStatus,
            el('details', null, el('summary', { text: 'Row errors (' + imp.row_errors.length + ')' }),
              el('ul', null, imp.row_errors.map(function (r) { return el('li', { text: 'Line ' + r.line + ': ' + r.errors.join(', ') }); }))),
          );
        }
      }

      async function pollImport(importId, tries) {
        if (!alive) return;
        try {
          var data = await EM.api(ctx.base + '/invitations/imports/' + encodeURIComponent(importId));
          renderImport(data.import);
          if (['completed', 'failed'].indexOf(data.import.status) !== -1) {
            if (data.import.status === 'completed') {
              load();
              ctx.refreshSummary();
            }
            return;
          }
        } catch (err) {
          EM.showError(importStatus, err);
          return;
        }
        if (tries < 60) pollTimer = setTimeout(function () { pollImport(importId, tries + 1); }, 2000);
        else ui.append(importStatus, el('p', { class: 'muted', text: 'Still processing. Refresh the page later to see the result.' }));
      }

      uploadBtn.addEventListener('click', async function () {
        var file = fileIn.files && fileIn.files[0];
        if (!file) {
          ui.toast('Choose a CSV file first.', 'error');
          return;
        }
        if (file.size > 1024 * 1024) {
          ui.toast('The file must be smaller than 1 MB.', 'error');
          return;
        }
        ui.setBusy(uploadBtn, true, 'Uploading...');
        try {
          var created = await EM.api(ctx.base + '/invitations/imports', { method: 'POST', body: {} });
          var put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: file, referrerPolicy: 'no-referrer' });
          if (!put.ok) throw new EM.ApiError(put.status, 'UPLOAD_FAILED', 'The upload failed (' + put.status + '). Try again.');
          renderImport(created.import);
          pollImport(created.import.import_id, 0);
        } catch (err) {
          EM.showError(importStatus, err);
        } finally {
          ui.setBusy(uploadBtn, false);
        }
      });

      var searchIn = el('input', { attrs: { type: 'search', placeholder: 'Search name or email', maxlength: 100, 'aria-label': 'Search guests' } });
      var statusSel = el('select', { attrs: { 'aria-label': 'Invitation status' } },
        el('option', { text: 'All invitations', attrs: { value: '' } }),
        ['pending', 'sent', 'responded', 'revoked'].map(function (s) { return el('option', { text: ui.statusLabel(s), attrs: { value: s } }); }));
      var repeatChk = el('input', { attrs: { type: 'checkbox', id: 'g-repeat' } });

      async function resend(inv) {
        try {
          var data = await EM.api(ctx.base + '/invitations/' + encodeURIComponent(inv.invitation_id) + '/resend', { method: 'POST', body: {} });
          ui.toast('Invitation resent (' + data.resends_remaining_today + ' resend(s) left today). The old link no longer works.', 'success');
          load();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function revoke(inv) {
        if (!window.confirm('Revoke the invitation for ' + inv.guest_name + '? Their link stops working and any seat is freed.')) return;
        try {
          await EM.api(ctx.base + '/invitations/' + encodeURIComponent(inv.invitation_id), { method: 'DELETE' });
          ui.toast('Invitation revoked.', 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function load() {
        try {
          var data = await EM.api(ctx.base + '/invitations', {
            query: { search: state.search, status: state.status, repeat_no_show: state.repeat ? 'true' : '', limit: state.limit, offset: state.offset },
          });
          state.total = data.total;
          var current = ctx.getEvent();
          ui.clear(listBox);
          listBox.appendChild(
            ui.table(
              [
                { label: 'Name', render: function (r) {
                  return el('span', null, r.guest_name, r.repeat_no_show ? el('span', { class: 'badge badge-flag', text: ' Repeat no-show (' + r.previous_no_shows + ')', attrs: { title: 'No-shows at your earlier events' } }) : null);
                } },
                { label: 'Email', render: function (r) { return r.guest_email; } },
                { label: 'Companions', render: function (r) { return String(r.plus_one_allowance); } },
                { label: 'Category', render: function (r) { return r.category; } },
                { label: 'Invitation', render: function (r) { return ui.badge(r.status); } },
                { label: 'Reply', render: function (r) { return r.rsvp_status ? el('span', null, ui.badge(r.rsvp_status), r.party_size ? ' x' + r.party_size : '') : el('span', { class: 'muted', text: 'No reply' }); } },
                { label: 'Checked in', render: function (r) { return r.checked_in ? 'Yes' : 'No'; } },
                { label: 'Actions', render: function (r) {
                  if (r.status === 'revoked') return null;
                  var a = el('div', { class: 'actions' });
                  if (current.status === 'published') a.appendChild(el('button', { class: 'btn btn-small btn-ghost', text: 'Resend', attrs: { type: 'button' }, on: { click: function () { resend(r); } } }));
                  if (['completed', 'cancelled'].indexOf(current.status) === -1 && !r.checked_in) {
                    a.appendChild(el('button', { class: 'btn btn-small btn-danger-ghost', text: 'Revoke', attrs: { type: 'button' }, on: { click: function () { revoke(r); } } }));
                  }
                  return a;
                } },
              ],
              data.invitations,
              'No guests match.',
            ),
          );
          listBox.appendChild(ui.pager(state, function (o) { state.offset = o; load(); }));
        } catch (err) {
          EM.showError(msg, err);
        }
      }

      searchIn.addEventListener('input', ui.debounce(function () { state.search = searchIn.value.trim(); state.offset = 0; load(); }, 300));
      statusSel.addEventListener('change', function () { state.status = statusSel.value; state.offset = 0; load(); });
      repeatChk.addEventListener('change', function () { state.repeat = repeatChk.checked; state.offset = 0; load(); });

      ui.append(
        container,
        msg,
        open
          ? el('div', { class: 'card stack' },
              el('h2', { text: 'Add a guest' }), addForm,
              el('hr'),
              el('h3', { text: 'Import a CSV guest list' }),
              el('p', { class: 'small muted', text: 'Columns: guest_name, guest_email, plus_one_allowance (0-3, optional), category (optional). Max 1000 rows, 1 MB.' }),
              el('div', { class: 'row' }, fileIn, uploadBtn),
              importStatus)
          : el('p', { class: 'alert alert-info', text: 'Guests can only be added while the event is a draft or published.' }),
        el('div', { class: 'row' }, el('div', { class: 'field' }, searchIn), statusSel, el('label', { class: 'choice', attrs: { for: 'g-repeat' } }, repeatChk, 'Repeat no-shows only')),
        listBox,
      );
      load();
      return function () {
        alive = false;
        clearTimeout(pollTimer);
      };
    },
  };
})();
