-- Additive meeting publication alerts. Apply after web-push.sql,
-- web-push-materials.sql and meeting-records.sql. Deploy the meeting-aware
-- worker/service worker first. No source, existing job or subscription backfill.
-- A private observation marker prevents historical alerts on every later
-- republish, even after a different device subscribes. observed_at is the time
-- this migration/trigger observed publication, not an inferred publication date.
begin;
do $guard$
begin
  if to_regclass('public.growell_web_push_jobs') is null
    or to_regclass('public.growell_web_push_subscriptions') is null
    or to_regclass('public.growell_meeting_records') is null
    or to_regclass('public.material_notes') is null
    or to_regclass('public.posts') is null or to_regclass('public.profiles') is null
    or to_regclass('public.book_locks') is null then
    raise exception 'Apply web-push, resource and meeting record schemas first';
  end if;
end
$guard$;
alter table public.growell_web_push_jobs add column if not exists meeting_id uuid;
alter table public.growell_web_push_jobs add column if not exists meeting_round integer;
alter table public.growell_web_push_jobs drop constraint if exists growell_web_push_jobs_kind_check;
alter table public.growell_web_push_jobs add constraint growell_web_push_jobs_kind_check check(kind in ('post','material','meeting','verse','test'));
alter table public.growell_web_push_jobs drop constraint if exists growell_web_push_jobs_meeting_check;
alter table public.growell_web_push_jobs add constraint growell_web_push_jobs_meeting_check check(
  (meeting_round is null or meeting_round between 1 and 9999)
  and (kind<>'meeting' or (meeting_id is not null and meeting_round is not null and book_id is not null and source_key=meeting_id::text)));

create table if not exists public.growell_web_push_meeting_publications (
  record_id uuid primary key,
  observed_at timestamptz not null default clock_timestamp()
);
alter table public.growell_web_push_meeting_publications enable row level security;
revoke all on public.growell_web_push_meeting_publications from public,anon,authenticated,service_role;
-- Seed only private observation metadata for already published records.
-- No source is edited and no alert job is created for a historical record.
-- Serialize publication during the initial observation/trigger installation.
lock table public.growell_meeting_records in share row exclusive mode;
insert into public.growell_web_push_meeting_publications(record_id)
  select id from public.growell_meeting_records where status='published'
  on conflict(record_id) do nothing;

create or replace function public.growell_web_push_eligible(p_subscription uuid,p_kind text,p_post text default null,p_generation uuid default null)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(select 1 from public.growell_web_push_subscriptions s
    join public.profiles recipient on recipient.id=s.owner_id and recipient.auth_user_id=s.auth_user_id
    where s.id=p_subscription and s.enabled and s.subscription_cipher is not null
      and (p_generation is null or s.generation=p_generation)
      and recipient.approval_status='approved' and recipient.is_deleted=false
      and (p_kind='test' or (p_kind='verse' and s.daily_verse) or (p_kind='post' and s.new_posts and exists(
        select 1 from public.posts p join public.profiles author on author.id=p.user_id
        where p.id=p_post and p.user_id<>s.owner_id and author.approval_status='approved' and author.is_deleted=false
          and coalesce(to_jsonb(p)->>'is_deleted','false')='false' and to_jsonb(p)->>'deleted_at' is null
          and coalesce(to_jsonb(p)->>'is_private','false')='false' and coalesce(to_jsonb(p)->>'visibility','public')='public'
          and p.book_id is not null and (recipient.is_admin=true
            or not coalesce((select b.locked from public.book_locks b where b.book_id=p.book_id),p.book_id<>'emotion'))))
        or (p_kind='material' and s.new_posts and exists(
          select 1 from public.material_notes m join public.profiles author on author.id=m.user_id
          where m.id=p_post and m.user_id<>s.owner_id and author.approval_status='approved' and author.is_deleted=false
            and coalesce(to_jsonb(m)->>'is_deleted','false')='false' and to_jsonb(m)->>'deleted_at' is null
            and coalesce(to_jsonb(m)->>'is_private','false')='false' and coalesce(to_jsonb(m)->>'visibility','public')='public'
            and m.book_id is not null and (recipient.is_admin=true
              or not coalesce((select b.locked from public.book_locks b where b.book_id=m.book_id),m.book_id<>'emotion'))))
        or (p_kind='meeting' and s.new_posts and exists(
          select 1 from public.growell_meeting_records r join public.profiles author on author.id=r.user_id
          where r.id::text=p_post and r.user_id<>s.owner_id and r.status='published' and r.deleted_at is null
            and author.approval_status='approved' and author.is_deleted=false and author.is_admin=true
            and r.book_id is not null and r.round between 1 and 9999 and (recipient.is_admin=true
              or not coalesce((select b.locked from public.book_locks b where b.book_id=r.book_id),r.book_id<>'emotion'))))));
