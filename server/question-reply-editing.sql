-- Apply after question-replies.sql. Add owner-only editing without replacing
-- existing replies, their creation times, or their original question snapshots.
-- For a rollback-only check, omit COMMIT and append the verification file.
begin;

alter table public.growell_question_replies
  add column if not exists reply_revision bigint not null default 0,
  add column if not exists updated_at timestamptz,
  add column if not exists deleted_at timestamptz;
do $constraint$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.growell_question_replies'::regclass
      and conname='growell_question_replies_revision_check') then
    alter table public.growell_question_replies add constraint growell_question_replies_revision_check
      check (reply_revision >= 0);
  end if;
end
$constraint$;
alter table public.growell_question_replies enable row level security;
revoke all on table public.growell_question_replies from public,anon,authenticated;

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
    -- A deleted answer remains a cursor anchor. Its body is never returned.
    select * into cursor_row from public.growell_question_replies where id=p_before_id and book_id=p_book_id and question_revision=(thread->>'revision')::bigint;
    if not found then raise exception 'Reply cursor changed' using errcode='40001';end if;
  end if;
  with page as (
    select r.* from public.growell_question_replies r
    where r.book_id=p_book_id and r.question_revision=(thread->>'revision')::bigint and r.deleted_at is null
      and (p_before_id is null or (r.created_at,r.id)<(cursor_row.created_at,cursor_row.id))
    order by r.created_at desc,r.id desc limit 31
  ), visible as (select * from page order by created_at desc,id desc limit 30)
  select (select count(*)>30 from page),coalesce(jsonb_agg(jsonb_build_object(
    'id',v.id,'book_id',v.book_id,'question_revision',v.question_revision,'user_id',v.user_id,
    'user_name',case when p.is_deleted then '탈퇴한 모임원' else p.name end,'body',v.body,'created_at',v.created_at,
    'reply_revision',v.reply_revision,'updated_at',v.updated_at
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
  select * into author from public.profiles where auth_user_id=(select auth.uid()) and is_deleted=false and approval_status='approved' for share;
  if not found then raise exception 'Approved membership required' using errcode='42501';end if;
  if coalesce((select locked from public.book_locks where book_id=p_book_id for share),p_book_id<>'emotion') and not public.growell_is_approved_admin() then
    raise exception 'Book locked' using errcode='42501';
  end if;
  if p_id is null or p_book_id is null or p_book_id not in ('emotion','thought','body','action')
      or p_expected_revision is null or p_expected_revision<0 or p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Invalid reply' using errcode='22023';
  end if;
  -- Keep the lock shared with question editing: a new answer is always bound
  -- to the question revision its author saw. Same-ID retries cannot overwrite.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_question:'||p_book_id,0));
  select * into saved from public.growell_question_replies where id=p_id for update;
  if found then
    if saved.deleted_at is not null or saved.user_id<>author.id or saved.book_id<>p_book_id or saved.question_revision<>p_expected_revision or saved.body<>btrim(p_body) then
      raise exception 'Reply identity conflict' using errcode='23505';
    end if;
  else
    thread:=public.growell_question_thread(p_book_id);
    if (thread->>'revision')::bigint<>p_expected_revision then raise exception 'Question changed' using errcode='40001';end if;
    insert into public.growell_question_replies(id,book_id,question_revision,question_text,user_id,body)
    values(p_id,p_book_id,p_expected_revision,thread->>'question',author.id,btrim(p_body)) returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'book_id',saved.book_id,'question_revision',saved.question_revision,
    'user_id',saved.user_id,'user_name',author.name,'body',saved.body,'created_at',saved.created_at,
    'reply_revision',saved.reply_revision,'updated_at',saved.updated_at);
end
$function$;

create or replace function public.growell_update_question_reply(p_id uuid,p_expected_reply_revision bigint,p_body text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare author public.profiles%rowtype; saved public.growell_question_replies%rowtype;
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  if p_id is null or p_expected_reply_revision is null or p_expected_reply_revision<0 or p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Invalid reply' using errcode='22023';
  end if;
  select * into author from public.profiles where auth_user_id=(select auth.uid()) and is_deleted=false and approval_status='approved' for share;
  if not found then raise exception 'Approved membership required' using errcode='42501';end if;
  select * into saved from public.growell_question_replies where id=p_id and user_id=author.id for update;
  -- Administrator status never grants permission to edit another author's text.
  if not found then raise exception 'Own reply required' using errcode='42501';end if;
  if coalesce((select locked from public.book_locks where book_id=saved.book_id for share),saved.book_id<>'emotion') and not public.growell_is_approved_admin() then
    raise exception 'Book locked' using errcode='42501';
  end if;
  if saved.deleted_at is not null then raise exception 'Reply deleted; reload before saving' using errcode='40001';end if;
  if saved.reply_revision=p_expected_reply_revision then
    if saved.body<>btrim(p_body) then
      update public.growell_question_replies set body=btrim(p_body),reply_revision=reply_revision+1,updated_at=clock_timestamp()
        where id=saved.id returning * into saved;
    end if;
  elsif saved.reply_revision-1=p_expected_reply_revision and saved.body=btrim(p_body) then
    -- Only the immediately acknowledged version can satisfy an uncertain retry.
    -- A later edit is a conflict even if its text happens to match this request.
    null;
  else
    raise exception 'Reply changed; reload before saving' using errcode='40001';
  end if;
  return jsonb_build_object('id',saved.id,'book_id',saved.book_id,'question_revision',saved.question_revision,
    'user_id',saved.user_id,'user_name',author.name,'body',saved.body,'created_at',saved.created_at,
    'reply_revision',saved.reply_revision,'updated_at',saved.updated_at);
end
$function$;

create or replace function public.growell_delete_question_reply(p_id uuid,p_expected_reply_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare author public.profiles%rowtype; saved public.growell_question_replies%rowtype;
begin
  if not public.growell_is_active_member() then raise exception 'Approved membership required' using errcode='42501';end if;
  if p_id is null or p_expected_reply_revision is null or p_expected_reply_revision<0 then
    raise exception 'Invalid reply' using errcode='22023';
  end if;
  select * into author from public.profiles where auth_user_id=(select auth.uid()) and is_deleted=false and approval_status='approved' for share;
  if not found then raise exception 'Approved membership required' using errcode='42501';end if;
  select * into saved from public.growell_question_replies where id=p_id and user_id=author.id for update;
  if not found then raise exception 'Own reply required' using errcode='42501';end if;
  if coalesce((select locked from public.book_locks where book_id=saved.book_id for share),saved.book_id<>'emotion') and not public.growell_is_approved_admin() then
    raise exception 'Book locked' using errcode='42501';
  end if;
  if saved.deleted_at is not null then
    if p_expected_reply_revision not in (saved.reply_revision-1,saved.reply_revision) then
      raise exception 'Reply changed; reload before deleting' using errcode='40001';
    end if;
  elsif saved.reply_revision<>p_expected_reply_revision then
    raise exception 'Reply changed; reload before deleting' using errcode='40001';
  else
    -- A tombstone keeps ordering/cursor anchors and prevents a delayed add from
    -- recreating the answer. No API exposes deleted reply contents.
    update public.growell_question_replies set deleted_at=clock_timestamp(),reply_revision=reply_revision+1
      where id=saved.id returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'book_id',saved.book_id,'question_revision',saved.question_revision,
    'user_id',saved.user_id,'reply_revision',saved.reply_revision,'deleted',true);
end
$function$;

revoke all on function public.growell_get_question_replies(text,uuid) from public,anon,authenticated;
revoke all on function public.growell_add_question_reply(uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.growell_update_question_reply(uuid,bigint,text) from public,anon,authenticated;
revoke all on function public.growell_delete_question_reply(uuid,bigint) from public,anon,authenticated;
grant execute on function public.growell_get_question_replies(text,uuid) to authenticated;
grant execute on function public.growell_add_question_reply(uuid,text,bigint,text) to authenticated;
grant execute on function public.growell_update_question_reply(uuid,bigint,text) to authenticated;
grant execute on function public.growell_delete_question_reply(uuid,bigint) to authenticated;

commit;
