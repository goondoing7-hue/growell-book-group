'use strict';

const crypto = require('node:crypto');
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = 1;
const REASONS = new Set(['video_unavailable', 'not_configured', 'rate_limited', 'temporary_error']);
class VideoError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
function getConfig(env = process.env) {
  const database = env.GROWELL_SUPABASE_URL || 'https://oxaeecawijnetwmvggjs.supabase.co';
  const origin = env.GROWELL_SYNC_ORIGIN || 'https://growell-book.vercel.app';
  return {database, origin, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    configured: /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database) && /^https:\/\/[^/?#:@]+$/.test(origin) && !!env.SUPABASE_SERVICE_ROLE_KEY};
}
function youtubeId(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (value.length > 4096 || /[\u0000-\u0020<>"'`\\]/.test(value)) return null;
  try {
    const u = new URL(value), host = u.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(host)) id = /^\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
    }
    return typeof id === 'string' && VIDEO_ID.test(id) ? id : null;
  } catch (_) { return null; }
}
function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, entity => {
    const named = {'&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' '};
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    const num = lower.startsWith('&#x') ? parseInt(lower.slice(3, -1), 16) : Number(lower.slice(2, -1));
    return num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
  });
}
function storedVideoIds(note) {
  let links = note?.drive_links || [];
  if (typeof links === 'string' && links.length <= 100000) { try { links = JSON.parse(links); } catch (_) { links = []; } }
  const urls = Array.isArray(links) ? links.slice(0, 500).map(link => link?.driveUrl).filter(value => typeof value === 'string') : [];
  const html = typeof note?.html === 'string' ? note.html.slice(0, 500000) : '';
  const text = decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' '));
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) urls.push(match[0].replace(/[.,;!?)\]}]+$/, ''));
  return new Set(urls.map(youtubeId).filter(Boolean));
}
function normalizedSummary(value) {
  const clean = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const overview = clean(value?.overview, 1200);
  const points = Array.isArray(value?.points) ? value.points.slice(0, 8).map(text => clean(text, 600)).filter(Boolean) : [];
  if (!overview || !points.length) throw new VideoError('temporary_error');
  return {overview, points};
}
function createTransport(fetchImpl = globalThis.fetch) {
  return async function request(url, options = {}, kind = 'database') {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const upstream = options.signal;
    if (upstream?.aborted) throw new VideoError('temporary_error');
    upstream?.addEventListener('abort', onAbort, {once: true});
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchImpl(url, {...options, signal: controller.signal, redirect: 'error'});
      if (!response.ok) {
        if (kind === 'auth' && [401, 403].includes(response.status)) throw new VideoError('authentication_required', 401);
        if (kind === 'material' && [401, 403].includes(response.status)) throw new VideoError('membership_required', 403);
        throw new VideoError(response.status === 429 ? 'rate_limited' : 'temporary_error');
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1000000) throw new VideoError('temporary_error');
      return raw ? JSON.parse(raw) : null;
    } catch (error) { if (error instanceof VideoError) throw error; throw new VideoError('temporary_error'); }
    finally { clearTimeout(timeout); upstream?.removeEventListener('abort', onAbort); }
  };
}
function createStore(config, request) {
  const headers = {apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, 'Content-Type': 'application/json'};
  const db = (path, options = {}, kind) => request(config.database + '/rest/v1/' + path, {...options, headers: {...headers, ...options.headers}}, kind);
  return {
    user: (token, signal) => request(config.database + '/auth/v1/user', {headers: {apikey: config.serviceKey, Authorization: 'Bearer ' + token}, signal}, 'auth'),
    async profile(authId, signal) {
      const rows = await db('profiles?select=id,auth_user_id,is_deleted,approval_status&auth_user_id=eq.' + encodeURIComponent(authId) + '&limit=2', {signal});
      return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    },
    async note(postId, token, signal) {
      // The user's JWT, not the service-role token, enforces material RLS.
      const rows = await db('material_notes?select=id,html,drive_links&id=eq.' + encodeURIComponent(postId) + '&limit=1', {headers: {Authorization: 'Bearer ' + token}, signal}, 'material');
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    claim: (profile, videoId, lease, signal) => db('rpc/growell_material_video_claim', {method: 'POST', signal,
      body: JSON.stringify({p_video: videoId, p_version: VERSION, p_owner: profile.id, p_auth: profile.auth_user_id, p_lease: lease})}),
    finish: (videoId, lease, result, signal) => db('rpc/growell_material_video_finish', {method: 'POST', signal,
      body: JSON.stringify({p_video: videoId, p_version: VERSION, p_lease: lease, p_result: result})})
  };
}
function createService(options = {}) {
  const env = options.env || process.env, config = options.config || getConfig(env);
  const store = options.store || createStore(config, options.request || createTransport(options.fetch));
  const summarize = options.summarize || ((id, args) => require('./materialVideoAI.cjs').summarize(id, args));
  async function approved(authId, signal) {
    const p = await store.profile(authId, signal);
    if (!p || p.auth_user_id !== authId || p.is_deleted !== false || p.approval_status !== 'approved') throw new VideoError('membership_required', 403);
    return p;
  }
  async function access(postId, videoId, token, signal) {
    const note = await store.note(postId, token, signal);
    if (!note || note.id !== postId || !storedVideoIds(note).has(videoId)) throw new VideoError('material_not_found', 404);
  }
  async function generate(body, token, signal) {
    if (!config.configured) return {status: 'unavailable', reason: 'not_configured'};
    const user = await store.user(token, signal);
    if (!user || !UUID.test(user.id || '')) throw new VideoError('authentication_required', 401);
    const profile = await approved(user.id, signal);
    await access(body.postId, body.videoId, token, signal);
    const lease = crypto.randomUUID(), claim = await store.claim(profile, body.videoId, lease, signal);
    if (claim?.status === 'ready') return {status: 'ready', videoId: body.videoId, summary: normalizedSummary(claim.summary), generatedAt: claim.generatedAt};
    if (claim?.status === 'pending') return {status: 'pending', retryAfter: 3};
    if (claim?.status === 'unavailable') return {status: 'unavailable', reason: REASONS.has(claim.reason) ? claim.reason : 'temporary_error', retryAfter: Math.min(86400, Math.max(3, Number(claim.retryAfter) || 60))};
    if (claim?.status !== 'claimed') throw new VideoError('temporary_error');
    let result;
    try { result = {status: 'ready', summary: normalizedSummary(await summarize(body.videoId, {env, fetch: options.fetch || globalThis.fetch, signal}))}; }
    catch (error) { result = {status: 'unavailable', reason: REASONS.has(error?.code) ? error.code : 'temporary_error'}; }
    const saved = await store.finish(body.videoId, lease, result, signal);
    // A deleted post, revoked membership or removed link must not be exposed by a slow response.
    await approved(user.id, signal);
    await access(body.postId, body.videoId, token, signal);
    if (saved?.status === 'ready') return {status: 'ready', videoId: body.videoId, summary: normalizedSummary(saved.summary), generatedAt: saved.generatedAt};
    if (saved?.status === 'unavailable') return {status: 'unavailable', reason: REASONS.has(saved.reason) ? saved.reason : 'temporary_error', retryAfter: Math.min(86400, Math.max(3, Number(saved.retryAfter) || 60))};
    return {status: 'pending', retryAfter: 3};
  }
  return {config, generate};
}
function parseBody(req) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > 4096) throw new VideoError('request_too_large', 413);
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > 4096) throw new VideoError('request_too_large', 413);
    try { body = JSON.parse(body); } catch (_) { throw new VideoError('invalid_request', 400); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VideoError('invalid_request', 400);
  if (Buffer.byteLength(JSON.stringify(body)) > 4096) throw new VideoError('request_too_large', 413);
  if (Object.keys(body).some(key => !['postId', 'videoId'].includes(key)) || typeof body.postId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.postId) || typeof body.videoId !== 'string' || !VIDEO_ID.test(body.videoId)) throw new VideoError('invalid_request', 400);
  return {postId: body.postId, videoId: body.videoId};
}
function createHandler(options = {}) {
  const service = options.service || createService(options);
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
    const controller = new AbortController(); let deadline;
    const abort = () => controller.abort();
    req.once?.('aborted', abort);
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, {error: 'method_not_allowed'}); }
      if (req.headers.origin !== service.config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new VideoError('same_origin_required', 403);
      const token = /^Bearer ([A-Za-z0-9._~-]{1,16000})$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new VideoError('authentication_required', 401);
      const body = parseBody(req);
      const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => {controller.abort(); reject(new VideoError('temporary_error'));}, options.timeoutMs || 50000); });
      return send(200, await Promise.race([service.generate(body, token, controller.signal), timedOut]));
    } catch (error) {
      if (error instanceof VideoError && error.status < 500) return send(error.status, {error: error.code});
      return send(200, {status: 'unavailable', reason: REASONS.has(error?.code) ? error.code : 'temporary_error', retryAfter: 60});
    } finally { clearTimeout(deadline); controller.abort(); req.off?.('aborted', abort); }
  };
}
module.exports = {VERSION, VideoError, getConfig, youtubeId, storedVideoIds, normalizedSummary, createTransport, createStore, createService, createHandler};
