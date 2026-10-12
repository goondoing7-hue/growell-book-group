'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const JOB = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const RECORD = '55555555-5555-4555-8555-555555555555';
const SECRET = 'fixture-worker-secret'.repeat(3);
const HASH = 'abc123'.repeat(10) + 'abcd';
const RECIPIENT = 'member@example.test';
const CLAIM = { id: JOB, lease_token: LEASE, record_id: RECORD, owner_id: 'member-owner', attempts: 1 };
const SNAPSHOT = { applied: true, recipient: RECIPIENT, content_hash: HASH, record: { id: RECORD, bookId: 'emotion', round: 1, revision: 2, status: 'published', topic: '회원 원문 비공개 로그 확인' }, materials: [], insights: [{ authorName: '회원', q1: '공개 통찰이다.' }] };
const PDF = Buffer.from('%PDF-1.3\n' + 'fixture binary '.repeat(20) + '\n%%EOF');
const SOURCE = fs.readFileSync(path.join(__dirname, '../server/meeting-record-email-worker.ts'), 'utf8').replace(/^import .+ from .+\r?\n/gm, '');

function fixture(options = {}) {
  let handler;
  const calls = [], fetches = [], messages = [], transports = [], logs = [];
  const counts = { verify: 0, close: 0 };
  const rpc = async (name, params) => {
    calls.push({ name, params });
    if (options.rpc) { const supplied = await options.rpc(name, params); if (supplied !== undefined) return supplied; }
    if (name === 'growell_meeting_mail_worker_authorized') return options.authorizationError ? { error: { message: 'PRIVATE SECRET DETAIL' } } : { data: options.authorized === undefined ? true : options.authorized, error: null };
    if (name === 'growell_meeting_mail_claim') return { data: options.claim === undefined ? [CLAIM] : options.claim, error: null };
    if (name === 'growell_meeting_mail_apply') {
      if (params.p_operation === 'snapshot') return { data: options.snapshot || SNAPSHOT, error: null };
      if (params.p_operation === 'prepare') return { data: options.prepare || SNAPSHOT, error: null };
      return { data: { applied: true }, error: null };
    }
    throw new Error('unexpected mock RPC');
  };
  const transport = {
    verify: async () => { counts.verify += 1; if (options.verifyError) throw new Error('SECRET SMTP AUTH'); },
    sendMail: async outgoing => {
      messages.push(outgoing);
      if (options.sendError) throw Object.assign(new Error('SECRET SMTP USER PASSWORD'), options.sendError);
      if (options.receipt) return options.receipt(outgoing);
      return { accepted: [RECIPIENT], rejected: [], response: '250 2.0.0 Accepted', messageId: outgoing.messageId };
    },
    close: () => { counts.close += 1; }
  };
  vm.runInNewContext(SOURCE, {
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://fixture.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key', GROWELL_GMAIL_APP_PASSWORD: options.password === undefined ? 'abcdefghijklmnop' : options.password }[key]) }, serve: fn => { handler = fn; } },
    createClient: () => ({ rpc }), nodemailer: { createTransport: configuration => { transports.push(configuration); return transport; } },
    Buffer, Response, AbortSignal, URL, console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    fetch: async (url, request) => {
      fetches.push({ url, request });
      if (options.fetchError) throw new Error('PRIVATE PDF BACKEND DETAILS');
      const headers = { 'content-type': options.mime || 'application/pdf', 'x-growell-record-revision': options.revision || '2', 'x-growell-content-hash': options.hash || HASH };
      if (options.length !== undefined) headers['content-length'] = String(options.length);
      return new Response(options.pdf || PDF, { status: options.pdfStatus || 200, headers });
    }
  }, { filename: 'meeting-record-email-worker.ts' });
  async function invoke({ action = 'process', raw, body, method = 'POST', secret = SECRET, type = 'application/json' } = {}) {
    const headers = { 'x-growell-worker-secret': secret, 'content-type': type };
    const request = new Request('https://fixture.supabase.test/functions/v1/meeting-record-email-worker', { method, headers, ...(method === 'GET' ? {} : { body: raw === undefined ? JSON.stringify(body === undefined ? { action } : body) : raw }) });
    const response = await handler(request);
    return { status: response.status, body: await response.json() };
  }
  return { invoke, calls, fetches, messages, transports, counts, logs };
}
function operations(f) { return f.calls.filter(call => call.name === 'growell_meeting_mail_apply').map(call => call.params.p_operation); }

