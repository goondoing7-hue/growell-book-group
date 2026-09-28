-- ROLLBACK ONLY. Omit member-approval.sql's COMMIT and append this file.
-- Only random fixture IDs are selected/changed; no real member content is read.
-- The outer ROLLBACK removes all fixtures and the provisional migration.
do $verify$
declare
  admin_auth uuid:=gen_random_uuid(); member_auth uuid:=gen_random_uuid();
  pending_auth uuid:=gen_random_uuid(); rejected_auth uuid:=gen_random_uuid();
  deleted_auth uuid:=gen_random_uuid(); photo_auth uuid:=gen_random_uuid();
  admin_id text:='qa_approval_'||replace(admin_auth::text,'-','');
  member_id text:='qa_approval_'||replace(member_auth::text,'-','');
  pending_id text:='qa_approval_'||replace(pending_auth::text,'-','');
  rejected_id text:='qa_approval_'||replace(rejected_auth::text,'-','');
  deleted_id text:='qa_approval_'||replace(deleted_auth::text,'-','');
  photo_id text:='qa_approval_'||replace(photo_auth::text,'-','');
  fixture_book text:='qa_approval_'||replace(gen_random_uuid()::text,'-','');
  table_name text; n bigint; blocked boolean; result jsonb; subject uuid;
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into auth.users(id) values(admin_auth),(member_auth),(pending_auth),(rejected_auth),(deleted_auth),(photo_auth);
  insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,is_admin,is_deleted,avatar_url,approval_status) values
    (admin_id,admin_auth,admin_id,'임시 승인 관리자',repeat('a',32),true,false,'https://example.invalid/admin.jpg','approved'),
    (member_id,member_auth,member_id,'임시 승인 회원',repeat('b',32),false,false,'https://example.invalid/member.jpg','approved'),
    (pending_id,pending_auth,pending_id,'임시 승인 대기',repeat('c',32),false,false,'https://example.invalid/pending.jpg','approved'),
    (rejected_id,rejected_auth,rejected_id,'임시 가입 거절',repeat('d',32),false,false,'https://example.invalid/rejected.jpg','approved'),
    (deleted_id,deleted_auth,deleted_id,'임시 탈퇴 관리자',repeat('e',32),true,true,'https://example.invalid/deleted.jpg','approved');
  if exists(select 1 from public.profiles where id=any(array[admin_id,member_id,pending_id,rejected_id,deleted_id]) and (approval_status<>'pending' or is_admin)) then
    raise exception 'FAIL new registration bypassed pending';
  end if;
  -- Maintenance-only setup of synthetic existing/approved members.
  -- The existing administrator-field trigger permits changes only for the
  -- service-role claim. Scope it to these random fixtures; no trigger is disabled.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.profiles set approval_status='approved',is_admin=(id=any(array[admin_id,deleted_id])) where id=any(array[admin_id,member_id,deleted_id]);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.profiles where id=admin_id and is_admin=true and approval_status='approved') then
    raise exception 'FAIL synthetic administrator setup';
  end if;
  blocked:=false;
  begin update public.profiles set is_admin=true where id=pending_id; exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL legacy service-role grant promoted pending account'; end if;
  blocked:=false;
  begin
    insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt,avatar_url)
      values(photo_id,photo_auth,photo_id,'사진 없는 가입',repeat('f',32),' ');
  exception when invalid_parameter_value then blocked:=true;
  end;
  if not blocked then raise exception 'FAIL service signup without photo allowed'; end if;
  insert into public.posts(id,book_id,user_id,html,created_at)
    values('p_'||member_id,fixture_book,member_id,'<p>Synthetic approved note</p>',1);
  insert into public.habits(id,book_id,user_id,created_at)
    values('h_'||pending_id,fixture_book,pending_id,1);
  insert into public.private_entries(id,book_id,user_id,iv,data,created_at)
    values('e_'||pending_id,fixture_book,pending_id,'fixture-iv','fixture-ciphertext',1);
  insert into auth.identities(provider_id,user_id,identity_data,provider)
    values(member_auth::text,member_auth,jsonb_build_object('sub',member_auth::text),'google');
  insert into public.growell_oauth_vaults(auth_user_id,profile_id,envelope)
    values(member_auth,member_id,'{"synthetic":"unchanged-vault"}');

  perform set_config('request.jwt.claim.sub',pending_auth::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pending_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if current_user<>'authenticated' or not row_security_active('public.profiles') then raise exception 'FAIL API role/RLS'; end if;
  if public.growell_is_active_member() or public.growell_is_approved_admin() then raise exception 'FAIL pending membership'; end if;
  select count(*) into n from public.profiles where id=any(array[admin_id,member_id,pending_id]);
  if n<>1 then raise exception 'FAIL pending own-profile-only access'; end if;
  foreach table_name in array array['posts','habits','private_entries','reading_meta','reading_logs'] loop
    execute format('select count(*) from public.%I where book_id=$1',table_name) into n using fixture_book;
    if n<>0 then raise exception 'FAIL pending can read %',table_name; end if;
  end loop;
  blocked:=false;
  begin
    insert into public.posts(id,book_id,user_id,html,created_at)
      values('blocked_'||pending_id,fixture_book,pending_id,'<p>Must not save</p>',1);
  exception when insufficient_privilege then blocked:=true;
  end;
  if not blocked then raise exception 'FAIL pending can write'; end if;
  update public.profiles set approval_status='approved' where id=pending_id;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL pending self approval'; end if;
  blocked:=false;
  begin perform public.growell_review_member(pending_id,'approved'); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL pending approval RPC'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',member_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_is_active_member() or public.growell_is_approved_admin() then raise exception 'FAIL approved membership'; end if;
  result:=public.growell_oauth_profile();
  if result->>'status'<>'ready' or result#>>'{profile,approval_status}'<>'approved'
      or result#>>'{profile,id}'<>member_id or result->'envelope'<>'{"synthetic":"unchanged-vault"}'::jsonb then
    raise exception 'FAIL existing approved OAuth profile/vault compatibility';
  end if;
  select count(*) into n from public.posts where book_id=fixture_book;
  if n<>1 then raise exception 'FAIL approved shared read'; end if;
  update public.posts set html='<p>Own approved update</p>' where id='p_'||member_id;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'FAIL approved owner write'; end if;
  blocked:=false;
  begin update public.profiles set approved_at=now() where id=member_id; exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL member approval metadata tamper'; end if;
  blocked:=false;
  begin perform public.growell_review_member(pending_id,'approved'); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL ordinary member approval RPC'; end if;
  execute 'reset role';

  -- Recheck the persisted photo, even if a trusted signup/upload is interrupted.
  update public.profiles set avatar_url=null where id=pending_id;
  perform set_config('request.jwt.claim.sub',admin_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_is_approved_admin() then raise exception 'FAIL administrator membership'; end if;
  select count(*) into n from public.profiles where id=any(array[admin_id,member_id,pending_id,rejected_id]);
  if n<>4 then raise exception 'FAIL admin pending member list'; end if;
  blocked:=false;
  begin perform public.growell_review_member(pending_id,'approved'); exception when invalid_parameter_value then blocked:=true; end;
  if not blocked then raise exception 'FAIL approval without photo'; end if;
  execute 'reset role';
  update public.profiles set avatar_url='https://example.invalid/pending.jpg' where id=pending_id;
  execute 'set local role authenticated';
  result:=public.growell_review_member(pending_id,'approved');
  if result->>'approval_status'<>'approved' or result->>'approved_by'<>admin_id or result->>'approved_at' is null then raise exception 'FAIL admin approval'; end if;
  if public.growell_review_member(pending_id,'approved')<>result then raise exception 'FAIL approval retry'; end if;
  result:=public.growell_review_member(rejected_id,'rejected');
  if result->>'approval_status'<>'rejected' then raise exception 'FAIL admin reject'; end if;
  blocked:=false;
  begin perform public.growell_review_member(rejected_id,'approved'); exception when serialization_failure then blocked:=true; end;
  if not blocked then raise exception 'FAIL stale approval after rejection'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',pending_auth::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pending_auth,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not public.growell_is_active_member() then raise exception 'FAIL approval not effective'; end if;
  select count(*) into n from public.private_entries where id='e_'||pending_id;
  if n<>1 then raise exception 'FAIL own private history unavailable after approval'; end if;
  execute 'reset role';

  foreach subject in array array[rejected_auth,deleted_auth] loop
    perform set_config('request.jwt.claim.sub',subject::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',subject,'role','authenticated')::text,true);
    execute 'set local role authenticated';
    if public.growell_is_active_member() or public.growell_is_approved_admin() then raise exception 'FAIL rejected/deleted membership'; end if;
    select count(*) into n from public.posts where book_id=fixture_book;
    if n<>0 then raise exception 'FAIL rejected/deleted shared read'; end if;
    blocked:=false;
    begin perform public.growell_review_member(rejected_id,'approved'); exception when insufficient_privilege then blocked:=true; end;
    if not blocked then raise exception 'FAIL rejected/deleted review'; end if;
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  execute 'set local role anon';
  if public.growell_is_active_member() then raise exception 'FAIL guest membership'; end if;
  blocked:=false;
  begin perform public.growell_review_member(pending_id,'approved'); exception when insufficient_privilege then blocked:=true; end;
  if not blocked then raise exception 'FAIL anonymous review'; end if;
  execute 'reset role';
  perform set_config('growell.approval_verification','{"ok":true,"new_signup_pending":true,"photo_required":true,"pending_data_read_write_denied":true,"own_status_readable":true,"approved_members_preserved":true,"approval_admin_only":true,"self_approval_denied":true,"idempotent_review":true,"rejected_deleted_denied":true}',true);
end
$verify$;
select current_setting('growell.approval_verification')::jsonb as verification;
rollback;
