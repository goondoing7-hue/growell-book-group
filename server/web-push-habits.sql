-- Additive 23:00 KST habit check reminders. Apply AFTER web-push-meetings.sql
-- and the habit-aware API/service worker deploy. No authored row is changed,
-- no historical queue is created, and no existing ON/OFF choice is reset.
begin;
do $guard$
begin
  if to_regclass('public.habits') is null or to_regclass('public.growell_web_push_jobs') is null
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='growell_web_push_jobs' and column_name='meeting_id') then
    raise exception 'Apply habits and meeting-aware push schema first';end if;
  if (select count(*) from information_schema.columns where table_schema='public' and table_name='habits'
    and column_name in ('id','user_id','book_id','start_date','end_date','weekdays','checked_dates'))<>7 then
    raise exception 'Expected existing habit schedule and check columns';end if;
end
$guard$;
alter table public.growell_web_push_subscriptions add column if not exists habit_check boolean not null default true;
alter table public.growell_web_push_jobs add column if not exists habit_day date;
do $columns$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='growell_web_push_subscriptions'
    and column_name='habit_check' and data_type='boolean' and is_nullable='NO')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='growell_web_push_jobs' and column_name='habit_day' and data_type='date')
    or not exists(select 1 from pg_catalog.pg_attribute where attrelid='public.habits'::regclass and attname='weekdays' and atttypid='integer[]'::regtype and not attisdropped) then
    raise exception 'Incompatible habit push columns; no changes committed';end if;
end
$columns$;
alter table public.growell_web_push_jobs drop constraint if exists growell_web_push_jobs_kind_check;
alter table public.growell_web_push_jobs add constraint growell_web_push_jobs_kind_check check(kind in ('post','material','meeting','verse','habit','test'));
alter table public.growell_web_push_jobs drop constraint if exists growell_web_push_jobs_habit_check;
alter table public.growell_web_push_jobs add constraint growell_web_push_jobs_habit_check check(kind<>'habit' or (habit_day is not null and source_key=habit_day::text));

create or replace function public.growell_web_push_habit_date(p_value text)
returns date language plpgsql immutable set search_path=''
as $function$
begin
  if p_value is null or p_value !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' then return null;end if;
  return p_value::date;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end
$function$;

create or replace function public.growell_web_push_habit_pending(p_owner text,p_day date)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(select 1 from public.habits h join public.profiles p on p.id=h.user_id
    where h.user_id=p_owner and p.approval_status='approved' and p.is_deleted=false
      and h.book_id is not null and (p.is_admin=true or not coalesce((select b.locked from public.book_locks b where b.book_id=h.book_id),h.book_id<>'emotion'))
      and coalesce(to_jsonb(h)->>'is_deleted','false')='false' and to_jsonb(h)->>'deleted_at' is null
      and (nullif(h.start_date::text,'') is null or public.growell_web_push_habit_date(h.start_date::text)<=p_day)
      and (nullif(h.end_date::text,'') is null or public.growell_web_push_habit_date(h.end_date::text)>=p_day)
      and (h.weekdays is null or (array_ndims(h.weekdays)=1 and cardinality(h.weekdays)>0 and h.weekdays <@ array[0,1,2,3,4,5,6]
        and array_position(h.weekdays,null) is null and extract(dow from p_day)::integer=any(h.weekdays)))
      and (to_jsonb(h)->'checked_dates' is null or to_jsonb(h)->'checked_dates'='null'::jsonb
        or (jsonb_typeof(to_jsonb(h)->'checked_dates')='array' and not (to_jsonb(h)->'checked_dates' @> jsonb_build_array(p_day::text)))));
$function$;
create or replace function public.growell_web_push_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare device public.growell_web_push_subscriptions%rowtype; endpoint_fingerprint text; same_owner boolean; key_name text;
  test_requested_at timestamptz; test_available_at timestamptz;
