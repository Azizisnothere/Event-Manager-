/* Waitlist tab: ordered list with positions and manual promotion. */
(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  window.EMTabs.waitlist = {
    mount: function (container, ctx) {
      var box = el('div', { class: 'stack' });
      var msg = el('div', { attrs: { hidden: true } });

      async function promote(r) {
        if (!window.confirm('Confirm ' + r.guest_name + ' (party of ' + r.party_size + ') now?')) return;
        try {
          await EM.api(ctx.base + '/rsvps/' + encodeURIComponent(r.rsvp_id) + '/promote', { method: 'POST', body: {} });
          ui.toast(r.guest_name + ' is confirmed and will receive a check-in code by email.', 'success');
          load();
          ctx.refreshSummary();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        }
      }

      async function load() {
        EM.showError(msg, null);
        try {
          var data = await EM.api(ctx.base + '/waitlist');
          var c = data.capacity;
          ui.clear(box);
          ui.append(
            box,
            el('p', { class: 'alert alert-info', text: c.confirmed_headcount + ' of ' + c.capacity + ' seats confirmed, ' + c.remaining_seats + ' free. ' +
              'Free seats are offered automatically in waitlist order; a party that does not fit is skipped but keeps its place.' }),
            ui.table(
              [
                { label: '#', render: function (r) { return String(r.position); } },
                { label: 'Name', render: function (r) { return r.guest_name; } },
                { label: 'Email', render: function (r) { return r.guest_email; } },
                { label: 'Party', render: function (r) { return String(r.party_size); } },
                { label: 'Waiting since', render: function (r) { return ui.fmtDateTime(r.waitlisted_at); } },
                { label: 'Fits now', render: function (r) { return r.fits_now ? 'Yes' : 'No'; } },
                { label: 'Actions', render: function (r) {
                  return el('button', { class: 'btn btn-small', text: 'Promote', attrs: { type: 'button', disabled: !r.fits_now }, on: { click: function () { promote(r); } } });
                } },
              ],
              data.waitlist,
              'Nobody is on the waitlist.',
            ),
          );
        } catch (err) {
          EM.showError(msg, err);
        }
      }

      ui.append(container, msg, box);
      load();
      return null;
    },
  };
})();
