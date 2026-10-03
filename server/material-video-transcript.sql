-- Native YouTube captions only. Independent of summaries and existing materials.
-- Only the application server may access this cache. Safe to apply again.
begin;

create table if not exists public.growell_material_transcript_cache (
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  version integer not null check (version between 1 and 999),
  state text not null check (state in ('pending','ready','unavailable')),
  transcript jsonb,
  fetched_at timestamptz,
  reason text check (reason in ('transcript_unavailable','video_unavailable','not_configured','rate_limited','temporary_error')),
  retry_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  job_id text check (job_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  job_started_at timestamptz,
  poll_attempts integer not null default 0 check (poll_attempts between 0 and 10),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(video_id,version),
  check ((state='ready' and transcript is not null and fetched_at is not null) or (state<>'ready' and transcript is null))
);
alter table public.growell_material_transcript_cache add column if not exists requested_language text not null default 'ko' check (requested_language in ('ko','en'));
alter table public.growell_material_transcript_cache add column if not exists fallback_reserved boolean not null default false;
create table if not exists public.growell_material_transcript_usage (
  usage_day date not null,
  owner_id text not null, -- Empty string is the global paid-request counter.
  attempts integer not null default 0 check (attempts>=0),
  primary key(usage_day,owner_id)
);
alter table public.growell_material_transcript_cache enable row level security;
alter table public.growell_material_transcript_usage enable row level security;
revoke all on public.growell_material_transcript_cache,public.growell_material_transcript_usage from public,anon,authenticated;
grant select,insert,update,delete on public.growell_material_transcript_cache,public.growell_material_transcript_usage to service_role;

create or replace function public.growell_material_transcript_claim(p_video text,p_version integer,p_owner text,p_auth uuid,p_lease uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_transcript_cache%rowtype;
  day_key date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  now_at timestamptz := clock_timestamp();
  global_total integer;
  member_total integer;
  rolling_total bigint;
begin
  if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' or p_version is null or p_version not between 1 and 999
    or p_owner is null or p_owner='' or p_auth is null or p_lease is null then
    raise exception 'invalid transcript request' using errcode='22023';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.is_deleted=false and p.approval_status='approved') then
    raise exception 'active membership required' using errcode='42501';
  end if;
  -- A single short transaction serializes cache misses and all spending limits,
  -- including two different videos requested at the same time.
  perform pg_advisory_xact_lock(70463922);
  select * into entry from public.growell_material_transcript_cache where video_id=p_video and version=p_version for update;
  if found then
    if entry.state='ready' then
      return jsonb_build_object('status','ready','transcript',entry.transcript,'fetchedAt',entry.fetched_at);
    end if;
    if entry.lease_until>now_at then return jsonb_build_object('status','pending','retryAfter',5);end if;
    if entry.retry_at>now_at then
      if entry.state='pending' then return jsonb_build_object('status','pending','retryAfter',5);end if;
      return jsonb_build_object('status','unavailable','reason',coalesce(entry.reason,'temporary_error'),
        'retryAfter',greatest(3,ceil(extract(epoch from entry.retry_at-now_at))::integer));
    end if;
  end if;
  -- An unconfigured provider never spends quota and does not invalidate a cache.
  if p_enabled is distinct from true then return jsonb_build_object('status','unavailable','reason','not_configured','retryAfter',300);end if;
  if entry.job_id is not null then
    if entry.poll_attempts>=10 or entry.job_started_at is null or entry.job_started_at<now_at-interval '10 minutes' then
      update public.growell_material_transcript_cache set state='unavailable',reason='temporary_error',retry_at=now_at+interval '15 minutes',
        lease_token=null,lease_until=null,job_id=null,job_started_at=null,poll_attempts=0,updated_at=now_at where video_id=p_video and version=p_version;
      return jsonb_build_object('status','unavailable','reason','temporary_error','retryAfter',900);
    end if;
    -- Supadata job-status requests cost no credits. They still get an exclusive
    -- lease, a 10-poll/10-minute bound, and never re-send the original video URL.
    update public.growell_material_transcript_cache set state='pending',reason=null,retry_at=null,
      lease_token=p_lease,lease_until=now_at+interval '90 seconds',poll_attempts=poll_attempts+1,updated_at=now_at where video_id=p_video and version=p_version;
    return jsonb_build_object('status','claimed','jobId',entry.job_id,'requestedLanguage',entry.requested_language);
  end if;
  insert into public.growell_material_transcript_usage(usage_day,owner_id) values(day_key,''),(day_key,p_owner) on conflict do nothing;
  select attempts into global_total from public.growell_material_transcript_usage where usage_day=day_key and owner_id='';
  select attempts into member_total from public.growell_material_transcript_usage where usage_day=day_key and owner_id=p_owner;
  -- A rolling 31-day cap is deliberately stricter than a calendar-month cap so
  -- an unknown provider billing-cycle boundary cannot double the free allowance.
  select coalesce(sum(attempts),0) into rolling_total from public.growell_material_transcript_usage where owner_id='' and usage_day>=day_key-30;
  if global_total>=20 or member_total>=10 or rolling_total>=100 then
    return jsonb_build_object('status','unavailable','reason','rate_limited','retryAfter',3600);
  end if;
  update public.growell_material_transcript_usage set attempts=attempts+1 where usage_day=day_key and owner_id in('',p_owner);
  delete from public.growell_material_transcript_usage where usage_day<day_key-31;
  insert into public.growell_material_transcript_cache(video_id,version,state,lease_token,lease_until,updated_at)
    values(p_video,p_version,'pending',p_lease,now_at+interval '90 seconds',now_at)
    on conflict(video_id,version) do update set state='pending',transcript=null,fetched_at=null,reason=null,retry_at=null,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,job_id=null,job_started_at=null,poll_attempts=0,
      requested_language='ko',fallback_reserved=false,updated_at=excluded.updated_at;
  return jsonb_build_object('status','claimed');
end $$;

-- A second paid request for an available English track needs its own quota.
-- Reservation is at most once per extraction, including asynchronous polls.
create or replace function public.growell_material_transcript_reserve_fallback(p_video text,p_version integer,p_owner text,p_auth uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_transcript_cache%rowtype;
  day_key date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  global_total integer;
  member_total integer;
  rolling_total bigint;
begin
  if not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.is_deleted=false and p.approval_status='approved') then
    raise exception 'active membership required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(70463922);
  select * into entry from public.growell_material_transcript_cache where video_id=p_video and version=p_version for update;
  if not found or entry.state<>'pending' or p_lease is null or entry.lease_token is distinct from p_lease
    or entry.lease_until<=clock_timestamp() or entry.fallback_reserved or entry.requested_language<>'ko' then
    return jsonb_build_object('reserved',false);
  end if;
  insert into public.growell_material_transcript_usage(usage_day,owner_id) values(day_key,''),(day_key,p_owner) on conflict do nothing;
  select attempts into global_total from public.growell_material_transcript_usage where usage_day=day_key and owner_id='';
  select attempts into member_total from public.growell_material_transcript_usage where usage_day=day_key and owner_id=p_owner;
  select coalesce(sum(attempts),0) into rolling_total from public.growell_material_transcript_usage where owner_id='' and usage_day>=day_key-30;
  if global_total>=20 or member_total>=10 or rolling_total>=100 then return jsonb_build_object('reserved',false);end if;
  update public.growell_material_transcript_usage set attempts=attempts+1 where usage_day=day_key and owner_id in('',p_owner);
  update public.growell_material_transcript_cache set fallback_reserved=true where video_id=p_video and version=p_version;
  return jsonb_build_object('reserved',true);
end $$;

create or replace function public.growell_material_transcript_finish(p_video text,p_version integer,p_lease uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_transcript_cache%rowtype;
  now_at timestamptz := clock_timestamp();
  content_text text;
  language_code text;
  native_transcript jsonb;
  result_job text;
  requested_lang text;
  title_text text;
  reason_code text;
  retry_seconds integer;
begin
  select * into entry from public.growell_material_transcript_cache where video_id=p_video and version=p_version for update;
  if not found or entry.state<>'pending' or entry.lease_token is distinct from p_lease
    or p_lease is null or entry.lease_until<=now_at then return jsonb_build_object('status','pending','retryAfter',5);end if;
  if p_result->>'status'='ready' then
    content_text:=p_result#>>'{transcript,text}';language_code:=p_result#>>'{transcript,language}';
    if jsonb_typeof(p_result#>'{transcript,text}') is distinct from 'string' or length(btrim(coalesce(content_text,'')))=0
      or octet_length(content_text)>2097152 or regexp_replace(content_text,E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
      or jsonb_typeof(p_result#>'{transcript,language}') is distinct from 'string' or language_code !~ '^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,5}$'
      or p_result#>>'{transcript,source}' is distinct from 'youtube_captions' then
      raise exception 'invalid native transcript' using errcode='22023';
    end if;
    native_transcript:=jsonb_build_object('text',content_text,'language',language_code,'source','youtube_captions');
    title_text:=btrim(p_result#>>'{transcript,title}');
    if jsonb_typeof(p_result#>'{transcript,title}')='string' and length(title_text) between 1 and 300 and title_text !~ '[[:cntrl:]]' then
      native_transcript:=native_transcript||jsonb_build_object('title',title_text);
    end if;
    update public.growell_material_transcript_cache set state='ready',transcript=native_transcript,fetched_at=now_at,reason=null,retry_at=null,
      lease_token=null,lease_until=null,job_id=null,job_started_at=null,poll_attempts=0,updated_at=now_at where video_id=p_video and version=p_version;
    return jsonb_build_object('status','ready','transcript',native_transcript,'fetchedAt',now_at);
  end if;
  if p_result->>'status'='pending' then
    result_job:=p_result->>'jobId';
    requested_lang:=coalesce(p_result->>'requestedLanguage','ko');
    if jsonb_typeof(p_result->'jobId') is distinct from 'string' or result_job !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
      or requested_lang not in('ko','en')
      or (requested_lang='en' and not entry.fallback_reserved)
      or (entry.requested_language='en' and requested_lang<>'en')
      or (entry.job_id is not null and entry.job_id is distinct from result_job
        and not (entry.requested_language='ko' and requested_lang='en' and entry.fallback_reserved)) then
      raise exception 'invalid transcript job' using errcode='22023';
    end if;
    update public.growell_material_transcript_cache set state='pending',job_id=result_job,requested_language=requested_lang,job_started_at=coalesce(entry.job_started_at,now_at),
      reason=null,retry_at=now_at+interval '5 seconds',lease_token=null,lease_until=null,updated_at=now_at where video_id=p_video and version=p_version;
    return jsonb_build_object('status','pending','retryAfter',5);
  end if;
  reason_code:=p_result->>'reason';
  if reason_code is null or reason_code not in('transcript_unavailable','video_unavailable','not_configured','rate_limited','temporary_error') then reason_code:='temporary_error';end if;
  retry_seconds:=case reason_code when 'transcript_unavailable' then 604800 when 'video_unavailable' then 604800
    when 'not_configured' then 300 when 'rate_limited' then 3600 else 900 end;
  update public.growell_material_transcript_cache set state='unavailable',transcript=null,fetched_at=null,reason=reason_code,
    retry_at=now_at+make_interval(secs=>retry_seconds),lease_token=null,lease_until=null,
    job_id=case when reason_code in('transcript_unavailable','video_unavailable') then null else job_id end,
    job_started_at=case when reason_code in('transcript_unavailable','video_unavailable') then null else job_started_at end,
    updated_at=now_at where video_id=p_video and version=p_version;
  return jsonb_build_object('status','unavailable','reason',reason_code,'retryAfter',retry_seconds);
end $$;

revoke all on function public.growell_material_transcript_claim(text,integer,text,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.growell_material_transcript_finish(text,integer,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.growell_material_transcript_reserve_fallback(text,integer,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.growell_material_transcript_claim(text,integer,text,uuid,uuid,boolean) to service_role;
grant execute on function public.growell_material_transcript_finish(text,integer,uuid,jsonb) to service_role;
grant execute on function public.growell_material_transcript_reserve_fallback(text,integer,text,uuid,uuid) to service_role;
commit;
