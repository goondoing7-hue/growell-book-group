-- Additive, service-role-only Google Drive backup. No external request is sent
-- by this migration. Archives are already encrypted inside private_entries.
begin;

do $guard$
declare source text; required record; column_name text;
begin
  if not exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.profiles')
    and attname='auth_user_id' and atttypid='uuid'::regtype and not attisdropped) then
    raise exception 'Member authentication schema required';
  end if;
  foreach source in array array['private_entries','habits','material_notes','posts','comments','worksheets','reading_logs','reading_meta'] loop
    if not exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.'||source)
      and attname='user_id' and atttypid='text'::regtype and not attisdropped) then
      raise exception 'Owned source table required: %',source;
    end if;
  end loop;
  -- JSON projection tolerates optional legacy display columns, but never an
  -- absent identity, encrypted payload, habit history, or reading progress.
  -- A renamed essential column must fail installation instead of exporting
  -- apparently successful backups that quietly omit the member's content.
  for required in select * from (values
    ('profiles',array['id','auth_user_id','approval_status','is_deleted']),
    ('private_entries',array['id','book_id','user_id','iv','data','created_at']),
    ('habits',array['id','book_id','user_id','name','place','time','goal','behavior_type','start_date','end_date','weekdays','checked_dates','created_at']),
    ('material_notes',array['id','book_id','user_id','html','photo_url','drive_links','title','created_at']),
    ('posts',array['id','book_id','user_id','html','photo_url','title','created_at']),
    ('comments',array['id','post_id','user_id','text','created_at']),
    ('worksheets',array['id','book_id','activity_key','user_id','data','created_at']),
    ('reading_logs',array['id','book_id','user_id','seconds','page','created_at']),
    ('reading_meta',array['book_id','user_id','current_page','updated_at'])
  ) as required_source(table_name,columns) loop
    foreach column_name in array required.columns loop
      if not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=to_regclass('public.'||required.table_name)
        and a.attname=column_name and not a.attisdropped and a.attgenerated='') then
        raise exception 'Required backup source column missing: %.%',required.table_name,column_name;
      end if;
    end loop;
  end loop;
end
$guard$;

create table if not exists public.growell_drive_backup_connections (
  owner_id text primary key references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  generation uuid not null,
  token_cipher text,
  account_id text,
  account_email text,
  enabled boolean not null default true,
  manual_requested boolean not null default false,
  dirty_revision bigint not null default 1 check(dirty_revision>0),
  synced_revision bigint not null default 0 check(synced_revision>=0),
  snapshot_revision bigint,
  folder_id text,
  file_id text,
  folder_created boolean not null default false,
  file_created boolean not null default false,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  next_sync_at timestamptz not null default clock_timestamp(),
  error_code text,
  last_counts jsonb,
  last_hash text,
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  check((lease_token is null)=(lease_until is null)),
  check(synced_revision<=dirty_revision),
  check(not folder_created or folder_id is not null),
  check(not file_created or file_id is not null)
);
create table if not exists public.growell_drive_backup_oauth_states (
  state_hash text primary key check(state_hash ~ '^[a-f0-9]{64}$'),
  owner_id text not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null,
  verifier_cipher text not null,
  expires_at timestamptz not null
);

alter table public.growell_drive_backup_connections enable row level security;
alter table public.growell_drive_backup_oauth_states enable row level security;
revoke all on table public.growell_drive_backup_connections,public.growell_drive_backup_oauth_states from public,anon,authenticated;
grant select,insert,update,delete on table public.growell_drive_backup_connections,public.growell_drive_backup_oauth_states to service_role;
create index if not exists growell_drive_backup_due on public.growell_drive_backup_connections(next_sync_at) where token_cipher is not null;
create index if not exists growell_drive_backup_oauth_expiry on public.growell_drive_backup_oauth_states(expires_at);

