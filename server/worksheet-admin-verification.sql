-- ROLLBACK ONLY: append to the migration after omitting its COMMIT.
-- Uses random synthetic Auth/profile/worksheet rows; no real member content is read.
-- Every fixture and the provisional policy are removed by the final ROLLBACK.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid();
  member_auth uuid:=gen_random_uuid();
  deleted_auth uuid:=gen_random_uuid();
  admin_id text:='qa_ws_'||replace(admin_auth::text,'-','');
  member_id text:='qa_ws_'||replace(member_auth::text,'-','');
  deleted_id text:='qa_ws_'||replace(deleted_auth::text,'-','');
  fixture_book text:='qa_ws_'||replace(gen_random_uuid()::text,'-','');
  n bigint;
  blocked boolean;
begin
  insert into auth.users(id) values(admin_auth),(member_auth),(deleted_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted) values
    (admin_id,admin_auth,admin_id,'활동지 임시 관리자',repeat('a',32),true,false),
    (member_id,member_auth,member_id,'활동지 임시 회원',repeat('b',32),false,false),
    (deleted_id,deleted_auth,deleted_id,'활동지 탈퇴 관리자',repeat('c',32),true,true);
  insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at) values
    ('w_'||admin_id,fixture_book,'test',admin_id,'{"synthetic":true}',1),
    ('w_'||member_id,fixture_book,'test',member_id,'{"synthetic":true}',1);

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if current_user<>'authenticated' or not row_security_active('public.worksheets') then raise exception 'FAIL API role/RLS';end if;
  select count(*) into n from public.worksheets where book_id=fixture_book;
  if n<>0 then raise exception 'FAIL ordinary member read';end if;
  update public.worksheets set data='{"changed":true}' where id='w_'||member_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL ordinary member update';end if;
  blocked:=false;
  begin
    insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at)
      values('blocked_'||member_id,fixture_book,'test',member_id,'{}',1);
  exception when insufficient_privilege then blocked:=true;
  end;
  if not blocked then raise exception 'FAIL ordinary member insert';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.worksheets where book_id=fixture_book;
  if n<>2 then raise exception 'FAIL administrator read';end if;
  insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at)
    values('new_'||admin_id,fixture_book,'test-new',admin_id,'{}',1);
  update public.worksheets set data='{"changed":true}' where id='w_'||admin_id;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'FAIL administrator own update';end if;
  update public.worksheets set data='{"changed":true}' where id='w_'||member_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL existing ownership policy changed';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',deleted_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',deleted_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.worksheets where book_id=fixture_book;
  if n<>0 then raise exception 'FAIL deleted administrator read';end if;
  blocked:=false;
  begin
    insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at)
      values('blocked_'||deleted_id,fixture_book,'test',deleted_id,'{}',1);
  exception when insufficient_privilege then blocked:=true;
  end;
  if not blocked then raise exception 'FAIL deleted administrator insert';end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','anon',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  execute 'set local role anon';
  begin
    select count(*) into n from public.worksheets where book_id=fixture_book;
    if n<>0 then raise exception 'FAIL guest read';end if;
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  perform set_config('growell.worksheet_verification','{"ok":true,"member_read_write_blocked":true,"admin_read_own_write":true,"ownership_preserved":true,"guest_deleted_admin_blocked":true}',true);
end
$verify$;
select current_setting('growell.worksheet_verification')::jsonb as verification;
rollback;
