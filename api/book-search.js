'use strict';

// Public bibliographic lookup only. API credentials never leave this function.
const MAX_QUERY = 120;
const MAX_LINK = 2000;
const MAX_RESULTS = 12;
const MAX_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const CACHE_LIMIT = 100;
const cache = new Map();
const requests = new Map();

function plain(value, limit = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (code[0] !== '#') return named[code.toLowerCase()] || all;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function imageUrl(value, source) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const allowed = source === 'yes24'
      ? url.hostname === 'image.yes24.com' && /^\/goods\/[1-9]\d{0,14}\/(?:L|M|S|XL)$/i.test(url.pathname)
      : source === 'kakao'
      ? /(^|\.)(kakaocdn\.net|daumcdn\.net)$/i.test(url.hostname)
      : source === 'google'
        ? /^(books\.google\.com|books\.googleusercontent\.com)$/i.test(url.hostname)
        : url.hostname === 'covers.openlibrary.org';
    if (!allowed) return '';
    url.protocol = 'https:';
    if (source === 'yes24') { url.search = ''; url.hash = ''; }
    return url.href.slice(0, 1800);
  } catch { return ''; }
}

function isbn(values) {
  const candidates = (Array.isArray(values) ? values : String(values || '').split(/\s+/))
    .map(value => String(value).replace(/[^\dXx]/g, '').toUpperCase());
  return candidates.find(value => /^\d{13}$/.test(value)) || candidates.find(value => /^\d{9}[\dX]$/.test(value)) || '';
}

