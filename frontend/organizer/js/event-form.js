(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;
  if (!EM.currentUser) return;

  var form = ui.$('#event-form');
  var errorBox = ui.$('#form-error');
  var warnBox = ui.$('#form-warning');
  var venueStatus = ui.$('#venue-status');
  var eventId = ui.param('id');
  var original = null;

  function setVenueStatus(ev) {
    if (!ev) return;
    venueStatus.textContent = ev.venue_verified
      ? 'Verified: the address was found (' + ev.venue_lat.toFixed(4) + ', ' + ev.venue_lng.toFixed(4) + ').'
      : 'Not verified yet. Save again to check the address; the event cannot be published until it is verified.';
    venueStatus.className = 'field-hint ' + (ev.venue_verified ? '' : 'badge badge-flag');
  }

  function fill(ev) {
    form.title.value = ev.title;
    form.description.value = ev.description || '';
    form.venue_address.value = ev.venue_address;
    form.start_time.value = ui.toLocalInput(ev.start_time);
    form.end_time.value = ui.toLocalInput(ev.end_time);
    form.rsvp_deadline.value = ui.toLocalInput(ev.rsvp_deadline);
    form.capacity.value = ev.capacity;
    form.invite_limit.value = ev.invite_limit;
    setVenueStatus(ev);
  }

  function readForm() {
    return {
      title: form.title.value.trim(),
      description: form.description.value.trim() || null,
      venue_address: form.venue_address.value.trim(),
      start_time: ui.fromLocalInput(form.start_time.value),
      end_time: ui.fromLocalInput(form.end_time.value),
      rsvp_deadline: ui.fromLocalInput(form.rsvp_deadline.value),
      capacity: Number.parseInt(form.capacity.value, 10),
      invite_limit: Number.parseInt(form.invite_limit.value, 10),
    };
  }

  function clientProblems(v) {
    var p = [];
    if (!v.title) p.push('Enter a title.');
    if (!v.venue_address) p.push('Enter the venue address.');
    if (!v.start_time || !v.end_time || !v.rsvp_deadline) p.push('Fill in the start, end and RSVP deadline.');
    if (v.start_time && v.end_time && v.end_time <= v.start_time) p.push('The end must be after the start.');
    if (v.start_time && v.rsvp_deadline && v.rsvp_deadline > v.start_time) p.push('The RSVP deadline must be on or before the start.');
    if (!(v.capacity >= 1)) p.push('Capacity must be at least 1.');
    if (!(v.invite_limit >= 1)) p.push('The invite limit must be at least 1.');
    return p;
  }

  /** For PATCH, send only what changed. */
  function changedFields(v) {
    var out = {};
    Object.keys(v).forEach(function (k) {
      var before = original[k];
      var now = v[k];
      if (['start_time', 'end_time', 'rsvp_deadline'].indexOf(k) !== -1) {
        if (new Date(before).getTime() !== new Date(now).getTime()) out[k] = now;
      } else if ((before === null ? '' : before) !== (now === null ? '' : now)) {
        out[k] = now;
      }
    });
    // Re-sending the same address asks the server to verify it again.
    if (!original.venue_verified && !('venue_address' in out)) out.venue_address = v.venue_address;
    return out;
  }

  async function init() {
    if (!eventId) {
      var start = new Date(Date.now() + 7 * 86400000);
      start.setMinutes(0, 0, 0);
      form.start_time.value = ui.toLocalInput(start.toISOString());
      form.end_time.value = ui.toLocalInput(new Date(start.getTime() + 3 * 3600000).toISOString());
      form.rsvp_deadline.value = ui.toLocalInput(new Date(start.getTime() - 2 * 86400000).toISOString());
      return;
    }
    ui.$('#form-title').textContent = 'Edit event';
    ui.$('#back-link').setAttribute('href', 'event.html?id=' + encodeURIComponent(eventId));
    ui.$('#cancel-link').setAttribute('href', 'event.html?id=' + encodeURIComponent(eventId));
    try {
      var data = await EM.api('/api/events/' + encodeURIComponent(eventId));
      original = data.event;
      fill(original);
      if (['completed', 'cancelled'].indexOf(original.status) !== -1) {
        EM.showError(errorBox, new EM.ApiError(409, 'NOT_EDITABLE', 'A ' + original.status + ' event can no longer be edited.'));
        ui.$('#save-button').disabled = true;
      }
    } catch (err) {
      EM.showError(errorBox, err);
    }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    EM.showError(errorBox, null);
    warnBox.hidden = true;
    var v = readForm();
    var problems = clientProblems(v);
    if (problems.length) {
      EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', problems.join(' ')));
      return;
    }
    var button = ui.$('#save-button');
    ui.setBusy(button, true, 'Saving...');
    try {
      var data;
      if (eventId) {
        var patch = changedFields(v);
        if (!Object.keys(patch).length) {
          window.location.href = 'event.html?id=' + encodeURIComponent(eventId);
          return;
        }
        data = await EM.api('/api/events/' + encodeURIComponent(eventId), { method: 'PATCH', body: patch });
      } else {
        if (v.description === null) delete v.description;
        data = await EM.api('/api/events', { method: 'POST', body: v });
      }
      if (data.warnings && data.warnings.length) {
        // Saved, but the venue could not be verified right now.
        sessionStorage.setItem('em_flash', data.warnings[0].message);
      }
      window.location.href = 'event.html?id=' + encodeURIComponent(data.event.event_id);
    } catch (err) {
      EM.showError(errorBox, err);
      if (err.code === 'VENUE_NOT_FOUND') {
        venueStatus.textContent = 'This address could not be found. Check the spelling or add the city.';
        venueStatus.className = 'field-hint badge badge-flag';
        form.venue_address.focus();
      }
    } finally {
      ui.setBusy(button, false);
    }
  });

  init();
})();
