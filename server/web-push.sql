-- Additive, opt-in web push. Existing posts and private entries are never changed.
-- No legacy posts are backfilled and no endpoint or post body enters a job.
begin;
do $guard$
begin
  if to_regclass('public.posts') is null or to_regclass('public.profiles') is null
    or to_regclass('public.book_locks') is null then
    raise exception 'Apply existing profiles, posts and book locks first';
  end if;
end
$guard$;

create table if not exists public.growell_web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.profiles(id),
  auth_user_id uuid not null,
  fingerprint text not null unique check(fingerprint ~ '^[0-9a-f]{64}$'),
  subscription_cipher text check(char_length(subscription_cipher) between 32 and 32768),
  generation uuid not null default gen_random_uuid(),
  enabled boolean not null default true,
  new_posts boolean not null default true,
  daily_verse boolean not null default true,
  connected_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_test_at timestamptz,
  last_sent_at timestamptz,
  last_error text
);
create table if not exists public.growell_web_push_jobs (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.growell_web_push_subscriptions(id),
  owner_id text not null,
  auth_user_id uuid not null,
  generation uuid not null,
  kind text not null check(kind in ('post','verse','test')),
  source_key text not null,
  post_id text,
  book_id text,
  verse_day date,
  status text not null default 'pending' check(status in ('pending','claimed','sending','sent','cancelled','review')),
  available_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique(subscription_id,kind,source_key)
);
alter table public.growell_web_push_subscriptions enable row level security;
alter table public.growell_web_push_jobs enable row level security;
revoke all on public.growell_web_push_subscriptions,public.growell_web_push_jobs from public,anon,authenticated;
grant select,insert,update on public.growell_web_push_subscriptions,public.growell_web_push_jobs to service_role;
create index if not exists growell_web_push_due on public.growell_web_push_jobs(available_at,created_at)
  where status in ('pending','claimed','sending');

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
            or not coalesce((select b.locked from public.book_locks b where b.book_id=p.book_id),p.book_id<>'emotion'))))));
$function$;

create or replace function public.growell_web_push_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare device public.growell_web_push_subscriptions%rowtype; endpoint_fingerprint text; same_owner boolean; key_name text;
begin
  perform 1 from public.profiles where id=p_owner and auth_user_id=p_auth and approval_status='approved' and is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_operation is null or p_operation not in ('status','connect','settings','disconnect','test') or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid push operation' using errcode='22023';end if;
  endpoint_fingerprint:=p_payload->>'fingerprint';
  if p_operation='status' and coalesce(endpoint_fingerprint,'')='' then
    return jsonb_build_object('connected',false,'deviceId',null,'newPosts',true,'dailyVerse',true,'lastSentAt',null,'lastError',null);
  end if;
  if endpoint_fingerprint is null or endpoint_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Device fingerprint required' using errcode='22023';end if;
  for key_name in select jsonb_object_keys(p_payload) loop
    if key_name not in ('fingerprint','subscription_cipher','new_posts','daily_verse') then
      raise exception 'Invalid device setting' using errcode='22023';end if;
  end loop;
  if (p_payload ? 'new_posts' and jsonb_typeof(p_payload->'new_posts')<>'boolean')
    or (p_payload ? 'daily_verse' and jsonb_typeof(p_payload->'daily_verse')<>'boolean') then
    raise exception 'Boolean preferences required' using errcode='22023';end if;
  -- Serialize owner device limits and endpoint transfers without exposing owners.
  perform pg_advisory_xact_lock(hashtextextended('growell-web-push-owner:'||p_owner,0));
  perform pg_advisory_xact_lock(hashtextextended('growell-web-push-device:'||endpoint_fingerprint,0));
  select * into device from public.growell_web_push_subscriptions s where s.fingerprint=endpoint_fingerprint for update;
  same_owner:=found and device.owner_id=p_owner and device.auth_user_id=p_auth;
  if p_operation='connect' then
    if jsonb_typeof(p_payload->'subscription_cipher') is distinct from 'string'
      or char_length(p_payload->>'subscription_cipher') not between 32 and 32768 then
      raise exception 'Encrypted subscription required' using errcode='22023';end if;
    if not coalesce(same_owner and device.enabled,false)
      and (select count(*) from public.growell_web_push_subscriptions where owner_id=p_owner and auth_user_id=p_auth and enabled)>=5 then
      raise exception 'Device limit reached' using errcode='54000';end if;
    insert into public.growell_web_push_subscriptions(owner_id,auth_user_id,fingerprint,subscription_cipher,new_posts,daily_verse)
      values(p_owner,p_auth,endpoint_fingerprint,p_payload->>'subscription_cipher',coalesce((p_payload->>'new_posts')::boolean,true),coalesce((p_payload->>'daily_verse')::boolean,true))
      on conflict(fingerprint) do update set owner_id=excluded.owner_id,auth_user_id=excluded.auth_user_id,
        subscription_cipher=excluded.subscription_cipher,enabled=true,generation=gen_random_uuid(),
        new_posts=case when same_owner then growell_web_push_subscriptions.new_posts else excluded.new_posts end,
        daily_verse=case when same_owner then growell_web_push_subscriptions.daily_verse else excluded.daily_verse end,
        connected_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=null,
        last_test_at=case when same_owner then growell_web_push_subscriptions.last_test_at else null end,
        last_sent_at=case when same_owner then growell_web_push_subscriptions.last_sent_at else null end
      returning * into device;
  elsif not coalesce(same_owner,false) then
    if p_operation<>'status' then raise exception 'Owned device required' using errcode='42501';end if;
    return jsonb_build_object('connected',false,'deviceId',null,'newPosts',true,'dailyVerse',true,'lastSentAt',null,'lastError',null);
  elsif p_operation='settings' then
    update public.growell_web_push_subscriptions set new_posts=coalesce((p_payload->>'new_posts')::boolean,new_posts),
      daily_verse=coalesce((p_payload->>'daily_verse')::boolean,daily_verse),updated_at=clock_timestamp() where id=device.id returning * into device;
  elsif p_operation='disconnect' then
    update public.growell_web_push_subscriptions set enabled=false,subscription_cipher=null,generation=gen_random_uuid(),
      updated_at=clock_timestamp(),last_error=null where id=device.id returning * into device;
  elsif p_operation='test' then
    if not public.growell_web_push_eligible(device.id,'test') then raise exception 'Active device required' using errcode='55000';end if;
    if device.last_test_at>clock_timestamp()-interval '60 seconds' then raise exception 'Test cooldown' using errcode='54000';end if;
    insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,expires_at)
      values(device.id,p_owner,p_auth,device.generation,'test',floor(extract(epoch from clock_timestamp())/60)::text,clock_timestamp()+interval '10 minutes')
      on conflict(subscription_id,kind,source_key) do nothing;
    update public.growell_web_push_subscriptions set last_test_at=clock_timestamp() where id=device.id returning * into device;
  end if;
  return jsonb_build_object('connected',device.enabled and device.subscription_cipher is not null,'deviceId',device.id,
    'newPosts',device.new_posts,'dailyVerse',device.daily_verse,'lastSentAt',device.last_sent_at,'lastError',device.last_error);