begin
  perform 1 from public.profiles where id=p_owner and auth_user_id=p_auth and approval_status='approved' and is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_operation is null or p_operation not in ('status','connect','settings','disconnect','test') or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid push operation' using errcode='22023';end if;
  endpoint_fingerprint:=p_payload->>'fingerprint';
  if p_operation='status' and coalesce(endpoint_fingerprint,'')='' then
    return jsonb_build_object('connected',false,'deviceId',null,'newPosts',true,'dailyVerse',true,'habitCheck',true,'lastSentAt',null,'lastError',null);
  end if;
  if endpoint_fingerprint is null or endpoint_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Device fingerprint required' using errcode='22023';end if;
  for key_name in select jsonb_object_keys(p_payload) loop
    if key_name not in ('fingerprint','subscription_cipher','new_posts','daily_verse','habit_check')
      and not (key_name='delay_seconds' and p_operation='test') then
      raise exception 'Invalid device setting' using errcode='22023';end if;
  end loop;
  if p_payload ? 'delay_seconds' and (jsonb_typeof(p_payload->'delay_seconds') is distinct from 'number'
    or p_payload->'delay_seconds' not in ('0'::jsonb,'60'::jsonb)) then
    raise exception 'Invalid test delay' using errcode='22023';end if;
  if (p_payload ? 'new_posts' and jsonb_typeof(p_payload->'new_posts')<>'boolean')
    or (p_payload ? 'daily_verse' and jsonb_typeof(p_payload->'daily_verse')<>'boolean')
    or (p_payload ? 'habit_check' and jsonb_typeof(p_payload->'habit_check')<>'boolean') then
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
    insert into public.growell_web_push_subscriptions(owner_id,auth_user_id,fingerprint,subscription_cipher,new_posts,daily_verse,habit_check)
      values(p_owner,p_auth,endpoint_fingerprint,p_payload->>'subscription_cipher',coalesce((p_payload->>'new_posts')::boolean,true),coalesce((p_payload->>'daily_verse')::boolean,true),coalesce((p_payload->>'habit_check')::boolean,true))
      on conflict(fingerprint) do update set owner_id=excluded.owner_id,auth_user_id=excluded.auth_user_id,
        subscription_cipher=excluded.subscription_cipher,enabled=true,generation=gen_random_uuid(),
        new_posts=case when same_owner then growell_web_push_subscriptions.new_posts else excluded.new_posts end,
        daily_verse=case when same_owner then growell_web_push_subscriptions.daily_verse else excluded.daily_verse end,
        habit_check=case when same_owner then growell_web_push_subscriptions.habit_check else excluded.habit_check end,
        connected_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=null,
        last_test_at=case when same_owner then growell_web_push_subscriptions.last_test_at else null end,
        last_sent_at=case when same_owner then growell_web_push_subscriptions.last_sent_at else null end
      returning * into device;
  elsif not coalesce(same_owner,false) then
    if p_operation<>'status' then raise exception 'Owned device required' using errcode='42501';end if;
    return jsonb_build_object('connected',false,'deviceId',null,'newPosts',true,'dailyVerse',true,'habitCheck',true,'lastSentAt',null,'lastError',null);
  elsif p_operation='settings' then
    update public.growell_web_push_subscriptions set new_posts=coalesce((p_payload->>'new_posts')::boolean,new_posts),
      daily_verse=coalesce((p_payload->>'daily_verse')::boolean,daily_verse),habit_check=coalesce((p_payload->>'habit_check')::boolean,habit_check),updated_at=clock_timestamp() where id=device.id returning * into device;
  elsif p_operation='disconnect' then
    update public.growell_web_push_subscriptions set enabled=false,subscription_cipher=null,generation=gen_random_uuid(),
      updated_at=clock_timestamp(),last_error=null where id=device.id returning * into device;
  elsif p_operation='test' then
    if not public.growell_web_push_eligible(device.id,'test') then raise exception 'Active device required' using errcode='55000';end if;
    if device.last_test_at>clock_timestamp()-interval '60 seconds' then raise exception 'Test cooldown' using errcode='54000';end if;
    test_requested_at:=clock_timestamp();
    test_available_at:=test_requested_at+make_interval(secs=>case when p_payload->'delay_seconds'='60'::jsonb then 60 else 0 end);
    insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,available_at,expires_at)
      values(device.id,p_owner,p_auth,device.generation,'test',floor(extract(epoch from test_requested_at)/60)::text,test_available_at,test_available_at+interval '5 minutes')
      on conflict(subscription_id,kind,source_key) do nothing;
    update public.growell_web_push_subscriptions set last_test_at=test_requested_at where id=device.id returning * into device;
  end if;
  return jsonb_build_object('connected',device.enabled and device.subscription_cipher is not null,'deviceId',device.id,
    'newPosts',device.new_posts,'dailyVerse',device.daily_verse,'habitCheck',device.habit_check,'lastSentAt',device.last_sent_at,'lastError',device.last_error);
end
$function$;