-- Explicit projections: new source columns are never silently exported. Cipher
-- bytes and IVs pass through unchanged; profile/login/recovery keys do not enter.
create or replace function public.growell_drive_backup_project(p_source text,p_row jsonb)
returns jsonb language sql immutable set search_path=''
as $function$
  select coalesce(jsonb_object_agg(item.key,item.value),'{}'::jsonb)
  from jsonb_each(p_row) item where item.key=any(case p_source
    when 'private_entries' then array['id','book_id','user_id','iv','data','created_at','updated_at']
    when 'habits' then array['id','book_id','user_id','name','place','time','goal','behavior_type','start_date','end_date','weekdays','checked_dates','created_at','updated_at']
    when 'material_notes' then array['id','book_id','user_id','note_type','page','html','photo_url','drive_links','meeting_no','font_size','title','created_at','updated_at']
    when 'posts' then array['id','book_id','user_id','checkin','note_type','meeting_no','q1','q2','q3','page','html','photo_url','bg_color','font_size','title','created_at','updated_at']
    when 'comments' then array['id','post_id','user_id','text','created_at']
    when 'worksheets' then array['id','book_id','activity_key','user_id','data','created_at','updated_at']
    when 'reading_logs' then array['id','book_id','user_id','seconds','page','start_page','created_at']
    when 'reading_meta' then array['book_id','user_id','current_page','updated_at']
    else array[]::text[] end);
$function$;

create or replace function public.growell_drive_backup_mark_dirty(p_owner text)
returns void language plpgsql security definer set search_path=''
as $function$
begin
  update public.growell_drive_backup_connections c set dirty_revision=c.dirty_revision+1,
    next_sync_at=case when c.error_code is null then clock_timestamp() else c.next_sync_at end
    where c.owner_id=p_owner and exists(select 1 from public.profiles p where p.id=c.owner_id
      and p.auth_user_id=c.auth_user_id and p.approval_status='approved' and p.is_deleted=false);
end
$function$;

create or replace function public.growell_drive_backup_capture()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if tg_op='UPDATE' and public.growell_drive_backup_project(tg_table_name,to_jsonb(old))
      is not distinct from public.growell_drive_backup_project(tg_table_name,to_jsonb(new)) then return new;end if;
  if tg_op<>'INSERT' then perform public.growell_drive_backup_mark_dirty(old.user_id);end if;
  if tg_op='INSERT' or (tg_op='UPDATE' and new.user_id is distinct from old.user_id) then
    perform public.growell_drive_backup_mark_dirty(new.user_id);
  end if;
  if tg_op='DELETE' then return old;end if;return new;
end
$function$;
do $triggers$
declare source text;
begin
  foreach source in array array['private_entries','habits','material_notes','posts','comments','worksheets','reading_logs','reading_meta'] loop
    execute format('drop trigger if exists growell_drive_backup_capture on public.%I',source);
    execute format('create trigger growell_drive_backup_capture after insert or update or delete on public.%I for each row execute function public.growell_drive_backup_capture()',source);
  end loop;
end
$triggers$;

create or replace function public.growell_drive_backup_revoke_member()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.is_deleted is distinct from false or new.approval_status is distinct from 'approved'
      or new.auth_user_id is distinct from old.auth_user_id then
    delete from public.growell_drive_backup_connections where owner_id=old.id;
    delete from public.growell_drive_backup_oauth_states where owner_id=old.id;
  end if;
  return new;
end
$function$;
drop trigger if exists growell_drive_backup_revoke_member on public.profiles;
create trigger growell_drive_backup_revoke_member after update of is_deleted,approval_status,auth_user_id on public.profiles
  for each row execute function public.growell_drive_backup_revoke_member();

