'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {VideoError, youtubeId, storedVideoIds, createStore, createService, createHandler, getConfig, normalizedSummary, createTransport} = require('../server/materialVideoService.cjs');
const AUTH = '11111111-1111-4111-8111-111111111111', ID = 'aBcDeFg1234';
const config = {configured: true, origin: 'https://growell-book.vercel.app', database: 'https://example.supabase.co', serviceKey: 'server-only-key'};
const body = {postId: 'post-1', videoId: ID};
const summary = {overview: '영상의 핵심 내용을 요약했습니다.', points: ['첫 번째 핵심입니다.', '두 번째 핵심입니다.']};
function fixture(extra = {}) {
  const calls = [], cache = new Map();
  const profile = {id: 'owner', auth_user_id: AUTH, is_deleted: false, approval_status: 'approved'};
  const note = {id: 'post-1', html: '<p>자료</p>', drive_links: [{driveUrl: 'https://youtu.be/' + ID}]};
  const store = {
    user: async token => {calls.push(['user', token]); return {id: AUTH};},
    profile: async () => profile,
    note: async (id, token) => {calls.push(['note', id, token]); return {...note, id};},
    claim: async (_, id, lease) => {calls.push(['claim', id]); if (cache.has(id)) return cache.get(id); cache.set(id, {status: 'pending', lease}); return {status: 'claimed'};},
    finish: async (id, lease, result) => {calls.push(['finish', id, lease]); const saved = {...result, generatedAt: '2026-10-03T00:00:00Z'};cache.set(id, saved);return saved;}
  };
  const service = createService({config, env: {INTERNAL: 'not-for-client'}, store, summarize: async (id, args) => {calls.push(['summarize', id, Object.keys(args)]);return summary;}, ...extra});
  return {service, store, calls, profile, note, cache};
}
async function http(handler, patch = {}) {
  const req = {method: 'POST', headers: {origin: config.origin, authorization: 'Bearer synthetic.jwt', 'content-type': 'application/json'}, body, ...patch};
  const res = {headers: {}, setHeader(k, v) {this.headers[k.toLowerCase()] = v;}, end(v) {this.data = v;}};
  await handler(req, res);
  return {status: res.statusCode, headers: res.headers, body: JSON.parse(res.data)};
}

