-- ROLLBACK ONLY. Omit signup-notifications.sql's COMMIT and append this file.
-- All writes and job claims below are restricted to one random fixture profile.
do $verify$
declare
  auth_id uuid:=gen_random_uuid();
  fixture_id text:='qa_signup_notice_'||replace(auth_id::text,'-','');
  result jsonb; job public.growell_signup_notifications%rowtype; first_job public.growell_signup_notifications%rowtype;
  blocked boolean; finished boolean; n integer; hint_stamp bigint; profile_snapshot jsonb; worker_token text;
begin
  if has_table_privilege('anon','public.growell_signup_notifications','select')
    or has_table_privilege('authenticated','public.growell_signup_notifications','select')
    or has_function_privilege('anon','public.growell_finalize_signup(text,uuid,text)','execute')
    or has_function_privilege('authenticated','public.growell_finalize_signup(text,uuid,text)','execute')
    or has_function_privilege('anon','public.growell_claim_signup_notification(text,text,text)','execute')
    or has_function_privilege('authenticated','public.growell_claim_signup_notification(text,text,text)','execute')
    or has_function_privilege('anon','public.growell_claim_signup_notification_v2(text,text,text,text)','execute')
    or has_function_privilege('authenticated','public.growell_claim_signup_notification_v2(text,text,text,text)','execute')
    or has_function_privilege('anon','public.growell_authorize_signup_notification_worker(text)','execute')
    or has_function_privilege('authenticated','public.growell_authorize_signup_notification_worker(text)','execute')
    or has_function_privilege('authenticated','public.growell_finish_signup_notification(uuid,uuid,text,text,boolean)','execute') then
    raise exception 'FAIL member can read or invoke notification service';
  end if;
  select decrypted_secret into worker_token from vault.decrypted_secrets where name='growell_signup_notification_worker_secret';
  if not public.growell_authorize_signup_notification_worker(worker_token)
      or public.growell_authorize_signup_notification_worker(null)
      or public.growell_authorize_signup_notification_worker('short')
      or public.growell_authorize_signup_notification_worker(repeat('wrong-synthetic-value',3)) then
    raise exception 'FAIL Vault worker authentication';
  end if;
  worker_token:=null;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(auth_id);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,avatar_url,is_deleted)
    values(fixture_id,auth_id,fixture_id,'임시 가입 알림',repeat('a',32),'https://example.invalid/avatar.png',false);
  select to_jsonb(p) into profile_snapshot from public.profiles p where id=fixture_id;
  blocked:=false;
  begin perform public.growell_finalize_signup(fixture_id,gen_random_uuid(),'synthetic hint');
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked or exists(select 1 from public.profile_secrets where user_id=fixture_id)
    or exists(select 1 from public.growell_signup_notifications where profile_id=fixture_id) then
    raise exception 'FAIL wrong account finalized';
  end if;
  result:=public.growell_finalize_signup(fixture_id,auth_id,'synthetic hint');
  if result<>jsonb_build_object('hintSaved',true,'notificationQueued',true) then raise exception 'FAIL finalizer result';end if;
  select updated_at into hint_stamp from public.profile_secrets where user_id=fixture_id;
  select * into first_job from public.growell_signup_notifications where profile_id=fixture_id;
  if first_job.applicant_name<>'임시 가입 알림' or first_job.login_id<>fixture_id
    or first_job.status<>'pending' or first_job.available_at<=now() then raise exception 'FAIL queue snapshot/delay';end if;
  perform public.growell_finalize_signup(fixture_id,auth_id,'synthetic hint');
  if (select count(*) from public.growell_signup_notifications where profile_id=fixture_id)<>1
    or (select updated_at from public.profile_secrets where user_id=fixture_id)<>hint_stamp
    or (select to_jsonb(p) from public.profiles p where id=fixture_id) is distinct from profile_snapshot then
    raise exception 'FAIL retry changed original registration';
  end if;
  blocked:=false;
  begin perform public.growell_finalize_signup(fixture_id,auth_id,'changed hint');
    exception when serialization_failure then blocked:=true;end;
  if not blocked or (select pw_hint from public.profile_secrets where user_id=fixture_id)<>'synthetic hint' then
    raise exception 'FAIL hint overwritten';
  end if;
  blocked:=false;
  begin perform public.growell_claim_signup_notification('sender@example.invalid','admin@example.invalid',fixture_id);
    exception when object_not_in_prerequisite_state then blocked:=true;end;
  if not blocked then raise exception 'FAIL old worker can claim';end if;
  blocked:=false;
  begin perform public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','other@example.invalid',fixture_id);
    exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL arbitrary recipient';end if;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 then raise exception 'FAIL initial delay skipped';end if;
  update public.growell_signup_notifications set available_at=now()-interval '1 second' where profile_id=fixture_id;
  select * into job from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if job.id is distinct from first_job.id or job.status<>'sending' or job.attempts<>1 or job.lease_token is null then raise exception 'FAIL claim';end if;
  if job.provider<>'gmail_smtp' or job.sender<>'goondoing7@gmail.com' or job.recipient<>'goondoing7@gmail.com' then raise exception 'FAIL provider snapshot';end if;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 then raise exception 'FAIL duplicate active claim';end if;
  if public.growell_finish_signup_notification(job.id,gen_random_uuid(),'not-owned-delivery',null,false) then raise exception 'FAIL stale lease wrote result';end if;
  if not public.growell_finish_signup_notification(job.id,job.lease_token,null,'smtp_before_data_temporary',true) then raise exception 'FAIL retry result';end if;
  if (select status from public.growell_signup_notifications where id=job.id)<>'pending' then raise exception 'FAIL retry lost';end if;
  update public.growell_signup_notifications set available_at=now()-interval '1 second' where profile_id=fixture_id;
  select * into job from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if job.attempts<>2 or job.provider<>'gmail_smtp' or job.sender<>'goondoing7@gmail.com' or job.recipient<>'goondoing7@gmail.com' then raise exception 'FAIL retry changed delivery payload';end if;
  if not public.growell_finish_signup_notification(job.id,job.lease_token,'synthetic-delivery-id',null,false) then raise exception 'FAIL sent result';end if;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 then raise exception 'FAIL sent job repeated';end if;
  -- These state transitions are fixture-only tests, never production retries.
  -- An unacknowledged Gmail send must never be re-claimed, even one second
  -- after its lease expires. This also covers a worker lost before SMTP began.
  update public.growell_signup_notifications set status='sending',provider_id=null,sent_at=null,lease_token=job.lease_token,
    lease_until=now()-interval '1 second',first_attempt_at=now()-interval '3 minutes' where profile_id=fixture_id;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 or (select status from public.growell_signup_notifications where profile_id=fixture_id)<>'review'
      or (select last_error from public.growell_signup_notifications where profile_id=fixture_id)<>'smtp_delivery_uncertain'
      or (select attempts from public.growell_signup_notifications where profile_id=fixture_id)<>2 then raise exception 'FAIL expired SMTP lease resent';end if;
  if public.growell_finish_signup_notification(job.id,job.lease_token,'late-ack',null,false) then raise exception 'FAIL expired lease accepted after review';end if;
  -- A mistakenly marked retryable ambiguous error is still blocked by SQL.
  update public.growell_signup_notifications set status='sending',lease_token=job.lease_token,lease_until=now()+interval '2 minutes' where profile_id=fixture_id;
  -- Keep the mutation and read in separate statements. A subquery in the same
  -- boolean expression can be evaluated before the mutating function call.
  finished:=public.growell_finish_signup_notification(job.id,job.lease_token,null,'smtp_delivery_uncertain',true);
  if not finished then raise exception 'FAIL uncertain result not stored';end if;
  if (select status from public.growell_signup_notifications where profile_id=fixture_id)<>'review' then raise exception 'FAIL uncertain error retried';end if;
  update public.growell_signup_notifications set status='sending',lease_token=job.lease_token where profile_id=fixture_id;
  finished:=public.growell_finish_signup_notification(job.id,job.lease_token,null,'network_error',true);
  if not finished then raise exception 'FAIL legacy generic result not stored';end if;
  if (select status from public.growell_signup_notifications where profile_id=fixture_id)<>'review' then raise exception 'FAIL legacy generic retry reused';end if;
  update public.growell_signup_notifications set status='pending',provider='legacy_resend',available_at=now()-interval '1 second' where profile_id=fixture_id;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 or (select status from public.growell_signup_notifications where profile_id=fixture_id)<>'review'
      or (select provider from public.growell_signup_notifications where profile_id=fixture_id)<>'legacy_resend' then raise exception 'FAIL provider snapshot rerouted';end if;
  update public.growell_signup_notifications set status='pending',provider='gmail_smtp',first_attempt_at=now()-interval '24 hours' where profile_id=fixture_id;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 or (select last_error from public.growell_signup_notifications where profile_id=fixture_id)<>'retry_window_elapsed' then raise exception 'FAIL bounded pre-DATA retry';end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved' where id=fixture_id;
  update public.growell_signup_notifications set status='pending',attempts=0,first_attempt_at=null where profile_id=fixture_id;
  select count(*) into n from public.growell_claim_signup_notification_v2('gmail_smtp','goondoing7@gmail.com','goondoing7@gmail.com',fixture_id);
  if n<>0 or (select status from public.growell_signup_notifications where profile_id=fixture_id)<>'cancelled' then raise exception 'FAIL reviewed account sent';end if;
  delete from public.profile_secrets where user_id=fixture_id;
  delete from public.profiles where id=fixture_id;
  if exists(select 1 from public.growell_signup_notifications where profile_id=fixture_id) then raise exception 'FAIL compensation leaves notice';end if;
  delete from auth.users where id=auth_id;
end
$verify$;
select true as signup_gmail_outbox_verified;
rollback;
