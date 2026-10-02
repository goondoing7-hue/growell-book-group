'use strict';

const crypto = require('node:crypto');
const D = require('./habitSyncDomain.cjs');
const habitsDomain = require('../habitDomain.js');
const COOKIE = '__Host-growell-habit-sync';
const TOKEN_URL = D.LOGIN_ORIGIN + '/common/oauth2/v2.0/token';

function createTransport(fetchImpl = fetch) {
  return async function request(url, options = {}, kind = 'service') {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, {...options, redirect: 'error', signal: controller.signal});
      if (!response.ok) {
        const status = response.status;
        let code = kind === 'graph' ? 'remote-unavailable' : 'service-unavailable';
        if (kind === 'database') {
          try {
            const raw = await response.text();
            const databaseCode = raw.length <= 16000 ? JSON.parse(raw).code : '';
            if (databaseCode === '40001') code = 'sync-busy';
            if (databaseCode === '42501') code = 'membership-required';
            if (databaseCode === '55000') code = 'connection-required';
            if (databaseCode === '22023') code = 'invalid-request';
          } catch (_) { /* provider text is never returned to a browser */ }
        }
        if (kind === 'graph' && status === 401) code = 'reconnect-required';
        if (kind === 'auth' && [401, 403].includes(status)) code = 'authentication-required';
        if (kind === 'graph' && status === 404) code = 'remote-missing';
        if (status === 429) code = 'rate-limited';
        if (kind === 'token' && [400, 401].includes(status)) code = 'reconnect-required';
        if (kind === 'database' && status === 409) code = 'sync-busy';
        const failure = new D.SyncError(code, code === 'authentication-required' ? 401 : code === 'membership-required' ? 403 : code === 'invalid-request' ? 400 : status === 404 ? 404 : status === 429 ? 429 : ['sync-busy', 'connection-required'].includes(code) ? 409 : 503,
          D.retryDelay(response.headers.get('retry-after')), (options.method === 'POST' && kind === 'graph' && status >= 500));
        failure.definiteRejection = kind === 'graph' && status >= 400 && status < 500;
        throw failure;
      }
      if (response.status === 204) return null;
      const text = await response.text();
      if (text.length > 1500000) throw new D.SyncError('response-too-large');
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof D.SyncError) throw error;
      throw new D.SyncError('service-unavailable', 503, 30, options.method === 'POST' && kind === 'graph');
    } finally { clearTimeout(timeout); }
  };
}

function createStore(config, request) {
  const headers = {apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, 'Content-Type': 'application/json'};
  const db = (path, method = 'GET', body) => request(config.database + '/rest/v1/' + path, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})}, 'database');
  const rpc = (name, body) => db('rpc/growell_habit_sync_' + name, 'POST', body);
  async function rows(path) {
    const result = [];
    for (let offset = 0; offset <= 10000; offset += 1000) {
      const page = await db(path + '&limit=1000&offset=' + offset);
      if (!Array.isArray(page)) throw new D.SyncError('service-unavailable');
      result.push(...page);
      if (result.length > 10000) throw new D.SyncError('response-too-large');
      if (page.length < 1000) return result;
    }
    throw new D.SyncError('response-too-large');
  }
  return {
    async profile(authId) {
      const rows = await db('profiles?select=id,auth_user_id,is_deleted,approval_status&auth_user_id=eq.' + encodeURIComponent(authId) + '&limit=2');
      return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    },
    async connection(owner) {
      const rows = await db('growell_habit_sync_connections?select=*&owner_id=eq.' + encodeURIComponent(owner) + '&limit=1');
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async pending(owner) {
      const rows = await db('growell_habit_sync_queue?select=habit_id&owner_id=eq.' + encodeURIComponent(owner) + '&pending=eq.true&limit=10001');
      return Array.isArray(rows) ? Math.min(rows.length, 10000) : 0;
    },
    habits: owner => rows('habits?select=id,user_id,name,time,start_date,end_date,weekdays&user_id=eq.' + encodeURIComponent(owner) + '&order=id.asc'),
    tracked: (owner, generation) => rows('growell_habit_sync_queue?select=owner_id,habit_id,generation,task_id,pending,last_error&owner_id=eq.' + encodeURIComponent(owner) + '&generation=eq.' + encodeURIComponent(generation) + '&order=habit_id.asc'),
    oauth: (operation, payload) => rpc('oauth', {p_operation: operation, p_payload: payload}),
    configure: (owner, authId, operation, payload = {}) => rpc('configure', {p_owner: owner, p_auth: authId, p_operation: operation, p_payload: payload}),
    claim: (owner = null, limit = 1) => rpc('claim', {p_owner: owner, p_limit: limit}),
    apply: (connection, operation, payload = {}) => rpc('apply', {p_owner: connection.owner_id, p_generation: connection.generation, p_lease: connection.lease_token, p_operation: operation, p_payload: payload})
  };
}

