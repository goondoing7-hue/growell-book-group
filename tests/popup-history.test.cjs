'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createPopupHistory = require('../popupHistory.js');

function browserFixture() {
  const listeners = {};
  const history = [{ url: 'https://example.test/#/book/emotion/share', state: { other: 'preserved' } }];
  const pending = [];
  let index = 0;
  const browser = {
    location: { href: history[0].url },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    history: {
      get state() { return history[index].state; },
      replaceState(state, unused, url) { history[index] = { state, url }; browser.location.href = url; },
      pushState(state, unused, url) { history.splice(index + 1); history.push({ state, url }); index++; browser.location.href = url; },
      go(delta) { pending.push(delta); }
    }
  };
  function emit(type, event) { (listeners[type] || []).slice().forEach(fn => fn(event)); }
  function navigate(hash) {
    const url = 'https://example.test/' + hash;
    browser.history.pushState(null, '', url);
    emit('popstate', { state: null });
    emit('hashchange', {});
  }
  function flush() {
    let count = 0;
    while (pending.length) {
      assert.ok(++count < 30, 'history skipping must settle');
      const target = index + pending.shift();
      if (target < 0 || target >= history.length) continue;
      const oldUrl = browser.location.href;
      index = target;
      browser.location.href = history[index].url;
      emit('popstate', { state: history[index].state });
      if (browser.location.href !== oldUrl) emit('hashchange', {});
    }
  }
  function back() { browser.history.go(-1); flush(); }
  function forward() { browser.history.go(1); flush(); }
  function reload() { Object.keys(listeners).forEach(key => delete listeners[key]); return createPopupHistory(browser); }
  return { browser, history, pending, navigate, back, forward, flush, reload, get index() { return index; } };
}

test('Back closes the popup on its original route; a second Back follows ordinary navigation', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/book/emotion/habits');
  popup.open('habit', { close() { closed.push('habit'); popup.closed('habit'); } });
  f.back();
  assert.deepEqual(closed, ['habit']);
  assert.match(f.browser.location.href, /habits$/);
  f.back();
  assert.match(f.browser.location.href, /share$/);
});

test('nested popups close one at a time and rerenders refresh their callback without extra entries', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/');
  popup.open('timer', { close() { closed.push('obsolete'); } });
  popup.open('timer', { close() { closed.push('timer'); } });
  popup.open('note', { close() { closed.push('note'); } });
  assert.equal(f.history.length, 4);
  f.back(); assert.deepEqual(closed, ['note']); assert.match(f.browser.location.href, /#\/$/);
  f.back(); assert.deepEqual(closed, ['note', 'timer']);
  f.back(); assert.match(f.browser.location.href, /share$/);
});

test('explicit close has no asynchronous traversal and one Back leaves the original screen', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser);
  f.navigate('#/book/emotion/habits');
  popup.open('habit', { close() { throw Error('already closed'); } });
  popup.closed('habit');
  assert.equal(f.pending.length, 0);
  f.back(); assert.match(f.browser.location.href, /share$/);
});

test('closing a nested popup explicitly still lets one Back close its parent', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/');
  popup.open('timer', { close() { closed.push('timer'); } });
  popup.open('note', { close() { closed.push('note'); } });
  popup.closed('note');
  f.back(); assert.deepEqual(closed, ['timer']); assert.match(f.browser.location.href, /#\/$/);
  f.back(); assert.match(f.browser.location.href, /share$/);
});

test('explicit close followed by immediate navigation cannot undo the intended route', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser);
  f.navigate('#/book/emotion/habits');
  popup.open('habit', { close() {} }); popup.closed('habit');
  f.navigate('#/book/emotion/mine'); f.flush();
  assert.match(f.browser.location.href, /mine$/);
  f.back(); assert.match(f.browser.location.href, /habits$/);
  f.back(); assert.match(f.browser.location.href, /share$/);
});

