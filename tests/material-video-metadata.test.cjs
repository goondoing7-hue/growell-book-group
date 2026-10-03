'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fetchYouTubeTitle, normalizeTitle, MAX_RESPONSE_BYTES, MAX_REQUEST_MS} = require('../server/materialVideoMetadata.cjs');
const ID = 'dQw4w9WgXcQ';
const json = (data, options = {}) => new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}, ...options});

test('YouTube title lookup uses one fixed public oEmbed request without credentials or redirects', async () => {
  let calls = 0;
  const title = await fetchYouTubeTitle(ID, {fetch: async (url, options) => {
    calls++;
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://www.youtube.com/oembed');
    assert.equal(target.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + ID);
    assert.equal(target.searchParams.get('format'), 'json');
    assert.equal(options.method, 'GET');assert.equal(options.redirect, 'error');assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, {Accept: 'application/json'});assert.equal(options.body, undefined);
    return json({title: '실제 영상 제목', html: '<iframe src="ignored"></iframe>', author_name: 'ignored'});
  }});
  assert.equal(title, '실제 영상 제목');assert.equal(calls, 1);assert.equal(MAX_REQUEST_MS, 5000);
});

test('title normalization removes controls and repeated whitespace, preserving literal text and Unicode', () => {
  assert.equal(normalizeTitle('  함께\n 읽는\t시간\u0000  '), '함께 읽는 시간');
  assert.equal(normalizeTitle('<script>alert(1)</script> & 독서'), '<script>alert(1)</script> & 독서');
  assert.equal(normalizeTitle('😀'.repeat(310)), '😀'.repeat(300));
  for (const value of [null, 12, {}, [], ' \n\u0000 ']) assert.equal(normalizeTitle(value), '');
});

test('invalid IDs and pre-aborted requests perform no network work', async () => {
  let calls = 0;const fetch = async () => {calls++;return json({title: 'never'});};
  for (const id of ['', null, '../private', 'https://www.youtube.com/watch?v=' + ID, ID + '?other=1']) assert.equal(await fetchYouTubeTitle(id, {fetch}), '');
  const controller = new AbortController();controller.abort();
  assert.equal(await fetchYouTubeTitle(ID, {fetch, signal: controller.signal}), '');assert.equal(calls, 0);
});

test('network, HTTP, redirect and malformed metadata failures return an empty title without retries', async () => {
  const responses = [
    () => {throw new Error('private upstream details');},
    () => json({title: 'must not use'}, {status: 403}),
    () => json({title: 'must not use'}, {status: 404}),
    () => ({status: 200, redirected: true, body: {cancel() {}}}),
    () => new Response('<html>not JSON</html>', {headers: {'content-type': 'text/html'}}),
    () => new Response('invalid json', {headers: {'content-type': 'application/json'}}),
    () => json({title: {nested: 'invalid'}}),
    () => json([{title: 'invalid'}]),
    () => json({author_name: 'No title'})
  ];
  for (const response of responses) {
    let calls = 0;assert.equal(await fetchYouTubeTitle(ID, {fetch: async () => {calls++;return response();}}), '');assert.equal(calls, 1);
  }
});

test('oversized declared metadata is rejected without reading its body', async () => {
  let read = false, cancelled = false;
  const result = await fetchYouTubeTitle(ID, {fetch: async () => ({status: 200, headers: new Headers({'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1)}),
    body: {getReader() {read = true;throw new Error('not expected');}, cancel() {cancelled = true;}}})});
  assert.equal(result, '');assert.equal(read, false);assert.equal(cancelled, true);
});

test('streamed metadata is capped at 64 KiB even without a Content-Length header', async () => {
  let reads = 0, cancelled = false, released = false;
  const result = await fetchYouTubeTitle(ID, {fetch: async () => ({status: 200, headers: new Headers({'content-type': 'application/json'}),
    body: {getReader() {return {async read() {reads++;return {done: false, value: new Uint8Array(40000)};}, cancel() {cancelled = true;}, releaseLock() {released = true;}};}}})});
  assert.equal(result, '');assert.equal(reads, 2);assert.equal(cancelled, true);assert.equal(released, true);
});

test('the deadline bounds both a stalled fetch and a stalled stream, without blocking captions', async () => {
  let fetchSignal;
  assert.equal(await fetchYouTubeTitle(ID, {timeoutMs: 12, fetch: async (_, options) => {fetchSignal = options.signal;return new Promise(() => {});}}), '');
  assert.equal(fetchSignal.aborted, true);
  let cancelled = false;
  assert.equal(await fetchYouTubeTitle(ID, {timeoutMs: 12, fetch: async () => ({status: 200, headers: new Headers({'content-type': 'application/json'}),
    body: {getReader() {return {read: () => new Promise(() => {}), cancel() {cancelled = true;return new Promise(() => {});}, releaseLock() {}};}}})}), '');
  assert.equal(cancelled, true);
});

test('caller cancellation interrupts title lookup and safely returns no title', async () => {
  const controller = new AbortController();let called;
  const started = new Promise(resolve => called = resolve);
  const result = fetchYouTubeTitle(ID, {signal: controller.signal, fetch: async () => {called();return new Promise(() => {});}});
  await started;controller.abort();assert.equal(await result, '');
});
