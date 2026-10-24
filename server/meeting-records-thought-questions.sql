-- Optional operator-authored thought questions. Apply after
-- meeting-records-next-preparation.sql. No authored row, revision or source is
-- rewritten. Legacy clients that omit thoughtQuestions retain the saved list.
begin;
do $guard$
begin
  if to_regclass('public.growell_meeting_records') is null
      or to_regprocedure('public.growell_valid_meeting_preparation(jsonb)') is null then
    raise exception 'Apply meeting-records-next-preparation.sql first';
  end if;
end
$guard$;

create or replace function public.growell_valid_meeting_questions(p_value jsonb)
returns boolean language plpgsql immutable set search_path=''
as $function$
declare item jsonb;
begin
  if p_value is null then return true;end if;
  if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value)>30 then return false;end if;
  for item in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','text']
        or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','text'))
        or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
        or jsonb_typeof(item->'text') is distinct from 'string' or char_length(item->>'text')>1000 then
      return false;
    end if;
  end loop;
  return (select count(distinct value->>'id') from jsonb_array_elements(p_value))=jsonb_array_length(p_value);
end
$function$;
revoke all on function public.growell_valid_meeting_questions(jsonb) from public,anon,authenticated;

alter table public.growell_meeting_records add column if not exists thought_questions jsonb;
do $constraint$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.growell_meeting_records'::regclass and conname='growell_meeting_records_questions_check') then
    alter table public.growell_meeting_records add constraint growell_meeting_records_questions_check
      check(public.growell_valid_meeting_questions(thought_questions));
  end if;
end
$constraint$;

create or replace function public.growell_meeting_record_json(p_row public.growell_meeting_records)
returns jsonb language sql stable set search_path = ''
as $function$
  select jsonb_build_object('id',p_row.id,'bookId',p_row.book_id,'round',p_row.round,
    'date',p_row.meeting_date,'topic',p_row.topic,'sections',p_row.sections,'concepts',p_row.concepts,
    'thoughtQuestions',coalesce(p_row.thought_questions,'[]'::jsonb),'materialIds',to_jsonb(p_row.material_ids),'nextMeeting',p_row.next_meeting,'status',p_row.status,'userId',p_row.user_id,
    'revision',p_row.revision,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at);
$function$;
revoke all on function public.growell_meeting_record_json(public.growell_meeting_records) from public,anon,authenticated;

