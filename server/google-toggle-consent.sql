-- Preserve each owner's explicit Google service choices during OAuth reconnect.
-- Apply after drive-backup.sql, meeting-calendar.sql and meeting-mail.sql.
-- Only the existing service-role configure functions are replaced. No member
-- content, credentials, existing settings, remote files/events, or queued mail
-- are changed by installation. No external request or enrollment is performed.
-- enabled is an explicit selected-service choice; default_enabled applies only
-- when that service has no connection row. Latest existing ON/OFF wins otherwise.
begin;

-- BEGIN GOOGLE_TOGGLE_CONSENT_FUNCTIONS
create or replace function public.growell_drive_backup_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_drive_backup_connections%rowtype; next_generation uuid; same_account boolean; next_enabled boolean;
begin
  perform 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.approval_status='approved' and p.is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell-drive-backup:'||p_owner,0));
  select * into connection from public.growell_drive_backup_connections where owner_id=p_owner for update;
  if found and connection.lease_until>clock_timestamp() then raise exception 'Connector busy; retry' using errcode='40001';end if;
  if p_operation='connect' then
    if (p_payload?'enabled' and jsonb_typeof(p_payload->'enabled') is distinct from 'boolean')
      or (p_payload?'default_enabled' and jsonb_typeof(p_payload->'default_enabled') is distinct from 'boolean') then
      raise exception 'Invalid connection settings' using errcode='22023';end if;
    -- Only the selected service sends an explicit choice. An unselected service
    -- supplies a first-connection default while preserving the latest ON/OFF
    -- held by this row lock, including another tab's choice during consent.
    -- Older callbacks omit both fields and keep their first-connection ON default.
    next_enabled:=case when p_payload?'enabled' then (p_payload->>'enabled')::boolean
      else coalesce(connection.enabled,(p_payload->>'default_enabled')::boolean,true) end;
    next_generation:=(p_payload->>'generation')::uuid;
    if next_generation is null or next_generation=connection.generation
      or char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536
      or char_length(coalesce(p_payload->>'account_id','')) not between 1 and 512
      or char_length(coalesce(p_payload->>'account_email',''))>320 then raise exception 'Invalid connection' using errcode='22023';end if;
    same_account:=coalesce(connection.account_id=p_payload->>'account_id',false);
    insert into public.growell_drive_backup_connections(owner_id,auth_user_id,generation,token_cipher,account_id,account_email,connected_at,enabled)
      values(p_owner,p_auth,next_generation,p_payload->>'token_cipher',p_payload->>'account_id',p_payload->>'account_email',clock_timestamp(),next_enabled)
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=excluded.generation,
        token_cipher=excluded.token_cipher,account_id=excluded.account_id,account_email=excluded.account_email,enabled=excluded.enabled,
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

