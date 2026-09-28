-- Follow-up to member-approval.sql and signup-notifications.sql.
-- Makes only the signup/profile photo optional. Approval, required hints,
-- identity checks, notification queuing and existing member data are preserved.
-- Run the companion rollback verification before applying this migration.
begin;

do $guard$
begin
  if to_regprocedure('public.growell_guard_member_approval()') is null
      or to_regprocedure('public.growell_review_member(text,text)') is null
      or to_regprocedure('public.growell_finalize_signup(text,uuid,text)') is null
      or to_regprocedure('public.growell_is_approved_admin()') is null then
    raise exception 'Apply the membership approval and signup notification migrations first';
  end if;
  if not exists(select 1 from pg_class where oid='public.profiles'::regclass and relrowsecurity) then
    raise exception 'Expected profile RLS';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass
      and tgname='growell_guard_member_approval' and tgfoid='public.growell_guard_member_approval()'::regprocedure and tgenabled='O') then
    raise exception 'Expected active membership approval trigger';
  end if;
  -- Metadata-only baseline for the rollback verification, never member records.
  perform set_config('growell.optional_photo_policy_baseline',coalesce((
    select jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname)::text
    from pg_policies p where p.schemaname in ('public','storage')
      and not (p.schemaname='public' and p.tablename='profiles'
        and p.policyname in ('growell_require_photo_for_profile_insert','growell_require_pending_profile_insert'))
  ),'[]'),true);
end
$guard$;

create or replace function public.growell_guard_member_approval()
returns trigger language plpgsql set search_path = ''
as $function$
begin
  if TG_OP='INSERT' then
    -- A photo is optional. Neither a photo nor an administrator code approves
    -- an application: new accounts always have pending, ordinary membership.
    new.approval_status:='pending';
    new.is_admin:=false;
    new.approved_at:=null;
    new.approved_by:=null;
  elsif row(new.approval_status,new.approved_at,new.approved_by)
      is distinct from row(old.approval_status,old.approved_at,old.approved_by) then
    if not (auth.uid() is null and exists(select 1 from pg_roles r join pg_class c on c.oid='public.profiles'::regclass
      where r.rolname=current_user and (r.rolsuper or r.rolbypassrls or (c.relowner=r.oid and not c.relforcerowsecurity))))
      and not public.growell_is_approved_admin() then
      raise exception 'Administrator approval required' using errcode='42501';
    end if;
  end if;
  if new.is_admin and new.approval_status<>'approved' then
    raise exception 'Approval required before administrator access' using errcode='42501';
  end if;
  return new;
end
$function$;
revoke all on function public.growell_guard_member_approval() from public,anon,authenticated;

-- Keep the restrictive pending requirement; remove only the photo expression.
-- Renaming the existing policy preserves its roles/type instead of replacing
-- unrelated ownership or administrator policies. Reapplication is idempotent.
do $policy$
begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
      and policyname='growell_require_photo_for_profile_insert') then
    if exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
        and policyname='growell_require_pending_profile_insert') then
      raise exception 'Conflicting profile insert policies; review before applying';
    end if;
    alter policy growell_require_photo_for_profile_insert on public.profiles rename to growell_require_pending_profile_insert;
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
      and policyname='growell_require_pending_profile_insert' and permissive='RESTRICTIVE'
      and cmd='INSERT' and roles @> array['anon','authenticated']::name[]) then
    raise exception 'Expected restrictive pending profile insert policy';
  end if;
  alter policy growell_require_pending_profile_insert on public.profiles with check (approval_status='pending');
end
$policy$;

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
  update public.profiles set approval_status=p_decision,
    approved_at=case when p_decision='approved' then now() else null end,
    approved_by=reviewer where id=target.id returning * into target;
  return jsonb_build_object('id',target.id,'approval_status',target.approval_status,
    'approved_at',target.approved_at,'approved_by',target.approved_by);
end
$function$;
revoke all on function public.growell_review_member(text,text) from public,anon,authenticated;
grant execute on function public.growell_review_member(text,text) to authenticated;

-- Preserve the existing single-string hint contract. A question ID and answer
-- serialized by the client are stored and compared together, unchanged.
-- No delivery is attempted here; the worker/queue contract remains untouched.
create or replace function public.growell_finalize_signup(p_profile_id text,p_auth_user_id uuid,p_pw_hint text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare applicant public.profiles%rowtype; existing_hint text;
begin
  if p_pw_hint is null or char_length(btrim(p_pw_hint)) not between 1 and 1024 then
    raise exception 'Invalid signup hint' using errcode='22023';
  end if;
  select * into applicant from public.profiles where id=p_profile_id for update;
  if not found or applicant.auth_user_id is distinct from p_auth_user_id
      or applicant.approval_status<>'pending' or applicant.is_admin or applicant.is_deleted then
    raise exception 'Signup profile mismatch' using errcode='42501';
  end if;
  insert into public.profile_secrets(user_id,pw_hint,updated_at)
    values(p_profile_id,btrim(p_pw_hint),(extract(epoch from clock_timestamp())*1000)::bigint)
    on conflict(user_id) do nothing;
  select pw_hint into existing_hint from public.profile_secrets where user_id=p_profile_id;
  if existing_hint is distinct from btrim(p_pw_hint) then
    raise exception 'Signup hint changed' using errcode='40001';
  end if;
  insert into public.growell_signup_notifications(profile_id,applicant_name,login_id)
    values(applicant.id,applicant.name,applicant.login_id) on conflict(profile_id) do nothing;
  return jsonb_build_object('hintSaved',true,'notificationQueued',true);
end
$function$;
revoke all on function public.growell_finalize_signup(text,uuid,text) from public,anon,authenticated;
grant execute on function public.growell_finalize_signup(text,uuid,text) to service_role;

commit;
