-- Read-only aggregate verification. No names, member IDs, record bodies,
-- questions, resource titles, endpoints or subscription ciphertext are output.
begin transaction isolation level repeatable read read only;
select 'profiles' as source,count(*) as rows from public.profiles
union all select 'posts',count(*) from public.posts
union all select 'material_notes',count(*) from public.material_notes
union all select 'private_entries',count(*) from public.private_entries
union all select 'habits',count(*) from public.habits
union all select 'growell_meeting_records',count(*) from public.growell_meeting_records
order by source;

select status,count(*) as records from public.growell_meeting_records group by status order by status;
select count(*) as publication_observations from public.growell_web_push_meeting_publications;
select kind,status,count(*) as jobs from public.growell_web_push_jobs group by kind,status order by kind,status;
select enabled,new_posts,daily_verse,count(*) as devices from public.growell_web_push_subscriptions
group by enabled,new_posts,daily_verse order by enabled,new_posts,daily_verse;

select c.relrowsecurity as publication_markers_rls,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_can_access,
  has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as member_can_access,
  has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') as service_can_access
from pg_catalog.pg_class c where c.oid='public.growell_web_push_meeting_publications'::regclass;

select column_name,data_type from information_schema.columns where table_schema='public'
  and table_name='growell_web_push_jobs' and column_name in ('meeting_id','meeting_round') order by column_name;
select conname,pg_catalog.pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
where conrelid='public.growell_web_push_jobs'::regclass
  and conname in ('growell_web_push_jobs_kind_check','growell_web_push_jobs_meeting_check') order by conname;
select t.tgname as trigger_name,pg_catalog.pg_get_triggerdef(t.oid) as definition from pg_catalog.pg_trigger t
where not t.tgisinternal and t.tgrelid='public.growell_meeting_records'::regclass and t.tgname='growell_web_push_new_meeting';
select p.proname as function_name,p.prosecdef as security_definer,p.proconfig as configuration,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as member_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_can_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('growell_web_push_eligible','growell_web_push_capture_meeting','growell_web_push_claim','growell_web_push_apply')
order by function_name;
commit;
