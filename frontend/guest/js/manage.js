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

  function buildForm(data) {
    var r = data.rsvp;
    var active = ['confirmed', 'waitlisted'].indexOf(r.status) !== -1;
    var max = data.invitation.max_party_size;
    var errorBox = el('div', { attrs: { hidden: true } });
    var form = el('form', { class: 'card stack', attrs: { novalidate: true } }, el('h2', { text: 'Change my reply' }), errorBox);
    var size = el('select', { attrs: { id: 'party-size' } });
    for (var i = 1; i <= max; i += 1) {
      size.appendChild(el('option', { text: String(i), attrs: { value: i, selected: i === Math.min(r.party_size, max) } }));
    }
    var notes = el('textarea', { attrs: { id: 'dietary', maxlength: 300 } });
    notes.value = r.dietary_notes || '';

    if (data.actions.can_change) {
      ui.append(form,
        el('div', { class: 'field' }, el('label', { text: 'Party size, including you', attrs: { for: 'party-size' } }), size,
          el('div', { class: 'field-hint', text: 'Up to ' + max + ' in total. A larger party is only possible if seats are free.' })),
        el('div', { class: 'field' }, el('label', { text: 'Dietary notes', attrs: { for: 'dietary' } }), notes));
    } else {
      form.appendChild(el('p', { class: 'alert alert-info', text: 'The reply deadline has passed. You can still cancel your attendance until the event starts.' }));
    }

    var turnstile = G.mountTurnstile(form);
    var buttons = el('div', { class: 'row' });
    form.appendChild(buttons);

    async function send(body, button, okText) {
      EM.showError(errorBox, null);
      var tsToken = turnstile.getToken();
      if (!tsToken) {
        EM.showError(errorBox, new EM.ApiError(400, 'TURNSTILE', 'Please complete the "verify you are human" check.'));
        return;
      }
      ui.setBusy(button, true, 'Saving...');
      try {
        await EM.api(G.apiPath('/rsvp'), { method: 'PATCH', body: body, auth: false, turnstileToken: tsToken });
        ui.toast(okText, 'success');
        window.location.href = 'result.html';
      } catch (err) {
        EM.showError(errorBox, err);
        turnstile.reset();
      } finally {
        ui.setBusy(button, false);
      }
    }

    function addButton(label, cls, handler) {
      var b = el('button', { class: 'btn ' + (cls || ''), text: label, attrs: { type: 'button' } });
      b.addEventListener('click', function () { handler(b); });
      buttons.appendChild(b);
    }

    if (data.actions.can_change && active) {
      addButton('Save changes', '', function (b) {
        var body = {};
        var newSize = Number.parseInt(size.value, 10);
        if (newSize !== r.party_size) body.party_size = newSize;
        if ((notes.value.trim() || null) !== (r.dietary_notes || null)) body.dietary_notes = notes.value.trim() || null;
        if (!Object.keys(body).length) {
          ui.toast('Nothing changed.');
          return;
        }
        send(body, b, 'Your reply was updated.');
      });
    }
    if (data.actions.can_change && !active) {
      addButton('I can attend after all', 'btn-ok', function (b) {
        var body = { response: 'accept', party_size: Number.parseInt(size.value, 10) };
        if (notes.value.trim()) body.dietary_notes = notes.value.trim();
        send(body, b, 'Thank you - your reply was updated.');
      });
    }
    if (data.actions.can_cancel) {
      addButton('Cancel my attendance', 'btn-danger-ghost', function (b) {
        if (!window.confirm('Cancel your attendance? Your seat will be offered to someone on the waitlist.')) return;
        send({ response: 'cancel' }, b, 'Your attendance was cancelled.');
      });
    }
    return form;
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
    ui.append(page, G.eventHeader(data), G.nav('manage.html'));
    if (!data.rsvp) {
      page.appendChild(el('div', { class: 'card' }, el('p', { text: 'You have not replied yet.' }),
        data.actions.can_reply ? el('a', { class: 'btn', text: 'Reply now', attrs: { href: 'invitation.html' } }) : null));
      return;
    }
    page.appendChild(el('div', { class: 'card' }, el('p', { class: 'big-status', text: G.statusText(data.rsvp) })));
    if (data.actions.can_change || data.actions.can_cancel) page.appendChild(buildForm(data));
    else page.appendChild(el('p', { class: 'alert alert-info', text: 'Your reply can no longer be changed.' }));
  }
  init();
})();
