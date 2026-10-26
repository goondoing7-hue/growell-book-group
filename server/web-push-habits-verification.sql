-- Read-only aggregate verification. No member IDs, habit names/check history,
-- endpoints, subscription ciphertext or credentials are returned.
begin transaction isolation level repeatable read read only;
select 'profiles' as source,count(*) as rows from public.profiles
union all select 'posts',count(*) from public.posts
union all select 'material_notes',count(*) from public.material_notes
union all select 'private_entries',count(*) from public.private_entries
union all select 'habits',count(*) from public.habits
union all select 'growell_meeting_records',count(*) from public.growell_meeting_records order by source;
select enabled,new_posts,daily_verse,habit_check,count(*) as devices from public.growell_web_push_subscriptions
group by enabled,new_posts,daily_verse,habit_check order by enabled,new_posts,daily_verse,habit_check;
select kind,status,count(*) as jobs from public.growell_web_push_jobs group by kind,status order by kind,status;
select column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public'
  and ((table_name='growell_web_push_subscriptions' and column_name='habit_check') or (table_name='growell_web_push_jobs' and column_name='habit_day')) order by table_name,column_name;
select conname,pg_catalog.pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
where conrelid='public.growell_web_push_jobs'::regclass and conname in ('growell_web_push_jobs_kind_check','growell_web_push_jobs_habit_check') order by conname;
select p.proname as function_name,p.prosecdef as security_definer,
  md5(regexp_replace(p.prosrc,'[[:space:]]+','','g')) as body_md5,
  coalesce('search_path=""'=any(p.proconfig),false) as search_path_safe,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as member_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_can_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('growell_web_push_habit_date','growell_web_push_habit_pending','growell_web_push_eligible','growell_web_push_configure','growell_web_push_tick','growell_web_push_claim','growell_web_push_apply') order by function_name;
select jobname,schedule,active,command='select public.growell_web_push_tick();' as exact_tick_command
from cron.job where jobname in ('growell-daily-verse-queue','growell-web-push') order by jobname;
commit;
