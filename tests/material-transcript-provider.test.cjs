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
    assert.deepEqual(Object.fromEntries(target.searchParams), {url: 'https://www.youtube.com/watch?v=' + VIDEO, mode: 'native', text: 'true', lang: 'ko'});
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.body, undefined);
    assert.ok(!url.includes(KEY)); assert.ok(request.signal instanceof AbortSignal);
    return json(native);
  }});
  assert.equal(requests, 1);
  assert.deepEqual(result, {status: 'ready', transcript: {text: native.content, language: 'ko', source: 'youtube_captions'}});
});

test('the first available native language is preserved when no English reservation is provided', async () => {
  for (const language of ['en', 'zh-TW', 'pt-BR', 'zh-Hans-CN', 'fil']) {
    const result = await requestTranscript(VIDEO, {env, fetch: async url => {
      assert.equal(new URL(url).searchParams.get('lang'), 'ko');
      return json({...native, lang: language});
    }});
    assert.equal(result.transcript.language, language);
  }
});

test('202 returns the validated job ID without polling or starting a second request', async () => {
  let calls = 0;
  const result = await requestTranscript(VIDEO, {env, fetch: async () => { calls++; return json({jobId: JOB}, 202); }});
  assert.deepEqual(result, {status: 'pending', jobId: JOB, requestedLanguage: 'ko'}); assert.equal(calls, 1);
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
    assert.equal(calls, 1); assert.deepEqual(result, {status: 'pending', jobId: JOB, requestedLanguage: 'ko'});
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

const french = {content: '  Un texte français natif.\nLa deuxième ligne.  ', lang: 'fr', availableLangs: ['fr', 'en']};
const firstTranscript = {text: french.content, language: 'fr', source: 'youtube_captions'};
const english = {content: 'Existing English captions.', lang: 'en', availableLangs: ['fr', 'en']};
const englishTranscript = {text: english.content, language: 'en', source: 'youtube_captions'};

test('Korean or English native results need no second request, including language subtags', async () => {
  for (const lang of ['ko', 'ko-KR', 'KO-kr', 'en', 'en-US', 'EN-gb']) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env,
      reserveFallback: async () => {reservations++; return true;},
      fetch: async url => {calls++; assert.equal(new URL(url).searchParams.get('lang'), 'ko'); return json({...native, lang});}
    });
    assert.equal(calls, 1); assert.equal(reservations, 0); assert.equal(result.transcript.language, lang);
  }
});

test('English fallback is requested only after its paid-call reservation succeeds', async () => {
  const order = [], signals = [];
  let calls = 0;
  const result = await requestTranscript(VIDEO, {env,
    reserveFallback: async () => {order.push('reserved'); return true;},
    fetch: async (url, request) => {
      calls++; const target = new URL(url); const lang = target.searchParams.get('lang'); order.push('fetch-' + lang); signals.push(request.signal);
      assert.equal(target.origin + target.pathname, 'https://api.supadata.ai/v1/transcript');
      assert.equal(target.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + VIDEO);
      assert.equal(target.searchParams.get('mode'), 'native'); assert.equal(target.searchParams.get('text'), 'true');
      assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.redirect, 'error'); assert.equal(request.method, 'GET');
      assert.ok(!url.includes(KEY)); return json(calls === 1 ? french : english);
    }
  });
  assert.deepEqual(order, ['fetch-ko', 'reserved', 'fetch-en']); assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]); assert.deepEqual(result, {status: 'ready', transcript: englishTranscript});
});

test('English availability accepts native English subtags without requesting a third language', async () => {
  for (const advertised of ['en', 'en-US', 'EN-gb']) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => {reservations++; return true;}, fetch: async url => {
      calls++; assert.equal(new URL(url).searchParams.get('lang'), calls === 1 ? 'ko' : 'en');
      return json(calls === 1 ? {...french, availableLangs: ['fr', advertised]} : {...english, lang: advertised});
    }});
    assert.equal(calls, 2); assert.equal(reservations, 1); assert.equal(result.transcript.language, advertised);
  }
});

