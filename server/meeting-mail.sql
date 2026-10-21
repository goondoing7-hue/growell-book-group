-- Additive automatic meeting-record PDF mail, including the explicitly selected
-- public insights for that book and round. Private records are never included.
-- No authored row, Google token, existing receipt or legacy queue is changed.
-- No external request is performed and no member is enrolled by installation.
begin;
do $guard$
begin
  if to_regclass('public.growell_meeting_records') is null
    or to_regclass('public.growell_drive_backup_connections') is null
    or to_regclass('public.growell_meeting_calendar_connections') is null
    or to_regclass('public.book_locks') is null then
    raise exception 'Apply existing meeting records and Google connectors first';
  end if;
end
$guard$;

create table if not exists public.growell_meeting_mail_subscriptions (
  owner_id text primary key references public.profiles(id),
  auth_user_id uuid not null,
  generation uuid not null default gen_random_uuid(),
  account_id text not null check(char_length(account_id) between 1 and 512),
  account_email text not null check(char_length(account_email) between 3 and 254 and account_email !~ '[[:space:][:cntrl:]]' and account_email ~ '^[^@]+@[^@]+\.[^@]+$'),
  enabled boolean not null default true,
  connected_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_sent_at timestamptz,
  last_error text
);
create table if not exists public.growell_meeting_mail_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.profiles(id),
  auth_user_id uuid not null,
  account_id text not null,
  recipient_email text not null,
  record_id uuid not null references public.growell_meeting_records(id),
  status text not null default 'pending' check(status in ('pending','claimed','sending','sent','review')),
  available_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  claimed_generation uuid,
  sent_revision bigint,
  provider_id text,
  message_id text,
  sent_at timestamptz,
  first_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique(record_id,account_id,recipient_email)
);
alter table public.growell_meeting_mail_subscriptions enable row level security;
alter table public.growell_meeting_mail_jobs enable row level security;
revoke all on public.growell_meeting_mail_subscriptions,public.growell_meeting_mail_jobs from public,anon,authenticated;
grant select,insert,update on public.growell_meeting_mail_subscriptions,public.growell_meeting_mail_jobs to service_role;
create index if not exists growell_meeting_mail_due on public.growell_meeting_mail_jobs(available_at,created_at) where status in ('pending','claimed','sending');

-- The email comes only from the verified, owner-bound unified Google stores.
-- A browser cannot choose another recipient or use its account's login email.
create or replace function public.growell_meeting_mail_eligible(p_owner text,p_auth uuid,p_account text,p_email text,p_book text default null)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(select 1 from public.profiles p
    join public.growell_drive_backup_connections d on d.owner_id=p.id and d.auth_user_id=p.auth_user_id
    join public.growell_meeting_calendar_connections c on c.owner_id=p.id and c.auth_user_id=p.auth_user_id
    where p.id=p_owner and p.auth_user_id=p_auth and p.approval_status='approved' and p.is_deleted=false
      and d.token_cipher is not null and c.token_cipher is not null
      and d.account_id=p_account and c.account_id=p_account
      and lower(d.account_email)=p_email and lower(c.account_email)=p_email
      and (p_book is null or p.is_admin=true or not coalesce((select b.locked from public.book_locks b where b.book_id=p_book),p_book<>'emotion')));
$function$;

create or replace function public.growell_meeting_mail_enqueue(p_owner text,p_record uuid)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare subscription public.growell_meeting_mail_subscriptions%rowtype; record_row public.growell_meeting_records%rowtype; affected integer;
begin
  select * into subscription from public.growell_meeting_mail_subscriptions where owner_id=p_owner and enabled=true;
  if not found then return false;end if;
  select * into record_row from public.growell_meeting_records where id=p_record and status='published' and deleted_at is null;
  if not found or not public.growell_meeting_mail_eligible(p_owner,subscription.auth_user_id,subscription.account_id,subscription.account_email,record_row.book_id) then return false;end if;
  insert into public.growell_meeting_mail_jobs(owner_id,auth_user_id,account_id,recipient_email,record_id)
    values(p_owner,subscription.auth_user_id,subscription.account_id,subscription.account_email,p_record)
    on conflict(record_id,account_id,recipient_email) do nothing;
  get diagnostics affected=row_count;return affected=1;
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

create or replace function public.growell_meeting_mail_capture()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare subscription record;
begin
  if new.status<>'published' or new.deleted_at is not null then return new;end if;
  if tg_op='UPDATE' and old.status='published' and old.deleted_at is null then return new;end if;
  for subscription in select owner_id from public.growell_meeting_mail_subscriptions where enabled=true loop
    perform public.growell_meeting_mail_enqueue(subscription.owner_id,new.id);
  end loop;
  return new;
end
$function$;
drop trigger if exists growell_meeting_mail_published on public.growell_meeting_records;
create trigger growell_meeting_mail_published after insert or update of status,deleted_at on public.growell_meeting_records
  for each row execute function public.growell_meeting_mail_capture();

