-- ROLLBACK ONLY. Omit question-reply-editing.sql's COMMIT and append this file.
-- Uses random synthetic Auth/profile/reply rows. Temporary book lock/question
-- changes and every fixture are undone by the final ROLLBACK.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid(); member_auth uuid:=gen_random_uuid();
  other_auth uuid:=gen_random_uuid(); pending_auth uuid:=gen_random_uuid(); outsider_auth uuid:=gen_random_uuid();
  admin_id text:='qa_replyedit_'||replace(admin_auth::text,'-','');
  member_id text:='qa_replyedit_'||replace(member_auth::text,'-','');
  other_id text:='qa_replyedit_'||replace(other_auth::text,'-','');
  pending_id text:='qa_replyedit_'||replace(pending_auth::text,'-','');
  reply_id uuid:=gen_random_uuid(); older_id uuid:=gen_random_uuid(); spare_id uuid:=gen_random_uuid();
  result jsonb; retry jsonb; original jsonb; immutable jsonb; thread jsonb; legacy jsonb; after_legacy jsonb;
  question_revision bigint; blocked boolean; subject uuid; invalid_body text; fn text;
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  -- Retain a hash-only snapshot so verification can assert existing replies
  -- were never changed without returning real member names or reply contents.
  select coalesce(jsonb_object_agg(r.id::text,md5(to_jsonb(r)::text)),'{}'::jsonb) into legacy from public.growell_question_replies r;
  insert into auth.users(id) values(admin_auth),(member_auth),(other_auth),(pending_auth),(outsider_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted,avatar_url) values
    (admin_id,admin_auth,admin_id,'답변 수정 검증 관리자',repeat('a',32),true,false,'https://example.invalid/qa-admin.jpg'),
    (member_id,member_auth,member_id,'답변 수정 검증 회원',repeat('b',32),false,false,'https://example.invalid/qa-member.jpg'),
    (other_id,other_auth,other_id,'답변 수정 검증 다른 회원',repeat('c',32),false,false,'https://example.invalid/qa-other.jpg'),
    (pending_id,pending_auth,pending_id,'답변 수정 검증 승인 대기',repeat('d',32),false,false,'https://example.invalid/qa-pending.jpg');
  -- Honor the existing administrator-field trigger for synthetic fixtures only.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved',is_admin=(id=admin_id) where id in(admin_id,member_id,other_id);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.profiles where id=admin_id and is_admin=true and approval_status='approved') then
    raise exception 'FAIL synthetic administrator setup';
  end if;
  insert into public.book_locks(book_id,locked,note) values('emotion',false,'Rollback-only reply-edit fixture')
    on conflict(book_id) do update set locked=false;
  thread:=public.growell_question_thread('emotion');
  question_revision:=(thread->>'revision')::bigint;

  foreach fn in array array[
    'public.growell_get_question_replies(text,uuid)',
    'public.growell_add_question_reply(uuid,text,bigint,text)',
    'public.growell_update_question_reply(uuid,bigint,text)',
    'public.growell_delete_question_reply(uuid,bigint)'
  ] loop
    if has_function_privilege('anon',fn,'EXECUTE') or not has_function_privilege('authenticated',fn,'EXECUTE') then
      raise exception 'FAIL function ACL: %',fn;
    end if;
    if not exists(select 1 from pg_catalog.pg_proc where oid=fn::regprocedure and prosecdef=true
      and 'search_path=""'=any(proconfig)) then raise exception 'FAIL function security/search path: %',fn;end if;
  end loop;
  if has_table_privilege('authenticated','public.growell_question_replies','SELECT')
    or has_table_privilege('authenticated','public.growell_question_replies','INSERT')
    or has_table_privilege('authenticated','public.growell_question_replies','UPDATE')
    or has_table_privilege('authenticated','public.growell_question_replies','DELETE')
    or has_table_privilege('anon','public.growell_question_replies','SELECT') then
    raise exception 'FAIL direct table access';
  end if;

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  original:=public.growell_add_question_reply(reply_id,'emotion',question_revision,'  처음 답변  ');
  retry:=public.growell_add_question_reply(reply_id,'emotion',question_revision,'처음 답변');
  if original<>retry or original->>'reply_revision'<>'0' or original->>'updated_at' is not null then
    raise exception 'FAIL add identity/defaults/retry';
  end if;
  perform public.growell_add_question_reply(older_id,'emotion',question_revision,'먼저 쓴 답변');
  execute 'reset role';
  -- Synthetic-only ordering makes the second answer reachable after the cursor.
  update public.growell_question_replies set created_at=(select created_at-interval '1 microsecond' from public.growell_question_replies where id=reply_id) where id=older_id;
  select jsonb_build_object('id',r.id,'book_id',r.book_id,'question_revision',r.question_revision,
    'question_text',r.question_text,'user_id',r.user_id,'created_at',r.created_at) into immutable
    from public.growell_question_replies r where id=reply_id;
  execute 'set local role authenticated';

  result:=public.growell_update_question_reply(reply_id,0,'  수정한 답변  ');
  if result->>'reply_revision'<>'1' or result->>'body'<>'수정한 답변' or result->>'updated_at' is null
      or result->>'created_at'<>original->>'created_at' or result->>'id'<>reply_id::text then
    raise exception 'FAIL owner update/version/timestamps';
  end if;
  retry:=public.growell_update_question_reply(reply_id,0,'수정한 답변');
  if retry<>result then raise exception 'FAIL uncertain update retry';end if;
  retry:=public.growell_update_question_reply(reply_id,1,'수정한 답변');
  if retry<>result then raise exception 'FAIL unchanged update writes a new revision';end if;
  foreach invalid_body in array array[null::text,'   ',repeat('가',2001)] loop
    blocked:=false;
    begin perform public.growell_update_question_reply(reply_id,1,invalid_body);exception when invalid_parameter_value then blocked:=true;end;
    if not blocked then raise exception 'FAIL invalid body accepted';end if;
  end loop;
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,0,'오래된 수정');exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale edit overwrites';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(reply_id,0);exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale delete removes';end if;
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,-1,'잘못된 버전');exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL negative revision accepted';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(reply_id,null);exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL null revision accepted';end if;
  execute 'reset role';

  -- Neither other members nor administrators can edit/delete this author's text.
  foreach subject in array array[other_auth,admin_auth,pending_auth,outsider_auth] loop
    perform set_config('request.jwt.claim.sub',subject::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',subject,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    blocked:=false;
    begin perform public.growell_update_question_reply(reply_id,1,'다른 사람의 수정');exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL foreign/nonapproved edit';end if;
    blocked:=false;
    begin perform public.growell_delete_question_reply(reply_id,1);exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL foreign/nonapproved delete';end if;
    execute 'reset role';
  end loop;

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  update public.book_locks set locked=true where book_id='emotion';
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,1,'잠긴 책 수정');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL book lock permits edit';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(reply_id,1);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL book lock permits delete';end if;
  execute 'reset role';
  update public.book_locks set locked=false where book_id='emotion';
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  update public.profiles set approval_status='rejected' where id=member_id;
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,1,'승인 철회 후 수정');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL revoked owner edit';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(reply_id,1);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL revoked owner delete';end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  update public.profiles set approval_status='approved',is_deleted=true where id=member_id;
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,1,'탈퇴 후 수정');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL deleted owner edit';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(reply_id,1);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL deleted owner delete';end if;
  execute 'reset role';
  update public.profiles set is_deleted=false where id=member_id;
  execute 'set local role authenticated';
  -- Once a different later edit exists, an old matching-body request conflicts.
  result:=public.growell_update_question_reply(reply_id,1,'다음 답변');
  result:=public.growell_update_question_reply(reply_id,2,'수정한 답변');
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,0,'수정한 답변');exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL old matching body accepted after later edits';end if;
  result:=public.growell_delete_question_reply(reply_id,3);
  retry:=public.growell_delete_question_reply(reply_id,3);
  if result<>retry or result->>'reply_revision'<>'4' or result->>'deleted'<>'true' or result ? 'body' then
    raise exception 'FAIL delete acknowledgement/idempotency';
  end if;
  thread:=public.growell_get_question_replies('emotion');
  if exists(select 1 from jsonb_array_elements(thread->'replies') r where r->>'id'=reply_id::text) then
    raise exception 'FAIL deleted reply remains listed';
  end if;
  thread:=public.growell_get_question_replies('emotion',reply_id);
  if not exists(select 1 from jsonb_array_elements(thread->'replies') r where r->>'id'=older_id::text and r->>'reply_revision'='0') then
    raise exception 'FAIL deleted cursor loses following page';
  end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(reply_id,'emotion',question_revision,'수정한 답변');exception when unique_violation then blocked:=true;end;
  if not blocked then raise exception 'FAIL delayed add resurrects deleted reply';end if;
  blocked:=false;
  begin perform public.growell_update_question_reply(reply_id,4,'살아난 답변');exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL update resurrects deleted reply';end if;
  execute 'reset role';
  if immutable is distinct from (select jsonb_build_object('id',r.id,'book_id',r.book_id,'question_revision',r.question_revision,
    'question_text',r.question_text,'user_id',r.user_id,'created_at',r.created_at)
    from public.growell_question_replies r where id=reply_id) then
    raise exception 'FAIL immutable reply identity or creation fields changed';
  end if;
  if not exists(select 1 from public.growell_question_replies where id=reply_id and deleted_at is not null and updated_at is not null and reply_revision=4) then
    raise exception 'FAIL tombstone not retained';
  end if;

  -- The original question revision boundary and retry behavior remain intact.
  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  perform public.growell_save_book_question('emotion','답변 수정 검증의 새 질문',question_revision);
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  retry:=public.growell_add_question_reply(older_id,'emotion',question_revision,'먼저 쓴 답변');
  if retry->>'id'<>older_id::text then raise exception 'FAIL original add retry after question changes';end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(spare_id,'emotion',question_revision,'옛 질문에 새 답변');exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale question accepted';end if;
  thread:=public.growell_get_question_replies('emotion');
  if exists(select 1 from jsonb_array_elements(thread->'replies') r where r->>'id'=older_id::text) then
    raise exception 'FAIL question revisions mixed';
  end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  execute 'set local role anon';
  blocked:=false;
  begin perform public.growell_get_question_replies('emotion');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL anonymous get';end if;
  blocked:=false;
  begin perform public.growell_add_question_reply(spare_id,'emotion',question_revision,'익명 답변');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL anonymous add';end if;
  blocked:=false;
  begin perform public.growell_update_question_reply(older_id,0,'익명 수정');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL anonymous edit';end if;
  blocked:=false;
  begin perform public.growell_delete_question_reply(older_id,0);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL anonymous delete';end if;
  execute 'reset role';
  perform set_config('request.jwt.claims','{}',true);
  select coalesce(jsonb_object_agg(r.id::text,md5(to_jsonb(r)::text)),'{}'::jsonb) into after_legacy
    from public.growell_question_replies r where r.user_id not in(admin_id,member_id,other_id,pending_id);
  if legacy<>after_legacy then raise exception 'FAIL existing member replies changed';end if;
  perform set_config('growell.question_reply_editing_verification',
    '{"ok":true,"owner_edit_delete":true,"admin_foreign_blocked":true,"revoked_deleted_pending_blocked":true,"book_lock_enforced":true,"optimistic_conflicts":true,"uncertain_retries_idempotent":true,"deleted_cursor_retained":true,"no_resurrection":true,"identity_timestamps_preserved":true,"question_revisions_isolated":true,"anonymous_blocked":true,"existing_replies_unchanged":true}',true);
end
$verify$;
select current_setting('growell.question_reply_editing_verification')::jsonb as verification;
rollback;