function createGraph(request, accessToken, budget = {}) {
  const headers = {Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json'};
  function urlFor(path) {
    const url = new URL(path, D.GRAPH_ORIGIN + '/v1.0/');
    if (url.origin !== D.GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/me/todo/') || url.username || url.password || url.hash) throw new D.SyncError('unsafe-remote-url');
    return url.href;
  }
  const call = (path, method = 'GET', body, extraHeaders = {}) => {
    if (budget.deadline && (budget.now || Date.now)() + 8500 > budget.deadline) throw new D.SyncError('sync-deferred', 409);
    return request(urlFor(path), {method, headers: {...headers, ...extraHeaders}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}, 'graph');
  };
  async function all(path) {
    const results = [], seen = new Set(); let next = path;
    for (let page = 0; next && page < 20; page++) {
      const url = urlFor(next);
      if (seen.has(url)) throw new D.SyncError('remote-pagination-invalid');
      seen.add(url);
      const data = await call(url);
      if (!data || !Array.isArray(data.value)) throw new D.SyncError('remote-response-invalid');
      results.push(...data.value);
      if (results.length > 2000) throw new D.SyncError('remote-list-too-large');
      next = data['@odata.nextLink'];
      if (next && typeof next !== 'string') throw new D.SyncError('remote-pagination-invalid');
    }
    if (next) throw new D.SyncError('remote-list-too-large');
    return results;
  }
  return {call, all};
}

function safeConnection(connection, pendingCount) {
  return {
    configured: true, connected: !!(connection && connection.token_cipher), enabled: !!(connection && connection.enabled && connection.token_cipher),
    timeZone: 'Asia/Seoul', listName: 'GROWELL', pendingCount: pendingCount || 0,
    lastSyncedAt: connection?.last_synced_at || null,
    errorCode: connection?.error_code || null
  };
}

function createService(options = {}) {
  const config = options.config || D.getConfig(), now = options.now || Date.now;
  const request = options.request || createTransport(options.fetch || globalThis.fetch);
  const store = options.store || createStore(config, request);
  const tokenContext = (owner, generation) => 'habit-sync-token:' + owner + ':' + generation;
  const callbackRedirect = state => config.origin + '/?habit-sync=' + state + '#/book/emotion/habit';
  function requireConfigured() { if (!config.configured) throw new D.SyncError('not-configured', 503); }
  async function approved(authId, owner) {
    const profile = await store.profile(authId);
    if (!profile || profile.auth_user_id !== authId || profile.is_deleted !== false || profile.approval_status !== 'approved' || (owner && owner !== profile.id)) throw new D.SyncError('membership-required', 403);
    return profile;
  }
  async function authenticate(req) {
    requireConfigured();
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization || '');
    if (!match || match[1].length > 16000) throw new D.SyncError('authentication-required', 401);
    let user;
    try { user = await request(config.database + '/auth/v1/user', {headers: {apikey: config.serviceKey, Authorization: 'Bearer ' + match[1]}}, 'auth'); }
    catch (error) { if (error.code === 'authentication-required') throw error; throw new D.SyncError('service-unavailable', 503); }
    if (!user || !D.UUID.test(user.id || '')) throw new D.SyncError('authentication-required', 401);
    return approved(user.id);
  }
  async function status(profile) {
    const connection = await store.connection(profile.id);
    const [habits, tracked] = await Promise.all([store.habits(profile.id), connection?.token_cipher ? store.tracked(profile.id, connection.generation) : []]);
    if (!Array.isArray(habits) || !Array.isArray(tracked)) throw new D.SyncError('service-unavailable');
    const currentRows = tracked.filter(row => row.owner_id === profile.id && row.generation === connection?.generation), queue = new Map(currentRows.map(row => [row.habit_id, row]));
    return {...safeConnection(connection, currentRows.filter(row => row.pending).length), habits: habits.filter(habit => habit.user_id === profile.id).map(habit => {
      const item = queue.get(habit.id), errorCode = item?.last_error ? safeError({code: item.last_error}) : null;
      let validPeriod = false;
      try { validPeriod = !!D.reminderSchedule(habit, now()); } catch (_) { /* invalid stored schedules cannot be connected */ }
      return {habitId: habit.id, name: D.clean(habit.name, 200), time: D.parseTime(habit.time) || '', weekdays: habitsDomain.weekdays(habit), scheduleLabel: habitsDomain.scheduleLabel(habit), canConnect: validPeriod,
        state: !item ? 'unlinked' : errorCode ? 'attention' : item.pending || !item.task_id ? 'pending' : 'synced', ...(errorCode ? {errorCode} : {})};
    })};
  }
  async function connect(profile) {
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url'), nonce = crypto.randomBytes(32).toString('base64url');
    const stateHash = D.hash(state);
    await store.oauth('put', {
      state_hash: stateHash, owner_id: profile.id, auth_user_id: profile.auth_user_id,
      verifier_cipher: D.seal({verifier, nonce}, config.key, 'habit-sync-oauth:' + profile.id + ':' + stateHash),
      expires_at: new Date(now() + 10 * 60000).toISOString()
    });
    const url = new URL(D.LOGIN_ORIGIN + '/common/oauth2/v2.0/authorize');
    url.search = new URLSearchParams({client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, response_mode: 'query', scope: config.scopes, state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account'}).toString();
    return {url: url.href, cookie: COOKIE + '=' + state + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'};
  }
  async function token(fields) {
    const data = await request(TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: config.clientId, client_secret: config.clientSecret, scope: config.scopes, ...fields}).toString()}, 'token');
    if (!data || typeof data.access_token !== 'string' || data.access_token.length < 20 || !String(data.scope || '').toLowerCase().split(/\s+/).some(scope => scope === 'tasks.readwrite' || scope.endsWith('/tasks.readwrite'))) throw new D.SyncError('consent-required', 403);
    return data;
  }
  async function verifyIdentity(raw, nonce) {
    // ID token comes only from the fixed TLS token endpoint, and is still fully
    // signature/issuer/audience/nonce validated before retaining its subject.
    try {
      const [headerPart, bodyPart, signaturePart, extra] = String(raw).split('.');
      if (extra || !signaturePart) throw new Error();
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()), claims = JSON.parse(Buffer.from(bodyPart, 'base64url').toString());
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !D.UUID.test(claims.tid || '') || claims.aud !== config.clientId || !D.equal(claims.nonce, nonce) || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || !Number.isFinite(claims.nbf) || claims.exp * 1000 <= now() || claims.nbf * 1000 > now() + 60000 || claims.iss !== D.LOGIN_ORIGIN + '/' + claims.tid + '/v2.0') throw new Error();
      const keys = await request(D.LOGIN_ORIGIN + '/common/discovery/v2.0/keys');
      const key = keys?.keys?.find(item => item.kid === header.kid && item.kty === 'RSA' && item.use === 'sig');
      if (!key || !crypto.verify('RSA-SHA256', Buffer.from(headerPart + '.' + bodyPart), crypto.createPublicKey({key, format: 'jwk'}), Buffer.from(signaturePart, 'base64url'))) throw new Error();
      return D.hash(claims.iss + ':' + claims.sub);
    } catch (_) { throw new D.SyncError('identity-invalid', 403); }
  }
  async function callback(query, cookies) {
    requireConfigured();
    const state = query.get('state') || '', cookie = String(cookies || '').split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !D.equal(cookie, state)) throw new D.SyncError('oauth-state-invalid', 400);
    const pending = await store.oauth('consume', {state_hash: D.hash(state)});
    if (!pending || new Date(pending.expires_at).getTime() <= now()) throw new D.SyncError('oauth-state-invalid', 400);
    await approved(pending.auth_user_id, pending.owner_id);
    if (query.get('error') || !query.get('code') || query.get('code').length > 16000) throw new D.SyncError('oauth-cancelled', 400);
    const payload = D.unseal(pending.verifier_cipher, config.key, 'habit-sync-oauth:' + pending.owner_id + ':' + D.hash(state));
    const tokens = await token({grant_type: 'authorization_code', code: query.get('code'), redirect_uri: config.redirectUri, code_verifier: payload.verifier});
    if (!tokens.refresh_token) throw new D.SyncError('consent-required', 403);
    const accountId = await verifyIdentity(tokens.id_token, payload.nonce), generation = crypto.randomUUID();
    await approved(pending.auth_user_id, pending.owner_id);
    await store.configure(pending.owner_id, pending.auth_user_id, 'connect', {
      generation, account_id: accountId,
      token_cipher: D.seal({refreshToken: tokens.refresh_token}, config.key, tokenContext(pending.owner_id, generation))
    });
    return callbackRedirect('connected');
  }
  async function apply(connection, operation, payload = {}) {
    const result = await store.apply(connection, operation, payload);
    if (!result || result.applied !== true) throw new D.SyncError('sync-stale', 409);
    return result;
  }
  async function refreshToken(connection) {
    await apply(connection, 'guard');
    const saved = D.unseal(connection.token_cipher, config.key, tokenContext(connection.owner_id, connection.generation));
    const tokens = await token({grant_type: 'refresh_token', refresh_token: saved.refreshToken});
    if (tokens.refresh_token) {
      await apply(connection, 'token', {token_cipher: D.seal({refreshToken: tokens.refresh_token}, config.key, tokenContext(connection.owner_id, connection.generation))});
    }
    return tokens.access_token;
  }
  async function requirePrivateList(graph, listId) {
    const list = await graph.call('/v1.0/me/todo/lists/' + encodeURIComponent(listId));
    if (!list || list.id !== listId || list.isOwner !== true || list.isShared !== false) throw new D.SyncError('list-not-private', 409);
    return listId;
  }
  async function ensureList(connection, graph, deadline) {
    // A previously private list can later be shared. Check the current Graph
    // permissions on every run, including an already stored list ID.
    if (connection.list_id) return requirePrivateList(graph, connection.list_id);
    const matches = (await graph.all('/v1.0/me/todo/lists?$top=100')).filter(list => list.displayName === 'GROWELL' && typeof list.id === 'string');
    if (matches.length > 1) throw new D.SyncError('list-ambiguous', 409);
    if (matches.length === 1) {
      if (matches[0].isOwner !== true || matches[0].isShared !== false) throw new D.SyncError('list-not-private', 409);
      await requirePrivateList(graph, matches[0].id);
      await apply(connection, 'list', {list_id: matches[0].id}); return matches[0].id;
    }
    // The first POST may have succeeded even if its response was lost. Never
    // create another list blindly after that uncertainty.
    if (connection.list_uncertain) throw new D.SyncError('list-create-uncertain', 409);
    if (now() + 12000 > deadline) throw new D.SyncError('sync-deferred', 409);
    await apply(connection, 'list_sending');
    let list;
    try { list = await graph.call('/v1.0/me/todo/lists', 'POST', {displayName: 'GROWELL'}); }
    catch (error) {
      if (error.definiteRejection || error.code === 'sync-deferred' || (!error.uncertain && ['rate-limited', 'reconnect-required'].includes(error.code))) await apply(connection, 'list_rejected');
      throw error;
    }
    if (!list || typeof list.id !== 'string') throw new D.SyncError('list-create-uncertain', 409);
    await apply(connection, 'list', {list_id: list.id});
    return requirePrivateList(graph, list.id);
  }
  const taskExpand = '$expand=linkedResources,extensions($filter=id eq \'' + D.MARKER_EXTENSION + '\')';
  async function recoverTask(graph, base, marker) {
    const tasks = await graph.all(base + '?$top=100&' + taskExpand);
    const matches = tasks.filter(task => typeof task.id === 'string' && D.hasMarker(task, marker));
    const active = matches.filter(task => task.status !== 'completed');
    if (active.length > 1) throw new D.SyncError('task-ambiguous', 409);
    if (active.length === 1) return active[0];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new D.SyncError('task-ambiguous', 409);
    return null;
  }
  async function prepareTaskMetadata(connection, item, graph, listId, base, task, deadline) {
    const path = base + '/' + encodeURIComponent(task.id);
    const guard = async () => {
      await apply(connection, 'guard', {habit_id: item.habit_id, revision: item.revision});
      await requirePrivateList(graph, listId);
      if (now() + 12000 > deadline) throw new D.SyncError('sync-deferred', 409);
    };
    if (!D.hasHiddenMarker(task, item.marker)) {
      if (!D.hasMarker(task, item.marker)) throw new D.SyncError('remote-task-changed', 409);
      // Keep the legacy marker until the replacement is confirmed by a read.
      // A lost POST response is retried by reading this fixed-name extension.
      await guard();
      await graph.call(path + '/extensions', 'POST', D.markerExtensionPayload(item.marker));
      task = await graph.call(path + '?' + taskExpand);
      if (!D.hasHiddenMarker(task, item.marker)) throw new D.SyncError('remote-task-changed', 409);
    }
    const ownedLinks = (task.linkedResources || []).filter(link => link && link.applicationName === 'GROWELL' && link.externalId === item.marker && typeof link.id === 'string' && link.id.length > 0 && link.id.length <= 2048);
    for (const link of ownedLinks) {
      await guard();
      try { await graph.call(path + '/linkedResources/' + encodeURIComponent(link.id), 'DELETE'); }
      catch (error) { if (error.code !== 'remote-missing') throw error; }
    }
    if (ownedLinks.length) {
      task = await graph.call(path + '?' + taskExpand);
      if (!D.hasHiddenMarker(task, item.marker)) throw new D.SyncError('remote-task-changed', 409);
    }
    return task;
  }
  async function processItem(connection, item, graph, listId, deadline) {
    const base = '/v1.0/me/todo/lists/' + encodeURIComponent(listId) + '/tasks';
    await apply(connection, 'guard', {habit_id: item.habit_id, revision: item.revision});
    let task = null;
    if (item.task_id) {
      try { task = await graph.call(base + '/' + encodeURIComponent(item.task_id) + '?' + taskExpand); }
      catch (error) { if (error.code !== 'remote-missing') throw error; }
      if (task && !D.hasMarker(task, item.marker)) throw new D.SyncError('remote-task-changed', 409);
      if (!task || task.status === 'completed') task = await recoverTask(graph, base, item.marker) || task;
    } else if (item.uncertain) task = await recoverTask(graph, base, item.marker);
    const payload = item.desired ? D.taskPayload(item.desired, item.marker, config.origin, now()) : null;
    // Recheck immediately before a task mutation as well; no habit text may be
    // sent to an existing shared list even when it was private earlier today.
    await requirePrivateList(graph, listId);
    if (now() + 12000 > deadline) throw new D.SyncError('sync-deferred', 409);
    if (!payload) {
      if (task) {
        await apply(connection, 'guard', {habit_id: item.habit_id, revision: item.revision});
        const etag = task['@odata.etag'];
        await graph.call(base + '/' + encodeURIComponent(task.id), 'DELETE', undefined, etag ? {'If-Match': etag} : {});
      } else if (item.uncertain) throw new D.SyncError('task-create-uncertain', 409);
      await apply(connection, 'success', {habit_id: item.habit_id, revision: item.revision, task_id: null});
      return;
    }
    if (task) {
      task = await prepareTaskMetadata(connection, item, graph, listId, base, task, deadline);
      await apply(connection, 'guard', {habit_id: item.habit_id, revision: item.revision});
      await requirePrivateList(graph, listId);
      // Never reset completion selected in the reminder app. No check dates or
      // completion status are sent from GROWELL in either direction.
      const {extensions, ...update} = payload;
      await graph.call(base + '/' + encodeURIComponent(task.id), 'PATCH', update, task['@odata.etag'] ? {'If-Match': task['@odata.etag']} : {});
      await apply(connection, 'success', {habit_id: item.habit_id, revision: item.revision, task_id: task.id});
      return;
    }
    // Missing known tasks are not silently recreated after a user removed or
    // moved them in To Do. A lost create response only triggers marker lookup.
    if (item.uncertain || item.task_id) throw new D.SyncError(item.uncertain ? 'task-create-uncertain' : 'remote-missing', 409);
    await apply(connection, 'sending', {habit_id: item.habit_id, revision: item.revision});
    let created;
    try { created = await graph.call(base, 'POST', payload); }
    catch (error) {
      // A clear 4xx rejection is safe to retry. Transport/5xx/malformed success
      // remain uncertain and can only recover through the opaque marker.
      if (error.definiteRejection || error.code === 'sync-deferred' || (!error.uncertain && ['rate-limited', 'reconnect-required'].includes(error.code))) error.safeCreateRetry = true;
      throw error;
    }
    if (!created || typeof created.id !== 'string') throw new D.SyncError('task-create-uncertain', 409);
    await apply(connection, 'success', {habit_id: item.habit_id, revision: item.revision, task_id: created.id});
  }
  async function run(owner = null) {
    requireConfigured();
    const deadline = now() + 45000;
    const claims = await store.claim(owner, 1);
    let processed = 0;
    for (const claim of Array.isArray(claims) ? claims : []) {
      const connection = claim.connection;
      if (!connection || (owner && connection.owner_id !== owner)) continue;
      try {
        await approved(connection.auth_user_id, connection.owner_id);
        const graph = createGraph(request, await refreshToken(connection), {deadline, now});
        const listId = await ensureList(connection, graph, deadline);
        for (const item of (claim.queue || []).slice(0, 3)) {
          if (now() + 16000 > deadline) break;
          try { await processItem(connection, item, graph, listId, deadline); processed++; }
          catch (error) {
            if (error.code === 'sync-stale') continue;
            const delay = error.retryAfter || D.retryDelay(null, item.attempts, now());
            await apply(connection, 'failure', {habit_id: item.habit_id, revision: item.revision, error_code: safeError(error), next_attempt_at: new Date(now() + delay * 1000).toISOString(), ...(error.safeCreateRetry ? {uncertain: false} : {})});
            if (error.code === 'reconnect-required') throw error;
          }
        }
      } catch (error) {
        try { await apply(connection, 'connection_error', {error_code: safeError(error), disable: error.code === 'reconnect-required', next_attempt_at: new Date(now() + (error.retryAfter || 300) * 1000).toISOString()}); } catch (_) { /* superseded or disconnected */ }
      } finally {
        try { await store.apply(connection, 'release', {}); } catch (_) { /* lease expires; never bypass owner/generation */ }
      }
    }
    return {processed};
  }
  async function mutate(profile, action, body) {
    if (action === 'settings') {
      if (typeof body.enabled !== 'boolean') throw new D.SyncError('invalid-settings', 400);
      // The legacy DB column remains for compatibility, never for scheduling.
      await store.configure(profile.id, profile.auth_user_id, 'settings', {enabled: body.enabled});
      return status(profile);
    }
    if (action === 'disconnect') { await store.configure(profile.id, profile.auth_user_id, 'disconnect'); return status(profile); }
    if (action === 'import') {
      if (body.habitId !== undefined && (typeof body.habitId !== 'string' || !/^[A-Za-z0-9_-]{1,384}$/.test(body.habitId))) throw new D.SyncError('invalid-habit', 400);
      return store.configure(profile.id, profile.auth_user_id, 'import', body.habitId ? {habit_id: body.habitId} : {});
    }
    if (action === 'run') return run(profile.id);
    throw new D.SyncError('unknown-action', 404);
  }
  return {config, authenticate, approved, status, connect, callback, callbackRedirect, mutate, run, store, verifyIdentity};
}

