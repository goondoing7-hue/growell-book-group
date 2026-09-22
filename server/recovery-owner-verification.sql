-- ROLLBACK-ONLY. Combine recovery-owner.sql with its final COMMIT removed,
-- followed by this file; keep the original BEGIN. Run the WHOLE batch as owner.
-- No real member is read or changed. All fixture identifiers are random.
-- The inner subtransaction rolls back fixture rows on success AND failure;
-- the final ROLLBACK also removes provisional function/privilege changes.
-- If the editor stops or interrupts the outer batch, issue ROLLBACK explicitly.
-- Never COMMIT a verification batch.

do $verify$
declare
  first_auth uuid := pg_catalog.gen_random_uuid();
  second_auth uuid := pg_catalog.gen_random_uuid();
  deleted_auth uuid := pg_catalog.gen_random_uuid();
  first_id text := 'u_recovery_' || replace(first_auth::text,'-','');
  second_id text := 'u_recovery_' || replace(second_auth::text,'-','');
  deleted_id text := 'u_recovery_' || replace(deleted_auth::text,'-','');
  first_login text := 'qa_recovery_' || replace(first_auth::text,'-','');
  second_login text := 'qa_recovery_' || replace(second_auth::text,'-','');
  deleted_login text := 'qa_recovery_' || replace(deleted_auth::text,'-','');
  function_id oid := 'public.growell_recovery_owner_matches(text,text,text)'::regprocedure;
  result jsonb;
  failure_message text;
  failure_code text;
begin
  begin
    insert into auth.users(id) values(first_auth),(second_auth),(deleted_auth);
    insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_deleted) values
      (first_id,first_auth,first_login,'복구 롤백 검증 1',repeat('a',32),false),
      (second_id,second_auth,second_login,'복구 롤백 검증 2',repeat('b',32),false),
      (deleted_id,deleted_auth,deleted_login,'탈퇴 롤백 검증',repeat('c',32),true);

    -- A guest must be able to verify a complete recovery-file identity without
    -- selecting profiles. The function returns only a Boolean.
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claim.role','anon',true);
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    if public.growell_recovery_owner_matches(first_login,first_id,first_auth::text) is distinct from true then
      raise exception 'FAIL guest exact active owner match';
    end if;
    if public.growell_recovery_owner_matches(second_login,second_id,second_auth::text) is distinct from true then
      raise exception 'FAIL second independent owner match';
    end if;

    -- Never join accounts using a login/name match or mixed identifiers.
    if public.growell_recovery_owner_matches(first_login,second_id,first_auth::text)
       or public.growell_recovery_owner_matches(first_login,first_id,second_auth::text)
       or public.growell_recovery_owner_matches(second_login,first_id,first_auth::text)
       or public.growell_recovery_owner_matches(upper(first_login),first_id,first_auth::text)
       or public.growell_recovery_owner_matches(first_login||' ',first_id,first_auth::text) then
      raise exception 'FAIL mismatched or implicitly normalized identifiers accepted';
    end if;
    if public.growell_recovery_owner_matches(deleted_login,deleted_id,deleted_auth::text) is distinct from false then
      raise exception 'FAIL deleted member accepted';
    end if;

    -- Invalid values yield false instead of casts/errors or partial lookups.
    if public.growell_recovery_owner_matches(null,first_id,first_auth::text) is distinct from false
       or public.growell_recovery_owner_matches(first_login,null,first_auth::text) is distinct from false
       or public.growell_recovery_owner_matches(first_login,first_id,null) is distinct from false
       or public.growell_recovery_owner_matches('',first_id,first_auth::text) is distinct from false
       or public.growell_recovery_owner_matches(first_login,'',first_auth::text) is distinct from false
       or public.growell_recovery_owner_matches(first_login,first_id,'not-a-uuid') is distinct from false
       or public.growell_recovery_owner_matches(repeat('x',201),first_id,first_auth::text) is distinct from false
       or public.growell_recovery_owner_matches(first_login,repeat('x',201),first_auth::text) is distinct from false then
      raise exception 'FAIL invalid identifier handling';
    end if;

    -- Role/definition checks are independent of the owner-run test calls.
    if not has_function_privilege('anon',function_id,'EXECUTE')
       or not has_function_privilege('authenticated',function_id,'EXECUTE') then
      raise exception 'FAIL recovery RPC API role execute privileges';
    end if;
    if exists(select 1 from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=function_id and acl.grantee=0 and acl.privilege_type='EXECUTE') then
      raise exception 'FAIL PUBLIC has recovery RPC execute privilege';
    end if;
    if not exists(select 1 from pg_proc p where p.oid=function_id and p.prosecdef
      and p.prorettype='boolean'::regtype and p.provolatile='s'
      and exists(select 1 from unnest(p.proconfig) c where c in ('search_path=""','search_path='))) then
      raise exception 'FAIL recovery RPC bounded definition or empty search_path';
    end if;

    -- Force every fixture write to roll back even when every assertion passed.
    raise exception 'GROWELL_RECOVERY_VERIFICATION_SUCCESS_ROLLBACK' using errcode='GW002';
  exception
    when sqlstate 'GW002' then
      result:=jsonb_build_object('ok',true,'checks','exact guest owner match, identifier isolation, deleted/invalid denial, Boolean-only definer, empty search_path, explicit API privileges');
    when others then
      get stacked diagnostics failure_message=message_text,failure_code=returned_sqlstate;
      result:=jsonb_build_object('ok',false,'error',failure_message,'sqlstate',failure_code);
  end;

  if exists(select 1 from auth.users where id in (first_auth,second_auth,deleted_auth))
     or exists(select 1 from public.profiles where auth_user_id in (first_auth,second_auth,deleted_auth)) then
    result:=jsonb_build_object('ok',false,'error','Synthetic recovery fixture rollback failed');
  else
    result:=result||jsonb_build_object('synthetic_rows_remaining',0);
  end if;
  perform set_config('growell.recovery_verification_result',result::text,true);
end;
$verify$;

select current_setting('growell.recovery_verification_result')::jsonb as recovery_verification;
rollback;