create or replace function public.growell_web_push_eligible(p_subscription uuid,p_kind text,p_post text default null,p_generation uuid default null)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(select 1 from public.growell_web_push_subscriptions s
    join public.profiles recipient on recipient.id=s.owner_id and recipient.auth_user_id=s.auth_user_id
    where s.id=p_subscription and s.enabled and s.subscription_cipher is not null
      and (p_generation is null or s.generation=p_generation)
      and recipient.approval_status='approved' and recipient.is_deleted=false
      and (p_kind='test' or (p_kind='verse' and s.daily_verse) or (p_kind='habit' and s.habit_check
        and p_post=(clock_timestamp() at time zone 'Asia/Seoul')::date::text
        and (clock_timestamp() at time zone 'Asia/Seoul')::time>=time '23:00'
        and (clock_timestamp() at time zone 'Asia/Seoul')::time<time '23:30'
        and public.growell_web_push_habit_pending(s.owner_id,(clock_timestamp() at time zone 'Asia/Seoul')::date)) or (p_kind='post' and s.new_posts and exists(
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

create or replace function public.growell_web_push_tick(p_now timestamptz default clock_timestamp())
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare local_now timestamp; inserted integer:=0; habit_inserted integer:=0;
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
  if local_now::time>=time '23:00' and local_now::time<time '23:15' then
    insert into public.growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,habit_day,available_at,expires_at)
      select s.id,s.owner_id,s.auth_user_id,s.generation,'habit',local_now::date::text,local_now::date,p_now,
        (local_now::date+time '23:30') at time zone 'Asia/Seoul'
      from public.growell_web_push_subscriptions s where public.growell_web_push_eligible(s.id,'habit',local_now::date::text,s.generation)
      on conflict(subscription_id,kind,source_key) do nothing;
    get diagnostics habit_inserted=row_count;
  end if;
  return jsonb_build_object('queued',inserted+habit_inserted);
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
    if not public.growell_web_push_eligible(job.subscription_id,job.kind,case when job.kind='habit' then job.habit_day::text when job.kind='meeting' then job.meeting_id::text when job.kind='material' then job.material_id else job.post_id end,job.generation)
      or not exists(select 1 from public.growell_web_push_subscriptions s where s.id=job.subscription_id and s.owner_id=job.owner_id and s.auth_user_id=job.auth_user_id)
      or (job.kind='material' and not exists(select 1 from public.material_notes m where m.id=job.material_id and m.book_id=job.book_id))
      or (job.kind='meeting' and not exists(select 1 from public.growell_meeting_records r where r.id=job.meeting_id and r.book_id=job.book_id and r.round=job.meeting_round and job.source_key=r.id::text))
      or (job.kind='habit' and (job.habit_day is null or job.source_key is distinct from job.habit_day::text))
      or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date) then
      update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible' where id=job.id;
      continue;
    end if;
    update public.growell_web_push_jobs set status='claimed',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1
      where id=job.id returning * into job;
    result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'lease_token',job.lease_token,'kind',job.kind,
      'post_id',job.post_id,'material_id',job.material_id,'meeting_id',job.meeting_id,'meeting_round',job.meeting_round,'book_id',job.book_id,'verse_day',job.verse_day,'habit_day',job.habit_day,'attempts',job.attempts));
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
    or (job.kind='habit' and (job.habit_day is null or job.source_key is distinct from job.habit_day::text))
      or (job.kind='verse' and job.verse_day<>(clock_timestamp() at time zone 'Asia/Seoul')::date)
    or not public.growell_web_push_eligible(job.subscription_id,job.kind,case when job.kind='habit' then job.habit_day::text when job.kind='meeting' then job.meeting_id::text when job.kind='material' then job.material_id else job.post_id end,job.generation) then
    update public.growell_web_push_jobs set status='cancelled',last_error='not-eligible',lease_until=null where id=p_job;
    return jsonb_build_object('applied',false);
  end if;
  if p_operation='prepare' then update public.growell_web_push_jobs set status='sending',lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;end if;
  return jsonb_build_object('applied',true,'subscription_cipher',device.subscription_cipher,'owner_id',device.owner_id,
    'auth_user_id',device.auth_user_id,'endpoint_hash',device.fingerprint,'kind',job.kind,'post_id',job.post_id,'material_id',job.material_id,
    'meeting_id',job.meeting_id,'meeting_round',job.meeting_round,'book_id',job.book_id,'verse_day',job.verse_day,'habit_day',job.habit_day,'expires_at',job.expires_at);
end
$function$;
revoke all on function public.growell_web_push_habit_date(text) from public,anon,authenticated;
revoke all on function public.growell_web_push_habit_pending(text,date) from public,anon,authenticated;
revoke all on function public.growell_web_push_eligible(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.growell_web_push_configure(text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.growell_web_push_tick(timestamptz) from public,anon,authenticated;
revoke all on function public.growell_web_push_claim(integer) from public,anon,authenticated;
revoke all on function public.growell_web_push_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_web_push_configure(text,uuid,text,jsonb),public.growell_web_push_tick(timestamptz),
  public.growell_web_push_claim(integer),public.growell_web_push_apply(uuid,uuid,text,jsonb) to service_role;
commit;
