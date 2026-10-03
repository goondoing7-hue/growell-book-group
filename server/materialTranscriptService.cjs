'use strict';

const crypto = require('node:crypto');
const video = require('./materialVideoService.cjs');
const {VideoError} = video;
const VERSION = 3; // Korean-first captions, including explicit English fallback when Korean is absent.
const TRANSLATION_VERSION = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REASONS = new Set(['transcript_unavailable', 'video_unavailable', 'not_configured', 'rate_limited', 'temporary_error']);

function normalizedTranscript(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > MAX_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text) ||
      typeof value.language !== 'string' || !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,5}$/.test(value.language) || value.source !== 'youtube_captions') throw new VideoError('temporary_error');
  // Preserve original captions; Korean AI output is stored separately.
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  return {text: value.text, language: value.language, source: 'youtube_captions',
    ...(title && Array.from(title).length <= 300 && !/[\u0000-\u001f\u007f]/.test(title) ? {title} : {})};
}
function normalizedTranslation(value) {
  if (!value || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text)>1048576 || !/[가-힣]/.test(value.text)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text) || value.language!=='ko' || value.source!=='ai_translation'
    || !UUID.test(value.generationId || '') || typeof value.generatedAt!=='string' || !Number.isFinite(Date.parse(value.generatedAt))
    || typeof value.model!=='string' || !value.model || value.model.length>120 || /[\u0000-\u001f\u007f]/.test(value.model)) throw new VideoError('temporary_error');
  return {text:value.text,language:'ko',source:'ai_translation',generationId:value.generationId,generatedAt:value.generatedAt,model:value.model};
}
function translationMetadata(value) {
  const model = typeof value?.model==='string' && /^[a-zA-Z0-9/_.:-]{1,120}$/.test(value.model) ? value.model : null;
  const count = n => Number.isSafeInteger(n) && n>=0 && n<100000000 ? n : null;
  return {model,inputTokens:count(value?.inputTokens),outputTokens:count(value?.outputTokens),durationMs:count(value?.durationMs)};
}
function translationFailure(error) {
  const partial = error?.partial;
  const chunks = Array.isArray(partial?.chunks) ? partial.chunks.slice(0,8).filter(c=>
    Number.isInteger(c?.index) && c.index>=0 && c.index<8 && typeof c.text==='string' && Buffer.byteLength(c.text)<=131072
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(c.text)).map(c=>({index:c.index,text:c.text,...translationMetadata(c)})) : [];
  return {status:'unavailable',...translationMetadata(partial),partial:chunks};
}
function safeResult(value) {
  if (value?.status === 'ready') return {status: 'ready', transcript: normalizedTranscript(value.transcript)};
  if (value?.status === 'pending' && typeof value.jobId === 'string' && JOB.test(value.jobId) &&
      (value.requestedLanguage == null || ['ko','en'].includes(value.requestedLanguage))) return {status: 'pending', jobId: value.jobId, requestedLanguage: value.requestedLanguage || 'ko'};
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
    async previous(id,signal) {
      const rows=await transport(config.database+'/rest/v1/growell_material_transcript_cache?select=transcript&video_id=eq.'+encodeURIComponent(id)+'&state=eq.ready&version=lt.'+VERSION+'&order=version.desc&limit=1',{headers,signal});
      return Array.isArray(rows) && rows.length===1 ? rows[0].transcript : null;
    },
    claim: (profile, id, lease, enabled, signal) => rpc('growell_material_transcript_claim', {p_video: id, p_version: VERSION, p_owner: profile.id, p_auth: profile.auth_user_id, p_lease: lease, p_enabled: enabled}, signal),
    reserveFallback: (profile, id, lease, signal) => rpc('growell_material_transcript_reserve_fallback', {p_video: id, p_version: VERSION, p_owner: profile.id, p_auth: profile.auth_user_id, p_lease: lease}, signal),
    claimTranslation: (profile,id,generation,enabled,signal) => rpc('growell_material_translation_claim', {p_video:id,p_version:VERSION,p_translation_version:TRANSLATION_VERSION,p_owner:profile.id,p_auth:profile.auth_user_id,p_generation:generation,p_enabled:enabled}, signal),
    finishTranslation: (generation,result,signal) => rpc('growell_material_translation_finish',{p_generation:generation,p_result:result},signal),
    finish: (id, lease, result, signal) => rpc('growell_material_transcript_finish', {p_video: id, p_version: VERSION, p_lease: lease, p_result: result}, signal)
  };
}
function createService(options = {}) {
  const env = options.env || process.env, config = options.config || video.getConfig(env);
  const store = options.store || createStore(config, options.request || video.createTransport(options.fetch), options.transcriptRequest || options.request || createTranscriptTransport(options.fetch));
  const provider = options.provider || require('./materialTranscriptProvider.cjs').requestTranscript;
  const titleProvider = options.titleProvider || require('./materialVideoMetadata.cjs').fetchYouTubeTitle;
  const translator = options.translator || ((input,settings)=>require('./materialTranscriptTranslation.cjs').translateTranscript(input,settings));
  const translationEnabled = !!(env.GEMINI_API_KEY || env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || env.VERCEL || options.translator);
  async function approved(authId, signal) {
    const p = await store.profile(authId, signal);
    if (!p || p.auth_user_id !== authId || p.is_deleted !== false || p.approval_status !== 'approved') throw new VideoError('membership_required', 403);
    return p;
  }
  async function access(body, token, signal) {
    const note = await store.note(body.postId, token, signal);
    if (!note || note.id !== body.postId || !video.storedVideoIds(note).has(body.videoId)) throw new VideoError('material_not_found', 404);
  }
  async function translated(response,body,profile,token,signal,{fresh=false}={}) {
    if (!/^en(?:[-_]|$)/i.test(response.transcript.language)) return response;
    // Extraction and translation get separate requests, so a slow caption
    // provider cannot consume the AI request's execution window.
    if (fresh) return {...response,translationStatus:translationEnabled && response.transcript.text.length<=60000 ? 'pending' : 'unavailable',retryAfter:3};
    let extra = {translationStatus:'unavailable'};
    try {
      const generationId=crypto.randomUUID();
      const claim=await store.claimTranslation(profile,body.videoId,generationId,translationEnabled,signal);
      if (claim?.status==='ready') extra={translation:normalizedTranslation(claim.translation)};
      else if (claim?.status==='pending') extra={translationStatus:'pending',retryAfter:5};
      else if (claim?.status==='claimed' && claim.generationId===generationId && translationEnabled) {
        await approved(profile.auth_user_id,signal);await access(body,token,signal);
        let result;
        try {
          const output=await translator({text:response.transcript.text,signal},{env,fetch:options.fetch});
          normalizedTranslation({...output,language:'ko',source:'ai_translation',generationId,generatedAt:new Date().toISOString()});
          result={status:'ready',text:output.text,...translationMetadata(output)};
        } catch(error) {result=translationFailure(error);}
        // Persist generated work before responding, including completed chunks
        // from a failed attempt. Never leak provider errors or partial text.
        const saved=await store.finishTranslation(generationId,result,AbortSignal.timeout(6000));
        if(saved?.status==='ready') extra={translation:normalizedTranslation(saved.translation)};
      }
    } catch (_) { /* The saved English original remains available. */ }
    await approved(profile.auth_user_id,signal);await access(body,token,signal);
    return {...response,...extra};
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
      return translated(ready(claim, body.videoId),body,profile,token,signal);
    }
    if (claim?.status === 'pending') return {status: 'pending', retryAfter: 5};
    if (claim?.status === 'unavailable') return unavailable(claim);
    if (claim?.status !== 'claimed' || !enabled) throw new VideoError('temporary_error');
    if (claim.jobId != null && (typeof claim.jobId !== 'string' || !JOB.test(claim.jobId))) throw new VideoError('temporary_error');
    if (claim.requestedLanguage != null && !['ko','en'].includes(claim.requestedLanguage)) throw new VideoError('temporary_error');
    if (signal?.aborted) throw new VideoError('temporary_error');
    let result;
    try {
      result = safeResult(await provider(body.videoId, {env, fetch: options.fetch || globalThis.fetch, signal,
        ...(claim.jobId ? {jobId: claim.jobId, requestedLanguage: claim.requestedLanguage || 'ko'} : {}),
        reserveFallback: async () => {
          if (!store.reserveFallback || signal?.aborted) return false;
          await approved(user.id, signal); await access(body, token, signal);
          return (await store.reserveFallback(profile, body.videoId, lease, signal))?.reserved === true;
        }}));
    } catch (error) { result = {status: 'unavailable', reason: REASONS.has(error?.code) ? error.code : 'temporary_error'}; }
    if(result.status==='unavailable' && ['transcript_unavailable','temporary_error','rate_limited'].includes(result.reason) && store.previous && !signal?.aborted){
      // A language preference upgrade must not make a previously saved source
      // disappear when the upstream has no Korean track or is temporarily down.
      try {const previous=await store.previous(body.videoId,signal);if(previous)result={status:'ready',transcript:normalizedTranscript(previous)};} catch (_) {}
    }
    if (result.status === 'ready' && !signal?.aborted) {
      let title = '';
      try { title = await titleProvider(body.videoId, {fetch: options.fetch || globalThis.fetch, signal}); } catch (_) {}
      result.transcript = normalizedTranscript({...result.transcript, title});
    }
    if (signal?.aborted) throw new VideoError('temporary_error');
    const saved = await store.finish(body.videoId, lease, result, signal);
    await approved(user.id, signal); await access(body, token, signal);
    if (saved?.status === 'ready') return translated(ready(saved, body.videoId),body,profile,token,signal,{fresh:true});
    if (saved?.status === 'unavailable') return unavailable(saved);
    return {status: 'pending', retryAfter: 5};
  }
  return {config, generate};
}
// Reuse the established same-origin POST, strict {postId,videoId}, member JWT,
// no-store response, timeout, and safe error boundary without changing summaries.
function createHandler(options = {}) { return video.createHandler({...options, service: options.service || createService(options)}); }
module.exports = {VERSION, TRANSLATION_VERSION, MAX_TEXT_BYTES, normalizedTranscript, normalizedTranslation, translationMetadata, translationFailure, safeResult, createTranscriptTransport, createStore, createService, createHandler};
