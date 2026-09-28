'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/book-search.js');
const { plain, plainLines, imageUrl, isbn, isbn13, yes24ProductId, yes24Items, yes24Url, kakaoItems, googleItems, openLibraryItems,
  yes24Genres, genreNames, lookupGenres, fetchJson, searchBooks, lookupBooks, requestOptions, cacheKey, cache, requests } = handler._test;
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
  const req = { method: 'GET', query: { q: '테스트책' }, headers: { 'x-forwarded-for': 'qa-test' } };
  cache.set(cacheKey(requestOptions(req)), { until: Date.now() + 60000, result: { items: [{ title: '테스트책' }], source: 'yes24' } });
  for (let i = 0; i < 30; i += 1) { const res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200); }
  const limited = resMock(); await handler(req, limited); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['Retry-After'], '60');
  cache.clear(); requests.clear();
});

const yes24Book = { itemId: 12345678, title: '<b>한국 신간</b>', author: '작가', publisher: '출판사', publishDate: '2026-09-28',
  isbn13: '9788966260959', pages: 584, cover: 'https://image.yes24.com/goods/12345678/L',
  link: 'https://evil.example/not-the-book', contentDetail: { bookIntroduction: '<p>새로운 책 소개</p>', tableOfContents: '<p>1장 시작</p><p>2장 도전<br>첫 번째 실천</p>' } };
const yes24Data = (items = [yes24Book], totalCount = 20) => ({ success: true, data: { items, currentPage: 1, pageSize: 12, totalCount } });
const options = (overrides = {}) => ({ mode: 'search', scope: 'domestic', sort: 'relevance', page: 1, query: '한국 신간', ...overrides });

test('YES24 metadata includes nullable pages, plain description and multiline contents with canonical attribution', () => {
  const [book] = yes24Items(yes24Data());
  assert.equal(book.source, 'yes24'); assert.equal(book.title, '한국 신간'); assert.equal(book.id, '12345678');
  assert.deepEqual(book.authors, ['작가']); assert.equal(book.pageCount, 584); assert.equal(book.publishedDate, '2026-09-28');
  assert.equal(book.description, '새로운 책 소개'); assert.equal(book.tableOfContents, '1장 시작\n2장 도전\n첫 번째 실천');
  assert.equal(book.sourceUrl, 'https://www.yes24.com/product/goods/12345678');
  assert.equal('link' in book, false);
  assert.equal(yes24Items(yes24Data([{ ...yes24Book, pages: null }]))[0].pageCount, null);
  assert.deepEqual(yes24Items(yes24Data([null, {}, { ...yes24Book, itemId: '../secret' }])), []);
  assert.equal(plainLines('a'.repeat(21000)).length, 20000);
  assert.equal(plain('&lt;img src=x onerror=alert(1)&gt; 안전'), '안전');
  assert.equal(plainLines('<script>token</script>목차\n둘째'), '목차\n둘째');
});

test('YES24 cover images allow only the canonical goods image endpoint', () => {
  assert.equal(imageUrl('http://image.yes24.com/goods/12345678/L', 'yes24'), yes24Book.cover);
  assert.equal(imageUrl('https://image.yes24.com/goods/12345678/L?tracking=private#ref', 'yes24'), yes24Book.cover);
  for (const url of ['https://image.yes24.com.evil.example/goods/1/L', 'https://evil.image.yes24.com/goods/1/L',
    'https://image.yes24.com/track?secret=1', 'https://image.yes24.com/goods/0/L', 'https://www.yes24.com/goods/1/L']) assert.equal(imageUrl(url, 'yes24'), '');
});

test('YES24 URL registration accepts only desktop/mobile product IDs, never arbitrary fetching targets', () => {
  assert.equal(yes24ProductId('https://www.yes24.com/Product/Goods/12345678?pid=123#detail'), '12345678');
  assert.equal(yes24ProductId('https://m.yes24.com/Goods/Detail/12345678'), '12345678');
  for (const value of ['https://www.yes24.com.evil.example/product/goods/123', 'https://www.yes24.com@evil.example/product/goods/123',
    'https://evil.example@www.yes24.com/product/goods/123', 'https://www.yes24.com:8443/product/goods/123',
    'http://127.0.0.1/product/goods/123', '//www.yes24.com/product/goods/123', 'file:///product/goods/123',
    'https://www.yes24.com/search?q=123', 'https://www.yes24.com/product/goods/123/other',
    'https://www.yes24.com\\@evil.example/product/goods/123', 'https://www.yes24.com/product/goods/%31%32%33',
    'https://www.yes24.com/product/goods/0', 'https://www.yes24.com/product/goods/123\n']) assert.equal(yes24ProductId(value), '', value);
});

