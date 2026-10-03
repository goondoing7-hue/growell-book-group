const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const routing = require('../guideRouting.js');

const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36', platform: 'Win32' };
const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };

test('phone and Android tablet signals choose the mobile guide', () => {
  for(const device of [
    iphone,
    { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', platform: 'Linux armv8l' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', platform: 'Linux armv8l', userAgentData: { mobile: false, platform: 'Android' } },
    { userAgentData: { mobile: true, platform: 'Android' } },
    { userAgentData: { mobile: false, platform: 'Android' } },
    { userAgentData: { mobile: true } }
  ]) {
    assert.equal(routing.isMobileDevice(device), true);
    assert.deepEqual(routing.target(device), { href: '/guide.html', label: '모바일 사용 가이드' });
  }
});

test('iPad remains mobile in its regular and desktop-request modes', () => {
  for(const device of [
    { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', platform: 'iPad' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
    { platform: 'MacIntel', maxTouchPoints: 5 }
  ]) assert.equal(routing.isMobileDevice(device), true);
});

test('desktop systems and touch-enabled Windows PCs stay on the PC guide', () => {
  for(const device of [
    desktop,
    { ...desktop, maxTouchPoints: 10, innerWidth: 390, userAgentData: { mobile: false, platform: 'Windows' } },
    { platform: 'Win32', maxTouchPoints: 10, userAgentData: { mobile: true } },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 },
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 10 },
    { userAgentData: { mobile: false, platform: 'macOS' } },
    { userAgentData: { mobile: false, platform: 'Linux' } },
    { userAgentData: { mobile: false, platform: 'Chrome OS' } }
  ]) {
    assert.equal(routing.isMobileDevice(device), false);
    assert.deepEqual(routing.target(device), { href: '/guide-pc.html', label: 'PC 사용 가이드' });
  }
});

test('missing or unusable device metadata safely defaults to PC', () => {
  for(const device of [undefined, null, {}, { userAgent: 5, platform: null, userAgentData: {} }, { userAgent: 'Unknown browser', userAgentData: { mobile: 'true' } }]) {
    assert.deepEqual(routing.target(device), { href: '/guide-pc.html', label: 'PC 사용 가이드' });
  }
});

function locationAt(pathname, extra = {}) {
  const location = { protocol: 'https:', pathname, search: '', hash: '', calls: [], ...extra };
  location.replace = function(href) { this.calls.push(href); };
  return location;
}

test('a direct wrong-guide visit redirects in either direction with query and hash intact', () => {
  const pcVisit = locationAt('/guide.html', { search: '?ref=footer&text=%ED%95%9C%EA%B8%80', hash: '#timer' });
  assert.equal(routing.redirect(pcVisit, desktop), true);
  assert.deepEqual(pcVisit.calls, ['/guide-pc.html?ref=footer&text=%ED%95%9C%EA%B8%80#timer']);
  const phoneVisit = locationAt('/guide-pc.html', { protocol: 'http:', search: '?from=shared', hash: '#private' });
  assert.equal(routing.redirect(phoneVisit, iphone), true);
  assert.deepEqual(phoneVisit.calls, ['/guide.html?from=shared#private']);
});

test('matching guides do not redirect or create a navigation loop', () => {
  for(const [pathname, device] of [['/guide-pc.html', desktop], ['/guide.html', iphone]]) {
    const location = locationAt(pathname, { search: '?ref=guide', hash: '#start' });
    assert.equal(routing.redirect(location, device), false);
    assert.deepEqual(location.calls, []);
  }
});

test('offline previews, unrelated paths, and incomplete locations never redirect', () => {
  for(const location of [
    locationAt('/guide.html', { protocol: 'file:' }),
    locationAt('/guide-pc.html', { protocol: 'file:' }),
    locationAt('/guide.html', { protocol: 'about:' }),
    locationAt('/'), locationAt('/index.html'), locationAt('/privacy.html'),
    locationAt('/another/guide.html'), locationAt('/guide.html/'),
    { protocol: 'https:', pathname: '/guide.html' }, {}, null, undefined
  ]) {
    assert.equal(routing.redirect(location, desktop), false);
    if(location && location.calls) assert.deepEqual(location.calls, []);
  }
});

test('the browser script exposes the same routing API without triggering navigation on load', () => {
  const location = locationAt('/guide.html');
  const context = vm.createContext({ location, navigator: desktop });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../guideRouting.js'), 'utf8'), context);
  assert.equal(typeof context.GrowellGuideRouting.redirect, 'function');
  assert.equal(context.GrowellGuideRouting.target(iphone).href, '/guide.html');
  assert.deepEqual(location.calls, []);
});

test('both guide editions include a navigable Drive backup chapter and retain previous anchors', () => {
  const guides=require('../scripts/build-guides.cjs');
  guides.verifyGuidesFresh();
  const expected=['start','spaces','home','write','sharing','archive','timer','notes','habit','reminders','materials','worksheet','drive-backup','help'];
  for(const file of ['guide.html','guide-pc.html']){
    const html=fs.readFileSync(path.join(__dirname,'../',file),'utf8');
    assert.deepEqual([...html.matchAll(/<section class="chapter" id="([^"]+)"/g)].map(match=>match[1]),expected);
    assert.match(html,/<a href="#drive-backup"><small>13<\/small>Google Drive 백업/);
    assert.match(html,/<a href="#help"><small>14<\/small>자주 묻는 질문/);
    if(file==='guide-pc.html')assert.match(html,/data-desktop-chapter="drive-backup"/);
  }
  const location=locationAt('/guide.html',{hash:'#drive-backup'});routing.redirect(location,desktop);
  assert.deepEqual(location.calls,['/guide-pc.html#drive-backup']);
});
