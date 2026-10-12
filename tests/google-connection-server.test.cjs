'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Drive = require('../server/driveBackupDomain.cjs');
const Calendar = require('../server/meetingCalendarDomain.cjs');
const Service = require('../server/driveBackupService.cjs');
const Google = require('../server/googleConnectionService.cjs');

const NOW = Date.parse('2026-10-12T09:00:00+09:00');
const AUTH = '11111111-1111-4111-8111-111111111111';
const PROFILE = {id: 'fixture-member', auth_user_id: AUTH, approval_status: 'approved', is_deleted: false};
const CONFIG = Drive.getConfig({GROWELL_GOOGLE_CLIENT_ID: 'fixture-client', GROWELL_GOOGLE_CLIENT_SECRET: 'fixture-secret',
  GROWELL_SYNC_KEY: Buffer.alloc(32, 9).toString('base64'), SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', CRON_SECRET: 'fixture-cron'});
const TOKENS = {accessToken: 'fixture-access', refreshToken: 'fixture-refresh', scope: Drive.GOOGLE_SCOPES};
const IDENTITY = {subject: 'fixture-google-account', email: 'member@example.test'};

function fixture({scope = Drive.GOOGLE_SCOPES, driveFailure, calendarFailure} = {}) {
  const state = {pending: null, member: structuredClone(PROFILE), calls: [], writes: [], exchange: 0};
  const configure = (name, failure) => async (owner, auth, operation, payload) => {
    state.calls.push({name, owner, auth, operation, payload});
    if (failure) throw failure;
    state.writes.push({name, payload});
  };
  state.drive = {owner_id: PROFILE.id, auth_user_id: AUTH, generation: '22222222-2222-4222-8222-222222222222', token_cipher: 'fixture-drive-cipher',
    account_id: Drive.hash(IDENTITY.subject), account_email: IDENTITY.email, enabled: true, dirty_revision: 1, synced_revision: 1};
  state.calendar = {owner_id: PROFILE.id, auth_user_id: AUTH, generation: '33333333-3333-4333-8333-333333333333', token_cipher: 'fixture-calendar-cipher',
    account_id: Drive.hash(IDENTITY.subject), account_email: IDENTITY.email, enabled: true};
  const driveStore = {profile: async () => state.member, connection: async () => state.drive, configure: configure('drive', driveFailure),
    oauth: async (operation, payload) => { if (operation === 'put') { state.pending = payload; return {}; }
      const pending = state.pending; state.pending = null; return pending; }};
  const calendarStore = {connection: async () => state.calendar, jobs: async () => [], configure: configure('calendar', calendarFailure)};
  const provider = {exchange: async () => { state.exchange++; return {...TOKENS, scope}; }, identity: async () => IDENTITY};
  const service = Service.createService({config: CONFIG, store: driveStore, calendarStore, providerFactory: () => provider,
    now: () => NOW, request: async () => ({id: AUTH})});
  return {state, service, driveStore, calendarStore, provider};
}

async function finish(f, combined = true) {
  const start = await f.service.connect(PROFILE, combined), state = new URL(start.url).searchParams.get('state');
  const result = await f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=' + state);
  return {start, result, state};
}

test('one Google authorization uses the already registered Drive callback and both limited scopes', async () => {
  const f = fixture(), start = await f.service.connect(PROFILE, true), url = new URL(start.url);
  assert.equal(url.origin + url.pathname, Drive.AUTH_URL);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.origin + '/api/drive-backup');
  assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set(['openid', 'email', Drive.DRIVE_SCOPE, Calendar.CALENDAR_SCOPE]));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(start.cookie.includes('Secure; HttpOnly; SameSite=Lax'), true);
  assert.equal(JSON.stringify(f.state.pending).includes('googleConnection'), false);
});

