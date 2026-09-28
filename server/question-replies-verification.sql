-- ROLLBACK ONLY. Append to question-replies.sql with its COMMIT omitted.
-- Requires approval migration first. Uses random temporary Auth/profile/reply
-- rows. A question and book lock are changed only inside this rolled-back test.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid(); member_auth uuid:=gen_random_uuid();
  pending_auth uuid:=gen_random_uuid(); outsider_auth uuid:=gen_random_uuid();
  admin_id text:='qa_reply_'||replace(admin_auth::text,'-','');
  member_id text:='qa_reply_'||replace(member_auth::text,'-','');
  pending_id text:='qa_reply_'||replace(pending_auth::text,'-','');
  reply_id uuid:=gen_random_uuid(); other_reply uuid:=gen_random_uuid();
  absent_book text:='qa_absent_'||replace(gen_random_uuid()::text,'-','');
  result jsonb; retry jsonb; thread jsonb; blocked boolean; subject uuid; n bigint;
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(admin_auth),(member_auth),(pending_auth),(outsider_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted,avatar_url,approval_status) values
    (admin_id,admin_auth,admin_id,'답변 검증 관리자',repeat('a',32),true,false,'https://example.com/qa-avatar.png','approved'),
    (member_id,member_auth,member_id,'답변 검증 회원',repeat('b',32),false,false,'https://example.com/qa-avatar.png','approved'),
    (pending_id,pending_auth,pending_id,'답변 검증 승인 대기',repeat('c',32),false,false,'https://example.com/qa-avatar.png','pending');
  -- A registration trigger may force a new profile to pending; these are only
  -- this transaction's synthetic members, approved explicitly by database owner.
  -- The existing administrator-field trigger also requires the service claim;
  -- restore empty claims immediately after preparing these random fixtures.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved' where id in(admin_id,member_id);
  update public.profiles set is_admin=true where id=admin_id;
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.profiles where id=admin_id and is_admin=true and approval_status='approved') then
    raise exception 'FAIL synthetic administrator setup';
  end if;
  delete from public.growell_book_questions where book_id='emotion';
  insert into public.book_locks(book_id,locked,note) values('emotion',false,'') on conflict(book_id) do update set locked=false;
  if has_table_privilege('authenticated','public.growell_question_replies','SELECT')
    or has_table_privilege('authenticated','public.growell_question_replies','INSERT')
    or has_table_privilege('anon','public.growell_question_replies','SELECT')
    or has_function_privilege('anon','public.growell_get_question_replies(text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.growell_question_thread(text)','EXECUTE') then
    raise exception 'FAIL direct table/helper access';
  end if;
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  -- A missing lock row defaults closed for every non-emotion book. Do not
  -- remove or alter a real thought-book lock merely to create this fixture.
  -- Exercise the actual thought branch whenever it is absent; a random absent
  -- key also exercises the same fallback before question validation in all DBs.
  blocked:=false;
  begin perform public.growell_get_question_replies(absent_book);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL absent book lock defaults open';end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(other_reply,absent_book,0,'없는 잠금 확인');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL absent book lock permits reply';end if;
  if not exists(select 1 from public.book_locks where book_id='thought') then
    blocked:=false;
    begin perform public.growell_get_question_replies('thought');exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL absent thought lock permits reading';end if;
    blocked:=false;
    begin perform public.growell_add_question_reply(other_reply,'thought',0,'생각 책은 아직 잠김');exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL absent thought lock permits reply';end if;
  end if;
  thread:=public.growell_get_question_replies('emotion');
  if thread->>'revision'<>'0' then raise exception 'FAIL default question';end if;
  result:=public.growell_add_question_reply(reply_id,'emotion',0,'  검증 답변  ');
  retry:=public.growell_add_question_reply(reply_id,'emotion',0,'검증 답변');
  if result<>retry or result->>'user_id'<>member_id or result->>'body'<>'검증 답변' then raise exception 'FAIL idempotency/ownership';end if;
  thread:=public.growell_get_question_replies('emotion');
  select count(*) into n from jsonb_array_elements(thread->'replies') r where r->>'id'=reply_id::text;
  if n<>1 then raise exception 'FAIL reply duplicate';end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(reply_id,'emotion',0,'덮어쓰기');exception when unique_violation then blocked:=true;end;
  if not blocked then raise exception 'FAIL retry overwrite';end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(other_reply,'emotion',0,repeat('가',2001));exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL length limit';end if;
  blocked:=false;
  begin perform public.growell_save_book_question('emotion','회원 변경',0);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL member edits question';end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.growell_save_book_question('emotion','새 검증 질문',0);
  blocked:=false;
  begin perform public.growell_add_question_reply(reply_id,'emotion',0,'검증 답변');exception when unique_violation then blocked:=true;end;
  if not blocked then raise exception 'FAIL another identity retries owner reply';end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_add_question_reply(other_reply,'emotion',0,'오래된 질문 답변');exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale question answer';end if;
  retry:=public.growell_add_question_reply(reply_id,'emotion',0,'검증 답변');
  if retry<>result then raise exception 'FAIL retry after question changed';end if;
  thread:=public.growell_get_question_replies('emotion');
  if exists(select 1 from jsonb_array_elements(thread->'replies') r where r->>'id'=reply_id::text) then raise exception 'FAIL answers mixed across questions';end if;
  execute 'reset role';
  if not exists(select 1 from public.growell_question_replies where id=reply_id and question_revision=0 and body='검증 답변') then raise exception 'FAIL previous answer lost';end if;
  update public.book_locks set locked=true where book_id='emotion';
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_get_question_replies('emotion');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL locked book exposed';end if;
  execute 'reset role';
  foreach subject in array array[pending_auth,outsider_auth] loop
    perform set_config('request.jwt.claim.sub',subject::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',subject,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    blocked:=false;
    begin perform public.growell_get_question_replies('emotion');exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL nonapproved read';end if;
    blocked:=false;
    begin perform public.growell_add_question_reply(other_reply,'emotion',1,'승인 안 된 답변');exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL nonapproved write';end if;
    blocked:=false;
    begin perform public.growell_get_book_questions();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL old question RPC exposes data';end if;
    execute 'reset role';
  end loop;
  perform set_config('growell.question_reply_verification','{"ok":true,"approved_reply":true,"retry_idempotent":true,"question_revisions_isolated":true,"old_answers_preserved":true,"pending_nonmember_blocked":true,"locked_book_blocked":true,"absent_lock_defaults_closed":true}',true);
end
$verify$;
select current_setting('growell.question_reply_verification')::jsonb as verification;
rollback;
