-- ROLLBACK ONLY. Remove meeting-records.sql's final COMMIT, then append this.
-- Creates random synthetic Auth/profile/material/meeting fixtures only. Book
-- lock changes below exist solely in this transaction and are rolled back.
do $verify$
declare
  owner_auth uuid:=gen_random_uuid();other_auth uuid:=gen_random_uuid();member_auth uuid:=gen_random_uuid();pending_auth uuid:=gen_random_uuid();
  owner_id text:='qa_meeting_'||replace(owner_auth::text,'-','');
  other_id text:='qa_meeting_'||replace(other_auth::text,'-','');
  member_id text:='qa_meeting_'||replace(member_auth::text,'-','');
  pending_id text:='qa_meeting_'||replace(pending_auth::text,'-','');
  source_id text:='qa_material_'||replace(owner_auth::text,'-','');
  meeting_id uuid:=gen_random_uuid();draft_id uuid:=gen_random_uuid();meeting_round integer:=9999;
  document jsonb;draft jsonb;saved jsonb;result jsonb;original_created text;blocked boolean;n bigint;
begin
  perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(owner_auth),(other_auth),(member_auth),(pending_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,avatar_url) values
    (owner_id,owner_auth,owner_id,'회의록 임시 관리자',repeat('a',32),false,null),
    (other_id,other_auth,other_id,'회의록 임시 다른 관리자',repeat('b',32),false,null),
    (member_id,member_auth,member_id,'회의록 임시 회원',repeat('c',32),false,null),
    (pending_id,pending_auth,pending_id,'회의록 임시 승인 대기',repeat('d',32),false,null);
  -- Honor production's administrator protection trigger for synthetic setup.
  perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved',is_admin=(id in (owner_id,other_id)) where id in (owner_id,other_id,member_id);
  perform set_config('request.jwt.claim.role','',true);perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.profiles where id=owner_id and is_admin and approval_status='approved') then
    raise exception 'FAIL synthetic administrator setup';end if;
  while exists(select 1 from public.growell_meeting_records where book_id='emotion' and round in (meeting_round,meeting_round-1) and deleted_at is null) loop
    meeting_round:=meeting_round-2;if meeting_round<2 then raise exception 'No unused fixture rounds';end if;
  end loop;
  insert into public.material_notes(id,book_id,user_id,note_type,title,html,created_at)
    values(source_id,'emotion',owner_id,'note','Rollback-only source','Synthetic source preserved',1);
  insert into public.book_locks(book_id,locked,note) values('emotion',false,'Rollback-only meeting fixture')
    on conflict(book_id) do update set locked=false;
  document:=jsonb_build_object('id',meeting_id,'bookId','emotion','round',meeting_round,'date','2026-10-11','topic','임시 회의록',
    'sections',jsonb_build_array(jsonb_build_object('id','section-1','summary','임시 요약','detail','임시 상세 내용')),
    'concepts',jsonb_build_array(jsonb_build_object('id','concept-1','word','임시 단어','meaning','임시 뜻')),
    'materialIds',jsonb_build_array(source_id),'status','draft','userId',owner_id);
  draft:=document||jsonb_build_object('id',draft_id,'round',meeting_round-1,'date',null,'topic','','sections','[]'::jsonb,'concepts','[]'::jsonb,'materialIds','[]'::jsonb);
  if has_table_privilege('authenticated','public.growell_meeting_records','SELECT')
      or has_table_privilege('authenticated','public.growell_meeting_records','INSERT')
      or has_table_privilege('authenticated','public.growell_meeting_records','UPDATE')
      or has_table_privilege('authenticated','public.growell_meeting_records','DELETE')
      or has_function_privilege('anon','public.growell_get_meeting_records(text)','EXECUTE')
      or has_function_privilege('anon','public.growell_save_meeting_record(jsonb,bigint)','EXECUTE') then
    raise exception 'FAIL direct or anonymous grant';end if;
  perform set_config('request.jwt.claim.sub',owner_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if current_user<>'authenticated' then raise exception 'FAIL API role';end if;
  saved:=public.growell_save_meeting_record(document,0);original_created:=saved->>'createdAt';
  if saved->>'revision'<>'1' or saved->>'userId'<>owner_id then raise exception 'FAIL initial save';end if;
  if public.growell_save_meeting_record(document,0)<>saved then raise exception 'FAIL idempotent initial retry';end if;
  perform public.growell_save_meeting_record(draft,0);
  result:=public.growell_get_meeting_records('emotion');
  select count(*) into n from jsonb_array_elements(result) r where r->>'id' in (meeting_id::text,draft_id::text);
  if n<>2 then raise exception 'FAIL own drafts';end if;
  blocked:=false;begin perform public.growell_save_meeting_record(draft||'{"status":"published"}',1);exception when invalid_parameter_value then blocked:=true;end;
  if not blocked then raise exception 'FAIL incomplete publish';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',other_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.growell_get_meeting_records('emotion');
  if exists(select 1 from jsonb_array_elements(result) r where r->>'id' in (meeting_id::text,draft_id::text)) then raise exception 'FAIL other admin draft exposure';end if;
  blocked:=false;begin perform public.growell_save_meeting_record(document||jsonb_build_object('userId',other_id),1);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL cross-admin overwrite';end if;
  blocked:=false;begin perform public.growell_delete_meeting_record(meeting_id,1);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL cross-admin deletion';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',owner_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  document:=document||'{"status":"published"}';saved:=public.growell_save_meeting_record(document,1);
  if saved->>'revision'<>'2' or saved->>'createdAt'<>original_created then raise exception 'FAIL publication or creation timestamp';end if;
  if public.growell_save_meeting_record(document,1)<>saved then raise exception 'FAIL idempotent edit retry';end if;
  blocked:=false;begin perform public.growell_save_meeting_record(document||'{"topic":"stale overwrite"}',1);exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL stale overwrite';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.growell_get_meeting_records('emotion');
  if not exists(select 1 from jsonb_array_elements(result) r where r->>'id'=meeting_id::text)
      or exists(select 1 from jsonb_array_elements(result) r where r->>'id'=draft_id::text) then raise exception 'FAIL member publication visibility';end if;
  blocked:=false;begin perform public.growell_save_meeting_record(document,2);exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL member write';end if;
  execute 'reset role';
  update public.book_locks set locked=true where book_id='emotion';
  execute 'set local role authenticated';
  blocked:=false;begin perform public.growell_get_meeting_records('emotion');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL book lock bypass';end if;
  execute 'reset role';
  update public.book_locks set locked=false where book_id='emotion';

  perform set_config('request.jwt.claim.sub',pending_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pending_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  blocked:=false;begin perform public.growell_get_meeting_records('emotion');exception when insufficient_privilege then blocked:=true;end;
  if not blocked then raise exception 'FAIL pending read';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',owner_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  saved:=public.growell_delete_meeting_record(meeting_id,2);
  if saved->>'deleted'<>'true' or saved->>'revision'<>'3' or public.growell_delete_meeting_record(meeting_id,2)<>saved then raise exception 'FAIL delete retry';end if;
  blocked:=false;begin perform public.growell_save_meeting_record(document,3);exception when serialization_failure then blocked:=true;end;
  if not blocked then raise exception 'FAIL deleted record restored';end if;
  result:=public.growell_get_meeting_records('emotion');
  if exists(select 1 from jsonb_array_elements(result) r where r->>'id'=meeting_id::text) then raise exception 'FAIL tombstone exposure';end if;
  execute 'reset role';
  if not exists(select 1 from public.material_notes where id=source_id and html='Synthetic source preserved') then raise exception 'FAIL source altered';end if;
  perform set_config('growell.meeting_record_verification','{"ok":true,"owner_drafts_private":true,"approved_member_published_only":true,"admin_owner_writes":true,"revision_and_retry":true,"book_lock_enforced":true,"pending_denied":true,"tombstones":true,"source_preserved":true}',true);
end
$verify$;
select current_setting('growell.meeting_record_verification')::jsonb as verification;
rollback;
