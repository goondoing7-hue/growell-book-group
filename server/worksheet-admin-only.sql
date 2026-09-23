-- Restrict the existing worksheets table to active administrators.
-- Existing ownership policies still apply; no records, grants or helpers change.
-- Before applying, omit COMMIT and append worksheet-admin-verification.sql.
begin;
do $guard$
begin
  if not exists(select 1 from pg_class where oid='public.worksheets'::regclass and relrowsecurity) then
    raise exception 'Expected worksheets RLS to be enabled';
  end if;
  if to_regprocedure('public.is_current_user_admin()') is null or to_regprocedure('public.growell_is_active_member()') is null then
    raise exception 'Expected existing GROWELL membership helpers';
  end if;
end
$guard$;
drop policy if exists growell_worksheets_admin_only on public.worksheets;
create policy growell_worksheets_admin_only on public.worksheets
  as restrictive for all to anon, authenticated
  using ((select public.growell_is_active_member()) and (select public.is_current_user_admin()))
  with check ((select public.growell_is_active_member()) and (select public.is_current_user_admin()));
commit;