create or replace function public.growell_meeting_mail_claim(p_limit integer default 1)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare job public.growell_meeting_mail_jobs%rowtype; subscription public.growell_meeting_mail_subscriptions%rowtype; result jsonb:='[]';
begin
  if p_limit is null or p_limit not between 1 and 5 then raise exception 'Invalid mail batch size' using errcode='22023';end if;
  -- A sending timeout cannot prove whether SMTP accepted the message. Keep it
  -- for review forever rather than silently mailing an identical attachment.
  update public.growell_meeting_mail_jobs set status='review',last_error='delivery-uncertain',lease_until=null
    where status='sending' and lease_until<clock_timestamp();
  update public.growell_meeting_mail_jobs set status='review',last_error='service-unavailable',lease_until=null
    where status='claimed' and attempts>=5 and lease_until<clock_timestamp();
  for job in select j.* from public.growell_meeting_mail_jobs j
    join public.growell_meeting_mail_subscriptions s on s.owner_id=j.owner_id and s.auth_user_id=j.auth_user_id
      and s.account_id=j.account_id and s.account_email=j.recipient_email and s.enabled=true
    join public.growell_meeting_records r on r.id=j.record_id and r.status='published' and r.deleted_at is null
    where j.available_at<=clock_timestamp() and (j.status='pending' or (j.status='claimed' and j.lease_until<clock_timestamp()))
      and public.growell_meeting_mail_eligible(j.owner_id,j.auth_user_id,j.account_id,j.recipient_email,r.book_id)
    order by j.available_at,j.created_at,j.id for update of j skip locked limit p_limit loop
    select * into subscription from public.growell_meeting_mail_subscriptions where owner_id=job.owner_id;
    update public.growell_meeting_mail_jobs set status='claimed',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '3 minutes',
      claimed_generation=subscription.generation,attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,clock_timestamp())
      where id=job.id returning * into job;
    result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'lease_token',job.lease_token,'record_id',job.record_id,
      'owner_id',job.owner_id,'attempts',job.attempts));
  end loop;
  return result;
end
$function$;

