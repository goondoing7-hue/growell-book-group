-- Add weekday schedules without changing habit IDs, check history, RLS or grants.
-- Run as the database owner before deploying the weekday-enabled application.
begin;

do $weekdays_schema$
begin
  if to_regclass('public.habits') is null then raise exception 'habits must exist before habit-weekdays';end if;
  alter table public.habits add column if not exists weekdays integer[] default array[0,1,2,3,4,5,6];
  if not exists(select 1 from pg_catalog.pg_attribute a
    where a.attrelid='public.habits'::regclass and a.attname='weekdays' and not a.attisdropped
      and a.atttypid='integer[]'::regtype and a.attgenerated='') then
    raise exception 'Incompatible source column habits.weekdays';
  end if;
  alter table public.habits alter column weekdays set default array[0,1,2,3,4,5,6];
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.habits'::regclass and conname='habits_weekdays_valid') then
    alter table public.habits add constraint habits_weekdays_valid check (
      weekdays is null or (
        array_ndims(weekdays)=1 and array_lower(weekdays,1)=1 and cardinality(weekdays) between 1 and 7
        and weekdays <@ array[0,1,2,3,4,5,6] and array_position(weekdays,null) is null
        and cardinality(weekdays)=(0=any(weekdays))::integer+(1=any(weekdays))::integer+(2=any(weekdays))::integer
          +(3=any(weekdays))::integer+(4=any(weekdays))::integer+(5=any(weekdays))::integer+(6=any(weekdays))::integer
      )
    );
  end if;
end
$weekdays_schema$;

-- An existing sync trigger compares only the source projection. Add weekdays
-- to that projection; changing check history alone still never queues a task.
-- CREATE OR REPLACE preserves the existing function owner and access rights.
do $weekdays_sync$
begin
  if to_regprocedure('public.growell_habit_sync_source(jsonb)') is not null then
    execute $source$
      create or replace function public.growell_habit_sync_source(p_habit jsonb)
      returns jsonb language sql immutable set search_path='' as $body$
        select jsonb_build_object('id',p_habit->'id','user_id',p_habit->'user_id',
          'name',p_habit->'name','goal',p_habit->'goal','time',p_habit->'time',
          'place',p_habit->'place','start_date',p_habit->'start_date',
          'end_date',p_habit->'end_date','behavior_type',p_habit->'behavior_type',
          'book_id',p_habit->'book_id','weekdays',p_habit->'weekdays');
      $body$;
    $source$;
  end if;
end
$weekdays_sync$;

notify pgrst, 'reload schema';
commit;