create or replace function public.growell_drive_backup_oauth(p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare saved public.growell_drive_backup_oauth_states%rowtype; owner text; member_auth uuid;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or coalesce(p_payload->>'state_hash','') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid OAuth state' using errcode='22023';
  end if;
  if p_operation='consume' then
    delete from public.growell_drive_backup_oauth_states where state_hash=p_payload->>'state_hash' returning * into saved;
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
    delete from public.growell_drive_backup_oauth_states where owner_id=owner or expires_at<=clock_timestamp();
    insert into public.growell_drive_backup_oauth_states(state_hash,owner_id,auth_user_id,verifier_cipher,expires_at)
      values(p_payload->>'state_hash',owner,member_auth,p_payload->>'verifier_cipher',(p_payload->>'expires_at')::timestamptz);
    return jsonb_build_object('saved',true);
  end if;
  raise exception 'Unknown OAuth operation' using errcode='22023';
end
$function$;

create or replace function public.growell_drive_backup_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_drive_backup_connections%rowtype; next_generation uuid; same_account boolean;
begin
  perform 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.approval_status='approved' and p.is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell-drive-backup:'||p_owner,0));
  select * into connection from public.growell_drive_backup_connections where owner_id=p_owner for update;
  if found and connection.lease_until>clock_timestamp() then raise exception 'Connector busy; retry' using errcode='40001';end if;
  if p_operation='connect' then
    next_generation:=(p_payload->>'generation')::uuid;
    if next_generation is null or next_generation=connection.generation
      or char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536
      or char_length(coalesce(p_payload->>'account_id','')) not between 1 and 512
      or char_length(coalesce(p_payload->>'account_email',''))>320 then raise exception 'Invalid connection' using errcode='22023';end if;
    same_account:=coalesce(connection.account_id=p_payload->>'account_id',false);
    insert into public.growell_drive_backup_connections(owner_id,auth_user_id,generation,token_cipher,account_id,account_email,connected_at)
      values(p_owner,p_auth,next_generation,p_payload->>'token_cipher',p_payload->>'account_id',p_payload->>'account_email',clock_timestamp())
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=excluded.generation,
        token_cipher=excluded.token_cipher,account_id=excluded.account_id,account_email=excluded.account_email,enabled=true,
        manual_requested=false,dirty_revision=public.growell_drive_backup_connections.dirty_revision+1,
        synced_revision=case when same_account then public.growell_drive_backup_connections.synced_revision else 0 end,
        snapshot_revision=null,folder_id=case when same_account then public.growell_drive_backup_connections.folder_id end,
        file_id=case when same_account then public.growell_drive_backup_connections.file_id end,
        folder_created=same_account and public.growell_drive_backup_connections.folder_created,
        file_created=same_account and public.growell_drive_backup_connections.file_created,
        connected_at=excluded.connected_at,last_synced_at=case when same_account then public.growell_drive_backup_connections.last_synced_at end,
        last_counts=case when same_account then public.growell_drive_backup_connections.last_counts end,
        last_hash=case when same_account then public.growell_drive_backup_connections.last_hash end,
        last_attempt_at=null,next_sync_at=clock_timestamp(),error_code=null,attempts=0,lease_token=null,lease_until=null;
  elsif p_operation='disconnect' then
    -- Preserve known remote IDs only for a future reconnect to the same account.
    -- No Drive file is deleted and no stale worker can apply a result afterwards.
    update public.growell_drive_backup_connections set token_cipher=null,generation=gen_random_uuid(),
      enabled=false,manual_requested=false,snapshot_revision=null,error_code=null,lease_token=null,lease_until=null where owner_id=p_owner;
    delete from public.growell_drive_backup_oauth_states where owner_id=p_owner;
  elsif p_operation in ('settings','sync') then
    if connection.owner_id is null or connection.auth_user_id is distinct from p_auth or connection.token_cipher is null then
      raise exception 'Connection required' using errcode='55000';end if;
    if p_operation='settings' then
      if not(p_payload ? 'enabled') or jsonb_typeof(p_payload->'enabled')<>'boolean' then raise exception 'Invalid settings' using errcode='22023';end if;
      update public.growell_drive_backup_connections set enabled=(p_payload->>'enabled')::boolean,
        manual_requested=false,error_code=null,next_sync_at=clock_timestamp(),lease_token=null,lease_until=null where owner_id=p_owner;
    else
      update public.growell_drive_backup_connections set manual_requested=true,dirty_revision=dirty_revision+1,
        error_code=null,next_sync_at=clock_timestamp(),lease_token=null,lease_until=null where owner_id=p_owner;
    end if;
  else raise exception 'Unknown configuration operation' using errcode='22023';end if;
  select * into connection from public.growell_drive_backup_connections where owner_id=p_owner;
  return to_jsonb(connection)-'token_cipher'-'lease_token'-'lease_until';
end
$function$;

create or replace function public.growell_drive_backup_claim(p_owner text default null,p_limit integer default 1)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_drive_backup_connections%rowtype; result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>10 then raise exception 'Invalid claim limit' using errcode='22023';end if;
  for connection in select c.* from public.growell_drive_backup_connections c where (p_owner is null or c.owner_id=p_owner)
    and (c.enabled or c.manual_requested) and c.token_cipher is not null and c.dirty_revision>c.synced_revision
    and (c.lease_until is null or c.lease_until<=clock_timestamp()) and c.next_sync_at<=clock_timestamp()
    and exists(select 1 from public.profiles p where p.id=c.owner_id and p.auth_user_id=c.auth_user_id
      and p.approval_status='approved' and p.is_deleted=false)
    order by c.last_attempt_at nulls first,c.owner_id for update of c skip locked limit p_limit loop
    update public.growell_drive_backup_connections set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',
      last_attempt_at=clock_timestamp(),snapshot_revision=null where owner_id=connection.owner_id returning * into connection;
    result:=result||jsonb_build_array(jsonb_build_object('connection',to_jsonb(connection)));
  end loop;
  return result;
end
$function$;

create or replace function public.growell_drive_backup_snapshot(p_owner text,p_generation uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_drive_backup_connections%rowtype; result jsonb;
begin
  select * into connection from public.growell_drive_backup_connections where owner_id=p_owner for update;
  if not found or connection.generation is distinct from p_generation or p_lease is null
    or connection.lease_token is distinct from p_lease or connection.lease_until<=clock_timestamp()
    or connection.token_cipher is null or not(connection.enabled or connection.manual_requested)
    or not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=connection.auth_user_id
      and p.approval_status='approved' and p.is_deleted=false) then return null;end if;
  -- One MVCC statement reads every collection. The connection row lock also
  -- serializes source triggers; there is no HTTP paging/truncation boundary.
  select jsonb_build_object('revision',c.dirty_revision,'data',jsonb_build_object(
    'private_entries',(select coalesce(jsonb_agg(public.growell_drive_backup_project('private_entries',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.private_entries r where r.user_id=p_owner),
    'habits',(select coalesce(jsonb_agg(public.growell_drive_backup_project('habits',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.habits r where r.user_id=p_owner),
    'material_notes',(select coalesce(jsonb_agg(public.growell_drive_backup_project('material_notes',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.material_notes r where r.user_id=p_owner),
    'posts',(select coalesce(jsonb_agg(public.growell_drive_backup_project('posts',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.posts r where r.user_id=p_owner),
    'comments',(select coalesce(jsonb_agg(public.growell_drive_backup_project('comments',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.comments r where r.user_id=p_owner),
    'worksheets',(select coalesce(jsonb_agg(public.growell_drive_backup_project('worksheets',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.worksheets r where r.user_id=p_owner),
    'reading_logs',(select coalesce(jsonb_agg(public.growell_drive_backup_project('reading_logs',to_jsonb(r)) order by r.id),'[]'::jsonb) from public.reading_logs r where r.user_id=p_owner),
    'reading_meta',(select coalesce(jsonb_agg(public.growell_drive_backup_project('reading_meta',to_jsonb(r)) order by r.book_id),'[]'::jsonb) from public.reading_meta r where r.user_id=p_owner)
  )) into result from public.growell_drive_backup_connections c where c.owner_id=p_owner;
  if octet_length(result::text)>20*1024*1024 then raise exception 'Backup snapshot too large' using errcode='22001';end if;
  update public.growell_drive_backup_connections set snapshot_revision=(result->>'revision')::bigint where owner_id=p_owner;
  return result;
end
$function$;

create or replace function public.growell_drive_backup_apply(p_owner text,p_generation uuid,p_lease uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_drive_backup_connections%rowtype; revision bigint; retry_seconds integer;
begin
  select * into connection from public.growell_drive_backup_connections where owner_id=p_owner for update;
  if not found or connection.generation is distinct from p_generation or p_lease is null
    or connection.lease_token is distinct from p_lease or connection.lease_until<=clock_timestamp()
    or not exists(select 1 from public.profiles p where p.id=p_owner and p.auth_user_id=connection.auth_user_id
      and p.approval_status='approved' and p.is_deleted=false) then return jsonb_build_object('applied',false);end if;
  if p_operation='release' then
    update public.growell_drive_backup_connections set lease_token=null,lease_until=null,snapshot_revision=null where owner_id=p_owner;
    return jsonb_build_object('applied',true);end if;
  if connection.token_cipher is null or not(connection.enabled or connection.manual_requested) then return jsonb_build_object('applied',false);end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid worker payload' using errcode='22023';end if;
  if p_operation='guard' then return jsonb_build_object('applied',true);
  elsif p_operation='ids' then
    if coalesce(p_payload->>'folder_id','') !~ '^[A-Za-z0-9_-]+$' or coalesce(p_payload->>'file_id','') !~ '^[A-Za-z0-9_-]+$'
      or char_length(p_payload->>'folder_id')>256 or char_length(p_payload->>'file_id')>256
      or p_payload->>'folder_id'=p_payload->>'file_id' then raise exception 'Invalid Drive IDs' using errcode='22023';end if;
    if (connection.folder_id is not null and connection.folder_id is distinct from p_payload->>'folder_id')
      or (connection.file_id is not null and connection.file_id is distinct from p_payload->>'file_id') then
      raise exception 'Drive IDs already reserved' using errcode='22023';end if;
    update public.growell_drive_backup_connections set folder_id=p_payload->>'folder_id',file_id=p_payload->>'file_id' where owner_id=p_owner;
  elsif p_operation='created' then
    if (p_payload ? 'folder_created' and jsonb_typeof(p_payload->'folder_created')<>'boolean')
      or (p_payload ? 'file_created' and jsonb_typeof(p_payload->'file_created')<>'boolean') then raise exception 'Invalid Drive creation flag' using errcode='22023';end if;
    update public.growell_drive_backup_connections set folder_created=folder_created or coalesce((p_payload->>'folder_created')::boolean,false),
      file_created=file_created or coalesce((p_payload->>'file_created')::boolean,false) where owner_id=p_owner;
  elsif p_operation='token' then
    if char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536 then raise exception 'Invalid encrypted token' using errcode='22023';end if;
    update public.growell_drive_backup_connections set token_cipher=p_payload->>'token_cipher' where owner_id=p_owner;
  elsif p_operation='success' then
    revision:=(p_payload->>'revision')::bigint;
    if revision is null or revision is distinct from connection.snapshot_revision or revision>connection.dirty_revision
      or revision<connection.synced_revision or not connection.folder_created or not connection.file_created then return jsonb_build_object('applied',false);end if;
    if jsonb_typeof(p_payload->'counts') is distinct from 'object' or octet_length((p_payload->'counts')::text)>4096
      or coalesce(p_payload->>'hash','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid backup receipt' using errcode='22023';end if;
    update public.growell_drive_backup_connections set synced_revision=revision,manual_requested=false,last_synced_at=clock_timestamp(),
      last_counts=p_payload->'counts',last_hash=p_payload->>'hash',error_code=null,attempts=0,next_sync_at=clock_timestamp() where owner_id=p_owner;
  elsif p_operation='failure' then
    retry_seconds:=greatest(5,least(coalesce((p_payload->>'retry_after')::integer,60),86400));
    if coalesce(p_payload->>'error_code','') !~ '^[a-z0-9_-]{1,100}$' then raise exception 'Invalid backup error' using errcode='22023';end if;
    update public.growell_drive_backup_connections set error_code=p_payload->>'error_code',attempts=attempts+1,
      next_sync_at=clock_timestamp()+make_interval(secs=>retry_seconds),
      enabled=case when p_payload->>'disable'='true' then false else enabled end,
      manual_requested=case when p_payload->>'disable'='true' then false else manual_requested end where owner_id=p_owner;
  else raise exception 'Unknown worker operation' using errcode='22023';end if;
  return jsonb_build_object('applied',true);
end
$function$;

revoke all on function public.growell_drive_backup_project(text,jsonb),public.growell_drive_backup_mark_dirty(text),
  public.growell_drive_backup_capture(),public.growell_drive_backup_revoke_member() from public,anon,authenticated,service_role;
revoke all on function public.growell_drive_backup_oauth(text,jsonb),public.growell_drive_backup_configure(text,uuid,text,jsonb),
  public.growell_drive_backup_claim(text,integer),public.growell_drive_backup_snapshot(text,uuid,uuid),
  public.growell_drive_backup_apply(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_drive_backup_oauth(text,jsonb),public.growell_drive_backup_configure(text,uuid,text,jsonb),
  public.growell_drive_backup_claim(text,integer),public.growell_drive_backup_snapshot(text,uuid,uuid),
  public.growell_drive_backup_apply(text,uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
