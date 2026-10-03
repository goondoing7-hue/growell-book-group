'use strict';

// Public YouTube oEmbed metadata only; a missing title never blocks captions.
const ENDPOINT = 'https://www.youtube.com/oembed';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_MS = 5000;

function normalizeTitle(value) {
  if (typeof value !== 'string') return '';
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(plain).slice(0, 300).join('');
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('aborted')); };
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('aborted')); else resolve(value);
    }, () => { signal.removeEventListener('abort', abort); reject(new Error('unavailable')); });
  });
}
function cancel(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch (_) {} }
async function readJson(response, signal) {
  const type = response.headers?.get('content-type') || '';
  const length = response.headers?.get('content-length');
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(type) ||
      (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) ||
      typeof response.body?.getReader !== 'function') {
    cancel(response.body); return null;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    for (;;) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) return null;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    if (signal.aborted) return null;
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size)));
  } finally {
    if (!finished) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
    try { reader.releaseLock(); } catch (_) {}
  }
}
async function fetchYouTubeTitle(videoId, options = {}) {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return '';
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort();
  if (options.signal?.aborted) return '';
  options.signal?.addEventListener('abort', abort, {once: true});
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(MAX_REQUEST_MS, options.timeoutMs) : MAX_REQUEST_MS;
  const timer = setTimeout(abort, timeout);
  try {
    const target = new URL(ENDPOINT);
    target.searchParams.set('url', 'https://www.youtube.com/watch?v=' + videoId);
    target.searchParams.set('format', 'json');
    const response = await abortable((options.fetch || globalThis.fetch)(target.href, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal, headers: {Accept: 'application/json'}
    }), signal);
    if (response.redirected || response.status !== 200) { cancel(response.body); return ''; }
    const data = await readJson(response, signal);
    return data && typeof data === 'object' && !Array.isArray(data) ? normalizeTitle(data.title) : '';
  } catch (_) {
    // Do not expose remote bodies or error messages to callers.
    return '';
  } finally {
    clearTimeout(timer);options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = {fetchYouTubeTitle, normalizeTitle, MAX_RESPONSE_BYTES, MAX_REQUEST_MS};