create or replace function public.growell_meeting_calendar_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare connection public.growell_meeting_calendar_connections%rowtype; next_generation uuid; same_account boolean; next_enabled boolean;
begin
  perform 1 from public.profiles p where p.id=p_owner and p.auth_user_id=p_auth
    and p.approval_status='approved' and p.is_deleted=false for share;
  if not found then raise exception 'Approved owner required' using errcode='42501';end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid payload' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell-meeting-calendar:'||p_owner,0));
  select * into connection from public.growell_meeting_calendar_connections where owner_id=p_owner for update;
  if found and connection.lease_until>clock_timestamp() then raise exception 'Connector busy; retry' using errcode='40001';end if;
  if p_operation='connect' then
    if (p_payload?'enabled' and jsonb_typeof(p_payload->'enabled') is distinct from 'boolean')
      or (p_payload?'default_enabled' and jsonb_typeof(p_payload->'default_enabled') is distinct from 'boolean') then
      raise exception 'Invalid connection settings' using errcode='22023';end if;
    next_enabled:=case when p_payload?'enabled' then (p_payload->>'enabled')::boolean
      else coalesce(connection.enabled,(p_payload->>'default_enabled')::boolean,true) end;
    next_generation:=(p_payload->>'generation')::uuid;
    if next_generation is null or next_generation=connection.generation
      or exists(select 1 from public.growell_meeting_calendar_jobs where owner_id=p_owner and generation=next_generation)
      or char_length(coalesce(p_payload->>'token_cipher','')) not between 16 and 65536
      or char_length(coalesce(p_payload->>'account_id','')) not between 1 and 512
      or char_length(coalesce(p_payload->>'account_email',''))>320 then
      raise exception 'Invalid connection' using errcode='22023';end if;
    same_account:=coalesce(connection.account_id=p_payload->>'account_id' and connection.auth_user_id=p_auth,false);
    insert into public.growell_meeting_calendar_connections(owner_id,auth_user_id,generation,delivery_generation,token_cipher,account_id,account_email,connected_at,enabled)
      values(p_owner,p_auth,next_generation,next_generation,p_payload->>'token_cipher',p_payload->>'account_id',p_payload->>'account_email',clock_timestamp(),next_enabled)
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=excluded.generation,delivery_generation=excluded.delivery_generation,
        token_cipher=excluded.token_cipher,account_id=excluded.account_id,account_email=excluded.account_email,enabled=excluded.enabled,
        manual_requested=false,connected_at=excluded.connected_at,last_synced_at=case when same_account then public.growell_meeting_calendar_connections.last_synced_at end,
        last_attempt_at=null,next_sync_at=clock_timestamp(),error_code=null,attempts=0,lease_token=null,lease_until=null;
    if same_account then
      insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired,revision,synced_revision,event_id,event_created,last_synced_at,last_error)
        select owner_id,schedule_id,next_generation,desired,revision,synced_revision,event_id,event_created,last_synced_at,last_error
          from public.growell_meeting_calendar_jobs where owner_id=p_owner and generation=coalesce(connection.delivery_generation,connection.generation);
    end if;
    if next_enabled then
      insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired)
        select p_owner,s.schedule_id,next_generation,s.desired from public.growell_meeting_calendar_schedules s
        join public.announcement a on a.book_id='global' and a.calendar_schedule_id=s.schedule_id
        on conflict(owner_id,schedule_id,generation) do update set desired=excluded.desired,
          revision=public.growell_meeting_calendar_jobs.revision+1,last_error=null,next_sync_at=clock_timestamp();
    end if;
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
      if (p_payload->>'enabled')::boolean then
        -- A first connection can be paused before any meeting is queued. An
        -- explicit later ON catches up only the current meeting, preserving
        -- any known remote event identity and all historical jobs.
        insert into public.growell_meeting_calendar_jobs(owner_id,schedule_id,generation,desired)
          select p_owner,s.schedule_id,connection.generation,s.desired from public.growell_meeting_calendar_schedules s
          join public.announcement a on a.book_id='global' and a.calendar_schedule_id=s.schedule_id
          on conflict(owner_id,schedule_id,generation) do update set desired=excluded.desired,
            revision=public.growell_meeting_calendar_jobs.revision+1,last_error=null,next_sync_at=clock_timestamp()
            where public.growell_meeting_calendar_jobs.desired is distinct from excluded.desired;
      end if;
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