$function$;

create or replace function public.growell_web_push_capture_meeting()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.status<>'published' or new.deleted_at is not null then return new;end if;
  if tg_op='UPDATE' and old.status<>'draft' then return new;end if;
  insert into public.growell_web_push_meeting_publications(record_id) values(new.id)
    on conflict(record_id) do nothing;
  if not found then return new;end if;
  insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,meeting_id,meeting_round,book_id,expires_at)
    select s.id,s.owner_id,s.auth_user_id,s.generation,'meeting',new.id::text,new.id,new.round,new.book_id,clock_timestamp()+interval '1 day'
    from public.growell_web_push_subscriptions s where public.growell_web_push_eligible(s.id,'meeting',new.id::text,s.generation)
    on conflict(subscription_id,kind,source_key) do nothing;
  return new;
end
$function$;
drop trigger if exists growell_web_push_new_meeting on public.growell_meeting_records;
create trigger growell_web_push_new_meeting after insert or update on public.growell_meeting_records for each row execute function public.growell_web_push_capture_meeting();

create or replace function public.growell_web_push_claim(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare job public.growell_web_push_jobs%rowtype; result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit not between 1 and 20 then raise exception 'Invalid batch limit' using errcode='22023';end if;
  update public.growell_web_push_jobs set status='review',last_error='delivery-uncertain',lease_until=null
    where status='sending' and lease_until<clock_timestamp();
  update public.growell_web_push_jobs set status='cancelled',last_error='expired',lease_until=null
    where status in ('pending','claimed') and expires_at<=clock_timestamp();
  update public.growell_web_push_jobs set status='review',last_error='push-unavailable',lease_until=null
    where status='claimed' and attempts>=5 and lease_until<clock_timestamp();
  for job in select j.* from public.growell_web_push_jobs j
    where j.available_at<=clock_timestamp() and j.expires_at>clock_timestamp() and j.attempts<5
      and (j.status='pending' or (j.status='claimed' and j.lease_until<clock_timestamp()))
    order by j.available_at,j.created_at,j.id for update skip locked limit p_limit
  loop
    if not public.growell_web_push_eligible(job.subscription_id,job.kind,case when job.kind='meeting' then job.meeting_id::text when job.kind='material' then job.material_id else job.post_id end,job.generation)
      or not exists(select 1 from public.growell_web_push_subscriptions s where s.id=job.subscription_id and s.owner_id=job.owner_id and s.auth_user_id=job.auth_user_id)
      or (job.kind='material' and not exists(select 1 from public.material_notes m where m.id=job.material_id and m.book_id=job.book_id))
      or (job.kind='meeting' and not exists(select 1 from public.growell_meeting_records r where r.id=job.meeting_id and r.book_id=job.book_id and r.round=job.meeting_round and job.source_key=r.id::text))
      or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date) then
      update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible' where id=job.id;
      continue;
    end if;
    update public.growell_web_push_jobs set status='claimed',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1
      where id=job.id returning * into job;
    result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'lease_token',job.lease_token,'kind',job.kind,
      'post_id',job.post_id,'material_id',job.material_id,'meeting_id',job.meeting_id,'meeting_round',job.meeting_round,'book_id',job.book_id,'verse_day',job.verse_day,'attempts',job.attempts));
  end loop;
  return result;
end
$function$;

