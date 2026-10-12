// Deploy as the separate Supabase Edge Function: meeting-record-email.
// Keep legacy JWT verification enabled at the gateway; the scheduler includes
// the same public anon JWT already used by the app. Additionally require the
// existing private Vault worker secret, verified by the service-only RPC.
// No browser-supplied recipient, URL, record content or manual resend action.
import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@9.0.1'
import { Buffer } from 'node:buffer'

const SENDER = 'goondoing7@gmail.com'
const PDF_URL = 'https://growell-book.vercel.app/api/meeting-record-mail?action=pdf'
const APP_URL = 'https://growell-book.vercel.app/'
const MAX_PDF = 8 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BOOKS = new Set(['emotion', 'thought', 'body', 'action'])
const CONTENT_HASH = /^[0-9a-f]{64}$/

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254) return false
  const match = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(value)
  return !!match && match[1].length <= 64 && !match[1].startsWith('.') && !match[1].endsWith('.') && !match[1].includes('..')
}
function validSnapshot(value, job) {
  const record = value && value.record
  return value?.applied === true && mailbox(value.recipient) && record?.id === job.record_id
    && record.status === 'published' && BOOKS.has(record.bookId)
    && Number.isInteger(record.round) && record.round >= 1 && record.round <= 9999
    && Number.isSafeInteger(record.revision) && record.revision >= 1 && CONTENT_HASH.test(value.content_hash || '')
}
function gmailTransport(password) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    auth: { user: SENDER, pass: password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.gmail.com' },
    dnsTimeout: 5000, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    logger: false, debug: false, transactionLog: false, disableFileAccess: true, disableUrlAccess: true,
  })
}
async function pdfAttachment(job, revision, contentHash, secret) {
  const result = await fetch(PDF_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.id, lease: job.lease_token }),
  })
  if (result.status !== 200 || (result.url && result.url !== PDF_URL)
      || !/^application\/pdf(?:\s*;|$)/i.test(result.headers.get('content-type') || '')
      || result.headers.get('x-growell-record-revision') !== String(revision)
      || result.headers.get('x-growell-content-hash') !== contentHash) throw new Error('pdf-unavailable')
  const length = result.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) < 100 || Number(length) > MAX_PDF)) throw new Error('pdf-unavailable')
  const reader = result.body?.getReader()
  if (!reader) throw new Error('pdf-unavailable')
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_PDF) throw new Error('pdf-unavailable')
      chunks.push(Buffer.from(part.value))
    }
  } catch (error) {
    try { await reader.cancel() } catch { /* Never log response bytes. */ }
    throw error
  }
  const buffer = Buffer.concat(chunks)
  if (bytes < 100 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-'
      || !buffer.subarray(-1024).includes(Buffer.from('%%EOF'))) throw new Error('pdf-unavailable')
  return buffer
}
function message(job, prepared, pdf) {
  const round = prepared.record.round
  const recipient = prepared.recipient
  return {
    from: `GROWELL <${SENDER}>`, to: [recipient], envelope: { from: SENDER, to: [recipient] },
    messageId: `<growell-meeting-v1-${job.id}@gmail.com>`,
    subject: `[GROWELL] ${round}번째 모임 기록`,
    text: `GROWELL ${round}번째 모임 기록\n\n운영자가 정리한 모임 내용과 해당 모임에 공개된 회원 통찰을 A4 PDF로 보내드립니다. 첨부파일에서 모임 내용과 다음 모임 준비를 확인해 주세요.\n\n프로필 → Google 연동에서 모임 기록 이메일 자동 수신을 관리할 수 있습니다.\n${APP_URL}`,
    attachments: [{ filename: `GROWELL-meeting-${round}.pdf`, content: pdf, contentType: 'application/pdf', contentDisposition: 'attachment' }],
    disableFileAccess: true, disableUrlAccess: true,
  }
}
function exactAcceptance(info, outgoing) {
  return Array.isArray(info?.accepted) && info.accepted.length === 1 && info.accepted[0] === outgoing.envelope.to[0]
    && Array.isArray(info.rejected) && info.rejected.length === 0
    && /^250(?:[ -])/.test(String(info.response || '')) && info.messageId === outgoing.messageId
}