test('quick close and reopen reuses a retired guard and Back closes the new popup exactly once', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/');
  for (let i = 0; i < 5; i++) {
    popup.open('first', { close() { closed.push('old'); } }); popup.closed('first');
  }
  popup.open('second', { close() { closed.push('new'); } });
  assert.equal(f.history.length, 3);
  f.back(); assert.deepEqual(closed, ['new']); assert.equal(f.index, 1);
});

test('closing a parent retires nested popups top first, without replaying its own close handler', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/');
  popup.open('parent', { close() { closed.push('parent'); } });
  popup.open('child', { close() { closed.push('child'); popup.closed('child'); } });
  popup.closed('parent'); assert.deepEqual(closed, ['child']);
  f.back(); assert.match(f.browser.location.href, /share$/);
});

test('direct route navigation retires open popups and Back returns to the underlying screen', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = [];
  f.navigate('#/book/emotion/habits');
  popup.open('habit', { close() { closed.push('habit'); } });
  f.navigate('#/'); assert.deepEqual(closed, ['habit']);
  f.back(); assert.match(f.browser.location.href, /habits$/);
});

test('a saving popup can reject Back then close normally when saving is finished', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); let saving = true; let count = 0;
  f.navigate('#/');
  popup.open('save', { close() { count++; }, canClose() { return !saving; } });
  f.back(); assert.equal(count, 0); assert.equal(f.index, 2);
  saving = false; f.back(); assert.equal(count, 1); assert.equal(f.index, 1);
});

test('Forward and reload never restore popup UI or persist private values in browser history', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); let count = 0;
  f.navigate('#/');
  popup.open('private-key', { close() { count++; }, value: 'private draft' });
  assert.doesNotMatch(JSON.stringify(f.history), /private-key|private draft/);
  assert.equal(f.history[0].state.other, 'preserved');
  f.back(); f.forward(); assert.equal(count, 1);
  const fresh = f.reload(); f.back(); f.forward(); assert.equal(count, 1);
  fresh.open('new', { close() { count++; } }); f.back(); assert.equal(count, 2);
});

test('a retired popup at the forward-history boundary does not swallow the next Back', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser);
  f.navigate('#/'); popup.open('timer', { close() {} });
  f.back(); f.forward(); f.back();
  assert.match(f.browser.location.href, /share$/);
});

test('Back during a nested save leaves both dialogs intact until the save finishes', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); const closed = []; let saving = true;
  f.navigate('#/');
  popup.open('timer', { close() { closed.push('timer'); } });
  popup.open('note', { close() { closed.push('note'); }, canClose() { return !saving; } });
  f.back(); assert.deepEqual(closed, []);
  saving = false; f.back(); assert.deepEqual(closed, ['note']);
  f.back(); assert.deepEqual(closed, ['note', 'timer']);
});

test('native author-post hash navigation goes Back to share and Forward to the post without reopening the author', () => {
  const f = browserFixture(); const popup = createPopupHistory(f.browser); let authorClosed = 0;
  popup.open('author', { close() { authorClosed++; } });
  popup.closed('author');
  f.navigate('#/book/emotion/share?post=example');
  f.back(); assert.equal(f.browser.location.href, 'https://example.test/#/book/emotion/share');
  f.forward(); assert.equal(f.browser.location.href, 'https://example.test/#/book/emotion/share?post=example');
  assert.equal(authorClosed, 0);
});

test('old-document history after reload remains ordinary navigation with no popup callbacks', () => {
  const f = browserFixture(); const old = createPopupHistory(f.browser); let closed = 0;
  f.navigate('#/book/emotion/habits');
  old.open('habit', { close() { closed++; } });
  const fresh = f.reload();
  f.back(); assert.match(f.browser.location.href, /habits$/);
  f.back(); assert.match(f.browser.location.href, /share$/);
  f.forward(); assert.match(f.browser.location.href, /habits$/);
  assert.equal(closed, 0);
  fresh.open('new-habit', { close() { closed++; } });
  f.back(); assert.equal(closed, 1); assert.match(f.browser.location.href, /habits$/);
});
