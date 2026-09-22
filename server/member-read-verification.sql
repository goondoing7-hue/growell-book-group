-- ROLLBACK-ONLY. Remove the final COMMIT from member-read-policy.sql, keep
-- its BEGIN, append this file, and run the entire batch as database owner.
-- Real member records are never selected or changed. Queries are restricted
-- to random fixture IDs. EXPLAIN uses WHERE false and never executes a scan.
-- SET LOCAL ROLE is actually applied and checked before each API-role test.
-- Success and failure both roll back all fixture rows in a subtransaction;
-- the final ROLLBACK removes the provisional policies/helper as well.
-- If the editor interrupts the batch, explicitly ROLLBACK. Never COMMIT it.

do $verify$
declare
  owner_role text := current_user;
  first_auth uuid := gen_random_uuid();
  second_auth uuid := gen_random_uuid();
  incomplete_auth uuid := gen_random_uuid();
  deleted_auth uuid := gen_random_uuid();
  admin_auth uuid := gen_random_uuid();
  first_id text := 'u_rls_'||replace(first_auth::text,'-','');
  second_id text := 'u_rls_'||replace(second_auth::text,'-','');
  incomplete_id text := 'u_rls_'||replace(incomplete_auth::text,'-','');
  deleted_id text := 'u_rls_'||replace(deleted_auth::text,'-','');
  admin_id text := 'u_rls_'||replace(admin_auth::text,'-','');
  fixture_book text := 'qa_rls_'||replace(gen_random_uuid()::text,'-','');
  all_profiles text[] := array[first_id,second_id,incomplete_id,deleted_id,admin_id];
  ordinary_profiles text[] := array[first_id,second_id];
  target_tables text[] := array['profiles','posts','comments','material_notes','worksheets','reading_meta','reading_logs','book_locks','announcement'];
  owner_tables text[] := array['private_entries','habits','reading_meta','reading_logs'];
  test_auth uuid;
  expected_profile text;
  table_name text;
  visible_count bigint;
  updated_count bigint;
  current_policies jsonb;
  current_acls jsonb;
  plan json;
  result jsonb;
  failure_message text;
  failure_code text;
  rejected boolean;
