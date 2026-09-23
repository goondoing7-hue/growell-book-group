-- Per-book shared discussion questions. Run as the database owner after reviewing
-- and running the rollback-only companion verification. No member data is changed.
begin;

create table if not exists public.growell_book_questions (
  book_id text primary key check (book_id in ('emotion','thought','body','action')),
  question text not null check (char_length(btrim(question)) between 1 and 240),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);
alter table public.growell_book_questions enable row level security;
revoke all on table public.growell_book_questions from public,anon,authenticated;

-- No direct client table access; the RPCs return only question content/revision.
-- Both functions pin search_path and verify the authenticated caller in profiles.
create or replace function public.growell_get_book_questions()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p where p.auth_user_id=(select auth.uid()) and p.is_deleted=false
  ) then raise exception 'Active membership required' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('book_id',q.book_id,'question',q.question,'revision',q.revision) order by q.book_id),'[]'::jsonb) from public.growell_book_questions q);
end
$function$;

create or replace function public.growell_save_book_question(p_book_id text,p_question text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  saved public.growell_book_questions%rowtype;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p where p.auth_user_id=(select auth.uid()) and p.is_admin=true and p.is_deleted=false
  ) then raise exception 'Administrator required' using errcode='42501'; end if;
  if p_book_id is null or p_book_id not in ('emotion','thought','body','action')
      or p_question is null or char_length(btrim(p_question)) not between 1 and 240
      or p_expected_revision is null or p_expected_revision<0 then
    raise exception 'Invalid question' using errcode='22023';
  end if;
  -- Locks also cover an absent row, so two first-time saves cannot overwrite.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_question:'||p_book_id,0));
  select * into saved from public.growell_book_questions where book_id=p_book_id for update;
  if coalesce(saved.revision,0)<>p_expected_revision then
    raise exception 'Question changed; reload before saving' using errcode='40001';
  end if;
  insert into public.growell_book_questions(book_id,question,revision,updated_at)
  values(p_book_id,btrim(p_question),p_expected_revision+1,now())
  on conflict(book_id) do update set question=excluded.question,revision=excluded.revision,updated_at=excluded.updated_at
  returning * into saved;
  return jsonb_build_object('book_id',saved.book_id,'question',saved.question,'revision',saved.revision);
end
$function$;

revoke all on function public.growell_get_book_questions() from public,anon,authenticated;
revoke all on function public.growell_save_book_question(text,text,bigint) from public,anon,authenticated;
grant execute on function public.growell_get_book_questions() to authenticated;
grant execute on function public.growell_save_book_question(text,text,bigint) to authenticated;

commit;
