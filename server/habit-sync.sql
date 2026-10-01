-- Run as the database owner. This migration sends no external requests and
-- never backfills existing habits. All connector data is service-role only.
begin;

do $schema_guard$
declare required record;
begin
  if to_regclass('public.profiles') is null or to_regclass('public.habits') is null then
    raise exception 'profiles and habits must exist before habit-sync';
  end if;
  for required in select * from (values
    ('profiles','id','text'),('profiles','auth_user_id','uuid'),
    ('profiles','approval_status','text'),('profiles','is_deleted','boolean'),
    ('habits','id','text'),('habits','user_id','text'),('habits','name','text'),
    ('habits','goal','text'),('habits','time','text'),('habits','place','text'),
    ('habits','behavior_type','text'),('habits','book_id','text')
  ) as x(table_name,column_name,type_name) loop
    if not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid=to_regclass('public.'||required.table_name)
        and a.attname=required.column_name and not a.attisdropped
        and a.atttypid=to_regtype(required.type_name) and a.attgenerated='') then
      raise exception 'Incompatible source column %.%',required.table_name,required.column_name;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_attribute a where a.attrelid='public.habits'::regclass
      and a.attname in ('start_date','end_date') and not a.attisdropped
      and a.atttypid in ('text'::regtype,'date'::regtype) and a.attgenerated='')<>2 then
    raise exception 'Incompatible habit date columns';
  end if;
end
$schema_guard$;

