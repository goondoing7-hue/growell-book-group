-- Apply after material-video-transcript.sql. Native captions stay immutable.
-- One durable Korean translation per caption version; refreshes never retry a
-- paid generation. Failed/partial output is retained privately for diagnosis.
begin;
create table if not exists public.growell_material_translation_cache (
  generation_id uuid primary key,
  video_id text not null,
  transcript_version integer not null,
  translation_version integer not null check (translation_version between 1 and 999),
  owner_id text not null,
  state text not null check (state in ('pending','ready','unavailable')),
  translation jsonb,
  partial_output jsonb,
  model text,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  duration_ms integer check (duration_ms >= 0),
  reason text,
  lease_until timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique(video_id,transcript_version,translation_version),
  foreign key(video_id,transcript_version) references public.growell_material_transcript_cache(video_id,version),
  check ((state='ready' and translation is not null) or (state<>'ready' and translation is null))
);
create index if not exists growell_material_translation_created on public.growell_material_translation_cache(created_at);
alter table public.growell_material_translation_cache enable row level security;
revoke all on public.growell_material_translation_cache from public,anon,authenticated;
grant select,insert,update on public.growell_material_translation_cache to service_role;

create or replace function public.growell_material_translation_claim(p_video text,p_version integer,p_translation_version integer,p_owner text,p_auth uuid,p_generation uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_translation_cache%rowtype;
  native public.growell_material_transcript_cache%rowtype;
  now_at timestamptz := clock_timestamp();
  day_start timestamptz := date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' or p_version is null or p_version not between 1 and 999
    or p_translation_version is null or p_translation_version not between 1 and 999 or p_generation is null then
    raise exception 'invalid translation request' using errcode='22023';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth and p.is_deleted=false and p.approval_status='approved') then
    raise exception 'active membership required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(70463923);
  select * into entry from public.growell_material_translation_cache
    where video_id=p_video and transcript_version=p_version and translation_version=p_translation_version for update;
  if found then
    if entry.state='ready' then return jsonb_build_object('status','ready','translation',entry.translation);end if;
    if entry.state='pending' and entry.lease_until>now_at then return jsonb_build_object('status','pending');end if;
    -- An interrupted generation may have already incurred cost. Never start it
    -- again merely because another reader opens or refreshes the material.
    if entry.state='pending' then
      update public.growell_material_translation_cache set state='unavailable',reason='translation_interrupted',finished_at=now_at where generation_id=entry.generation_id;
    end if;
    return jsonb_build_object('status','unavailable');
  end if;
  select * into native from public.growell_material_transcript_cache where video_id=p_video and version=p_version;
  if not found or native.state<>'ready' or lower(native.transcript->>'language') !~ '^en([-_]|$)'
    or length(native.transcript->>'text')>60000 then return jsonb_build_object('status','unavailable');end if;
  if p_enabled is distinct from true then return jsonb_build_object('status','unavailable');end if;
  if (select count(*) from public.growell_material_translation_cache where created_at>=day_start)>=20
    or (select count(*) from public.growell_material_translation_cache where created_at>=day_start and owner_id=p_owner)>=10
    or (select count(*) from public.growell_material_translation_cache where created_at>=day_start-interval '30 days')>=100 then
    return jsonb_build_object('status','unavailable');
  end if;
  insert into public.growell_material_translation_cache(generation_id,video_id,transcript_version,translation_version,owner_id,state,lease_until)
    values(p_generation,p_video,p_version,p_translation_version,p_owner,'pending',now_at+interval '90 seconds');
  return jsonb_build_object('status','claimed','generationId',p_generation);
end $$;

create or replace function public.growell_material_translation_finish(p_generation uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  entry public.growell_material_translation_cache%rowtype;
  now_at timestamptz := clock_timestamp();
  content_text text;
  model_name text;
  output jsonb;
  usage_input integer;
  usage_output integer;
  elapsed integer;
begin
  select * into entry from public.growell_material_translation_cache where generation_id=p_generation for update;
  if not found then return jsonb_build_object('status','unavailable');end if;
  if entry.state='ready' then return jsonb_build_object('status','ready','translation',entry.translation);end if;
  -- Allow an in-flight success to be saved even if a reader just observed the
  -- expired lease. The generation ID can never be replaced by a paid retry.
  if entry.state<>'pending' and entry.reason is distinct from 'translation_interrupted' then return jsonb_build_object('status','unavailable');end if;
  model_name:=p_result->>'model';
  if model_name is not null and (length(model_name)>120 or model_name ~ '[[:cntrl:]]') then raise exception 'invalid translation metadata' using errcode='22023';end if;
  if p_result->>'inputTokens' ~ '^\d{1,8}$' then usage_input:=(p_result->>'inputTokens')::integer;end if;
  if p_result->>'outputTokens' ~ '^\d{1,8}$' then usage_output:=(p_result->>'outputTokens')::integer;end if;
  if p_result->>'durationMs' ~ '^\d{1,8}$' then elapsed:=(p_result->>'durationMs')::integer;end if;
  if p_result->>'status'='ready' then
    content_text:=p_result->>'text';
    if jsonb_typeof(p_result->'text') is distinct from 'string' or length(btrim(coalesce(content_text,'')))=0
      or octet_length(content_text)>1048576 or content_text !~ '[가-힣]'
      or regexp_replace(content_text,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' or model_name is null then
      raise exception 'invalid Korean translation' using errcode='22023';
    end if;
    output:=jsonb_build_object('text',content_text,'language','ko','source','ai_translation','generatedAt',now_at,'model',model_name,'generationId',p_generation);
    update public.growell_material_translation_cache set state='ready',translation=output,model=model_name,input_tokens=usage_input,output_tokens=usage_output,
      duration_ms=elapsed,finished_at=now_at,reason=null where generation_id=p_generation;
    return jsonb_build_object('status','ready','translation',output);
  end if;
  update public.growell_material_translation_cache set state='unavailable',reason='translation_failed',finished_at=now_at,
    model=model_name,input_tokens=usage_input,output_tokens=usage_output,duration_ms=elapsed,
    partial_output=case when jsonb_typeof(p_result->'partial')='array' and octet_length((p_result->'partial')::text)<=1048576 then p_result->'partial' else null end
    where generation_id=p_generation;
  return jsonb_build_object('status','unavailable');
end $$;
revoke all on function public.growell_material_translation_claim(text,integer,integer,text,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.growell_material_translation_finish(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.growell_material_translation_claim(text,integer,integer,text,uuid,uuid,boolean) to service_role;
grant execute on function public.growell_material_translation_finish(uuid,jsonb) to service_role;
commit;
