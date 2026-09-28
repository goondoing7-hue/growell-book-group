// Deploy as the separate Supabase Edge Function `signup-notification-worker`.
// verify_jwt=false is required for a dedicated worker secret, checked below.
// Never invoke from the public app; never accept recipients or message content.
import { createClient } from 'npm:@supabase/supabase-js@2'

const ADMIN_RECIPIENT = 'goondoing7@kakao.com'
const ADMIN_URL = 'https://growell-book.vercel.app/#/admin/users'
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
}
function validWorkerSecret(provided: string | null, expected: string | undefined) {
  if (!expected || expected.length < 32 || expected.length > 256 || !provided || provided.length !== expected.length) return false
  let diff = 0
  for (let i=0;i<expected.length;i++) diff |= expected.charCodeAt(i)^provided.charCodeAt(i)
  return diff === 0
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
}
type Job = {
  id: string; lease_token: string; applicant_name: string; login_id: string;
  requested_at: string; sender: string; recipient: string; template_version: number;
}
function notificationMessage(job: Job) {
  if (job.template_version !== 1 || !EMAIL_RE.test(job.sender) || job.recipient !== ADMIN_RECIPIENT) throw new Error('invalid_job')
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
    text:`GROWELL 가입 승인 요청\n\n이름: ${name}\n아이디: ${loginId}\n신청 시각: ${requestedAt}\n\n가입자 목록에서 신청을 확인하고 승인해 주세요.\n${ADMIN_URL}\n\n관리자 로그인 후 승인할 수 있습니다. 이 메일을 여는 것만으로 승인되지 않습니다.`,
    html:`<!doctype html><html lang="ko"><body style="margin:0;background:#f5f5ef;font-family:Arial,sans-serif;color:#20372e"><main style="max-width:520px;margin:32px auto;padding:28px;background:#fff;border:1px solid #dde3d8;border-radius:16px"><p style="color:#3d6450;font-weight:bold;letter-spacing:1px">GROWELL</p><h1 style="font-size:24px;margin:20px 0">새 가입 승인 요청</h1><p>새로운 회원이 가입 승인을 기다리고 있습니다.</p><table style="border-collapse:collapse;width:100%;line-height:1.8"><tr><th style="text-align:left;width:96px">이름</th><td>${escapeHtml(name)}</td></tr><tr><th style="text-align:left">아이디</th><td>${escapeHtml(loginId)}</td></tr><tr><th style="text-align:left">신청 시각</th><td>${escapeHtml(requestedAt)}</td></tr></table><p style="margin:28px 0"><a href="${ADMIN_URL}" style="display:inline-block;padding:13px 20px;background:#3d6450;color:#fff;text-decoration:none;border-radius:9px">가입 신청 확인하기</a></p><p style="font-size:13px;color:#667269">관리자 로그인 후 승인할 수 있습니다.<br>이 메일을 여는 것만으로 승인되지 않습니다.</p></main></body></html>`,
  }
}
async function sendNotification(job: Job, apiKey: string) {
  let message
  try { message = notificationMessage(job) }
  catch { return {error:'invalid_request',retryable:false} }
  try {
    const result = await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`growell-signup-v1/${job.id}`},
      body:JSON.stringify(message),signal:AbortSignal.timeout(8000),
    })
    let data: Record<string,unknown> = {}
    try { data = await result.json() } catch { /* Never log the provider body. */ }
    if (result.ok && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 200) return {providerId:data.id}
    if (result.status === 429) return {error:'rate_limited',retryable:true}
    if (result.status >= 500) return {error:'provider_unavailable',retryable:true}
    if (result.status === 409 && data.name === 'concurrent_idempotent_requests') return {error:'provider_unavailable',retryable:true}
    if (result.status === 409) return {error:'idempotency_conflict',retryable:false}
    if (result.status === 401 || result.status === 403) return {error:'invalid_sender',retryable:false}
    if (result.ok) return {error:'unexpected_response',retryable:true}
    return {error:'provider_rejected',retryable:false}
  } catch { return {error:'network_error',retryable:true} }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return response({error:'method_not_allowed'},405)
  if (!validWorkerSecret(req.headers.get('x-growell-worker-secret'),Deno.env.get('GROWELL_NOTIFICATION_WORKER_SECRET'))) {
    return response({error:'unauthorized'},401)
  }
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const sender = Deno.env.get('GROWELL_SIGNUP_FROM')?.trim() || ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  // A verified sender domain is required. Testing-only resend.dev addresses are
  // intentionally not silently selected for the administrator's real inbox.
  if (!apiKey || !EMAIL_RE.test(sender) || /@resend\.dev$/i.test(sender) || !supabaseUrl || !serviceKey) {
    return response({error:'notification_not_configured'},503)
  }
  const supabase = createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})
  let processed = 0
  try {
    // Four bounded sequential sends avoid unbounded load and stay within one
    // short invocation. Each claimed row gets its own two-minute lease.
    for (let i=0;i<4;i++) {
      const {data,error} = await supabase.rpc('growell_claim_signup_notification',{p_sender:sender,p_recipient:ADMIN_RECIPIENT})
      if (error) return response({error:'queue_unavailable',processed},503)
      const job = Array.isArray(data) ? data[0] as Job | undefined : undefined
      if (!job) break
      const result = await sendNotification(job,apiKey)
      const {data:ack,error:ackError} = await supabase.rpc('growell_finish_signup_notification',{
        p_id:job.id,p_lease_token:job.lease_token,p_provider_id:result.providerId || null,
        p_error:result.error || null,p_retryable:result.retryable === true,
      })
      // If acknowledgment fails, retain the lease and retry using the same
      // idempotency key. Do not invent a new delivery ID or immediately resend.
      if (ackError || ack !== true) return response({error:'acknowledgment_pending',processed},503)
      processed++
    }
    return response({ok:true,processed})
  } catch { return response({error:'worker_unavailable',processed},503) }
})