create table if not exists public.growell_habit_sync_connections (
  owner_id text primary key references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  generation uuid not null,
  token_cipher text,
  account_id text,
  list_id text,
  list_uncertain boolean not null default false,
  enabled boolean not null default false,
  default_time text not null default '09:00' check(default_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  connected_at timestamptz,
  created_after timestamptz not null default clock_timestamp(),
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  next_sync_at timestamptz not null default clock_timestamp(),
  error_code text,
  lease_token uuid,
  lease_until timestamptz,
  check((lease_token is null)=(lease_until is null))
);
create table if not exists public.growell_habit_sync_oauth_states (
  state_hash text primary key check(state_hash ~ '^[a-f0-9]{64}$'),
  owner_id text not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  verifier_cipher text not null,
  expires_at timestamptz not null
);
create table if not exists public.growell_habit_sync_queue (
  owner_id text not null references public.growell_habit_sync_connections(owner_id) on delete cascade,
  habit_id text not null,
  generation uuid not null,
  marker uuid not null default gen_random_uuid(),
  desired jsonb,
  revision bigint not null default 1 check(revision>0),
  task_id text,
  pending boolean not null default true,
  uncertain boolean not null default false,
  attempts integer not null default 0 check(attempts>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  primary key(owner_id,habit_id),
  unique(marker),
  check(desired is null or jsonb_typeof(desired)='object')
);

-- Fail closed on a conflicting installation instead of silently accepting an
-- unrelated table with the same name. Functions below require these types.
do $connector_schema_guard$
declare required record;
begin
  for required in select * from (values
    ('connections','owner_id','text'),('connections','auth_user_id','uuid'),
    ('connections','generation','uuid'),('connections','token_cipher','text'),
    ('connections','account_id','text'),('connections','list_id','text'),
    ('connections','list_uncertain','boolean'),('connections','enabled','boolean'),
    ('connections','default_time','text'),('connections','connected_at','timestamptz'),
    ('connections','created_after','timestamptz'),('connections','last_synced_at','timestamptz'),
    ('connections','last_attempt_at','timestamptz'),('connections','next_sync_at','timestamptz'),
    ('connections','error_code','text'),('connections','lease_token','uuid'),('connections','lease_until','timestamptz'),
    ('oauth_states','state_hash','text'),('oauth_states','owner_id','text'),
    ('oauth_states','auth_user_id','uuid'),('oauth_states','verifier_cipher','text'),('oauth_states','expires_at','timestamptz'),
    ('queue','owner_id','text'),('queue','habit_id','text'),('queue','generation','uuid'),
    ('queue','marker','uuid'),('queue','desired','jsonb'),('queue','revision','bigint'),
    ('queue','task_id','text'),('queue','pending','boolean'),('queue','uncertain','boolean'),
    ('queue','attempts','integer'),('queue','next_attempt_at','timestamptz'),('queue','last_error','text')
  ) as x(suffix,column_name,type_name) loop
    if not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid=to_regclass('public.growell_habit_sync_'||required.suffix)
        and a.attname=required.column_name and not a.attisdropped
        and a.atttypid=to_regtype(required.type_name) and a.attgenerated='') then
      raise exception 'Incompatible connector column %.%',required.suffix,required.column_name;
    end if;
  end loop;
end
$connector_schema_guard$;

alter table public.growell_habit_sync_connections enable row level security;
alter table public.growell_habit_sync_oauth_states enable row level security;
alter table public.growell_habit_sync_queue enable row level security;
revoke all on table public.growell_habit_sync_connections,public.growell_habit_sync_oauth_states,
  public.growell_habit_sync_queue from public,anon,authenticated;
grant select,insert,update,delete on table public.growell_habit_sync_connections,
  public.growell_habit_sync_oauth_states,public.growell_habit_sync_queue to service_role;
create index if not exists growell_habit_sync_queue_due on public.growell_habit_sync_queue(next_attempt_at,owner_id) where pending;
create index if not exists growell_habit_sync_oauth_expiry on public.growell_habit_sync_oauth_states(expires_at);

create or replace function public.growell_habit_sync_source(p_habit jsonb)
returns jsonb language sql immutable set search_path=''
as $function$
  select jsonb_build_object('id',p_habit->'id','user_id',p_habit->'user_id',
    'name',p_habit->'name','goal',p_habit->'goal','time',p_habit->'time',
    'place',p_habit->'place','start_date',p_habit->'start_date',
    'end_date',p_habit->'end_date','behavior_type',p_habit->'behavior_type',
    'book_id',p_habit->'book_id');
$function$;

create or replace function public.growell_habit_sync_enqueue(p_owner text,p_habit text,p_desired jsonb,p_allow_new boolean)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_habit_sync_connections%rowtype; existing boolean;
begin
  select c.* into connection from public.growell_habit_sync_connections c where c.owner_id=p_owner for update;
  if not found or connection.token_cipher is null or not exists(select 1 from public.profiles p
    where p.id=p_owner and p.auth_user_id=connection.auth_user_id and p.approval_status='approved' and p.is_deleted=false) then
    return false;
  end if;
  select exists(select 1 from public.growell_habit_sync_queue q
    where q.owner_id=p_owner and q.habit_id=p_habit and q.generation=connection.generation) into existing;
  if not existing and (not p_allow_new or not connection.enabled or p_desired is null) then return false;end if;
  if p_desired is not null and (p_desired->>'user_id' is distinct from p_owner or p_desired->>'id' is distinct from p_habit) then
    raise exception 'Habit ownership mismatch' using errcode='42501';
  end if;
  insert into public.growell_habit_sync_queue(owner_id,habit_id,generation,desired)
    values(p_owner,p_habit,connection.generation,p_desired)
    on conflict(owner_id,habit_id) do update set desired=excluded.desired,
      revision=public.growell_habit_sync_queue.revision+1,pending=true,
      attempts=0,next_attempt_at=clock_timestamp(),last_error=null;
  return true;
end
$function$;

create or replace function public.growell_habit_sync_capture()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare before_value jsonb; after_value jsonb; allow_new boolean:=false;
begin
  if tg_op<>'INSERT' then before_value:=public.growell_habit_sync_source(to_jsonb(old));end if;
  if tg_op<>'DELETE' then after_value:=public.growell_habit_sync_source(to_jsonb(new));end if;
  if tg_op='UPDATE' and before_value is not distinct from after_value then return new;end if;
  if tg_op='DELETE' or (tg_op='UPDATE' and old.user_id is distinct from new.user_id) then
    perform public.growell_habit_sync_enqueue(old.user_id,old.id,null,false);
  end if;
  if tg_op<>'DELETE' then
    if tg_op='INSERT' then
      select statement_timestamp()>=c.created_after into allow_new from public.growell_habit_sync_connections c where c.owner_id=new.user_id;
    end if;
    perform public.growell_habit_sync_enqueue(new.user_id,new.id,after_value,coalesce(allow_new,false));
    return new;
  end if;
  return old;
end
$function$;
drop trigger if exists growell_habit_sync_capture on public.habits;
create trigger growell_habit_sync_capture after insert or update or delete on public.habits
  for each row execute function public.growell_habit_sync_capture();

-- Membership revocation, soft deletion and Auth identity replacement must
-- destroy credentials, not merely hide a settings screen. Existing remote
-- reminders remain with the member's Microsoft account.
create or replace function public.growell_habit_sync_revoke_member()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.is_deleted is distinct from false or new.approval_status is distinct from 'approved'
    or new.auth_user_id is distinct from old.auth_user_id then
    delete from public.growell_habit_sync_connections where owner_id=old.id;
    delete from public.growell_habit_sync_oauth_states where owner_id=old.id;
  end if;
  return new;
end
$function$;
drop trigger if exists growell_habit_sync_revoke_member on public.profiles;
create trigger growell_habit_sync_revoke_member after update of is_deleted,approval_status,auth_user_id on public.profiles
  for each row execute function public.growell_habit_sync_revoke_member();

create or replace function public.growell_habit_sync_oauth(p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare saved public.growell_habit_sync_oauth_states%rowtype; owner text; member_auth uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(p_payload->>'state_hash','') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid OAuth state' using errcode='22023';
  end if;
  if p_operation='consume' then
    delete from public.growell_habit_sync_oauth_states where state_hash=p_payload->>'state_hash' returning * into saved;
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
      raise exception 'Invalid OAuth state lifetime' using errcode='22023';
    end if;
    delete from public.growell_habit_sync_oauth_states where owner_id=owner or expires_at<=clock_timestamp();
    insert into public.growell_habit_sync_oauth_states(state_hash,owner_id,auth_user_id,verifier_cipher,expires_at)
      values(p_payload->>'state_hash',owner,member_auth,p_payload->>'verifier_cipher',(p_payload->>'expires_at')::timestamptz);
    return jsonb_build_object('saved',true);
  end if;
  raise exception 'Unknown OAuth operation' using errcode='22023';
end
$function$;

create or replace function public.growell_habit_sync_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_habit_sync_connections%rowtype; next_generation uuid;
  source_habit record; queued integer:=0; next_time text; was_enabled boolean;
begin
  perform 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.approval_status='approved' and p.is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload' using errcode='22023';end if;
  -- Serialize first connections too: an absent connector row cannot be locked.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell-habit-sync:'||p_owner,0));
  select * into connection from public.growell_habit_sync_connections where owner_id=p_owner for update;
  if found and connection.lease_until>clock_timestamp() then raise exception 'Connector busy; retry' using errcode='40001';end if;
  if p_operation='connect' then
    next_generation:=(p_payload->>'generation')::uuid;
    next_time:=coalesce(p_payload->>'default_time','09:00');
    if next_generation is null or next_generation=connection.generation
      or char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536
      or char_length(coalesce(p_payload->>'account_id','')) not between 1 and 512
      or next_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid connection' using errcode='22023';end if;
    insert into public.growell_habit_sync_connections(owner_id,auth_user_id,generation,token_cipher,account_id,enabled,default_time,connected_at,created_after)
      values(p_owner,p_auth,next_generation,p_payload->>'token_cipher',p_payload->>'account_id',true,next_time,clock_timestamp(),clock_timestamp())
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=excluded.generation,
        token_cipher=excluded.token_cipher,account_id=excluded.account_id,enabled=true,default_time=excluded.default_time,
        connected_at=excluded.connected_at,created_after=excluded.created_after,list_id=null,list_uncertain=false,
        last_synced_at=null,last_attempt_at=null,next_sync_at=clock_timestamp(),error_code=null,lease_token=null,lease_until=null;
    delete from public.growell_habit_sync_queue where owner_id=p_owner;
  elsif p_operation='disconnect' then
    update public.growell_habit_sync_connections set token_cipher=null,account_id=null,list_id=null,list_uncertain=false,
      generation=gen_random_uuid(),enabled=false,error_code=null,lease_token=null,lease_until=null where owner_id=p_owner;
    delete from public.growell_habit_sync_queue where owner_id=p_owner;
    delete from public.growell_habit_sync_oauth_states where owner_id=p_owner;
  elsif p_operation in ('settings','import') then
    if connection.owner_id is null or connection.auth_user_id is distinct from p_auth or connection.token_cipher is null then
      raise exception 'Connection required' using errcode='55000';
    end if;
    if p_operation='settings' then
      next_time:=coalesce(p_payload->>'default_time',connection.default_time);
      if next_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (p_payload ? 'enabled' and jsonb_typeof(p_payload->'enabled')<>'boolean') then raise exception 'Invalid settings' using errcode='22023';end if;
      was_enabled:=connection.enabled;
      update public.growell_habit_sync_connections set default_time=next_time,
        enabled=coalesce((p_payload->>'enabled')::boolean,enabled),error_code=null,
        lease_token=null,lease_until=null,next_sync_at=clock_timestamp() where owner_id=p_owner;
      if next_time is distinct from connection.default_time or (not was_enabled and coalesce((p_payload->>'enabled')::boolean,false)) then
        update public.growell_habit_sync_queue set revision=revision+1,pending=true,next_attempt_at=clock_timestamp(),attempts=0,last_error=null
          where owner_id=p_owner and generation=connection.generation;
      end if;
    else
      if not connection.enabled then raise exception 'Connection paused' using errcode='55000';end if;
      if p_payload ? 'habit_id' and not exists(select 1 from public.habits h where h.id=p_payload->>'habit_id' and h.user_id=p_owner) then
        raise exception 'Owned habit required' using errcode='42501';
      end if;
      for source_habit in select h.* from public.habits h where h.user_id=p_owner
        and (not(p_payload ? 'habit_id') or h.id=p_payload->>'habit_id') loop
        if public.growell_habit_sync_enqueue(p_owner,source_habit.id,public.growell_habit_sync_source(to_jsonb(source_habit)),true) then queued:=queued+1;end if;
      end loop;
      return jsonb_build_object('queued',queued);
    end if;
  else raise exception 'Unknown configuration operation' using errcode='22023';
  end if;
  select * into connection from public.growell_habit_sync_connections where owner_id=p_owner;
  -- Server still whitelists its browser response; this RPC never returns tokens.
  return to_jsonb(connection)-'token_cipher'-'lease_token'-'lease_until';
end
$function$;

create or replace function public.growell_habit_sync_claim(p_owner text default null,p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_habit_sync_connections%rowtype; jobs jsonb; result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>20 then raise exception 'Invalid claim limit' using errcode='22023';end if;
  for connection in select c.* from public.growell_habit_sync_connections c
    where (p_owner is null or c.owner_id=p_owner) and c.enabled and c.token_cipher is not null
      and (c.lease_until is null or c.lease_until<=clock_timestamp())
      and c.next_sync_at<=clock_timestamp()
      and exists(select 1 from public.profiles p where p.id=c.owner_id and p.auth_user_id=c.auth_user_id and p.approval_status='approved' and p.is_deleted=false)
      and (c.list_id is null or exists(select 1 from public.growell_habit_sync_queue q
        where q.owner_id=c.owner_id and q.generation=c.generation and q.pending and q.next_attempt_at<=clock_timestamp()))
    order by c.last_attempt_at nulls first,c.owner_id for update of c skip locked limit p_limit loop
    update public.growell_habit_sync_connections set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',last_attempt_at=clock_timestamp()
      where owner_id=connection.owner_id returning * into connection;
    select coalesce(jsonb_agg(to_jsonb(due) order by due.next_attempt_at,due.habit_id),'[]'::jsonb) into jobs
      from (select q.* from public.growell_habit_sync_queue q where q.owner_id=connection.owner_id
        and q.generation=connection.generation and q.pending and q.next_attempt_at<=clock_timestamp()
        order by q.next_attempt_at,q.habit_id limit 25) due;
    result:=result||jsonb_build_array(jsonb_build_object('connection',to_jsonb(connection),'queue',jobs));
  end loop;
  return result;
end
$function$;

create or replace function public.growell_habit_sync_apply(p_owner text,p_generation uuid,p_lease uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_habit_sync_connections%rowtype; job public.growell_habit_sync_queue%rowtype;
  requested_revision bigint; retry_at timestamptz;
begin
  select * into connection from public.growell_habit_sync_connections where owner_id=p_owner for update;
  if not found or connection.generation is distinct from p_generation
    or p_lease is null or connection.lease_token is distinct from p_lease or connection.lease_until<=clock_timestamp()
    then return jsonb_build_object('applied',false);end if;
  -- A revoked refresh token pauses the connector. Its own lease may still be
  -- released immediately so an explicit reconnect is not blocked for 90 s.
  if p_operation='release' then
    update public.growell_habit_sync_connections set lease_token=null,lease_until=null where owner_id=p_owner;
    return jsonb_build_object('applied',true);
  end if;
  if not connection.enabled or not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=connection.auth_user_id
      and p.approval_status='approved' and p.is_deleted=false) then return jsonb_build_object('applied',false);end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid worker payload' using errcode='22023';end if;
  if p_payload ? 'habit_id' then
    select * into job from public.growell_habit_sync_queue where owner_id=p_owner and habit_id=p_payload->>'habit_id'
      and generation=p_generation for update;
    requested_revision:=(p_payload->>'revision')::bigint;
    if not found or requested_revision is null or requested_revision<=0
      or (p_operation in ('guard','sending') and job.revision<>requested_revision)
      or requested_revision>job.revision then return jsonb_build_object('applied',false);end if;
  elsif p_operation in ('sending','success','failure') then
    raise exception 'Worker habit required' using errcode='22023';
  end if;
  if p_operation='guard' then return jsonb_build_object('applied',true);
  elsif p_operation='token' then
    if char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536 then raise exception 'Invalid encrypted token' using errcode='22023';end if;
    update public.growell_habit_sync_connections set token_cipher=p_payload->>'token_cipher',error_code=null where owner_id=p_owner;
  elsif p_operation='list_sending' then
    update public.growell_habit_sync_connections set list_uncertain=true where owner_id=p_owner;
  elsif p_operation='list_rejected' then
    update public.growell_habit_sync_connections set list_uncertain=false where owner_id=p_owner;
  elsif p_operation='list' then
    if char_length(coalesce(p_payload->>'list_id','')) not between 1 and 2048 then raise exception 'Invalid task list' using errcode='22023';end if;
    update public.growell_habit_sync_connections set list_id=p_payload->>'list_id',list_uncertain=false,error_code=null where owner_id=p_owner;
  elsif p_operation='sending' then
    update public.growell_habit_sync_queue set uncertain=true where owner_id=p_owner and habit_id=job.habit_id;
  elsif p_operation='success' then
    if job.desired is null and job.revision=requested_revision then
      delete from public.growell_habit_sync_queue where owner_id=p_owner and habit_id=job.habit_id;
    else
      if p_payload->>'task_id' is not null and char_length(p_payload->>'task_id') not between 1 and 2048 then raise exception 'Invalid task id' using errcode='22023';end if;
      update public.growell_habit_sync_queue set task_id=p_payload->>'task_id',uncertain=false,
        pending=(revision<>requested_revision),attempts=0,next_attempt_at=clock_timestamp(),last_error=null
        where owner_id=p_owner and habit_id=job.habit_id;
    end if;
    update public.growell_habit_sync_connections set last_synced_at=clock_timestamp(),error_code=null where owner_id=p_owner;
  elsif p_operation='failure' then
    retry_at:=coalesce((p_payload->>'next_attempt_at')::timestamptz,clock_timestamp()+interval '1 minute');
    retry_at:=greatest(clock_timestamp()+interval '5 seconds',least(retry_at,clock_timestamp()+interval '1 day'));
    update public.growell_habit_sync_queue set attempts=attempts+1,
      next_attempt_at=case when revision=requested_revision then retry_at else next_attempt_at end,
      last_error=left(coalesce(p_payload->>'error_code','sync_failed'),100),
      uncertain=case when jsonb_typeof(p_payload->'uncertain')='boolean' then (p_payload->>'uncertain')::boolean else uncertain end
      where owner_id=p_owner and habit_id=job.habit_id;
    update public.growell_habit_sync_connections set error_code=left(coalesce(p_payload->>'error_code','sync_failed'),100) where owner_id=p_owner;
  elsif p_operation='connection_error' then
    update public.growell_habit_sync_connections set error_code=left(coalesce(p_payload->>'error_code','sync_failed'),100),
      next_sync_at=greatest(clock_timestamp()+interval '30 seconds',least(coalesce((p_payload->>'next_attempt_at')::timestamptz,clock_timestamp()+interval '5 minutes'),clock_timestamp()+interval '1 day')),
      enabled=case when p_payload->>'disable'='true' then false else enabled end where owner_id=p_owner;
  else raise exception 'Unknown worker operation' using errcode='22023';
  end if;
  return jsonb_build_object('applied',true);
end
$function$;

-- Trigger-only helpers are not RPC entry points for clients or service workers.
revoke all on function public.growell_habit_sync_source(jsonb),
  public.growell_habit_sync_enqueue(text,text,jsonb,boolean),public.growell_habit_sync_capture(),public.growell_habit_sync_revoke_member()
  from public,anon,authenticated,service_role;
revoke all on function public.growell_habit_sync_oauth(text,jsonb),
  public.growell_habit_sync_configure(text,uuid,text,jsonb),public.growell_habit_sync_claim(text,integer),
  public.growell_habit_sync_apply(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_habit_sync_oauth(text,jsonb),
  public.growell_habit_sync_configure(text,uuid,text,jsonb),public.growell_habit_sync_claim(text,integer),
  public.growell_habit_sync_apply(text,uuid,uuid,text,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
