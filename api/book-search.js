'use strict';

// Public bibliographic lookup only. API credentials never leave this function.
const MAX_QUERY = 120;
const MAX_RESULTS = 12;
const MAX_BYTES = 1024 * 1024;
const CACHE_LIMIT = 100;
const cache = new Map();
const requests = new Map();

function plain(value, limit = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (code[0] !== '#') return named[code.toLowerCase()] || all;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function imageUrl(value, source) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const allowed = source === 'kakao'
      ? /(^|\.)(kakaocdn\.net|daumcdn\.net)$/i.test(url.hostname)
      : source === 'google'
        ? /^(books\.google\.com|books\.googleusercontent\.com)$/i.test(url.hostname)
        : url.hostname === 'covers.openlibrary.org';
    if (!allowed) return '';
    url.protocol = 'https:';
    return url.href.slice(0, 1800);
  } catch { return ''; }
}

function isbn(values) {
  const candidates = (Array.isArray(values) ? values : String(values || '').split(/\s+/))
    .map(value => String(value).replace(/[^\dXx]/g, '').toUpperCase());
  return candidates.find(value => /^\d{13}$/.test(value)) || candidates.find(value => /^\d{9}[\dX]$/.test(value)) || '';
}

function names(value) { return (Array.isArray(value) ? value : []).slice(0, 10).map(item => plain(item, 120)).filter(Boolean); }
function pages(value) { const count = Number(value); return Number.isInteger(count) && count > 0 && count <= 100000 ? count : null; }

function kakaoItems(data) {
  return (Array.isArray(data?.documents) ? data.documents : []).slice(0, MAX_RESULTS).map((book) => {
    const identifier = isbn(book.isbn);
    const title = plain(book.title, 250);
    return { source: 'kakao', id: identifier || title, title, authors: names(book.authors),
      description: plain(book.contents, 6000), publisher: plain(book.publisher, 200), publishedDate: plain(book.datetime, 32).slice(0, 10),
      thumbnail: imageUrl(book.thumbnail, 'kakao'), isbn: identifier, pageCount: null,
      sourceUrl: `https://search.daum.net/search?w=book&q=${encodeURIComponent(identifier || title)}` };
  }).filter(book => book.title);
}

function googleItems(data) {
  return (Array.isArray(data?.items) ? data.items : []).slice(0, MAX_RESULTS).map((item) => {
    const book = item.volumeInfo || {};
    const id = plain(item.id, 100);
    return { source: 'google', id, title: plain(book.title, 250), authors: names(book.authors),
      description: plain(book.description, 6000), publisher: plain(book.publisher, 200), publishedDate: plain(book.publishedDate, 32),
      thumbnail: imageUrl(book.imageLinks?.thumbnail || book.imageLinks?.smallThumbnail, 'google'),
      isbn: isbn((Array.isArray(book.industryIdentifiers) ? book.industryIdentifiers : []).filter(row => ['ISBN_13', 'ISBN_10'].includes(row.type)).map(row => row.identifier)),
      pageCount: pages(book.pageCount), sourceUrl: `https://books.google.com/books?id=${encodeURIComponent(id)}` };
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
      thumbnail: imageUrl(cover, 'openlibrary'), isbn: isbn(edition?.isbn || []), pageCount: pages(edition?.number_of_pages),
      sourceUrl: id ? `https://openlibrary.org${id}` : '' };
  }).filter(book => book.id && book.title);
}

async function fetchJson(fetcher, url, headers = {}) {
  const response = await fetcher(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(2400) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('lookup_unavailable');
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
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('lookup_unavailable'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function searchBooks(query, { fetcher = fetch, env = process.env } = {}) {
  const providers = [];
  if (env.KAKAO_REST_API_KEY) {
    const url = new URL('https://dapi.kakao.com/v3/search/book');
    url.searchParams.set('query', query); url.searchParams.set('size', String(MAX_RESULTS));
    providers.push({ source: 'kakao', url, headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` }, map: kakaoItems });
  }
  const google = new URL('https://www.googleapis.com/books/v1/volumes');
  google.searchParams.set('q', query); google.searchParams.set('maxResults', String(MAX_RESULTS)); google.searchParams.set('printType', 'books');
  if (env.GOOGLE_BOOKS_API_KEY) google.searchParams.set('key', env.GOOGLE_BOOKS_API_KEY);
  providers.push({ source: 'google', url: google, map: googleItems });
  const openLibrary = new URL('https://openlibrary.org/search.json');
  openLibrary.searchParams.set('q', query); openLibrary.searchParams.set('lang', /[가-힣]/.test(query) ? 'ko' : 'en'); openLibrary.searchParams.set('limit', String(MAX_RESULTS));
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

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { items: [], source: 'none', error: '지원하지 않는 요청이에요.' }); }
  const query = requestQuery(req);
  if (query.length < 2 || query.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(query)) return send(res, 400, { items: [], source: 'none', error: '책 제목이나 저자를 2~120자로 입력해 주세요.' });
  const now = Date.now();
  const address = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
  const rate = requests.get(address);
  if (rate && rate.until > now && rate.count >= 30) { res.setHeader('Retry-After', '60'); return send(res, 429, { items: [], source: 'none', error: '검색 요청이 많아요. 잠시 후 다시 시도해 주세요.' }); }
  requests.set(address, rate && rate.until > now ? { count: rate.count + 1, until: rate.until } : { count: 1, until: now + 60000 });
  if (requests.size > 500) for (const [key, value] of requests) { if (value.until <= now || requests.size > 500) requests.delete(key); }
  const cacheKey = query.toLocaleLowerCase();
  const existing = cache.get(cacheKey);
  if (existing && existing.until > now) return send(res, 200, existing.result);
  try {
    const result = await searchBooks(query);
    if (!result.error) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { until: now + (result.items.length ? 900000 : 60000), result });
    }
    return send(res, result.error ? 503 : 200, result);
  } catch { return send(res, 503, { items: [], source: 'none', error: '책 검색에 연결하지 못했어요. 직접 등록하거나 잠시 후 다시 시도해 주세요.' }); }
}

module.exports = handler;
module.exports._test = { plain, imageUrl, isbn, kakaoItems, googleItems, openLibraryItems, fetchJson, searchBooks, requestQuery, cache, requests };
