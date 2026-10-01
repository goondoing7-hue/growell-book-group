'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../server/habitSyncDomain.cjs');
const S = require('../server/habitSyncService.cjs');
const reading = require('../readingHabit.js');
const NOW = Date.parse('2026-10-02T03:00:00Z');
const AUTH = '11111111-1111-4111-8111-111111111111';
const GEN = '22222222-2222-4222-8222-222222222222';
const MARK = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const profile = {id: 'member_fixture', auth_user_id: AUTH, is_deleted: false, approval_status: 'approved'};
const config = D.getConfig({GROWELL_MS_CLIENT_ID: 'test-client', GROWELL_MS_CLIENT_SECRET: 'test-client-secret', GROWELL_SYNC_KEY: Buffer.alloc(32, 7).toString('base64'), SUPABASE_SERVICE_ROLE_KEY: 'test-service-role', CRON_SECRET: 'test-worker-secret'});
const habit = {id: 'habit_fixture', user_id: profile.id, name: '독서', goal: '하루 10쪽 읽기', time: '오후 4시', place: '집', start_date: '2026-10-02', end_date: '2026-10-20', behavior_type: 'do', book_id: 'emotion'};
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const connection = {owner_id: profile.id, auth_user_id: AUTH, generation: GEN, enabled: true, list_id: 'fixture-list', default_time: '21:00', lease_token: LEASE, token_cipher: D.seal({refreshToken: 'fixture-refresh-token'}, config.key, 'habit-sync-token:' + profile.id + ':' + GEN)};
  const item = {habit_id: habit.id, generation: GEN, marker: MARK, revision: 1, desired: clone(habit), task_id: null, uncertain: false, pending: true, attempts: 0};
  Object.assign(connection, options.connection); Object.assign(item, options.item);
  const operations = [], requests = [], remote = options.remote || [];
  const state = {connected: true, active: true, member: clone(profile), connection, item, remote};
  const store = {
    async profile() { return state.member; },
    async connection() { return state.connected ? connection : null; },
    async pending() { return item.pending ? 1 : 0; },
    async claim(owner) {
      operations.push(['claim', owner]);
      if (!state.active || !connection.enabled || !state.connected) return [];
      return [{connection: clone(connection), queue: item.pending ? [clone(item)] : []}];
    },
    async apply(conn, op, payload) {
      operations.push([op, clone(payload)]);
      if (!state.active || conn.generation !== connection.generation || conn.owner_id !== connection.owner_id) return {applied: false};
      if (['guard', 'sending'].includes(op) && payload.habit_id && payload.revision !== item.revision) return {applied: false};
      if (op === 'sending') item.uncertain = true;
      if (op === 'success') { item.task_id = payload.task_id; item.uncertain = false; item.pending = payload.revision !== item.revision; }
      if (op === 'failure') { item.attempts++; item.last_error = payload.error_code; if (typeof payload.uncertain === 'boolean') item.uncertain = payload.uncertain; }
      if (op === 'token') connection.token_cipher = payload.token_cipher;
      if (op === 'list_sending') connection.list_uncertain = true;
      if (op === 'list') { connection.list_id = payload.list_id; connection.list_uncertain = false; }
      if (op === 'connection_error') connection.error_code = payload.error_code;
      return {applied: true};
    },
    async configure(owner, auth, operation, body) {
      operations.push(['configure', owner, auth, operation, body]);
      if (operation === 'disconnect') { state.connected = false; state.active = false; }
      if (operation === 'settings') Object.assign(connection, {enabled: body.enabled, default_time: body.default_time});
      if (operation === 'import') return {queued: 1};
      return {};
    }
  };
  const request = async (url, opts = {}, kind) => {
    requests.push({url, opts, kind});
    if (options.request) {
      const handled = await options.request(url, opts, kind, state);
      if (handled !== undefined) return handled;
    }
    if (url.endsWith('/auth/v1/user')) return {id: AUTH};
    if (kind === 'token') return {access_token: 'fixture-access-token-long-value', refresh_token: 'rotated-fixture-refresh', scope: 'Tasks.ReadWrite'};
    if (kind !== 'graph') throw new Error('Unexpected request');
    if (url.includes('/tasks?')) return {value: clone(remote)};
    if (url.includes('/tasks/')) {
      const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const found = remote.find(task => task.id === id);
      if (!found) throw new D.SyncError('remote-missing', 404);
      if (opts.method === 'DELETE') { remote.splice(remote.indexOf(found), 1); return null; }
      if (opts.method === 'PATCH') { Object.assign(found, JSON.parse(opts.body)); return clone(found); }
      return clone(found);
    }
    if (url.endsWith('/tasks') && opts.method === 'POST') { const task = {...JSON.parse(opts.body), id: 'created-task'}; remote.push(task); return clone(task); }
    if (url.includes('/lists/') && !url.includes('/tasks')) {
      const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
      return {id, displayName: 'GROWELL', isOwner: true, isShared: false};
    }
    if (url.includes('/lists?')) return {value: options.lists || []};
    if (url.endsWith('/lists') && opts.method === 'POST') return {id: 'new-list', displayName: 'GROWELL', isOwner: true, isShared: false};
    throw new Error('Unexpected graph path');
  };
  return {state, store, request, operations, requests, service: S.createService({config, store, request, now: () => NOW})};
}

