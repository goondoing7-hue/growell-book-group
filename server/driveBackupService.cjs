'use strict';

const crypto = require('node:crypto');
const D = require('./driveBackupDomain.cjs');
const {createProvider} = require('./driveBackupProvider.cjs');
const {saveConnections, requireGrantedScopes, verifiedGoogleAccount, loadGoogleAccount, enabledIntent} = require('./googleConnectionService.cjs');
const CalendarService = require('./meetingCalendarService.cjs');
const MailService = require('./meetingMailService.cjs');
const COOKIE = '__Host-growell-drive-backup';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLES = Object.freeze(['private_entries', 'habits', 'material_notes', 'posts', 'comments', 'worksheets', 'reading_logs', 'reading_meta']);
const MAX_BYTES = 20 * 1024 * 1024;
const CODES = new Set(['not-configured', 'authentication-required', 'membership-required', 'invalid-request', 'connection-required', 'service-unavailable', 'rate-limited', 'backup-busy', 'sync-busy', 'backup-stale', 'backup-too-large', 'snapshot-invalid', 'oauth-state-invalid', 'oauth-cancelled', 'consent-required', 'identity-invalid', 'google-account-mismatch', 'connection-key-invalid', 'reconnect-required', 'backup-folder-unsafe', 'backup-file-unsafe', 'backup-remote-missing', 'remote-unavailable', 'remote-response-invalid', 'backup-deferred', 'unsafe-remote-url', 'backup-not-configured', 'backup-permission-denied', 'backup-unavailable', 'backup-response-invalid', 'backup-identity-invalid', 'backup-remote-conflict']);
function safeError(error) { return error?.code === 'backup-storage-full' ? 'backup-storage-full' : CODES.has(error?.code) ? error.code : 'service-unavailable'; }

function createTransport(fetchImpl = globalThis.fetch) {
  return async function request(url, options = {}, kind = 'database') {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl(url, {...options, signal: controller.signal, redirect: 'error'});
      if (!res.ok) {
        let code = 'service-unavailable', status = 503;
        if (kind === 'auth' && [401,403].includes(res.status)) { code = 'authentication-required'; status = 401; }
        if (kind === 'database') {
          const text = await res.text();
          let dbCode;
          try { dbCode = text.length < 16000 ? JSON.parse(text).code : ''; } catch (_) { /* no provider text crosses API */ }
          if (['42883','PGRST202'].includes(dbCode) && new URL(url).pathname.startsWith('/rest/v1/rpc/growell_meeting_mail_')) { code = 'not-configured'; }
          if (dbCode === '42501') { code = 'membership-required'; status = 403; }
          if (dbCode === '40001') { code = 'backup-busy'; status = 409; }
          if (dbCode === '55000') { code = 'connection-required'; status = 409; }
          if (dbCode === '22023') { code = 'invalid-request'; status = 400; }
          if (['54000','22001'].includes(dbCode)) { code = 'backup-too-large'; status = 413; }
        }
        if (res.status === 429) { code = 'rate-limited'; status = 429; }
        throw new D.BackupError(code, status);
      }
      if (res.status === 204) return null;
      const chunks = []; let size = 0;
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        while (true) {
          const {value,done} = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES + 1024 * 1024) { await reader.cancel(); throw new D.BackupError('backup-too-large', 413); }
          chunks.push(Buffer.from(value));
        }
      } else {
        const raw = Buffer.from(await res.text()); size = raw.length; chunks.push(raw);
      }
      if (size > MAX_BYTES + 1024 * 1024) throw new D.BackupError('backup-too-large', 413);
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof D.BackupError) throw error;
      throw new D.BackupError('service-unavailable', 503);
    } finally { clearTimeout(timer); }
  };
}

