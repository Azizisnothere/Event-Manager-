(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;

  var HOME = { organizer: 'organizer/dashboard.html', staff: 'staff/events.html' };

  var u = EM.session.user;
  if (EM.session.token && u && HOME[u.role]) {
    window.location.replace(HOME[u.role]);
    return;
  }

  var form = ui.$('#login-form');
  var errorBox = ui.$('#login-error');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    EM.showError(errorBox, null);
    var email = form.email.value.trim();
    var password = form.password.value;
    if (!email || !password) {
      EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', 'Enter your email and password.'));
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    ui.setBusy(button, true, 'Logging in...');
    try {
      var data = await EM.api('/api/auth/login', { method: 'POST', body: { email: email, password: password }, auth: false });
      if (!HOME[data.user.role]) {
        EM.showError(errorBox, new EM.ApiError(403, 'UNKNOWN_ROLE', 'This account cannot use this site.'));
        return;
      }
      EM.session.save(data.token, data.user);
      window.location.href = HOME[data.user.role];
    } catch (err) {
      EM.showError(errorBox, err);
    } finally {
      ui.setBusy(button, false);
    }
  });
})();
