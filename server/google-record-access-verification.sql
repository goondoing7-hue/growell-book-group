-- Run as the database owner AFTER google-record-access.sql. ALL synthetic
-- writes, including actual Vault secrets, roll back on success AND failure.
-- Reads only the random fixtures' exact IDs, never an existing Vault secret,
-- master key, member record, or encryption key. Output is an aggregate only.
begin;
do $verify_google_record_access$
declare
  owner_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); applicant_id uuid:=gen_random_uuid();
  session_id uuid:=gen_random_uuid(); other_session uuid:=gen_random_uuid(); applicant_session uuid:=gen_random_uuid();
  owner_profile text; other_profile text; applicant_profile text;
  material text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'base64');
  replacement text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'base64');
  key_digest text; next_digest text; owner_claims jsonb; response jsonb; first_response jsonb;
  profile_before jsonb; old_envelope jsonb; old_secret uuid; next_secret uuid;
  intermediate_secret uuid;
  secret_ids uuid[]:='{}'; blocked boolean; result jsonb; stage text:='fixtures'; app_role text;
begin
  begin
    perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claims','{}',true);
    insert into auth.users(id) values(owner_id),(other_id),(applicant_id);
    insert into auth.sessions(id,user_id) values(session_id,owner_id),(other_session,other_id),(applicant_session,applicant_id);
    insert into auth.identities(provider_id,user_id,identity_data,provider) values
      (owner_id::text,owner_id,jsonb_build_object('sub',owner_id::text),'google'),
      (owner_id::text,owner_id,jsonb_build_object('sub',owner_id::text),'email'),
      (other_id::text,other_id,jsonb_build_object('sub',other_id::text),'google'),
      (applicant_id::text,applicant_id,jsonb_build_object('sub',applicant_id::text),'google');
    insert into public.profiles(auth_user_id,login_id,name,pbkdf2_salt)
      values(owner_id,'qa_record_'||replace(owner_id::text,'-',''),'기록 연결 롤백 검증',repeat('a',32)) returning id into owner_profile;
    insert into public.profiles(auth_user_id,login_id,name,pbkdf2_salt)
      values(other_id,'qa_record_'||replace(other_id::text,'-',''),'다른 소유자 롤백 검증',repeat('b',32)) returning id into other_profile;
    -- Approval is fixture maintenance only, not part of the user-facing RPC.
    perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    update public.profiles set approval_status='approved' where id in (owner_profile,other_profile);
    perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claims','{}',true);
    select to_jsonb(p) into profile_before from public.profiles p where id=owner_profile;
    old_envelope:=jsonb_build_object('format','synthetic-existing-password-wrapper','preserved',true);
    insert into public.growell_oauth_vaults(auth_user_id,profile_id,envelope) values(owner_id,owner_profile,old_envelope);
    key_digest:=encode(sha256(decode(material,'base64')),'hex');next_digest:=encode(sha256(decode(replacement,'base64')),'hex');
    owner_claims:=jsonb_build_object('sub',owner_id::text,'role','authenticated','is_anonymous',false,'session_id',session_id::text,
      'exp',floor(extract(epoch from now()))+3600,'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',floor(extract(epoch from now())))));
    perform set_config('request.jwt.claim.sub',owner_id::text,true);perform set_config('request.jwt.claims',owner_claims::text,true);

    stage:='original-key prepare and real Vault readback';
    execute 'set local role authenticated';
    if public.growell_google_record_access_get()->>'status' is distinct from 'missing' then raise exception 'unexpected initial state'; end if;
    first_response:=public.growell_google_record_access_prepare(owner_profile,repeat('a',32),material,key_digest);
    if first_response->>'keyB64' is distinct from material or first_response->>'keyDigest' is distinct from key_digest
      or first_response#>>'{profile,id}' is distinct from owner_profile then raise exception 'key readback mismatch'; end if;
    if public.growell_google_record_access_get() is distinct from first_response
      or public.growell_google_record_access_prepare(owner_profile,repeat('a',32),material,key_digest) is distinct from first_response then raise exception 'retry mismatch'; end if;
    execute 'reset role';
    select vault_secret_id into old_secret from public.growell_google_record_access where auth_user_id=owner_id;secret_ids:=array_append(secret_ids,old_secret);
    if not exists(select 1 from vault.secrets where id=old_secret and position(material in secret)=0) then raise exception 'Vault ciphertext missing'; end if;
    blocked:=false;
    begin perform public.growell_google_record_access_prepare(owner_profile,repeat('a',32),replacement,next_digest);
    exception when serialization_failure then blocked:=true; end;
    if not blocked then raise exception 'immutable prepare accepted a different key'; end if;

    stage:='live session and owner binding';
    perform set_config('request.jwt.claims',jsonb_set(owner_claims,'{session_id}',to_jsonb(other_session::text))::text,true);
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'foreign session accepted'; end if;
    perform set_config('request.jwt.claims',jsonb_set(owner_claims,'{exp}',to_jsonb(floor(extract(epoch from now()))-1))::text,true);
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'expired JWT accepted'; end if;
    perform set_config('request.jwt.claims',owner_claims::text,true);
    update auth.sessions set not_after=now()-interval '1 second' where id=session_id;
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'expired session accepted'; end if;
    update auth.sessions set not_after=null where id=session_id;
    perform set_config('request.jwt.claim.sub',other_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',other_id::text,'role','authenticated','is_anonymous',false,'session_id',other_session::text,'exp',floor(extract(epoch from now()))+3600)::text,true);
    if public.growell_google_record_access_get()->>'status' is distinct from 'missing' then raise exception 'foreign key disclosed'; end if;
    blocked:=false;begin perform public.growell_google_record_access_prepare(owner_profile,repeat('a',32),material,key_digest);exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'foreign profile accepted'; end if;

    stage:='Google identity and approved profile';
    perform set_config('request.jwt.claim.sub',owner_id::text,true);perform set_config('request.jwt.claims',owner_claims::text,true);
    delete from auth.identities where user_id=owner_id and provider='google';
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'missing Google identity accepted'; end if;
    insert into auth.identities(provider_id,user_id,identity_data,provider) values(owner_id::text,owner_id,jsonb_build_object('sub',owner_id::text),'google');
    perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    update public.profiles set approval_status='pending' where id=owner_profile;
    perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claim.sub',owner_id::text,true);perform set_config('request.jwt.claims',owner_claims::text,true);
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'pending member key disclosed'; end if;
    perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    update public.profiles set approval_status='approved',approved_at=(profile_before->>'approved_at')::timestamptz,approved_by=profile_before->>'approved_by' where id=owner_profile;
    perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claim.sub',owner_id::text,true);perform set_config('request.jwt.claims',owner_claims::text,true);

    stage:='recovery CAS and retained original secret';
    response:=public.growell_google_record_access_rotate(owner_profile,repeat('a',32),key_digest,replacement,next_digest,old_secret);
    if response->>'keyB64' is distinct from replacement
      or public.growell_google_record_access_rotate(owner_profile,repeat('a',32),key_digest,replacement,next_digest,old_secret) is distinct from response then raise exception 'rotation retry mismatch'; end if;
    select vault_secret_id into next_secret from public.growell_google_record_access where auth_user_id=owner_id;secret_ids:=array_append(secret_ids,next_secret);
    if not exists(select 1 from public.growell_google_record_access_history h where h.auth_user_id=owner_id and h.vault_secret_id=old_secret and h.key_digest=(first_response->>'keyDigest') and h.replacement_secret_id=next_secret)
      or not exists(select 1 from vault.secrets where id=old_secret) then raise exception 'old secret not retained'; end if;
    blocked:=false;begin perform public.growell_google_record_access_rotate(owner_profile,repeat('a',32),repeat('0',64),material,key_digest,old_secret);exception when serialization_failure then blocked:=true;end;
    if not blocked then raise exception 'stale CAS accepted'; end if;
    perform set_config('request.jwt.claims',jsonb_set(owner_claims,'{amr}',jsonb_build_array(jsonb_build_object('method','oauth','timestamp',floor(extract(epoch from now())))))::text,true);
    blocked:=false;begin perform public.growell_google_record_access_rotate(owner_profile,repeat('a',32),next_digest,material,key_digest,next_secret);exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'rotation without recent password accepted'; end if;
    perform set_config('request.jwt.claims',owner_claims::text,true);
    intermediate_secret:=next_secret;
    response:=public.growell_google_record_access_rotate(owner_profile,repeat('a',32),next_digest,material,key_digest,intermediate_secret);
    select vault_secret_id into next_secret from public.growell_google_record_access where auth_user_id=owner_id;secret_ids:=array_append(secret_ids,next_secret);
    if next_secret=old_secret or response->>'keyB64' is distinct from material then raise exception 'access generation not renewed'; end if;
    blocked:=false;begin perform public.growell_google_record_access_rotate(owner_profile,repeat('a',32),key_digest,replacement,next_digest,old_secret);exception when serialization_failure then blocked:=true;end;
    if not blocked then raise exception 'digest-only ABA accepted'; end if;
    if public.growell_google_record_access_rotate(owner_profile,repeat('a',32),next_digest,material,key_digest,intermediate_secret) is distinct from response then raise exception 'exact generation retry mismatch'; end if;
    if (select to_jsonb(p) from public.profiles p where id=owner_profile) is distinct from profile_before
      or (select envelope from public.growell_oauth_vaults where auth_user_id=owner_id) is distinct from old_envelope then raise exception 'original profile or v1 vault changed'; end if;

    stage:='nickname-only pending enrollment and winning-key retry';
    perform set_config('request.jwt.claim.sub',applicant_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',applicant_id::text,'role','authenticated','is_anonymous',false,'session_id',applicant_session::text,'exp',floor(extract(epoch from now()))+3600)::text,true);
    execute 'set local role authenticated';
    response:=public.growell_google_register('신규 롤백 검증',repeat('c',32),material);applicant_profile:=response#>>'{profile,id}';
    if response->>'status' is distinct from 'approval-required' or response->'keyB64' is distinct from 'null'::jsonb
      or response#>>'{profile,approval_status}' is distinct from 'pending' or response#>'{profile,is_admin}' is distinct from 'false'::jsonb then raise exception 'unsafe enrollment response'; end if;
    if public.growell_google_register('덮지 않을 이름',repeat('d',32),replacement) is distinct from response then raise exception 'enrollment retry replaced first proposal'; end if;
    blocked:=false;begin perform public.growell_google_record_access_get();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'applicant key disclosed before approval'; end if;
    execute 'reset role';
    if (select count(*) from public.growell_signup_notifications where profile_id=applicant_profile)<>1 then raise exception 'notice not exactly once'; end if;
    select vault_secret_id into next_secret from public.growell_google_record_access where auth_user_id=applicant_id;secret_ids:=array_append(secret_ids,next_secret);
    perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    update public.profiles set approval_status='approved' where id=applicant_profile;
    perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claim.sub',applicant_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',applicant_id::text,'role','authenticated','is_anonymous',false,'session_id',applicant_session::text,'exp',floor(extract(epoch from now()))+3600)::text,true);
    if public.growell_google_record_access_get()->>'keyB64' is distinct from material then raise exception 'first enrollment key not retained'; end if;

    stage:='RPC and direct-data ACL';
    foreach app_role in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(app_role,'public.growell_google_record_access','SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege(app_role,'public.growell_google_record_access_history','SELECT,INSERT,UPDATE,DELETE')
        or has_schema_privilege(app_role,'growell_record_access_private','USAGE') then raise exception 'direct record key access'; end if;
      if app_role<>'authenticated' and (has_function_privilege(app_role,'public.growell_google_record_access_get()','EXECUTE')
        or has_function_privilege(app_role,'public.growell_google_record_access_prepare(text,text,text,text)','EXECUTE')
        or has_function_privilege(app_role,'public.growell_google_record_access_rotate(text,text,text,text,text,uuid)','EXECUTE')
        or has_function_privilege(app_role,'public.growell_google_register(text,text,text)','EXECUTE')) then raise exception 'wrong API role'; end if;
    end loop;
    result:=jsonb_build_object('ok',true,'checks','actual Vault ciphertext/readback, same key/profile/salt/v1 preservation, current session/expiry/Google/approval/owner denial, immutable prepare, nickname-only atomic pending enrollment/retry, recent-password generation CAS/ABA/history and API ACL');
    -- Force this successful subtransaction to roll back exactly like failures.
    raise sqlstate 'GW001';
  exception
    when sqlstate 'GW001' then null;
    when others then result:=jsonb_build_object('ok',false,'stage',stage,'code',sqlstate);
  end;
  execute 'reset role';
  if exists(select 1 from auth.users where id=any(array[owner_id,other_id,applicant_id]))
    or exists(select 1 from public.profiles where auth_user_id=any(array[owner_id,other_id,applicant_id]))
    or exists(select 1 from public.growell_google_record_access where auth_user_id=any(array[owner_id,other_id,applicant_id]))
    or exists(select 1 from public.growell_google_record_access_history where auth_user_id=any(array[owner_id,other_id,applicant_id]))
    or exists(select 1 from vault.secrets where id=any(secret_ids)) then
    result:=jsonb_build_object('ok',false,'stage','synthetic rollback','code','fixture_remaining');
  else result:=result||jsonb_build_object('synthetic_rows_remaining',0); end if;
  perform set_config('growell.google_record_access_verification',result::text,true);
end;
$verify_google_record_access$;
select current_setting('growell.google_record_access_verification')::jsonb as google_record_access_verification;
rollback;