create or replace function public.growell_save_meeting_record(p_record jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  actor text; record_id uuid; book text; meeting_round integer; meeting_day date; heading text;
  record_status text; item jsonb; section_rows jsonb; concept_rows jsonb; materials text[]; material text;
  saved public.growell_meeting_records%rowtype; candidate jsonb; previous jsonb; preparation jsonb; questions jsonb;
begin
  if not public.growell_is_approved_admin() then raise exception 'Administrator required' using errcode='42501';end if;
  select p.id into actor from public.profiles p where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
    and p.approval_status='approved' and p.is_admin=true for share;
  if actor is null then raise exception 'Administrator required' using errcode='42501';end if;
  if p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9007199254740990
      or jsonb_typeof(p_record) is distinct from 'object' or pg_column_size(p_record)>700000 then
    raise exception 'Invalid meeting record' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_record) k where k not in
      ('id','bookId','round','date','topic','sections','concepts','thoughtQuestions','materialIds','nextMeeting','status','userId','revision','createdAt','updatedAt'))
      or not p_record ?& array['id','bookId','round','topic','sections','concepts','materialIds','status']
      or jsonb_typeof(p_record->'id') is distinct from 'string'
      or (p_record->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(p_record->'bookId') is distinct from 'string'
      or (p_record->>'bookId') not in ('emotion','thought','body','action')
      or jsonb_typeof(p_record->'round') is distinct from 'number' or (p_record->>'round')!~'^[0-9]{1,4}$'
      or jsonb_typeof(p_record->'topic') is distinct from 'string' or char_length(p_record->>'topic')>160
      or jsonb_typeof(p_record->'status') is distinct from 'string' or (p_record->>'status') not in ('draft','published')
      or jsonb_typeof(p_record->'sections') is distinct from 'array'
      or jsonb_typeof(p_record->'concepts') is distinct from 'array'
      or jsonb_typeof(p_record->'materialIds') is distinct from 'array' then
    raise exception 'Invalid meeting record' using errcode='22023';
  end if;
  if p_record ? 'userId' and (jsonb_typeof(p_record->'userId') is distinct from 'string' or p_record->>'userId'<>actor) then
    raise exception 'Own meeting record required' using errcode='42501';
  end if;
  record_id:=(p_record->>'id')::uuid;book:=p_record->>'bookId';meeting_round:=(p_record->>'round')::integer;
  heading:=btrim(p_record->>'topic');record_status:=p_record->>'status';section_rows:=p_record->'sections';concept_rows:=p_record->'concepts';
  if meeting_round<1 or jsonb_array_length(section_rows)>20 or jsonb_array_length(concept_rows)>30 or jsonb_array_length(p_record->'materialIds')>30 then
    raise exception 'Invalid meeting record' using errcode='22023';
  end if;
  if p_record ? 'date' and p_record->'date'<>'null'::jsonb then
    if jsonb_typeof(p_record->'date') is distinct from 'string' or (p_record->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid meeting date' using errcode='22023';
    end if;
    begin meeting_day:=(p_record->>'date')::date;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid meeting date' using errcode='22023';end;
  end if;
  for item in select value from jsonb_array_elements(section_rows) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','summary','detail']
        or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','summary','detail'))
        or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
        or jsonb_typeof(item->'summary') is distinct from 'string' or char_length(item->>'summary')>120
        or jsonb_typeof(item->'detail') is distinct from 'string' or char_length(item->>'detail')>10000
        or (record_status='published' and (char_length(btrim(item->>'summary'))=0 or char_length(btrim(item->>'detail'))=0)) then
      raise exception 'Invalid meeting section' using errcode='22023';
    end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(section_rows))<>jsonb_array_length(section_rows) then
    raise exception 'Duplicate meeting section' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(concept_rows) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','word','meaning']
        or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','word','meaning'))
        or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'
        or jsonb_typeof(item->'word') is distinct from 'string' or char_length(item->>'word')>80
        or jsonb_typeof(item->'meaning') is distinct from 'string' or char_length(item->>'meaning')>4000
        or (record_status='published' and (char_length(btrim(item->>'word'))=0 or char_length(btrim(item->>'meaning'))=0)) then
      raise exception 'Invalid meeting concept' using errcode='22023';
    end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(concept_rows))<>jsonb_array_length(concept_rows) then
    raise exception 'Duplicate meeting concept' using errcode='22023';
  end if;
  if record_status='published' and (meeting_day is null or heading='' or jsonb_array_length(section_rows)=0) then
    raise exception 'Complete the meeting record before publishing' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(p_record->'materialIds') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' then
      raise exception 'Invalid meeting material' using errcode='22023';
    end if;
  end loop;
  select coalesce(array_agg(value order by ord),'{}'::text[]) into materials
    from jsonb_array_elements_text(p_record->'materialIds') with ordinality a(value,ord);
  if (select count(distinct v) from unnest(materials) v)<>cardinality(materials) then
    raise exception 'Duplicate meeting material' using errcode='22023';
  end if;
  -- The ID lock covers initial creation as well as edits/deletion. The round
  -- index rejects an independent record for the same book/round atomically.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_meeting:'||record_id::text,0));
  select * into saved from public.growell_meeting_records where id=record_id for update;
  if found and saved.user_id<>actor then raise exception 'Own meeting record required' using errcode='42501';end if;
  if saved.id is not null and saved.book_id<>book then raise exception 'Meeting book cannot change' using errcode='22023';end if;
  if saved.deleted_at is not null then raise exception 'Meeting record deleted' using errcode='40001';end if;
  -- Old clients omit this optional field. Preserve its stored value on edits
  -- and retries; only an explicit JSON null requests removing preparation.
  preparation:=case when p_record ? 'nextMeeting' then nullif(p_record->'nextMeeting','null'::jsonb) else saved.next_meeting end;
  if not public.growell_valid_meeting_preparation(preparation) then
    raise exception 'Invalid next meeting preparation' using errcode='22023';
  end if;
  -- Omission by a legacy client preserves the stored questions exactly. An
  -- explicit [] clears this record's questions; it never touches source posts.
  questions:=case when p_record ? 'thoughtQuestions' then p_record->'thoughtQuestions' else coalesce(saved.thought_questions,'[]'::jsonb) end;
  if jsonb_typeof(questions) is distinct from 'array' or not public.growell_valid_meeting_questions(questions) then
    raise exception 'Invalid thought questions' using errcode='22023';
  end if;
  if record_status='published' and exists(select 1 from jsonb_array_elements(questions) q where q->>'text' !~ '[^[:space:]]') then
    raise exception 'Complete thought questions before publishing' using errcode='22023';
  end if;
  candidate:=jsonb_build_object('bookId',book,'round',meeting_round,'date',meeting_day,'topic',heading,
    'sections',section_rows,'concepts',concept_rows,'thoughtQuestions',questions,'materialIds',to_jsonb(materials),'nextMeeting',preparation,'status',record_status);
  if saved.id is not null then
    previous:=public.growell_meeting_record_json(saved)-array['id','userId','revision','createdAt','updatedAt'];
    if saved.revision=p_expected_revision+1 and candidate=previous then return public.growell_meeting_record_json(saved);end if;
  end if;
  if coalesce(saved.revision,0)<>p_expected_revision then raise exception 'Meeting record changed; reload before saving' using errcode='40001';end if;
  -- Material content stays in its original table and is never copied here.
  -- Validate every selected source, including retained links. The editor can
  -- remove a link whose source was deleted or transferred before saving again.
  foreach material in array materials loop
    perform 1 from public.material_notes m where m.id=material and m.book_id=book and m.user_id=actor for share;
    if not found then raise exception 'Meeting material unavailable' using errcode='22023';end if;
  end loop;
  insert into public.growell_meeting_records(id,book_id,round,meeting_date,topic,sections,concepts,thought_questions,material_ids,next_meeting,status,user_id,revision)
    values(record_id,book,meeting_round,meeting_day,heading,section_rows,concept_rows,questions,materials,preparation,record_status,actor,p_expected_revision+1)
    on conflict(id) do update set round=excluded.round,meeting_date=excluded.meeting_date,topic=excluded.topic,
      sections=excluded.sections,concepts=excluded.concepts,thought_questions=excluded.thought_questions,material_ids=excluded.material_ids,next_meeting=excluded.next_meeting,status=excluded.status,
      revision=excluded.revision,updated_at=clock_timestamp() returning * into saved;
  return public.growell_meeting_record_json(saved);
end
$function$;

revoke all on function public.growell_save_meeting_record(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.growell_save_meeting_record(jsonb,bigint) to authenticated;

commit;
