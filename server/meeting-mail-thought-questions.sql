-- Apply after meeting-records-thought-questions.sql and the existing meeting-mail.sql.
-- This updates only the canonical PDF snapshot projection, not subscriptions,
-- jobs, delivery receipts, source records or publication triggers.
begin;
do $guard$
begin
  if to_regprocedure('public.growell_meeting_mail_apply(uuid,uuid,text,jsonb)') is null
      or not exists(select 1 from pg_attribute where attrelid='public.growell_meeting_records'::regclass and attname='thought_questions' and not attisdropped) then
    raise exception 'Apply meeting records questions and existing meeting mail first';
  end if;
end
$guard$;
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
      'topic',record_row.topic,'sections',record_row.sections,'concepts',record_row.concepts,'thoughtQuestions',coalesce(nullif(to_jsonb(record_row)->'thought_questions','null'::jsonb),'[]'::jsonb),'nextMeeting',record_row.next_meeting,
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
revoke all on function public.growell_meeting_mail_apply(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.growell_meeting_mail_apply(uuid,uuid,text,jsonb) to service_role;
commit;
