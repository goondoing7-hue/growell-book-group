-- Read-only aggregate verification. Run before and after the additive migration.
-- No member IDs, names, titles, body text, endpoint or encrypted secrets are output.
begin transaction isolation level repeatable read read only;

select 'profiles' as source,count(*) as rows from public.profiles
union all select 'posts',count(*) from public.posts
union all select 'material_notes',count(*) from public.material_notes
union all select 'private_entries',count(*) from public.private_entries
union all select 'habits',count(*) from public.habits
order by source;

select t.tgname as trigger_name,c.relname as source,
  pg_catalog.pg_get_triggerdef(t.oid) as definition
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid=t.tgrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
  and t.tgname in ('growell_web_push_new_post','growell_web_push_new_material')
order by source,trigger_name;

select exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='growell_web_push_jobs'
    and column_name='material_id' and data_type='text') as material_column_ready,
  exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.growell_web_push_jobs'::regclass
      and conname='growell_web_push_jobs_kind_check'
      and pg_catalog.pg_get_constraintdef(oid) like '%material%') as material_kind_ready;

select kind,status,count(*) as jobs from public.growell_web_push_jobs
group by kind,status order by kind,status;

select p.proname as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as member_can_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('growell_web_push_eligible',
  'growell_web_push_capture_material','growell_web_push_claim','growell_web_push_apply')
order by function_name;
commit;
