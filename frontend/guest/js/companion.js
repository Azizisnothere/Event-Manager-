(function () {
  'use strict';
  var EM = window.EM;
  var G = window.EMGuest;
  var ui = EM.ui;
  var el = ui.el;
  var page = ui.$('#page');

  if (!G.token) {
    G.noTokenMessage(page);
    return;
  }

  async function init() {
    var data;
    try {
      data = await G.loadInvitation();
    } catch (err) {
      G.invalidMessage(page, err);
      return;
    }
    ui.clear(page);
    ui.append(page, G.eventHeader(data), G.nav('companion.html'));
    page.appendChild(el('p', { text: 'You may currently bring ' + data.invitation.plus_one_allowance + ' companion(s).' }));

    if (data.actions.can_request_companion) {
      var errorBox = el('div', { attrs: { hidden: true } });
      var nameIn = el('input', { attrs: { type: 'text', id: 'c-name', maxlength: 100, required: true } });
      var noteIn = el('textarea', { attrs: { id: 'c-note', maxlength: 300, placeholder: 'e.g. my sister, who is visiting' } });
      var submit = el('button', { class: 'btn btn-block', text: 'Send request', attrs: { type: 'submit' } });
      var form = el('form', { class: 'card', attrs: { novalidate: true } },
        el('h2', { text: 'Ask to bring one more person' }),
        errorBox,
        el('div', { class: 'field' }, el('label', { text: 'Companion name', attrs: { for: 'c-name' } }), nameIn),
        el('div', { class: 'field' }, el('label', { text: 'Note to the organizer (optional)', attrs: { for: 'c-note' } }), noteIn),
        submit);
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        EM.showError(errorBox, null);
        var body = { companion_name: nameIn.value.trim() };
        if (!body.companion_name) {
          EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', 'Enter your companion\'s name.'));
          return;
        }
        if (noteIn.value.trim()) body.note = noteIn.value.trim();
        ui.setBusy(submit, true, 'Sending...');
        try {
          await EM.api(G.apiPath('/plus-one-requests'), { method: 'POST', body: body, auth: false });
          ui.toast('Request sent. You will get an email with the decision.', 'success');
          init();
        } catch (err) {
          EM.showError(errorBox, err);
        } finally {
          ui.setBusy(submit, false);
        }
      });
      page.appendChild(form);
    } else {
      page.appendChild(el('p', { class: 'alert alert-info', text:
        data.plus_one_requests.some(function (r) { return r.status === 'pending'; })
          ? 'Your request is waiting for the organizer\'s decision.'
          : data.invitation.plus_one_allowance >= 3 ? 'You already have the maximum number of companions.' : 'Companion requests are closed for this event.' }));
    }

    page.appendChild(el('h2', { text: 'Your requests' }));
    page.appendChild(
      ui.table(
        [
          { label: 'Companion', render: function (r) { return r.companion_name; } },
          { label: 'Status', render: function (r) { return ui.badge(r.status); } },
          { label: 'Requested', render: function (r) { return ui.fmtDateTime(r.created_at); } },
        ],
        data.plus_one_requests,
        'No requests yet.',
      ),
    );
  }
  init();
})();
