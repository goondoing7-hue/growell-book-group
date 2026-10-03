'use strict';

const crypto = require('node:crypto');
const video = require('./materialVideoService.cjs');
const {VideoError} = video;
const VERSION = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REASONS = new Set(['transcript_unavailable', 'video_unavailable', 'not_configured', 'rate_limited', 'temporary_error']);

function normalizedTranscript(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > MAX_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text) ||
      typeof value.language !== 'string' || !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,5}$/.test(value.language) || value.source !== 'youtube_captions') throw new VideoError('temporary_error');
  // Preserve the caption text and actual language; do not translate or silently truncate.
  return {text: value.text, language: value.language, source: 'youtube_captions'};
}
function safeResult(value) {
  if (value?.status === 'ready') return {status: 'ready', transcript: normalizedTranscript(value.transcript)};
  if (value?.status === 'pending' && typeof value.jobId === 'string' && JOB.test(value.jobId)) return {status: 'pending', jobId: value.jobId};
  if (value?.status === 'unavailable') return {status: 'unavailable', reason: REASONS.has(value.reason) ? value.reason : 'temporary_error'};
  throw new VideoError('temporary_error');
}
function unavailable(value) {
  return {status: 'unavailable', reason: REASONS.has(value?.reason) ? value.reason : 'temporary_error', retryAfter: Math.min(604800, Math.max(3, Number(value?.retryAfter) || 60))};
}
function ready(value, id) {
  const transcript = normalizedTranscript(value.transcript);
  if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) throw new VideoError('temporary_error');
  return {status: 'ready', videoId: id, transcript, fetchedAt: value.fetchedAt};
}

// Transcript RPC responses may contain up to 2 MiB of text. The summary
// transport's 1 MB cap is intentionally kept unchanged for its existing callers.
function createTranscriptTransport(fetchImpl = globalThis.fetch) {
  return async function request(url, options = {}) {
    const controller = new AbortController(), upstream = options.signal;
    const abort = () => controller.abort();
    if (upstream?.aborted) throw new VideoError('temporary_error');
    upstream?.addEventListener('abort', abort, {once: true});
    const timeout = setTimeout(abort, 6000);
    let reader;
    try {
      const response = await fetchImpl(url, {...options, signal: controller.signal, redirect: 'error'});
      if (!response.ok) throw new VideoError(response.status === 429 ? 'rate_limited' : 'temporary_error');
      const maxBytes = MAX_TEXT_BYTES + 32768;
      if (Number(response.headers?.get('content-length')) > maxBytes || !response.body?.getReader) throw new VideoError('temporary_error');
      reader = response.body.getReader();
      let length = 0; const chunks = [];
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > maxBytes) throw new VideoError('temporary_error');
        chunks.push(Buffer.from(part.value));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : null;
    } catch (error) { if (error instanceof VideoError) throw error; throw new VideoError('temporary_error'); }
    finally { if (reader) {try {await reader.cancel();} catch (_) {} reader.releaseLock();} clearTimeout(timeout); upstream?.removeEventListener('abort', abort); }
  };
}
function createStore(config, request, transcriptRequest) {
  const base = video.createStore(config, request || video.createTransport());
  const transport = transcriptRequest || request || createTranscriptTransport();
  const headers = {apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, 'Content-Type': 'application/json'};
  const rpc = (name, payload, signal) => transport(config.database + '/rest/v1/rpc/' + name, {method: 'POST', headers, signal, body: JSON.stringify(payload)});
  return {
    user: base.user, profile: base.profile, note: base.note,
    claim: (profile, id, lease, enabled, signal) => rpc('growell_material_transcript_claim', {p_video: id, p_version: VERSION, p_owner: profile.id, p_auth: profile.auth_user_id, p_lease: lease, p_enabled: enabled}, signal),
    finish: (id, lease, result, signal) => rpc('growell_material_transcript_finish', {p_video: id, p_version: VERSION, p_lease: lease, p_result: result}, signal)
  };
}
function createService(options = {}) {
  const env = options.env || process.env, config = options.config || video.getConfig(env);
  const store = options.store || createStore(config, options.request || video.createTransport(options.fetch), options.transcriptRequest || options.request || createTranscriptTransport(options.fetch));
  const provider = options.provider || require('./materialTranscriptProvider.cjs').requestTranscript;
  async function approved(authId, signal) {
    const p = await store.profile(authId, signal);
    if (!p || p.auth_user_id !== authId || p.is_deleted !== false || p.approval_status !== 'approved') throw new VideoError('membership_required', 403);
    return p;
  }
  async function access(body, token, signal) {
    const note = await store.note(body.postId, token, signal);
    if (!note || note.id !== body.postId || !video.storedVideoIds(note).has(body.videoId)) throw new VideoError('material_not_found', 404);
  }
  async function generate(body, token, signal) {
    if (!config.configured) return {status: 'unavailable', reason: 'not_configured'};
    const user = await store.user(token, signal);
    if (!user || !UUID.test(user.id || '')) throw new VideoError('authentication_required', 401);
    const profile = await approved(user.id, signal);
    await access(body, token, signal);
    const lease = crypto.randomUUID();
    const enabled = typeof env.SUPADATA_API_KEY === 'string' && !!env.SUPADATA_API_KEY.trim();
    const claim = await store.claim(profile, body.videoId, lease, enabled, signal);
    if (claim?.status === 'ready') {
      await approved(user.id, signal); await access(body, token, signal);
      return ready(claim, body.videoId);
    }
    if (claim?.status === 'pending') return {status: 'pending', retryAfter: 5};
    if (claim?.status === 'unavailable') return unavailable(claim);
    if (claim?.status !== 'claimed' || !enabled) throw new VideoError('temporary_error');
    if (claim.jobId != null && (typeof claim.jobId !== 'string' || !JOB.test(claim.jobId))) throw new VideoError('temporary_error');
    if (signal?.aborted) throw new VideoError('temporary_error');
    let result;
    try {
      result = safeResult(await provider(body.videoId, {env, fetch: options.fetch || globalThis.fetch, signal, ...(claim.jobId ? {jobId: claim.jobId} : {})}));
    } catch (error) { result = {status: 'unavailable', reason: REASONS.has(error?.code) ? error.code : 'temporary_error'}; }
    if (signal?.aborted) throw new VideoError('temporary_error');
    const saved = await store.finish(body.videoId, lease, result, signal);
    await approved(user.id, signal); await access(body, token, signal);
    if (saved?.status === 'ready') return ready(saved, body.videoId);
    if (saved?.status === 'unavailable') return unavailable(saved);
    return {status: 'pending', retryAfter: 5};
  }
  return {config, generate};
}
// Reuse the established same-origin POST, strict {postId,videoId}, member JWT,
// no-store response, timeout, and safe error boundary without changing summaries.
function createHandler(options = {}) { return video.createHandler({...options, service: options.service || createService(options)}); }
module.exports = {VERSION, MAX_TEXT_BYTES, normalizedTranscript, safeResult, createTranscriptTransport, createStore, createService, createHandler};
