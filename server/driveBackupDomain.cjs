'use strict';

const crypto = require('node:crypto');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const DRIVE_ORIGIN = 'https://www.googleapis.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = 'openid email ' + DRIVE_SCOPE;
const FOLDER_NAME = 'GROWELL 백업';
const FILE_NAME = 'GROWELL-backup.json';
const FILE_ID = /^[A-Za-z0-9_-]{5,200}$/;
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

class BackupError extends Error {
  constructor(code, status = 503, retryAfter = 30, uncertain = false) {
    super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; this.uncertain = uncertain;
  }
}
function getConfig(env = process.env) {
  let key;
  try { key = Buffer.from(env.GROWELL_SYNC_KEY || '', 'base64'); } catch (_) { key = Buffer.alloc(0); }
  const origin = env.GROWELL_SYNC_ORIGIN || 'https://growell-book.vercel.app';
  const database = env.GROWELL_SUPABASE_URL || 'https://oxaeecawijnetwmvggjs.supabase.co';
  const config = {
    origin, database, key, clientId: env.GROWELL_GOOGLE_CLIENT_ID || '', clientSecret: env.GROWELL_GOOGLE_CLIENT_SECRET || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '', cronSecret: env.CRON_SECRET || '', scopes: SCOPES,
    redirectUri: origin + '/api/drive-backup'
  };
  config.configured = !!(/^https:\/\/[^/?#:@]+(?::443)?$/.test(origin) && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database)
    && key.length === 32 && config.clientId && config.clientSecret && config.serviceKey && config.cronSecret);
  return config;
}
function seal(value, key, context) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('growell-drive-backup:' + context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
function unseal(value, key, context) {
  try {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from('growell-drive-backup:' + context));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
  } catch (_) { throw new BackupError('connection-key-invalid'); }
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function clean(value, length = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) : '';
}
function tokenContext(owner, generation) { return 'token:' + owner + ':' + generation; }
function marker(owner, accountId, key) {
  return crypto.createHmac('sha256', key).update('growell-drive-backup-owner:' + JSON.stringify([owner, accountId])).digest('hex');
}
function retryDelay(header, now = Date.now()) {
  let seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = Math.ceil((Date.parse(header) - now) / 1000);
  return Math.max(30, Math.min(86400, Number.isFinite(seconds) && seconds > 0 ? seconds : 30));
}
function authorizationUrl(config, {state, verifier} = {}) {
  if (!config.configured) throw new BackupError('backup-not-configured');
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(state) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new BackupError('invalid-request', 400);
  const params = new URLSearchParams({client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent select_account', state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'});
  return AUTH_URL + '?' + params;
}
module.exports = {AUTH_URL, TOKEN_URL, USERINFO_URL, DRIVE_ORIGIN, DRIVE_SCOPE, SCOPES, FOLDER_NAME, FILE_NAME, FILE_ID,
  MAX_CONTENT_BYTES, BackupError, getConfig, seal, unseal, hash, equal, clean, tokenContext, marker, retryDelay, authorizationUrl};
