// GROWELL signup: profile photo required; every new application awaits approval.
// Service credentials are supplied by the existing Supabase runtime only.
import { createClient } from 'npm:@supabase/supabase-js@2'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'bad_json' }, 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_json' }, 400)
  const input = body as Record<string, unknown>
  if (typeof input.loginId !== 'string' || typeof input.name !== 'string') return json({ error: 'missing_fields' }, 400)
  const loginId = input.loginId.trim().toLowerCase()
  const name = input.name.trim()
  const password = input.password
  const salt = input.salt
  const pwHint = typeof input.pwHint === 'string' ? input.pwHint.trim() : ''
  if (!loginId || !name || !password || !salt) return json({ error: 'missing_fields' }, 400)
  if (!pwHint) return json({ error: 'missing_hint' }, 400)
  if (pwHint.length > 1024) return json({ error: 'invalid_hint' }, 400)
  if (!/^[a-z0-9_-]{1,64}$/i.test(loginId)) return json({ error: 'invalid_id_format' }, 400)
  if (name.length > 30) return json({ error: 'invalid_name' }, 400)
  if (typeof password !== 'string' || password.length < 8) return json({ error: 'weak_password' }, 400)
  if (password.length > 1024) return json({ error: 'invalid_password' }, 400)
  if (typeof salt !== 'string' || !/^[a-f0-9]{32}$/.test(salt)) return json({ error: 'invalid_salt' }, 400)
  if (typeof input.avatarDataUrl !== 'string' || !input.avatarDataUrl) return json({ error: 'missing_avatar' }, 400)
  const image = /^data:image\/(jpeg|png|webp|gif);base64,([a-z0-9+/]+={0,2})$/i.exec(input.avatarDataUrl)
  if (!image || image[2].length > 8 * 1024 * 1024) return json({ error: 'invalid_avatar' }, 400)
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(image[2]), c => c.charCodeAt(0))
    if (!bytes.length) return json({ error: 'invalid_avatar' }, 400)
  } catch { return json({ error: 'invalid_avatar' }, 400) }
  // Validate the declared image's signature before creating any account.
  const type = image[1].toLowerCase()
  const valid = type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'png' ? [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)
    : type === 'gif' ? String.fromCharCode(...bytes.slice(0,6)).match(/^GIF8[79]a$/)
    : String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP'
  if (!valid) return json({ error: 'invalid_avatar' }, 400)
  let supabase: ReturnType<typeof createClient> | null = null
  // Set only from a successful createUser response. Never look up an existing
  // Auth ID for compensation: failures must not delete an existing account.
  let createdAuthId: string | null = null
  let createdProfileId: string | null = null
  let avatarPath: string | null = null
  async function failAfterCreation(error: string) {
    let cleanupComplete = true
    async function attempt(work: () => PromiseLike<{ error?: unknown }>) {
      try { if ((await work())?.error) cleanupComplete = false } catch { cleanupComplete = false }
    }
    if (supabase && createdAuthId) {
      const client = supabase
      const authId = createdAuthId
      if (createdProfileId) {
        const profileId = createdProfileId
        await attempt(() => client.from('profile_secrets').delete().eq('user_id', profileId))
      }
      if (avatarPath) {
        const path = avatarPath
        await attempt(() => client.storage.from('avatars').remove([path]))
      }
      // This also handles an uncertain profile INSERT response: only the Auth
      // user created by this request can have this freshly generated UUID.
      await attempt(() => client.from('profiles').delete().eq('auth_user_id', authId))
      await attempt(() => client.auth.admin.deleteUser(authId))
    }
    return json({ error, ...(cleanupComplete ? {} : { cleanupRequired: true }) }, 500)
  }
  try {
    supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: existing, error: lookupError } = await supabase.from('profiles').select('id').eq('login_id', loginId).maybeSingle()
    if (lookupError) return json({ error: 'lookup_failed' }, 500)
    if (existing) return json({ error: 'duplicate_id' }, 409)
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: `${loginId}@growell.internal`, password, email_confirm: true,
      user_metadata: { login_id: loginId, name },
    })
    if (createError || !created?.user) return json({ error: 'create_failed' }, 400)
    createdAuthId = created.user.id
    avatarPath = `${createdAuthId}/avatar.${type}`
    const { error: uploadError } = await supabase.storage.from('avatars').upload(avatarPath, bytes, { contentType: `image/${type}`, upsert: false })
    if (uploadError) return await failAfterCreation('avatar_upload_failed')
    const avatarUrl = supabase.storage.from('avatars').getPublicUrl(avatarPath).data.publicUrl
    const { data: profile, error: profileError } = await supabase.from('profiles').insert({
      auth_user_id: createdAuthId, login_id: loginId, name, is_admin: false,
      avatar_url: avatarUrl, pbkdf2_salt: salt, approval_status: 'pending',
    }).select().single()
    if (profileError || !profile?.id || profile.auth_user_id !== createdAuthId
        || profile.approval_status !== 'pending' || profile.is_admin !== false) {
      return await failAfterCreation('profile_failed')
    }
    createdProfileId = profile.id
    // Required hint and notification outbox are one transaction. The scheduled
    // worker sends later; delivery failures never roll back a valid signup.
    const { data: finalized, error: hintError } = await supabase.rpc('growell_finalize_signup', {
      p_profile_id: profile.id, p_auth_user_id: createdAuthId, p_pw_hint: pwHint,
    })
    if (hintError || finalized?.hintSaved !== true || finalized?.notificationQueued !== true) return await failAfterCreation('hint_save_failed')
    return json({ ok: true, pendingApproval: true, profile, hintSaved: true })
  } catch {
    return await failAfterCreation('signup_unavailable')
  }
})
