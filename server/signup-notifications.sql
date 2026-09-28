-- Apply and verify before deploying the signup finalizer or notification worker.
-- No emails are sent by this migration. Existing applicants are not backfilled.
begin;

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

-- Claim exactly one job. Concurrent workers use SKIP LOCKED and a distinct lease.
-- The first sender and recipient are frozen so retry payloads stay identical.
create or replace function public.growell_claim_signup_notification(p_sender text,p_recipient text,p_profile_id text default null)
returns setof public.growell_signup_notifications language plpgsql security definer set search_path=''
as $function$
declare job_id uuid;
begin
  if p_sender is null or p_recipient is null or p_sender !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
      or p_recipient !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then
    raise exception 'Invalid notification configuration' using errcode='22023';
  end if;
  update public.growell_signup_notifications n set status='cancelled',lease_token=null,lease_until=null,last_error='application_reviewed'
    where (p_profile_id is null or n.profile_id=p_profile_id) and n.status in ('pending','sending') and not exists(select 1 from public.profiles p
      join public.profile_secrets s on s.user_id=p.id
      where p.id=n.profile_id and p.approval_status='pending' and p.is_deleted=false and p.is_admin=false);
  -- Resend deduplication lasts 24 hours. Stop uncertain retries before it expires.
  update public.growell_signup_notifications set status='review',lease_token=null,lease_until=null,last_error='retry_window_elapsed'
    where (p_profile_id is null or profile_id=p_profile_id) and status in ('pending','sending') and (attempts>=10 or first_attempt_at<now()-interval '23 hours')
      and (lease_until is null or lease_until<=now());
  select id into job_id from public.growell_signup_notifications
    where (p_profile_id is null or profile_id=p_profile_id) and (status='pending' or (status='sending' and lease_until<=now())) and available_at<=now()
    order by requested_at,id limit 1 for update skip locked;
  if job_id is null then return; end if;
  return query update public.growell_signup_notifications set
    status='sending',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),
    lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
    sender=coalesce(sender,p_sender),recipient=coalesce(recipient,p_recipient)
    where id=job_id returning *;
end
$function$;
revoke all on function public.growell_claim_signup_notification(text,text,text) from public,anon,authenticated;
grant execute on function public.growell_claim_signup_notification(text,text,text) to service_role;

create or replace function public.growell_finish_signup_notification(p_id uuid,p_lease_token uuid,p_provider_id text default null,p_error text default null,p_retryable boolean default false)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare changed integer;
begin
  if p_provider_id is not null and (p_error is not null or char_length(p_provider_id) not between 1 and 200) then
    raise exception 'Invalid delivery result' using errcode='22023';
  end if;
  if p_provider_id is null and coalesce(p_error,'') not in
    ('rate_limited','provider_unavailable','invalid_sender','invalid_request','network_error','unexpected_response','provider_rejected','idempotency_conflict') then
    raise exception 'Invalid delivery error' using errcode='22023';
  end if;
  update public.growell_signup_notifications set
    status=case when p_provider_id is not null then 'sent' when p_retryable and attempts<10 and first_attempt_at>=now()-interval '23 hours' then 'pending' else 'review' end,
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