test('YES24 ISBN13 registration validates its checksum and supports printed separators', () => {
  assert.equal(isbn13('978-89-6626-095-9'), '9788966260959');
  assert.equal(isbn13('978 89 6626 095 9'), '9788966260959');
  for (const value of ['9788966260958', 'abcdefghijklm', '8966260950', '1111111111111', '9788966260959<script>']) assert.equal(isbn13(value), '');
  assert.match(requestOptions({ query: { mode: 'link', q: '9788966260958' } }).error, /ISBN/);
});

test('request options default to domestic and validate mode, scope, sort, page and duplicate inputs', () => {
  assert.deepEqual(requestOptions({ query: { q: '한국 책' } }), options({ query: '한국 책' }));
  assert.deepEqual(requestOptions({ url: '/api/book-search?mode=new&page=2' }), options({ mode: 'new', page: 2, query: '' }));
  for (const query of [{ mode: 'secret', q: '책책' }, { scope: 'ALL', q: '책책' }, { sort: 'SQL', q: '책책' },
    { q: '책책', page: '0' }, { q: '책책', page: '51' }, { q: '책책', page: '1.2' }, { q: '책책', page: '01' },
    { q: '책책', scope: ['domestic', 'foreign'] }, { q: '책\n책' }, { mode: 'new', scope: 'foreign' }, { mode: 'new', q: '책책' }]) assert.ok(requestOptions({ query }).error, JSON.stringify(query));
  assert.ok(requestOptions({ url: '/api/book-search?q=one&q=two' }).error);
  assert.ok(requestOptions({ query: { mode: 'link', q: `https://www.yes24.com/product/goods/123?x=${'a'.repeat(2000)}` } }).error);
});

test('domestic, new-book and explicit link lookup never substitute foreign results when YES24 is not configured', async () => {
  for (const params of [options(), options({ mode: 'new', query: '' }), options({ mode: 'link', query: yes24Book.link }), options({ scope: 'foreign', query: '9788966260959' })]) {
    const result = await lookupBooks(params, { env: {}, fetcher: () => assert.fail('No fallback request should be made') });
    assert.equal(result.code, 'YES24_NOT_CONFIGURED'); assert.match(result.error, /직접 등록/); assert.deepEqual(result.items, []);
  }
});

test('unconfigured explicit foreign text search retains paged foreign providers without using a domestic fallback', async () => {
  const result = await lookupBooks(options({ query: 'Little Prince', scope: 'foreign', page: 3, sort: 'recent' }), {
    env: { KAKAO_REST_API_KEY: 'should-not-be-used' }, fetcher: async (input, init) => {
      const url = new URL(input); assert.equal(url.hostname, 'www.googleapis.com');
      assert.equal(url.searchParams.get('startIndex'), '24'); assert.equal(url.searchParams.get('orderBy'), 'newest');
      assert.equal(init.headers.Authorization, undefined);
      return response({ items: [{ id: 'little-prince', volumeInfo: { title: 'Little Prince' } }] });
    }
  });
  assert.equal(result.source, 'google'); assert.equal(result.page, 3); assert.equal(result.hasMore, false);
});

test('domestic search authenticates only to the fixed YES24 API and requests full newest metadata with paging', async () => {
  const key = 'server-only-test-key'; const query = '새 책 & category=ALL';
  const result = await lookupBooks(options({ query, sort: 'recent', page: 2 }), { env: { YES24_API_KEY: key }, fetcher: async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, 'https://apis.yes24.com'); assert.equal(url.pathname, '/v1/goods/itemList');
    assert.equal(url.searchParams.get('query'), query); assert.equal(url.searchParams.get('category'), 'BOOK');
    assert.equal(url.searchParams.get('sort'), 'RECENT'); assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('pageSize'), '12'); assert.equal(url.searchParams.get('detail'), 'Y');
    assert.equal(init.headers['X-Api-Key'], key); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(url.href.includes(key), false); return response(yes24Data([yes24Book], 25));
  } });
  assert.equal(result.source, 'yes24'); assert.equal(result.page, 2); assert.equal(result.hasMore, true); assert.equal(result.total, 25);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('explicit foreign search uses the documented YES24 FOREIGN category', () => {
  const url = yes24Url(options({ scope: 'foreign' }));
  assert.equal(url.searchParams.get('category'), 'FOREIGN'); assert.equal(url.searchParams.get('sort'), 'RELATION');
});