test('without advertised English the first available native text is retained without reservation', async () => {
  for (const availableLangs of [[], ['fr'], ['fr', 'de'], undefined, 'en', [null, {}, 'french'], ['english']]) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => {reservations++; return true;}, fetch: async () => {
      calls++; return json({...french, availableLangs});
    }});
    assert.equal(calls, 1); assert.equal(reservations, 0); assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
  }
});

test('a denied, absent, non-boolean or failed reservation preserves the first text with no second call', async () => {
  const callbacks = [undefined, async () => false, async () => undefined, async () => null, async () => 1, async () => 'true', async () => ({}), async () => {throw new Error(KEY);}];
  for (const reserveFallback of callbacks) {
    let calls = 0;
    const result = await requestTranscript(VIDEO, {env, reserveFallback, fetch: async () => {calls++; return json(french);}});
    assert.equal(calls, 1); assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
  }
});

test('fallback HTTP, network, malformed and empty results preserve the original native text', async () => {
  const failures = [
    ...[206, 401, 402, 403, 404, 429, 503].map(status => async () => json({error: KEY}, status)),
    async () => {throw new Error(KEY);},
    async () => new Response(KEY, {headers: {'Content-Type': 'application/json'}}),
    async () => json({...english, content: ''}),
    async () => json({...english, content: 'bad\u0000text'}),
    async () => json({jobId: '../invalid'}, 202)
  ];
  for (const failedFetch of failures) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => {reservations++; return true;}, fetch: async () => {
      calls++; return calls === 1 ? json(french) : failedFetch();
    }});
    assert.equal(calls, 2); assert.equal(reservations, 1); assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
  }
});

test('an unexpected nonpreferred English-request result retains the first candidate and stops at two paid calls', async () => {
  let calls = 0, reservations = 0;
  const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => {reservations++; return true;}, fetch: async () => {
    calls++; return json(calls === 1 ? french : {content: 'Anderer Originaltext', lang: 'de', availableLangs: ['de', 'en', 'ko']});
  }});
  assert.equal(calls, 2); assert.equal(reservations, 1); assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
});

test('an English fallback job carries its requested language without duplicating the transcript', async () => {
  let calls = 0;
  const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => true, fetch: async () => {
    calls++; return calls === 1 ? json(french) : json({jobId: JOB}, 202);
  }});
  assert.equal(calls, 2);
  assert.deepEqual(result, {status: 'pending', jobId: JOB, requestedLanguage: 'en'});
});

test('pending English polls preserve language state and never reserve or start another paid request', async () => {
  for (const status of ['queued', 'active']) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage: 'en',
      reserveFallback: async () => {reservations++; return true;},
      fetch: async url => {calls++; assert.equal(url, 'https://api.supadata.ai/v1/transcript/' + JOB); return json({status});}
    });
    assert.equal(calls, 1); assert.equal(reservations, 0);
    assert.deepEqual(result, {status: 'pending', jobId: JOB, requestedLanguage: 'en'});
  }
});

test('a completed Korean-preference job may reserve the one English fallback with the persisted state', async () => {
  let calls = 0, reservations = 0;
  const result = await requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage: 'ko',
    reserveFallback: async () => {reservations++; return true;}, fetch: async url => {
      calls++;
      if (calls === 1) {assert.equal(url, 'https://api.supadata.ai/v1/transcript/' + JOB); return json({status: 'completed', ...french});}
      assert.equal(new URL(url).searchParams.get('lang'), 'en'); return json(english);
    }
  });
  assert.equal(calls, 2); assert.equal(reservations, 1); assert.deepEqual(result, {status: 'ready', transcript: englishTranscript});
});

test('completed English jobs preserve the available native language and never attempt a third paid call', async () => {
  for (const content of [english, {content: 'Disponible en français', lang: 'fr', availableLangs: ['en', 'ko', 'fr']}]) {
    let calls = 0, reservations = 0;
    const result = await requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage: 'en',
      reserveFallback: async () => {reservations++; return true;}, fetch: async () => {calls++; return json({status: 'completed', ...content});}
    });
    assert.equal(calls, 1); assert.equal(reservations, 0);
    assert.deepEqual(result, {status: 'ready', transcript: {text: content.content, language: content.lang, source: 'youtube_captions'}});
  }
});

