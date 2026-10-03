'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/driveBackupDomain.cjs');
const {createProvider} = require('../server/driveBackupProvider.cjs');
const config = D.getConfig({GROWELL_GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GROWELL_GOOGLE_CLIENT_SECRET: 'test-secret',
  GROWELL_SYNC_KEY: Buffer.alloc(32, 4).toString('base64'), SUPABASE_SERVICE_ROLE_KEY: 'test-service', CRON_SECRET: 'test-cron'});
const NOW = Date.UTC(2026, 9, 4), FOLDER = 'fixture_folder', FILE = 'fixture_file', ROOT = 'fixture_root', PERMISSION = 'fixture_permission';
const MARKER = D.marker('member-fixture', 'google-fixture', config.key);
const content = JSON.stringify({records: [{id: 'record-fixture', data: 'synthetic-ciphertext'}]});
const reply = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), {status, headers});
const validToken = () => ({access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', scope: D.SCOPES});
function meta(id) {
  const folder = id === FOLDER;
  return {id, name: folder ? D.FOLDER_NAME : D.FILE_NAME, mimeType: folder ? 'application/vnd.google-apps.folder' : 'application/json',
    parents: [folder ? ROOT : FOLDER], trashed: false, shared: false, ownedByMe: true, owners: [{permissionId: PERMISSION, me: true}],
    appProperties: {growellBackup: 'v1', owner: MARKER, role: folder ? 'folder' : 'latest'}, capabilities: {canEdit: true, canAddChildren: folder}};
}
function fixture({existing = true, mutate, handle} = {}) {
  const resources = new Map(existing ? [[FOLDER, meta(FOLDER)], [FILE, meta(FILE)]] : []), calls = [], uploads = [];
  if (mutate) mutate(resources);
  const fetch = async (url, init) => {
    const call = {url: String(url), ...init}, parsed = new URL(url);
    calls.push(call);
    if (handle) { const response = await handle(call, resources, calls); if (response) return response; }
    if (parsed.pathname === '/drive/v3/about') return reply({user: {permissionId: PERMISSION}});
    if (parsed.pathname === '/drive/v3/files/root') return reply({id: ROOT});
    if (parsed.pathname === '/drive/v3/files/generateIds') return reply({ids: [FOLDER, FILE].slice(0, Number(parsed.searchParams.get('count')))});
    if (parsed.pathname === '/drive/v3/files' && init.method === 'POST') {
      const data = JSON.parse(init.body);
      if (resources.has(data.id)) return reply({error: 'conflict'}, 409);
      resources.set(data.id, {...meta(data.id), ...data});
      return reply({id: data.id});
    }
    if (parsed.pathname.startsWith('/drive/v3/files/')) return resources.has(parsed.pathname.split('/').at(-1)) ? reply(resources.get(parsed.pathname.split('/').at(-1))) : reply({error: 'missing'}, 404);
    if (parsed.pathname === '/upload/drive/v3/files/' + FILE) {
      if (parsed.searchParams.get('uploadType') === 'resumable' && init.method === 'PATCH') return reply(null, 200, {location: D.DRIVE_ORIGIN + parsed.pathname + '?uploadType=resumable&upload_id=fixture_upload'});
      uploads.push(init.body); return reply({id: FILE, size: String(Buffer.byteLength(init.body))});
    }
    throw new Error('Unexpected test endpoint: ' + parsed.pathname);
  };
  const provider = createProvider(config, {fetch, now: () => NOW});
  const write = extra => provider.writeBackup({accessToken: 'fixture-access', folderId: FOLDER, fileId: FILE, marker: MARKER, content,
    folderCreated: existing, fileCreated: existing, ...extra});
  return {resources, calls, uploads, provider, write, fetch};
}

test('Drive OAuth configuration is server-only and rejects unsafe origins and malformed keys', () => {
  assert.equal(config.configured, true);
  assert.equal(config.redirectUri, 'https://growell-book.vercel.app/api/drive-backup');
  for (const env of [{}, {GROWELL_SYNC_ORIGIN: 'https://example.com/redirect'}, {GROWELL_SYNC_ORIGIN: 'https://user:password@example.com'}, {GROWELL_SUPABASE_URL: 'https://attacker.example'}, {GROWELL_SYNC_KEY: 'invalid'}]) {
    assert.equal(D.getConfig(env).configured, false);
  }
});
test('OAuth requests only app-created files, account identity, offline consent and S256 PKCE', () => {
  const verifier = 'v'.repeat(64), state = 's'.repeat(48), url = new URL(D.authorizationUrl(config, {state, verifier}));
  assert.equal(url.origin + url.pathname, D.AUTH_URL);
  assert.equal(url.searchParams.get('scope'), D.SCOPES);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), Buffer.from(D.hash(verifier), 'hex').toString('base64url'));
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.throws(() => D.authorizationUrl(config, {state: 'short', verifier}), /invalid-request/);
});
test('Drive token ciphers are bound to account owner and connection generation', () => {
  const value = {refreshToken: 'fixture-refresh'}, context = D.tokenContext('member-a', 'generation-a');
  const encrypted = D.seal(value, config.key, context);
  assert.deepEqual(D.unseal(encrypted, config.key, context), value);
  assert.throws(() => D.unseal(encrypted, config.key, D.tokenContext('member-b', 'generation-a')), /connection-key-invalid/);
  assert.throws(() => D.unseal(encrypted, config.key, D.tokenContext('member-a', 'generation-b')), /connection-key-invalid/);
  assert.equal(D.marker('member-a', 'account-a', config.key), D.marker('member-a', 'account-a', config.key));
  assert.notEqual(D.marker('member-a', 'account-a', config.key), D.marker('member-a', 'account-b', config.key));
});
test('Code exchange uses the fixed Google endpoint, PKCE and configured callback', async () => {
  let captured;
  const p = createProvider(config, {now: () => NOW, fetch: async (url, init) => { captured = {url, init}; return reply(validToken()); }});
  const tokens = await p.exchange({code: 'fixture-code', verifier: 'v'.repeat(64)}), body = new URLSearchParams(captured.init.body);
  assert.equal(captured.url, D.TOKEN_URL);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(body.get('redirect_uri'), config.redirectUri);
  assert.equal(body.get('code_verifier'), 'v'.repeat(64));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(tokens.expiresAt, NOW + 3600000);
});
test('Refresh preserves prior scope and refresh token when Google omits those fields', async () => {
  const p = createProvider(config, {now: () => NOW, fetch: async () => reply({access_token: 'next-access', expires_in: 3600, token_type: 'Bearer'})});
  const next = await p.refresh({accessToken: 'old-access', refreshToken: 'saved-refresh', scope: D.SCOPES});
  assert.equal(next.refreshToken, 'saved-refresh');
  assert.equal(next.scope, D.SCOPES);
  assert.equal(next.accessToken, 'next-access');
});
test('Incomplete consent and missing offline token fail before creating Drive files', async () => {
  for (const change of [{scope: 'openid email'}, {scope: D.DRIVE_SCOPE}, {refresh_token: ''}, {token_type: 'mac'}, {expires_in: -1}]) {
    const p = createProvider(config, {fetch: async () => reply({...validToken(), ...change})});
    await assert.rejects(p.exchange({code: 'fixture-code', verifier: 'v'.repeat(64)}), error => ['backup-permission-denied', 'reconnect-required'].includes(error.code));
  }
});
test('Identity is read using the exchanged access token and only verified email is displayed', async () => {
  let seen;
  const p = createProvider(config, {fetch: async (url, init) => { seen = {url, init}; return reply({sub: 'fixture-subject', email: 'fixture@example.test', email_verified: true}); }});
  assert.deepEqual(await p.identity('fixture-access'), {subject: 'fixture-subject', email: 'fixture@example.test'});
  assert.equal(seen.url, D.USERINFO_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer fixture-access');
  const unverified = createProvider(config, {fetch: async () => reply({sub: 'fixture-subject', email: 'unverified@example.test', email_verified: false})});
  assert.equal((await unverified.identity('fixture-access')).email, '');
});
test('Provider failures do not disclose response bodies, tokens, or client secrets', async () => {
  const p = createProvider(config, {fetch: async () => reply({error: 'fixture-access test-secret saved-refresh'}, 400)});
  await assert.rejects(p.exchange({code: 'fixture-code', verifier: 'v'.repeat(64)}), error => error.message === 'reconnect-required' && !JSON.stringify(error).includes('test-secret'));
});
test('Only generated IDs are returned; duplicate and unsafe IDs are rejected', async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.allocateIds('fixture-access'), [FOLDER, FILE]);
  for (const ids of [[FOLDER, FOLDER], [FOLDER, '../outside'], [FOLDER]]) {
    const p = createProvider(config, {fetch: async () => reply({ids})});
    await assert.rejects(p.allocateIds('fixture-access'), /backup-response-invalid/);
  }
});
test('Initial backup creates metadata first, persists each creation, then uploads exact JSON', async () => {
  const f = fixture({existing: false}), progress = []; let guards = 0;
  const result = await f.write({onCreated: async event => progress.push(event), beforeWrite: async () => { guards++; }});
  assert.deepEqual(progress, [{folderCreated: true, fileCreated: false}, {folderCreated: true, fileCreated: true}]);
  assert.equal(guards, 3);
  assert.equal(result.bytes, Buffer.byteLength(content));
  assert.deepEqual(f.uploads, [content]);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  assert.ok(f.calls.every(call => call.redirect === 'error'));
  assert.ok(f.calls.every(call => !call.url.includes('files?') || call.method === 'POST'));
});
test('Repeated backups update the same persisted file without creating duplicates', async () => {
  const f = fixture();
  await f.write(); await f.write();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(f.uploads.length, 2);
});
test('Known deleted resources are not silently recreated or replaced', async () => {
  for (const id of [FOLDER, FILE]) {
    const f = fixture({mutate: resources => resources.delete(id)});
    await assert.rejects(f.write(), /backup-remote-missing/);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
});
test('Uncertain metadata creation retries the same allocated ID and never duplicates files', async () => {
  let uncertain = true;
  const f = fixture({existing: false, handle: (call, resources) => {
    if (uncertain && call.method === 'POST') { uncertain = false; resources.set(FOLDER, meta(FOLDER)); throw new Error('timeout fixture-secret'); }
  }});
  await assert.rejects(f.write(), error => error.code === 'backup-unavailable' && error.uncertain);
  await f.write();
  assert.equal(f.resources.size, 2);
  assert.equal(f.calls.filter(call => call.method === 'POST' && JSON.parse(call.body).id === FOLDER).length, 1);
  assert.deepEqual(f.uploads, [content]);
});
test('A concurrent create conflict is accepted only after verifying the exact resource', async () => {
  let conflict = true;
  const f = fixture({existing: false, handle: (call, resources) => {
    if (conflict && call.method === 'POST') { conflict = false; resources.set(FOLDER, meta(FOLDER)); return reply(null, 409); }
  }});
  await f.write();
  assert.deepEqual(f.uploads, [content]);
});
for (const [label, mutate] of [
  ['shared', item => { item.shared = true; }],
  ['trashed', item => { item.trashed = true; }],
  ['moved', item => { item.parents = ['other_folder']; }],
  ['not owned', item => { item.ownedByMe = false; }],
  ['different owner', item => { item.owners[0].permissionId = 'other_owner'; }],
  ['shared drive', item => { item.driveId = 'shared_drive'; }],
  ['forged marker', item => { item.appProperties.owner = 'a'.repeat(64); }],
  ['shortcut', item => { item.mimeType = 'application/vnd.google-apps.shortcut'; }],
  ['read only', item => { item.capabilities.canEdit = false; }],
  ['unknown sharing state', item => { delete item.shared; }]
]) {
  test('Private data is never uploaded to ' + label + ' backup resources', async () => {
    for (const id of [FOLDER, FILE]) {
      const f = fixture({mutate: resources => mutate(resources.get(id))});
      await assert.rejects(f.write(), error => error.code === (id === FOLDER ? 'backup-folder-unsafe' : 'backup-file-unsafe'));
      assert.equal(f.uploads.length, 0);
    }
  });
}
test('Folder and file safety is checked again immediately before transmitting member data', async () => {
  const f = fixture({existing: false});
  await assert.rejects(f.write({onCreated: async event => { if (event.fileCreated) f.resources.get(FOLDER).shared = true; }}), /backup-folder-unsafe/);
  assert.equal(f.uploads.length, 0);
});
test('A membership or generation guard cancellation prevents subsequent remote writes', async () => {
  const f = fixture();
  await assert.rejects(f.write({beforeWrite: async () => { throw new D.BackupError('connection-required', 409); }}), /connection-required/);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.calls.filter(call => call.method && call.method !== 'GET').length, 0);
});
test('Creation progress persistence failure stops before sending any member data', async () => {
  const f = fixture({existing: false});
  await assert.rejects(f.write({onCreated: async () => { throw new D.BackupError('backup-busy', 409); }}), /backup-busy/);
  assert.equal(f.resources.size, 1);
  assert.equal(f.uploads.length, 0);
});
test('Large JSON uses a pinned resumable session and transmits original UTF-8 bytes', async () => {
  const f = fixture(), large = JSON.stringify({data: '한'.repeat(1800000)}); let guards = 0;
  await f.write({content: large, beforeWrite: async () => { guards++; }});
  assert.equal(guards, 2);
  assert.equal(f.uploads[0], large);
  assert.equal(f.calls.find(call => call.method === 'PUT').headers['Content-Length'], String(Buffer.byteLength(large)));
});
test('A provider supplied foreign or wrong-file upload URL never receives tokens or member data', async () => {
  for (const location of ['https://evil.example/upload', D.DRIVE_ORIGIN + '/upload/drive/v3/files/other_file?uploadType=resumable&upload_id=x']) {
    const f = fixture({handle: call => call.method === 'PATCH' ? reply(null, 200, {location}) : undefined});
    await assert.rejects(f.write({content: JSON.stringify({data: 'a'.repeat(6 * 1024 * 1024)})}), /backup-response-invalid/);
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
    assert.equal(f.uploads.length, 0);
  }
});
test('An oversized or invalid snapshot fails before any Drive request', async () => {
  const f = fixture();
  await assert.rejects(f.write({content: JSON.stringify({data: 'a'.repeat(D.MAX_CONTENT_BYTES)})}), /backup-too-large/);
  await assert.rejects(f.write({content: '[]'}), /invalid-request/);
  await assert.rejects(f.write({fileId: '../not-a-file'}), /invalid-request/);
  assert.equal(f.calls.length, 0);
});
test('The worker deadline defers before beginning a request that may exceed its lease', async () => {
  let calls = 0;
  const p = createProvider(config, {now: () => NOW, deadline: NOW + 5000, fetch: async () => { calls++; return reply({}); }});
  await assert.rejects(p.allocateIds('fixture-access'), /backup-deferred/);
  assert.equal(calls, 0);
});
test('Rate limits expose only a bounded retry delay', async () => {
  const p = createProvider(config, {now: () => NOW, fetch: async () => reply({private: 'never disclose'}, 429, {'retry-after': '999999'})});
  await assert.rejects(p.allocateIds('fixture-access'), error => error.code === 'rate-limited' && error.retryAfter === 86400 && error.status === 429);
});
test('Google 403 rate and storage limits are distinguished from account permission denial', async () => {
  for (const [reason, code] of [['rateLimitExceeded', 'rate-limited'], ['userRateLimitExceeded', 'rate-limited'], ['storageQuotaExceeded', 'backup-storage-full'], ['insufficientPermissions', 'backup-permission-denied']]) {
    const p = createProvider(config, {fetch: async () => reply({error: {errors: [{reason}]}}, 403)});
    await assert.rejects(p.allocateIds('fixture-access'), error => error.code === code);
  }
});
test('A mismatched upload confirmation is never recorded as successful', async () => {
  for (const body of [{id: 'other_file', size: String(Buffer.byteLength(content))}, {id: FILE, size: '1'}]) {
    const f = fixture({handle: call => call.method === 'PATCH' ? reply(body) : undefined});
    await assert.rejects(f.write(), error => error.code === 'backup-response-invalid' && error.uncertain);
  }
});
