(function () {
  'use strict';

  function el(tag, props) {
    var node = document.createElement(tag);
    props = props || {};
    if (props.class) node.className = props.class;
    if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
    if (props.attrs) {
      Object.keys(props.attrs).forEach(function (k) {
        var v = props.attrs[k];
        if (v === false || v === null || v === undefined) return;
        if (/^on/i.test(k) || k === 'style' || k === 'srcdoc') return;
        node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (props.dataset) {
      Object.keys(props.dataset).forEach(function (k) {
        node.dataset[k] = String(props.dataset[k]);
      });
    }
    if (props.on) {
      Object.keys(props.on).forEach(function (evt) {
        node.addEventListener(evt, props.on[evt]);
      });
    }
    for (var i = 2; i < arguments.length; i += 1) append(node, arguments[i]);
    return node;
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i += 1) appendOne(parent, arguments[i]);
    return parent;
  }

  function appendOne(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) {
        appendOne(parent, c);
      });
      return;
    }
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function param(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  var dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function fmtDateTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '-' : dtf.format(d);
  }

  function relTime(iso) {
    if (!iso) return '';
    var diff = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    var abs = Math.abs(diff);
    var unit = abs < 60 ? abs + ' min' : abs < 1440 ? Math.round(abs / 60) + ' h' : Math.round(abs / 1440) + ' d';
    return diff >= 0 ? 'in ' + unit : unit + ' ago';
  }

  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fromLocalInput(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  var STATUS_LABELS = {
    draft: 'Draft',
    published: 'Published',
    rsvp_closed: 'RSVP closed',
    completed: 'Completed',
    cancelled: 'Cancelled',
    pending: 'Pending',
    sent: 'Sent',
    responded: 'Responded',
    revoked: 'Revoked',
    confirmed: 'Confirmed',
    waitlisted: 'Waitlisted',
    declined: 'Declined',
    cancelled_by_guest: 'Cancelled by guest',
    cancelled_by_organizer: 'Cancelled by organizer',
    event_cancelled: 'Event cancelled',
    approved: 'Approved',
    denied: 'Denied',
    active: 'Active',
    voided: 'Undone',
    pending_setup: 'Setup pending',
    disabled: 'Disabled',
    processing: 'Processing',
    failed: 'Failed',
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || '-').replace(/_/g, ' ');
  }

  function badge(status, extraClass) {
    return el('span', { class: 'badge badge-' + String(status || 'none').replace(/[^a-z_]/g, '') + (extraClass ? ' ' + extraClass : ''), text: statusLabel(status) });
  }

  function table(columns, rows, emptyText) {
    var thead = el('thead', null, el('tr', null, columns.map(function (c) { return el('th', { text: c.label, attrs: { scope: 'col' } }); })));
    var tbody = el('tbody');
    if (!rows.length) {
      tbody.appendChild(el('tr', null, el('td', { class: 'muted', text: emptyText || 'Nothing to show.', attrs: { colspan: columns.length } })));
    }
    rows.forEach(function (row) {
      tbody.appendChild(
        el('tr', null, columns.map(function (c) {
          var v = c.render(row);
          return el('td', { attrs: { 'data-label': c.label } }, v === null || v === undefined || v === '' ? '-' : v);
        })),
      );
    });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, thead, tbody));
  }

  var toastTimer = null;
  function toast(message, kind) {
    var box = document.getElementById('toast');
    if (!box) {
      box = el('div', { attrs: { id: 'toast', role: 'status', 'aria-live': 'polite' } });
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.className = 'toast toast-' + (kind || 'info') + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      box.className = 'toast';
    }, 4000);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyText || 'Please wait...';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  function askReason(message, min) {
    var value = window.prompt(message);
    if (value === null) return null;
    value = value.trim();
    if (value.length < (min || 3)) {
      toast('Please give a reason of at least ' + (min || 3) + ' characters.', 'error');
      return null;
    }
    return value.slice(0, 300);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

  function pager(state, onChange) {
    var from = state.total ? state.offset + 1 : 0;
    var to = Math.min(state.offset + state.limit, state.total);
    return el(
      'div',
      { class: 'pager' },
      el('button', { class: 'btn btn-small btn-ghost', text: 'Previous', attrs: { type: 'button', disabled: state.offset === 0 }, on: { click: function () { onChange(Math.max(0, state.offset - state.limit)); } } }),
      el('span', { class: 'muted', text: from + '-' + to + ' of ' + state.total }),
      el('button', { class: 'btn btn-small btn-ghost', text: 'Next', attrs: { type: 'button', disabled: to >= state.total }, on: { click: function () { onChange(state.offset + state.limit); } } }),
    );
  }

  function mapUrl(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=17/' + lat + '/' + lng;
  }

  function externalLink(href, text) {
    return el('a', { text: text, attrs: { href: href, target: '_blank', rel: 'noopener noreferrer' } });
  }

  window.EM = window.EM || {};
  window.EM.ui = {
    el: el,
    append: append,
    clear: clear,
    $: $,
    param: param,
    fmtDateTime: fmtDateTime,
    relTime: relTime,
    toLocalInput: toLocalInput,
    fromLocalInput: fromLocalInput,
    statusLabel: statusLabel,
    badge: badge,
    table: table,
    toast: toast,
    setBusy: setBusy,
    askReason: askReason,
    debounce: debounce,
    pager: pager,
    mapUrl: mapUrl,
    externalLink: externalLink,
  };
})();
