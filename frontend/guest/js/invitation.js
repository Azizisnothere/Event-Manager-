/* Invitation page: event details, map link, accept or decline, party size within the allowance, dietary notes, Turnstile. */
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

  function replyForm(data) {
    var max = data.invitation.max_party_size;
    var errorBox = el('div', { attrs: { hidden: true } });
    var accept = el('input', { attrs: { type: 'radio', name: 'response', value: 'accept', checked: true } });
    var decline = el('input', { attrs: { type: 'radio', name: 'response', value: 'decline' } });
    var size = el('select', { attrs: { id: 'party-size' } });
    for (var i = 1; i <= max; i += 1) size.appendChild(el('option', { text: i === 1 ? '1 (just me)' : i + ' (me + ' + (i - 1) + ')', attrs: { value: i } }));
    var notes = el('textarea', { attrs: { id: 'dietary', maxlength: 300, placeholder: 'e.g. vegetarian, nut allergy' } });
    var counter = el('div', { class: 'counter', text: '0 / 300' });
    notes.addEventListener('input', function () { counter.textContent = notes.value.length + ' / 300'; });
    var attendingFields = el('div', null,
      el('div', { class: 'field' }, el('label', { text: 'How many people, including you?', attrs: { for: 'party-size' } }), size,
        el('div', { class: 'field-hint', text: max > 1 ? 'You may bring up to ' + (max - 1) + ' companion(s).' : 'This invitation is for you only.' })),
      el('div', { class: 'field' }, el('label', { text: 'Dietary notes (optional)', attrs: { for: 'dietary' } }), notes, counter));
    var submit = el('button', { class: 'btn btn-block btn-large', text: 'Send my reply', attrs: { type: 'submit' } });
    var form = el('form', { class: 'card', attrs: { novalidate: true } },
      el('h2', { text: 'Will you attend?' }),
      el('p', { class: 'small muted', text: 'Please reply by ' + ui.fmtDateTime(data.event.rsvp_deadline) + '.' }),
      errorBox,
      el('div', { class: 'choice-group field' },
        el('label', { class: 'choice-card' }, accept, 'Yes, I will attend'),
        el('label', { class: 'choice-card' }, decline, 'No, I cannot attend')),
      attendingFields);
    var turnstile = G.mountTurnstile(form);
    form.appendChild(submit);

    function sync() { attendingFields.hidden = decline.checked; }
    accept.addEventListener('change', sync);
    decline.addEventListener('change', sync);

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      EM.showError(errorBox, null);
      var tsToken = turnstile.getToken();
      if (!tsToken) {
        EM.showError(errorBox, new EM.ApiError(400, 'TURNSTILE', 'Please complete the "verify you are human" check.'));
        return;
      }
      var body = { response: accept.checked ? 'accept' : 'decline' };
      if (accept.checked) {
        body.party_size = Number.parseInt(size.value, 10);
        if (notes.value.trim()) body.dietary_notes = notes.value.trim();
      }
      ui.setBusy(submit, true, 'Sending...');
      try {
        await EM.api(G.apiPath('/rsvp'), { method: 'POST', body: body, auth: false, turnstileToken: tsToken });
        window.location.href = 'result.html';
      } catch (err) {
        EM.showError(errorBox, err);
        turnstile.reset(); // Turnstile tokens are single-use
      } finally {
        ui.setBusy(submit, false);
      }
    });
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
    ui.append(page, G.eventHeader(data), G.nav('invitation.html'));
    if (data.event.description) page.appendChild(el('div', { class: 'card' }, el('h2', { text: 'About the event' }), el('p', { text: data.event.description })));

    if (data.rsvp) {
      page.appendChild(el('div', { class: 'card stack' }, el('p', { class: 'big-status', text: G.statusText(data.rsvp) }),
        el('div', { class: 'row' },
          el('a', { class: 'btn', text: 'View my status', attrs: { href: 'result.html' } }),
          data.actions.can_change || data.actions.can_cancel ? el('a', { class: 'btn btn-ghost', text: 'Change my reply', attrs: { href: 'manage.html' } }) : null)));
    } else if (data.actions.can_reply) {
      page.appendChild(replyForm(data));
    } else {
      page.appendChild(el('p', { class: 'alert alert-info', text: data.event.status === 'cancelled' ? 'This event has been cancelled.' : 'Replies are closed for this event.' }));
    }
    if (data.actions.can_request_companion) {
      page.appendChild(el('p', { class: 'small' }, 'Want to bring someone else? ', el('a', { text: 'Ask the organizer for an extra companion', attrs: { href: 'companion.html' } })));
    }
  }
  init();
})();
