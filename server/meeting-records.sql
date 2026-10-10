-- Administrator-authored meeting records. Apply after member-approval.sql.
-- No existing member records or policies are changed. Before COMMIT, append
-- meeting-records-verification.sql instead for a rollback-only production check.
begin;

do $guard$
begin
  if to_regprocedure('public.growell_is_active_member()') is null
      or to_regprocedure('public.growell_is_approved_admin()') is null
      or to_regclass('public.material_notes') is null then
    raise exception 'Apply existing GROWELL membership schema first';
  end if;
end
$guard$;

create table if not exists public.growell_meeting_records (
  id uuid primary key,
  book_id text not null check (book_id in ('emotion','thought','body','action')),
  round integer not null check (round between 1 and 9999),
  meeting_date date,
  topic text not null check (char_length(topic)<=160),
  sections jsonb not null check (jsonb_typeof(sections)='array' and jsonb_array_length(sections)<=20),
  concepts jsonb not null check (jsonb_typeof(concepts)='array' and jsonb_array_length(concepts)<=30),
  material_ids text[] not null default '{}',
  status text not null check (status in ('draft','published')),
  user_id text not null references public.profiles(id),
  revision bigint not null default 1 check (revision>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check (cardinality(material_ids)<=30),
  check (status<>'published' or (meeting_date is not null and char_length(btrim(topic))>0 and jsonb_array_length(sections)>0))
);
create unique index if not exists growell_meeting_records_round_idx
  on public.growell_meeting_records(book_id,round) where deleted_at is null;
alter table public.growell_meeting_records enable row level security;
revoke all on table public.growell_meeting_records from public,anon,authenticated;

-- An internal allowlist serializer keeps profile fields and tombstones private.
create or replace function public.growell_meeting_record_json(p_row public.growell_meeting_records)
returns jsonb language sql stable set search_path = ''
as $function$
  select jsonb_build_object('id',p_row.id,'bookId',p_row.book_id,'round',p_row.round,
    'date',p_row.meeting_date,'topic',p_row.topic,'sections',p_row.sections,'concepts',p_row.concepts,
    'materialIds',to_jsonb(p_row.material_ids),'status',p_row.status,'userId',p_row.user_id,
    'revision',p_row.revision,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at);
$function$;
revoke all on function public.growell_meeting_record_json(public.growell_meeting_records) from public,anon,authenticated;

create or replace function public.growell_get_meeting_records(p_book_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare actor text; administrator boolean;
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  if p_book_id is null or p_book_id not in ('emotion','thought','body','action') then
    raise exception 'Invalid book' using errcode='22023';
  end if;
  administrator:=public.growell_is_approved_admin();
  select p.id into actor from public.profiles p where p.auth_user_id=(select auth.uid()) and p.is_deleted=false and p.approval_status='approved';
  if not administrator and coalesce((select b.locked from public.book_locks b where b.book_id=p_book_id),p_book_id<>'emotion') then
    raise exception 'Book locked' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(public.growell_meeting_record_json(r) order by r.round desc,r.id),'[]'::jsonb)
    from public.growell_meeting_records r where r.book_id=p_book_id and r.deleted_at is null
      and (r.status='published' or (administrator and r.user_id=actor)));
end
$function$;

create or replace function public.growell_save_meeting_record(p_record jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  actor text; record_id uuid; book text; meeting_round integer; meeting_day date; heading text;
  record_status text; item jsonb; section_rows jsonb; concept_rows jsonb; materials text[]; material text;
  saved public.growell_meeting_records%rowtype; candidate jsonb; previous jsonb;
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
      ('id','bookId','round','date','topic','sections','concepts','materialIds','status','userId','revision','createdAt','updatedAt'))
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
  candidate:=jsonb_build_object('bookId',book,'round',meeting_round,'date',meeting_day,'topic',heading,
    'sections',section_rows,'concepts',concept_rows,'materialIds',to_jsonb(materials),'status',record_status);
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
  insert into public.growell_meeting_records(id,book_id,round,meeting_date,topic,sections,concepts,material_ids,status,user_id,revision)
    values(record_id,book,meeting_round,meeting_day,heading,section_rows,concept_rows,materials,record_status,actor,p_expected_revision+1)
    on conflict(id) do update set round=excluded.round,meeting_date=excluded.meeting_date,topic=excluded.topic,
      sections=excluded.sections,concepts=excluded.concepts,material_ids=excluded.material_ids,status=excluded.status,
      revision=excluded.revision,updated_at=clock_timestamp() returning * into saved;
  return public.growell_meeting_record_json(saved);
end
$function$;

create or replace function public.growell_delete_meeting_record(p_id uuid,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare actor text;saved public.growell_meeting_records%rowtype;
begin
  if not public.growell_is_approved_admin() then raise exception 'Administrator required' using errcode='42501';end if;
  select p.id into actor from public.profiles p where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
    and p.approval_status='approved' and p.is_admin=true for share;
  if actor is null then raise exception 'Administrator required' using errcode='42501';end if;
  if p_id is null or p_expected_revision is null or p_expected_revision<1 or p_expected_revision>9007199254740990 then
    raise exception 'Invalid meeting record' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_meeting:'||p_id::text,0));
  select * into saved from public.growell_meeting_records where id=p_id for update;
  if not found or saved.user_id<>actor then raise exception 'Own meeting record required' using errcode='42501';end if;
  if saved.deleted_at is not null then
    if saved.revision<>p_expected_revision+1 then raise exception 'Meeting record changed' using errcode='40001';end if;
  elsif saved.revision<>p_expected_revision then raise exception 'Meeting record changed' using errcode='40001';
  else
    update public.growell_meeting_records set deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
      where id=p_id returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'deleted',true,'revision',saved.revision);
end
$function$;

revoke all on function public.growell_get_meeting_records(text) from public,anon,authenticated;
revoke all on function public.growell_save_meeting_record(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.growell_delete_meeting_record(uuid,bigint) from public,anon,authenticated;
grant execute on function public.growell_get_meeting_records(text) to authenticated;
grant execute on function public.growell_save_meeting_record(jsonb,bigint) to authenticated;
grant execute on function public.growell_delete_meeting_record(uuid,bigint) to authenticated;

commit;
