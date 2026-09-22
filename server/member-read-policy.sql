-- Applied to production on 2026-09-23 after rollback verification.
-- Before reapplying, export/review current policies and repeat verification.
-- Run as the project database owner.
-- This requires an authenticated, active GROWELL profile for shared SELECTs.
-- A member can still read their own profile to finish boot/account checks.
-- Direct client profile INSERTs additionally cannot set admin/deleted flags.
-- Existing ownership/admin policies remain in place and are AND-combined with
-- these new restrictions. No permissive policy or existing trigger is replaced.
-- It does not cover Storage public object URLs, views, RPC, or Edge Functions.
begin;

do $check$
declare
  table_name text;
begin
  -- Capture metadata only for the rollback verification appended to this batch.
  -- These transaction-local settings contain no member records or secrets.
  perform set_config('growell.member_policy_baseline',coalesce((
    select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname)::text
    from pg_policies p where p.schemaname='public' and p.policyname not in ('growell_require_auth_for_select','growell_require_safe_profile_insert')
      and p.tablename=any(array['profiles','posts','comments','material_notes','worksheets','reading_meta','reading_logs','book_locks','announcement','private_entries','habits'])
  ),'[]'),true);
  perform set_config('growell.member_acl_baseline',coalesce((
    select jsonb_agg(jsonb_build_object('table',c.relname,'acl',c.relacl::text) order by c.relname)::text
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=any(array['profiles','posts','comments','material_notes','worksheets','reading_meta','reading_logs','book_locks','announcement','private_entries','habits'])
  ),'[]'),true);
  -- The new definer must bypass profile RLS to prevent recursive evaluation.
  if not exists (
    select 1 from pg_class c join pg_roles r on r.rolname=current_user
    where c.oid='public.profiles'::regclass
      and (r.rolsuper or r.rolbypassrls or (c.relowner=r.oid and not c.relforcerowsecurity))
  ) then
    raise exception 'Run as the profiles owner with RLS bypass; no policies applied';
  end if;
  foreach table_name in array array[
    'profiles','posts','comments','material_notes','worksheets',
    'reading_meta','reading_logs','book_locks','announcement'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Expected table public.% does not exist; no policies applied', table_name;
    end if;
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = table_name
        and p.permissive = 'PERMISSIVE' and p.cmd in ('ALL','SELECT')
        and (p.roles && array['public','authenticated']::name[])
    ) then
      raise exception 'Review existing authenticated SELECT policies on public.% first; no policies applied', table_name;
    end if;
  end loop;
end
$check$;

-- Existing current_profile_id()/is_current_user_admin() are SECURITY INVOKER.
-- Do not call either from a profiles policy: it could recurse back into itself.
-- This helper accepts no caller-selected user ID and returns one Boolean only.
create or replace function public.growell_is_active_member()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.profiles p
    where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
  );
$function$;
revoke all on function public.growell_is_active_member() from public, anon, authenticated;
grant execute on function public.growell_is_active_member() to anon, authenticated;

do $apply$
declare
  table_name text;
  membership_condition text;
begin
  foreach table_name in array array[
    'profiles','posts','comments','material_notes','worksheets',
    'reading_meta','reading_logs','book_locks','announcement'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists growell_require_auth_for_select on public.%I', table_name);
    membership_condition := case when table_name='profiles'
      then '((auth_user_id=(select auth.uid())) or (select public.growell_is_active_member()))'
      else '(select public.growell_is_active_member())' end;
    execute format(
      'create policy growell_require_auth_for_select on public.%I as restrictive for select to anon, authenticated using ((select auth.uid()) is not null and %s)',
      table_name,membership_condition
    );
  end loop;
end
$apply$;

-- Existing profiles INSERT only checks Auth ownership and its is_admin trigger
-- covers UPDATE, so a client could otherwise request an admin flag on INSERT.
-- Both new flags must have the ordinary defaults; the old permissive INSERT
-- policy still applies. Database-owner/service-role Edge operations retain their
-- existing RLS bypass. This does not allow a client to promote any member.
drop policy if exists growell_require_safe_profile_insert on public.profiles;
create policy growell_require_safe_profile_insert on public.profiles
  as restrictive for insert to anon, authenticated
  with check (
    (select auth.uid()) is not null
    and auth_user_id=(select auth.uid())
    and is_admin=false
    and is_deleted=false
  );

commit;

-- Verification must use separate temporary sessions, not real member data:
-- 1. anon / Auth identity without a profile: no shared/member records returned.
-- 2. temporary member: own-profile boot and permitted shared records still work.
-- 3. temporary second member: cannot read the first member's private records.
-- 4. temporary administrator: permitted moderation/membership operations remain.
-- 5. direct client INSERT: admin/deleted flags denied; ordinary own profile allowed.
-- Existing private_entries/habits and storage policies require separate review.