function createStore(config, request) {
  const headers = {apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, 'Content-Type': 'application/json'};
  const db = (path, method = 'GET', body) => request(config.database + '/rest/v1/' + path, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const rpc = (name, body) => db('rpc/growell_drive_backup_' + name, 'POST', body);
  return {
    async profile(authId) {
      const rows = await db('profiles?select=id,auth_user_id,is_deleted,approval_status&auth_user_id=eq.' + encodeURIComponent(authId) + '&limit=2');
      if (!Array.isArray(rows)) throw new D.BackupError('service-unavailable');
      return rows.length === 1 ? rows[0] : null;
    },
    async connection(owner) {
      const rows = await db('growell_drive_backup_connections?select=*&owner_id=eq.' + encodeURIComponent(owner) + '&limit=1');
      if (!Array.isArray(rows)) throw new D.BackupError('service-unavailable');
      return rows[0] || null;
    },
    oauth: (operation, payload) => rpc('oauth', {p_operation: operation, p_payload: payload}),
    configure: (owner, authId, operation, payload = {}) => rpc('configure', {p_owner: owner, p_auth: authId, p_operation: operation, p_payload: payload}),
    claim: (owner = null, limit = 1) => rpc('claim', {p_owner: owner, p_limit: limit}),
    apply: (connection, operation, payload = {}) => rpc('apply', {p_owner: connection.owner_id, p_generation: connection.generation, p_lease: connection.lease_token, p_operation: operation, p_payload: payload}),
    snapshot: connection => rpc('snapshot', {p_owner: connection.owner_id, p_generation: connection.generation, p_lease: connection.lease_token})
  };
}

function safeConnection(c, now = Date.now()) {
  const connected = !!c?.token_cipher;
  return {configured: true, connected, enabled: connected && !!c.enabled,
    accountEmail: connected ? D.clean(c.account_email || '', 254) : '',
    folderUrl: connected && c.folder_created && /^[A-Za-z0-9_-]+$/.test(c.folder_id || '') ? 'https://drive.google.com/drive/folders/' + c.folder_id : null,
    lastBackedUpAt: c?.last_synced_at || null,
    pending: connected && (Number(c.dirty_revision) > Number(c.synced_revision) || !!c.manual_requested),
    busy: connected && !!c.lease_token && Date.parse(c.lease_until) > now,
    errorCode: c?.error_code ? safeError({code: c.error_code}) : null,
    counts: c?.last_counts && typeof c.last_counts === 'object' ? Object.fromEntries(TABLES.map(table => [table, Math.max(0, Number(c.last_counts[table]) || 0)])) : null};
}

function buildBackup(snapshot, owner, now) {
  if (!snapshot || !Number.isSafeInteger(Number(snapshot.revision)) || Number(snapshot.revision) < 1 || !snapshot.data || typeof snapshot.data !== 'object') throw new D.BackupError('snapshot-invalid');
  const data = {}, counts = {};
  for (const table of TABLES) {
    const rows = snapshot.data[table];
    // Missing/error/truncated snapshots never replace a successful Drive file.
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || row.user_id !== owner)) throw new D.BackupError('snapshot-invalid');
    data[table] = rows; counts[table] = rows.length;
  }
  const hash = D.hash(JSON.stringify(data));
  const content = JSON.stringify({format: 'growell-backup', version: 1, createdAt: new Date(now).toISOString(), ownerId: owner,
    revision: Number(snapshot.revision), counts, contentHash: hash,
    notes: {privateRecords: '개인 기록은 원래 암호화된 상태입니다. 별도 보관한 GROWELL 복구 파일의 키가 필요합니다.', attachments: '첨부파일은 저장된 주소를 보존합니다. 외부 첨부파일 원본은 포함되지 않습니다.', direction: 'GROWELL에서 Google Drive로 저장하는 백업입니다. 이 파일을 수정해도 GROWELL에는 반영되지 않습니다.'}, data});
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new D.BackupError('backup-too-large', 413);
  return {content, hash, counts, revision: Number(snapshot.revision)};
}

