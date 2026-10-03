'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {requestTranscript, validateTranscript, validJobId, MAX_RESPONSE_BYTES, MAX_TRANSCRIPT_BYTES, MAX_REQUEST_MS} = require('../server/materialTranscriptProvider.cjs');

const VIDEO = 'abcdefghijk';
const JOB = '123e4567-e89b-12d3-a456-426614174000';
const KEY = 'synthetic-server-secret';
const env = {SUPADATA_API_KEY: KEY};
const native = {content: '  원래 자막입니다.\n두 번째 줄입니다.  ', lang: 'ko', availableLangs: ['ko', 'en']};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code && !error.cause);

test('only a canonical YouTube ID leaves the server; native mode, key header and redirects are fixed', async () => {
  let requests = 0;
  const result = await requestTranscript(VIDEO, {env, fetch: async (url, request) => {
    requests++;
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://api.supadata.ai/v1/transcript');
    assert.deepEqual(Object.fromEntries(target.searchParams), {url: 'https://www.youtube.com/watch?v=' + VIDEO, mode: 'native', text: 'true'});
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.body, undefined);
    assert.ok(!url.includes(KEY)); assert.ok(request.signal instanceof AbortSignal);
    return json(native);
  }});
  assert.equal(requests, 1);
  assert.deepEqual(result, {status: 'ready', transcript: {text: native.content, language: 'ko', source: 'youtube_captions'}});
});

test('the native language is preserved without requesting translation or a language fallback', async () => {
  for (const language of ['en', 'zh-TW', 'pt-BR', 'zh-Hans-CN', 'fil']) {
    const result = await requestTranscript(VIDEO, {env, fetch: async url => {
      assert.equal(new URL(url).searchParams.has('lang'), false);
      return json({...native, lang: language});
    }});
    assert.equal(result.transcript.language, language);
  }
});

test('202 returns the validated job ID without polling or starting a second request', async () => {
  let calls = 0;
  const result = await requestTranscript(VIDEO, {env, fetch: async () => { calls++; return json({jobId: JOB}, 202); }});
  assert.deepEqual(result, {status: 'pending', jobId: JOB}); assert.equal(calls, 1);
});

test('checking a stored job uses exactly one GET and preserves the same pending job', async () => {
  for (const status of ['queued', 'active']) {
    let calls = 0;
    const result = await requestTranscript(VIDEO, {env, jobId: JOB, fetch: async (url, request) => {
      calls++;
      assert.equal(url, 'https://api.supadata.ai/v1/transcript/' + JOB);
      assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.method, 'GET');
      return json({status});
    }});
    assert.equal(calls, 1); assert.deepEqual(result, {status: 'pending', jobId: JOB});
  }
});

test('completed job supports the documented REST shape and SDK result wrapper', async () => {
  for (const body of [{status: 'completed', ...native}, {status: 'completed', result: native, error: null}]) {
    const result = await requestTranscript(VIDEO, {env, jobId: JOB, fetch: async () => json(body)});
    assert.equal(result.transcript.text, native.content);
  }
});

test('206 never falls back to AI even if the response contains text', async () => {
  let calls = 0, cancelled = false;
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => {
    calls++;
    return {status: 206, body: {cancel() {cancelled = true;}}, text() {throw new Error('must not read');}};
  }}), 'transcript_unavailable');
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test('HTTP errors map to fixed public codes without reading arbitrary provider bodies', async () => {
  for (const [status, code] of [[401, 'not_configured'], [402, 'rate_limited'], [403, 'video_unavailable'], [404, 'video_unavailable'], [429, 'rate_limited'], [400, 'temporary_error'], [500, 'temporary_error'], [503, 'temporary_error'], [302, 'temporary_error']]) {
    let calls = 0;
    await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => {
      calls++; return {status, body: {cancel() {}}, text() {throw new Error(KEY);}};
    }}), code);
    assert.equal(calls, 1);
  }
  await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, fetch: async () => json({message: KEY}, 404)}), 'temporary_error');
});

test('failed jobs use only allowlisted error codes, never provider messages', async () => {
  for (const [error, code] of [['transcript-unavailable', 'transcript_unavailable'], ['forbidden', 'video_unavailable'], ['not-found', 'video_unavailable'], ['unauthorized', 'not_configured'], ['limit-exceeded', 'rate_limited'], ['upgrade-required', 'rate_limited'], ['internal-error', 'temporary_error'], [KEY, 'temporary_error']]) {
    await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, fetch: async () => json({status: 'failed', error: {error, message: KEY, details: KEY}})}), code);
  }
});

test('unsafe input and missing or malformed configuration cause zero requests', async () => {
  let calls = 0;
  const fetch = async () => {calls++; return json(native);};
  for (const video of ['../x', 'https://youtu.be/' + VIDEO, VIDEO + '&mode=generate', null, 123]) await rejectCode(requestTranscript(video, {env, fetch}), 'video_unavailable');
  for (const key of [undefined, '', ' ', 'x\r\nInjected: yes', 'x'.repeat(4097), {}]) await rejectCode(requestTranscript(VIDEO, {env: {SUPADATA_API_KEY: key}, fetch}), 'not_configured');
  for (const jobId of ['', '../x', 'x?mode=generate', 'x/y', 'x'.repeat(129), {}, 123]) await rejectCode(requestTranscript(VIDEO, {env, fetch, jobId}), 'temporary_error');
  assert.equal(calls, 0); assert.equal(validJobId(JOB), true);
});