end
$function$;

create or replace function public.growell_web_push_capture()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,post_id,book_id,expires_at)
    select s.id,s.owner_id,s.auth_user_id,s.generation,'post',new.id,new.id,new.book_id,clock_timestamp()+interval '1 day'
    from public.growell_web_push_subscriptions s where public.growell_web_push_eligible(s.id,'post',new.id,s.generation)
    on conflict(subscription_id,kind,source_key) do nothing;
  return new;
end
$function$;
drop trigger if exists growell_web_push_new_post on public.posts;
create trigger growell_web_push_new_post after insert on public.posts for each row execute function public.growell_web_push_capture();

create or replace function public.growell_web_push_tick(p_now timestamptz default clock_timestamp())
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare local_now timestamp; inserted integer:=0;
begin
  local_now:=p_now at time zone 'Asia/Seoul';
  if local_now::time>=time '09:00' and local_now::time<time '09:15' then
    insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,verse_day,available_at,expires_at)
      select s.id,s.owner_id,s.auth_user_id,s.generation,'verse',local_now::date::text,local_now::date,p_now,
        (local_now::date+time '10:00') at time zone 'Asia/Seoul'
      from public.growell_web_push_subscriptions s where public.growell_web_push_eligible(s.id,'verse',null,s.generation)
      on conflict(subscription_id,kind,source_key) do nothing;
    get diagnostics inserted=row_count;
  end if;
  return jsonb_build_object('queued',inserted);
end
$function$;

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
    if not public.growell_web_push_eligible(job.subscription_id,job.kind,job.post_id,job.generation)
      or not exists(select 1 from public.growell_web_push_subscriptions s where s.id=job.subscription_id and s.owner_id=job.owner_id and s.auth_user_id=job.auth_user_id)
      or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date) then
      update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible' where id=job.id;
      continue;
    end if;
    update public.growell_web_push_jobs set status='claimed',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1
      where id=job.id returning * into job;
    result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'lease_token',job.lease_token,'kind',job.kind,
      'post_id',job.post_id,'book_id',job.book_id,'verse_day',job.verse_day,'attempts',job.attempts));
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
    or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date)
    or not public.growell_web_push_eligible(job.subscription_id,job.kind,job.post_id,job.generation) then
    update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible',lease_until=null where id=p_job;
    return jsonb_build_object('applied',false);
  end if;
  if p_operation='prepare' then update public.growell_web_push_jobs set status='sending',lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;end if;
  return jsonb_build_object('applied',true,'subscription_cipher',device.subscription_cipher,'owner_id',device.owner_id,
    'auth_user_id',device.auth_user_id,'endpoint_hash',device.fingerprint,'kind',job.kind,'post_id',job.post_id,'book_id',job.book_id,'verse_day',job.verse_day,'expires_at',job.expires_at);
end
$function$;

create or replace function public.growell_web_push_worker_authorized(p_secret text)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare expected text;
begin
  if p_secret is null or char_length(p_secret) not between 32 and 256 then return false;end if;
  select case when count(*)=1 then max(decrypted_secret) end into expected from vault.decrypted_secrets where name='growell_habit_sync_worker_secret';
  if expected is null or char_length(expected) not between 32 and 256 then return false;end if;
  return pg_catalog.sha256(pg_catalog.convert_to(p_secret,'UTF8'))=pg_catalog.sha256(pg_catalog.convert_to(expected,'UTF8'));
end
$function$;
revoke all on function public.growell_web_push_eligible(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.growell_web_push_capture() from public,anon,authenticated;
revoke all on function public.growell_web_push_configure(text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.growell_web_push_tick(timestamptz) from public,anon,authenticated;
revoke all on function public.growell_web_push_claim(integer) from public,anon,authenticated;
revoke all on function public.growell_web_push_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.growell_web_push_worker_authorized(text) from public,anon,authenticated;
grant execute on function public.growell_web_push_configure(text,uuid,text,jsonb) to service_role;
grant execute on function public.growell_web_push_tick(timestamptz) to service_role;
grant execute on function public.growell_web_push_claim(integer) to service_role;
grant execute on function public.growell_web_push_apply(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.growell_web_push_worker_authorized(text) to service_role;
commit;