function createService(options = {}) {
  const config = options.config || D.getConfig(), now = options.now || Date.now;
  const request = options.request || createTransport(options.fetch);
  const store = options.store || createStore(config, request);
  const calendarStore = options.calendarStore || CalendarService.createStore(config, CalendarService.createTransport(options.fetch));
  const mailStore = options.mailStore || MailService.createStore(config, request);
  const loginAccounts = new WeakMap();
  const providerFactory = options.providerFactory || (deadline => createProvider(config, {fetch: options.fetch, now, deadline}));
  const callbackRedirect = state => config.origin + '/?drive-backup=' + state + '#/';
  const oauthContext = (owner, hash) => 'drive-backup-oauth:' + owner + ':' + hash;
  function requireConfigured() { if (!config.configured) throw new D.BackupError('not-configured', 503); }
  async function approved(authId, owner) {
    const p = await store.profile(authId);
    if (!p || p.auth_user_id !== authId || p.is_deleted !== false || p.approval_status !== 'approved' || (owner && p.id !== owner)) throw new D.BackupError('membership-required', 403);
    return p;
  }
  async function authenticate(req) {
    requireConfigured();
    const match = /^Bearer ([A-Za-z0-9._~-]{1,16000})$/.exec(req.headers.authorization || '');
    if (!match) throw new D.BackupError('authentication-required', 401);
    const user = await request(config.database + '/auth/v1/user', {headers: {apikey: config.serviceKey, Authorization: 'Bearer ' + match[1]}}, 'auth');
    if (!UUID.test(user?.id || '')) throw new D.BackupError('authentication-required', 401);
    const profile = await approved(user.id);
    loginAccounts.set(profile, verifiedGoogleAccount(user, user.id));
    return profile;
  }
  async function loginAccount(profile) {
    return loginAccounts.has(profile) ? loginAccounts.get(profile) : loadGoogleAccount({config, request, authId:profile.auth_user_id});
  }
  function ownedConnection(profile, connection) {
    if (connection && (connection.owner_id !== profile.id || connection.auth_user_id !== profile.auth_user_id)) throw new D.BackupError('membership-required', 403);
    return connection;
  }
  async function ensureGoogleAccount(profile, service = 'drive') {
    const expected = await loginAccount(profile);
    if (!expected) return;
    const values = await Promise.all((service === 'mail' ? [store, calendarStore] : [service === 'calendar' ? calendarStore : store]).map(value => value.connection(profile.id)));
    for (const value of values) {
      const connection = ownedConnection(profile, value);
      if (connection?.token_cipher && !D.equal(connection.account_id, expected)) throw new D.BackupError('google-account-mismatch', 409);
    }
  }
  async function currentEnabled(profile) {
    const values = await Promise.all([store.connection(profile.id), calendarStore.connection(profile.id), mailStore.configure(profile.id, profile.auth_user_id, 'status')]);
    const drive = ownedConnection(profile, values[0]), calendar = ownedConnection(profile, values[1]), mail = MailService.safeStatus(values[2]);
    for (const value of [drive, calendar]) if (value && typeof value.enabled !== 'boolean') throw new D.BackupError('service-unavailable');
    return {drive:!!(drive?.token_cipher && drive.enabled), calendar:!!(calendar?.token_cipher && calendar.enabled), mail:mail.connected && mail.enabled};
  }
  async function status(profile) {
    const c = await store.connection(profile.id);
    if (c && (c.owner_id !== profile.id || c.auth_user_id !== profile.auth_user_id)) throw new D.BackupError('membership-required', 403);
    return safeConnection(c, now());
  }
  async function googleStatus(profile) {
    const expected = await loginAccount(profile);
    const results = await Promise.allSettled([store.connection(profile.id), calendarStore.connection(profile.id)]);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value && (result.value.owner_id !== profile.id || result.value.auth_user_id !== profile.auth_user_id)) {
        throw new D.BackupError('membership-required', 403);
      }
    }
    const unavailable = error => ({configured: true, connected: null, enabled: null, accountEmail: '', unavailable: true, errorCode: safeError(error)});
    const driveConnection = results[0].status === 'fulfilled' ? results[0].value : null;
    const calendarConnection = results[1].status === 'fulfilled' ? results[1].value : null;
    const drive = results[0].status === 'fulfilled' ? safeConnection(driveConnection, now()) : unavailable(results[0].reason);
    let calendar;
    if (results[1].status === 'rejected') calendar = unavailable(results[1].reason);
    else {
      try {
        const jobs = calendarConnection?.token_cipher ? await calendarStore.jobs(profile.id, calendarConnection.generation) : [];
        if (!Array.isArray(jobs) || jobs.some(job => job.owner_id !== profile.id || job.generation !== calendarConnection?.generation)) {
          throw new D.BackupError('service-unavailable');
        }
        calendar = CalendarService.safeConnection(calendarConnection, jobs, now());
      } catch (error) { calendar = unavailable(error); }
    }
    const unknown = drive.unavailable === true || calendar.unavailable === true;
    const bothConnected = drive.connected === true && calendar.connected === true;
    const sameAccount = unknown ? null : bothConnected && typeof driveConnection.account_id === 'string' && driveConnection.account_id !== ''
      && D.equal(driveConnection.account_id, calendarConnection.account_id);
    const connected = unknown ? null : bothConnected && sameAccount;
    let mail;
    try { mail = MailService.safeStatus(await mailStore.configure(profile.id, profile.auth_user_id, 'status')); }
    catch (error) {
      mail = error?.code === 'not-configured' ? {configured:false} : unavailable(error);
    }
    const matches = connection => expected && connection?.token_cipher ? D.equal(connection.account_id, expected) : null;
    drive.loginAccountMatches = drive.unavailable ? null : matches(driveConnection);
    calendar.loginAccountMatches = calendar.unavailable ? null : matches(calendarConnection);
    mail.loginAccountMatches = mail.connected === true && expected ? sameAccount && drive.loginAccountMatches === true : null;
    const loginAccountMatches = expected ? unknown ? null : [drive.loginAccountMatches,calendar.loginAccountMatches,mail.loginAccountMatches].some(value => value === false) ? false : connected ? true : null : null;
    return {configured: true, drive, calendar, mail, sameAccount, connected, googleLoginLinked:!!expected, loginAccountMatches,
      partial: (drive.connected === true || calendar.connected === true) && connected !== true, unavailable: unknown};
  }
  async function connect(profile, combined = false, service) {
    if (service !== undefined && !['drive','calendar','mail'].includes(service)) throw new D.BackupError('invalid-request', 400);
    if (service !== undefined && !combined) throw new D.BackupError('invalid-request', 400);
    const expectedAccount = await loginAccount(profile);
    const desiredEnabled = service === undefined ? undefined : {...await currentEnabled(profile), [service]:true};
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url'), stateHash = D.hash(state);
    await store.oauth('put', {state_hash: stateHash, owner_id: profile.id, auth_user_id: profile.auth_user_id,
      verifier_cipher: D.seal({verifier, expectedAccount, ...(combined ? {googleConnection: true} : {}), ...(desiredEnabled ? {service, desiredEnabled} : {})}, config.key, oauthContext(profile.id, stateHash)), expires_at: new Date(now() + 600000).toISOString()});
    return {url: D.authorizationUrl(config, {state, verifier, combined}), cookie: COOKIE + '=' + state + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'};
  }
  async function callback(query, cookies) {
    requireConfigured();
    const state = query.get('state') || '', cookie = String(cookies || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !D.equal(state, cookie)) throw new D.BackupError('oauth-state-invalid', 400);
    const pending = await store.oauth('consume', {state_hash: D.hash(state)});
    if (!pending || !Number.isFinite(Date.parse(pending.expires_at)) || Date.parse(pending.expires_at) <= now()) throw new D.BackupError('oauth-state-invalid', 400);
    await approved(pending.auth_user_id, pending.owner_id);
    if (query.get('error') || !query.get('code') || query.get('code').length > 16000) throw new D.BackupError('oauth-cancelled', 400);
    const {verifier, googleConnection, expectedAccount, service, desiredEnabled:storedIntent} = D.unseal(pending.verifier_cipher, config.key, oauthContext(pending.owner_id, D.hash(state)));
    if (expectedAccount !== undefined && expectedAccount !== null && (typeof expectedAccount !== 'string' || !/^[a-f0-9]{64}$/.test(expectedAccount))) throw new D.BackupError('oauth-state-invalid', 400);
    const desiredEnabled = enabledIntent(storedIntent);
    if (desiredEnabled && !['drive','calendar','mail'].includes(service)) throw new D.BackupError('oauth-state-invalid', 400);
    const currentAccount = await loadGoogleAccount({config, request, authId:pending.auth_user_id});
    if (expectedAccount && !D.equal(expectedAccount, currentAccount)) throw new D.BackupError('google-account-mismatch', 409);
    const provider = providerFactory(now() + 35000), tokens = await provider.exchange({code: query.get('code'), verifier});
    if (!tokens.refreshToken) throw new D.BackupError('consent-required', 403);
    if (googleConnection === true) requireGrantedScopes(tokens);
    const identity = await provider.identity(tokens.accessToken), generation = crypto.randomUUID();
    if ((currentAccount || expectedAccount) && !D.equal(D.hash(identity.subject), currentAccount || expectedAccount)) throw new D.BackupError('google-account-mismatch', 409);
    const finalAccount = await loadGoogleAccount({config, request, authId:pending.auth_user_id});
    if (!D.equal(currentAccount || '', finalAccount || '') || finalAccount && !D.equal(D.hash(identity.subject), finalAccount)) throw new D.BackupError('google-account-mismatch', 409);
    await approved(pending.auth_user_id, pending.owner_id);
    if (googleConnection === true) {
      const result = await saveConnections({config, driveStore: store, calendarStore, mailStore, approved, owner: pending.owner_id,
        authId: pending.auth_user_id, tokens, identity, desiredEnabled, requestedService:service});
      return config.origin + '/?google-connection=' + result + '#/';
    }
    await store.configure(pending.owner_id, pending.auth_user_id, 'connect', {generation, account_id: D.hash(identity.subject), account_email: identity.email,
      token_cipher: D.seal({refreshToken: tokens.refreshToken, scope: tokens.scope}, config.key, D.tokenContext(pending.owner_id, generation))});
    return callbackRedirect('connected');
  }
  async function apply(c, operation, payload = {}) {
    const result = await store.apply(c, operation, payload);
    if (result?.applied !== true) throw new D.BackupError('backup-stale', 409);
    return result;
  }
  async function run(owner = null) {
    requireConfigured();
    const deadline = now() + 45000, claims = await store.claim(owner, 1);
    if (!Array.isArray(claims)) throw new D.BackupError('service-unavailable');
    let processed = 0;
    for (const {connection: c} of claims) {
      if (!c || (owner && c.owner_id !== owner)) continue;
      try {
        await approved(c.auth_user_id, c.owner_id); await apply(c, 'guard');
        const snapshot = await store.snapshot(c), backup = buildBackup(snapshot, c.owner_id, now());
        const provider = providerFactory(deadline);
        const previous = D.unseal(c.token_cipher, config.key, D.tokenContext(c.owner_id, c.generation));
        const tokens = await provider.refresh(previous);
        if (tokens.refreshToken && tokens.refreshToken !== previous.refreshToken) await apply(c, 'token', {token_cipher: D.seal({refreshToken: tokens.refreshToken, scope: tokens.scope || previous.scope}, config.key, D.tokenContext(c.owner_id, c.generation))});
        if (!c.folder_id || !c.file_id) {
          const ids = await provider.allocateIds(tokens.accessToken, 2);
          if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => !/^[A-Za-z0-9_-]+$/.test(id)) || ids[0] === ids[1]) throw new D.BackupError('remote-response-invalid');
          const folderId = c.folder_id || ids[0], fileId = c.file_id || ids[1];
          await apply(c, 'ids', {folder_id: folderId, file_id: fileId}); c.folder_id = folderId; c.file_id = fileId;
        }
        await provider.writeBackup({accessToken: tokens.accessToken, folderId: c.folder_id, fileId: c.file_id,
          folderCreated: !!c.folder_created, fileCreated: !!c.file_created,
          marker: D.marker(c.owner_id, c.account_id, config.key), content: backup.content,
          beforeWrite: async () => { await approved(c.auth_user_id, c.owner_id); await apply(c, 'guard'); },
          onCreated: flags => apply(c, 'created', {folder_created: !!flags.folderCreated, file_created: !!flags.fileCreated})});
        await apply(c, 'success', {revision: backup.revision, hash: backup.hash, counts: backup.counts}); processed++;
      } catch (error) {
        try { await apply(c, 'failure', {error_code: safeError(error), retry_after: Math.min(3600, Math.max(60, Number(error.retryAfter) || 300)), disable: error.code === 'reconnect-required'}); } catch (_) { /* stale/revoked lease cannot update another connection */ }
      } finally { try { await store.apply(c, 'release'); } catch (_) { /* lease expires automatically */ } }
    }
    return {processed};
  }
  async function mutate(profile, action, body) {
    if (action === 'mail-configure') {
      if (typeof body.enabled !== 'boolean' || Object.keys(body).some(key => key !== 'enabled')) throw new D.BackupError('invalid-request', 400);
      if (body.enabled) await ensureGoogleAccount(profile, 'mail');
      return MailService.safeStatus(await mailStore.configure(profile.id, profile.auth_user_id, 'settings', {enabled:body.enabled}));
    }
    if (action === 'configure') {
      if (typeof body.enabled !== 'boolean') throw new D.BackupError('invalid-request', 400);
      if (body.enabled) await ensureGoogleAccount(profile);
      await store.configure(profile.id, profile.auth_user_id, 'settings', {enabled: body.enabled});
    } else if (action === 'disconnect') await store.configure(profile.id, profile.auth_user_id, 'disconnect');
    else if (action === 'sync') {
      await ensureGoogleAccount(profile);
      await store.configure(profile.id, profile.auth_user_id, 'sync');
      await run(profile.id);
    } else throw new D.BackupError('invalid-request', 400);
    return status(profile);
  }
  return {config, store, authenticate, approved, status, googleStatus, connect, callback, callbackRedirect, mutate, ensureGoogleAccount, run};
}

