-- GROWELL membership approval. Run as the database owner in a maintenance window.
-- Review the live signup Edge Function first: it must store the submitted avatar
-- before returning success, clean up failed Auth signups, and never auto-approve.
-- Existing accounts are grandfathered once; new accounts always start pending.
-- Before COMMIT, run member-approval-verification.sql in a rollback-only batch.
begin;

do $guard$
begin
  if not exists (
    select 1 from pg_class c join pg_roles r on r.rolname=current_user
    where c.oid='public.profiles'::regclass
      and (r.rolsuper or r.rolbypassrls or (c.relowner=r.oid and not c.relforcerowsecurity))
  ) then raise exception 'Run as profiles owner with RLS bypass'; end if;
  if to_regprocedure('public.growell_is_active_member()') is null then
    raise exception 'Apply and verify member-read-policy.sql first';
  end if;
end
$guard$;

-- No re-approval on subsequent deployments: only a newly added column gets the
-- legacy default. PostgreSQL preserves that value for existing rows when the
-- default is subsequently changed, avoiding an UPDATE of existing profiles.
do $columns$
begin
  if not exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='approval_status') then
    alter table public.profiles add column approval_status text not null default 'approved';
    alter table public.profiles alter column approval_status set default 'pending';
    alter table public.profiles add constraint profiles_approval_status_check
      check (approval_status in ('pending','approved','rejected'));
  end if;
end
$columns$;
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists approved_by text;

create or replace function public.growell_is_active_member()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.profiles p
    where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
      and p.approval_status='approved'
  );
$function$;
revoke all on function public.growell_is_active_member() from public,anon,authenticated;
grant execute on function public.growell_is_active_member() to anon,authenticated;

create or replace function public.growell_is_approved_admin()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.profiles p
    where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
      and p.is_admin=true and p.approval_status='approved'
  );
$function$;
revoke all on function public.growell_is_approved_admin() from public,anon,authenticated;
grant execute on function public.growell_is_approved_admin() to anon,authenticated;

-- Preserve the legacy helper name used by existing table policies/RPCs while
-- making its administrator result depend on approval as well.
create or replace function public.is_current_user_admin()
returns boolean language sql stable security invoker set search_path = ''
as $function$
  select public.growell_is_approved_admin();
$function$;

create or replace function public.growell_guard_member_approval()
returns trigger language plpgsql set search_path = ''
as $function$
begin
  if TG_OP='INSERT' then
    if char_length(btrim(coalesce(new.avatar_url,'')))=0 then
      raise exception 'Profile photo required' using errcode='22023';
    end if;
    -- Includes service-role signup and the legacy administrator-code path.
    -- Registration and approval are separate operations, even for new admins.
    new.approval_status:='pending';
    new.is_admin:=false;
    new.approved_at:=null;
    new.approved_by:=null;
  elsif row(new.approval_status,new.approved_at,new.approved_by)
      is distinct from row(old.approval_status,old.approved_at,old.approved_by) then
    -- Trusted maintenance without an end-user JWT remains possible. A client
    -- cannot gain this by SET ROLE; PostgREST uses the authenticated DB role.
    if not (auth.uid() is null and exists(select 1 from pg_roles r join pg_class c on c.oid='public.profiles'::regclass
      where r.rolname=current_user and (r.rolsuper or r.rolbypassrls or (c.relowner=r.oid and not c.relforcerowsecurity))))
      and not public.growell_is_approved_admin() then
      raise exception 'Administrator approval required' using errcode='42501';
    end if;
  end if;
  -- Legacy service-role grant-admin endpoints cannot promote pending/rejected
  -- accounts, even when an applicant knows the existing administrator code.
  if new.is_admin and new.approval_status<>'approved' then
    raise exception 'Approval required before administrator access' using errcode='42501';
  end if;
  return new;
end
$function$;
revoke all on function public.growell_guard_member_approval() from public,anon,authenticated;
drop trigger if exists growell_guard_member_approval on public.profiles;
create trigger growell_guard_member_approval before insert or update on public.profiles
  for each row execute function public.growell_guard_member_approval();

-- Retain existing permissive ownership policies, and add a membership condition
-- to reads AND writes. Pending users can read only their own profile for login.
do $policies$
declare table_name text;
begin
  foreach table_name in array array['posts','comments','material_notes','worksheets',
    'reading_meta','reading_logs','book_locks','announcement','private_entries','habits'] loop
    if to_regclass(format('public.%I',table_name)) is null then
      raise exception 'Expected member table public.%',table_name;
    end if;
    execute format('alter table public.%I enable row level security',table_name);
    execute format('drop policy if exists growell_require_approved_member on public.%I',table_name);
    execute format('create policy growell_require_approved_member on public.%I as restrictive for all to anon,authenticated using ((select public.growell_is_active_member())) with check ((select public.growell_is_active_member()))',table_name);
  end loop;
