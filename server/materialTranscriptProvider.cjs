'use strict';

// Native captions only: prefer Korean, then try English once if Korean is
// unavailable or English is advertised, after reserving the paid request.
// https://docs.supadata.ai/get-transcript
// https://docs.supadata.ai/api-reference/endpoint/transcript/transcript-get
const ENDPOINT = 'https://api.supadata.ai/v1/transcript';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_MS = 40000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const SAFE_CODES = new Set(['transcript_unavailable', 'video_unavailable', 'not_configured', 'rate_limited', 'temporary_error']);

function failure(code) { const error = new Error(code); error.code = code; return error; }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validJobId(value) { return typeof value === 'string' && JOB_ID.test(value); }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(failure('temporary_error'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure('temporary_error')); };
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(failure('temporary_error')); else resolve(value);
    }, () => { signal.removeEventListener('abort', abort); reject(failure('temporary_error')); });
  });
}
function cancelBody(body) {
  // Cancellation is best effort and must not extend the request deadline.
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch (_) {}
}
async function readJson(response, signal) {
  const contentType = response.headers?.get('content-type') || '';
  const length = response.headers?.get('content-length');
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType) ||
      (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) ||
      typeof response.body?.getReader !== 'function') {
    cancelBody(response.body); throw failure('temporary_error');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, finished = false;
  try {
    for (;;) {
      if (signal.aborted) throw failure('temporary_error');
      const {done, value} = await abortable(reader.read(), signal);
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) throw failure('temporary_error');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure('temporary_error');
      chunks.push(value);
    }
    if (signal.aborted) throw failure('temporary_error');
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size));
    return JSON.parse(raw);
  } finally {
    if (!finished) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
    try { reader.releaseLock(); } catch (_) {}
  }
}
function validateTranscript(value) {
  if (!isObject(value)) throw failure('temporary_error');
  if (typeof value.content === 'string' && !value.content.trim() || Array.isArray(value.content) && value.content.length === 0) throw failure('transcript_unavailable');
  if (typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > MAX_TRANSCRIPT_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.content) ||
      typeof value.lang !== 'string' || !LANGUAGE.test(value.lang)) throw failure('temporary_error');
  // Preserve the native language and text. The source follows from mode=native;
  // callers may only supply stored job IDs originating from this adapter.
  return {text: value.content, language: value.lang, source: 'youtube_captions'};
}
function upstreamCode(error) {
  const code = isObject(error) ? error.error : error;
  if (code === 'transcript-unavailable') return 'transcript_unavailable';
  if (code === 'forbidden' || code === 'not-found') return 'video_unavailable';
  if (code === 'unauthorized') return 'not_configured';
  if (code === 'limit-exceeded' || code === 'upgrade-required') return 'rate_limited';
  return 'temporary_error';
}
function httpCode(status, polling) {
  if (status === 206) return 'transcript_unavailable';
  if (status === 401) return 'not_configured';
  if (status === 402 || status === 429) return 'rate_limited';
  if (status === 403) return 'video_unavailable';
  // A job expires after one hour; its 404 is not evidence about the video.
  if (status === 404) return polling ? 'temporary_error' : 'video_unavailable';
  return 'temporary_error';
}
function languageBase(value) { return value.toLowerCase().split('-')[0]; }
function englishAvailable(value) {
  if (!Array.isArray(value)) return false;
  return value.some(language => typeof language === 'string' && LANGUAGE.test(language) && languageBase(language) === 'en');
}
async function requestTranscript(videoId, options = {}) {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw failure('video_unavailable');
  const env = options.env || process.env;
  const apiKey = typeof env.SUPADATA_API_KEY === 'string' ? env.SUPADATA_API_KEY.trim() : '';
  if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) throw failure('not_configured');
  const polling = options.jobId != null;
  if (polling && !validJobId(options.jobId)) throw failure('temporary_error');
  const requestedLanguage = options.requestedLanguage == null ? 'ko' : options.requestedLanguage;
  if (requestedLanguage !== 'ko' && requestedLanguage !== 'en') throw failure('temporary_error');
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(MAX_REQUEST_MS, options.timeoutMs) : MAX_REQUEST_MS;
  const timer = setTimeout(abort, timeout);
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, {once: true});
  const fetcher = options.fetch || globalThis.fetch;
  async function exchange(jobId, language) {
    if (signal.aborted) throw failure('temporary_error');
    const checking = jobId != null;
    const target = new URL(checking ? ENDPOINT + '/' + jobId : ENDPOINT);
    if (!checking) {
      target.searchParams.set('url', 'https://www.youtube.com/watch?v=' + videoId);
      target.searchParams.set('mode', 'native');
      target.searchParams.set('text', 'true');
      target.searchParams.set('lang', language);
    }
    const response = await abortable(fetcher(target.href, {
      method: 'GET', redirect: 'error', signal,
      headers: {'Accept': 'application/json', 'x-api-key': apiKey}
    }), signal);
    if (response.redirected || ![200, 202].includes(response.status)) {
      cancelBody(response.body); throw failure(response.redirected ? 'temporary_error' : httpCode(response.status, checking));
    }
    const data = await readJson(response, signal);
    if (!isObject(data)) throw failure('temporary_error');
    if (response.status === 202) {
      if (!validJobId(data.jobId) || checking && data.jobId !== jobId) throw failure('temporary_error');
      return {status: 'pending', jobId: data.jobId, requestedLanguage: language};
    }
    if (checking) {
      if (data.status === 'queued' || data.status === 'active') return {status: 'pending', jobId, requestedLanguage: language};
      if (data.status === 'failed') throw failure(upstreamCode(data.error));
      if (data.status !== 'completed') throw failure('temporary_error');
    } else if (data.status != null) throw failure('temporary_error');
    if (data.error != null) throw failure(upstreamCode(data.error));
    const value = checking && data.result != null ? data.result : data;
    return {status: 'ready', transcript: validateTranscript(value), hasEnglish: englishAvailable(value.availableLangs)};
  }
  try {
    let first;
    try {
      first = await exchange(polling ? options.jobId : null, requestedLanguage);
    } catch (error) {
      // Missing preferred-language captions can be reported as 206, empty
      // content or a failed native job without an availableLangs list. This
      // alone permits one reserved English attempt; other failures never do.
      if (error?.code !== 'transcript_unavailable' || requestedLanguage !== 'ko' || typeof options.reserveFallback !== 'function') throw error;
      let reserved;
      try { reserved = await abortable(options.reserveFallback(), signal); }
      catch (_) { if (signal.aborted) throw failure('temporary_error'); throw error; }
      if (signal.aborted) throw failure('temporary_error');
      if (reserved !== true) throw error;
      const fallback = await exchange(null, 'en');
      // Return directly so even an unexpected native language cannot cause a
      // third request. Pending state persists the English stage for later polls.
      return fallback.status === 'pending' ? fallback : {status: 'ready', transcript: fallback.transcript};
    }
    if (first.status === 'pending') return first;
    const original = {status: 'ready', transcript: first.transcript};
    const actualLanguage = languageBase(first.transcript.language);
    // A completed English job never starts another paid request. English already
    // returned from the Korean preference also needs no redundant second fetch.
    if (requestedLanguage === 'en' || actualLanguage === 'ko' || actualLanguage === 'en' || !first.hasEnglish || typeof options.reserveFallback !== 'function') return original;
    try {
      if (await abortable(options.reserveFallback(), signal) !== true) return original;
      if (signal.aborted) throw failure('temporary_error');
      const fallback = await exchange(null, 'en');
      if (fallback.status === 'pending') return fallback;
      const actualFallback = languageBase(fallback.transcript.language);
      return actualFallback === 'en' || actualFallback === 'ko' ? {status: 'ready', transcript: fallback.transcript} : original;
    } catch (error) {
      // A quota denial or failed preferred-language fetch must not discard the
      // valid native transcript already received. Cancellation still propagates.
      if (signal.aborted) throw failure('temporary_error');
      return original;
    }
  } catch (error) {
    // Never forward upstream messages, bodies, URLs, or the API key.
    throw failure(SAFE_CODES.has(error?.code) ? error.code : 'temporary_error');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = {requestTranscript, validateTranscript, validJobId, MAX_RESPONSE_BYTES, MAX_TRANSCRIPT_BYTES, MAX_REQUEST_MS};