function createHandler(options = {}) {
  const service = options.service || createService(options);
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url || '/', service.config.origin);
      const action = url.searchParams.get('action') || (req.method === 'GET' && url.searchParams.has('state') ? 'callback' : 'status');
      if (req.method === 'GET' && action === 'config') return send(200, {configured: !!service.config.configured});
      if (!service.config.configured) throw new D.BackupError('not-configured', 503);
      if (req.method === 'GET' && action === 'callback') {
        res.setHeader('Set-Cookie', COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        let target;
        try { target = await service.callback(url.searchParams, req.headers.cookie); } catch (_) { target = service.callbackRedirect('error'); }
        res.statusCode = 303; res.setHeader('Location', target); return res.end();
      }
      if (req.method === 'GET' && action === 'worker') {
        if (!service.config.cronSecret || !D.equal(req.headers.authorization || '', 'Bearer ' + service.config.cronSecret)) throw new D.BackupError('authentication-required', 401);
        return send(200, await service.run());
      }
      if (req.method !== 'POST' && !(req.method === 'GET' && ['status', 'google-status'].includes(action))) return send(405, {error: 'method-not-allowed'});
      if (req.method === 'POST' && (req.headers.origin !== service.config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) return send(403, {error: 'same-origin-required'});
      const profile = await service.authenticate(req);
      if (action === 'status' && req.method === 'GET') return send(200, await service.status(profile));
      if (action === 'google-status' && req.method === 'GET') return send(200, await service.googleStatus(profile));
      let body = req.body;
      if (typeof body === 'string') { if (body.length > 2048) return send(413, {error: 'request-too-large'}); try { body = JSON.parse(body); } catch (_) { return send(400, {error: 'invalid-json'}); } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 2048) return send(400, {error: 'invalid-json'});
      // Never accept user-supplied snapshots, owner IDs, file IDs or tokens.
      if (Object.keys(body).some(key => action === 'connect' ? key !== 'service' : !['configure','mail-configure'].includes(action) || key !== 'enabled')) return send(400, {error: 'invalid-request'});
      if (action === 'connect') { if (Object.hasOwn(body,'service') && !['drive','calendar','mail'].includes(body.service)) return send(400, {error:'invalid-request'}); const result = await service.connect(profile, true, body.service); res.setHeader('Set-Cookie', result.cookie); return send(200, {url: result.url}); }
      return send(200, await service.mutate(profile, action, body));
    } catch (error) { return send(error instanceof D.BackupError ? error.status : 503, {error: safeError(error)}); }
  };
}

module.exports = {COOKIE, TABLES, MAX_BYTES, createTransport, createStore, safeConnection, buildBackup, safeError, createService, createHandler};
