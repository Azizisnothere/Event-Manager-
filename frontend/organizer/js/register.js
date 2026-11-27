(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;

  var form = ui.$('#register-form');
  var errorBox = ui.$('#register-error');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    EM.showError(errorBox, null);
    var name = form.name.value.trim();
    var email = form.email.value.trim();
    var password = form.password.value;
    var problems = [];
    if (!name) problems.push('Enter your name.');
    if (!email) problems.push('Enter your email.');
    if (password.length < 10) problems.push('The password must be at least 10 characters.');
    if (password !== form.confirm.value) problems.push('The passwords do not match.');
    if (problems.length) {
      EM.showError(errorBox, new EM.ApiError(400, 'VALIDATION', problems.join(' ')));
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    ui.setBusy(button, true, 'Creating account...');
    try {
      var data = await EM.api('/api/auth/register', {
        method: 'POST',
        body: { name: name, email: email, password: password },
        auth: false,
      });
      EM.session.save(data.token, { user_id: data.user.user_id, name: data.user.name, role: data.user.role });
      window.location.href = 'dashboard.html';
    } catch (err) {
      EM.showError(errorBox, err);
    } finally {
      ui.setBusy(button, false);
    }
  });
})();
