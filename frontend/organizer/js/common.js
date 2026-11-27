/* Organizer pages: login guard and the user / logout area of the top bar. */
(function () {
  'use strict';
  var EM = window.EM;
  var ui = EM.ui;

  var user = EM.requireLogin(['organizer'], '../index.html');
  if (!user) return;

  var area = document.getElementById('user-area');
  if (area) {
    ui.clear(area);
    ui.append(
      area,
      ui.el('span', { class: 'muted', text: user.name || '' }),
      ui.el('button', {
        class: 'btn btn-small btn-ghost',
        text: 'Log out',
        attrs: { type: 'button' },
        on: { click: function () { EM.logout('../index.html'); } },
      }),
    );
  }
  EM.currentUser = user;
})();