test('one grant creates both owner-specific encrypted connections without exporting access tokens or source data', async () => {
  const f = fixture(), {result} = await finish(f);
  assert.equal(result, CONFIG.origin + '/?google-connection=connected#/');
  assert.equal(f.state.exchange, 1); assert.equal(f.state.writes.length, 2);
  const [drive, calendar] = f.state.writes;
  assert.deepEqual(f.state.calls.map(({name, owner, auth, operation}) => ({name, owner, auth, operation})), [
    {name: 'drive', owner: PROFILE.id, auth: AUTH, operation: 'connect'},
    {name: 'calendar', owner: PROFILE.id, auth: AUTH, operation: 'connect'}]);
  assert.equal(drive.payload.account_id, calendar.payload.account_id);
  assert.equal(drive.payload.account_id, Drive.hash(IDENTITY.subject));
  assert.equal(drive.payload.account_email, IDENTITY.email);
  assert.notEqual(drive.payload.generation, calendar.payload.generation);
  const driveToken = Drive.unseal(drive.payload.token_cipher, CONFIG.key, Drive.tokenContext(PROFILE.id, drive.payload.generation));
  const calendarToken = Calendar.unseal(calendar.payload.token_cipher, CONFIG.key, Calendar.tokenContext(PROFILE.id, calendar.payload.generation));
  assert.deepEqual(driveToken, {refreshToken: TOKENS.refreshToken, scope: Drive.GOOGLE_SCOPES});
  assert.deepEqual(calendarToken, driveToken);
  assert.throws(() => Calendar.unseal(drive.payload.token_cipher, CONFIG.key, Calendar.tokenContext(PROFILE.id, drive.payload.generation)), /connection-key-invalid/);
  for (const {payload} of f.state.calls) {
    assert.equal(JSON.stringify(payload).includes(TOKENS.refreshToken), false);
    for (const field of ['accessToken', 'folder_id', 'file_id', 'event_id', 'jobs', 'snapshot', 'records']) assert.equal(payload[field], undefined);
  }
});

test('granting only one permission cannot modify either prior connection', async () => {
  for (const scope of [Drive.SCOPES, Calendar.SCOPES, Drive.DRIVE_SCOPE + ' ' + Calendar.CALENDAR_SCOPE]) {
    const f = fixture({scope});
    await assert.rejects(finish(f), {code: 'consent-required'});
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.writes.length, 0);
  }
});

test('a partial store outage is reported and never disconnects a successfully connected service', async () => {
  for (const options of [{driveFailure: new Drive.BackupError('backup-busy', 409)}, {calendarFailure: new Calendar.CalendarError('calendar-busy', 409)}]) {
    const f = fixture(options), {result} = await finish(f);
    assert.equal(result, CONFIG.origin + '/?google-connection=partial#/');
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.calls.length, 2);
    assert.equal(f.state.calls.every(({operation}) => operation === 'connect'), true);
  }
});

test('both store failures produce a safe error and do not claim a successful connection', async () => {
  const f = fixture({driveFailure: new Error('secret storage detail'), calendarFailure: new Error('private provider detail')});
  await assert.rejects(finish(f), {code: 'service-unavailable'});
  assert.equal(f.state.writes.length, 0);
});

test('membership revocation between writes prevents the next connection and preserves the first success', async () => {
  const f = fixture(), configure = f.driveStore.configure;
  f.driveStore.configure = async (...args) => { await configure(...args); f.state.member.approval_status = 'pending'; };
  await assert.rejects(finish(f), {code: 'membership-required'});
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes.length, 1);
});

test('a permission failure in the first connector stops instead of claiming a partial success', async () => {
  const f = fixture({driveFailure: new Drive.BackupError('membership-required', 403)});
  await assert.rejects(finish(f), {code: 'membership-required'});
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes.length, 0);
});

test('the signed, encrypted pending state selects unified mode and remains single-use and browser-bound', async () => {
  const f = fixture(), start = await f.service.connect(PROFILE, true), state = new URL(start.url).searchParams.get('state');
  await assert.rejects(f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=another-browser'), {code: 'oauth-state-invalid'});
  assert.equal(f.state.exchange, 0); assert.ok(f.state.pending);
  await f.service.callback(new URLSearchParams({state, code: 'fixture-code', combined: 'false'}), Service.COOKIE + '=' + state);
  assert.equal(f.state.writes.length, 2);
  await assert.rejects(f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=' + state), {code: 'oauth-state-invalid'});
  assert.equal(f.state.exchange, 1);
});

test('legacy pending states retain their original single Drive callback behavior', async () => {
  const f = fixture({scope: Drive.SCOPES}), {result, start} = await finish(f, false);
  assert.equal(new URL(start.url).searchParams.get('scope'), Drive.SCOPES);
  assert.equal(result, CONFIG.origin + '/?drive-backup=connected#/');
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].name, 'drive');
});

test('HTTP connect always starts the combined flow, rejecting client owner, scopes and mode overrides', async () => {
  const f = fixture(), handler = Service.createHandler({service: f.service});
  async function invoke(body = {}, headers = {}) {
    const response = {headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.value = value; }};
    await handler({method: 'POST', url: '/api/drive-backup?action=connect', body,
      headers: {authorization: 'Bearer fixture.jwt', origin: CONFIG.origin, 'content-type': 'application/json', ...headers}}, response);
    return {...response, body: JSON.parse(response.value)};
  }
  const accepted = await invoke();
  assert.equal(accepted.statusCode, 200); assert.equal(new URL(accepted.body.url).searchParams.get('scope'), Drive.GOOGLE_SCOPES);
  for (const body of [{owner: 'another-member'}, {combined: false}, {scope: 'https://mail.google.com/'}]) assert.equal((await invoke(body)).statusCode, 400);
  assert.equal((await invoke({}, {origin: 'https://foreign.example'})).statusCode, 403);
});