test('malformed 202 job IDs and unexpected job states are rejected', async () => {
  for (const body of [{}, {jobId: '../x'}, {jobId: {}}, {jobId: 'x'.repeat(129)}]) await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => json(body, 202)}), 'temporary_error');
  await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, fetch: async () => json({jobId: 'another-job'}, 202)}), 'temporary_error');
  for (const body of [{}, {status: 'unexpected'}, {status: 'completed'}, {status: 'completed', result: []}]) await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, fetch: async () => json(body)}), 'temporary_error');
});

test('non-JSON, malformed types, invalid language and control characters cannot become a transcript', async () => {
  for (const body of [null, [], {...native, content: {}}, {...native, content: [{text: 'segment'}]}, {...native, lang: null}, {...native, lang: '<script>'}, {...native, lang: 'x'.repeat(40)}, {...native, content: 'text\u0000'}, {...native, status: 'completed'}, {...native, error: 'secret'}]) {
    await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => json(body)}), 'temporary_error');
  }
  for (const [body, type] of [['not-json ' + KEY, 'application/json'], ['<html>' + KEY, 'text/html']]) await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => new Response(body, {headers: {'Content-Type': type}})}), 'temporary_error');
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => new Response(new Uint8Array([0xff]), {headers: {'Content-Type': 'application/json'}})}), 'temporary_error');
});

test('empty transcripts are unavailable rather than fabricated', async () => {
  for (const content of ['', ' \n\t ', []]) await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => json({...native, content})}), 'transcript_unavailable');
});

test('oversized Content-Length is refused before acquiring or reading the response stream', async () => {
  let cancelled = false;
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => ({status: 200,
    headers: new Headers({'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1)}),
    body: {getReader() {throw new Error('must not read');}, cancel() {cancelled = true;}}
  })}), 'temporary_error');
  assert.equal(cancelled, true);
});

test('the streaming cap cancels chunked bodies without reading the rest or calling text/json', async () => {
  let reads = 0, cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => ({status: 200,
    headers: new Headers({'content-type': 'application/json'}),
    body: {getReader() {return {async read() {reads++; return {done: false, value: chunk};}, cancel() {cancelled = true;}, releaseLock() {}};}},
    text() {throw new Error('must not read whole body');}, json() {throw new Error('must not read whole body');}
  })}), 'temporary_error');
  assert.equal(reads, 3); assert.equal(cancelled, true);
});

test('transcript size limit counts UTF-8 bytes rather than only JS string length', () => {
  assert.equal(MAX_TRANSCRIPT_BYTES, 2 * 1024 * 1024);
  assert.throws(() => validateTranscript({...native, content: '한'.repeat(Math.floor(MAX_TRANSCRIPT_BYTES / 3) + 1)}), {code: 'temporary_error'});
});

test('redirected responses and thrown upstream details never leak', async () => {
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => ({status: 200, redirected: true, body: {cancel() {}}})}), 'temporary_error');
  await rejectCode(requestTranscript(VIDEO, {env, fetch: async () => {throw new Error(KEY);}}), 'temporary_error');
});

test('an already-aborted caller signal prevents the external request', async () => {
  const controller = new AbortController(); controller.abort(new Error(KEY));
  let calls = 0;
  await rejectCode(requestTranscript(VIDEO, {env, signal: controller.signal, fetch: async () => {calls++; return json(native);}}), 'temporary_error');
  assert.equal(calls, 0);
});

test('the deadline aborts a stalled fetch and never retries', async () => {
  let signal, calls = 0;
  await rejectCode(requestTranscript(VIDEO, {env, timeoutMs: 10, fetch: async (_, request) => {calls++; signal = request.signal; return new Promise(() => {});}}), 'temporary_error');
  assert.equal(MAX_REQUEST_MS, 40000); assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('the same deadline covers body streaming and cancels a stalled reader', async () => {
  let cancelled = false, signal;
  await rejectCode(requestTranscript(VIDEO, {env, timeoutMs: 10, fetch: async (_, request) => {
    signal = request.signal;
    return {status: 200, headers: new Headers({'content-type': 'application/json'}), body: {getReader() {return {
      read() {return new Promise(() => {});}, cancel() {cancelled = true;}, releaseLock() {}
    };}}};
  }}), 'temporary_error');
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test('caller abort propagates into a running fetch and remains a safe public error', async () => {
  const controller = new AbortController(); let signal;
  const promise = requestTranscript(VIDEO, {env, signal: controller.signal, fetch: async (_, request) => {signal = request.signal; return new Promise(() => {});}});
  controller.abort(new Error(KEY));
  await rejectCode(promise, 'temporary_error'); assert.equal(signal.aborted, true);
});
