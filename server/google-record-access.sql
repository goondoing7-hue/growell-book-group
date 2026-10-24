-- Google-only access to the SAME existing private-record key on another device.
-- Requires Supabase Vault 0.3.1 (already installed); never enable extensions,
-- expose Vault, infer a password, or replace a member's key during deployment.
-- Existing OAuth v1 envelopes/history and all member content remain untouched.
begin;

do $preconditions$
begin
  if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
    or to_regclass('vault.decrypted_secrets') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.growell_oauth_vaults') is null
    or to_regclass('public.growell_signup_notifications') is null then
    raise exception 'Existing Vault and member enrollment contracts required';
  end if;
end;
$preconditions$;

create schema if not exists growell_record_access_private;
revoke all on schema growell_record_access_private from public,anon,authenticated,service_role;

-- No cascading FKs: account deletion must block access, not permanently erase
-- recoverable key material or introduce a new dependency in delete-account.
create table if not exists public.growell_google_record_access (
  auth_user_id uuid primary key,
  profile_id text not null unique,
  profile_salt text not null check (profile_salt ~ '^[a-fA-F0-9]{32}$'),
  key_digest text not null check (key_digest ~ '^[a-f0-9]{64}$'),
  vault_secret_id uuid not null unique,
  context text not null,
  created_at timestamptz not null default now()
);
alter table public.growell_google_record_access enable row level security;
revoke all on public.growell_google_record_access from public,anon,authenticated,service_role;

create table if not exists public.growell_google_record_access_history (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  profile_id text not null,
  profile_salt text not null,
  key_digest text not null,
  vault_secret_id uuid not null,
  context text not null,
  replacement_secret_id uuid not null,
  replacement_digest text not null,
  replaced_at timestamptz not null default now(),
  unique(auth_user_id,vault_secret_id)
);
alter table public.growell_google_record_access_history enable row level security;
revoke all on public.growell_google_record_access_history from public,anon,authenticated,service_role;

-- Fail closed if an earlier browser-role grant could expose a new secret.
-- service_role is a trusted server/database administrator in the Vault custody
-- model, not a browser role. Retain its existing worker privileges unchanged.
create or replace function growell_record_access_private.assert_vault_private()
returns void language plpgsql security invoker set search_path = ''
as $function$
declare app_role text;
begin
  foreach app_role in array array['anon','authenticated'] loop
    if has_table_privilege(app_role,'vault.secrets','SELECT')
      or has_any_column_privilege(app_role,'vault.secrets','SELECT')
      or has_table_privilege(app_role,'vault.decrypted_secrets','SELECT')
      or has_any_column_privilege(app_role,'vault.decrypted_secrets','SELECT')
      or (has_schema_privilege(app_role,'vault','USAGE') and exists(
        select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='vault' and has_function_privilege(app_role,p.oid,'EXECUTE')
      )) then
      raise exception 'record_access_vault_permissions' using errcode='42501';
    end if;
  end loop;
end;
$function$;
revoke all on function growell_record_access_private.assert_vault_private() from public,anon,authenticated,service_role;

select growell_record_access_private.assert_vault_private();

create or replace function growell_record_access_private.verified_auth()
returns uuid language plpgsql security invoker set search_path = ''
as $function$
declare
  owner_id uuid := auth.uid();
  claims jsonb := auth.jwt();
  session_text text := claims->>'session_id';
  identity_value jsonb;
  auth_value jsonb;
