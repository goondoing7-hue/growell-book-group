-- Public-video summaries only. No post content, user names, tokens or transcripts
-- are stored here. Execute once with the database administrator; safe to reapply.
begin;

create table if not exists public.growell_material_video_cache (
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  version integer not null check (version between 1 and 999),
  state text not null check (state in ('pending','ready','unavailable')),
  summary jsonb,
  generated_at timestamptz,
  reason text check (reason in ('video_unavailable','not_configured','rate_limited','temporary_error')),
  retry_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(video_id,version),
  check ((state='ready' and summary is not null and generated_at is not null) or (state<>'ready' and summary is null))
);
create table if not exists public.growell_material_video_usage (
  usage_day date not null,
  owner_id text not null, -- Empty string is the global daily counter.
  attempts integer not null default 0 check (attempts>=0),
  primary key(usage_day,owner_id)
);
alter table public.growell_material_video_cache enable row level security;
alter table public.growell_material_video_usage enable row level security;
revoke all on public.growell_material_video_cache,public.growell_material_video_usage from public,anon,authenticated;
grant select,insert,update,delete on public.growell_material_video_cache,public.growell_material_video_usage to service_role;

create or replace function public.growell_material_video_claim(p_video text,p_version integer,p_owner text,p_auth uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_video_cache%rowtype;
  day_key date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  now_at timestamptz := clock_timestamp();
  total integer;
  member_total integer;
begin
  if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' or p_version is null or p_version not between 1 and 999
    or p_owner is null or p_owner='' or p_auth is null or p_lease is null then
    raise exception 'invalid video summary request' using errcode='22023';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.is_deleted=false and p.approval_status='approved') then
    raise exception 'active membership required' using errcode='42501';
  end if;
  -- All claims share this brief transaction lock: an absent cache entry and both
  -- daily counters are decided atomically, including concurrent HTTP requests.
  perform pg_advisory_xact_lock(70463921);
  select * into entry from public.growell_material_video_cache where video_id=p_video and version=p_version for update;
  if found then
    if entry.state='ready' then
      return jsonb_build_object('status','ready','summary',entry.summary,'generatedAt',entry.generated_at);
    end if;
    if entry.state='pending' and entry.lease_until>now_at then return jsonb_build_object('status','pending','retryAfter',3);end if;
    if entry.retry_at>now_at then
      return jsonb_build_object('status','unavailable','reason',coalesce(entry.reason,'temporary_error'),
        'retryAfter',greatest(3,ceil(extract(epoch from entry.retry_at-now_at))::integer));
    end if;
  end if;
  insert into public.growell_material_video_usage(usage_day,owner_id) values(day_key,''),(day_key,p_owner) on conflict do nothing;
  select attempts into total from public.growell_material_video_usage where usage_day=day_key and owner_id='';
  select attempts into member_total from public.growell_material_video_usage where usage_day=day_key and owner_id=p_owner;
  if total>=50 or member_total>=10 then return jsonb_build_object('status','unavailable','reason','rate_limited','retryAfter',3600);end if;
  update public.growell_material_video_usage set attempts=attempts+1 where usage_day=day_key and owner_id in('',p_owner);
  delete from public.growell_material_video_usage where usage_day<day_key-31;
  insert into public.growell_material_video_cache(video_id,version,state,lease_token,lease_until,updated_at)
    values(p_video,p_version,'pending',p_lease,now_at+interval '90 seconds',now_at)
    on conflict(video_id,version) do update set state='pending',summary=null,generated_at=null,reason=null,retry_at=null,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at;
  return jsonb_build_object('status','claimed');
end $$;

create or replace function public.growell_material_video_finish(p_video text,p_version integer,p_lease uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_video_cache%rowtype;
  now_at timestamptz := clock_timestamp();
  overview text;
  points jsonb;
  point jsonb;
  reason_code text;
  retry_seconds integer;
begin
  select * into entry from public.growell_material_video_cache where video_id=p_video and version=p_version for update;
  if not found or entry.state<>'pending' or entry.lease_token is distinct from p_lease
    or p_lease is null or entry.lease_until<=now_at then return jsonb_build_object('status','pending','retryAfter',3);end if;
  if p_result->>'status'='ready' then
    overview:=p_result#>>'{summary,overview}';points:=p_result#>'{summary,points}';
    if jsonb_typeof(p_result#>'{summary,overview}') is distinct from 'string' or length(btrim(coalesce(overview,'')))=0
      or length(overview)>1200 or jsonb_typeof(points) is distinct from 'array' then
      raise exception 'invalid video summary result' using errcode='22023';
    end if;
    if jsonb_array_length(points) not between 1 and 8 then raise exception 'invalid video summary points' using errcode='22023';end if;
    for point in select value from jsonb_array_elements(points) loop
      if jsonb_typeof(point) is distinct from 'string' or length(btrim(point#>>'{}'))=0 or length(point#>>'{}')>600 then
        raise exception 'invalid video summary point' using errcode='22023';
      end if;
    end loop;
    update public.growell_material_video_cache set state='ready',summary=jsonb_build_object('overview',overview,'points',points),
      generated_at=now_at,reason=null,retry_at=null,lease_token=null,lease_until=null,updated_at=now_at
      where video_id=p_video and version=p_version;
    return jsonb_build_object('status','ready','summary',jsonb_build_object('overview',overview,'points',points),'generatedAt',now_at);
  end if;
  reason_code:=p_result->>'reason';
  if reason_code is null or reason_code not in('video_unavailable','not_configured','rate_limited','temporary_error') then reason_code:='temporary_error';end if;
  retry_seconds:=case reason_code when 'video_unavailable' then 86400 when 'rate_limited' then 3600 when 'not_configured' then 300 else 900 end;
  update public.growell_material_video_cache set state='unavailable',summary=null,generated_at=null,reason=reason_code,
    retry_at=now_at+make_interval(secs=>retry_seconds),lease_token=null,lease_until=null,updated_at=now_at where video_id=p_video and version=p_version;
  return jsonb_build_object('status','unavailable','reason',reason_code,'retryAfter',retry_seconds);
end $$;

revoke all on function public.growell_material_video_claim(text,integer,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.growell_material_video_finish(text,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.growell_material_video_claim(text,integer,text,uuid,uuid) to service_role;
grant execute on function public.growell_material_video_finish(text,integer,uuid,jsonb) to service_role;

commit;
