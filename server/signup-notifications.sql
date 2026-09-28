-- Apply and verify before deploying the signup finalizer or notification worker.
-- No emails are sent by this migration. Existing applicants are not backfilled.
begin;

-- The scheduler token is generated and kept inside Vault. No SQL result, Edge
-- environment variable, browser, repository or operator tool needs its value.
create extension if not exists supabase_vault with schema vault;
create extension if not exists pgcrypto with schema extensions;
do $worker_secret$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_signup_notification_worker_secret',0));
  if not exists(select 1 from vault.secrets where name='growell_signup_notification_worker_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
      'growell_signup_notification_worker_secret','GROWELL signup notification scheduler; do not expose');
  end if;
end
$worker_secret$;
create or replace function public.growell_authorize_signup_notification_worker(p_secret text)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare expected text;
begin
  if p_secret is null or char_length(p_secret) not between 32 and 256 then return false;end if;
  select decrypted_secret into expected from vault.decrypted_secrets where name='growell_signup_notification_worker_secret';
  if expected is null or char_length(expected) not between 32 and 256 then return false;end if;
  return extensions.digest(p_secret,'sha256')=extensions.digest(expected,'sha256');
end
$function$;
revoke all on function public.growell_authorize_signup_notification_worker(text) from public,anon,authenticated;
grant execute on function public.growell_authorize_signup_notification_worker(text) to service_role;

create table if not exists public.growell_signup_notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null unique references public.profiles(id) on delete cascade,
  applicant_name text not null,
  login_id text not null,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check(status in ('pending','sending','sent','cancelled','review')),
  available_at timestamptz not null default (now()+interval '2 minutes'),
  attempts integer not null default 0 check(attempts>=0),
  first_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  sender text,
  recipient text,
  provider_id text,
  sent_at timestamptz,
  last_error text,
  template_version integer not null default 1 check(template_version=1)
);
-- Additive migration for installations with the former Resend queue. A provider
-- is chosen once, at the first claim; changing server secrets cannot reroute it.
alter table public.growell_signup_notifications add column if not exists provider text;
do $provider_constraint$
begin
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.growell_signup_notifications'::regclass
    and conname='growell_signup_notifications_provider_check') then
    alter table public.growell_signup_notifications add constraint growell_signup_notifications_provider_check
      check(provider is null or provider in ('gmail_smtp','legacy_resend'));
  end if;
end
$provider_constraint$;
-- We cannot prove whether a legacy attempt was accepted. Preserve its snapshot
-- and sent/cancelled history; quarantine unfinished attempts instead of resending.
update public.growell_signup_notifications set provider='legacy_resend' where provider is null and attempts>0;
update public.growell_signup_notifications set status='review',last_error='provider_migration_review',lease_token=null,lease_until=null
  where provider='legacy_resend' and status in ('pending','sending');
alter table public.growell_signup_notifications enable row level security;
revoke all on table public.growell_signup_notifications from public,anon,authenticated;
grant select,insert,update,delete on table public.growell_signup_notifications to service_role;
create index if not exists growell_signup_notifications_due
  on public.growell_signup_notifications(available_at) where status in ('pending','sending');