begin
  begin
    -- The migration only adds/replaces its own restrictive policies.
    select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname),'[]'::jsonb) into current_policies
    from pg_policies p where p.schemaname='public' and p.policyname not in ('growell_require_auth_for_select','growell_require_safe_profile_insert')
      and p.tablename=any(target_tables||array['private_entries','habits']);
    if current_policies is distinct from current_setting('growell.member_policy_baseline')::jsonb then
      raise exception 'FAIL existing SELECT/write/admin policies changed';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'acl',c.relacl::text) order by c.relname),'[]'::jsonb) into current_acls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=any(target_tables||array['private_entries','habits']);
    if current_acls is distinct from current_setting('growell.member_acl_baseline')::jsonb then
      raise exception 'FAIL existing table privileges changed';
    end if;
    if (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=any(target_tables)
      and p.policyname='growell_require_auth_for_select' and p.permissive='RESTRICTIVE' and p.cmd='SELECT'
      and p.roles @> array['anon','authenticated']::name[])<>9 then
      raise exception 'FAIL expected nine restrictive SELECT policies';
    end if;
    if not exists(select 1 from pg_policies p where p.schemaname='public' and p.tablename='profiles'
      and p.policyname='growell_require_safe_profile_insert' and p.permissive='RESTRICTIVE' and p.cmd='INSERT'
      and p.roles @> array['anon','authenticated']::name[]) then
      raise exception 'FAIL restrictive profile INSERT guard missing';
    end if;

    insert into auth.users(id) values(first_auth),(second_auth),(incomplete_auth),(deleted_auth),(admin_auth);
    insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_deleted,is_admin) values
      (first_id,first_auth,'qa_'||first_id,'회원 정책 검증 1',repeat('a',32),false,false),
      (second_id,second_auth,'qa_'||second_id,'회원 정책 검증 2',repeat('b',32),false,false),
      (deleted_id,deleted_auth,'qa_'||deleted_id,'탈퇴 정책 검증',repeat('c',32),true,false),
      (admin_id,admin_auth,'qa_'||admin_id,'임시 관리자 정책 검증',repeat('d',32),false,true);
    insert into public.posts(id,book_id,user_id,html,created_at) values
      ('p_'||first_id,fixture_book,first_id,'<p>Synthetic first shared note</p>',1),
      ('p_'||second_id,fixture_book,second_id,'<p>Synthetic second shared note</p>',1);
    insert into public.private_entries(id,book_id,user_id,iv,data,created_at) values
      ('e_'||first_id,fixture_book,first_id,'synthetic-iv','synthetic-ciphertext',1),
      ('e_'||second_id,fixture_book,second_id,'synthetic-iv','synthetic-ciphertext',1);
    insert into public.habits(id,book_id,user_id,created_at) values
      ('h_'||first_id,fixture_book,first_id,1),('h_'||second_id,fixture_book,second_id,1);
    insert into public.reading_meta(book_id,user_id,updated_at) values
      (fixture_book,first_id,1),(fixture_book,second_id,1);
    insert into public.reading_logs(id,book_id,user_id,seconds,page,created_at) values
      ('rl_'||first_id,fixture_book,first_id,30,1,1),('rl_'||second_id,fixture_book,second_id,60,2,1);

    -- 1. Anonymous API role: helper false and synthetic shared/private rows hidden.
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claim.role','anon',true);
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    execute 'set local role anon';
    if current_user<>'anon' or exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
      raise exception 'FAIL anonymous test is not using the real API role';
    end if;
    if public.growell_is_active_member() is distinct from false then raise exception 'FAIL guest membership helper'; end if;
    foreach table_name in array target_tables||array['private_entries','habits'] loop
      if not row_security_active(format('public.%I',table_name)::regclass) then
        raise exception 'FAIL RLS not active for anonymous role on %',table_name;
      end if;
      -- No table contents are read by this permission/policy compilation check.
      begin
        execute format('explain (format json) select 1 from public.%I where false',table_name) into plan;
      exception when insufficient_privilege then null; -- No table privilege also denies access.
      end;
    end loop;
    begin
      select count(*) into visible_count from public.profiles where id=any(all_profiles);
      if visible_count<>0 then raise exception 'FAIL guest can read profiles'; end if;
    exception when insufficient_privilege then null;
    end;
    foreach table_name in array array['posts','private_entries','habits','reading_meta','reading_logs'] loop
      begin
        execute format('select count(*) from public.%I where user_id=any($1) and book_id=$2',table_name)
          into visible_count using ordinary_profiles,fixture_book;
        if visible_count<>0 then raise exception 'FAIL guest can read %',table_name; end if;
      exception when insufficient_privilege then null;
      end;
    end loop;
    execute format('set local role %I',owner_role);

    -- 2. Auth identity without a profile: SELECT succeeds with no shared rows;
    -- own-profile boot returns no row so OAuth registration can proceed.
    perform set_config('request.jwt.claim.sub',incomplete_auth::text,true);
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',incomplete_auth::text,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    if current_user<>'authenticated' or exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
      raise exception 'FAIL incomplete-member test is not using the real API role';
    end if;
    if public.growell_is_active_member() is distinct from false then raise exception 'FAIL incomplete member accepted'; end if;
    select count(*) into visible_count from public.profiles where auth_user_id=incomplete_auth;
    if visible_count<>0 then raise exception 'FAIL incomplete own-profile lookup'; end if;
    select count(*) into visible_count from public.profiles where id=any(all_profiles);
    if visible_count<>0 then raise exception 'FAIL incomplete member can read other profiles'; end if;
    foreach table_name in array array['posts','private_entries','habits','reading_meta','reading_logs'] loop
      execute format('select count(*) from public.%I where user_id=any($1) and book_id=$2',table_name)
        into visible_count using ordinary_profiles,fixture_book;
      if visible_count<>0 then raise exception 'FAIL incomplete member can read %',table_name; end if;
    end loop;

    -- Direct PostgREST-style INSERT cannot bypass the social RPC to self-promote.
    rejected:=false;
    begin
      insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted)
      values(incomplete_id,incomplete_auth,'qa_'||incomplete_id,'금지된 관리자 등록',repeat('e',32),true,false);
    exception when insufficient_privilege then rejected:=true;
    end;
    if not rejected then raise exception 'FAIL client self-promoted to admin on INSERT'; end if;
    rejected:=false;
    begin
      insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted)
      values(incomplete_id,incomplete_auth,'qa_'||incomplete_id,'금지된 상태 등록',repeat('e',32),false,true);
    exception when insufficient_privilege then rejected:=true;
    end;
    if not rejected then raise exception 'FAIL client supplied deleted flag on INSERT'; end if;
    select count(*) into visible_count from public.profiles where auth_user_id=incomplete_auth;
    if visible_count<>0 then raise exception 'FAIL rejected client INSERT left a profile'; end if;
    -- The new restrictive policy must not block ordinary own-profile signup.
    insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted)
    values(incomplete_id,incomplete_auth,'qa_'||incomplete_id,'정상 일반회원 등록',repeat('e',32),false,false);
    select count(*) into visible_count from public.profiles where auth_user_id=incomplete_auth and not is_admin and not is_deleted;
    if visible_count<>1 or public.growell_is_active_member() is distinct from true
       or public.is_current_user_admin() is distinct from false then
      raise exception 'FAIL ordinary own-profile INSERT or membership transition';
    end if;
    execute format('set local role %I',owner_role);

    -- 3. Both real member roles see shared posts, but only their own private
    -- entries/habits/progress/sessions. Existing INVOKER helpers must not recurse.
    foreach test_auth in array array[first_auth,second_auth] loop
      expected_profile:=case when test_auth=first_auth then first_id else second_id end;
      perform set_config('request.jwt.claim.sub',test_auth::text,true);
      perform set_config('request.jwt.claim.role','authenticated',true);
      perform set_config('request.jwt.claims',jsonb_build_object('sub',test_auth::text,'role','authenticated')::text,true);
      execute 'set local role authenticated';
      if current_user<>'authenticated' then raise exception 'FAIL member API role'; end if;
      if public.growell_is_active_member() is distinct from true or public.current_profile_id() is distinct from expected_profile
         or public.is_current_user_admin() is distinct from false then raise exception 'FAIL member/helper lookup'; end if;
      foreach table_name in array target_tables||array['private_entries','habits'] loop
        if not row_security_active(format('public.%I',table_name)::regclass) then
          raise exception 'FAIL RLS not active for member on %',table_name;
        end if;
        execute format('explain (format json) select 1 from public.%I where false',table_name) into plan;
      end loop;
      select count(*) into visible_count from public.profiles where auth_user_id=test_auth;
      if visible_count<>1 then raise exception 'FAIL own-profile boot blocked'; end if;
      select count(*) into visible_count from public.profiles where id=any(ordinary_profiles);
      if visible_count<>2 then raise exception 'FAIL shared member identities unavailable'; end if;
      select count(*) into visible_count from public.posts where user_id=any(ordinary_profiles) and book_id=fixture_book;
      if visible_count<>2 then raise exception 'FAIL member shared posts unavailable'; end if;
      foreach table_name in array owner_tables loop
        execute format('select count(*) from public.%I where user_id=any($1) and book_id=$2',table_name)
          into visible_count using ordinary_profiles,fixture_book;
        if visible_count<>1 then raise exception 'FAIL owner isolation on %',table_name; end if;
        execute format('select count(*) from public.%I where user_id=$1 and book_id=$2',table_name)
          into visible_count using expected_profile,fixture_book;
        if visible_count<>1 then raise exception 'FAIL own row unavailable on %',table_name; end if;
      end loop;
      update public.posts set html='<p>Synthetic owner edit</p>' where id='p_'||expected_profile;
      get diagnostics updated_count=row_count;
      if updated_count<>1 then raise exception 'FAIL existing own-post update blocked'; end if;
      update public.posts set html='<p>Must not write</p>' where id='p_'||case when test_auth=first_auth then second_id else first_id end;
      get diagnostics updated_count=row_count;
      if updated_count<>0 then raise exception 'FAIL member updated another member post'; end if;
      execute format('set local role %I',owner_role);
    end loop;

    -- 4. A deleted profile remains readable only to its own Auth identity for
    -- the app's account-state check; it cannot read shared posts/other profiles.
    perform set_config('request.jwt.claim.sub',deleted_auth::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',deleted_auth::text,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    if current_user<>'authenticated' or public.growell_is_active_member() is distinct from false then raise exception 'FAIL deleted membership'; end if;
    select count(*) into visible_count from public.profiles where id=any(all_profiles);
    if visible_count<>1 then raise exception 'FAIL deleted own-profile-only lookup'; end if;
    select count(*) into visible_count from public.posts where user_id=any(ordinary_profiles) and book_id=fixture_book;
    if visible_count<>0 then raise exception 'FAIL deleted member can read shared posts'; end if;
    execute format('set local role %I',owner_role);

    -- 5. A synthetic admin retains its existing helper and shared read access.
    perform set_config('request.jwt.claim.sub',admin_auth::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth::text,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    if current_user<>'authenticated' or public.growell_is_active_member() is distinct from true
       or public.is_current_user_admin() is distinct from true then raise exception 'FAIL existing admin helper'; end if;
    select count(*) into visible_count from public.profiles where id=any(all_profiles);
    if visible_count<>5 then raise exception 'FAIL admin shared profile access'; end if;
    select count(*) into visible_count from public.posts where user_id=any(ordinary_profiles) and book_id=fixture_book;
    if visible_count<>2 then raise exception 'FAIL admin shared posts unavailable'; end if;
    execute format('set local role %I',owner_role);

    raise exception 'GROWELL_MEMBER_VERIFICATION_SUCCESS_ROLLBACK' using errcode='GW003';
  exception
    when sqlstate 'GW003' then result:=jsonb_build_object('ok',true,'checks','real anon/authenticated roles, active RLS, guest/incomplete/deleted shared denial, own-profile boot, admin/deleted INSERT denial, ordinary INSERT allowed, member shared reads, private/habit/reading isolation, own-post edits, cross-post write denial, admin helper, existing policy/grant preservation');
    when others then
      get stacked diagnostics failure_message=message_text,failure_code=returned_sqlstate;
      result:=jsonb_build_object('ok',false,'error',failure_message,'sqlstate',failure_code);
  end;

  if current_user is distinct from owner_role then raise exception 'Verification role rollback failed'; end if;
  if exists(select 1 from auth.users where id=any(array[first_auth,second_auth,incomplete_auth,deleted_auth,admin_auth]))
     or exists(select 1 from public.profiles where id=any(all_profiles)) then
    result:=jsonb_build_object('ok',false,'error','Synthetic Auth/profile rollback failed');
  end if;
  foreach table_name in array array['posts','private_entries','habits','reading_meta','reading_logs'] loop
    execute format('select count(*) from public.%I where user_id=any($1) and book_id=$2',table_name)
      into visible_count using ordinary_profiles,fixture_book;
    if visible_count<>0 then result:=jsonb_build_object('ok',false,'error','Synthetic row rollback failed on '||table_name); end if;
  end loop;
  if result->>'ok'='true' then result:=result||jsonb_build_object('synthetic_rows_remaining',0); end if;
  perform set_config('growell.member_verification_result',result::text,true);
end;
$verify$;

select current_setting('growell.member_verification_result')::jsonb as member_verification;
rollback;