begin
  if owner_id is null or claims->>'role' is distinct from 'authenticated'
    or claims->>'sub' is distinct from owner_id::text
    or coalesce(claims->'is_anonymous','false'::jsonb) is distinct from 'false'::jsonb then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  if coalesce(claims->>'exp','') !~ '^[0-9]{1,12}$'
    or (claims->>'exp')::numeric <= extract(epoch from statement_timestamp()) then
    raise exception 'current_session_required' using errcode='42501';
  end if;
  if session_text is null or session_text !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
    raise exception 'current_session_required' using errcode='42501';
  end if;
  perform 1 from auth.sessions s where s.id=session_text::uuid and s.user_id=owner_id
    and ((to_jsonb(s)->>'not_after') is null or (to_jsonb(s)->>'not_after')::timestamptz>statement_timestamp()) for share;
  if not found then raise exception 'current_session_required' using errcode='42501'; end if;
  select to_jsonb(u) into auth_value from auth.users u where u.id=owner_id for share;
  if not found or auth_value->>'deleted_at' is not null
    or (auth_value->>'banned_until' is not null and (auth_value->>'banned_until')::timestamptz>statement_timestamp()) then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  begin
    select to_jsonb(i) into strict identity_value from auth.identities i
      where i.user_id=owner_id and i.provider='google' for share;
  exception when no_data_found or too_many_rows then
    raise exception 'google_identity_required' using errcode='42501';
  end;
  if coalesce(identity_value#>>'{identity_data,sub}','') !~ '^[A-Za-z0-9_-]{1,255}$'
    or identity_value->>'provider_id' is distinct from identity_value#>>'{identity_data,sub}' then
    raise exception 'google_identity_required' using errcode='42501';
  end if;
  perform growell_record_access_private.assert_vault_private();
  return owner_id;
end;
$function$;
revoke all on function growell_record_access_private.verified_auth() from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.member()
returns public.profiles language plpgsql security invoker set search_path = ''
as $function$
declare owner_id uuid := growell_record_access_private.verified_auth(); member public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,73491));
  select * into member from public.profiles where auth_user_id=owner_id for share;
  if not found or member.is_deleted is distinct from false
    or member.approval_status is distinct from 'approved'
    or coalesce(member.pbkdf2_salt,'') !~ '^[a-fA-F0-9]{32}$' then
    raise exception 'approved_member_required' using errcode='42501';
  end if;
  return member;
end;
$function$;
revoke all on function growell_record_access_private.member() from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.profile_json(member public.profiles)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  select jsonb_build_object('id',member.id,'auth_user_id',member.auth_user_id,'login_id',member.login_id,
    'name',member.name,'is_admin',member.is_admin,'avatar_url',member.avatar_url,
    'pbkdf2_salt',member.pbkdf2_salt,'created_at',member.created_at,'is_deleted',member.is_deleted,
    'approval_status',member.approval_status,'approved_at',member.approved_at,'approved_by',member.approved_by);
$function$;
revoke all on function growell_record_access_private.profile_json(public.profiles) from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.key_digest(material text)
returns text language plpgsql immutable security invoker set search_path = ''
as $function$
declare raw_key bytea;
begin
  if material is null or material !~ '^[A-Za-z0-9+/]{43}=$' then
    raise exception 'invalid_record_access_key' using errcode='22023';
  end if;
  begin raw_key:=decode(material,'base64'); exception when others then
    raise exception 'invalid_record_access_key' using errcode='22023';
  end;
  if octet_length(raw_key)<>32 or encode(raw_key,'base64')<>material then
    raise exception 'invalid_record_access_key' using errcode='22023';
  end if;
  return encode(sha256(raw_key),'hex');
end;
$function$;
revoke all on function growell_record_access_private.key_digest(text) from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.key_context(owner_id uuid,profile_id text,profile_salt text,key_digest text)
returns text language sql immutable security invoker set search_path = ''
as $function$
  select jsonb_build_array('growell-google-record-access-v1',1,owner_id::text,profile_id,profile_salt,key_digest)::text;