test('extracts strict YouTube URLs from saved attachments and HTML, rejecting spoofed hosts', () => {
  for (const url of ['https://youtu.be/' + ID, 'https://www.youtube.com/watch?v=' + ID + '&t=2', 'https://m.youtube.com/shorts/' + ID, 'https://www.youtube-nocookie.com/embed/' + ID]) assert.equal(youtubeId(url), ID);
  for (const url of ['https://youtube.com.evil.test/watch?v=' + ID, 'https://youtube.com@evil.test/watch?v=' + ID, 'https://youtube.com:9000/watch?v=' + ID, 'javascript:https://youtu.be/' + ID, 'https://youtu.be/' + ID + '/other', 'https://youtu.be/short', 'https://youtu.be\\@evil.test/' + ID]) assert.equal(youtubeId(url), null);
  assert.deepEqual([...storedVideoIds({html: '<a href="https://www.youtube.com/watch?t=1&amp;v=' + ID + '">영상</a>'})], [ID]);
  assert.deepEqual([...storedVideoIds({html: '<p>https://youtu.be/' + ID + '.</p>', drive_links: JSON.stringify([{driveUrl: 'https://youtu.be/' + ID}])})], [ID]);
  assert.deepEqual([...storedVideoIds({html: '<p>https://youtu.be/' + ID + '&nbsp;영상</p>'})], [ID]);
  assert.equal(youtubeId(' https://youtu.be/' + ID + ' '), ID);
  assert.equal(storedVideoIds({html: '<script>https://youtu.be/' + ID + '</script>'}).size, 0);
});
test('authenticates approved membership and saved RLS material before generation; caches across posts', async () => {
  const f = fixture();
  const first = await f.service.generate(body, 'synthetic.jwt');
  assert.deepEqual(first.summary, summary); assert.equal(first.status, 'ready'); assert.equal(first.videoId, ID);
  assert.deepEqual(f.calls.filter(c => c[0] === 'summarize')[0], ['summarize', ID, ['env', 'fetch', 'signal']]);
  assert.equal((await f.service.generate({...body, postId: 'post-2'}, 'synthetic.jwt')).status, 'ready');
  assert.equal(f.calls.filter(c => c[0] === 'summarize').length, 1);
  assert.ok(f.calls.filter(c => c[0] === 'note').every(c => c[2] === 'synthetic.jwt'));
  assert.equal(JSON.stringify(first).includes('server-only-key'), false);
});
test('declines unknown or removed links and deleted, pending or mismatched members', async () => {
  for (const state of [{is_deleted: true}, {approval_status: 'pending'}, {auth_user_id: 'other'}]) {
    const f = fixture(); Object.assign(f.profile, state);
    await assert.rejects(f.service.generate(body, 'token'), e => e.status === 403);
    assert.equal(f.calls.some(c => c[0] === 'claim'), false);
  }
  const f = fixture();f.note.drive_links = [];
  await assert.rejects(f.service.generate(body, 'token'), e => e.status === 404);
  assert.equal(f.calls.some(c => c[0] === 'claim'), false);
});
test('a link removed or membership revoked while generating is not returned', async () => {
  for (const mode of ['link', 'membership']) {
    let f;
    f = fixture({summarize: async () => {if (mode === 'link') f.note.drive_links = []; else f.profile.is_deleted = true;return summary;}});
    await assert.rejects(f.service.generate(body, 'token'), e => e.status === (mode === 'link' ? 404 : 403));
  }
});
test('pending claims and rate limits never call the provider', async () => {
  for (const result of [{status: 'pending'}, {status: 'unavailable', reason: 'rate_limited', retryAfter: 3600}]) {
    const f = fixture();f.cache.set(ID, result);
    const data = await f.service.generate(body, 'token');assert.equal(data.status, result.status);
    assert.equal(f.calls.some(c => c[0] === 'summarize'), false);
  }
});
test('provider failures are persisted as safe unavailable reasons without raw error text', async () => {
  for (const code of ['video_unavailable', 'rate_limited', 'not_configured', 'unknown-secret']) {
    const f = fixture({summarize: async () => {throw Object.assign(new Error('provider secret token'), {code});}});
    const result = await f.service.generate(body, 'token');
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, code === 'unknown-secret' ? 'temporary_error' : code);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(f.cache.get(ID).status, 'unavailable');
  }
});
test('database note read uses the caller bearer, while profile/cache use the server credential', async () => {
  const calls = [];const store = createStore(config, async (...args) => {calls.push(args);return [{id: 'post-1'}];});
  await store.note('post-1', 'member-jwt'); await store.profile(AUTH); await store.claim({id: 'owner', auth_user_id: AUTH}, ID, AUTH);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer member-jwt');
  assert.equal(calls[0][2], 'material');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer server-only-key');
  assert.equal(calls[2][1].headers.Authorization, 'Bearer server-only-key');
  assert.equal(calls[0][0].includes('select=id,html,drive_links'), true);
});
test('HTTP endpoint restricts method, origin, content type, bearer and payload size', async () => {
  const f = fixture(), handler = createHandler({service: f.service});
  assert.equal((await http(handler)).status, 200);
  assert.equal((await http(handler, {method: 'GET'})).status, 405);
  assert.equal((await http(handler, {headers: {origin: 'https://evil.test', authorization: 'Bearer test', 'content-type': 'application/json'}})).status, 403);
  assert.equal((await http(handler, {headers: {origin: config.origin, 'content-type': 'application/json'}})).status, 401);
  assert.equal((await http(handler, {body: 'x'.repeat(4097)})).status, 413);
  assert.equal((await http(handler, {body: {...body, text: 'private input'}})).status, 400);
  assert.equal((await http(handler, {body: {...body, videoId: 'https://evil.test'}})).status, 400);
  assert.equal((await http(handler, {body: {...body, postId: 'x&select=*'}})).status, 400);
  const result = await http(handler);assert.equal(result.headers['cache-control'], 'no-store, private');
});
test('HTTP deadline aborts provider work and hides unexpected exception details', async () => {
  let signal;
  const stalled = {config, generate: async (_, __, given) => {signal = given;return new Promise(() => {});}};
  const result = await http(createHandler({service: stalled, timeoutMs: 10}));
  assert.equal(signal.aborted, true);assert.equal(result.body.reason, 'temporary_error');
  const failed = await http(createHandler({service: {config, generate: async () => {throw new Error('private credential');}}}));
  assert.equal(JSON.stringify(failed).includes('credential'), false);
});
test('transport never redirects credentials and normalizes auth and network failures', async () => {
  let options;
  const transport = createTransport(async (_, opts) => {options = opts;return {ok: false, status: 401};});
  await assert.rejects(transport(config.database + '/auth/v1/user', {}, 'auth'), e => e instanceof VideoError && e.status === 401);
  assert.equal(options.redirect, 'error');assert.ok(options.signal);
  const unavailable = createTransport(async () => {throw new Error('private transport details');});
  await assert.rejects(unavailable('https://example.test'), e => e.message === 'temporary_error');
});
test('summary is limited to plain data and malformed values fail closed', () => {
  assert.throws(() => normalizedSummary({overview: 'summary', points: []}));
  const result = normalizedSummary({overview: 'x'.repeat(3000), points: Array(20).fill('y'.repeat(2000)), secret: 'removed'});
  assert.equal(result.overview.length, 1200);assert.equal(result.points.length, 8);assert.equal(result.points[0].length, 600);assert.equal(result.secret, undefined);
  assert.equal(getConfig({SUPABASE_SERVICE_ROLE_KEY: 'key', GROWELL_SUPABASE_URL: 'https://evil.test'}).configured, false);
});
