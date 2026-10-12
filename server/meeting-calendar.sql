-- Additive Google Calendar delivery. This migration never changes member
-- records or existing announcement text and does not send external requests.
begin;

do $guard$
declare required record;
begin
  for required in select * from (values
    ('profiles','id','text'),('profiles','auth_user_id','uuid'),
    ('profiles','approval_status','text'),('profiles','is_deleted','boolean'),
    ('announcement','book_id','text'),('announcement','next_date','text'),
    ('announcement','next_time','text'),('announcement','next_place','text'),
    ('announcement','next_note','text'),('announcement','reading_book_id','text'),
    ('announcement','reading_meeting_no','text'),('announcement','reading_chapter','text'),
    ('announcement','reading_range','text')
  ) as columns(table_name,column_name,type_name) loop
    if not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid=to_regclass('public.'||required.table_name)
      and a.attname=required.column_name and a.atttypid=required.type_name::regtype
      and not a.attisdropped and a.attgenerated='') then
      raise exception 'Required calendar source column missing: %.%',required.table_name,required.column_name;
    end if;
  end loop;
end
$guard$;

-- Null on existing rows: a free-text date is never guessed or backfilled.
alter table public.announcement add column if not exists next_calendar_date text;
alter table public.announcement add column if not exists next_calendar_start text;
alter table public.announcement add column if not exists next_calendar_end text;
alter table public.announcement add column if not exists calendar_schedule_id uuid;
do $calendar_columns$
declare required record;
begin
  for required in select * from (values ('next_calendar_date','text'),('next_calendar_start','text'),
    ('next_calendar_end','text'),('calendar_schedule_id','uuid')) as columns(column_name,type_name) loop
    if not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='public.announcement'::regclass
      and a.attname=required.column_name and a.atttypid=required.type_name::regtype and not a.attisdropped and a.attgenerated='') then
      raise exception 'Incompatible calendar source column: %',required.column_name;
    end if;
  end loop;
end
$calendar_columns$;

