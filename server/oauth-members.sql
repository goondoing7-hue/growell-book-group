-- GROWELL social membership and encrypted private-space key vault.
-- Prepared against the inspected production profiles schema on 2026-09-23.
-- Apply as database owner. No existing profile, password, note, or admin role
-- is migrated, merged, overwritten, or deleted by this script.
begin;

create table if not exists public.growell_oauth_vaults (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  profile_id text not null unique references public.profiles(id) on delete cascade,
  envelope jsonb not null,
  created_at bigint not null default ((extract(epoch from now()) * 1000)::bigint),
  constraint growell_oauth_vault_envelope_object check (jsonb_typeof(envelope) = 'object')
);
alter table public.growell_oauth_vaults enable row level security;
revoke all on public.growell_oauth_vaults from public, anon, authenticated;

create or replace function public.growell_oauth_profile()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  member_auth_id uuid := auth.uid();
  member_profile public.profiles%rowtype;
  member_envelope jsonb;
begin
  if member_auth_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not exists (select 1 from auth.identities i where i.user_id=member_auth_id and i.provider in ('google','kakao')) then
    raise exception 'social_identity_required' using errcode='42501';
  end if;
  select * into member_profile from public.profiles where auth_user_id=member_auth_id;
  if not found then return jsonb_build_object('status','new','profile',null,'envelope',null); end if;
  if member_profile.is_deleted then raise exception 'account_deleted' using errcode='42501'; end if;
  select envelope into member_envelope from public.growell_oauth_vaults where auth_user_id=member_auth_id and profile_id=member_profile.id;
  return jsonb_build_object(
    'status',case when member_envelope is null then 'legacy' else 'ready' end,
    'profile',jsonb_build_object('id',member_profile.id,'auth_user_id',member_profile.auth_user_id,'login_id',member_profile.login_id,
      'name',member_profile.name,'is_admin',member_profile.is_admin,'avatar_url',member_profile.avatar_url,
      'pbkdf2_salt',member_profile.pbkdf2_salt,'created_at',member_profile.created_at,'is_deleted',member_profile.is_deleted),
    'envelope',member_envelope
  );
end;
$function$;
revoke all on function public.growell_oauth_profile() from public, anon;
grant execute on function public.growell_oauth_profile() to authenticated;

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
  insert into public.profiles(auth_user_id,login_id,name,is_admin,pbkdf2_salt)
  values(member_auth_id,'social_'||replace(member_auth_id::text,'-',''),btrim(p_name),false,p_salt)
  returning id into member_profile_id;
  insert into public.growell_oauth_vaults(auth_user_id,profile_id,envelope)
  values(member_auth_id,member_profile_id,p_envelope);
  return public.growell_oauth_profile();
end;
$function$;
revoke all on function public.growell_oauth_register(text,text,jsonb) from public, anon;
grant execute on function public.growell_oauth_register(text,text,jsonb) to authenticated;

commit;

-- Staging verification before enabling providers for members:
-- * anon / password-only Auth users cannot execute either operation successfully.
-- * verified Google/Kakao Auth user: status new -> ready; is_admin is false.
-- * repeated/concurrent registration returns the first stored profile/envelope.
-- * a legacy profile remains unchanged and returns legacy, even with matching name/email.
-- * a different user's envelope owner is rejected; raw vault table access is denied.
-- * name/salt/envelope are inserted atomically and rollback together on failure.