test('failed English jobs and expired lookups retain safe errors without starting another paid call', async () => {
  for (const [failedFetch, code] of [[async () => json({status: 'failed', error: {error: 'transcript-unavailable', message: KEY}}), 'transcript_unavailable'], [async () => json({message: KEY}, 404), 'temporary_error'], [async () => {throw new Error(KEY);}, 'temporary_error']]) {
    let calls = 0, reservations = 0;
    await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage: 'en',
      reserveFallback: async () => {reservations++; return true;}, fetch: async () => {calls++; return failedFetch();}
    }), code);
    assert.equal(calls, 1); assert.equal(reservations, 0);
  }
});

test('invalid persisted requested languages are rejected before any external request', async () => {
  let calls = 0;
  for (const requestedLanguage of ['', 'fr', 'en&mode=generate', 'ko-KR', 1, {}]) {
    await rejectCode(requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage, fetch: async () => {calls++; return json({status: 'completed', ...native});}}), 'temporary_error');
  }
  assert.equal(calls, 0);
});

test('fallback bodies remain stream-bounded and an oversized fallback cannot replace the valid candidate', async () => {
  let calls = 0, reads = 0, cancelled = false;
  const result = await requestTranscript(VIDEO, {env, reserveFallback: async () => true, fetch: async () => {
    calls++;
    if (calls === 1) return json(french);
    return {status: 200, headers: new Headers({'content-type': 'application/json'}), body: {getReader() {return {
      async read() {reads++; return {done: false, value: new Uint8Array(1024 * 1024)};}, cancel() {cancelled = true;}, releaseLock() {}
    };}}};
  }});
  assert.equal(calls, 2); assert.equal(reads, 3); assert.equal(cancelled, true); assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
});

test('the shared request deadline also bounds a stalled reservation before the second request', async () => {
  let calls = 0, reservations = 0, signal;
  await rejectCode(requestTranscript(VIDEO, {env, timeoutMs: 10,
    reserveFallback: async () => {reservations++; return new Promise(() => {});},
    fetch: async (_, request) => {calls++; signal = request.signal; return json(french);}
  }), 'temporary_error');
  assert.equal(calls, 1); assert.equal(reservations, 1); assert.equal(signal.aborted, true);
});

test('the second request shares the original deadline and abort signal', async () => {
  let calls = 0; const signals = [];
  await rejectCode(requestTranscript(VIDEO, {env, timeoutMs: 10, reserveFallback: async () => true, fetch: async (_, request) => {
    calls++; signals.push(request.signal); return calls === 1 ? json(french) : new Promise(() => {});
  }}), 'temporary_error');
  assert.equal(calls, 2); assert.equal(signals[0], signals[1]); assert.equal(signals[1].aborted, true);
});

test('caller abort during reservation rejects safely without spending a second request', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = requestTranscript(VIDEO, {env, signal: controller.signal,
    reserveFallback: async () => {controller.abort(new Error(KEY)); return true;},
    fetch: async () => {calls++; return json(french);}
  });
  await rejectCode(promise, 'temporary_error'); assert.equal(calls, 1);
});

test('caller abort during the English request rejects instead of caching a partial result', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = requestTranscript(VIDEO, {env, signal: controller.signal, reserveFallback: async () => true, fetch: async () => {
    calls++; if (calls === 1) return json(french);
    controller.abort(new Error(KEY)); return new Promise(() => {});
  }});
  await rejectCode(promise, 'temporary_error'); assert.equal(calls, 2);
});

test('Korean 206 or empty native captions permit one reserved English request without available languages', async () => {
  for (const absent of [() => json({error: 'transcript-unavailable'}, 206),
    () => json({content: '', lang: 'ko'}), () => json({content: ' \n\t ', lang: 'ko'}), () => json({content: [], lang: 'ko'})]) {
    const order = [];
    let calls = 0;
    const result = await requestTranscript(VIDEO, {env,
      reserveFallback: async () => {order.push('reserved'); return true;},
      fetch: async url => {
        calls++; const target = new URL(url);
        assert.equal(target.searchParams.get('mode'), 'native');
        assert.equal(target.searchParams.get('text'), 'true');
        order.push(target.searchParams.get('lang'));
        return calls === 1 ? absent() : json(english);
      }
    });
    assert.deepEqual(order, ['ko', 'reserved', 'en']);
    assert.equal(calls, 2);
    assert.deepEqual(result, {status: 'ready', transcript: englishTranscript});
  }
});

