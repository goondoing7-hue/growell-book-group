-- ROLLBACK ONLY. Omit worksheet-locks.sql's COMMIT and append this file.
-- Needs member-approval.sql. Uses only temporary synthetic responses/profiles.
-- The emotion lock is transactionally replaced for the test and then restored.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid(); member_auth uuid:=gen_random_uuid();
  other_auth uuid:=gen_random_uuid(); pending_auth uuid:=gen_random_uuid();
  admin_id text:='qa_wslock_'||replace(admin_auth::text,'-','');
  member_id text:='qa_wslock_'||replace(member_auth::text,'-','');
  other_id text:='qa_wslock_'||replace(other_auth::text,'-','');
  pending_id text:='qa_wslock_'||replace(pending_auth::text,'-','');
  n bigint; blocked boolean; result jsonb;
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(admin_auth),(member_auth),(other_auth),(pending_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,avatar_url) values
    (admin_id,admin_auth,admin_id,'잠금 임시 관리자',repeat('a',32),true,'https://example.invalid/admin.jpg'),
    (member_id,member_auth,member_id,'잠금 임시 회원',repeat('b',32),false,'https://example.invalid/member.jpg'),
    (other_id,other_auth,other_id,'잠금 임시 다른 회원',repeat('c',32),false,'https://example.invalid/other.jpg'),
    (pending_id,pending_auth,pending_id,'잠금 임시 승인 대기',repeat('d',32),false,'https://example.invalid/pending.jpg');
  -- Honor the existing administrator-field trigger while preparing only these
  -- random synthetic members. All access checks below use authenticated claims.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved',is_admin=(id=admin_id) where id=any(array[admin_id,member_id,other_id]);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.profiles where id=admin_id and is_admin=true and approval_status='approved') then
    raise exception 'FAIL synthetic administrator setup';
  end if;
  delete from public.growell_worksheet_locks where book_id='emotion';
  insert into public.book_locks(book_id,locked,note) values('emotion',false,'Rollback-only worksheet fixture')
    on conflict(book_id) do update set locked=excluded.locked,note=excluded.note;
  insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at) values
    ('w_'||member_id,'emotion','qa-lock',member_id,'{"synthetic":true}',1),
    ('w_'||other_id,'emotion','qa-lock',other_id,'{"synthetic":true}',1);
  if has_table_privilege('authenticated','public.growell_worksheet_locks','SELECT')
      or has_table_privilege('authenticated','public.growell_worksheet_locks','UPDATE') then
    raise exception 'FAIL direct lock table grant';
  end if;
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if current_user<>'authenticated' or not row_security_active('public.worksheets') then raise exception 'FAIL API role/RLS'; end if;
  if public.growell_can_access_worksheet('emotion') then raise exception 'FAIL default unlocked'; end if;
  result:=public.growell_get_worksheet_locks();
  if jsonb_array_length(result)<>4 or result->0<>jsonb_build_object('book_id','emotion','locked',true,'revision',0) then raise exception 'FAIL default locks'; end if;
  select count(*) into n from public.worksheets where id=any(array['w_'||member_id,'w_'||other_id]);
  if n<>0 then raise exception 'FAIL member locked read'; end if;
  blocked:=false;
  begin perform public.growell_set_worksheet_lock('emotion',false,0); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL member unlock'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_can_access_worksheet('emotion') then raise exception 'FAIL admin locked access'; end if;
  select count(*) into n from public.worksheets where id=any(array['w_'||member_id,'w_'||other_id]);
  if n<>2 then raise exception 'FAIL admin worksheet read'; end if;
  result:=public.growell_set_worksheet_lock('emotion',false,0);
  if result<>jsonb_build_object('book_id','emotion','locked',false,'revision',1) then raise exception 'FAIL admin unlock'; end if;
  blocked:=false;
  begin perform public.growell_set_worksheet_lock('emotion',true,0); exception when serialization_failure then blocked:=true; end;
  if not blocked then raise exception 'FAIL stale lock overwrite'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_can_access_worksheet('emotion') then raise exception 'FAIL unlocked member access'; end if;
  select count(*) into n from public.worksheets where id=any(array['w_'||member_id,'w_'||other_id]);
  if n<>2 then raise exception 'FAIL unlocked member shared worksheets'; end if;
  update public.worksheets set data='{"changed":true}' where id='w_'||member_id;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'FAIL unlocked own update'; end if;
  update public.worksheets set data='{"must_not_change":true}' where id='w_'||other_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL cross-member worksheet update'; end if;
  insert into public.worksheets(id,book_id,activity_key,user_id,data,created_at)
    values('new_'||member_id,'emotion','qa-new',member_id,'{}',1);
  execute 'reset role';

  update public.book_locks set locked=true where book_id='emotion';
  execute 'set local role authenticated';
  if public.growell_can_access_worksheet('emotion') then raise exception 'FAIL worksheet bypassed book lock'; end if;
  select count(*) into n from public.worksheets where id='w_'||member_id;
  if n<>0 then raise exception 'FAIL closed-book worksheet visible'; end if;
  execute 'reset role';
  update public.book_locks set locked=false where book_id='emotion';

  perform set_config('request.jwt.claim.sub',pending_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pending_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if public.growell_can_access_worksheet('emotion') then raise exception 'FAIL pending unlocked access'; end if;
  blocked:=false;
  begin perform public.growell_get_worksheet_locks(); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL pending lock metadata'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  result:=public.growell_set_worksheet_lock('emotion',true,1);
  if result->>'locked'<>'true' or result->>'revision'<>'2' then raise exception 'FAIL admin relock'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  update public.worksheets set data='{"after_lock":true}' where id='w_'||member_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL relocked write'; end if;
  select count(*) into n from public.worksheets where id='w_'||member_id;
  if n<>0 then raise exception 'FAIL relocked read'; end if;
  execute 'reset role';
  select count(*) into n from public.worksheets where id='w_'||member_id and data::jsonb='{"changed":true}'::jsonb;
  if n<>1 then raise exception 'FAIL relock destroyed response'; end if;
  perform set_config('growell.worksheet_lock_verification','{"ok":true,"locked_by_default":true,"admin_can_toggle":true,"stale_update_denied":true,"unlocked_approved_member_access":true,"owner_writes_preserved":true,"pending_denied":true,"relock_blocks_read_write":true,"responses_preserved":true}',true);
end
$verify$;
select current_setting('growell.worksheet_lock_verification')::jsonb as verification;
rollback;