const CODES = new Set(['not-configured', 'authentication-required', 'membership-required', 'invalid-request', 'connection-required', 'invalid-time', 'invalid-settings', 'invalid-habit', 'unknown-action', 'oauth-state-invalid', 'oauth-cancelled', 'consent-required', 'identity-invalid', 'connection-key-invalid', 'reconnect-required', 'remote-unavailable', 'remote-missing', 'rate-limited', 'sync-busy', 'service-unavailable', 'response-too-large', 'unsafe-remote-url', 'remote-pagination-invalid', 'remote-response-invalid', 'remote-list-too-large', 'sync-stale', 'list-ambiguous', 'list-not-private', 'list-create-uncertain', 'sync-deferred', 'task-ambiguous', 'remote-task-changed', 'task-create-uncertain']);
function safeError(error) { return error && CODES.has(error.code) ? error.code : 'service-unavailable'; }

function createHandler(options = {}) {
  const service = options.service || createService(options);
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
    const url = new URL(req.url || '/', service.config.origin);
    // Personal Microsoft accounts require a registered redirect URI without
    // query parameters. OAuth identifies this bare endpoint by its state.
    const action = url.searchParams.get('action') || (req.method === 'GET' && url.searchParams.has('state') ? 'callback' : 'status');
    try {
      if (req.method === 'GET' && action === 'config') return send(200, {configured: service.config.configured});
      if (!service.config.configured) throw new D.SyncError('not-configured', 503);
      if (req.method === 'GET' && action === 'callback') {
        res.setHeader('Set-Cookie', COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        let destination;
        try { destination = await service.callback(url.searchParams, req.headers.cookie); }
        catch (_) { destination = service.callbackRedirect('failed'); }
        res.statusCode = 303; res.setHeader('Location', destination); return res.end();
      }
      if (req.method === 'GET' && action === 'worker') {
        if (!D.equal(req.headers.authorization || '', 'Bearer ' + service.config.cronSecret)) throw new D.SyncError('authentication-required', 401);
        return send(200, await service.run());
      }
      if (req.method !== 'POST' && !(req.method === 'GET' && action === 'status')) return send(405, {error: 'method-not-allowed'});
      if (req.method === 'POST' && (req.headers.origin !== service.config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) return send(403, {error: 'same-origin-required'});
      const profile = await service.authenticate(req);
      if (action === 'status' && req.method === 'GET') return send(200, await service.status(profile));
      let body = req.body;
      if (typeof body === 'string') { if (body.length > 8192) return send(413, {error: 'request-too-large'}); try { body = JSON.parse(body); } catch (_) { return send(400, {error: 'invalid-json'}); } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 8192) return send(400, {error: 'invalid-json'});
      if (action === 'connect') {
        const connection = await service.connect(profile, body); res.setHeader('Set-Cookie', connection.cookie);
        return send(200, {url: connection.url});
      }
      return send(200, await service.mutate(profile, action, body));
    } catch (error) { return send(error instanceof D.SyncError ? error.status : 503, {error: safeError(error)}); }
  };
}
module.exports = {COOKIE, createTransport, createStore, createGraph, safeConnection, safeError, createService, createHandler};