test('a Korean native job reporting absent captions may switch to one persisted English job', async () => {
  let calls = 0, reservations = 0;
  const englishJob = 'english-job';
  const result = await requestTranscript(VIDEO, {env, jobId: JOB, requestedLanguage: 'ko',
    reserveFallback: async () => {reservations++; return true;},
    fetch: async url => {
      calls++;
      if (calls === 1) {assert.equal(url, 'https://api.supadata.ai/v1/transcript/' + JOB); return json({status: 'failed', error: {error: 'transcript-unavailable'}});}
      assert.equal(new URL(url).searchParams.get('lang'), 'en');
      return json({jobId: englishJob}, 202);
    }
  });
  assert.equal(calls, 2); assert.equal(reservations, 1);
  assert.deepEqual(result, {status: 'pending', jobId: englishJob, requestedLanguage: 'en'});
});

test('missing or denied fallback reservation preserves the original unavailable error without a paid retry', async () => {
  for (const reserveFallback of [undefined, async () => false, async () => null, async () => 'true', async () => {throw new Error(KEY); }]) {
    let calls = 0;
    await rejectCode(requestTranscript(VIDEO, {env, reserveFallback, fetch: async () => {calls++; return json({}, 206);}}), 'transcript_unavailable');
    assert.equal(calls, 1);
  }
});

test('other initial failures never reserve or start an English request', async () => {
  for (const [status, code] of [[401, 'not_configured'], [403, 'video_unavailable'], [404, 'video_unavailable'], [429, 'rate_limited'], [503, 'temporary_error']]) {
    let calls = 0, reservations = 0;
    await rejectCode(requestTranscript(VIDEO, {env,
      reserveFallback: async () => {reservations++; return true;},
      fetch: async () => {calls++; return json({error: KEY}, status);}
    }), code);
    assert.equal(calls, 1); assert.equal(reservations, 0);
  }
});

test('an absent Korean result followed by absent or failed English never makes a third attempt', async () => {
  for (const [status, code] of [[206, 'transcript_unavailable'], [429, 'rate_limited'], [503, 'temporary_error']]) {
    let calls = 0, reservations = 0;
    await rejectCode(requestTranscript(VIDEO, {env,
      reserveFallback: async () => {reservations++; return true;},
      fetch: async () => {calls++; return json({}, calls === 1 ? 206 : status);}
    }), code);
    assert.equal(calls, 2); assert.equal(reservations, 1);
  }
  let calls = 0, reservations = 0;
  const result = await requestTranscript(VIDEO, {env,
    reserveFallback: async () => {reservations++; return true;},
    fetch: async () => {calls++; return calls === 1 ? json({}, 206) : json(french);}
  });
  assert.equal(calls, 2); assert.equal(reservations, 1);
  assert.deepEqual(result, {status: 'ready', transcript: firstTranscript});
});

test('an English-stage unavailable result never reserves another request', async () => {
  for (const jobId of [undefined, JOB]) {
    let calls = 0, reservations = 0;
    await rejectCode(requestTranscript(VIDEO, {env, jobId, requestedLanguage: 'en',
      reserveFallback: async () => {reservations++; return true;},
      fetch: async () => {calls++; return json({}, 206);}
    }), 'transcript_unavailable');
    assert.equal(calls, 1); assert.equal(reservations, 0);
  }
});

test('unavailable-caption fallback keeps the same deadline across reservation and its English fetch', async () => {
  let calls = 0, signal;
  await rejectCode(requestTranscript(VIDEO, {env, timeoutMs: 10,
    reserveFallback: async () => true,
    fetch: async (_, options) => {calls++; signal = options.signal; return calls === 1 ? json({}, 206) : new Promise(() => {});}
  }), 'temporary_error');
  assert.equal(calls, 2); assert.equal(signal.aborted, true);
});