create or replace function public.growell_meeting_mail_configure(p_owner text,p_auth uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare subscription public.growell_meeting_mail_subscriptions%rowtype; drive_row public.growell_drive_backup_connections%rowtype;
  current_record uuid; same_account boolean; connected boolean; pending integer; sent integer; review integer; latest text; next_enabled boolean;
begin
  perform 1 from public.profiles where id=p_owner and auth_user_id=p_auth and approval_status='approved' and is_deleted=false for share;
  if not found then raise exception 'Approved membership required' using errcode='42501';end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>1024 then raise exception 'Invalid mail settings' using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('growell_meeting_mail:'||p_owner,0));
  select * into subscription from public.growell_meeting_mail_subscriptions where owner_id=p_owner for update;
  if p_operation='connect' then
    if (p_payload?'enabled' and jsonb_typeof(p_payload->'enabled') is distinct from 'boolean')
      or (p_payload?'default_enabled' and jsonb_typeof(p_payload->'default_enabled') is distinct from 'boolean')
      or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('enabled','default_enabled')) then
      raise exception 'Recipient cannot be supplied' using errcode='22023';end if;
    next_enabled:=case when p_payload?'enabled' then (p_payload->>'enabled')::boolean
      else coalesce(subscription.enabled,(p_payload->>'default_enabled')::boolean,true) end;
    select * into drive_row from public.growell_drive_backup_connections where owner_id=p_owner and auth_user_id=p_auth;
    if drive_row.owner_id is null or coalesce(char_length(drive_row.account_email),0) not between 3 and 254
      or drive_row.account_email ~ '[[:space:][:cntrl:]]' or drive_row.account_email !~ '^[^@]+@[^@]+\.[^@]+$'
      or not public.growell_meeting_mail_eligible(p_owner,p_auth,drive_row.account_id,lower(drive_row.account_email)) then
      raise exception 'Unified Google connection required' using errcode='55000';end if;
    same_account:=coalesce(subscription.account_id=drive_row.account_id and subscription.account_email=lower(drive_row.account_email) and subscription.auth_user_id=p_auth,false);
    insert into public.growell_meeting_mail_subscriptions(owner_id,auth_user_id,account_id,account_email,enabled)
      values(p_owner,p_auth,drive_row.account_id,lower(drive_row.account_email),next_enabled)
      on conflict(owner_id) do update set auth_user_id=excluded.auth_user_id,generation=gen_random_uuid(),account_id=excluded.account_id,
        -- Explicit connect choices apply before enqueueing; an omitted choice
        -- preserves the owner's preference even when changing Google accounts.
        account_email=excluded.account_email,enabled=excluded.enabled,
        last_sent_at=case when same_account then growell_meeting_mail_subscriptions.last_sent_at else null end,
        updated_at=clock_timestamp(),last_error=null returning * into subscription;
  elsif p_operation='settings' then
    if subscription.owner_id is null or subscription.auth_user_id is distinct from p_auth then raise exception 'Mail connection required' using errcode='55000';end if;
    if not(p_payload?'enabled') or jsonb_typeof(p_payload->'enabled') is distinct from 'boolean'
      or exists(select 1 from jsonb_object_keys(p_payload) k where k<>'enabled') then raise exception 'Invalid mail settings' using errcode='22023';end if;
    if not public.growell_meeting_mail_eligible(p_owner,p_auth,subscription.account_id,subscription.account_email) then raise exception 'Unified Google connection required' using errcode='55000';end if;
    update public.growell_meeting_mail_subscriptions set enabled=(p_payload->>'enabled')::boolean,generation=gen_random_uuid(),updated_at=clock_timestamp()
      where owner_id=p_owner returning * into subscription;
  elsif p_operation='status' then
    if p_payload<>'{}'::jsonb then raise exception 'Invalid mail settings' using errcode='22023';end if;
  else raise exception 'Unknown mail operation' using errcode='22023';end if;
  if p_operation in ('connect','settings') and subscription.enabled then
    -- Only the latest published, accessible record is added on first connect or
    -- resume. Older archives are never bulk-mailed. Uniqueness retains receipts.
    select r.id into current_record from public.growell_meeting_records r
      where r.status='published' and r.deleted_at is null
        and public.growell_meeting_mail_eligible(p_owner,p_auth,subscription.account_id,subscription.account_email,r.book_id)
      order by r.meeting_date desc nulls last,r.created_at desc,r.id desc limit 1;
    if current_record is not null then perform public.growell_meeting_mail_enqueue(p_owner,current_record);end if;
  end if;
  connected:=subscription.owner_id is not null and subscription.auth_user_id=p_auth
    and public.growell_meeting_mail_eligible(p_owner,p_auth,subscription.account_id,subscription.account_email);
  select count(*) filter(where j.status in ('pending','claimed','sending')),count(*) filter(where j.status='sent'),count(*) filter(where j.status='review')
    into pending,sent,review from public.growell_meeting_mail_jobs j where j.owner_id=p_owner and j.auth_user_id=p_auth
      and j.account_id=subscription.account_id and j.recipient_email=subscription.account_email;
  select case when j.status='claimed' then 'pending' when j.status='review' and j.last_error='delivery-uncertain' then 'uncertain'
    when j.status='review' then 'failed' else j.status end into latest
    from public.growell_meeting_mail_jobs j where j.owner_id=p_owner and j.auth_user_id=p_auth
      and j.account_id=subscription.account_id and j.recipient_email=subscription.account_email order by j.created_at desc,j.id desc limit 1;
  return jsonb_build_object('configured',true,'connected',connected,'enabled',connected and subscription.enabled,
    'accountEmail',case when connected then subscription.account_email else '' end,'lastSentAt',subscription.last_sent_at,
    'pendingCount',coalesce(pending,0),'sentCount',coalesce(sent,0),'reviewCount',coalesce(review,0),'errorCode',subscription.last_error,
    'latestStatus',case when not connected then 'none' when not subscription.enabled then 'paused' else coalesce(latest,'none') end);
end
$function$;

revoke all on function public.growell_drive_backup_configure(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_drive_backup_configure(text,uuid,text,jsonb) to service_role;
revoke all on function public.growell_meeting_calendar_configure(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_meeting_calendar_configure(text,uuid,text,jsonb) to service_role;
revoke all on function public.growell_meeting_mail_configure(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_meeting_mail_configure(text,uuid,text,jsonb) to service_role;
-- END GOOGLE_TOGGLE_CONSENT_FUNCTIONS

commit;