test('SMTP verification checks connection only without claims, PDFs or mail', async () => {
  const f = fixture(), result = await f.invoke({ action: 'verify' });
  assert.equal(result.status, 200); assert.equal(result.body.connectionVerified, true);
  assert.equal(f.counts.verify, 1); assert.equal(f.counts.close, 1);
  assert.deepEqual(f.calls.map(call => call.name), ['growell_meeting_mail_worker_authorized']);
  assert.equal(f.fetches.length, 0); assert.equal(f.messages.length, 0);
  assert.equal(f.transports[0].host, 'smtp.gmail.com'); assert.equal(f.transports[0].auth.user, 'goondoing7@gmail.com');
  assert.equal(f.transports[0].debug, false); assert.equal(f.transports[0].logger, false); assert.equal(f.transports[0].disableUrlAccess, true);
});

test('authorization, JSON action allowlist and configured password protect the worker', async () => {
  const method = fixture(); assert.equal((await method.invoke({ method: 'GET' })).status, 405); assert.equal(method.calls.length, 0);
  const short = fixture(); assert.equal((await short.invoke({ secret: 'short' })).status, 401); assert.equal(short.calls.length, 0);
  const denied = fixture({ authorized: false }); assert.equal((await denied.invoke()).status, 401); assert.equal(denied.fetches.length, 0); assert.equal(denied.transports.length, 0);
  const unavailable = fixture({ authorizationError: true }); assert.equal((await unavailable.invoke()).status, 503); assert.equal(unavailable.transports.length, 0);
  for (const body of [{ action: 'test' }, { action: 'process', recipient: 'victim@example.test' }, { action: 'process', url: 'https://attacker.example' }, { action: 'process', record: {} }, {}, [], null]) {
    const f = fixture(); assert.equal((await f.invoke({ body })).status, 400); assert.equal(f.transports.length, 0); assert.equal(f.fetches.length, 0);
  }
  const malformed = fixture(); assert.equal((await malformed.invoke({ raw: '{broken' })).status, 400);
  const empty = fixture(); assert.equal((await empty.invoke({ raw: '' })).status, 400);
  const tooLarge = fixture(); assert.equal((await tooLarge.invoke({ raw: 'x'.repeat(1025) })).status, 400);
  const mime = fixture(); assert.equal((await mime.invoke({ type: 'text/plain' })).status, 400);
  const password = fixture({ password: '' }); assert.equal((await password.invoke()).status, 503); assert.equal(password.calls.length, 1);
});

test('exact authoritative snapshot and PDF are fenced again immediately before SMTP', async () => {
  const f = fixture(), result = await f.invoke();
  assert.equal(result.status, 200); assert.equal(result.body.accepted, true); assert.equal(result.body.processed, 1);
  assert.deepEqual(operations(f), ['snapshot', 'prepare', 'accepted']);
  const prepare = f.calls.find(call => call.params?.p_operation === 'prepare');
  assert.deepEqual(JSON.parse(JSON.stringify(prepare.params.p_payload)), { record_revision: 2, content_hash: HASH });
  assert.equal(f.fetches[0].url, 'https://growell-book.vercel.app/api/meeting-record-mail?action=pdf');
  assert.equal(f.fetches[0].request.redirect, 'error'); assert.equal(f.fetches[0].request.headers.Authorization, 'Bearer ' + SECRET);
  assert.deepEqual(JSON.parse(f.fetches[0].request.body), { jobId: JOB, lease: LEASE });
  const outgoing = f.messages[0]; assert.equal(f.messages.length, 1);
  assert.deepEqual(Array.from(outgoing.envelope.to), [RECIPIENT]); assert.equal(outgoing.envelope.from, 'goondoing7@gmail.com');
  assert.equal(outgoing.messageId, `<growell-meeting-v1-${JOB}@gmail.com>`);
  assert.equal(outgoing.attachments.length, 1); assert.equal(outgoing.attachments[0].contentType, 'application/pdf');
  assert.equal(outgoing.attachments[0].content.equals(PDF), true); assert.equal(outgoing.attachments[0].filename, 'GROWELL-meeting-1.pdf');
  assert.equal(f.counts.close, 1); assert.deepEqual(f.logs, []);
});

test('empty or malformed queue never sends and claim count is one', async () => {
  const f = fixture({ claim: [] }); assert.equal((await f.invoke()).body.processed, 0); assert.equal(f.messages.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].params)), { p_limit: 1 });
  for (const claim of [null, [CLAIM, CLAIM], [{ ...CLAIM, id: 'bad' }]]) {
    const invalid = fixture({ claim }); assert.equal((await invalid.invoke()).status, 503); assert.equal(invalid.fetches.length, 0); assert.equal(invalid.messages.length, 0);
  }
});

