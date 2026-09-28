-- ROLLBACK ONLY. Remove signup-optional-photo.sql's COMMIT and append this file.
-- Requires the existing approval and notification migrations. Only random
-- synthetic Auth/profile/hint/notification/post rows are read or written.
-- No notification worker is called; uncommitted notices are removed by ROLLBACK.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid(); member_auth uuid:=gen_random_uuid();
  applicant_auth uuid:=gen_random_uuid(); rejected_auth uuid:=gen_random_uuid();
  direct_auth uuid:=gen_random_uuid();
  admin_id text:='qa_optional_'||replace(admin_auth::text,'-','');
  member_id text:='qa_optional_'||replace(member_auth::text,'-','');
  applicant_id text:='qa_optional_'||replace(applicant_auth::text,'-','');
  rejected_id text:='qa_optional_'||replace(rejected_auth::text,'-','');
  direct_id text:='qa_optional_'||replace(direct_auth::text,'-','');
  fixture_book text:='qa_optional_'||replace(gen_random_uuid()::text,'-','');
  fixture_hint text:='{"version":1,"questionId":"fixture-question","answer":"fixture-answer"}';
  changed_question text:='{"version":1,"questionId":"different-question","answer":"fixture-answer"}';
  blocked boolean; n bigint; result jsonb; approval_result jsonb; policies jsonb;
  hint_stamp bigint; notice_snapshot jsonb; profile_snapshot jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname),'[]'::jsonb) into policies
    from pg_policies p where p.schemaname in ('public','storage')
      and not (p.schemaname='public' and p.tablename='profiles'
        and p.policyname in ('growell_require_photo_for_profile_insert','growell_require_pending_profile_insert'));
  if policies is distinct from current_setting('growell.optional_photo_policy_baseline')::jsonb then
    raise exception 'FAIL unrelated RLS policies changed';
  end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='growell_require_photo_for_profile_insert')
      or not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
        and policyname='growell_require_pending_profile_insert' and permissive='RESTRICTIVE' and cmd='INSERT') then
    raise exception 'FAIL optional photo policy replacement';
  end if;
  if has_function_privilege('anon','public.growell_finalize_signup(text,uuid,text)','execute')
      or has_function_privilege('authenticated','public.growell_finalize_signup(text,uuid,text)','execute')
      or has_function_privilege('anon','public.growell_review_member(text,text)','execute') then
    raise exception 'FAIL privileged RPC grants broadened';
  end if;

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(admin_auth),(member_auth),(applicant_auth),(rejected_auth),(direct_auth);
  -- All fixtures omit photos. Caller-supplied privileged flags are overridden.
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,approval_status) values
    (admin_id,admin_auth,admin_id,'임시 관리자',repeat('a',32),true,'approved'),
    (member_id,member_auth,member_id,'임시 회원',repeat('b',32),false,'approved'),
    (applicant_id,applicant_auth,applicant_id,'사진 없는 가입 신청',repeat('c',32),true,'approved'),
    (rejected_id,rejected_auth,rejected_id,'사진 없는 거절 신청',repeat('d',32),false,'approved');
  if exists(select 1 from public.profiles where id=any(array[admin_id,member_id,applicant_id,rejected_id])
      and (avatar_url is not null or approval_status<>'pending' or is_admin or approved_at is not null or approved_by is not null)) then
    raise exception 'FAIL photo-less signup bypassed pending ordinary defaults';
  end if;
  -- Respect the existing protect_is_admin trigger for synthetic admin setup.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved',is_admin=(id=admin_id)
    where id=any(array[admin_id,member_id]);
  blocked:=false;
  begin update public.profiles set is_admin=true where id=applicant_id;
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL service role promoted pending applicant'; end if;
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into public.posts(id,book_id,user_id,html,created_at)
    values('p_'||member_id,fixture_book,member_id,'<p>Synthetic approved post</p>',1);
  select to_jsonb(p) into profile_snapshot from public.profiles p where id=applicant_id;

  -- Photo absence must not remove required hint checks or the identity binding.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  execute 'set local role service_role';
  blocked:=false;
  begin perform public.growell_finalize_signup(applicant_id,applicant_auth,' ');
    exception when invalid_parameter_value then blocked:=true; end;
  if not blocked then raise exception 'FAIL missing hint accepted'; end if;
  blocked:=false;
  begin perform public.growell_finalize_signup(applicant_id,member_auth,fixture_hint);
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL mismatched signup identity accepted'; end if;
  result:=public.growell_finalize_signup(applicant_id,applicant_auth,fixture_hint);
  if result<>jsonb_build_object('hintSaved',true,'notificationQueued',true) then
    raise exception 'FAIL photo-less signup finalization';
  end if;
  execute 'reset role';
  select updated_at into hint_stamp from public.profile_secrets where user_id=applicant_id;
  select to_jsonb(notice_row) into notice_snapshot from public.growell_signup_notifications notice_row where notice_row.profile_id=applicant_id;
  if (select pw_hint from public.profile_secrets where user_id=applicant_id) is distinct from fixture_hint
      or notice_snapshot->>'status'<>'pending' or (notice_snapshot->>'available_at')::timestamptz<=now() then
    raise exception 'FAIL hint or delayed notification contract';
  end if;
  execute 'set local role service_role';
  perform public.growell_finalize_signup(applicant_id,applicant_auth,fixture_hint);
  blocked:=false;
  begin perform public.growell_finalize_signup(applicant_id,applicant_auth,changed_question);
    exception when serialization_failure then blocked:=true; end;
  if not blocked then raise exception 'FAIL different question changed stored hint'; end if;
  execute 'reset role';
  if (select updated_at from public.profile_secrets where user_id=applicant_id) is distinct from hint_stamp
      or (select to_jsonb(notice_row) from public.growell_signup_notifications notice_row where notice_row.profile_id=applicant_id) is distinct from notice_snapshot
      or (select to_jsonb(p) from public.profiles p where id=applicant_id) is distinct from profile_snapshot then
    raise exception 'FAIL signup retry changed existing profile/hint/notice';
  end if;

  perform set_config('request.jwt.claim.sub',applicant_auth::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',applicant_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if current_user<>'authenticated' or not row_security_active('public.profiles') then raise exception 'FAIL API role/RLS'; end if;
  if public.growell_is_active_member() or public.growell_is_approved_admin() then raise exception 'FAIL pending membership access'; end if;
  select count(*) into n from public.profiles where id=any(array[applicant_id,admin_id,member_id]);
  if n<>1 then raise exception 'FAIL pending own-status-only access'; end if;
  select count(*) into n from public.posts where book_id=fixture_book;
  if n<>0 then raise exception 'FAIL pending member data read'; end if;
  update public.profiles set approval_status='approved' where id=applicant_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL pending self approval'; end if;
  blocked:=false;
  begin perform public.growell_review_member(applicant_id,'approved');
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL pending approval RPC'; end if;
  blocked:=false;
  begin perform public.growell_finalize_signup(applicant_id,applicant_auth,fixture_hint);
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL client finalizer access'; end if;
  execute 'reset role';

  -- Ordinary authenticated direct INSERT can omit a photo, but never approval.
  perform set_config('request.jwt.claim.sub',direct_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',direct_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,approval_status)
    values(direct_id,direct_auth,direct_id,'임시 직접 가입',repeat('e',32),false,'approved');
  if not exists(select 1 from public.profiles where id=direct_id and avatar_url is null and approval_status='pending' and is_admin=false) then
    raise exception 'FAIL optional direct insert or pending guard';
  end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_review_member(applicant_id,'approved');
    exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL ordinary member review'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  approval_result:=public.growell_review_member(applicant_id,'approved');
  if approval_result->>'approval_status'<>'approved' or approval_result->>'approved_by'<>admin_id
      or approval_result->>'approved_at' is null then raise exception 'FAIL administrator photo-less approval'; end if;
  if public.growell_review_member(applicant_id,'approved') is distinct from approval_result then raise exception 'FAIL approval retry'; end if;
  result:=public.growell_review_member(rejected_id,'rejected');
  if result->>'approval_status'<>'rejected' then raise exception 'FAIL rejection'; end if;
  blocked:=false;
  begin perform public.growell_review_member(rejected_id,'approved');
    exception when serialization_failure then blocked:=true; end;
  if not blocked then raise exception 'FAIL stale rejection override'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',applicant_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',applicant_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_is_active_member() or public.growell_is_approved_admin() then raise exception 'FAIL approved ordinary membership'; end if;
  if not exists(select 1 from public.profiles where id=applicant_id and avatar_url is null) then raise exception 'FAIL approval invented photo'; end if;
  select count(*) into n from public.posts where book_id=fixture_book;
  if n<>1 then raise exception 'FAIL approved data access'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',rejected_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',rejected_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if public.growell_is_active_member() then raise exception 'FAIL rejected membership'; end if;
  execute 'reset role';
  perform set_config('growell.optional_photo_verification','{"ok":true,"optional_photo_signup_and_approval":true,"hint_required":true,"hint_identity_binding":true,"hint_question_answer_preserved":true,"notice_retry_preserved":true,"pending_access_denied":true,"pending_admin_escalation_denied":true,"admin_only_review":true,"unrelated_policies_preserved":true}',true);
end
$verify$;
select current_setting('growell.optional_photo_verification')::jsonb as verification;
rollback;
