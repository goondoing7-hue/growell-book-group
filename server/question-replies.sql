-- Apply after member-approval.sql. Replies are separate from shared posts:
-- each answer belongs to the exact question revision the member was shown.
-- Previous question answers remain stored when an administrator edits a question.
begin;

create table if not exists public.growell_question_replies (
  id uuid primary key,
  book_id text not null check (book_id in ('emotion','thought','body','action')),
  question_revision bigint not null check (question_revision >= 0),
  question_text text not null check (char_length(btrim(question_text)) between 1 and 240),
  user_id text not null references public.profiles(id),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists growell_question_replies_thread_idx on public.growell_question_replies(book_id,question_revision,created_at,id);
alter table public.growell_question_replies enable row level security;
revoke all on table public.growell_question_replies from public,anon,authenticated;

-- Internal helper: not client-callable. An unchanged built-in question is
-- revision zero; its wording matches communityDomain.js exactly.
create or replace function public.growell_question_thread(p_book_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare q public.growell_book_questions%rowtype; fallback text;
begin
  fallback:=case p_book_id
    when 'emotion' then '최근 내 마음에 이름을 붙여 준 순간이 있었나요?'
    when 'thought' then '책 속의 어떤 생각이 나의 시선을 바꾸었나요?'
    when 'body' then '오늘 몸이 나에게 보내는 신호는 무엇인가요?'
    when 'action' then '이번 주에 작게 실천해 보고 싶은 것은 무엇인가요?'
    else null end;
  if fallback is null then raise exception 'Invalid book' using errcode='22023';end if;
  select * into q from public.growell_book_questions where book_id=p_book_id;
  return jsonb_build_object('book_id',p_book_id,'question',coalesce(q.question,fallback),'revision',coalesce(q.revision,0));
end
$function$;
revoke all on function public.growell_question_thread(text) from public,anon,authenticated;

create or replace function public.growell_get_question_replies(p_book_id text,p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare thread jsonb; cursor_row public.growell_question_replies%rowtype; result jsonb; more boolean;
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  if coalesce((select locked from public.book_locks where book_id=p_book_id),p_book_id<>'emotion') and not public.growell_is_approved_admin() then
    raise exception 'Book locked' using errcode='42501';
  end if;
  thread:=public.growell_question_thread(p_book_id);
  if p_before_id is not null then
    select * into cursor_row from public.growell_question_replies where id=p_before_id and book_id=p_book_id and question_revision=(thread->>'revision')::bigint;
    if not found then raise exception 'Reply cursor changed' using errcode='40001';end if;
  end if;
  with page as (
    select r.* from public.growell_question_replies r
    where r.book_id=p_book_id and r.question_revision=(thread->>'revision')::bigint
      and (p_before_id is null or (r.created_at,r.id)<(cursor_row.created_at,cursor_row.id))
    order by r.created_at desc,r.id desc limit 31
  ), visible as (select * from page order by created_at desc,id desc limit 30)
  select (select count(*)>30 from page),coalesce(jsonb_agg(jsonb_build_object(
    'id',v.id,'book_id',v.book_id,'question_revision',v.question_revision,'user_id',v.user_id,
    'user_name',case when p.is_deleted then '탈퇴한 모임원' else p.name end,'body',v.body,'created_at',v.created_at
  ) order by v.created_at,v.id),'[]'::jsonb)
  into more,result from visible v join public.profiles p on p.id=v.user_id;
  return thread||jsonb_build_object('replies',result,'has_more',more);
end
$function$;

create or replace function public.growell_add_question_reply(p_id uuid,p_book_id text,p_expected_revision bigint,p_body text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare author public.profiles%rowtype; thread jsonb; saved public.growell_question_replies%rowtype;
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  select * into author from public.profiles where auth_user_id=(select auth.uid()) and is_deleted=false;
  if coalesce((select locked from public.book_locks where book_id=p_book_id),p_book_id<>'emotion') and not public.growell_is_approved_admin() then
    raise exception 'Book locked' using errcode='42501';
  end if;
  if p_id is null or p_expected_revision is null or p_expected_revision<0 or p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Invalid reply' using errcode='22023';
  end if;
  -- Same lock as question editing; a reply can never race into a new question.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_question:'||p_book_id,0));
  -- A retry after an uncertain response returns the original answer, even if
  -- the question has since changed. It cannot overwrite or duplicate a reply.
  select * into saved from public.growell_question_replies where id=p_id;
  if found then
    if saved.user_id<>author.id or saved.book_id<>p_book_id or saved.question_revision<>p_expected_revision or saved.body<>btrim(p_body) then
      raise exception 'Reply identity conflict' using errcode='23505';
    end if;
  else
    thread:=public.growell_question_thread(p_book_id);
    if (thread->>'revision')::bigint<>p_expected_revision then raise exception 'Question changed' using errcode='40001';end if;
    insert into public.growell_question_replies(id,book_id,question_revision,question_text,user_id,body)
    values(p_id,p_book_id,p_expected_revision,thread->>'question',author.id,btrim(p_body)) returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'book_id',saved.book_id,'question_revision',saved.question_revision,
    'user_id',saved.user_id,'user_name',author.name,'body',saved.body,'created_at',saved.created_at);
end
$function$;

-- Existing question RPCs must use the same approval-aware membership checks.
create or replace function public.growell_get_book_questions()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('book_id',q.book_id,'question',q.question,'revision',q.revision) order by q.book_id),'[]'::jsonb) from public.growell_book_questions q);
end
$function$;

create or replace function public.growell_save_book_question(p_book_id text,p_question text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare saved public.growell_book_questions%rowtype;
begin
  if not public.growell_is_approved_admin() then raise exception 'Approved administrator required' using errcode='42501';end if;
  if p_book_id is null or p_book_id not in ('emotion','thought','body','action') or p_question is null
      or char_length(btrim(p_question)) not between 1 and 240 or p_expected_revision is null or p_expected_revision<0 then
    raise exception 'Invalid question' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_question:'||p_book_id,0));
  select * into saved from public.growell_book_questions where book_id=p_book_id for update;
  if coalesce(saved.revision,0)<>p_expected_revision then raise exception 'Question changed; reload before saving' using errcode='40001';end if;
  insert into public.growell_book_questions(book_id,question,revision,updated_at)
  values(p_book_id,btrim(p_question),p_expected_revision+1,now())
  on conflict(book_id) do update set question=excluded.question,revision=excluded.revision,updated_at=excluded.updated_at returning * into saved;
  return jsonb_build_object('book_id',saved.book_id,'question',saved.question,'revision',saved.revision);
end
$function$;

revoke all on function public.growell_get_question_replies(text,uuid) from public,anon,authenticated;
revoke all on function public.growell_add_question_reply(uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.growell_get_book_questions() from public,anon,authenticated;
revoke all on function public.growell_save_book_question(text,text,bigint) from public,anon,authenticated;
grant execute on function public.growell_get_question_replies(text,uuid) to authenticated;
grant execute on function public.growell_add_question_reply(uuid,text,bigint,text) to authenticated;
grant execute on function public.growell_get_book_questions() to authenticated;
grant execute on function public.growell_save_book_question(text,text,bigint) to authenticated;

commit;