-- The hint remains required. Its write and the notice enqueue commit together.
-- The caller may compensate only its newly created account if this RPC fails.
create or replace function public.growell_finalize_signup(p_profile_id text,p_auth_user_id uuid,p_pw_hint text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare applicant public.profiles%rowtype; existing_hint text;
begin
  if p_pw_hint is null or char_length(btrim(p_pw_hint)) not between 1 and 1024 then
    raise exception 'Invalid signup hint' using errcode='22023';
  end if;
  select * into applicant from public.profiles where id=p_profile_id for update;
  if not found or applicant.auth_user_id is distinct from p_auth_user_id
      or applicant.approval_status<>'pending' or applicant.is_admin or applicant.is_deleted
      or char_length(btrim(coalesce(applicant.avatar_url,'')))=0 then
    raise exception 'Signup profile mismatch' using errcode='42501';
  end if;
  insert into public.profile_secrets(user_id,pw_hint,updated_at)
    values(p_profile_id,btrim(p_pw_hint),(extract(epoch from clock_timestamp())*1000)::bigint)
    on conflict(user_id) do nothing;
  select pw_hint into existing_hint from public.profile_secrets where user_id=p_profile_id;
  if existing_hint is distinct from btrim(p_pw_hint) then
    raise exception 'Signup hint changed' using errcode='40001';
  end if;
  insert into public.growell_signup_notifications(profile_id,applicant_name,login_id)
    values(applicant.id,applicant.name,applicant.login_id) on conflict(profile_id) do nothing;
  return jsonb_build_object('hintSaved',true,'notificationQueued',true);
end
$function$;
revoke all on function public.growell_finalize_signup(text,uuid,text) from public,anon,authenticated;
grant execute on function public.growell_finalize_signup(text,uuid,text) to service_role;

-- Disable the old entry point: an old worker must not claim Gmail jobs and send
-- through its previous provider. Retain the signature for additive deployment.
create or replace function public.growell_claim_signup_notification(p_sender text,p_recipient text,p_profile_id text default null)
returns setof public.growell_signup_notifications language plpgsql security definer set search_path=''
as $function$
begin
  raise exception 'Notification worker upgrade required' using errcode='55000';
end
$function$;
revoke all on function public.growell_claim_signup_notification(text,text,text) from public,anon,authenticated;
grant execute on function public.growell_claim_signup_notification(text,text,text) to service_role;

-- Claim exactly one pending job. There is deliberately no expired-sending path.
create or replace function public.growell_claim_signup_notification_v2(p_provider text,p_sender text,p_recipient text,p_profile_id text default null)
returns setof public.growell_signup_notifications language plpgsql security definer set search_path=''
as $function$
declare job_id uuid;
begin
  if p_provider is distinct from 'gmail_smtp' or p_sender is distinct from 'goondoing7@gmail.com'
      or p_recipient is distinct from 'goondoing7@gmail.com' then
    raise exception 'Invalid notification configuration' using errcode='22023';
  end if;
  update public.growell_signup_notifications n set status='cancelled',lease_token=null,lease_until=null,last_error='application_reviewed'
    where (p_profile_id is null or n.profile_id=p_profile_id) and n.status in ('pending','sending') and not exists(select 1 from public.profiles p
      join public.profile_secrets s on s.user_id=p.id
      where p.id=n.profile_id and p.approval_status='pending' and p.is_deleted=false and p.is_admin=false);
  -- SMTP has no deduplication key. This includes crashes before/after SMTP and
  -- loss of the database acknowledgment: no second claim is permitted.
  update public.growell_signup_notifications set status='review',lease_token=null,lease_until=null,last_error='smtp_delivery_uncertain'
    where (p_profile_id is null or profile_id=p_profile_id) and status='sending' and (lease_until is null or lease_until<=now());
  update public.growell_signup_notifications set status='review',lease_token=null,lease_until=null,last_error='invalid_delivery_snapshot'
    where (p_profile_id is null or profile_id=p_profile_id) and status='pending'
      and ((provider is not null and provider<>p_provider) or (sender is not null and sender<>p_sender)
        or (recipient is not null and recipient<>p_recipient) or (attempts>0 and (provider is null or sender is null or recipient is null)));
  -- Only proved pre-DATA temporary failures can reach pending again. Bound
  -- those retries as well, without treating this as an SMTP deduplication window.
  update public.growell_signup_notifications set status='review',lease_token=null,lease_until=null,last_error='retry_window_elapsed'
    where (p_profile_id is null or profile_id=p_profile_id) and status='pending' and (attempts>=10 or first_attempt_at<now()-interval '23 hours');
  select id into job_id from public.growell_signup_notifications
    where (p_profile_id is null or profile_id=p_profile_id) and status='pending' and available_at<=now()
    order by requested_at,id limit 1 for update skip locked;
  if job_id is null then return; end if;
  return query update public.growell_signup_notifications set
    status='sending',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),
    lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
    provider=coalesce(provider,p_provider),sender=coalesce(sender,p_sender),recipient=coalesce(recipient,p_recipient)
    where id=job_id returning *;
end
$function$;
revoke all on function public.growell_claim_signup_notification_v2(text,text,text,text) from public,anon,authenticated;
grant execute on function public.growell_claim_signup_notification_v2(text,text,text,text) to service_role;

create or replace function public.growell_finish_signup_notification(p_id uuid,p_lease_token uuid,p_provider_id text default null,p_error text default null,p_retryable boolean default false)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare changed integer;
begin
  if p_provider_id is not null and (p_error is not null or char_length(p_provider_id) not between 1 and 200) then
    raise exception 'Invalid delivery result' using errcode='22023';
  end if;
  if p_provider_id is null and coalesce(p_error,'') not in
    ('rate_limited','provider_unavailable','invalid_sender','invalid_request','network_error','unexpected_response','provider_rejected','idempotency_conflict',
     'smtp_before_data_temporary','smtp_auth_failed','smtp_rejected','smtp_delivery_uncertain') then
    raise exception 'Invalid delivery error' using errcode='22023';
  end if;
  update public.growell_signup_notifications set
    status=case when p_provider_id is not null then 'sent'
      when p_retryable and provider='gmail_smtp' and p_error='smtp_before_data_temporary'
        and attempts<10 and first_attempt_at>=now()-interval '23 hours' then 'pending' else 'review' end,
    provider_id=p_provider_id,sent_at=case when p_provider_id is not null then now() else null end,
    last_error=p_error,lease_token=null,lease_until=null,
    available_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer)
    where id=p_id and lease_token=p_lease_token and status='sending';
  get diagnostics changed=row_count;
  return changed=1;
end
$function$;
revoke all on function public.growell_finish_signup_notification(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.growell_finish_signup_notification(uuid,uuid,text,text,boolean) to service_role;

commit;