test('PDF failures, sizes, MIME, magic, EOF, revision and content hash retry only before sending', async () => {
  for (const options of [{ fetchError: true }, { pdfStatus: 503 }, { mime: 'text/html' }, { revision: '3' }, { hash: 'b'.repeat(64) }, { length: 8 * 1024 * 1024 + 1 }, { pdf: Buffer.from('x'.repeat(300)) }, { pdf: Buffer.from('%PDF-' + 'x'.repeat(300)) }, { pdf: Buffer.from('%PDF-%%EOF') }]) {
    const f = fixture(options), result = await f.invoke();
    assert.equal(result.status, 503); assert.equal(result.body.error, 'pdf-unavailable');
    assert.deepEqual(operations(f), ['snapshot', 'retry']); assert.equal(f.messages.length, 0);
    const retry = f.calls.find(call => call.params?.p_operation === 'retry'); assert.equal(retry.params.p_payload.error_code, 'pdf-unavailable');
    assert.equal(retry.params.p_payload.retry_after, 60); assert.deepEqual(f.logs, []);
  }
  const overflow = fixture({ pdf: Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024)]) });
  assert.equal((await overflow.invoke()).body.error, 'pdf-unavailable'); assert.equal(overflow.messages.length, 0);
});

test('snapshot identity and mailbox safety block unavailable, private or arbitrary-recipient content', async () => {
  for (const snapshot of [{ applied: false }, { ...SNAPSHOT, record: { ...SNAPSHOT.record, status: 'draft' } }, { ...SNAPSHOT, record: { ...SNAPSHOT.record, id: JOB } }, { ...SNAPSHOT, content_hash: '' }, { ...SNAPSHOT, recipient: 'one@example.test,two@example.test' }, { ...SNAPSHOT, recipient: 'victim@example.test\r\nBcc:other@example.test' }]) {
    const f = fixture({ snapshot }); assert.equal((await f.invoke()).body.error, 'record-changed');
    assert.equal(f.fetches.length, 0); assert.equal(f.messages.length, 0); assert.deepEqual(operations(f), ['snapshot', 'retry']);
  }
});

test('changed revision, consent and public-insight hash at prepare prevent stale mail', async () => {
  const stale = fixture({ prepare: { applied: false } }); assert.equal((await stale.invoke()).body.error, 'record-changed');
  assert.deepEqual(operations(stale), ['snapshot', 'prepare', 'retry']); assert.equal(stale.messages.length, 0);
  for (const prepare of [{ ...SNAPSHOT, recipient: 'other@example.test' }, { ...SNAPSHOT, content_hash: 'f'.repeat(64) }, { ...SNAPSHOT, record: { ...SNAPSHOT.record, revision: 3 } }]) {
    const f = fixture({ prepare }); assert.equal((await f.invoke()).body.automaticRetry, false);
    assert.deepEqual(operations(f), ['snapshot', 'prepare', 'uncertain']); assert.equal(f.messages.length, 0);
  }
});

test('a lost prepare acknowledgment is uncertain and never enters the retry operation', async () => {
  const f = fixture({ rpc: (name, params) => params?.p_operation === 'prepare' ? { error: { message: 'lost committed prepare' } } : undefined });
  assert.equal((await f.invoke()).body.automaticRetry, false); assert.equal(f.messages.length, 0);
  assert.deepEqual(operations(f), ['snapshot', 'prepare', 'uncertain']);
});

test('SMTP attempted errors and every incomplete/mismatched acceptance proof are never retried', async () => {
  for (const options of [{ sendError: { code: 'EAUTH' } }, { sendError: { code: 'EDNS' } }, { sendError: { code: 'ETIMEDOUT', command: 'DATA' } },
    { receipt: outgoing => ({ accepted: [RECIPIENT], rejected: [], response: '250 okay', messageId: outgoing.messageId + 'other' }) },
    { receipt: outgoing => ({ accepted: [RECIPIENT, 'other@example.test'], rejected: [], response: '250 okay', messageId: outgoing.messageId }) },
    { receipt: outgoing => ({ accepted: [RECIPIENT], rejected: ['other@example.test'], response: '250 okay', messageId: outgoing.messageId }) },
    { receipt: outgoing => ({ accepted: [RECIPIENT], rejected: [], response: '200 okay', messageId: outgoing.messageId }) }]) {
    const f = fixture(options), result = await f.invoke(); assert.equal(result.body.error, 'delivery-uncertain'); assert.equal(result.body.automaticRetry, false);
    assert.equal(f.messages.length, 1); assert.deepEqual(operations(f), ['snapshot', 'prepare', 'uncertain']); assert.deepEqual(f.logs, []);
  }
});

test('lost accepted receipt retains sending state for review and never resends or exposes private errors', async () => {
  for (const ack of [{ error: { message: 'PRIVATE SECRET SMTP DATA' } }, { data: { applied: false }, error: null }]) {
    const f = fixture({ rpc: (name, params) => params?.p_operation === 'accepted' ? ack : undefined });
    const result = await f.invoke(); assert.equal(result.status, 503); assert.equal(result.body.error, 'acknowledgment-pending');
    assert.equal(result.body.automaticRetry, false); assert.equal(f.messages.length, 1); assert.deepEqual(operations(f), ['snapshot', 'prepare', 'accepted']);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE'), false); assert.deepEqual(f.logs, []);
  }
});
