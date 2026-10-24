-- Apply after approval/optional-photo/notification/vault contracts exist.
-- Replaces only new-enrollment functions. No existing row or identity is updated.
begin;
do $preconditions$
begin
  if to_regclass('public.growell_signup_notifications') is null
    or to_regprocedure('public.growell_guard_member_approval()') is null
    or to_regprocedure('public.growell_oauth_profile()') is null then
    raise exception 'Existing membership approval and notification contracts required';
  end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.growell_before_user_created(jsonb)')
    and md5(replace(prosrc,E'\r\n',E'\n')) in ('6f0fc3f93a60a6dfe4aee8413d8397b6','e441ed8c319d1b059e093ad55ab26cab')) then
    raise exception 'Enrollment definition changed; inspect growell_before_user_created before applying';
  end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.growell_oauth_register(text,text,jsonb)')
    and md5(replace(prosrc,E'\r\n',E'\n')) in ('7ba074ce592cb7832b8fc0be8c8d07ab','d76263fb99cfcbbaf5a6a9b23622b472')) then
    raise exception 'Enrollment definition changed; inspect growell_oauth_register before applying';
  end if;
end;
$preconditions$;
-- New Auth creation is Google-only. Login/linking of an existing Auth UUID
-- never creates a user. Only Auth-supplied app_metadata is inspected here.
create or replace function public.growell_before_user_created(event jsonb)
returns jsonb language sql immutable security invoker set search_path = ''
as $function$
  select case when lower(event#>>'{user,app_metadata,provider}')='google'
    and coalesce((event#>>'{user,is_anonymous}')::boolean,false)=false
    then '{}'::jsonb
    else jsonb_build_object('error',jsonb_build_object('http_code',403,
      'message','새 회원가입은 Google 계정으로 진행해주세요.')) end;
$function$;
revoke all on function public.growell_before_user_created(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.growell_before_user_created(jsonb) to supabase_auth_admin;

create or replace function public.growell_oauth_register(p_name text,p_salt text,p_envelope jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  member_auth_id uuid := auth.uid();
  member_profile_id text;
  current_status jsonb;
  iv_bytes bytea;
  cipher_bytes bytea;
begin
  if member_auth_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not exists (select 1 from auth.identities i where i.user_id=member_auth_id and i.provider in ('google','kakao')) then
    raise exception 'social_identity_required' using errcode='42501';
  end if;
  -- Serialize first registration/retries from two tabs of the same account.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(member_auth_id::text, 0));
  current_status := public.growell_oauth_profile();
  if current_status->>'status' <> 'new' then return current_status; end if;
  if not exists(select 1 from auth.identities i where i.user_id=member_auth_id and i.provider='google') then
    raise exception 'google_signup_required' using errcode='42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 30 then
    raise exception 'invalid_display_name' using errcode='22023';
  end if;
  if p_salt is null or p_salt !~ '^[a-f0-9]{32}$' then raise exception 'invalid_salt' using errcode='22023'; end if;
  if jsonb_typeof(p_envelope) is distinct from 'object'
     or octet_length(p_envelope::text)>8192
     or p_envelope->>'format' is distinct from 'growell-oauth-vault-v1'
     or p_envelope->>'version' is distinct from '1'
     or p_envelope->>'owner' is distinct from member_auth_id::text
     or p_envelope#>>'{kdf,name}' is distinct from 'PBKDF2'
     or p_envelope#>>'{kdf,hash}' is distinct from 'SHA-256'
     or p_envelope#>>'{kdf,iterations}' is distinct from '150000'
     or p_envelope#>>'{kdf,salt}' is distinct from p_salt
     or coalesce(p_envelope->>'iv','') !~ '^[A-Za-z0-9+/]+={0,2}$'
     or coalesce(p_envelope->>'data','') !~ '^[A-Za-z0-9+/]+={0,2}$'
  then raise exception 'invalid_private_key_envelope' using errcode='22023'; end if;
  begin
    iv_bytes := pg_catalog.decode(p_envelope->>'iv','base64');
    cipher_bytes := pg_catalog.decode(p_envelope->>'data','base64');
  exception when others then raise exception 'invalid_private_key_encoding' using errcode='22023';
  end;
  if octet_length(iv_bytes)<>12 or octet_length(cipher_bytes) not between 17 and 3072 then
    raise exception 'invalid_private_key_size' using errcode='22023';
  end if;
  -- Deliberately no email/name matching and no caller-supplied id or admin flag.
  -- A pre-existing general account always returns status=legacy above.
  insert into public.profiles(auth_user_id,login_id,name,is_admin,pbkdf2_salt,approval_status)
  values(member_auth_id,'social_'||replace(member_auth_id::text,'-',''),btrim(p_name),false,p_salt,'pending')
  returning id into member_profile_id;
  insert into public.growell_oauth_vaults(auth_user_id,profile_id,envelope)
  values(member_auth_id,member_profile_id,p_envelope);
  insert into public.growell_signup_notifications(profile_id,applicant_name,login_id)
  select p.id,p.name,p.login_id from public.profiles p where p.id=member_profile_id
  on conflict(profile_id) do nothing;
  return public.growell_oauth_profile();
end;
$function$;
revoke all on function public.growell_oauth_register(text,text,jsonb) from public, anon;
grant execute on function public.growell_oauth_register(text,text,jsonb) to authenticated;


commit;
