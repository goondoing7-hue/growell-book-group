-- Optional next-meeting end time. Apply after thought questions.
-- No authored rows, revisions, timestamps, identities, or delivery jobs change.
-- Serializers and mail snapshots already carry next_meeting as an exact object.
begin;
do $guard$
begin
  if to_regprocedure('public.growell_valid_meeting_questions(jsonb)') is null
      or to_regprocedure('public.growell_save_meeting_record(jsonb,bigint)') is null then
    raise exception 'Apply meeting-records-thought-questions.sql first';
  end if;
end
$guard$;

create or replace function public.growell_valid_meeting_preparation(p_value jsonb)
returns boolean language plpgsql immutable set search_path = ''
as $function$
declare field text; candidate_date date;
begin
  if p_value is null then return true;end if;
  if jsonb_typeof(p_value) is distinct from 'object' then return false;end if;
  if not p_value ?& array['date','time','place','reading','sharing','habit']
      or exists(select 1 from jsonb_object_keys(p_value) k where k not in ('date','time','endTime','place','reading','sharing','habit')) then
    return false;
  end if;
  foreach field in array array['date','time','place','reading','sharing','habit'] loop
    if jsonb_typeof(p_value->field) is distinct from 'string' then return false;end if;
    if char_length(p_value->>field)>(case when field='date' then 10 when field='time' then 5 when field='place' then 1000 else 4000 end) then
      return false;
    end if;
  end loop;
  if p_value->>'date'<>'' then
    if (p_value->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false;end if;
    begin candidate_date:=(p_value->>'date')::date;
    exception when invalid_datetime_format or datetime_field_overflow then return false;end;
  end if;
  if p_value->>'time'<>'' and (p_value->>'time')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false;end if;
  if p_value ? 'endTime' then
    if jsonb_typeof(p_value->'endTime') is distinct from 'string' or char_length(p_value->>'endTime')>5 then return false;end if;
    if p_value->>'endTime'<>'' then
      if (p_value->>'endTime')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false;end if;
      if p_value->>'time'<>'' and p_value->>'endTime'<=p_value->>'time' then return false;end if;
    end if;
  end if;
  return true;
end
$function$;
revoke all on function public.growell_valid_meeting_preparation(jsonb) from public,anon,authenticated;

-- Patch only the existing optional-preparation assignment. Copying an older
-- complete RPC here could silently undo current authorization or field checks.
-- Stop on unexpected source instead of replacing an unreviewed definition.
do $patch$
declare definition text;
  old_assignment text := $old$  preparation:=case when p_record ? 'nextMeeting' then nullif(p_record->'nextMeeting','null'::jsonb) else saved.next_meeting end;$old$;
  new_assignment text := $new$  preparation:=case when p_record ? 'nextMeeting' then nullif(p_record->'nextMeeting','null'::jsonb) else saved.next_meeting end;
  -- An older editor knows the other preparation fields but omits endTime.
  -- Preserve that stored value; only an explicit empty endTime clears it.
  if jsonb_typeof(preparation)='object' and not preparation ? 'endTime'
      and saved.next_meeting ? 'endTime' then
    preparation:=preparation||jsonb_build_object('endTime',saved.next_meeting->'endTime');
  end if;$new$;
begin
  definition:=replace(pg_catalog.pg_get_functiondef('public.growell_save_meeting_record(jsonb,bigint)'::regprocedure),chr(13),'');
  if strpos(definition,new_assignment)>0 then return;end if;
  if length(definition)-length(replace(definition,old_assignment,''))<>length(old_assignment) then
    raise exception 'Unexpected meeting save definition; inspect before applying end time';
  end if;
  execute replace(definition,old_assignment,new_assignment);
end
$patch$;
commit;