test('new books use the verified domestic category and registration-date order, never a stale search term', async () => {
  const result = await lookupBooks(options({ mode: 'new', query: '', page: 3 }), { env: { YES24_API_KEY: 'test' }, fetcher: async input => {
    const url = new URL(input); assert.equal(url.pathname, '/v1/category/newproduct');
    assert.equal(url.searchParams.get('categoryId'), '001'); assert.equal(url.searchParams.get('sort'), 'RegDate');
    assert.equal(url.searchParams.has('query'), false); assert.equal(url.searchParams.get('page'), '3');
    return response(yes24Data([yes24Book], 36));
  } });
  assert.equal(result.hasMore, false);
});

test('URL and ISBN lookups call only itemDetail and do not follow the submitted URL or query parameters', async () => {
  for (const params of [options({ mode: 'link', query: 'https://m.yes24.com/Goods/Detail/12345678?redirect=https://evil.example' }),
    options({ mode: 'link', query: '978-89-6626-095-9' }), options({ query: '9788966260959' })]) {
    const result = await lookupBooks(params, { env: { YES24_API_KEY: 'test' }, fetcher: async input => {
      const url = new URL(input); assert.equal(url.origin, 'https://apis.yes24.com'); assert.equal(url.pathname, '/v1/goods/itemDetail');
      assert.equal(url.searchParams.get('query'), params.query.startsWith('http') ? '12345678' : '9788966260959');
      assert.equal(url.searchParams.get('searchType'), params.query.startsWith('http') ? 'ItemId' : 'ISBN13');
      assert.equal(url.searchParams.has('redirect'), false); assert.equal(url.searchParams.get('detail'), 'Y');
      return response(yes24Data([yes24Book], 100));
    } });
    assert.equal(result.hasMore, false); assert.equal(result.items.length, 1);
  }
});

test('documented no-result errors are empty results, while authentication, malformed and service errors stay errors', async () => {
  for (const code of ['SEARCH_001', 'GOODS_001', 'GOODS_002', 'NEW_001']) {
    const result = await lookupBooks(options(), { env: { YES24_API_KEY: 'test' }, fetcher: async () => response({ success: false, errorCode: code }, 404) });
    assert.equal(result.error, undefined); assert.equal(result.total, 0); assert.deepEqual(result.items, []);
  }
  for (const [body, status] of [[{ success: false, errorCode: 'AUTH_002', message: 'sensitive-token' }, 401],
    [{ success: false, errorCode: 'SEARCH_002', message: 'sensitive-token' }, 404], [{ success: true, data: null }, 200],
    [{ success: false, errorCode: 'AUTH_002', message: 'sensitive-token' }, 200], [{ success: false }, 503]]) {
    const result = await lookupBooks(options(), { env: { YES24_API_KEY: 'test' }, fetcher: async () => response(body, status) });
    assert.equal(result.code, 'YES24_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('sensitive-token'), false);
  }
});

test('lookup cache keys isolate source configuration, mode, scope, sort, page and query', () => {
  const keys = [options(), options({ scope: 'foreign' }), options({ sort: 'recent' }), options({ page: 2 }),
    options({ query: '다른 책' }), options({ mode: 'new', query: '' }), options({ mode: 'link', query: 'https://www.yes24.com/product/goods/123' })]
    .map(value => cacheKey(value, true));
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(cacheKey(options(), true), cacheKey(options(), false));
  assert.notEqual(cacheKey(options({ mode: 'link', query: '9788966260959' })), cacheKey(options({ mode: 'link', query: 'https://www.yes24.com/product/goods/9788966260959' })));
});

test('unknown total retains next-page browsing for a full page and caps browsing at page 50', async () => {
  const fixture = yes24Data(Array.from({ length: 12 }, (_, index) => ({ ...yes24Book, itemId: index + 1 })), null);
  for (const page of [1, 50]) {
    const result = await lookupBooks(options({ page }), { env: { YES24_API_KEY: 'test' }, fetcher: async () => response(fixture) });
    assert.equal(result.hasMore, page < 50); assert.equal('total' in result, false);
  }
});

test('handler returns missing configuration as 503 and never caches transient/configuration errors', async () => {
  const savedKey = process.env.YES24_API_KEY, savedFetch = global.fetch;
  cache.clear(); requests.clear(); delete process.env.YES24_API_KEY;
  try {
    const req = { method: 'GET', query: { q: '한국책' }, headers: { 'x-forwarded-for': 'qa-config' } };
    let res = resMock(); await handler(req, res); assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'YES24_NOT_CONFIGURED');
    assert.equal(cache.size, 0);
    process.env.YES24_API_KEY = 'not-a-real-key';
    global.fetch = async () => response({ success: false, errorCode: 'AUTH_002', message: 'do-not-expose' }, 401);
    res = resMock(); await handler(req, res); assert.equal(res.statusCode, 503); assert.equal(cache.size, 0);
    assert.equal(JSON.stringify(res.body).includes('do-not-expose'), false);
    global.fetch = async () => response(yes24Data());
    res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200); assert.equal(cache.size, 1);
    global.fetch = () => assert.fail('Confirmed results should be cached');
    res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200);
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.YES24_API_KEY; else process.env.YES24_API_KEY = savedKey;
    cache.clear(); requests.clear();
  }
});