async function invoke(handler, req) {
  const response = {headers: {}, statusCode: 200, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body = '') { this.text = body; }};
  await handler({url: '/api/habit-sync?action=config', method: 'GET', headers: {}, ...req}, response);
  if (response.text.startsWith('{')) response.body = JSON.parse(response.text);
  return response;
}
const post = (action, body = {}) => ({url: '/api/habit-sync?action=' + action, method: 'POST', headers: {origin: config.origin, 'content-type': 'application/json', authorization: 'Bearer fixture.jwt.value'}, body});

test('connector fails closed without all server credentials and accepts only fixed HTTPS origins', () => {
  assert.equal(D.getConfig({}).configured, false); assert.equal(config.configured, true);
  for (const setting of [{GROWELL_SYNC_ORIGIN: 'http://growell-book.vercel.app'}, {GROWELL_SYNC_ORIGIN: 'https://user:pass@evil.test'}, {GROWELL_SUPABASE_URL: 'https://evil.test'}, {GROWELL_SYNC_KEY: 'short'}]) {
    const base = {GROWELL_MS_CLIENT_ID: 'id', GROWELL_MS_CLIENT_SECRET: 'secret', GROWELL_SYNC_KEY: Buffer.alloc(32).toString('base64'), SUPABASE_SERVICE_ROLE_KEY: 'service', CRON_SECRET: 'cron'};
    assert.equal(D.getConfig({...base, ...setting}).configured, false);
  }
});
test('AES-GCM binds encrypted tokens to one owner and connection generation', () => {
  const cipher = D.seal({refreshToken: 'sensitive-fixture'}, config.key, 'owner-a:one');
  assert.ok(!cipher.includes('sensitive-fixture'));
  assert.equal(D.unseal(cipher, config.key, 'owner-a:one').refreshToken, 'sensitive-fixture');
  for (const context of ['owner-b:one', 'owner-a:two']) assert.throws(() => D.unseal(cipher, config.key, context), /connection-key-invalid/);
  assert.throws(() => D.unseal(cipher.slice(0, -3) + 'abc', config.key, 'owner-a:one'), /connection-key-invalid/);
});
test('schedule parses explicit Korean time and uses agreed default for informal descriptions', () => {
  assert.equal(D.parseTime('매일 오후 4시', '21:00'), '16:00');
  assert.equal(D.parseTime('오전 12시 5분', '21:00'), '00:05');
  assert.equal(D.parseTime('오후 12시', '21:00'), '12:00');
  for (const text of ['잠들기 전', '아침 식사 후', '오후 13시', '4시', '24:00', '오후 4시 60분']) assert.equal(D.parseTime(text, '21:00'), '21:00');
  assert.throws(() => D.parseTime('잠들기 전', 'invalid'), /invalid-time/);
});
test('Graph payload whitelists habit information and decodes reading metadata without private IDs', () => {
  const encoded = reading.encode('하루 10쪽 읽기', {bookId: 'private_archive_sensitive', linkedBookId: '', targetPages: 10}, 'wisdom');
  const payload = D.taskPayload({...habit, goal: encoded, checked_dates: ['2026-10-01'], secret: 'not-exported'}, MARK, '21:00', config.origin, NOW);
  const text = JSON.stringify(payload);
  assert.equal(payload.title, '독서'); assert.equal(payload.reminderDateTime.dateTime, '2026-10-02T16:00:00');
  assert.equal(payload.recurrence.range.recurrenceTimeZone, 'Korea Standard Time');
  for (const excluded of ['private_archive_sensitive', 'member_fixture', 'habit_fixture', 'not-exported', 'checked_dates', 'valueId']) assert.ok(!text.includes(excluded));
  assert.ok(text.includes('하루 10쪽 읽기')); assert.equal(payload.status, undefined); assert.equal(D.hasMarker(payload, MARK), true);
  const broken = D.taskPayload({...habit, goal: 'growell-reading-habit-v1:{"badPrivateId":"hidden"}'}, MARK, '21:00', config.origin, NOW);
  assert.ok(!JSON.stringify(broken).includes('badPrivateId'));
});
test('passed time rolls to tomorrow and expired habits do not produce reminders', () => {
  const payload = D.taskPayload({...habit, time: '10:00'}, MARK, '21:00', config.origin, NOW);
  assert.equal(payload.reminderDateTime.dateTime, '2026-10-03T10:00:00');
  assert.equal(D.taskPayload({...habit, end_date: '2026-10-01'}, MARK, '21:00', config.origin, NOW), null);
  assert.equal(D.validDay('2026-02-31'), false);
});
test('config endpoint exposes only readiness; unconfigured mutations never touch auth or provider', async () => {
  let called = false;
  const handler = S.createHandler({config: D.getConfig({}), request: async () => { called = true; }});
  const first = await invoke(handler, {}); assert.deepEqual(first.body, {configured: false});
  const second = await invoke(handler, post('connect', {defaultTime: '21:00'})); assert.equal(second.statusCode, 503); assert.equal(called, false);
  assert.equal(first.headers['cache-control'], 'no-store, private');
});
test('POST rejects foreign or missing Origin and non-JSON before authentication', async () => {
  const f = fixture(), handler = S.createHandler({service: f.service});
  for (const changes of [{origin: 'https://evil.example'}, {origin: undefined}, {'content-type': 'text/plain'}]) {
    const req = post('connect', {defaultTime: '21:00'}); req.headers = {...req.headers, ...changes};
    assert.equal((await invoke(handler, req)).statusCode, 403);
  }
  assert.equal(f.requests.length, 0);
});
test('actual Supabase token and approved profile determine ownership, never body ownerId', async () => {
  const f = fixture(), handler = S.createHandler({service: f.service});
  await invoke(handler, post('import', {ownerId: 'other-member', habitId: habit.id}));
  const operation = f.operations.find(item => item[0] === 'configure');
  assert.equal(operation[1], profile.id); assert.equal(operation[2], AUTH);
  const auth = f.requests.find(item => item.url.endsWith('/auth/v1/user'));
  assert.equal(auth.opts.headers.Authorization, 'Bearer fixture.jwt.value');
  f.state.member.approval_status = 'pending';
  assert.equal((await invoke(handler, post('run'))).statusCode, 403);
  f.state.member.approval_status = 'approved'; f.state.member.is_deleted = true;
  assert.equal((await invoke(handler, post('run'))).statusCode, 403);
});
test('status never returns encrypted credentials, account IDs or worker leases', async () => {
  const f = fixture(); f.state.connection.account_id = 'private-account';
  const result = await f.service.status(profile);
  assert.deepEqual(Object.keys(result).sort(), ['configured','connected','defaultTime','enabled','errorCode','lastSyncedAt','listName','pendingCount','timeZone'].sort());
  assert.ok(!JSON.stringify(result).includes('private-account'));
});
test('worker endpoint requires timing-safe configured cron credential', async () => {
  const f = fixture(), handler = S.createHandler({service: f.service});
  const fail = await invoke(handler, {url: '/api/habit-sync?action=worker', headers: {authorization: 'Bearer wrong'}});
  assert.equal(fail.statusCode, 401); assert.equal(f.operations.length, 0);
  const pass = await invoke(handler, {url: '/api/habit-sync?action=worker', headers: {authorization: 'Bearer ' + config.cronSecret}});
  assert.equal(pass.statusCode, 200); assert.equal(pass.body.processed, 1);
});
test('connection produces fixed OAuth URL with PKCE, nonce and secure one-use cookie', async () => {
  const f = fixture(); let saved;
  f.store.oauth = async (op, payload) => { saved = payload; return {saved: true}; };
  const result = await f.service.connect(profile, {defaultTime: '21:00', redirect: 'https://evil.example'});
  const url = new URL(result.url);
  assert.equal(url.origin, D.LOGIN_ORIGIN); assert.equal(url.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(result.cookie, /Secure; HttpOnly; SameSite=Lax/);
  const secret = D.unseal(saved.verifier_cipher, config.key, 'habit-sync-oauth:' + profile.id + ':' + saved.state_hash);
  assert.equal(crypto.createHash('sha256').update(secret.verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(secret.nonce, url.searchParams.get('nonce')); assert.ok(!JSON.stringify(saved).includes(secret.verifier));
});
test('OAuth callback rejects missing browser cookie, expired or replayed states before token exchange', async () => {
  const f = fixture(), state = crypto.randomBytes(32).toString('base64url'); let consumed = 0;
  f.store.oauth = async () => { consumed++; return null; };
  const query = new URLSearchParams({state, code: 'fixture'});
  await assert.rejects(f.service.callback(query, ''), /oauth-state-invalid/); assert.equal(consumed, 0);
  await assert.rejects(f.service.callback(query, S.COOKIE + '=' + state), /oauth-state-invalid/); assert.equal(consumed, 1);
  assert.equal(f.requests.length, 0);
});
test('query-free Microsoft redirect routes code and cancellation callbacks without bearer authentication', async () => {
  assert.equal(config.redirectUri, config.origin + '/api/habit-sync');
  const received = [];
  const service = {
    config,
    async authenticate() { throw new Error('OAuth callback must use its state cookie, not bearer auth'); },
    async callback(params, cookie) {
      received.push({state: params.get('state'), code: params.get('code'), error: params.get('error'), cookie});
      if (params.get('error')) throw new D.SyncError('oauth-cancelled', 400);
      return config.origin + '/?habit-sync=connected#/book/emotion/habit';
    },
    callbackRedirect(result) { return config.origin + '/?habit-sync=' + result + '#/book/emotion/habit'; }
  };
  const handler = S.createHandler({service});
  const success = await invoke(handler, {url: '/api/habit-sync?code=provider-code&state=provider-state', headers: {cookie: S.COOKIE + '=fixture'}});
  assert.equal(success.statusCode, 303);
  assert.equal(success.headers.location, config.origin + '/?habit-sync=connected#/book/emotion/habit');
  assert.match(success.headers['set-cookie'], /Max-Age=0/);
  const cancellation = await invoke(handler, {url: '/api/habit-sync?error=access_denied&state=cancel-state', headers: {cookie: S.COOKIE + '=fixture'}});
  assert.equal(cancellation.statusCode, 303);
  assert.equal(cancellation.headers.location, config.origin + '/?habit-sync=failed#/book/emotion/habit');
  assert.deepEqual(received.map(item => [item.state, item.code, item.error]), [['provider-state', 'provider-code', null], ['cancel-state', null, 'access_denied']]);
  assert.equal(received[0].cookie, S.COOKIE + '=fixture');
});
test('OAuth identity validation verifies RSA signature, audience, expiry and nonce', async () => {
  const pair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const jwk = {...pair.publicKey.export({format: 'jwk'}), kid: 'fixture-key', use: 'sig'};
  const f = fixture({request: async url => url.endsWith('/keys') ? {keys: [jwk]} : undefined});
  const claims = {tid: AUTH, iss: D.LOGIN_ORIGIN + '/' + AUTH + '/v2.0', aud: config.clientId, nonce: 'nonce-fixture', sub: 'subject-fixture', nbf: NOW / 1000 - 30, exp: NOW / 1000 + 60};
  function sign(value, privateKey = pair.privateKey) {
    const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'fixture-key'})).toString('base64url');
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
  }
  assert.match(await f.service.verifyIdentity(sign(claims), 'nonce-fixture'), /^[a-f0-9]{64}$/);
  for (const invalid of [{...claims, aud: 'another-client'}, {...claims, nonce: 'wrong'}, {...claims, exp: undefined}, {...claims, exp: NOW / 1000 - 1}, {...claims, iss: 'https://evil.example'}]) await assert.rejects(f.service.verifyIdentity(sign(invalid), 'nonce-fixture'), /identity-invalid/);
  const other = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  await assert.rejects(f.service.verifyIdentity(sign(claims, other.privateKey), 'nonce-fixture'), /identity-invalid/);
});
test('successful OAuth callback consumes state once and stores only an owner/generation-bound refresh token', async () => {
  const pair = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  const jwk = {...pair.publicKey.export({format: 'jwk'}), kid: 'callback-key', use: 'sig'};
  let pending = null, secret;
  const f = fixture({request: async (url, opts, kind) => {
    if (url.endsWith('/keys')) return {keys: [jwk]};
    if (kind === 'token') {
      assert.equal(new URLSearchParams(opts.body).get('code_verifier'), secret.verifier);
      const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'callback-key'})).toString('base64url');
      const claims = {tid: AUTH, iss: D.LOGIN_ORIGIN + '/' + AUTH + '/v2.0', aud: config.clientId, nonce: secret.nonce, sub: 'callback-subject', nbf: NOW / 1000 - 1, exp: NOW / 1000 + 600};
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return {access_token: 'callback-access-token-fixture', refresh_token: 'callback-refresh-fixture', scope: 'Tasks.ReadWrite', id_token: head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), pair.privateKey).toString('base64url')};
    }
  }});
  f.store.oauth = async (operation, payload) => {
    if (operation === 'put') { pending = clone(payload); return {saved: true}; }
    const result = pending; pending = null; return result;
  };
  const start = await f.service.connect(profile, {defaultTime: '08:30'});
  const state = new URL(start.url).searchParams.get('state');
  secret = D.unseal(pending.verifier_cipher, config.key, 'habit-sync-oauth:' + profile.id + ':' + pending.state_hash);
  const params = new URLSearchParams({state, code: 'callback-code', redirect: 'https://evil.example'});
  assert.equal(await f.service.callback(params, S.COOKIE + '=' + state), config.origin + '/?habit-sync=connected#/book/emotion/habit');
  const saved = f.operations.find(row => row[0] === 'configure' && row[3] === 'connect')[4];
  assert.equal(saved.default_time, '08:30'); assert.match(saved.account_id, /^[a-f0-9]{64}$/);
  assert.equal(D.unseal(saved.token_cipher, config.key, 'habit-sync-token:' + profile.id + ':' + saved.generation).refreshToken, 'callback-refresh-fixture');
  assert.ok(!JSON.stringify(saved).includes('callback-access-token'));
  await assert.rejects(f.service.callback(params, S.COOKIE + '=' + state), /oauth-state-invalid/);
});
test('worker creates exactly one marked task and saves rotated encrypted token before Graph access', async () => {
  const f = fixture(); assert.deepEqual(await f.service.run(profile.id), {processed: 1});
  assert.equal(f.state.remote.length, 1); assert.equal(f.state.item.task_id, 'created-task');
  assert.equal(f.state.item.uncertain, false); assert.equal(f.state.item.pending, false);
  assert.ok(f.operations.findIndex(item => item[0] === 'token') < f.operations.findIndex(item => item[0] === 'sending'));
  assert.equal(D.unseal(f.state.connection.token_cipher, config.key, 'habit-sync-token:' + profile.id + ':' + GEN).refreshToken, 'rotated-fixture-refresh');
  await f.service.run(profile.id); assert.equal(f.state.remote.length, 1);
});
test('accepted-but-lost create recovers marker without repeating POST', async () => {
  let loseResponse = true;
  const f = fixture({request: async (url, opts, kind, state) => {
    if (kind === 'graph' && url.endsWith('/tasks') && opts.method === 'POST' && loseResponse) {
      loseResponse = false; state.remote.push({...JSON.parse(opts.body), id: 'accepted-task'});
      throw new D.SyncError('service-unavailable', 503, 30, true);
    }
  }});
  assert.deepEqual(await f.service.run(profile.id), {processed: 0}); assert.equal(f.state.item.uncertain, true);
  assert.deepEqual(await f.service.run(profile.id), {processed: 1}); assert.equal(f.state.item.task_id, 'accepted-task');
  assert.equal(f.requests.filter(item => item.kind === 'graph' && item.opts.method === 'POST').length, 1);
});
test('uncertain create with an empty successful list does not blindly create or delete', async () => {
  const f = fixture({item: {uncertain: true}});
  await f.service.run(profile.id); assert.equal(f.state.item.last_error, 'task-create-uncertain');
  assert.equal(f.requests.filter(item => item.kind === 'graph' && ['POST', 'DELETE'].includes(item.opts.method)).length, 0);
});
test('multiple matching active tasks stop recovery without editing or deleting either', async () => {
  const body = D.taskPayload(habit, MARK, '21:00', config.origin, NOW);
  const f = fixture({item: {uncertain: true}, remote: [{...body, id: 'copy-one'}, {...body, id: 'copy-two'}]});
  await f.service.run(profile.id); assert.equal(f.state.item.last_error, 'task-ambiguous');
  assert.equal(f.requests.filter(item => item.kind === 'graph' && ['POST', 'PATCH', 'DELETE'].includes(item.opts.method)).length, 0);
});
test('failed task listing cannot become an empty authoritative result or issue a delete', async () => {
  const f = fixture({item: {uncertain: true, desired: null}, request: async (url, opts, kind) => {
    if (kind === 'graph' && url.includes('/tasks?')) throw new D.SyncError('remote-unavailable');
  }});
  await f.service.run(profile.id); assert.equal(f.state.item.pending, true);
  assert.equal(f.requests.filter(item => item.opts.method === 'DELETE').length, 0);
});
test('remote deletion is limited to a known marker and preserves unrelated tasks', async () => {
  const marked = {...D.taskPayload(habit, MARK, '21:00', config.origin, NOW), id: 'owned-task', '@odata.etag': 'etag-fixture'};
  const f = fixture({item: {task_id: marked.id, desired: null}, remote: [marked, {id: 'unrelated', title: 'Private task'}]});
  assert.deepEqual(await f.service.run(profile.id), {processed: 1}); assert.deepEqual(f.state.remote.map(task => task.id), ['unrelated']);
  const deletion = f.requests.find(item => item.opts.method === 'DELETE'); assert.equal(deletion.opts.headers['If-Match'], 'etag-fixture');
  const other = fixture({item: {task_id: 'wrong', desired: null}, remote: [{id: 'wrong', title: 'Someone else'}]});
  await other.service.run(profile.id); assert.equal(other.state.item.last_error, 'remote-task-changed'); assert.equal(other.state.remote.length, 1);
});
test('updates retain external completion and never transfer GROWELL checks', async () => {
  const marked = {...D.taskPayload(habit, MARK, '21:00', config.origin, NOW), id: 'owned-task', status: 'completed'};
  const f = fixture({item: {task_id: marked.id, desired: {...habit, checked_dates: ['2026-10-02'], name: '읽기'}}, remote: [marked]});
  await f.service.run(profile.id); assert.equal(f.state.remote[0].status, 'completed');
  const patch = JSON.parse(f.requests.find(item => item.opts.method === 'PATCH').opts.body); assert.equal(patch.status, undefined); assert.equal(patch.checked_dates, undefined);
});
test('revision changes while POST is in flight keep the new desired edit pending', async () => {
  const f = fixture({request: async (url, opts, kind, state) => {
    if (kind === 'graph' && url.endsWith('/tasks') && opts.method === 'POST') { state.item.revision++; state.item.desired.name = '변경한 이름'; }
  }});
  await f.service.run(profile.id); assert.equal(f.state.item.task_id, 'created-task'); assert.equal(f.state.item.pending, true);
  await f.service.run(profile.id); assert.equal(f.state.remote[0].title, '변경한 이름'); assert.equal(f.state.remote.length, 1);
});
test('a stale lease/generation or revoked membership cannot create remote tasks', async () => {
  const f = fixture({request: async (url, opts, kind, state) => { if (kind === 'token') state.active = false; }});
  await f.service.run(profile.id); assert.equal(f.requests.filter(item => item.kind === 'graph').length, 0);
  const revoked = fixture(); revoked.state.member.is_deleted = true;
  await revoked.service.run(profile.id); assert.equal(revoked.requests.length, 0);
});
test('disconnect and settings use only authenticated owner and never call remote deletion', async () => {
  const f = fixture();
  await f.service.mutate(profile, 'settings', {enabled: false, defaultTime: '08:30', ownerId: 'other'});
  assert.equal(f.state.connection.enabled, false); assert.equal(f.state.connection.default_time, '08:30');
  await f.service.mutate(profile, 'disconnect', {}); assert.equal(f.state.connected, false); assert.equal(f.requests.length, 0);
});
test('uncertain list creation reuses one discovered list and does not duplicate on empty listing', async () => {
  const f = fixture({connection: {list_id: null, list_uncertain: true}, lists: [{id: 'recovered-list', displayName: 'GROWELL', isOwner: true, isShared: false}]});
  await f.service.run(profile.id); assert.equal(f.state.connection.list_id, 'recovered-list');
  assert.equal(f.requests.filter(item => item.opts.method === 'POST' && item.url.endsWith('/lists')).length, 0);
  const empty = fixture({connection: {list_id: null, list_uncertain: true}}); await empty.service.run(profile.id);
  assert.equal(empty.state.connection.error_code, 'list-create-uncertain'); assert.equal(empty.state.remote.length, 0);
});
test('an existing GROWELL list must be owned and private before any habit data is written', async () => {
  for (const flags of [{isOwner: true, isShared: true}, {isOwner: false, isShared: false}, {}]) {
    const f = fixture({connection: {list_id: null}, lists: [{id: 'shared-list', displayName: 'GROWELL', ...flags}]});
    await f.service.run(profile.id);
    assert.equal(f.state.connection.error_code, 'list-not-private');
    assert.equal(f.requests.filter(item => item.kind === 'graph' && ['POST', 'PATCH', 'DELETE'].includes(item.opts.method)).length, 0);
  }
});
test('a cached list that has become shared blocks creation, updates and deletion', async () => {
  for (const desired of [habit, null]) {
    const marked = {...D.taskPayload(habit, MARK, '21:00', config.origin, NOW), id: 'owned-task'};
    const f = fixture({item: {task_id: marked.id, desired}, remote: [marked], request: async url => {
      if (url.endsWith('/lists/fixture-list')) return {id: 'fixture-list', isOwner: true, isShared: true};
    }});
    await f.service.run(profile.id);
    assert.equal(f.state.connection.error_code, 'list-not-private');
    assert.equal(f.requests.filter(item => item.kind === 'graph' && ['POST', 'PATCH', 'DELETE'].includes(item.opts.method)).length, 0);
    assert.equal(f.state.remote.length, 1);
  }
});
test('list privacy is rechecked immediately before mutation after the run started', async () => {
  let checks = 0;
  const f = fixture({request: async url => {
    if (url.endsWith('/lists/fixture-list')) return {id: 'fixture-list', isOwner: true, isShared: ++checks > 1};
  }});
  await f.service.run(profile.id);
  assert.equal(f.state.item.last_error, 'list-not-private'); assert.equal(f.state.remote.length, 0);
  assert.equal(checks, 2);
});
test('Graph pagination validates nextLink before forwarding access tokens', async () => {
  const seen = [], graph = S.createGraph(async url => { seen.push(url); return {value: [], '@odata.nextLink': 'https://attacker.example/steal'}; }, 'sensitive-token');
  await assert.rejects(graph.all('/v1.0/me/todo/lists?$top=100'), /unsafe-remote-url/); assert.equal(seen.length, 1);
});
test('Graph pagination rejects loops, invalid responses and bounded oversized collections', async () => {
  const loop = S.createGraph(async url => ({value: [], '@odata.nextLink': url}), 'token');
  await assert.rejects(loop.all('/v1.0/me/todo/lists'), /remote-pagination-invalid/);
  const invalid = S.createGraph(async () => ({}), 'token'); await assert.rejects(invalid.all('/v1.0/me/todo/lists'), /remote-response-invalid/);
  const large = S.createGraph(async () => ({value: Array.from({length: 2001}, () => ({}))}), 'token'); await assert.rejects(large.all('/v1.0/me/todo/lists'), /remote-list-too-large/);
});
test('transport enforces timeouts/redirect refusal and keeps provider errors out of responses', async () => {
  let received;
  const transport = S.createTransport(async (url, opts) => { received = opts; return new Response('secret provider internals', {status: 429, headers: {'Retry-After': '120'}}); });
  await assert.rejects(transport('https://graph.microsoft.com/v1.0/me/todo/lists', {}, 'graph'), error => error.code === 'rate-limited' && error.retryAfter === 120 && !error.message.includes('secret'));
  assert.equal(received.redirect, 'error'); assert.ok(received.signal instanceof AbortSignal);
  assert.equal(D.retryDelay('9999999'), 86400); assert.equal(D.retryDelay(null, 2), 120);
});
test('database serialization failures expose retryable stable codes without SQL text', async () => {
  const transport = S.createTransport(async () => new Response(JSON.stringify({code: '40001', message: 'private SQL and credential fixture'}), {status: 500}));
  await assert.rejects(transport(config.database + '/rest/v1/rpc/fixture', {method: 'POST'}, 'database'), error => error.code === 'sync-busy' && error.status === 409 && !error.message.includes('private'));
});
test('schema denies browser connector access, captures metadata only, and revokes soft-deleted accounts', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../server/habit-sync.sql'), 'utf8');
  assert.match(sql, /revoke all on table[\s\S]*from public,anon,authenticated/);
  assert.match(sql, /for update of c skip locked/);
  assert.match(sql, /job\.revision<>requested_revision/);
  assert.match(sql, /after update of is_deleted,approval_status,auth_user_id on public\.profiles/);
  const source = sql.slice(sql.indexOf('function public.growell_habit_sync_source'), sql.indexOf('function public.growell_habit_sync_enqueue'));
  assert.ok(!source.includes('checked_dates'));
  assert.match(sql, /tg_op='INSERT'/); assert.match(sql, /p_operation='import'|p_operation in \('settings','import'\)/);
});
