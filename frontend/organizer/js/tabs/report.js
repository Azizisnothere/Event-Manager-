/* Report tab: final attendance, no-show list, late cancellations and the CSV download (after completion). */
(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  var el = ui.el;
  window.EMTabs = window.EMTabs || {};

  function stat(label, value) {
    return el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: String(value) }), el('div', { class: 'stat-label', text: label }));
  }

  window.EMTabs.report = {
    mount: function (container, ctx) {
      var box = el('div', { class: 'stack' });
      var timer = null;
      var alive = true;

      async function download(button) {
        ui.setBusy(button, true, 'Preparing...');
        try {
          var data = await EM.api(ctx.base + '/attendance/report/download');
          // A private, 5-minute presigned link (Threat 7).
          var a = el('a', { attrs: { href: data.download.url, rel: 'noopener noreferrer' } });
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (err) {
          ui.toast(EM.errorText(err), 'error');
        } finally {
          ui.setBusy(button, false);
        }
      }

      async function load() {
        if (!alive) return;
        ui.clear(box);
        try {
          var data = await EM.api(ctx.base + '/attendance/report');
          var r = data.report;
          var dl = el('button', { class: 'btn', text: 'Download CSV', attrs: { type: 'button', disabled: !r.csv_available } });
          dl.addEventListener('click', function () { download(dl); });
          ui.append(
            box,
            el('div', { class: 'row row-between' }, el('h2', { text: 'Attendance report' }), dl),
            el('p', { class: 'small muted', text: 'Generated ' + ui.fmtDateTime(r.generated_at) + '.' + (r.csv_available ? '' : ' CSV storage is not configured in this environment.') }),
            el('div', { class: 'grid-stats' },
              stat('Invited', r.invited),
              stat('Confirmed', r.confirmed),
              stat('Attended', r.attended),
              stat('No-shows', r.no_shows),
              stat('Late cancellations', r.late_cancellations),
              stat('Attendance rate', Math.round(r.attendance_rate * 1000) / 10 + '%'),
              stat('People arrived', r.people_arrived + ' / ' + r.people_confirmed),
              stat('Promoted from waitlist', r.waitlist_promoted)),
            el('h3', { text: 'No-shows' }),
            ui.table(
              [
                { label: 'Name', render: function (x) { return x.guest_name; } },
                { label: 'Email', render: function (x) { return x.guest_email; } },
                { label: 'Party', render: function (x) { return String(x.party_size); } },
              ],
              data.no_shows,
              'No no-shows.',
            ),
            el('h3', { text: 'Late cancellations (after the RSVP deadline)' }),
            ui.table(
              [
                { label: 'Name', render: function (x) { return x.guest_name; } },
                { label: 'Email', render: function (x) { return x.guest_email; } },
                { label: 'Cancelled', render: function (x) { return ui.fmtDateTime(x.cancelled_at); } },
              ],
              data.late_cancellations,
              'No late cancellations.',
            ),
          );
        } catch (err) {
          if (err.status === 409) {
            box.appendChild(el('p', { class: 'alert alert-info', text: err.message }));
            if (err.code === 'REPORT_PENDING') timer = setTimeout(load, 3000);
          } else {
            box.appendChild(el('p', { class: 'alert alert-error', text: EM.errorText(err) }));
          }
        }
      }

      container.appendChild(box);
      load();
      return function () {
        alive = false;
        clearTimeout(timer);
      };
    },
  };
})();
