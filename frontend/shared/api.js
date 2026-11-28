(function () {
  'use strict';

  var TOKEN_KEY = 'em_token';
  var USER_KEY = 'em_user';

  function ApiError(status, code, message, details) {
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message = message;
    this.details = details;
  }
  ApiError.prototype = Object.create(Error.prototype);

  var session = {
    get token() {
      try {
        return sessionStorage.getItem(TOKEN_KEY);
      } catch (e) {
        return null;
      }
    },
    get user() {
      try {
        return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');
      } catch (e) {
        return null;
      }
    },
    save: function (token, user) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear: function () {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    },
  };

  var loginPage = null;

  function buildUrl(path, query) {
    var url = (window.EM_CONFIG.API_BASE_URL || '') + path;
    if (query) {
      var params = new URLSearchParams();
      Object.keys(query).forEach(function (k) {
        var v = query[k];
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      });
      var qs = params.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  async function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var auth = opts.auth !== false;
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && session.token) headers.Authorization = 'Bearer ' + session.token;
    if (opts.turnstileToken) headers['X-Turnstile-Token'] = opts.turnstileToken;

    var res;
    try {
      res = await fetch(buildUrl(path, opts.query), {
        method: method,
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
    }
    var data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
    }
    if (!res.ok) {
      var err = (data && data.error) || {};
      if (res.status === 401 && auth) {
        session.clear();
        if (loginPage) {
          window.location.href = loginPage;
        }
      }
      var message = err.message || 'Request failed (' + res.status + ').';
      if (res.status === 429) {
        var retry = res.headers.get('Retry-After');
        if (retry) message += ' Try again in about ' + Math.ceil(Number(retry) / 60) + ' minute(s).';
      }
      throw new ApiError(res.status, err.code || 'HTTP_' + res.status, message, err.details);
    }
    return data;
  }

  function errorText(err) {
    if (!err) return 'Something went wrong.';
    if (err instanceof ApiError) {
      var text = err.message;
      if (Array.isArray(err.details) && err.details.length) {
        text +=
          ' ' +
          err.details
            .map(function (d) {
              return d.field ? d.field.replace(/_/g, ' ') + ' ' + d.message : String(d.message || '');
            })
            .join('; ') +
          '.';
      }
      return text;
    }
    return 'Something went wrong. Please try again.';
  }

  function showError(container, err) {
    if (!container) return;
    container.textContent = err ? errorText(err) : '';
    container.hidden = !err;
    container.classList.add('alert', 'alert-error');
    container.setAttribute('role', 'alert');
  }

  function showSuccess(container, text) {
    if (!container) return;
    container.textContent = text || '';
    container.hidden = !text;
    container.classList.remove('alert-error');
    container.classList.add('alert', 'alert-success');
    container.setAttribute('role', 'status');
  }

  function requireLogin(roles, page) {
    loginPage = page;
    var user = session.user;
    if (!session.token || !user || (roles && roles.indexOf(user.role) === -1)) {
      session.clear();
      window.location.replace(page);
      return null;
    }
    return user;
  }

  function logout(page) {
    session.clear();
    window.location.href = page;
  }

  window.EM = window.EM || {};
  window.EM.api = api;
  window.EM.ApiError = ApiError;
  window.EM.session = session;
  window.EM.errorText = errorText;
  window.EM.showError = showError;
  window.EM.showSuccess = showSuccess;
  window.EM.requireLogin = requireLogin;
  window.EM.logout = logout;
})();