$function$;
revoke all on function growell_record_access_private.key_context(uuid,text,text,text) from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.store_key(member public.profiles,material text,digest_value text)
returns public.growell_google_record_access language plpgsql security invoker set search_path = ''
as $function$
declare saved public.growell_google_record_access%rowtype; payload jsonb;
begin
  saved.auth_user_id:=member.auth_user_id;saved.profile_id:=member.id;saved.profile_salt:=member.pbkdf2_salt;saved.key_digest:=digest_value;
  saved.context:=growell_record_access_private.key_context(saved.auth_user_id,saved.profile_id,saved.profile_salt,saved.key_digest);
  -- Vault authenticates its ciphertext. These authenticated payload fields bind
  -- its contents to the exact owner/profile/salt/digest/context on readback;
  -- Vault does not offer caller-supplied associated-data parameters.
  payload:=jsonb_build_object('format','growell-google-record-access-v1','version',1,'owner',saved.auth_user_id::text,
    'profileId',saved.profile_id,'profileSalt',saved.profile_salt,'keyDigest',saved.key_digest,'aad',saved.context,'keyB64',material);
  -- Official Vault API: plaintext exists during trusted database processing.
  -- This is encrypted storage, not zero-knowledge or a zero-plaintext-WAL claim.
  begin
    saved.vault_secret_id:=vault.create_secret(payload::text,null,'GROWELL owner-only private-record access',null);
  exception when others then
    raise exception 'record_access_store_unavailable' using errcode='55000';
  end;
  saved.created_at:=now();return saved;
end;
$function$;
revoke all on function growell_record_access_private.store_key(public.profiles,text,text) from public,anon,authenticated,service_role;

create or replace function growell_record_access_private.open_key(saved public.growell_google_record_access,member public.profiles)
returns jsonb language plpgsql security invoker set search_path = ''
as $function$
declare payload jsonb; plaintext text; expected_context text; actual_digest text;
begin
  if saved.auth_user_id is distinct from member.auth_user_id or saved.profile_id is distinct from member.id
    or saved.profile_salt is distinct from member.pbkdf2_salt then
    raise exception 'record_access_profile_changed' using errcode='42501';
  end if;
  expected_context:=growell_record_access_private.key_context(member.auth_user_id,member.id,member.pbkdf2_salt,saved.key_digest);
  if saved.context is distinct from expected_context then raise exception 'record_access_corrupt' using errcode='22023'; end if;
  begin
    select decrypted_secret into strict plaintext from vault.decrypted_secrets where id=saved.vault_secret_id;
    payload:=plaintext::jsonb;
  exception when others then raise exception 'record_access_corrupt' using errcode='22023';
  end;
  if jsonb_typeof(payload) is distinct from 'object'
    or payload - array['format','version','owner','profileId','profileSalt','keyDigest','aad','keyB64']::text[]<>'{}'::jsonb
    or payload->>'format' is distinct from 'growell-google-record-access-v1' or payload->'version' is distinct from '1'::jsonb
    or payload->>'owner' is distinct from member.auth_user_id::text or payload->>'profileId' is distinct from member.id
    or payload->>'profileSalt' is distinct from member.pbkdf2_salt or payload->>'keyDigest' is distinct from saved.key_digest
    or payload->>'aad' is distinct from expected_context then
    raise exception 'record_access_corrupt' using errcode='22023';
  end if;
  actual_digest:=growell_record_access_private.key_digest(payload->>'keyB64');
  if actual_digest is distinct from saved.key_digest then raise exception 'record_access_corrupt' using errcode='22023'; end if;
  return jsonb_build_object('status','ready','version',1,'profile',growell_record_access_private.profile_json(member),
    'keyB64',payload->>'keyB64','keyDigest',actual_digest,'accessId',saved.vault_secret_id::text);
end;
$function$;
revoke all on function growell_record_access_private.open_key(public.growell_google_record_access,public.profiles) from public,anon,authenticated,service_role;

create or replace function public.growell_google_record_access_get()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare member public.profiles := growell_record_access_private.member(); saved public.growell_google_record_access%rowtype;
begin
  select * into saved from public.growell_google_record_access where auth_user_id=member.auth_user_id;
  if not found then return jsonb_build_object('status','missing','version',1,'profile',growell_record_access_private.profile_json(member),'keyB64',null,'keyDigest',null,'accessId',null); end if;
  return growell_record_access_private.open_key(saved,member);
end;
$function$;
revoke all on function public.growell_google_record_access_get() from public,anon,authenticated,service_role;
grant execute on function public.growell_google_record_access_get() to authenticated;