create or replace function public.growell_meeting_mail_apply(p_job uuid,p_lease uuid,p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare job public.growell_meeting_mail_jobs%rowtype; subscription public.growell_meeting_mail_subscriptions%rowtype;
  record_row public.growell_meeting_records%rowtype; materials jsonb; insights jsonb; record_json jsonb; outgoing jsonb;
  content_hash text; permitted boolean; delay integer;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>4096 then raise exception 'Invalid mail operation' using errcode='22023';end if;
  select * into job from public.growell_meeting_mail_jobs where id=p_job for update;
  if not found or p_lease is null or job.lease_token is distinct from p_lease or job.status not in ('claimed','sending') then return jsonb_build_object('applied',false);end if;
  -- Once SMTP began, receipt updates remain valid despite pause/revocation or
  -- reconnect, otherwise accepted-but-unrecorded mail could be sent twice.
  if p_operation in ('accepted','uncertain') then
    if job.status<>'sending' then return jsonb_build_object('applied',false);end if;
    if p_operation='accepted' then
      if char_length(coalesce(p_payload->>'provider_id',''))>512 or char_length(coalesce(p_payload->>'message_id',''))>512 then raise exception 'Invalid receipt' using errcode='22023';end if;
      update public.growell_meeting_mail_jobs set status='sent',sent_at=clock_timestamp(),lease_until=null,last_error=null,
        provider_id=p_payload->>'provider_id',message_id=p_payload->>'message_id' where id=p_job;
      update public.growell_meeting_mail_subscriptions set last_sent_at=clock_timestamp(),last_error=null
        where owner_id=job.owner_id and auth_user_id=job.auth_user_id and account_id=job.account_id and account_email=job.recipient_email;
    else
      update public.growell_meeting_mail_jobs set status='review',lease_until=null,last_error='delivery-uncertain' where id=p_job;
      update public.growell_meeting_mail_subscriptions set last_error='delivery-uncertain'
        where owner_id=job.owner_id and account_id=job.account_id and account_email=job.recipient_email;
    end if;
    return jsonb_build_object('applied',true);
  end if;
  if job.status<>'claimed' or job.lease_until<=clock_timestamp() then return jsonb_build_object('applied',false);end if;
  select * into subscription from public.growell_meeting_mail_subscriptions where owner_id=job.owner_id;
  select * into record_row from public.growell_meeting_records where id=job.record_id for share;
  permitted:=subscription.enabled and subscription.auth_user_id=job.auth_user_id and subscription.generation=job.claimed_generation
    and subscription.account_id=job.account_id and subscription.account_email=job.recipient_email
    and record_row.status='published' and record_row.deleted_at is null
    and public.growell_meeting_mail_eligible(job.owner_id,job.auth_user_id,job.account_id,job.recipient_email,record_row.book_id);
  if permitted is distinct from true then return jsonb_build_object('applied',false);end if;
  if p_operation in ('guard','snapshot','prepare') then
    if p_operation='guard' then return jsonb_build_object('applied',true);end if;
    -- Deliberate allowlists: operator content and the selected PUBLIC same-round
    -- answers only. Profile/account details and private/material bodies remain
    -- in their original tables and are never copied to the outgoing document.
    record_json:=jsonb_build_object('id',record_row.id,'bookId',record_row.book_id,'round',record_row.round,'date',record_row.meeting_date,
      'topic',record_row.topic,'sections',record_row.sections,'concepts',record_row.concepts,'nextMeeting',record_row.next_meeting,
      'revision',record_row.revision,'status','published');
    select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'title',m.title) order by array_position(record_row.material_ids,m.id)),'[]') into materials
      from public.material_notes m where m.id=any(record_row.material_ids) and m.book_id=record_row.book_id and m.user_id=record_row.user_id;
    select coalesce(jsonb_agg(jsonb_build_object('authorName',coalesce(nullif(btrim(a.name),''),'회원'),
      'date',case when p.created_at is null then null else to_char(to_timestamp(p.created_at/1000.0) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'q1',coalesce(p.q1,''),'q2',coalesce(p.q2,''),'q3',coalesce(p.q3,'')) order by p.created_at,p.id),'[]') into insights
      from public.posts p join public.profiles a on a.id=p.user_id and a.approval_status='approved' and a.is_deleted=false
      where p.book_id=record_row.book_id and p.note_type='insight'
        and case when char_length(btrim(p.meeting_no))<=30 and btrim(p.meeting_no) ~ '^[+]?[0-9]{1,10}([.][0-9]{1,10})?([eE][+-]?[0-9]{1,3})?$'
          then btrim(p.meeting_no)::numeric else null end=record_row.round
        and coalesce(to_jsonb(p)->>'is_deleted','false')='false' and to_jsonb(p)->>'deleted_at' is null
        and coalesce(to_jsonb(p)->>'is_private','false')='false' and coalesce(to_jsonb(p)->>'visibility','public')='public';
    outgoing:=jsonb_build_object('record',record_json,'materials',materials,'insights',insights);
    if octet_length(outgoing::text)>4*1024*1024 then raise exception 'Meeting PDF content too large' using errcode='54000';end if;
    content_hash:=encode(pg_catalog.sha256(pg_catalog.convert_to(outgoing::text,'UTF8')),'hex');
    if p_operation='prepare' then
      if jsonb_typeof(p_payload->'record_revision') is distinct from 'number' or (p_payload->>'record_revision') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(p_payload->'content_hash') is distinct from 'string' or (p_payload->>'content_hash') !~ '^[0-9a-f]{64}$' then
        raise exception 'Record revision and content hash required' using errcode='22023';end if;
      if (p_payload->>'record_revision')::bigint<>record_row.revision or p_payload->>'content_hash'<>content_hash then return jsonb_build_object('applied',false);end if;
      update public.growell_meeting_mail_jobs set status='sending',sent_revision=record_row.revision,lease_until=clock_timestamp()+interval '3 minutes' where id=p_job;
    end if;
    return jsonb_build_object('applied',true,'recipient',job.recipient_email,'record',record_json,'materials',materials,'insights',insights,'content_hash',content_hash);
  elsif p_operation='retry' then
    if p_payload->>'error_code' not in ('pdf-unavailable','service-unavailable','record-changed') then raise exception 'Invalid retry reason' using errcode='22023';end if;
    delay:=least(3600,greatest(60,coalesce((p_payload->>'retry_after')::integer,300)));
    update public.growell_meeting_mail_jobs set status=case when attempts>=5 then 'review' else 'pending' end,
      available_at=clock_timestamp()+make_interval(secs=>delay),lease_token=null,lease_until=null,
      claimed_generation=null,last_error=p_payload->>'error_code' where id=p_job;
    update public.growell_meeting_mail_subscriptions set last_error=p_payload->>'error_code' where owner_id=job.owner_id;
    return jsonb_build_object('applied',true);
  else raise exception 'Unknown mail operation' using errcode='22023';end if;
end
$function$;

-- The service-only Edge worker needs the already-existing worker credential to
-- request a PDF from the fixed Vercel endpoint. Never expose this RPC to clients.
create or replace function public.growell_meeting_mail_worker_secret()
returns text language plpgsql security definer set search_path=''
as $function$
declare secret text;
begin
  select case when count(*)=1 then max(decrypted_secret) end into secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret';
  if secret is null or char_length(secret) not between 32 and 256 then raise exception 'Worker not configured' using errcode='55000';end if;
  return secret;
end
$function$;
create or replace function public.growell_meeting_mail_worker_authorized(p_secret text)
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
revoke all on function public.growell_meeting_mail_eligible(text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_enqueue(text,uuid) from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_capture() from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_configure(text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_claim(integer) from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_worker_secret() from public,anon,authenticated;
revoke all on function public.growell_meeting_mail_worker_authorized(text) from public,anon,authenticated;
grant execute on function public.growell_meeting_mail_configure(text,uuid,text,jsonb) to service_role;
grant execute on function public.growell_meeting_mail_claim(integer) to service_role;
grant execute on function public.growell_meeting_mail_apply(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.growell_meeting_mail_worker_secret() to service_role;
grant execute on function public.growell_meeting_mail_worker_authorized(text) to service_role;
commit;
