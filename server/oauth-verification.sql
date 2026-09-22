-- ROLLBACK-ONLY verification. No real member row is read or modified.
-- Combine oauth-members.sql with its final COMMIT removed, followed by this file.
-- Keep the original BEGIN and execute the entire combined batch as database owner.
-- This file never commits. Every synthetic Auth/profile/vault row is also inside
-- a subtransaction that is deliberately rolled back on BOTH success and failure.
-- The final ROLLBACK undoes the provisional DDL and permission changes as well.
-- If the editor stops a failed outer batch early, explicitly issue ROLLBACK;
-- do not COMMIT an aborted or interrupted verification transaction.
-- Ciphertext below is an intentionally synthetic format fixture. WebCrypto
-- integrity/password/owner checks are independently covered by Node tests.

do $verify$
declare
  google_id uuid := pg_catalog.gen_random_uuid();
  kakao_id uuid := pg_catalog.gen_random_uuid();
  legacy_id uuid := pg_catalog.gen_random_uuid();
  email_id uuid := pg_catalog.gen_random_uuid();
  fixture_salt text := repeat('a',32);
  google_envelope jsonb;
  kakao_envelope jsonb;
  response jsonb;
  first_response jsonb;
  legacy_before jsonb;
  legacy_after jsonb;
  blocked boolean;
  result jsonb;
  failure_message text;
  failure_code text;
