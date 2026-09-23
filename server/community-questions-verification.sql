-- ROLLBACK ONLY. Remove the migration's final COMMIT, then append this file and
-- execute the entire batch as the database owner. No real member content is read.
-- Fixtures use random Auth/profile IDs. Existing questions are only replaced
-- transactionally for this test, and are restored by the unconditional ROLLBACK.
do $verify$
declare
  admin_id uuid:=pg_catalog.gen_random_uuid();
  member_id uuid:=pg_catalog.gen_random_uuid();
  deleted_id uuid:=pg_catalog.gen_random_uuid();
  incomplete_id uuid:=pg_catalog.gen_random_uuid();
  result jsonb;
  blocked boolean;
  subject uuid;
begin
  insert into auth.users(id) values(admin_id),(member_id),(deleted_id),(incomplete_id);
  insert into public.profiles(auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted) values
    (admin_id,'qa_question_'||replace(admin_id::text,'-',''),'질문 검증 관리자',repeat('a',32),true,false),
    (member_id,'qa_question_'||replace(member_id::text,'-',''),'질문 검증 회원',repeat('b',32),false,false),
    (deleted_id,'qa_question_'||replace(deleted_id::text,'-',''),'질문 검증 탈퇴',repeat('c',32),true,true);
  -- Exactly this transaction's question fixtures, never actual member posts.
  delete from public.growell_book_questions;
  if has_table_privilege('authenticated','public.growell_book_questions','SELECT')
     or has_table_privilege('authenticated','public.growell_book_questions','INSERT')
     or has_table_privilege('authenticated','public.growell_book_questions','UPDATE')
     or has_table_privilege('authenticated','public.growell_book_questions','DELETE')
     or has_table_privilege('anon','public.growell_book_questions','SELECT') then
    raise exception 'FAIL direct question table grant';
  end if;
  if has_function_privilege('anon','public.growell_get_book_questions()','EXECUTE')
     or has_function_privilege('anon','public.growell_save_book_question(text,text,bigint)','EXECUTE') then
    raise exception 'FAIL anon RPC grant';
  end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.growell_save_book_question('emotion','  롤백 검증 질문  ',0);
  if result<>jsonb_build_object('book_id','emotion','question','롤백 검증 질문','revision',1) then raise exception 'FAIL admin create';end if;
  result:=public.growell_save_book_question('emotion','수정한 검증 질문',1);
  if result->>'revision'<>'2' then raise exception 'FAIL revision increment';end if;
  blocked:=false;
  begin perform public.growell_save_book_question('emotion','오래된 편집',1);exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale overwrite allowed';end if;
  blocked:=false;
  begin perform public.growell_save_book_question('unknown','잘못된 책',0);exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL unknown book allowed';end if;
  blocked:=false;
  begin perform public.growell_save_book_question('thought',repeat('가',241),0);exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL long question allowed';end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',member_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.growell_get_book_questions();
  if jsonb_array_length(result)<>1 or result->0->>'question'<>'수정한 검증 질문' then raise exception 'FAIL member read';end if;
  blocked:=false;
  begin perform public.growell_save_book_question('emotion','일반회원 쓰기',2);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL ordinary member write';end if;
  execute 'reset role';
  foreach subject in array array[deleted_id,incomplete_id] loop
    perform set_config('request.jwt.claim.sub',subject::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',subject,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    blocked:=false;
    begin perform public.growell_get_book_questions();exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL nonmember read';end if;
    blocked:=false;
    begin perform public.growell_save_book_question('emotion','권한 없는 쓰기',2);exception when insufficient_privilege then blocked:=true;end;
    if not blocked then raise exception 'FAIL nonmember write';end if;
    execute 'reset role';
  end loop;
  perform set_config('growell.question_verification','{"ok":true,"admin_save":true,"member_read":true,"nonadmin_write_blocked":true,"nonmember_read_blocked":true,"conflict_blocked":true}',true);
end
$verify$;
select current_setting('growell.question_verification')::jsonb as verification;
rollback;
