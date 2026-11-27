(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;

  var form = ui.$('#setup-form');
  var errorBox = ui.$('#setup-error');
  var successBox = ui.$('#setup-success');
  var fields = ui.$('#setup-fields');

  // The one-time token arrives in the URL fragment (#t=...), which is never sent to the server
  // that hosts this page. Remove it from the address bar right away.
  var match = /(?:^#|&)t=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  var token = match ? match[1] : sessionStorage.getItem('em_setup_token');
  if (match) {
    sessionStorage.setItem('em_setup_token', match[1]);
    history.replaceState(null, '', window.location.pathname);
  }
  if (!token) {
    EM.showError(errorBox, new EM.ApiError(404, 'NO_TOKEN', 'This setup link is incomplete. Open the link from your email again.'));
    fields.hidden = true;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    EM.showError(errorBox, null);
    var password = form.password.value;
    if (password.length < 10) {
      EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', 'The password must be at least 10 characters.'));
      return;
    }
    if (password !== form.confirm.value) {
      EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', 'The passwords do not match.'));
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    ui.setBusy(button, true, 'Saving...');
    try {
      await EM.api('/api/auth/staff-setup', { method: 'POST', body: { token: token, password: password }, auth: false });
      sessionStorage.removeItem('em_setup_token');
      fields.hidden = true;
      EM.showSuccess(successBox, 'Your password is set. You can now log in.');
    } catch (err) {
      EM.showError(errorBox, err);
      if (err.status === 404 || err.status === 409) sessionStorage.removeItem('em_setup_token');
    } finally {
      ui.setBusy(button, false);
    }
  });
})();