Deno.serve(async req => {
  if (req.method !== 'POST') return response({ error: 'method-not-allowed' }, 405)
  const secret = req.headers.get('x-growell-worker-secret') || ''
  if (secret.length < 32 || secret.length > 256) return response({ error: 'unauthorized' }, 401)
  const database = Deno.env.get('SUPABASE_URL'), serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!database || !serviceKey) return response({ error: 'not-configured' }, 503)
  const client = createClient(database, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(6000) }) },
  })
  async function rpc(name, params) {
    const result = await client.rpc('growell_meeting_mail_' + name, params)
    if (result.error) throw new Error('service-unavailable')
    return result.data
  }
  try {
    if (await rpc('worker_authorized', { p_secret: secret }) !== true) return response({ error: 'unauthorized' }, 401)
  } catch { return response({ error: 'authorization-unavailable' }, 503) }
  let action
  try {
    const raw = await req.text()
    if (!raw || raw.length > 1024 || !/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) throw new Error('invalid')
    const input = JSON.parse(raw)
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length !== 1
        || !['verify', 'process'].includes(input.action)) throw new Error('invalid')
    action = input.action
  } catch { return response({ error: 'invalid-action' }, 400) }
  const password = (Deno.env.get('GROWELL_GMAIL_APP_PASSWORD') || '').replace(/ /g, '')
  if (!/^[a-zA-Z]{16}$/.test(password)) return response({ error: 'not-configured' }, 503)
  const transport = gmailTransport(password)
  let job, prepared = false
  const apply = (operation, payload = {}) => rpc('apply', { p_job: job.id, p_lease: job.lease_token, p_operation: operation, p_payload: payload })
  async function retry(errorCode) {
    // SQL bounds claimed-only retries to five attempts. Sending/review jobs are
    // never accepted by this operation, including a lost prepare response.
    return apply('retry', { error_code: errorCode, retry_after: Math.min(3600, 60 * 2 ** Math.min(job.attempts - 1, 6)) })
  }
  async function uncertain() {
    try { await apply('uncertain') } catch { /* An expired sending lease goes to review, never retry. */ }
    return response({ error: 'delivery-uncertain', processed: 0, automaticRetry: false }, 503)
  }
  try {
    if (action === 'verify') {
      // Authentication/TLS only: do not claim a job, render a PDF, or send mail.
      try { await transport.verify(); return response({ ok: true, connectionVerified: true }) }
      catch { return response({ error: 'smtp-unavailable', connectionVerified: false }, 503) }
    }
    const claimed = await rpc('claim', { p_limit: 1 })
    if (!Array.isArray(claimed) || claimed.length > 1) return response({ error: 'queue-unavailable', processed: 0 }, 503)
    if (!claimed.length) return response({ ok: true, processed: 0 })
    job = claimed[0]
    if (!UUID.test(job?.id || '') || !UUID.test(job?.lease_token || '') || !UUID.test(job?.record_id || '')
        || !Number.isInteger(job.attempts) || job.attempts < 1) return response({ error: 'queue-unavailable', processed: 0 }, 503)
    let snapshot
    try { snapshot = await apply('snapshot') }
    catch { await retry('service-unavailable'); return response({ error: 'service-unavailable', processed: 0 }, 503) }
    if (!validSnapshot(snapshot, job)) {
      await retry('record-changed'); return response({ error: 'record-changed', processed: 0 }, 503)
    }
    let pdf
    try { pdf = await pdfAttachment(job, snapshot.record.revision, snapshot.content_hash, secret) }
    catch { await retry('pdf-unavailable'); return response({ error: 'pdf-unavailable', processed: 0 }, 503) }
    let preparation
    try { preparation = await apply('prepare', { record_revision: snapshot.record.revision, content_hash: snapshot.content_hash }) }
    catch { return uncertain() }
    if (preparation?.applied !== true) {
      await retry('record-changed'); return response({ error: 'record-changed', processed: 0 }, 503)
    }
    prepared = true
    if (!validSnapshot(preparation, job) || preparation.recipient !== snapshot.recipient
        || preparation.record.revision !== snapshot.record.revision || preparation.record.round !== snapshot.record.round
        || preparation.record.bookId !== snapshot.record.bookId || preparation.content_hash !== snapshot.content_hash) return uncertain()
    const outgoing = message(job, preparation, pdf)
    let accepted
    // Every SMTP attempt is irreversible. Even a DNS/authentication error or
    // unexpected receipt is retained for review, never automatically resent.
    try { accepted = exactAcceptance(await transport.sendMail(outgoing), outgoing) }
    catch { return uncertain() }
    if (!accepted) return uncertain()
    let acknowledgment
    try { acknowledgment = await apply('accepted', { provider_id: outgoing.messageId, message_id: outgoing.messageId }) }
    catch { return response({ error: 'acknowledgment-pending', processed: 0, automaticRetry: false }, 503) }
    if (acknowledgment?.applied !== true) return response({ error: 'acknowledgment-pending', processed: 0, automaticRetry: false }, 503)
    return response({ ok: true, processed: 1, accepted: true })
  } catch {
    if (prepared) return uncertain()
    return response({ error: 'worker-unavailable', processed: 0 }, 503)
  } finally {
    try { transport.close() } catch { /* No recipient, credential or SMTP logs. */ }
  }
})