begin
  begin
    insert into auth.users(id) values(google_id),(kakao_id),(legacy_id),(email_id);
    insert into auth.identities(provider_id,user_id,identity_data,provider) values
      (google_id::text,google_id,jsonb_build_object('sub',google_id::text),'google'),
      (kakao_id::text,kakao_id,jsonb_build_object('sub',kakao_id::text),'kakao'),
      (legacy_id::text,legacy_id,jsonb_build_object('sub',legacy_id::text),'google'),
      (email_id::text,email_id,jsonb_build_object('sub',email_id::text),'email');

    google_envelope := jsonb_build_object(
      'format','growell-oauth-vault-v1','version',1,'owner',google_id::text,
      'kdf',jsonb_build_object('name','PBKDF2','hash','SHA-256','iterations',150000,'salt',fixture_salt),
      'iv',encode(repeat('i',12)::bytea,'base64'),
      'data',translate(encode(repeat('x',96)::bytea,'base64'),E'\n\r','')
    );
    kakao_envelope := jsonb_set(google_envelope,'{owner}',to_jsonb(kakao_id::text));

    -- 1. Registered Google identity, without a GROWELL profile, is new.
    perform set_config('request.jwt.claim.sub',google_id::text,true);
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',google_id::text,'role','authenticated','is_anonymous',false)::text,true);
    response := public.growell_oauth_profile();
    if response->>'status' is distinct from 'new' or response->'profile' is distinct from 'null'::jsonb then
      raise exception 'FAIL new Google identity did not return new';
    end if;

    -- 2. First registration is atomic and always creates an ordinary member.
    first_response := public.growell_oauth_register('롤백 검증 회원',fixture_salt,google_envelope);
    if first_response->>'status' is distinct from 'ready'
       or first_response#>>'{profile,auth_user_id}' is distinct from google_id::text
       or first_response#>>'{profile,is_admin}' is distinct from 'false'
       or first_response->'envelope' is distinct from google_envelope then
      raise exception 'FAIL first registration/profile/vault/admin state';
    end if;
    if (select count(*) from public.profiles where auth_user_id=google_id)<>1
       or (select count(*) from public.growell_oauth_vaults where auth_user_id=google_id)<>1 then
      raise exception 'FAIL registration did not create one linked profile and one vault';
    end if;

    -- 3. A retry cannot replace the first nickname, salt, profile, or envelope.
    response := public.growell_oauth_register('덮어쓰면 안 됨',repeat('b',32),jsonb_set(google_envelope,'{data}',to_jsonb(encode(repeat('y',48)::bytea,'base64'))));
    if response is distinct from first_response then raise exception 'FAIL registration retry overwrote first data'; end if;
    if public.growell_oauth_profile() is distinct from first_response then raise exception 'FAIL repeat lookup differs from first registration'; end if;

    -- 4. Kakao identity cannot submit another account's envelope.
    perform set_config('request.jwt.claim.sub',kakao_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',kakao_id::text,'role','authenticated')::text,true);
    blocked := false;
    begin
      perform public.growell_oauth_register('다른 회원',fixture_salt,google_envelope);
    exception when invalid_parameter_value then blocked := true;
    end;
    if not blocked then raise exception 'FAIL other owner envelope accepted'; end if;
    if exists(select 1 from public.profiles where auth_user_id=kakao_id)
       or exists(select 1 from public.growell_oauth_vaults where auth_user_id=kakao_id) then
      raise exception 'FAIL invalid envelope left partially registered data';
    end if;
    response := public.growell_oauth_register('카카오 검증 회원',fixture_salt,kakao_envelope);
    if response->>'status' is distinct from 'ready' or response#>>'{profile,is_admin}' is distinct from 'false'
       or response#>>'{envelope,owner}' is distinct from kakao_id::text then
      raise exception 'FAIL Kakao registration';
    end if;

    -- 5. An existing ordinary profile is returned as legacy and never modified.
    insert into public.profiles(auth_user_id,login_id,name,pbkdf2_salt)
    values(legacy_id,'qa_rollback_'||replace(legacy_id::text,'-',''),'기존 일반회원 검증',repeat('c',32));
    select to_jsonb(p) into legacy_before from public.profiles p where auth_user_id=legacy_id;
    perform set_config('request.jwt.claim.sub',legacy_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',legacy_id::text,'role','authenticated')::text,true);
    response := public.growell_oauth_register('다른 이름',fixture_salt,jsonb_set(google_envelope,'{owner}',to_jsonb(legacy_id::text)));
    select to_jsonb(p) into legacy_after from public.profiles p where auth_user_id=legacy_id;
    if response->>'status' is distinct from 'legacy' or legacy_after is distinct from legacy_before
       or exists(select 1 from public.growell_oauth_vaults where auth_user_id=legacy_id) then
      raise exception 'FAIL existing ordinary profile was changed or given a vault';
    end if;

    -- 6. Password-only Auth identities cannot use either social RPC.
    perform set_config('request.jwt.claim.sub',email_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',email_id::text,'role','authenticated')::text,true);
    blocked := false;
    begin perform public.growell_oauth_profile(); exception when insufficient_privilege then blocked:=true; end;
    if not blocked then raise exception 'FAIL email identity accessed social profile RPC'; end if;
    blocked := false;
    begin perform public.growell_oauth_register('이메일 검증',fixture_salt,jsonb_set(google_envelope,'{owner}',to_jsonb(email_id::text)));
    exception when insufficient_privilege then blocked:=true; end;
    if not blocked then raise exception 'FAIL email identity registered through social RPC'; end if;

    -- 7. Missing authenticated identity is denied by both function bodies.
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claim.role','anon',true);
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    blocked := false;
    begin perform public.growell_oauth_profile(); exception when insufficient_privilege then blocked:=true; end;
    if not blocked then raise exception 'FAIL anonymous profile RPC accepted'; end if;
    blocked := false;
    begin perform public.growell_oauth_register('익명 검증',fixture_salt,google_envelope);
    exception when insufficient_privilege then blocked:=true; end;
    if not blocked then raise exception 'FAIL anonymous register RPC accepted'; end if;

    -- 8. Privilege checks cover real API roles independently of the owner-run DO.
    if has_function_privilege('anon','public.growell_oauth_profile()','EXECUTE')
       or has_function_privilege('anon','public.growell_oauth_register(text,text,jsonb)','EXECUTE') then
      raise exception 'FAIL anon can execute social RPCs';
    end if;
    if not has_function_privilege('authenticated','public.growell_oauth_profile()','EXECUTE')
       or not has_function_privilege('authenticated','public.growell_oauth_register(text,text,jsonb)','EXECUTE') then
      raise exception 'FAIL authenticated RPC execute privilege missing';
    end if;
    if has_table_privilege('anon','public.growell_oauth_vaults','SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated','public.growell_oauth_vaults','SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'FAIL a client role has direct vault table privileges';
    end if;
    if not (select relrowsecurity from pg_class where oid='public.growell_oauth_vaults'::regclass) then
      raise exception 'FAIL vault RLS is disabled';
    end if;

    -- Deliberate exception rolls back ALL synthetic data, including Auth rows,
    -- even when every assertion passed. Only the local result variable survives.
    raise exception 'GROWELL_VERIFICATION_SUCCESS_ROLLBACK' using errcode='GW001';
  exception
    when sqlstate 'GW001' then result:=jsonb_build_object('ok',true,'checks','Google/Kakao new-ready, ordinary role, idempotent retry, owner isolation, legacy preservation, email/anon denial, vault/RPC privileges');
    when others then
      get stacked diagnostics failure_message=message_text,failure_code=returned_sqlstate;
      result:=jsonb_build_object('ok',false,'error',failure_message,'sqlstate',failure_code);
  end;

  -- Query only the random IDs created in this run; no real member is inspected.
  if exists(select 1 from auth.users where id in (google_id,kakao_id,legacy_id,email_id))
     or exists(select 1 from auth.identities where user_id in (google_id,kakao_id,legacy_id,email_id))
     or exists(select 1 from public.profiles where auth_user_id in (google_id,kakao_id,legacy_id,email_id))
     or exists(select 1 from public.growell_oauth_vaults where auth_user_id in (google_id,kakao_id,legacy_id,email_id)) then
    result:=jsonb_build_object('ok',false,'error','Synthetic row rollback verification failed');
  else
    result:=result||jsonb_build_object('synthetic_rows_remaining',0);
  end if;
  perform set_config('growell.oauth_verification_result',result::text,true);
end;
$verify$;

select current_setting('growell.oauth_verification_result')::jsonb as oauth_verification;
rollback;
