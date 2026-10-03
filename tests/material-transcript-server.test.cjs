'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createService, createHandler, createStore, createTranscriptTransport, normalizedTranscript, safeResult, MAX_TEXT_BYTES} = require('../server/materialTranscriptService.cjs');
const AUTH = '11111111-1111-4111-8111-111111111111', ID = 'aBcDeFg1234';
const config = {configured: true, origin: 'https://growell-book.vercel.app', database: 'https://example.supabase.co', serviceKey: 'server-only-secret'};
const body = {postId: 'post-1', videoId: ID};
const transcript = {text: '첫 번째 원문입니다.\nSecond original line.', language: 'ko', source: 'youtube_captions'};
function fixture(extra = {}) {
  const calls = [], cache = new Map();
  const profile = {id: 'owner', auth_user_id: AUTH, is_deleted: false, approval_status: 'approved'};
  const note = {id: 'post-1', html: '', drive_links: [{driveUrl: 'https://youtu.be/' + ID}]};
  const store = {
    user: async token => {calls.push(['user', token]);return {id: AUTH};},
    profile: async () => profile,
    note: async (id, token) => {calls.push(['note', id, token]);return {...note, id};},
    claim: async (_, id, lease, enabled) => {calls.push(['claim', id, enabled]);if (cache.has(id)) return cache.get(id);if (!enabled) return {status: 'unavailable', reason: 'not_configured'};cache.set(id, {status: 'pending'});return {status: 'claimed'};},
    finish: async (id, lease, result) => {calls.push(['finish', id, result]);const saved = {...result, fetchedAt: '2026-10-03T00:00:00Z'};cache.set(id, saved);return saved;}
  };
  const service = createService({config, env: {SUPADATA_API_KEY: 'synthetic-key'}, store, provider: async (id, options) => {calls.push(['provider', id, options]);return {status: 'ready', transcript};}, ...extra});
  return {service, store, calls, profile, note, cache};
}
async function http(handler, patch = {}) {
  const req = {method: 'POST', headers: {origin: config.origin, authorization: 'Bearer synthetic.jwt', 'content-type': 'application/json'}, body, ...patch};
  const res = {headers: {}, setHeader(k, v) {this.headers[k.toLowerCase()] = v;}, end(v) {this.data = v;}};
  await handler(req, res);return {status: res.statusCode, headers: res.headers, body: JSON.parse(res.data)};
}
test('native text is preserved and cached across authorized posts without another provider call', async () => {
  const f = fixture(), first = await f.service.generate(body, 'member-jwt');
  assert.deepEqual(first, {status: 'ready', videoId: ID, transcript, fetchedAt: '2026-10-03T00:00:00Z'});
  assert.equal((await f.service.generate({...body, postId: 'post-2'}, 'member-jwt')).status, 'ready');
  assert.equal(f.calls.filter(c => c[0] === 'provider').length, 1);
  assert.ok(f.calls.filter(c => c[0] === 'note').every(c => c[2] === 'member-jwt'));
  assert.equal(JSON.stringify(first).includes('secret'), false);
});
test('pending/blocked claims spend no provider requests, and a persisted job is polled by its exact ID', async () => {
  for (const cached of [{status: 'pending'}, {status: 'unavailable', reason: 'rate_limited', retryAfter: 3600}, {status: 'unavailable', reason: 'transcript_unavailable', retryAfter: 604800}]) {
    const f = fixture();f.cache.set(ID, cached);assert.equal((await f.service.generate(body, 'token')).status, cached.status);
    assert.equal(f.calls.some(c => c[0] === 'provider'), false);
  }
  const f = fixture();f.cache.set(ID, {status: 'claimed', jobId: 'native-job_123'});
  assert.equal((await f.service.generate(body, 'token')).status, 'ready');
  assert.equal(f.calls.find(c => c[0] === 'provider')[2].jobId, 'native-job_123');
  const pending = fixture({provider: async () => ({status: 'pending', jobId: 'hidden-native-job'})});
  const response = await pending.service.generate(body, 'token');
  assert.deepEqual(response, {status: 'pending', retryAfter: 5});assert.equal(JSON.stringify(response).includes('job'), false);
  assert.equal(pending.calls.find(c => c[0] === 'finish')[2].jobId, 'hidden-native-job');
});
test('missing provider key serves existing captions but never attempts an uncached fetch', async () => {
  const f = fixture({env: {}});f.cache.set(ID, {status: 'ready', transcript, fetchedAt: '2026-10-03T00:00:00Z'});
  assert.equal((await f.service.generate(body, 'token')).status, 'ready');f.cache.clear();
  assert.equal((await f.service.generate(body, 'token')).reason, 'not_configured');
  assert.equal(f.calls.some(c => c[0] === 'provider'), false);
});
test('unapproved/deleted members, removed links and inaccessible materials cannot view or generate captions', async () => {
  for (const state of [{is_deleted: true}, {approval_status: 'pending'}, {auth_user_id: 'other'}]) {
    const f = fixture();Object.assign(f.profile, state);await assert.rejects(f.service.generate(body, 'token'), e => e.status === 403);
    assert.equal(f.calls.some(c => c[0] === 'claim'), false);
  }
  const f = fixture();f.note.drive_links = [];await assert.rejects(f.service.generate(body, 'token'), e => e.status === 404);
  assert.equal(f.calls.some(c => c[0] === 'claim'), false);
});
test('permission changes during provider generation or cached reads never expose the transcript', async () => {
  for (const mode of ['link', 'membership']) {
    let f;f = fixture({provider: async () => {if (mode === 'link') f.note.drive_links = [];else f.profile.is_deleted = true;return {status: 'ready', transcript};}});
    await assert.rejects(f.service.generate(body, 'token'), e => e.status === (mode === 'link' ? 404 : 403));
    const cached = fixture();cached.store.claim = async () => {cached.profile.is_deleted = true;return {status: 'ready', transcript, fetchedAt: '2026-10-03T00:00:00Z'};};
    await assert.rejects(cached.service.generate(body, 'token'), e => e.status === 403);
  }
});
test('aborted work is not persisted and arbitrary provider errors never leave the server', async () => {
  const controller = new AbortController();const f = fixture({provider: async () => {controller.abort();return {status: 'ready', transcript};}});
  await assert.rejects(f.service.generate(body, 'token', controller.signal));assert.equal(f.calls.some(c => c[0] === 'finish'), false);
  for (const code of ['transcript_unavailable', 'video_unavailable', 'not_configured', 'rate_limited', 'unknown-secret']) {
    const failed = fixture({provider: async () => {throw Object.assign(new Error('provider key and body secret'), {code});}});
    const output = await failed.service.generate(body, 'token');assert.equal(output.reason, code === 'unknown-secret' ? 'temporary_error' : code);
    assert.equal(JSON.stringify(output).includes('secret'), false);
    assert.equal(JSON.stringify(failed.calls.find(c => c[0] === 'finish')).includes('secret'), false);
  }
});
test('provider output must be bounded native text with a real language and a safe job identifier', async () => {
  for (const invalid of [{...transcript, text: ''}, {...transcript, text: 'x'.repeat(MAX_TEXT_BYTES + 1)}, {...transcript, text: 'x\u0001y'}, {...transcript, language: '<ko>'}, {...transcript, source: 'ai_generated'}]) assert.throws(() => normalizedTranscript(invalid));
  assert.equal(normalizedTranscript({...transcript, secret: 'discarded'}).secret, undefined);
  assert.throws(() => safeResult({status: 'pending', jobId: '../secret'}));
  const f = fixture();f.cache.set(ID, {status: 'claimed', jobId: 'https://evil.test'});await assert.rejects(f.service.generate(body, 'token'));
  assert.equal(f.calls.some(c => c[0] === 'provider'), false);
  const bad = fixture({provider: async () => ({status: 'ready', transcript: {...transcript, source: 'generated'}})});
  assert.equal((await bad.service.generate(body, 'token')).reason, 'temporary_error');
});
test('store uses member RLS for materials and server-only independent transcript RPCs', async () => {
  const calls = [];const store = createStore(config, async (...args) => {calls.push(args);return [{id: 'post-1'}];});
  await store.note('post-1', 'member-jwt');await store.claim({id: 'owner', auth_user_id: AUTH}, ID, AUTH, true);await store.finish(ID, AUTH, {status: 'ready', transcript});
  assert.equal(calls[0][1].headers.Authorization, 'Bearer member-jwt');assert.equal(calls[0][2], 'material');
  assert.match(calls[1][0], /growell_material_transcript_claim$/);assert.match(calls[2][0], /growell_material_transcript_finish$/);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer server-only-secret');assert.equal(JSON.parse(calls[1][1].body).p_enabled, true);
});
test('HTTP endpoint inherits same-origin/auth/schema limits and returns only safe response fields', async () => {
  const handler = createHandler({service: fixture().service});
  assert.equal((await http(handler)).body.status, 'ready');
  assert.equal((await http(handler, {method: 'GET'})).status, 405);
  assert.equal((await http(handler, {headers: {origin: 'https://evil.test', authorization: 'Bearer x', 'content-type': 'application/json'}})).status, 403);
  assert.equal((await http(handler, {headers: {origin: config.origin, 'content-type': 'application/json'}})).status, 401);
  assert.equal((await http(handler, {body: {...body, jobId: 'client-controlled'}})).status, 400);
  assert.equal((await http(handler, {body: {...body, videoId: 'https://evil.test'}})).status, 400);
  assert.equal((await http(handler, {body: 'x'.repeat(4097)})).status, 413);
  assert.equal((await http(handler)).headers['cache-control'], 'no-store, private');
  let signal;const stalled = createHandler({service: {config, generate: async (_, __, given) => {signal = given;return new Promise(() => {});}}, timeoutMs: 5});
  assert.equal((await http(stalled)).body.reason, 'temporary_error');assert.equal(signal.aborted, true);
});
test('caption database transport accepts long captions, bounds streams and refuses credential redirects', async () => {
  let options;const big = JSON.stringify({transcript: {...transcript, text: 'a'.repeat(1100000)}});
  const good = createTranscriptTransport(async (_, opts) => {options = opts;return new Response(big);});
  assert.equal((await good('https://example.supabase.co')).transcript.text.length, 1100000);assert.equal(options.redirect, 'error');
  const large = createTranscriptTransport(async () => new Response('x'.repeat(MAX_TEXT_BYTES + 32769)));
  await assert.rejects(large('https://example.supabase.co'), e => e.message === 'temporary_error');
  const failed = createTranscriptTransport(async () => {throw new Error('database credentials');});
  await assert.rejects(failed('https://example.supabase.co'), e => e.message === 'temporary_error');
});
