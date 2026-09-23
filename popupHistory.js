(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.GrowellPopupHistory = factory(root);
}(typeof window !== 'undefined' ? window : this, function createPopupHistory(browser) {
  'use strict';
  var stateKey = '__growellPopupHistory';
  var session = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var serial = 0;
  var entries = Object.create(null);
  var stack = [];
  var skipping = null;
  var current;

  function href() { return browser.location.href; }
  function stateWith(entry, original) {
    var state = original && typeof original === 'object' ? Object.assign({}, original) : {};
    // No popup key, content, account, or form values enter browser history.
    state[stateKey] = { session: session, entry: entry.token };
    return state;
  }
  function known(state) {
    var marker = state && state[stateKey];
    return marker && marker.session === session ? entries[marker.entry] : null;
  }
  function makeEntry(url, order, popup) {
    var entry = { token: session + '-' + (++serial), url: url, order: order, popup: popup || null };
    entries[entry.token] = entry;
    return entry;
  }
  function stamp(order) {
    current = makeEntry(href(), order);
    browser.history.replaceState(stateWith(current, browser.history.state), '', href());
  }
  function isLive(entry) {
    return !!(entry && entry.popup && entry.popup.active && entry.popup.entry === entry);
  }
  function push(popup) {
    current = makeEntry(popup.url, current.order + 1, popup);
    popup.entry = current;
    browser.history.pushState(stateWith(current, browser.history.state), '', popup.url);
  }
  function removeFrom(index, notifyParent) {
    var removed = stack.splice(index);
    removed.forEach(function (popup) { popup.active = false; });
    // Mark every entry retired before callbacks: native close events can re-enter closed().
    for (var i = removed.length - 1; i >= 0; i--) {
      if (i || notifyParent) removed[i].close();
    }
  }
  function retire() {
    if (stack.length) removeFrom(0, true);
  }
  function synchronizeRoute() {
    if (current.url === href() && known(browser.history.state) === current) return;
    retire();
    skipping = null;
    stamp(current.order + 1);
  }
  function open(key, options) {
    if (!options || typeof options.close !== 'function') throw new TypeError('A popup close callback is required.');
    synchronizeRoute();
    var existing = stack.find(function (popup) { return popup.key === key; });
    if (existing) {
      existing.close = options.close;
      existing.canClose = options.canClose;
      return;
    }
    var popup = { key: key, close: options.close, canClose: options.canClose, url: href(), active: true, entry: null };
    stack.push(popup);
    // Reuse an explicitly closed popup's current entry instead of adding duplicate history.
    if (current.popup && !isLive(current)) {
      current.popup = popup;
      popup.entry = current;
    } else push(popup);
  }
  function closed(key) {
    var index = stack.findIndex(function (popup) { return popup.key === key; });
    if (index < 0) return;
    removeFrom(index, false);
    // Do not call history.back() here. Its asynchronous traversal could undo a
    // route chosen immediately after closing a popup. Retired entries are skipped
    // on the next traversal, while reopening can safely reuse the current entry.
  }
  function skip(direction, skipBase) {
    skipping = { direction: direction, skipBase: !!skipBase, url: href() };
    browser.history.go(direction);
  }
  function onPop(event) {
    var previous = current;
    var continuation = skipping;
    skipping = null;
    var next = known(event.state);
    // A new native hash navigation emits popstate(null) before hashchange.
    // Routes managed by this document are already stamped, so an untagged
    // entry is a newly created route, not a Back traversal through our guards.
    var marker = event.state && event.state[stateKey];
    var direction = next ? (next.order > previous.order ? 1 : -1)
      : (continuation ? continuation.direction : (!marker ? 1 : -1));
    // go() at either history boundary produces no event. A later traversal in
    // the opposite direction is a new user action, not that abandoned skip.
    if (continuation && continuation.direction !== direction) continuation = null;
    if (!next) {
      // Reloaded/forward history from another document never reopens a popup.
      stamp(previous.order + direction);
      next = current;
    } else current = next;

    var keep = stack.findIndex(function (popup) { return popup.entry === next && popup.url === href(); });
    var firstRemoved = keep + 1;
    var leaving = stack.length && (href() !== stack[0].url || direction < 0);
    if (leaving && firstRemoved < stack.length) {
      var removed = stack.slice(firstRemoved);
      var blocked = removed.some(function (popup) { return popup.canClose && !popup.canClose(); });
      if (blocked) {
        // Restore guards at the current position, without racing history.forward().
        removed.forEach(push);
      } else removeFrom(firstRemoved, true);
      return;
    }
    var skipBase = continuation ? (continuation.skipBase && continuation.url === next.url)
      : (previous.popup && !isLive(previous) && previous.url === next.url && direction < 0);
    if (next.popup && !isLive(next)) {
      skip(direction, skipBase);
      return;
    }
    // X/Escape already closed the popup. One Back must reach the preceding
    // screen (or parent popup), rather than stop at its duplicate base URL.
    if (skipBase) skip(direction, false);
  }

  stamp(0);
  browser.addEventListener('popstate', onPop);
  browser.addEventListener('hashchange', synchronizeRoute);
  return Object.freeze({ open: open, closed: closed, retire: retire });
}));