function names(value) { return (Array.isArray(value) ? value : []).slice(0, 10).map(item => plain(item, 120)).filter(Boolean); }
function genreNames(value) { return [...new Set((Array.isArray(value) ? value : []).slice(0, 40).map(item => plain(item, 80)).filter(Boolean))].slice(0, 8); }
function pages(value) { const count = Number(value); return Number.isInteger(count) && count > 0 && count <= 100000 ? count : null; }
function plainLines(value, limit = 20000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit * 4).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li)\s*>/gi, '\n').split(/\r?\n/)
    .map(line => plain(line, limit)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function kakaoItems(data) {
  return (Array.isArray(data?.documents) ? data.documents : []).slice(0, MAX_RESULTS).map((book) => {
    const identifier = isbn(book.isbn);
    const title = plain(book.title, 250);
    return { source: 'kakao', id: identifier || title, title, authors: names(book.authors),
      description: plain(book.contents, 6000), publisher: plain(book.publisher, 200), publishedDate: plain(book.datetime, 32).slice(0, 10),
      thumbnail: imageUrl(book.thumbnail, 'kakao'), isbn: identifier, pageCount: null, genres: [], genreSource: '',
      sourceUrl: `https://search.daum.net/search?w=book&q=${encodeURIComponent(identifier || title)}` };
  }).filter(book => book.title);
}

function googleItems(data) {
  return (Array.isArray(data?.items) ? data.items : []).slice(0, MAX_RESULTS).map((item) => {
    const book = item.volumeInfo || {};
    const id = plain(item.id, 100);
    const genres = genreNames(Array.isArray(book.categories) && book.categories.length ? book.categories : [book.mainCategory]);
    return { source: 'google', id, title: plain(book.title, 250), authors: names(book.authors),
      description: plain(book.description, 6000), publisher: plain(book.publisher, 200), publishedDate: plain(book.publishedDate, 32),
      thumbnail: imageUrl(book.imageLinks?.thumbnail || book.imageLinks?.smallThumbnail, 'google'),
      isbn: isbn((Array.isArray(book.industryIdentifiers) ? book.industryIdentifiers : []).filter(row => ['ISBN_13', 'ISBN_10'].includes(row.type)).map(row => row.identifier)),
      pageCount: pages(book.pageCount), genres, genreSource: genres.length ? 'google' : '', sourceUrl: `https://books.google.com/books?id=${encodeURIComponent(id)}` };
  }).filter(book => book.id && book.title);
}

function openLibraryItems(data) {
  return (Array.isArray(data?.docs) ? data.docs : []).slice(0, MAX_RESULTS).map((work) => {
    const edition = Array.isArray(work.editions?.docs) ? work.editions.docs[0] : null;
    const id = /^\/books\/OL\d+M$/.test(edition?.key || '') ? edition.key : /^\/works\/OL\d+W$/.test(work.key || '') ? work.key : '';
    const cover = edition && id.startsWith('/books/') ? `https://covers.openlibrary.org/b/olid/${id.slice(7)}-M.jpg?default=false`
      : Number.isInteger(work.cover_i) && work.cover_i > 0 ? `https://covers.openlibrary.org/b/id/${work.cover_i}-M.jpg?default=false` : '';
    return { source: 'openlibrary', id, title: plain(edition?.title || work.title, 250), authors: names(work.author_name),
      description: '', publisher: plain(edition?.publisher?.[0], 200), publishedDate: plain(edition?.publish_date?.[0] || String(work.first_publish_year || ''), 32),
      thumbnail: imageUrl(cover, 'openlibrary'), isbn: isbn(edition?.isbn || []), pageCount: pages(edition?.number_of_pages), genres: [], genreSource: '',
      sourceUrl: id ? `https://openlibrary.org${id}` : '' };
  }).filter(book => book.id && book.title);
}

async function fetchJson(fetcher, url, headers = {}) {
  return fetchJsonResponse(fetcher, url, headers, false);
}

async function fetchJsonResponse(fetcher, url, headers, allowNotFound) {
  const response = await fetcher(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(4000) });
  if ((!response.ok && !(allowNotFound && response.status === 404)) || Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('lookup_unavailable');
  return JSON.parse((await boundedBody(response, MAX_BYTES)).toString('utf8'));
}

async function boundedBody(response, limit) {
  // Limit decoded bytes too; compressed or chunked upstream bodies have no useful content-length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('lookup_unavailable');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('lookup_unavailable'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function isbn13(value) {
  if (typeof value !== 'string' || !/^[\d\s-]+$/.test(value)) return '';
  const compact = value.replace(/[\s-]/g, '');
  if (!/^97[89]\d{10}$/.test(compact)) return '';
  const sum = [...compact].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return sum % 10 === 0 ? compact : '';
}

// Never fetch a submitted URL. Only its validated product number is passed to the fixed API host.
function yes24ProductId(value) {
  if (typeof value !== 'string' || value.length > MAX_LINK || /[\s\\\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const pattern = url.hostname === 'www.yes24.com' ? /^\/product\/goods\/([1-9]\d{0,14})\/?$/i
      : url.hostname === 'm.yes24.com' ? /^\/goods\/detail\/([1-9]\d{0,14})\/?$/i : null;
    return pattern?.exec(url.pathname)?.[1] || '';
  } catch { return ''; }
}

// YES24's current API has no subject category. Read only the selected book's public
// category block; never classify from its title, navigation, awards or suggestions.
function yes24Genres(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const opening = /<div\b[^>]*\sid\s*=\s*(["'])infoset_goodsCate\1[^>]*>/i.exec(clean);
  if (!opening) return [];
  const start = opening.index + opening[0].length;
  const tail = clean.slice(start, start + 65536);
  const tags = /<\/?div\b[^>]*>/gi;
  let depth = 1, end = -1, match;
  while ((match = tags.exec(tail))) {
    depth += /^<\//.test(match[0]) ? -1 : 1;
    if (depth === 0) { end = match.index; break; }
  }
  if (end < 0) return [];
  const block = tail.slice(0, end);
  const sections = block.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl\s*>/gi);
  for (const section of sections) {
    const label = /<dt\b[^>]*>([\s\S]*?)<\/dt\s*>/i.exec(section[1]);
    if (!label || plain(label[1], 100).replace(/\s/g, '') !== '카테고리분류') continue;
    const genres = [];
    for (const row of section[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      for (const anchor of row[1].matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
        let category;
        try { category = new URL(plain(anchor[2], 500), 'https://www.yes24.com'); } catch { continue; }
        if (category.origin !== 'https://www.yes24.com' || category.username || category.password || category.search || category.hash ||
          !/^\/product\/category\/display\/(?:001|009)(?:\d{3}){2,8}\/?$/i.test(category.pathname)) continue;
        const name = plain(anchor[3], 80);
        if (!name || /^(국내도서|외국도서|외서)$/.test(name)) continue;
        genres.push(name);
        break;
      }
      if (genres.length >= 24) break;
    }
    return genreNames(genres);
  }
  return [];
}

async function lookupGenres(options, { fetcher = fetch } = {}) {
  const id = yes24ProductId(options.query);
  const empty = { genres: [], genreSource: 'yes24', source: 'yes24', id };
  if (!id) return { ...empty, code: 'GENRE_UNAVAILABLE', error: '책의 분류를 확인하지 못했어요. 직접 입력할 수 있어요.' };
  try {
    const response = await fetcher(`https://www.yes24.com/product/goods/${id}`, {
      headers: { Accept: 'text/html', 'User-Agent': 'GROWELL/1.0 (https://growell-book.vercel.app)' },
      redirect: 'error', signal: AbortSignal.timeout(4000)
    });
    if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length') || 0) > MAX_HTML_BYTES) throw new Error('genre_unavailable');
    const body = await boundedBody(response, MAX_HTML_BYTES);
    const charset = /charset\s*=\s*["']?(?:euc-kr|ks_c_5601-1987)/i.test(response.headers.get('content-type') || '') ? 'euc-kr' : 'utf-8';
    const genres = yes24Genres(new TextDecoder(charset).decode(body));
    if (!genres.length) throw new Error('genre_unavailable');
    return { ...empty, genres };
  } catch {
    return { ...empty, code: 'GENRE_UNAVAILABLE', error: '책의 분류를 확인하지 못했어요. 직접 입력할 수 있어요.' };
  }
}

function yes24Items(data) {
  return (Array.isArray(data?.data?.items) ? data.data.items : []).slice(0, MAX_RESULTS).map(book => {
    if (!book || typeof book !== 'object') return null;
    const id = typeof book.itemId === 'string' ? book.itemId : Number.isSafeInteger(book.itemId) ? String(book.itemId) : '';
    if (!/^[1-9]\d{0,14}$/.test(id)) return null;
    const title = plain(book.title, 250);
    if (!title) return null;
    return { source: 'yes24', id, title, authors: names(Array.isArray(book.author) ? book.author : [book.author]),
      description: plain(book.contentDetail?.bookIntroduction || book.contentDetail?.bookSummary, 6000),
      tableOfContents: plainLines(book.contentDetail?.tableOfContents),
      publisher: plain(book.publisher, 200), publishedDate: plain(book.publishDate, 32).slice(0, 10),
      thumbnail: imageUrl(book.cover, 'yes24'), isbn: isbn([book.isbn13 || '', book.isbn10 || '']), pageCount: pages(book.pages), genres: [], genreSource: '',
      sourceUrl: `https://www.yes24.com/product/goods/${id}` };
  }).filter(Boolean);
}

function yes24Url(options) {
  let path = '/v1/goods/itemList';
  const params = { detail: 'Y' };
  const identifier = isbn13(options.query);
  if (options.mode === 'link' || identifier) {
    path = '/v1/goods/itemDetail';
    params.searchType = identifier ? 'ISBN13' : 'ItemId';
    params.query = identifier || yes24ProductId(options.query);
    if (!params.query) throw new Error('invalid_product');
  } else if (options.mode === 'new') {
    path = '/v1/category/newproduct';
    params.categoryId = '001';
    params.sort = 'RegDate';
  } else {
    params.query = options.query;
    params.category = options.scope === 'foreign' ? 'FOREIGN' : 'BOOK';
    params.sort = options.sort === 'recent' ? 'RECENT' : 'RELATION';
  }
  if (path !== '/v1/goods/itemDetail') {
    params.page = String(options.page);
    params.pageSize = String(MAX_RESULTS);
  }
  const url = new URL(path, 'https://apis.yes24.com');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function lookupBooks(options, { fetcher = fetch, env = process.env } = {}) {
  if (options.mode === 'genres') return lookupGenres(options, { fetcher });
  const empty = { items: [], source: 'yes24', page: options.page, hasMore: false };
  if (!env.YES24_API_KEY || !String(env.YES24_API_KEY).trim()) {
    if (options.mode === 'search' && options.scope === 'foreign' && !isbn13(options.query)) {
      // Legacy providers are available only when the reader explicitly chooses foreign books.
      const result = await searchBooks(options.query, { fetcher, env: { GOOGLE_BOOKS_API_KEY: env.GOOGLE_BOOKS_API_KEY }, page: options.page, sort: options.sort });
      return { ...result, page: options.page, hasMore: result.items.length === MAX_RESULTS && options.page < 50 };
    }
    return { ...empty, code: 'YES24_NOT_CONFIGURED', error: 'YES24 도서 검색 연결을 준비 중이에요. 지금은 직접 등록할 수 있어요.' };
  }
  try {
    const data = await fetchJsonResponse(fetcher, yes24Url(options), { 'X-Api-Key': env.YES24_API_KEY }, true);
    if (data?.success !== true) {
      if (['SEARCH_001', 'GOODS_001', 'GOODS_002', 'NEW_001'].includes(data?.errorCode)) return { ...empty, total: 0 };
      throw new Error('lookup_unavailable');
    }
    if (!Array.isArray(data?.data?.items)) throw new Error('lookup_unavailable');
    const items = yes24Items(data);
    const total = Number(data.data.totalCount);
    const validTotal = data.data.totalCount != null && data.data.totalCount !== '' && Number.isSafeInteger(total) && total >= 0;
    const exact = options.mode === 'link' || Boolean(isbn13(options.query));
    return { items, source: 'yes24', page: options.page,
      hasMore: !exact && options.page < 50 && (validTotal ? options.page * MAX_RESULTS < total : data.data.items.length === MAX_RESULTS),
      ...(validTotal ? { total } : {}) };
  } catch {
    return { ...empty, code: 'YES24_UNAVAILABLE', error: 'YES24 도서 정보를 불러오지 못했어요. 잠시 후 다시 시도하거나 직접 등록해 주세요.' };
  }
}

async function searchBooks(query, { fetcher = fetch, env = process.env, page = 1, sort = 'relevance' } = {}) {
  const providers = [];
  if (env.KAKAO_REST_API_KEY) {
    const url = new URL('https://dapi.kakao.com/v3/search/book');
    url.searchParams.set('query', query); url.searchParams.set('size', String(MAX_RESULTS));
    url.searchParams.set('page', String(page));
    providers.push({ source: 'kakao', url, headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` }, map: kakaoItems });
  }
  const google = new URL('https://www.googleapis.com/books/v1/volumes');
  google.searchParams.set('q', query); google.searchParams.set('maxResults', String(MAX_RESULTS)); google.searchParams.set('printType', 'books');
  google.searchParams.set('startIndex', String((page - 1) * MAX_RESULTS));
  if (sort === 'recent') google.searchParams.set('orderBy', 'newest');
  if (env.GOOGLE_BOOKS_API_KEY) google.searchParams.set('key', env.GOOGLE_BOOKS_API_KEY);
  providers.push({ source: 'google', url: google, map: googleItems });
  const openLibrary = new URL('https://openlibrary.org/search.json');
  openLibrary.searchParams.set('q', query); openLibrary.searchParams.set('lang', /[가-힣]/.test(query) ? 'ko' : 'en'); openLibrary.searchParams.set('limit', String(MAX_RESULTS));
  openLibrary.searchParams.set('page', String(page));
  if (sort === 'recent') openLibrary.searchParams.set('sort', 'new');
  openLibrary.searchParams.set('fields', 'key,title,author_name,cover_i,first_publish_year,editions,editions.key,editions.title,editions.isbn,editions.publisher,editions.publish_date,editions.language,editions.cover_i');
  providers.push({ source: 'openlibrary', url: openLibrary, headers: { 'User-Agent': 'GROWELL/1.0 (https://growell-book.vercel.app)' }, map: openLibraryItems });
  let available = false;
  for (const provider of providers) {
    try {
      const items = provider.map(await fetchJson(fetcher, provider.url, provider.headers));
      available = true;
      if (items.length) return { items, source: provider.source };
    } catch { /* A provider failure must leave manual registration available. */ }
  }
  return available ? { items: [], source: 'none' } : { items: [], source: 'none', error: '책 검색에 연결하지 못했어요. 잠시 후 다시 검색하거나 직접 등록해 주세요.' };
}

function send(res, status, data) { res.status(status).json(data); }
function requestQuery(req) {
  const parsed = new URL(req.url || '/', 'https://growell-book.vercel.app');
  const raw = req.query?.q ?? parsed.searchParams.get('q');
  return typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

function requestOptions(req) {
  let url;
  try { url = new URL(req.url || '/', 'https://growell-book.vercel.app'); }
  catch { return { error: '검색 요청을 확인해 주세요.' }; }
  const get = name => {
    if (url.searchParams.getAll(name).length > 1) return null;
    const value = req.query?.[name] ?? url.searchParams.get(name) ?? '';
    return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  };
  const rawQuery = get('q'), rawMode = get('mode'), rawScope = get('scope'), rawSort = get('sort'), rawPage = get('page');
  if ([rawQuery, rawMode, rawScope, rawSort, rawPage].includes(null)) return { error: '검색 요청을 확인해 주세요.' };
  const mode = rawMode || 'search', scope = rawScope || 'domestic', sort = rawSort || 'relevance';
  if (!['search', 'link', 'new', 'genres'].includes(mode) || !['domestic', 'foreign'].includes(scope) || !['relevance', 'recent'].includes(sort)) return { error: '검색 방식을 확인해 주세요.' };
  if (rawQuery.length > (['link', 'genres'].includes(mode) ? MAX_LINK : MAX_QUERY)) return { error: '검색어가 너무 길어요. 책 제목이나 YES24 주소를 확인해 주세요.' };
  if (rawPage && !/^(?:[1-9]|[1-4]\d|50)$/.test(rawPage)) return { error: '검색 페이지를 확인해 주세요.' };
  const page = Number(rawPage || 1);
  const query = rawQuery.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (mode === 'new') {
    if (scope !== 'domestic' || query) return { error: '신간은 국내도서 목록에서 확인할 수 있어요.' };
  } else if (mode === 'genres') {
    if (!yes24ProductId(query) || page !== 1) return { error: '분류를 확인할 YES24 책 상세 주소를 입력해 주세요.' };
  } else if (mode === 'link') {
    if (query.length > MAX_LINK || (!yes24ProductId(query) && !isbn13(query)) || page !== 1) return { error: 'YES24 책 상세 주소나 올바른 ISBN 13자리를 입력해 주세요.' };
  } else if (query.length < 2 || query.length > MAX_QUERY) {
    return { error: '책 제목이나 저자를 2~120자로 입력해 주세요.' };
  }
  if (mode === 'search' && isbn13(query) && page !== 1) return { error: 'ISBN으로 찾은 책은 첫 페이지에서 확인해 주세요.' };
  return { mode, scope, sort, page, query };
}

function cacheKey(options, configured = Boolean(process.env.YES24_API_KEY?.trim())) {
  return JSON.stringify([configured, options.mode, options.scope, options.sort, options.page,
    ['link', 'genres'].includes(options.mode) ? (isbn13(options.query) ? `isbn:${isbn13(options.query)}` : `item:${yes24ProductId(options.query)}`) : options.query.toLocaleLowerCase()]);
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { items: [], source: 'none', error: '지원하지 않는 요청이에요.' }); }
  const options = requestOptions(req);
  if (options.error) return send(res, 400, { items: [], source: 'none', error: options.error });
  const now = Date.now();
  const address = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
  const rate = requests.get(address);
  if (rate && rate.until > now && rate.count >= 30) { res.setHeader('Retry-After', '60'); return send(res, 429, { items: [], source: 'none', error: '검색 요청이 많아요. 잠시 후 다시 시도해 주세요.' }); }
  requests.set(address, rate && rate.until > now ? { count: rate.count + 1, until: rate.until } : { count: 1, until: now + 60000 });
  if (requests.size > 500) for (const [key, value] of requests) { if (value.until <= now || requests.size > 500) requests.delete(key); }
  const key = cacheKey(options);
  const existing = cache.get(key);
  if (existing && existing.until > now) return send(res, 200, existing.result);
  try {
    const result = await lookupBooks(options);
    if (!result.error) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, { until: now + (options.mode === 'genres' ? 21600000 : result.items.length ? 900000 : 60000), result });
    }
    return send(res, result.error ? 503 : 200, result);
  } catch { return send(res, 503, { items: [], source: 'none', error: '책 검색에 연결하지 못했어요. 직접 등록하거나 잠시 후 다시 시도해 주세요.' }); }
}

module.exports = handler;
module.exports._test = { plain, plainLines, genreNames, imageUrl, isbn, isbn13, yes24ProductId, yes24Items, yes24Url, yes24Genres, kakaoItems, googleItems, openLibraryItems,
  fetchJson, searchBooks, lookupBooks, lookupGenres, requestQuery, requestOptions, cacheKey, cache, requests };