test('both scope and refresh-token validation complete before connection writes', async () => {
  const saved = [];
  for (const tokens of [{...TOKENS, refreshToken: ''}, {...TOKENS, scope: ''}, {...TOKENS, scope: null}]) {
    await assert.rejects(Google.saveConnections({config: CONFIG, driveStore: {configure: async () => saved.push('drive')},
      calendarStore: {configure: async () => saved.push('calendar')}, approved: async () => PROFILE, owner: PROFILE.id, authId: AUTH, tokens, identity: IDENTITY}), {code: 'consent-required'});
  }
  assert.deepEqual(saved, []);
});

test('combined status compares stable Google subject hashes and never returns connector secrets', async () => {
  const f = fixture(), value = await f.service.googleStatus(PROFILE);
  assert.equal(value.connected, true); assert.equal(value.sameAccount, true); assert.equal(value.partial, false); assert.equal(value.unavailable, false);
  const serialized = JSON.stringify(value);
  for (const secret of ['fixture-drive-cipher', 'fixture-calendar-cipher', 'account_id', 'auth_user_id', 'generation', 'lease_token', 'owner_id']) assert.equal(serialized.includes(secret), false);
  // Changed or unavailable display email cannot change authenticated identity.
  f.state.calendar.account_email = '';
  assert.equal((await f.service.googleStatus(PROFILE)).sameAccount, true);
  f.state.calendar.account_id = Drive.hash('another-google-account');
  const mismatch = await f.service.googleStatus(PROFILE);
  assert.equal(mismatch.sameAccount, false); assert.equal(mismatch.connected, false); assert.equal(mismatch.partial, true);
});

test('single-service failure keeps the known status and marks unavailable state without claiming disconnection', async () => {
  for (const target of ['driveStore', 'calendarStore']) {
    const f = fixture(); f[target].connection = async () => { throw new Error('secret db detail'); };
    const result = await f.service.googleStatus(PROFILE);
    const failed = target === 'driveStore' ? result.drive : result.calendar, known = target === 'driveStore' ? result.calendar : result.drive;
    assert.equal(failed.connected, null); assert.equal(failed.unavailable, true); assert.equal(failed.errorCode, 'service-unavailable');
    assert.equal(known.connected, true); assert.equal(result.connected, null); assert.equal(result.sameAccount, null);
    assert.equal(result.partial, true); assert.equal(result.unavailable, true); assert.equal(JSON.stringify(result).includes('secret db detail'), false);
  }
});

test('no connections are distinct from a failed status lookup and foreign connection ownership fails closed', async () => {
  const f = fixture(); f.state.drive = null; f.state.calendar = null;
  const empty = await f.service.googleStatus(PROFILE);
  assert.equal(empty.connected, false); assert.equal(empty.partial, false); assert.equal(empty.unavailable, false);
  const foreign = fixture(); foreign.state.calendar.owner_id = 'another-member';
  await assert.rejects(foreign.service.googleStatus(PROFILE), {code: 'membership-required'});
});

test('calendar job lookup failures are unknown and cannot remove successful Drive status', async () => {
  const f = fixture(); f.calendarStore.jobs = async () => { throw new Error('private job content'); };
  const failed = await f.service.googleStatus(PROFILE);
  assert.equal(failed.drive.connected, true); assert.equal(failed.calendar.connected, null); assert.equal(failed.connected, null);
  f.calendarStore.jobs = async () => [{owner_id: 'another-member', generation: f.state.calendar.generation}];
  const foreign = await f.service.googleStatus(PROFILE);
  assert.equal(foreign.calendar.unavailable, true); assert.equal(foreign.calendar.errorCode, 'service-unavailable');
  assert.equal(foreign.calendar.jobs, undefined);
});

test('combined status is authenticated and same-source filtered without accepting browser identifiers', async () => {
  const f = fixture(), handler = Service.createHandler({service: f.service});
  const invoke = async headers => {
    const response = {headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.value = value; }};
    await handler({method: 'GET', url: '/api/drive-backup?action=google-status&owner=another-member', headers}, response);
    return {...response, body: JSON.parse(response.value)};
  };
  assert.equal((await invoke({})).statusCode, 401);
  const accepted = await invoke({authorization: 'Bearer fixture.jwt'});
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.body.connected, true);
  assert.equal(accepted.headers['cache-control'], 'no-store, private');
});
