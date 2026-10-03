'use strict';

const D = require('./driveBackupDomain.cjs');
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,trashed,shared,ownedByMe,owners(permissionId,me),driveId,appProperties,capabilities(canEdit,canAddChildren),size';

// All endpoints are fixed here; tokens and provider error bodies never enter public errors.
function createProvider(config, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch, now = options.now || Date.now;
  async function request(url, init = {}, kind = 'drive') {
    if (options.deadline && now() + 8500 > options.deadline) throw new D.BackupError('backup-deferred', 409);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, {...init, redirect: 'error', signal: controller.signal});
      if (!response.ok) {
        const status = response.status;
        let reason = '';
        if (kind === 'drive' && status === 403) {
          try { const raw = await response.text(); if (raw.length < 16000) reason = JSON.parse(raw)?.error?.errors?.[0]?.reason || ''; } catch (_) { /* Never expose provider text. */ }
        }
        const rateLimited = status === 429 || (status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason));
        const code = rateLimited ? 'rate-limited' : status === 404 ? 'backup-remote-missing' : status === 409 ? 'backup-remote-conflict'
          : status === 403 && reason === 'storageQuotaExceeded' ? 'backup-storage-full'
          : status === 401 || (kind === 'token' && status === 400) ? 'reconnect-required' : status === 403 ? 'backup-permission-denied' : 'backup-unavailable';
        throw new D.BackupError(code, status === 404 ? 404 : status === 409 ? 409 : rateLimited ? 429 : 503,
          D.retryDelay(response.headers.get('retry-after'), now()), init.method && init.method !== 'GET' && status >= 500);
      }
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new D.BackupError('backup-response-invalid');
      return {body: text ? JSON.parse(text) : null, headers: response.headers};
    } catch (error) {
      if (error instanceof D.BackupError) throw error;
      throw new D.BackupError('backup-unavailable', 503, 30, !!init.method && init.method !== 'GET');
    } finally { clearTimeout(timer); }
  }
  function token(raw, previous) {
    const scope = typeof raw?.scope === 'string' ? raw.scope : previous?.scope;
    const scopes = new Set((scope || '').split(/\s+/));
    if (!scopes.has(D.DRIVE_SCOPE) || !scopes.has('openid') || !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email'))) throw new D.BackupError('backup-permission-denied');
    const refreshToken = raw.refresh_token || previous?.refreshToken;
    if (typeof raw.access_token !== 'string' || !raw.access_token || raw.access_token.length > 16384 || typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 16384
      || String(raw.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(+raw.expires_in) || +raw.expires_in <= 0 || +raw.expires_in > 86400) throw new D.BackupError('reconnect-required');
    return {accessToken: raw.access_token, refreshToken, expiresAt: now() + Number(raw.expires_in) * 1000, scope};
  }
  async function tokenRequest(body, previous) {
    const response = await request(D.TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: config.clientId, client_secret: config.clientSecret, ...body}).toString()}, 'token');
    return token(response.body, previous);
  }
  function headers(accessToken, extra = {}) {
    if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) throw new D.BackupError('reconnect-required');
    return {Authorization: 'Bearer ' + accessToken, ...extra};
  }
  const path = id => {
    if (typeof id !== 'string' || !D.FILE_ID.test(id) || id === 'root') throw new D.BackupError('invalid-request', 400);
    return D.DRIVE_ORIGIN + '/drive/v3/files/' + encodeURIComponent(id);
  };
  async function metadata(accessToken, id) {
    try { return (await request(path(id) + '?fields=' + encodeURIComponent(FILE_FIELDS), {headers: headers(accessToken)})).body; }
    catch (error) { if (error.code === 'backup-remote-missing') return null; throw error; }
  }
  function validate(meta, {id, type, parent, permissionId, marker, role}) {
    if (!meta || meta.id !== id || meta.mimeType !== type || meta.trashed !== false || meta.shared !== false || meta.ownedByMe !== true || meta.driveId
      || !Array.isArray(meta.owners) || meta.owners.length !== 1 || meta.owners[0]?.permissionId !== permissionId || meta.owners[0]?.me !== true
      || !Array.isArray(meta.parents) || meta.parents.length !== 1 || typeof meta.parents[0] !== 'string' || !D.FILE_ID.test(meta.parents[0])
      || (parent !== 'root' && meta.parents[0] !== parent)
      || meta.appProperties?.growellBackup !== 'v1' || meta.appProperties?.owner !== marker || meta.appProperties?.role !== role
      || meta.capabilities?.canEdit !== true || (role === 'folder' && meta.capabilities?.canAddChildren !== true)) throw new D.BackupError(role === 'folder' ? 'backup-folder-unsafe' : 'backup-file-unsafe', 409);
    return meta;
  }
  async function verifiedRootParent(accessToken, expected) {
    // drive.file cannot necessarily read the user's pre-existing root folder.
    // Search only this member's app-created backup folders beneath the root alias.
    const query = "'root' in parents and 'me' in owners and trashed = false and mimeType = '" + FOLDER_TYPE
      + "' and appProperties has { key='growellBackup' and value='v1' }"
      + " and appProperties has { key='owner' and value='" + expected.marker + "' }"
      + " and appProperties has { key='role' and value='folder' }";
    const seen = new Set(); let pageToken = '', parent = null;
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({q: query, spaces: 'drive', corpora: 'user', pageSize: '100', fields: 'nextPageToken,incompleteSearch,files(id,parents)'});
      if (pageToken) params.set('pageToken', pageToken);
      const result = (await request(D.DRIVE_ORIGIN + '/drive/v3/files?' + params, {headers: headers(accessToken)})).body;
      if (!result || !Array.isArray(result.files) || result.files.length > 100 || (result.incompleteSearch !== undefined && result.incompleteSearch !== false)) throw new D.BackupError('backup-response-invalid');
      for (const item of result.files) {
        if (!item || typeof item.id !== 'string' || !D.FILE_ID.test(item.id) || !Array.isArray(item.parents) || item.parents.length !== 1
          || typeof item.parents[0] !== 'string' || !D.FILE_ID.test(item.parents[0])) throw new D.BackupError('backup-response-invalid');
        if (item.id === expected.id) {
          if (parent !== null) throw new D.BackupError('backup-response-invalid');
          parent = item.parents[0];
        }
      }
      if (result.nextPageToken === undefined || result.nextPageToken === null || result.nextPageToken === '') {
        if (!parent) throw new D.BackupError('backup-folder-unsafe', 409);
        return parent;
      }
      pageToken = result.nextPageToken;
      if (typeof pageToken !== 'string' || pageToken.length > 2048 || seen.has(pageToken)) throw new D.BackupError('backup-response-invalid');
      seen.add(pageToken);
    }
    throw new D.BackupError('backup-response-invalid');
  }
  async function ensure(accessToken, expected, created, name, beforeWrite) {
    let meta = await metadata(accessToken, expected.id);
    if (!meta && created) throw new D.BackupError('backup-remote-missing', 409);
    if (!meta) {
      try {
        await beforeWrite();
        await request(D.DRIVE_ORIGIN + '/drive/v3/files?fields=id', {method: 'POST', headers: headers(accessToken, {'Content-Type': 'application/json'}), body: JSON.stringify({
          id: expected.id, name, mimeType: expected.type, parents: [expected.parent],
          appProperties: {growellBackup: 'v1', owner: expected.marker, role: expected.role}
        })});
      } catch (error) { if (error.code !== 'backup-remote-conflict') throw error; }
      meta = await metadata(accessToken, expected.id);
    }
    return validate(meta, expected);
  }
  return {
    authorizationUrl: details => D.authorizationUrl(config, details),
    async exchange({code, verifier} = {}) {
      if (typeof code !== 'string' || !code || code.length > 4096 || /[\r\n]/.test(code) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new D.BackupError('invalid-request', 400);
      return tokenRequest({code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: config.redirectUri});
    },
    async refresh(previous) {
      if (typeof previous?.refreshToken !== 'string' || !previous.refreshToken) throw new D.BackupError('reconnect-required');
      return tokenRequest({refresh_token: previous.refreshToken, grant_type: 'refresh_token'}, previous);
    },
    async identity(accessToken) {
      const user = (await request(D.USERINFO_URL, {headers: headers(accessToken)}, 'identity')).body;
      if (!user || typeof user.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(user.sub)) throw new D.BackupError('backup-identity-invalid');
      return {subject: user.sub, email: user.email_verified === true && typeof user.email === 'string' ? D.clean(user.email, 254) : ''};
    },
    async allocateIds(accessToken, count = 2) {
      if (!Number.isInteger(count) || count < 1 || count > 2) throw new D.BackupError('invalid-request', 400);
      const result = (await request(D.DRIVE_ORIGIN + '/drive/v3/files/generateIds?' + new URLSearchParams({count: String(count), space: 'drive', type: 'files'}), {headers: headers(accessToken)})).body;
      if (!Array.isArray(result?.ids) || result.ids.length !== count || result.ids.some(id => typeof id !== 'string' || !D.FILE_ID.test(id)) || new Set(result.ids).size !== count) throw new D.BackupError('backup-response-invalid');
      return result.ids;
    },
    async writeBackup({accessToken, folderId, fileId, marker, content, folderCreated = false, fileCreated = false, onCreated = async () => {}, beforeWrite = async () => {}} = {}) {
      path(folderId); path(fileId);
      if (folderId === fileId || typeof marker !== 'string' || !/^[a-f0-9]{64}$/.test(marker) || typeof content !== 'string') throw new D.BackupError('invalid-request', 400);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > D.MAX_CONTENT_BYTES) throw new D.BackupError('backup-too-large', 413);
      try { const parsed = JSON.parse(content); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch (_) { throw new D.BackupError('invalid-request', 400); }
      const about = (await request(D.DRIVE_ORIGIN + '/drive/v3/about?fields=user(permissionId)', {headers: headers(accessToken)})).body;
      const permissionId = about?.user?.permissionId;
      if (typeof permissionId !== 'string' || !permissionId) throw new D.BackupError('backup-identity-invalid');
      const folder = {id: folderId, type: FOLDER_TYPE, parent: 'root', permissionId, marker, role: 'folder'};
      const file = {id: fileId, type: 'application/json', parent: folderId, permissionId, marker, role: 'latest'};
      const folderMeta = await ensure(accessToken, folder, folderCreated, D.FOLDER_NAME, beforeWrite);
      folder.parent = await verifiedRootParent(accessToken, folder);
      validate(folderMeta, folder);
      if (!folderCreated) await onCreated({folderCreated: true, fileCreated});
      await ensure(accessToken, file, fileCreated, D.FILE_NAME, beforeWrite);
      if (!fileCreated) await onCreated({folderCreated: true, fileCreated: true});
      // Re-read both after creation and immediately before sending any member data.
      validate(await metadata(accessToken, folderId), folder);
      validate(await metadata(accessToken, fileId), file);
      const upload = D.DRIVE_ORIGIN + '/upload/drive/v3/files/' + encodeURIComponent(fileId);
      let uploaded;
      if (bytes <= 5 * 1024 * 1024) {
        await beforeWrite();
        uploaded = await request(upload + '?uploadType=media&fields=id,size', {method: 'PATCH', headers: headers(accessToken, {'Content-Type': 'application/json; charset=UTF-8'}), body: content});
      } else {
        await beforeWrite();
        const session = await request(upload + '?uploadType=resumable&fields=id,size', {method: 'PATCH', headers: headers(accessToken, {'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes)}), body: '{}'});
        let target;
        try { target = new URL(session.headers.get('location')); } catch (_) { throw new D.BackupError('backup-response-invalid'); }
        if (target.origin !== D.DRIVE_ORIGIN || target.pathname !== '/upload/drive/v3/files/' + fileId || target.username || target.password || target.hash || target.searchParams.get('uploadType') !== 'resumable' || !target.searchParams.get('upload_id')) throw new D.BackupError('backup-response-invalid');
        validate(await metadata(accessToken, folderId), folder);
        validate(await metadata(accessToken, fileId), file);
        await beforeWrite();
        uploaded = await request(target.href, {method: 'PUT', headers: headers(accessToken, {'Content-Type': 'application/json', 'Content-Length': String(bytes)}), body: content});
      }
      if (uploaded.body?.id !== fileId || Number(uploaded.body?.size) !== bytes) throw new D.BackupError('backup-response-invalid', 503, 30, true);
      return {folderId, fileId, folderCreated: true, fileCreated: true, bytes};
    }
  };
}
module.exports = {createProvider};