create or replace function public.growell_google_record_access_prepare(p_profile_id text,p_salt text,p_key_b64 text,p_key_digest text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare member public.profiles := growell_record_access_private.member(); saved public.growell_google_record_access%rowtype; actual_digest text;
begin
  if p_profile_id is distinct from member.id or p_salt is distinct from member.pbkdf2_salt then raise exception 'record_access_profile_changed' using errcode='42501'; end if;
  actual_digest:=growell_record_access_private.key_digest(p_key_b64);
  if p_key_digest is null or p_key_digest !~ '^[a-f0-9]{64}$' or p_key_digest<>actual_digest then raise exception 'invalid_record_access_digest' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(member.auth_user_id::text,73491));
  select * into saved from public.growell_google_record_access where auth_user_id=member.auth_user_id for update;
  if found then
    if saved.key_digest<>actual_digest then raise exception 'record_access_key_conflict' using errcode='40001'; end if;
    -- Compare the actual stored key too; a matching metadata fingerprint alone
    -- never authorizes a stale/corrupt/foreign Vault secret.
    if growell_record_access_private.open_key(saved,member)->>'keyB64' is distinct from p_key_b64 then raise exception 'record_access_key_conflict' using errcode='40001'; end if;
    return growell_record_access_private.open_key(saved,member);
  end if;
  saved:=growell_record_access_private.store_key(member,p_key_b64,actual_digest);
  insert into public.growell_google_record_access select saved.*;
  return growell_record_access_private.open_key(saved,member);
end;
$function$;
revoke all on function public.growell_google_record_access_prepare(text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.growell_google_record_access_prepare(text,text,text,text) to authenticated;

-- New Google applicants never need an extra private password. A key is minted
-- by the client ONLY after the verified profile lookup says new; this atomic
-- first write retains the winning key on retries and never changes old profiles.
create or replace function public.growell_google_register(p_name text,p_salt text,p_key_b64 text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare owner_id uuid := growell_record_access_private.verified_auth(); member public.profiles%rowtype; saved public.growell_google_record_access%rowtype; digest_value text;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,73491));
  select * into member from public.profiles where auth_user_id=owner_id for update;
  if found then
    if member.is_deleted is distinct from false then raise exception 'approved_member_required' using errcode='42501'; end if;
    if member.approval_status='approved' then return public.growell_google_record_access_get(); end if;
    return jsonb_build_object('status','approval-required','version',1,'profile',growell_record_access_private.profile_json(member),'keyB64',null,'keyDigest',null,'accessId',null);
  end if;
  if exists(select 1 from public.growell_google_record_access where auth_user_id=owner_id)
    or exists(select 1 from public.growell_google_record_access_history where auth_user_id=owner_id)
    or exists(select 1 from public.growell_oauth_vaults where auth_user_id=owner_id) then
    raise exception 'record_access_existing_owner' using errcode='42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 30 then raise exception 'invalid_display_name' using errcode='22023'; end if;
  if p_salt is null or p_salt !~ '^[a-f0-9]{32}$' then raise exception 'invalid_salt' using errcode='22023'; end if;
  digest_value:=growell_record_access_private.key_digest(p_key_b64);
  insert into public.profiles(auth_user_id,login_id,name,is_admin,pbkdf2_salt,approval_status)
    values(owner_id,'social_'||replace(owner_id::text,'-',''),btrim(p_name),false,p_salt,'pending') returning * into member;
  if member.auth_user_id<>owner_id or member.is_admin is distinct from false or member.approval_status is distinct from 'pending'
    or member.pbkdf2_salt is distinct from p_salt or member.is_deleted is distinct from false then
    raise exception 'record_access_enrollment_changed' using errcode='42501';
  end if;
  saved:=growell_record_access_private.store_key(member,p_key_b64,digest_value);
  insert into public.growell_google_record_access select saved.*;
  insert into public.growell_signup_notifications(profile_id,applicant_name,login_id) values(member.id,member.name,member.login_id) on conflict(profile_id) do nothing;
  return jsonb_build_object('status','approval-required','version',1,'profile',growell_record_access_private.profile_json(member),'keyB64',null,'keyDigest',null,'accessId',null);
