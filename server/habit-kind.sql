-- Apply as the database owner before deploying the habit-kind UI.
-- Existing habits become 'do'. No names, dates, check records or ownership change.
begin;

lock table public.habits in share row exclusive mode;
alter table public.habits add column if not exists behavior_type text not null default 'do';

do $migration$
declare
  column_type oid;
  generated_kind "char";
  existing_expression text;
begin
  select atttypid, attgenerated into column_type, generated_kind
  from pg_catalog.pg_attribute
  where attrelid='public.habits'::regclass and attname='behavior_type' and not attisdropped;
  if column_type is distinct from 'text'::regtype::oid or generated_kind is distinct from ''::"char" then
    raise exception 'habits.behavior_type already exists with an incompatible definition; no changes committed';
  end if;
  if exists (select 1 from public.habits where behavior_type is not null and behavior_type not in ('do','avoid')) then
    raise exception 'habits.behavior_type contains unknown values; review them before migration';
  end if;
  -- Re-running this migration must never silently accept a conflicting constraint.
  if exists (select 1 from pg_catalog.pg_constraint where conrelid='public.habits'::regclass and conname='growell_habits_behavior_type_check') then
    select pg_catalog.pg_get_expr(conbin,conrelid) into existing_expression
    from pg_catalog.pg_constraint
    where conrelid='public.habits'::regclass and conname='growell_habits_behavior_type_check' and contype='c';
    if regexp_replace(coalesce(existing_expression,''),'\s','','g') <> '(behavior_type=ANY(ARRAY[''do''::text,''avoid''::text]))' then
      raise exception 'growell_habits_behavior_type_check has an unexpected definition; no changes committed';
    end if;
  else
    alter table public.habits add constraint growell_habits_behavior_type_check check (behavior_type in ('do','avoid'));
  end if;
end
$migration$;

update public.habits set behavior_type='do' where behavior_type is null;
alter table public.habits alter column behavior_type set default 'do';
alter table public.habits alter column behavior_type set not null;
alter table public.habits validate constraint growell_habits_behavior_type_check;
notify pgrst, 'reload schema';
commit;

-- Verification: text / NO / 'do'::text, validated=true, invalid_rows=0.
select data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='habits' and column_name='behavior_type';
select convalidated as validated
from pg_catalog.pg_constraint
where conrelid='public.habits'::regclass and conname='growell_habits_behavior_type_check';
select count(*) as invalid_rows from public.habits where behavior_type is null or behavior_type not in ('do','avoid');
