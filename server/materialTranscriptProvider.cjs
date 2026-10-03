'use strict';

// Native captions only: never translate, generate, retry, or poll implicitly.
// https://docs.supadata.ai/get-transcript
// https://docs.supadata.ai/api-reference/endpoint/transcript/transcript-get
const ENDPOINT = 'https://api.supadata.ai/v1/transcript';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_MS = 40000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
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
      typeof value.lang !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value.lang)) throw failure('temporary_error');
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
async function requestTranscript(videoId, options = {}) {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw failure('video_unavailable');
  const env = options.env || process.env;
  const apiKey = typeof env.SUPADATA_API_KEY === 'string' ? env.SUPADATA_API_KEY.trim() : '';
  if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) throw failure('not_configured');
  const polling = options.jobId != null;
  if (polling && !validJobId(options.jobId)) throw failure('temporary_error');
  const target = new URL(polling ? ENDPOINT + '/' + options.jobId : ENDPOINT);
  if (!polling) {
    target.searchParams.set('url', 'https://www.youtube.com/watch?v=' + videoId);
    target.searchParams.set('mode', 'native');
    target.searchParams.set('text', 'true');
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(MAX_REQUEST_MS, options.timeoutMs) : MAX_REQUEST_MS;
  const timer = setTimeout(abort, timeout);
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, {once: true});
  try {
    if (signal.aborted) throw failure('temporary_error');
    const fetcher = options.fetch || globalThis.fetch;
    // Exactly one externally countable request, including when checking a job.
    const response = await abortable(fetcher(target.href, {
      method: 'GET', redirect: 'error', signal,
      headers: {'Accept': 'application/json', 'x-api-key': apiKey}
    }), signal);
    if (response.redirected || ![200, 202].includes(response.status)) {
      cancelBody(response.body); throw failure(response.redirected ? 'temporary_error' : httpCode(response.status, polling));
    }
    const data = await readJson(response, signal);
    if (!isObject(data)) throw failure('temporary_error');
    if (response.status === 202) {
      if (!validJobId(data.jobId) || polling && data.jobId !== options.jobId) throw failure('temporary_error');
      return {status: 'pending', jobId: data.jobId};
    }
    if (polling) {
      if (data.status === 'queued' || data.status === 'active') return {status: 'pending', jobId: options.jobId};
      if (data.status === 'failed') throw failure(upstreamCode(data.error));
      if (data.status !== 'completed') throw failure('temporary_error');
    } else if (data.status != null) throw failure('temporary_error');
    if (data.error != null) throw failure(upstreamCode(data.error));
    const transcript = validateTranscript(polling && data.result != null ? data.result : data);
    return {status: 'ready', transcript};
  } catch (error) {
    // Never forward upstream messages, bodies, URLs, or the API key.
    throw failure(SAFE_CODES.has(error?.code) ? error.code : 'temporary_error');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = {requestTranscript, validateTranscript, validJobId, MAX_RESPONSE_BYTES, MAX_TRANSCRIPT_BYTES, MAX_REQUEST_MS};
