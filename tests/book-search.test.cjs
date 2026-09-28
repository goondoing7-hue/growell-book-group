'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/book-search.js');
const { plain, imageUrl, isbn, kakaoItems, googleItems, openLibraryItems, fetchJson, searchBooks, cache, requests } = handler._test;
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const resMock = () => ({ headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

test('metadata is plain, bounded text and malformed entities do not throw', () => {
  assert.equal(plain('<b>책</b> &amp; &#x1F525; &#999999999;'), '책 & 🔥');
  assert.equal(plain('a'.repeat(700)).length, 500);
  assert.equal(plain({ secret: true }), '');
  assert.equal(isbn('8936433598 9788936433598'), '9788936433598');
});

test('cover URLs accept only expected image hosts and upgrade HTTP', () => {
  assert.match(imageUrl('http://books.google.com/books/content?id=test', 'google'), /^https:/);
  assert.match(imageUrl('https://search1.kakaocdn.net/thumb/image', 'kakao'), /^https:/);
  for (const url of ['javascript:alert(1)', 'https://evil.example/cover', 'https://books.google.com.evil.example/x', 'https://password@books.google.com/x', 'https://books.google.com:444/x']) assert.equal(imageUrl(url, 'google'), '');
});

test('Kakao result maps cover and description without leaking raw fields', () => {
  const [book] = kakaoItems({ documents: [{ title: '<b>좋은 책</b>', authors: ['저자'], contents: '책 소개', isbn: '8936433598 9788936433598', thumbnail: 'https://search1.kakaocdn.net/cover', datetime: '2026-09-28T00:00:00.000+09:00', price: 9999, publisher: '출판사' }] });
  assert.deepEqual({ title: book.title, description: book.description, authors: book.authors, isbn: book.isbn, publishedDate: book.publishedDate, pageCount: book.pageCount }, { title: '좋은 책', description: '책 소개', authors: ['저자'], isbn: '9788936433598', publishedDate: '2026-09-28', pageCount: null });
  assert.equal('price' in book, false);
});

test('Google result preserves bibliographic fields with safe missing values', () => {
  const [book] = googleItems({ items: [{ id: 'book123', volumeInfo: { title: '책', authors: ['글쓴이'], description: '<p>소개</p>', imageLinks: { thumbnail: 'http://books.google.com/books/content?id=book123' }, industryIdentifiers: [{ type: 'ISBN_13', identifier: '9788936433598' }], pageCount: 364 } }] });
  assert.equal(book.description, '소개'); assert.equal(book.pageCount, 364); assert.equal(book.isbn, '9788936433598');
  assert.equal(book.publisher, ''); assert.match(book.thumbnail, /^https:/);
  assert.deepEqual(googleItems({ items: [{ id: 'bad', volumeInfo: {} }] }), []);
});

test('Open Library uses the matching edition, not mixed work-level editions', () => {
  const [book] = openLibraryItems({ docs: [{ key: '/works/OL17334243W', title: 'The Vegetarian', author_name: ['Han Kang'], cover_i: 7412625, isbn: ['9780553448191'], editions: { docs: [{ key: '/books/OL23965279M', title: '채식주의자', isbn: ['9788936433598'], publisher: ['창비'], publish_date: ['2007'], language: ['kor'] }] } }] });
  assert.equal(book.title, '채식주의자'); assert.equal(book.isbn, '9788936433598'); assert.equal(book.publisher, '창비');
  assert.match(book.thumbnail, /OL23965279M-M\.jpg/); assert.equal(book.description, '');
  assert.deepEqual(openLibraryItems({ docs: [{ key: '//evil.example/x', title: 'bad' }] }), []);
});

test('configured Kakao search is server-authenticated and stops on valid results', async () => {
  const calls = [];
  const result = await searchBooks('감정', { env: { KAKAO_REST_API_KEY: 'not-a-real-secret' }, fetcher: async (url, options) => { calls.push({ url: String(url), options }); return response({ documents: [{ title: '감정', contents: '소개' }] }); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.Authorization, 'KakaoAK not-a-real-secret');
  assert.match(calls[0].url, /^https:\/\/dapi.kakao.com\/v3\/search\/book/);
  assert.equal(result.source, 'kakao'); assert.equal(JSON.stringify(result).includes('not-a-real-secret'), false);
});

test('Google quota failure falls back to Open Library', async () => {
  const calls = [];
  const result = await searchBooks('채식주의자', { env: {}, fetcher: async (url) => {
    calls.push(String(url));
    return String(url).includes('googleapis.com') ? response({ error: 'quota' }, 429) : response({ docs: [{ key: '/works/OL123W', title: '채식주의자' }] });
  } });
  assert.equal(calls.length, 2); assert.equal(result.source, 'openlibrary'); assert.equal(result.items.length, 1);
  assert.match(calls[1], /lang=ko/);
});

test('empty successful search differs from all providers failing', async () => {
  const empty = await searchBooks('없는책', { env: {}, fetcher: async () => response({ items: [], docs: [] }) });
  assert.deepEqual(empty, { items: [], source: 'none' });
  const unavailable = await searchBooks('없는책', { env: {}, fetcher: async () => { throw new Error('secret-provider-detail'); } });
  assert.equal(unavailable.items.length, 0); assert.match(unavailable.error, /직접 등록/); assert.equal(JSON.stringify(unavailable).includes('secret-provider-detail'), false);
});

test('upstream requests reject redirects and use a bounded abort signal', async () => {
  await fetchJson(async (_url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return response({ valid: true });
  }, new URL('https://openlibrary.org/search.json'));
  await assert.rejects(fetchJson(async () => response({ a: 1 }, 200, { 'content-length': '2097152' }), new URL('https://openlibrary.org/search.json')));
  await assert.rejects(fetchJson(async () => new Response('x'.repeat(1024 * 1024 + 1)), new URL('https://openlibrary.org/search.json')));
});

test('method and query validation do not call providers', async () => {
  for (const request of [{ method: 'POST', url: '/api/book-search?q=test' }, { method: 'GET', url: '/api/book-search?q=a' }, { method: 'GET', query: { q: ['one', 'two'] } }, { method: 'GET', query: { q: 'a'.repeat(121) } }]) {
    const res = resMock(); await handler(request, res);
    assert.equal(res.statusCode, request.method === 'POST' ? 405 : 400); assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('cached results avoid upstream requests and client rate limit stays bounded', async () => {
  cache.clear(); requests.clear();
  cache.set('테스트책', { until: Date.now() + 60000, result: { items: [{ title: '테스트책' }], source: 'google' } });
  const req = { method: 'GET', query: { q: '테스트책' }, headers: { 'x-forwarded-for': 'qa-test' } };
  for (let i = 0; i < 30; i += 1) { const res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200); }
  const limited = resMock(); await handler(req, limited); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['Retry-After'], '60');
  cache.clear(); requests.clear();
});