// Reduced fixture from the public product's verified infoset_goodsCate structure.
const categoryLink = (name, id = '001001019') => `<a href="/product/category/display/${id}">${name}</a>`;
const categoryRow = (name = '인문', id = '001001019') => `<li><a href="https://www.yes24.com/Main/Book.aspx?CategoryNumber=001">국내도서</a>${categoryLink(name, id)}${categoryLink('심리', id + '004')}${categoryLink('쉽게 읽는 심리학', id + '004008001')}</li>`;
const genrePage = (rows = categoryRow()) => `<nav>${categoryLink('경제경영', '001001025')}</nav>
<div id="infoset_goodsCate" class="gd_infoSet infoSet_txtCont">
 <div class="tm_infoSet"><h4>관련분류</h4></div><div class="infoSetCont_wrap">
 <dl class="yesAlertDl"><dt>카테고리 분류</dt><dd><ul>${rows}</ul></dd></dl>
 <dl><dt>수상내역 및 미디어 추천 분류</dt><dd><ul><li>${categoryLink('세종도서', '001005011')}</li></ul></dd></dl>
 </div><script>doNotRun()</script></div><div id="recommendations">${categoryLink('소설', '001001046')}</div>`;

test('YES24 genre extraction uses only the category taxonomy, first broad category per path', () => {
  assert.deepEqual(yes24Genres(genrePage()), ['인문']);
  assert.deepEqual(yes24Genres(genrePage(categoryRow() + categoryRow() + categoryRow('사회 정치', '001001022'))), ['인문', '사회 정치']);
  assert.deepEqual(yes24Genres('<script>' + genrePage() + '</script>' + genrePage()), ['인문']);
  assert.deepEqual(yes24Genres('<!--' + genrePage() + '-->'), []);
  assert.deepEqual(yes24Genres(genrePage().replace('카테고리 분류', '책 제목')) , []);
  assert.deepEqual(yes24Genres(genrePage().replace('id="infoset_goodsCate"', 'data-id="infoset_goodsCate"')), []);
  assert.deepEqual(yes24Genres('<h1>소설 심리 자기계발</h1><nav>' + categoryLink('소설') + '</nav>'), []);
});

test('genre taxonomy rejects spoofed links, malformed section boundaries and oversized markup', () => {
  const links = ['https://www.yes24.com.evil.example/product/category/display/001001019',
    'https://evil.example@www.yes24.com/product/category/display/001001019',
    '//evil.example/product/category/display/001001019', '/product/goods/123', 'javascript:alert(1)'];
  for (const href of links) assert.deepEqual(yes24Genres(genrePage(`<li><a href="${href}">가짜분류</a></li>`)), []);
  assert.deepEqual(yes24Genres(genrePage().replace('</div><script>', '<script>')), []);
  assert.deepEqual(yes24Genres('a'.repeat(2 * 1024 * 1024 + 1)), []);
  assert.deepEqual(genreNames(['<b>인문</b>', '인문', '', null, '심리']), ['인문', '심리']);
  assert.equal(genreNames(Array.from({ length: 20 }, (_, i) => '분류' + i)).length, 8);
});