create table if not exists public.growell_meeting_calendar_connections (
  owner_id text primary key references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  generation uuid not null,
  delivery_generation uuid,
  token_cipher text,
  account_id text,
  account_email text,
  enabled boolean not null default true,
  manual_requested boolean not null default false,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  next_sync_at timestamptz not null default clock_timestamp(),
  error_code text,
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  check((lease_token is null)=(lease_until is null))
);
create table if not exists public.growell_meeting_calendar_oauth_states (
  state_hash text primary key check(state_hash ~ '^[a-f0-9]{64}$'),
  owner_id text not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  verifier_cipher text not null,
  expires_at timestamptz not null
);
-- Delivery history is independent of the singleton announcement. Changing
-- the book/meeting retains the previous meeting and remote event receipt.
create table if not exists public.growell_meeting_calendar_schedules (
  schedule_id uuid primary key,
  desired jsonb not null check(jsonb_typeof(desired)='object'),
  revision bigint not null default 1 check(revision>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.growell_meeting_calendar_jobs (
  owner_id text not null references public.growell_meeting_calendar_connections(owner_id) on delete cascade,
  schedule_id uuid not null references public.growell_meeting_calendar_schedules(schedule_id),
  generation uuid not null,
  desired jsonb not null check(jsonb_typeof(desired)='object'),
  revision bigint not null default 1 check(revision>0),
  synced_revision bigint not null default 0 check(synced_revision>=0),
  claimed_revision bigint,
  event_id text,
  event_created boolean not null default false,
  last_error text,
  next_sync_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check(attempts>=0),
  last_synced_at timestamptz,
  primary key(owner_id,schedule_id,generation),
  check(synced_revision<=revision),
  check(claimed_revision is null or claimed_revision<=revision),
  check(not event_created or event_id is not null)
);

alter table public.growell_meeting_calendar_connections enable row level security;
alter table public.growell_meeting_calendar_oauth_states enable row level security;
alter table public.growell_meeting_calendar_schedules enable row level security;
alter table public.growell_meeting_calendar_jobs enable row level security;
revoke all on table public.growell_meeting_calendar_connections,public.growell_meeting_calendar_oauth_states,
  public.growell_meeting_calendar_schedules,public.growell_meeting_calendar_jobs from public,anon,authenticated;
grant select,insert,update,delete on table public.growell_meeting_calendar_connections,public.growell_meeting_calendar_oauth_states,
  public.growell_meeting_calendar_schedules,public.growell_meeting_calendar_jobs to service_role;
create index if not exists growell_meeting_calendar_due on public.growell_meeting_calendar_connections(next_sync_at) where token_cipher is not null;
create index if not exists growell_meeting_calendar_jobs_due on public.growell_meeting_calendar_jobs(owner_id,generation,next_sync_at) where revision>synced_revision;
create index if not exists growell_meeting_calendar_oauth_expiry on public.growell_meeting_calendar_oauth_states(expires_at);

create or replace function public.growell_meeting_calendar_capture()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare desired jsonb; previous public.growell_meeting_calendar_schedules%rowtype;
  connection public.growell_meeting_calendar_connections%rowtype; next_id uuid; calendar_date date;
begin
  if new.book_id<>'global' then return new;end if;
  if tg_op='UPDATE' then
    -- A caller cannot inject or replace the server's stable event identity.
    new.calendar_schedule_id:=old.calendar_schedule_id;
    if row(new.reading_book_id,new.reading_meeting_no) is distinct from row(old.reading_book_id,old.reading_meeting_no) then
      new.calendar_schedule_id:=null;
    end if;
  else new.calendar_schedule_id:=null;end if;
  if coalesce(new.next_calendar_date,'')='' and coalesce(new.next_calendar_start,'')='' and coalesce(new.next_calendar_end,'')='' then return new;end if;
  if coalesce(new.next_calendar_date,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(new.next_calendar_start,'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(new.next_calendar_end,'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or new.next_calendar_end<=new.next_calendar_start then
    raise exception 'Complete same-day calendar date and times required' using errcode='22023';
  end if;
  begin calendar_date:=new.next_calendar_date::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'Valid calendar date required' using errcode='22023';end;
  if to_char(calendar_date,'YYYY-MM-DD')<>new.next_calendar_date or calendar_date<date '2000-01-01' or calendar_date>date '2100-12-31' then
    raise exception 'Valid calendar date required' using errcode='22023';end if;
  new.calendar_schedule_id:=coalesce(new.calendar_schedule_id,gen_random_uuid());next_id:=new.calendar_schedule_id;
  desired:=jsonb_build_object('schedule_id',next_id,'meeting_date',new.next_calendar_date,
    'start_time',new.next_calendar_start,'end_time',new.next_calendar_end,
    'place',coalesce(new.next_place,''),'book_id',coalesce(new.reading_book_id,''),
    'meeting_no',coalesce(new.reading_meeting_no,''),'chapter',coalesce(new.reading_chapter,''),
    'reading_range',coalesce(new.reading_range,''),'note',coalesce(new.next_note,''));
  if octet_length(desired::text)>32768 then raise exception 'Calendar schedule too large' using errcode='22001';end if;
  select * into previous from public.growell_meeting_calendar_schedules where schedule_id=next_id;
  if found and previous.desired=desired then return new;end if;
  insert into public.growell_meeting_calendar_schedules(schedule_id,desired) values(next_id,desired)
    on conflict(schedule_id) do update set desired=excluded.desired,
      revision=public.growell_meeting_calendar_schedules.revision+1,updated_at=clock_timestamp();
  for connection in select c.* from public.growell_meeting_calendar_connections c
    where c.token_cipher is not null and exists(select 1 from public.profiles p where p.id=c.owner_id
      and p.auth_user_id=c.auth_user_id and p.approval_status='approved' and p.is_deleted=false)
    order by c.owner_id for update of c loop
    insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired)
      values(connection.owner_id,next_id,connection.generation,desired)
      on conflict(owner_id,schedule_id,generation) do update set desired=excluded.desired,
        revision=public.growell_meeting_calendar_jobs.revision+1,last_error=null,attempts=0,
        next_sync_at=case when public.growell_meeting_calendar_jobs.last_error is null
          then clock_timestamp() else public.growell_meeting_calendar_jobs.next_sync_at end;
    -- Preserve an outage backoff when another edit arrives.
    update public.growell_meeting_calendar_connections set next_sync_at=case when error_code is null then clock_timestamp() else next_sync_at end
      where owner_id=connection.owner_id;
  end loop;
  return new;
end
$function$;
drop trigger if exists growell_meeting_calendar_capture on public.announcement;
create trigger growell_meeting_calendar_capture before insert or update on public.announcement
  for each row execute function public.growell_meeting_calendar_capture();

create or replace function public.growell_meeting_calendar_revoke_member()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.is_deleted is distinct from false or new.approval_status is distinct from 'approved'
    or new.auth_user_id is distinct from old.auth_user_id then
    update public.growell_meeting_calendar_connections set token_cipher=null,generation=gen_random_uuid(),enabled=false,
      manual_requested=false,lease_token=null,lease_until=null,error_code=null where owner_id=old.id;
    delete from public.growell_meeting_calendar_oauth_states where owner_id=old.id;
  end if;
  return new;
end
$function$;
drop trigger if exists growell_meeting_calendar_revoke_member on public.profiles;
create trigger growell_meeting_calendar_revoke_member after update of is_deleted,approval_status,auth_user_id on public.profiles
  for each row execute function public.growell_meeting_calendar_revoke_member();

create or replace function public.growell_meeting_calendar_oauth(p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare saved public.growell_meeting_calendar_oauth_states%rowtype; owner text; member_auth uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(p_payload->>'state_hash','') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid OAuth state' using errcode='22023';end if;
  if p_operation='consume' then
    delete from public.growell_meeting_calendar_oauth_states where state_hash=p_payload->>'state_hash' returning * into saved;
    if not found or saved.expires_at<=clock_timestamp() or not exists(select 1 from public.profiles p
      where p.id=saved.owner_id and p.auth_user_id=saved.auth_user_id and p.approval_status='approved' and p.is_deleted=false) then return null;end if;
    return to_jsonb(saved);
  elsif p_operation='put' then
    owner:=p_payload->>'owner_id';member_auth:=(p_payload->>'auth_user_id')::uuid;
    perform 1 from public.profiles p where p.id=owner and p.auth_user_id=member_auth
      and p.approval_status='approved' and p.is_deleted=false for share;
    if not found then raise exception 'Approved owner required' using errcode='42501';end if;
    if char_length(coalesce(p_payload->>'verifier_cipher','')) not between 16 and 65536
      or (p_payload->>'expires_at')::timestamptz is null
      or (p_payload->>'expires_at')::timestamptz<=clock_timestamp()
      or (p_payload->>'expires_at')::timestamptz>clock_timestamp()+interval '15 minutes' then
      raise exception 'Invalid OAuth state lifetime' using errcode='22023';end if;
    delete from public.growell_meeting_calendar_oauth_states where owner_id=owner or expires_at<=clock_timestamp();
    insert into public.growell_meeting_calendar_oauth_states(state_hash,owner_id,auth_user_id,verifier_cipher,expires_at)
      values(p_payload->>'state_hash',owner,member_auth,p_payload->>'verifier_cipher',(p_payload->>'expires_at')::timestamptz);
    return jsonb_build_object('saved',true);
  end if;
  raise exception 'Unknown OAuth operation' using errcode='22023';
end
$function$;

create or replace function public.growell_meeting_calendar_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_meeting_calendar_connections%rowtype; next_generation uuid; same_account boolean;
begin
  perform 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.approval_status='approved' and p.is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell-meeting-calendar:'||p_owner,0));
  select * into connection from public.growell_meeting_calendar_connections where owner_id=p_owner for update;
  if found and connection.lease_until>clock_timestamp() then raise exception 'Connector busy; retry' using errcode='40001';end if;
  if p_operation='connect' then
    next_generation:=(p_payload->>'generation')::uuid;
    if next_generation is null or next_generation=connection.generation
      or exists(select 1 from public.growell_meeting_calendar_jobs where owner_id=p_owner and generation=next_generation)
      or char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536
      or char_length(coalesce(p_payload->>'account_id','')) not between 1 and 512
      or char_length(coalesce(p_payload->>'account_email',''))>320 then
      raise exception 'Invalid connection' using errcode='22023';end if;
    same_account:=coalesce(connection.account_id=p_payload->>'account_id' and connection.auth_user_id=p_auth,false);
    insert into public.growell_meeting_calendar_connections(owner_id,auth_user_id,generation,delivery_generation,token_cipher,account_id,account_email,connected_at)
      values(p_owner,p_auth,next_generation,next_generation,p_payload->>'token_cipher',p_payload->>'account_id',p_payload->>'account_email',clock_timestamp())
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=excluded.generation,delivery_generation=excluded.delivery_generation,
        token_cipher=excluded.token_cipher,account_id=excluded.account_id,account_email=excluded.account_email,enabled=true,
        manual_requested=false,connected_at=excluded.connected_at,last_synced_at=case when same_account then public.growell_meeting_calendar_connections.last_synced_at end,
        last_attempt_at=null,next_sync_at=clock_timestamp(),error_code=null,attempts=0,lease_token=null,lease_until=null;
    if same_account then
      insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired,revision,synced_revision,event_id,event_created,last_synced_at,last_error)
        select owner_id,schedule_id,next_generation,desired,revision,synced_revision,event_id,event_created,last_synced_at,last_error
          from public.growell_meeting_calendar_jobs where owner_id=p_owner and generation=coalesce(connection.delivery_generation,connection.generation);
    end if;
    insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired)
      select p_owner,s.schedule_id,next_generation,s.desired from public.growell_meeting_calendar_schedules s
      join public.announcement a on a.book_id='global' and a.calendar_schedule_id=s.schedule_id
      on conflict(owner_id,schedule_id,generation) do update set desired=excluded.desired,
        revision=public.growell_meeting_calendar_jobs.revision+1,last_error=null,next_sync_at=clock_timestamp();
  elsif p_operation='disconnect' then
    -- Existing Google events and GROWELL records remain intact.
    update public.growell_meeting_calendar_connections set token_cipher=null,generation=gen_random_uuid(),enabled=false,
      manual_requested=false,lease_token=null,lease_until=null,error_code=null where owner_id=p_owner;
    delete from public.growell_meeting_calendar_oauth_states where owner_id=p_owner;
  elsif p_operation in ('settings','sync') then
    if connection.owner_id is null or connection.auth_user_id is distinct from p_auth or connection.token_cipher is null then
      raise exception 'Connection required' using errcode='55000';end if;
    if p_operation='settings' then
      if not(p_payload ? 'enabled') or jsonb_typeof(p_payload->'enabled')<>'boolean' then raise exception 'Invalid settings' using errcode='22023';end if;
      update public.growell_meeting_calendar_connections set enabled=(p_payload->>'enabled')::boolean,manual_requested=false,
        next_sync_at=clock_timestamp(),error_code=null where owner_id=p_owner;
    else
      update public.growell_meeting_calendar_connections set manual_requested=true,next_sync_at=clock_timestamp(),error_code=null where owner_id=p_owner;
      update public.growell_meeting_calendar_jobs set revision=revision+1,last_error=null,next_sync_at=clock_timestamp()
        where owner_id=p_owner and generation=connection.generation;
    end if;
  else raise exception 'Unknown configuration operation' using errcode='22023';end if;
  select * into connection from public.growell_meeting_calendar_connections where owner_id=p_owner;
  return to_jsonb(connection)-'token_cipher'-'lease_token'-'lease_until';
end
$function$;

create or replace function public.growell_meeting_calendar_claim(p_owner text default null,p_limit integer default 1)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_meeting_calendar_connections%rowtype; jobs jsonb; result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>10 then raise exception 'Invalid claim limit' using errcode='22023';end if;
  for connection in select c.* from public.growell_meeting_calendar_connections c
    where (p_owner is null or c.owner_id=p_owner) and (c.enabled or c.manual_requested) and c.token_cipher is not null
    and (c.lease_until is null or c.lease_until<=clock_timestamp()) and c.next_sync_at<=clock_timestamp()
    and exists(select 1 from public.profiles p where p.id=c.owner_id and p.auth_user_id=c.auth_user_id and p.approval_status='approved' and p.is_deleted=false)
    and exists(select 1 from public.growell_meeting_calendar_jobs j where j.owner_id=c.owner_id and j.generation=c.generation
      and j.revision>j.synced_revision and j.next_sync_at<=clock_timestamp()
      and coalesce(j.last_error,'') not in ('calendar-remote-missing','calendar-event-unsafe','invalid-schedule'))
    order by c.last_attempt_at nulls first,c.owner_id for update of c skip locked limit p_limit loop
    update public.growell_meeting_calendar_connections set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',
      last_attempt_at=clock_timestamp() where owner_id=connection.owner_id returning * into connection;
    with candidates as (select j.owner_id,j.schedule_id,j.generation from public.growell_meeting_calendar_jobs j
      where j.owner_id=connection.owner_id and j.generation=connection.generation and j.revision>j.synced_revision
        and j.next_sync_at<=clock_timestamp()
        and coalesce(j.last_error,'') not in ('calendar-remote-missing','calendar-event-unsafe','invalid-schedule')
        order by j.next_sync_at,j.schedule_id for update of j skip locked limit 3),
    claimed as (update public.growell_meeting_calendar_jobs j set claimed_revision=j.revision from candidates c
      where j.owner_id=c.owner_id and j.schedule_id=c.schedule_id and j.generation=c.generation returning j.*)
    select coalesce(jsonb_agg(to_jsonb(claimed) order by claimed.next_sync_at,claimed.schedule_id),'[]'::jsonb) into jobs from claimed;
    result:=result||jsonb_build_array(jsonb_build_object('connection',to_jsonb(connection),'jobs',jobs));
  end loop;
  return result;
end
$function$;

create or replace function public.growell_meeting_calendar_apply(p_owner text,p_generation uuid,p_lease uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_meeting_calendar_connections%rowtype; job public.growell_meeting_calendar_jobs%rowtype;
  schedule uuid; sent_revision bigint; retry_seconds integer; remote_id text;
begin
  select * into connection from public.growell_meeting_calendar_connections where owner_id=p_owner for update;
  if not found or connection.generation is distinct from p_generation or p_lease is null
    or connection.lease_token is distinct from p_lease or connection.lease_until<=clock_timestamp()
    or not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=connection.auth_user_id
      and p.approval_status='approved' and p.is_deleted=false) then return jsonb_build_object('applied',false);end if;
  if p_operation='release' then
    update public.growell_meeting_calendar_connections set lease_token=null,lease_until=null,
      manual_requested=manual_requested and exists(select 1 from public.growell_meeting_calendar_jobs j where j.owner_id=p_owner
        and j.generation=p_generation and j.revision>j.synced_revision) where owner_id=p_owner;
    update public.growell_meeting_calendar_jobs set claimed_revision=null where owner_id=p_owner and generation=p_generation;
    return jsonb_build_object('applied',true);end if;
  if connection.token_cipher is null or not(connection.enabled or connection.manual_requested) then return jsonb_build_object('applied',false);end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid worker payload' using errcode='22023';end if;
  if p_operation='token' then
    if char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536 then raise exception 'Invalid encrypted token' using errcode='22023';end if;
    update public.growell_meeting_calendar_connections set token_cipher=p_payload->>'token_cipher' where owner_id=p_owner;
    return jsonb_build_object('applied',true);
  end if;
  if p_operation='guard' and not(p_payload ? 'schedule_id') and not(p_payload ? 'revision') then return jsonb_build_object('applied',true);end if;
  schedule:=(p_payload->>'schedule_id')::uuid;sent_revision:=(p_payload->>'revision')::bigint;
  select * into job from public.growell_meeting_calendar_jobs where owner_id=p_owner and generation=p_generation and schedule_id=schedule for update;
  if not found or sent_revision is null or job.claimed_revision is distinct from sent_revision
    or sent_revision>job.revision or sent_revision<job.synced_revision then return jsonb_build_object('applied',false);end if;
  if p_operation='guard' then return jsonb_build_object('applied',job.revision=sent_revision);
  elsif p_operation in ('created','success') then
    remote_id:=p_payload->>'event_id';
    if coalesce(remote_id,'') !~ '^[a-v0-9]+$' or char_length(remote_id) not between 5 and 1024 then
      raise exception 'Invalid Calendar event ID' using errcode='22023';end if;
    if job.event_id is not null and job.event_id is distinct from remote_id then raise exception 'Calendar event ID already reserved' using errcode='22023';end if;
    update public.growell_meeting_calendar_jobs set event_id=remote_id,event_created=true,
      synced_revision=case when p_operation='success' then greatest(synced_revision,sent_revision) else synced_revision end,
      last_synced_at=case when p_operation='success' then clock_timestamp() else last_synced_at end,
      last_error=null,attempts=0,next_sync_at=clock_timestamp() where owner_id=p_owner and generation=p_generation and schedule_id=schedule;
    if p_operation='success' then update public.growell_meeting_calendar_connections set last_synced_at=clock_timestamp(),
      error_code=null,attempts=0,next_sync_at=clock_timestamp() where owner_id=p_owner;end if;
  elsif p_operation='failure' then
    -- An old request failing after an operator saved a correction must not
    -- put the new revision into terminal error or carry over its backoff.
    if job.revision<>sent_revision then return jsonb_build_object('applied',false);end if;
    retry_seconds:=greatest(5,least(coalesce((p_payload->>'retry_after')::integer,60),86400));
    if coalesce(p_payload->>'error_code','') !~ '^[a-z0-9_-]{1,100}$'
      or (p_payload ? 'disable' and jsonb_typeof(p_payload->'disable')<>'boolean') then raise exception 'Invalid Calendar error' using errcode='22023';end if;
    update public.growell_meeting_calendar_jobs set last_error=p_payload->>'error_code',attempts=attempts+1,
      next_sync_at=clock_timestamp()+make_interval(secs=>retry_seconds) where owner_id=p_owner and generation=p_generation and schedule_id=schedule;
    update public.growell_meeting_calendar_connections set error_code=p_payload->>'error_code',attempts=attempts+1,
      next_sync_at=clock_timestamp()+make_interval(secs=>retry_seconds),
      enabled=case when p_payload->>'disable'='true' then false else enabled end,
      manual_requested=case when p_payload->>'disable'='true' then false else manual_requested end where owner_id=p_owner;
  else raise exception 'Unknown worker operation' using errcode='22023';end if;
  return jsonb_build_object('applied',true);
end
$function$;

revoke all on function public.growell_meeting_calendar_capture(),public.growell_meeting_calendar_revoke_member()
  from public,anon,authenticated,service_role;
revoke all on function public.growell_meeting_calendar_oauth(text,jsonb),public.growell_meeting_calendar_configure(text,uuid,text,jsonb),
  public.growell_meeting_calendar_claim(text,integer),public.growell_meeting_calendar_apply(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_meeting_calendar_oauth(text,jsonb),public.growell_meeting_calendar_configure(text,uuid,text,jsonb),
  public.growell_meeting_calendar_claim(text,integer),public.growell_meeting_calendar_apply(text,uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
