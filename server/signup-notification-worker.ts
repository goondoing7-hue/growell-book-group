// Deploy as the separate Supabase Edge Function `signup-notification-worker`.
// verify_jwt=false; a Vault-held worker secret is checked by a service-only RPC.
// Never invoke from the public app; never accept recipients or message content.
import { createClient } from 'npm:@supabase/supabase-js@2'
// Supabase's SMTP example uses Nodemailer's npm transport. Pin the reviewed
// version: error-stage handling below must be rechecked before upgrading.
import nodemailer from 'npm:nodemailer@9.0.1'

const ADMIN_RECIPIENT = 'goondoing7@gmail.com'
const PROVIDER = 'gmail_smtp'
const ADMIN_URL = 'https://growell-book.vercel.app/#/admin/users'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
}
type Job = {
  id: string; lease_token: string; applicant_name: string; login_id: string;
  requested_at: string; sender: string; recipient: string; provider: string; template_version: number;
}
function notificationMessage(job: Job) {
  if (job.template_version !== 1 || job.provider !== PROVIDER || job.sender !== ADMIN_RECIPIENT
      || job.recipient !== ADMIN_RECIPIENT || !UUID_RE.test(job.id) || !UUID_RE.test(job.lease_token)) throw new Error('invalid_job')
  const date = new Date(job.requested_at)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_job')
  const requestedAt = new Intl.DateTimeFormat('ko-KR',{
    timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,
  }).format(date)
  const name = String(job.applicant_name).slice(0,30)
  const loginId = String(job.login_id).slice(0,64)
  const subject = '[GROWELL] 새 가입 승인 요청'
  // This v1 template is deliberately stable: retries use the same payload.
  return {
    from:`GROWELL <${job.sender}>`,to:[job.recipient],subject,
    envelope:{from:ADMIN_RECIPIENT,to:[ADMIN_RECIPIENT]},
    // Useful for manual Gmail searches, NOT an SMTP idempotency guarantee.
    messageId:`<growell-signup-v1-${job.id}@gmail.com>`,date,
    text:`GROWELL 가입 승인 요청\n\n이름: ${name}\n아이디: ${loginId}\n신청 시각: ${requestedAt}\n\n가입자 목록에서 신청을 확인하고 승인해 주세요.\n${ADMIN_URL}\n\n관리자 로그인 후 승인할 수 있습니다. 이 메일을 여는 것만으로 승인되지 않습니다.`,
    html:`<!doctype html><html lang="ko"><body style="margin:0;background:#f5f5ef;font-family:Arial,sans-serif;color:#20372e"><main style="max-width:520px;margin:32px auto;padding:28px;background:#fff;border:1px solid #dde3d8;border-radius:16px"><p style="color:#3d6450;font-weight:bold;letter-spacing:1px">GROWELL</p><h1 style="font-size:24px;margin:20px 0">새 가입 승인 요청</h1><p>새로운 회원이 가입 승인을 기다리고 있습니다.</p><table style="border-collapse:collapse;width:100%;line-height:1.8"><tr><th style="text-align:left;width:96px">이름</th><td>${escapeHtml(name)}</td></tr><tr><th style="text-align:left">아이디</th><td>${escapeHtml(loginId)}</td></tr><tr><th style="text-align:left">신청 시각</th><td>${escapeHtml(requestedAt)}</td></tr></table><p style="margin:28px 0"><a href="${ADMIN_URL}" style="display:inline-block;padding:13px 20px;background:#3d6450;color:#fff;text-decoration:none;border-radius:9px">가입 신청 확인하기</a></p><p style="font-size:13px;color:#667269">관리자 로그인 후 승인할 수 있습니다.<br>이 메일을 여는 것만으로 승인되지 않습니다.</p></main></body></html>`,
  }
}
type DeliveryResult = {providerId?: string; error?: string; retryable?: boolean}
function smtpFailure(error: unknown): DeliveryResult {
  const err = (error && typeof error === 'object' ? error : {}) as Record<string,unknown>
  const code = String(err.code || ''), command = String(err.command || '').toUpperCase()
  const reply = typeof err.responseCode === 'number' ? err.responseCode : 0
  // In Nodemailer, socket timeout/close errors can say command=CONN even AFTER
  // DATA. Never infer "not delivered" from CONN, ECONNECTION or ETIMEDOUT alone.
  const beforeData = /^(?:EHLO|HELO|AUTH(?: .*)?|MAIL FROM|RCPT TO)$/.test(command)
  if (code === 'EDNS' || (err.syscall === 'connect' && command === 'CONN')
      || (beforeData && reply >= 400 && reply < 500)) return {error:'smtp_before_data_temporary',retryable:true}
  if (code === 'EAUTH') return {error:'smtp_auth_failed',retryable:false}
  if (reply >= 400 && reply < 600 && (beforeData || command === 'DATA')) return {error:'smtp_rejected',retryable:false}
  return {error:'smtp_delivery_uncertain',retryable:false}
}
function gmailTransport(password: string) {
  return nodemailer.createTransport({
    host:'smtp.gmail.com',port:465,secure:true,pool:false,
    auth:{user:ADMIN_RECIPIENT,pass:password},
    tls:{minVersion:'TLSv1.2',rejectUnauthorized:true,servername:'smtp.gmail.com'},
    dnsTimeout:5000,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,
    logger:false,debug:false,transactionLog:false,disableFileAccess:true,disableUrlAccess:true,
  })
}
async function sendMessage(transport: ReturnType<typeof gmailTransport>, message: Record<string,unknown>): Promise<DeliveryResult> {
  try {
    const info = await transport.sendMail(message)
    // A local Message-ID alone is not evidence of SMTP acceptance.
    if (Array.isArray(info.accepted) && info.accepted.length === 1 && info.accepted[0] === ADMIN_RECIPIENT
        && Array.isArray(info.rejected) && info.rejected.length === 0 && /^250(?:[ -])/.test(String(info.response || ''))
        && typeof info.messageId === 'string' && info.messageId === message.messageId) return {providerId:info.messageId}
    return {error:'smtp_delivery_uncertain',retryable:false}
  } catch (error) { return smtpFailure(error) }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return response({error:'method_not_allowed'},405)
  const suppliedSecret = req.headers.get('x-growell-worker-secret') || ''
  if (suppliedSecret.length < 32 || suppliedSecret.length > 256) {
    return response({error:'unauthorized'},401)
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return response({error:'notification_not_configured'},503)
  const supabase = createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})
  try {
    const {data:authorized,error} = await supabase.rpc('growell_authorize_signup_notification_worker',{p_secret:suppliedSecret})
    if (error) return response({error:'authorization_unavailable'},503)
    if (authorized !== true) return response({error:'unauthorized'},401)
  } catch { return response({error:'authorization_unavailable'},503) }
  const password = (Deno.env.get('GROWELL_GMAIL_APP_PASSWORD') || '').replace(/ /g,'')
  // A Google app password contains 16 letters. Do not consume queued jobs until
  // it is configured. No domain, Resend key or caller-supplied address is used.
  if (!/^[a-zA-Z]{16}$/.test(password)) {
    return response({error:'notification_not_configured'},503)
  }
  let action = 'process'
  try {
    const raw = await req.text()
    if (raw.length > 1024) return response({error:'invalid_action'},400)
    const input = raw ? JSON.parse(raw) : {}
    if (!input || Array.isArray(input) || typeof input !== 'object') return response({error:'invalid_action'},400)
    action = input.action ?? 'process'
    if (!['process','verify','test'].includes(action)) return response({error:'invalid_action'},400)
  } catch { return response({error:'invalid_action'},400) }
  const transport = gmailTransport(password)
  try {
    if (action === 'verify') {
      // No message or claim: checks TLS and authentication only.
      try { await transport.verify(); return response({ok:true,connectionVerified:true}) }
      catch (error) { return response({error:smtpFailure(error).error,connectionVerified:false},503) }
    }
    if (action === 'test') {
      // Explicit, authenticated self-test. One fixed message, no queue access,
      // no automatic retry, and no recipient/content supplied by the caller.
      const result = await sendMessage(transport,{
        from:`GROWELL <${ADMIN_RECIPIENT}>`,to:[ADMIN_RECIPIENT],envelope:{from:ADMIN_RECIPIENT,to:[ADMIN_RECIPIENT]},
        messageId:`<growell-connection-test-${crypto.randomUUID()}@gmail.com>`,
        subject:'[GROWELL] 승인 알림 연결 테스트',
        text:`GROWELL 가입 승인 알림의 Gmail 연결 테스트입니다.\n실제 가입 신청이나 승인 처리가 아닙니다.\n\n가입 신청 확인: ${ADMIN_URL}\n관리자 로그인 후 승인할 수 있습니다.`,
      })
      return result.providerId ? response({ok:true,accepted:true}) : response({error:result.error,accepted:false,automaticRetry:false},503)
    }
    // One job per invocation bounds Gmail connection time and avoids retrying
    // a different job after a configuration or acknowledgment failure.
    const {data,error} = await supabase.rpc('growell_claim_signup_notification_v2',{
      p_provider:PROVIDER,p_sender:ADMIN_RECIPIENT,p_recipient:ADMIN_RECIPIENT,
    })
    if (error) return response({error:'queue_unavailable',processed:0},503)
    const job = Array.isArray(data) ? data[0] as Job | undefined : undefined
    if (!job) return response({ok:true,processed:0})
    let result: DeliveryResult
    try { result = await sendMessage(transport,notificationMessage(job)) }
    catch { result = {error:'invalid_request',retryable:false} }
    const {data:ack,error:ackError} = await supabase.rpc('growell_finish_signup_notification',{
      p_id:job.id,p_lease_token:job.lease_token,p_provider_id:result.providerId || null,
      p_error:result.error || null,p_retryable:result.retryable === true,
    })
    // A lost acknowledgment leaves sending in place. SQL moves an expired
    // Gmail lease to review; it must NEVER reclaim or resend that message.
    if (ackError || ack !== true) return response({error:'acknowledgment_pending',processed:0},503)
    return response({ok:true,processed:1})
  } catch { return response({error:'worker_unavailable',processed:0},503) }
  finally { try { transport.close() } catch { /* Do not expose transport details. */ } }
})