end
$policies$;
drop policy if exists growell_require_auth_for_select on public.profiles;
create policy growell_require_auth_for_select on public.profiles
  as restrictive for select to anon,authenticated
  using ((select auth.uid()) is not null and (
    auth_user_id=(select auth.uid())
    or ((select public.growell_is_active_member()) and approval_status='approved')
    or (select public.growell_is_approved_admin())
  ));
drop policy if exists growell_require_approval_for_profile_update on public.profiles;
create policy growell_require_approval_for_profile_update on public.profiles
  as restrictive for update to anon,authenticated
  using ((select public.growell_is_active_member()))
  with check ((select public.growell_is_active_member()));
drop policy if exists growell_require_approval_for_profile_delete on public.profiles;
create policy growell_require_approval_for_profile_delete on public.profiles
  as restrictive for delete to anon,authenticated
  using ((select public.growell_is_active_member()));

-- The prior safe-profile-insert policy still disallows client admin/deleted
-- flags. Requiring a photo here closes direct PostgREST registration bypasses.
-- Service signup uploads a photo itself; the approval RPC rechecks its result.
drop policy if exists growell_require_photo_for_profile_insert on public.profiles;
create policy growell_require_photo_for_profile_insert on public.profiles
  as restrictive for insert to anon,authenticated
  with check (approval_status='pending' and char_length(btrim(coalesce(avatar_url,'')))>0);

-- Authentication alone must not enable uploads/edits before membership approval.
-- Service-role signup avatar uploads retain their existing trusted bypass.
-- Existing public object URLs stay public; this does not change bucket privacy.
drop policy if exists growell_require_approval_for_storage_insert on storage.objects;
create policy growell_require_approval_for_storage_insert on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id not in ('avatars','post-photos') or (select public.growell_is_active_member()));
drop policy if exists growell_require_approval_for_storage_update on storage.objects;
create policy growell_require_approval_for_storage_update on storage.objects
  as restrictive for update to authenticated
  using (bucket_id not in ('avatars','post-photos') or (select public.growell_is_active_member()))
  with check (bucket_id not in ('avatars','post-photos') or (select public.growell_is_active_member()));
drop policy if exists growell_require_approval_for_storage_delete on storage.objects;
create policy growell_require_approval_for_storage_delete on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id not in ('avatars','post-photos') or (select public.growell_is_active_member()));

create or replace function public.growell_review_member(p_profile_id text,p_decision text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare target public.profiles%rowtype; reviewer text;
begin
  if not public.growell_is_approved_admin() then
    raise exception 'Administrator required' using errcode='42501';
  end if;
  if p_profile_id is null or p_decision is null or p_decision not in ('approved','rejected') then
    raise exception 'Invalid approval decision' using errcode='22023';
  end if;
  select id into reviewer from public.profiles where auth_user_id=(select auth.uid());
  select * into target from public.profiles where id=p_profile_id for update;
  if not found or target.is_deleted then
    raise exception 'Member request not found' using errcode='22023';
  end if;
  if target.id=reviewer then raise exception 'Cannot review yourself' using errcode='42501'; end if;
  if target.approval_status=p_decision then
    return jsonb_build_object('id',target.id,'approval_status',target.approval_status,
      'approved_at',target.approved_at,'approved_by',target.approved_by);
  end if;
  if target.approval_status<>'pending' then
    raise exception 'Request already reviewed; reload before saving' using errcode='40001';
  end if;
  if p_decision='approved' and char_length(btrim(coalesce(target.avatar_url,'')))=0 then
    raise exception 'Profile photo required before approval' using errcode='22023';
  end if;
  update public.profiles set approval_status=p_decision,
    approved_at=case when p_decision='approved' then now() else null end,
    approved_by=reviewer where id=target.id returning * into target;
  return jsonb_build_object('id',target.id,'approval_status',target.approval_status,
    'approved_at',target.approved_at,'approved_by',target.approved_by);
end
$function$;
revoke all on function public.growell_review_member(text,text) from public,anon,authenticated;
grant execute on function public.growell_review_member(text,text) to authenticated;

-- Keep existing social accounts compatible with the approval-aware login.
-- Same identity checks, return statuses, and encrypted envelope as before; the
-- profile adds only approval metadata. No account/vault is rewritten or merged.
create or replace function public.growell_oauth_profile()
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  member_auth_id uuid:=auth.uid();
  member_profile public.profiles%rowtype;
  member_envelope jsonb;
begin
  if member_auth_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not exists(select 1 from auth.identities i where i.user_id=member_auth_id and i.provider in ('google','kakao')) then
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
      'pbkdf2_salt',member_profile.pbkdf2_salt,'created_at',member_profile.created_at,'is_deleted',member_profile.is_deleted,
      'approval_status',member_profile.approval_status,'approved_at',member_profile.approved_at,'approved_by',member_profile.approved_by),
    'envelope',member_envelope
  );
end
$function$;
revoke all on function public.growell_oauth_profile() from public,anon;
grant execute on function public.growell_oauth_profile() to authenticated;

commit;