end;
$function$;
revoke all on function public.growell_google_register(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.growell_google_register(text,text,text) to authenticated;

-- Reserved for the client callback AFTER a completed native-password recovery
-- and successful read-only proof of every own private record with the new key.
-- A normal prepare conflict must NEVER automatically invoke this operation.
drop function if exists public.growell_google_record_access_rotate(text,text,text,text,text);
create or replace function public.growell_google_record_access_rotate(p_profile_id text,p_salt text,p_expected_digest text,p_key_b64 text,p_key_digest text,p_expected_access_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare member public.profiles := growell_record_access_private.member(); claims jsonb := auth.jwt();
  saved public.growell_google_record_access%rowtype; replacement public.growell_google_record_access%rowtype; actual_digest text; now_epoch numeric:=extract(epoch from statement_timestamp());
begin
  if p_profile_id is distinct from member.id or p_salt is distinct from member.pbkdf2_salt then raise exception 'record_access_profile_changed' using errcode='42501'; end if;
  if jsonb_typeof(claims->'amr') is distinct from 'array' or not exists(select 1 from jsonb_array_elements(claims->'amr') method
    where method->>'method'='password' and case when coalesce(method->>'timestamp','') ~ '^[0-9]{1,12}$'
      then (method->>'timestamp')::numeric between now_epoch-600 and now_epoch+60 else false end)
    or not exists(select 1 from auth.identities where user_id=member.auth_user_id and provider='email') then
    raise exception 'recent_password_authentication_required' using errcode='42501';
  end if;
  actual_digest:=growell_record_access_private.key_digest(p_key_b64);
  if p_key_digest is null or p_key_digest !~ '^[a-f0-9]{64}$' or p_key_digest<>actual_digest
    or p_expected_digest is null or p_expected_digest !~ '^[a-f0-9]{64}$' or p_expected_access_id is null then raise exception 'invalid_record_access_digest' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(member.auth_user_id::text,73491));
  select * into saved from public.growell_google_record_access where auth_user_id=member.auth_user_id for update;
  if not found then raise exception 'record_access_missing' using errcode='40001'; end if;
  perform growell_record_access_private.open_key(saved,member);
  if saved.key_digest=actual_digest then
    if (p_expected_digest<>saved.key_digest or p_expected_access_id<>saved.vault_secret_id) and not exists(select 1 from public.growell_google_record_access_history h
      where h.auth_user_id=member.auth_user_id and h.profile_id=member.id and h.key_digest=p_expected_digest and h.vault_secret_id=p_expected_access_id
        and h.replacement_secret_id=saved.vault_secret_id and h.replacement_digest=actual_digest) then
      raise exception 'record_access_key_conflict' using errcode='40001';
    end if;
    if growell_record_access_private.open_key(saved,member)->>'keyB64' is distinct from p_key_b64 then raise exception 'record_access_key_conflict' using errcode='40001'; end if;
    return growell_record_access_private.open_key(saved,member);
  end if;
  if saved.key_digest<>p_expected_digest or saved.vault_secret_id<>p_expected_access_id then raise exception 'record_access_key_conflict' using errcode='40001'; end if;
  replacement:=growell_record_access_private.store_key(member,p_key_b64,actual_digest);
  insert into public.growell_google_record_access_history(auth_user_id,profile_id,profile_salt,key_digest,vault_secret_id,context,replacement_secret_id,replacement_digest)
    values(saved.auth_user_id,saved.profile_id,saved.profile_salt,saved.key_digest,saved.vault_secret_id,saved.context,replacement.vault_secret_id,replacement.key_digest);
  update public.growell_google_record_access set key_digest=replacement.key_digest,vault_secret_id=replacement.vault_secret_id,context=replacement.context
    where auth_user_id=member.auth_user_id and profile_id=member.id and profile_salt=member.pbkdf2_salt and key_digest=p_expected_digest and vault_secret_id=p_expected_access_id;
  if not found then raise exception 'record_access_key_conflict' using errcode='40001'; end if;
  return growell_record_access_private.open_key(replacement,member);
end;
$function$;
revoke all on function public.growell_google_record_access_rotate(text,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.growell_google_record_access_rotate(text,text,text,text,text,uuid) to authenticated;

commit;