create or replace function public.growell_web_push_apply(p_job uuid,p_lease uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare job public.growell_web_push_jobs%rowtype; device public.growell_web_push_subscriptions%rowtype; delay integer;
begin
  select * into job from public.growell_web_push_jobs where id=p_job for update;
  if not found or p_lease is null or job.lease_token is distinct from p_lease or job.status not in ('claimed','sending') then return jsonb_build_object('applied',false);end if;
  if p_operation='accepted' and job.status='sending' then
    update public.growell_web_push_jobs set status='sent',sent_at=clock_timestamp(),lease_until=null,last_error=null where id=p_job;
    update public.growell_web_push_subscriptions set last_sent_at=clock_timestamp(),last_error=null
      where id=job.subscription_id and generation=job.generation;
    return jsonb_build_object('applied',true);
  elsif p_operation='uncertain' and job.status='sending' then
    update public.growell_web_push_jobs set status='review',last_error='delivery-uncertain',lease_until=null where id=p_job;
    return jsonb_build_object('applied',true);
  elsif p_operation='gone' then
    update public.growell_web_push_jobs set status='cancelled',last_error='subscription-expired',lease_until=null where id=p_job;
    update public.growell_web_push_subscriptions set enabled=false,subscription_cipher=null,generation=gen_random_uuid(),last_error='subscription-expired'
      where id=job.subscription_id and generation=job.generation;
    return jsonb_build_object('applied',true);
  end if;
  if job.lease_until<=clock_timestamp() then return jsonb_build_object('applied',false);end if;
  if p_operation='retry' then
    if coalesce(p_payload->>'error_code','') not in ('push-unavailable','service-unavailable','rate-limited') then raise exception 'Invalid retry reason' using errcode='22023';end if;
    delay:=least(3600,greatest(60,coalesce((p_payload->>'retry_after')::integer,300)));
    update public.growell_web_push_jobs set status=case when attempts>=5 then 'review' else 'pending' end,
      available_at=clock_timestamp()+make_interval(secs=>delay),lease_token=null,lease_until=null,last_error=p_payload->>'error_code' where id=p_job;
    return jsonb_build_object('applied',true);
  end if;
  if p_operation is null or p_operation not in ('snapshot','prepare') then raise exception 'Invalid push operation' using errcode='22023';end if;
  if job.status<>'claimed' then return jsonb_build_object('applied',false);end if;
  select * into device from public.growell_web_push_subscriptions where id=job.subscription_id for share;
  if device.owner_id is distinct from job.owner_id or device.auth_user_id is distinct from job.auth_user_id
    or job.expires_at<=clock_timestamp()
    or (job.kind='post' and not exists(select 1 from public.posts p where p.id=job.post_id and p.book_id=job.book_id))
    or (job.kind='material' and not exists(select 1 from public.material_notes m where m.id=job.material_id and m.book_id=job.book_id))
    or (job.kind='meeting' and not exists(select 1 from public.growell_meeting_records r where r.id=job.meeting_id and r.book_id=job.book_id and r.round=job.meeting_round and job.source_key=r.id::text))
    or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date)
    or not public.growell_web_push_eligible(job.subscription_id,job.kind,case when job.kind='meeting' then job.meeting_id::text when job.kind='material' then job.material_id else job.post_id end,job.generation) then
    update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible',lease_until=null where id=p_job;
    return jsonb_build_object('applied',false);
  end if;
  if p_operation='prepare' then update public.growell_web_push_jobs set status='sending',lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;end if;
  return jsonb_build_object('applied',true,'subscription_cipher',device.subscription_cipher,'owner_id',device.owner_id,
    'auth_user_id',device.auth_user_id,'endpoint_hash',device.fingerprint,'kind',job.kind,'post_id',job.post_id,'material_id',job.material_id,
    'meeting_id',job.meeting_id,'meeting_round',job.meeting_round,'book_id',job.book_id,'verse_day',job.verse_day,'expires_at',job.expires_at);
end
$function$;

revoke all on function public.growell_web_push_eligible(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.growell_web_push_capture_meeting() from public,anon,authenticated;
revoke all on function public.growell_web_push_claim(integer) from public,anon,authenticated;
revoke all on function public.growell_web_push_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_web_push_claim(integer) to service_role;
grant execute on function public.growell_web_push_apply(uuid,uuid,text,jsonb) to service_role;
commit;