test('genre requests validate YES24 URLs and isolate their cache from book lookup', () => {
  const request = { query: { mode: 'genres', q: 'https://m.yes24.com/Goods/Detail/167543321?pid=123' } };
  assert.equal(requestOptions(request).mode, 'genres');
  for (const q of ['9788966260959', 'https://localhost/product/goods/123', 'https://www.yes24.com.evil.example/product/goods/123']) assert.ok(requestOptions({ query: { mode: 'genres', q } }).error);
  assert.ok(requestOptions({ query: { ...request.query, page: '2' } }).error);
  assert.notEqual(cacheKey(requestOptions(request)), cacheKey(requestOptions({ query: { ...request.query, mode: 'link' } })));
  assert.equal(cacheKey(requestOptions(request)), cacheKey(requestOptions({ query: { mode: 'genres', q: 'https://www.yes24.com/product/goods/167543321' } })));
});

test('selected YES24 book genre lookup uses one fixed public-page request without API credentials or tracking', async () => {
  let count = 0;
  const result = await lookupBooks(options({ mode: 'genres', query: 'https://m.yes24.com/Goods/Detail/167543321?redirect=https://evil.example' }), {
    env: { YES24_API_KEY: 'must-not-be-sent' }, fetcher: async (url, init) => {
      count++; assert.equal(String(url), 'https://www.yes24.com/product/goods/167543321');
      assert.equal(init.headers['X-Api-Key'], undefined); assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
      return new Response(genrePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });
  assert.equal(count, 1); assert.deepEqual(result, { genres: ['인문'], source: 'yes24', genreSource: 'yes24', id: '167543321' });
});

test('unavailable or structurally changed genres return no guessed categories and safe manual-entry guidance', async () => {
  for (const mocked of [new Response('sensitive-body', { status: 403 }), new Response('<h1>소설</h1>', { headers: { 'content-type': 'text/html' } }),
    new Response(genrePage(), { headers: { 'content-type': 'application/json' } }),
    new Response(genrePage(), { headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) } }),
    new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } })]) {
    const result = await lookupGenres(options({ query: 'https://www.yes24.com/product/goods/123' }), { fetcher: async () => mocked });
    assert.deepEqual(result.genres, []); assert.equal(result.code, 'GENRE_UNAVAILABLE'); assert.match(result.error, /직접 입력/);
    assert.equal(JSON.stringify(result).includes('sensitive-body'), false);
  }
});

test('Google search genres come only from documented categories and never the title', () => {
  const [withGenres, withoutGenres] = googleItems({ items: [
    { id: 'a', volumeInfo: { title: '책', categories: ['Psychology', 'Psychology', 'Self-Help'] } },
    { id: 'b', volumeInfo: { title: 'Psychology and Science' } }
  ] });
  assert.deepEqual(withGenres.genres, ['Psychology', 'Self-Help']); assert.equal(withGenres.genreSource, 'google');
  assert.deepEqual(withoutGenres.genres, []); assert.equal(withoutGenres.genreSource, '');
  assert.deepEqual(yes24Items(yes24Data([{ ...yes24Book, goodsType: '국내도서', goodsSortNm: '국내도서' }]))[0].genres, []);
});

test('genre handler caches confirmed categories but never errors', async () => {
  const savedFetch = global.fetch; cache.clear(); requests.clear();
  const req = { method: 'GET', query: { mode: 'genres', q: 'https://www.yes24.com/product/goods/167543321' }, headers: { 'x-forwarded-for': 'qa-genre' } };
  try {
    global.fetch = async () => new Response('missing', { headers: { 'content-type': 'text/html' } });
    let res = resMock(); await handler(req, res); assert.equal(res.statusCode, 503); assert.equal(cache.size, 0);
    global.fetch = async () => new Response(genrePage(), { headers: { 'content-type': 'text/html' } });
    res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200); assert.deepEqual(res.body.genres, ['인문']); assert.equal(cache.size, 1);
    global.fetch = () => assert.fail('Cached genre should not fetch again');
    res = resMock(); await handler(req, res); assert.equal(res.statusCode, 200);
  } finally { global.fetch = savedFetch; cache.clear(); requests.clear(); }
});
