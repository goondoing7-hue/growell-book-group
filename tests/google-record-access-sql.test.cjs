'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const Private=require('../privateCrypto.js');
const migration=fs.readFileSync(path.join(__dirname,'../server/google-record-access.sql'),'utf8');
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',NEW='55555555-5555-4555-8555-555555555555';
const SESSION='33333333-3333-4333-8333-333333333333',OTHER_SESSION='44444444-4444-4444-8444-444444444444',NEW_SESSION='66666666-6666-4666-8666-666666666666';
const salt='a'.repeat(32),key=Buffer.alloc(32,7).toString('base64'),nextKey=Buffer.alloc(32,9).toString('base64');
const digest=value=>crypto.createHash('sha256').update(Buffer.from(value,'base64')).digest('hex');
const codeIs=code=>error=>error.code===code;

async function fixture(apply=true){
  const db=new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin;
    create schema auth;grant usage on schema public,auth to anon,authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
    create table auth.identities(provider_id text,user_id uuid references auth.users(id),identity_data jsonb,provider text,unique(provider_id,provider));
    create table public.profiles(id text primary key default gen_random_uuid()::text,auth_user_id uuid unique not null,
      login_id text unique not null,name text,is_admin boolean default false,avatar_url text,pbkdf2_salt text,
      created_at bigint default 1234567890,is_deleted boolean default false,approval_status text default 'approved',approved_at timestamptz,approved_by text);
    create table public.private_entries(id text primary key,user_id text,created_at bigint,data text);
    create table public.posts(id text primary key,user_id text,body text);
    create table public.habits(id text primary key,user_id text,checked_dates jsonb);
    create table public.growell_oauth_vaults(auth_user_id uuid primary key,profile_id text,envelope jsonb);
    create table public.growell_oauth_vault_history(id uuid primary key,auth_user_id uuid,envelope jsonb);
    create table public.growell_signup_notifications(profile_id text primary key,applicant_name text not null,login_id text not null);
    create schema vault;revoke all on schema vault from public,anon,authenticated,service_role;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text not null);
    create view vault.decrypted_secrets as select id,convert_from(decode(secret,'base64'),'UTF8') as decrypted_secret from vault.secrets;
    create function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null)
      returns uuid language plpgsql as $$declare secret_id uuid;begin insert into vault.secrets(secret) values(encode(convert_to(new_secret,'UTF8'),'base64')) returning id into secret_id;return secret_id;end$$;
    revoke all on all tables in schema vault from public,anon,authenticated,service_role;
    revoke all on function vault.create_secret(text,text,text,uuid) from public,anon,authenticated,service_role;`);
  // This adapter models the Vault API/ACL only. Encoding is NOT encryption.
  // Actual Vault authenticated encryption is checked by the rollback-only
  // production verification, never inferred from this in-memory test double.
  if(apply)await db.exec(migration);
  return db;
}

describe('Google private-record access SQL retains original keys and separates owner-only access',()=>{
  let db,preparedAccessId;
  before(async()=>{db=await fixture();});after(async()=>{if(db)await db.close();});
  beforeEach(async()=>{
    preparedAccessId=null;
    await db.exec('reset role;truncate public.growell_google_record_access_history,public.growell_google_record_access,vault.secrets,public.growell_signup_notifications,public.private_entries,public.posts,public.habits,public.growell_oauth_vault_history,public.growell_oauth_vaults,public.profiles,auth.identities,auth.sessions,auth.users');
    for(const [owner,session] of [[OWNER,SESSION],[OTHER,OTHER_SESSION],[NEW,NEW_SESSION]]){
      await db.query('insert into auth.users(id) values($1::uuid)',[owner]);await db.query('insert into auth.sessions(id,user_id) values($1::uuid,$2::uuid)',[session,owner]);
      await db.query("insert into auth.identities(provider_id,user_id,identity_data,provider) values($1,$2::uuid,jsonb_build_object('sub',$1::text),'google'),($2::text,$2::uuid,'{}','email')",['google-'+owner,owner]);
    }
    await db.query("insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt) values('owner',$1::uuid,'original-id','원래 별명',$3),('other',$2::uuid,'other-id','다른 별명',$3)",[OWNER,OTHER,salt]);
    await db.exec("insert into public.private_entries values('note','owner',1234567890,'original-encrypted-data');insert into public.posts values('post','owner','공개 원문 그대로');insert into public.habits values('habit','owner','[\"2026-10-24\"]')");
    await db.query("insert into public.growell_oauth_vaults values($1::uuid,'owner','{\"original\":\"password-wrapper\"}')",[OWNER]);
    await db.query("insert into public.growell_oauth_vault_history values(gen_random_uuid(),$1::uuid,'{\"original\":\"prior-wrapper\"}')",[OWNER]);
    await claims();
  });
  async function claims(overrides={},owner=OWNER){const value={sub:owner,role:'authenticated',is_anonymous:false,session_id:owner===OWNER?SESSION:owner===OTHER?OTHER_SESSION:NEW_SESSION,exp:Math.floor(Date.now()/1000)+3600,amr:[{method:'oauth',timestamp:Math.floor(Date.now()/1000)}],...overrides};await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner||'',JSON.stringify(value)]);}
  async function asRole(role,action){await db.exec('set role '+role);try{return await action();}finally{await db.exec('reset role');}}
  const rpc=(name,values=[],role='authenticated')=>asRole(role,async()=>(await db.query('select public.'+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') as value',values)).rows[0].value);
  const get=()=>rpc('growell_google_record_access_get');
  const prepare=async(material=key,overrides={})=>{const response=await rpc('growell_google_record_access_prepare',[overrides.profile??'owner',overrides.salt??salt,material,overrides.digest??digest(material)]);if(!preparedAccessId)preparedAccessId=response.accessId;return response;};
  const register=(material=key,name='신규 별명',nextSalt=salt)=>rpc('growell_google_register',[name,nextSalt,material]);
  const rotate=(expected=digest(key),material=nextKey,expectedAccessId=preparedAccessId)=>rpc('growell_google_record_access_rotate',['owner',salt,expected,material,digest(material),expectedAccessId]);
  const snapshot=async()=>JSON.stringify((await db.query(`select (select jsonb_agg(to_jsonb(p) order by id) from public.profiles p) as profiles,(select jsonb_agg(to_jsonb(n) order by id) from public.private_entries n) as notes,(select jsonb_agg(to_jsonb(p) order by id) from public.posts p) as posts,(select jsonb_agg(to_jsonb(h) order by id) from public.habits h) as habits,(select jsonb_agg(to_jsonb(v) order by auth_user_id) from public.growell_oauth_vaults v) as old_vaults,(select jsonb_agg(to_jsonb(v) order by id) from public.growell_oauth_vault_history v) as old_history`)).rows[0]);
  const counts=async()=> (await db.query('select (select count(*)::int from vault.secrets) as secrets,(select count(*)::int from public.growell_google_record_access) as keys,(select count(*)::int from public.growell_google_record_access_history) as history')).rows[0];

  test('missing never creates a replacement; prepare/readback/fresh-device get retain the exact original key and all content',async()=>{
    const before=await snapshot();assert.equal((await get()).status,'missing');assert.equal((await get()).accessId,null);assert.deepEqual(await counts(),{secrets:0,keys:0,history:0});
    const first=await prepare();assert.equal(first.status,'ready');assert.equal(first.keyB64,key);assert.equal(first.keyDigest,digest(key));assert.match(first.accessId,/^[a-f0-9-]{36}$/);assert.equal(first.profile.id,'owner');assert.equal(first.profile.pbkdf2_salt,salt);
    await claims({amr:[{method:'oauth',timestamp:Math.floor(Date.now()/1000)}]});assert.deepEqual(await get(),first);assert.deepEqual(await prepare(),first);assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});assert.equal(await snapshot(),before);
    const metadata=JSON.stringify((await db.query('select * from public.growell_google_record_access')).rows);assert.equal(metadata.includes(key),false);
  });
  test('a competing or stale candidate cannot overwrite an enrolled key, salt or v1 wrapper',async()=>{
    const first=await prepare(),before=await snapshot();await assert.rejects(prepare(nextKey),codeIs('40001'));assert.deepEqual(await get(),first);assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});assert.equal(await snapshot(),before);
    for(const overrides of [{profile:'other'},{salt:'b'.repeat(32)}])await assert.rejects(prepare(key,overrides),codeIs('42501'));
  });
  test('anonymous/service roles, direct tables and private helpers cannot read/write keys even with spoofed metadata',async()=>{
    await prepare();for(const role of ['anon','service_role'])for(const [name,args] of [['growell_google_record_access_get',[]],['growell_google_record_access_prepare',['owner',salt,key,digest(key)]],['growell_google_register',['이름',salt,key]],['growell_google_record_access_rotate',['owner',salt,digest(key),nextKey,digest(nextKey),preparedAccessId]]])await assert.rejects(rpc(name,args,role),codeIs('42501'));
    for(const role of ['anon','authenticated','service_role'])for(const query of ['select * from public.growell_google_record_access','select * from public.growell_google_record_access_history','select * from vault.secrets','select * from vault.decrypted_secrets','select growell_record_access_private.member()'])await assert.rejects(asRole(role,()=>db.query(query)),codeIs('42501'));
    await claims({role:'service_role',user_metadata:{provider:'google'}});await assert.rejects(get(),codeIs('42501'));
    const config=(await db.query("select prosecdef,proconfig from pg_proc where oid='public.growell_google_record_access_get()'::regprocedure")).rows[0];assert.equal(config.prosecdef,true);assert.deepEqual(config.proconfig,['search_path=""']);
    assert.ok((await db.query("select relrowsecurity from pg_class where oid in ('public.growell_google_record_access'::regclass,'public.growell_google_record_access_history'::regclass)")).rows.every(row=>row.relrowsecurity));
  });
  test('actual live session, expiry, real Google identity and Auth deletion/ban are required',async()=>{
    await prepare();for(const override of [{session_id:OTHER_SESSION},{session_id:'invalid'},{exp:Math.floor(Date.now()/1000)-1},{exp:'bad'},{is_anonymous:true},{sub:OTHER}]){await claims(override);await assert.rejects(get(),codeIs('42501'));}await claims();
    await db.query('update auth.sessions set not_after=now()-interval \'1 second\' where id=$1::uuid',[SESSION]);await assert.rejects(get(),codeIs('42501'));await db.query('update auth.sessions set not_after=null where id=$1::uuid',[SESSION]);
    await db.query("update auth.identities set identity_data='{}' where user_id=$1::uuid and provider='google'",[OWNER]);await assert.rejects(get(),codeIs('42501'));
    await db.query("update auth.identities set identity_data=jsonb_build_object('sub',provider_id) where user_id=$1::uuid and provider='google'",[OWNER]);
    await db.query('update auth.users set banned_until=now()+interval \'1 hour\' where id=$1::uuid',[OWNER]);await assert.rejects(get(),codeIs('42501'));await db.query('update auth.users set banned_until=null,deleted_at=now() where id=$1::uuid',[OWNER]);await assert.rejects(get(),codeIs('42501'));
    await db.query('update auth.users set deleted_at=null where id=$1::uuid',[OWNER]);await db.query('delete from auth.sessions where id=$1::uuid',[SESSION]);await assert.rejects(get(),codeIs('42501'));
  });
  test('pending/rejected/deleted profiles and another account never obtain the owner key',async()=>{
    await prepare();for(const status of ['pending','rejected']){await db.query('update public.profiles set approval_status=$1 where id=\'owner\'',[status]);await assert.rejects(get(),codeIs('42501'));await assert.rejects(prepare(),codeIs('42501'));}await db.exec("update public.profiles set approval_status='approved',is_deleted=true where id='owner'");await assert.rejects(get(),codeIs('42501'));
    await db.exec("update public.profiles set is_deleted=false where id='owner'");await claims({},OTHER);const other=await get();assert.equal(other.status,'missing');assert.equal(other.keyB64,null);await assert.rejects(prepare(),codeIs('42501'));
  });
  test('canonical 32-byte keys, honest digest and exact owner/salt/context are verified before delivery',async()=>{
    for(const material of [null,'',Buffer.alloc(16).toString('base64'),key+'\n',key.slice(0,-2)+'9=',key.repeat(100)])await assert.rejects(prepare(material,{digest:digest(key)}),codeIs('22023'));
    await assert.rejects(prepare(key,{digest:'0'.repeat(64)}),codeIs('22023'));await assert.rejects(prepare(key,{digest:digest(key).toUpperCase()}),codeIs('22023'));await prepare();
    const stored=(await db.query('select * from public.growell_google_record_access')).rows[0],payload=JSON.parse((await db.query('select decrypted_secret from vault.decrypted_secrets where id=$1::uuid',[stored.vault_secret_id])).rows[0].decrypted_secret);
    for(const changed of [{...payload,owner:OTHER},{...payload,profileId:'other'},{...payload,profileSalt:'b'.repeat(32)},{...payload,aad:'other-context'},{...payload,keyDigest:'0'.repeat(64)},{...payload,keyB64:nextKey},{...payload,extra:'unexpected'}]){
      await db.query("update vault.secrets set secret=encode(convert_to($1,'UTF8'),'base64') where id=$2::uuid",[JSON.stringify(changed),stored.vault_secret_id]);await assert.rejects(get(),codeIs('22023'));
    }
    await db.query("update vault.secrets set secret=encode(convert_to($1,'UTF8'),'base64') where id=$2::uuid",[JSON.stringify(payload),stored.vault_secret_id]);await db.exec("update public.growell_google_record_access set context='changed'");await assert.rejects(get(),codeIs('22023'));
  });
  test('new Google registration atomically creates one pending nonadmin profile/key/notice; retries retain the winning key and old accounts',async()=>{
    const before=await snapshot();await claims({},NEW);const first=await register();assert.equal(first.status,'approval-required');assert.equal(first.keyB64,null);assert.equal(first.keyDigest,null);assert.equal(first.profile.is_admin,false);assert.equal(first.profile.approval_status,'pending');assert.equal(first.profile.pbkdf2_salt,salt);
    assert.deepEqual(await register(nextKey,'다른 이름','b'.repeat(32)),first);await assert.rejects(get(),codeIs('42501'));assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});assert.equal((await db.query('select count(*)::int as count from public.growell_signup_notifications')).rows[0].count,1);
    await db.query("update public.profiles set approval_status='approved' where auth_user_id=$1::uuid",[NEW]);const ready=await get();assert.equal(ready.keyB64,key);assert.deepEqual(await register(nextKey),ready);
    await claims();assert.equal((await register(nextKey)).status,'missing','existing legacy profiles never adopt the new-enrollment candidate');assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});
    await db.query('delete from public.growell_signup_notifications where profile_id=$1',[first.profile.id]);await db.query('delete from public.profiles where auth_user_id=$1::uuid',[NEW]);assert.equal(await snapshot(),before);
  });
  test('failed secret/notice writes roll back the entire applicant without partial profile/key enrollment',async()=>{
    await claims({},NEW);const before=await snapshot();
    await db.exec("create function public.reject_test_notice() returns trigger language plpgsql as $$begin raise exception 'synthetic_notice_failure';end$$;create trigger reject_test_notice before insert on public.growell_signup_notifications for each row execute function public.reject_test_notice()");
    await assert.rejects(register());assert.equal(await snapshot(),before);assert.deepEqual(await counts(),{secrets:0,keys:0,history:0});await db.exec('drop trigger reject_test_notice on public.growell_signup_notifications;drop function public.reject_test_notice()');
    await db.exec("create or replace function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null) returns uuid language plpgsql as $$begin raise exception 'synthetic_vault_failure';end$$");
    await assert.rejects(register());assert.equal(await snapshot(),before);assert.deepEqual(await counts(),{secrets:0,keys:0,history:0});
    await db.exec("create or replace function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null) returns uuid language plpgsql as $$declare secret_id uuid;begin insert into vault.secrets(secret) values(encode(convert_to(new_secret,'UTF8'),'base64')) returning id into secret_id;return secret_id;end$$");
  });
  test('recovery rotation requires fresh password proof and exact CAS, retains the previous secret and idempotent retry',async()=>{
    await prepare();const before=await snapshot();await assert.rejects(rotate(),codeIs('42501'));await claims({amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)-601}]});await assert.rejects(rotate(),codeIs('42501'));
    await claims({amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]});await assert.rejects(rotate('0'.repeat(64)),codeIs('40001'));const first=await rotate();assert.equal(first.keyB64,nextKey);assert.deepEqual(await rotate(),first);assert.deepEqual(await counts(),{secrets:2,keys:1,history:1});
    await assert.rejects(rotate('0'.repeat(64)),codeIs('40001'));await assert.rejects(rotate(digest(key),Buffer.alloc(32,10).toString('base64')),codeIs('40001'));assert.deepEqual(await get(),first);assert.equal(await snapshot(),before);
    const history=(await db.query('select h.key_digest,v.decrypted_secret from public.growell_google_record_access_history h join vault.decrypted_secrets v on v.id=h.vault_secret_id')).rows;assert.equal(history.length,1);assert.equal(JSON.parse(history[0].decrypted_secret).keyB64,key);
  });
  test('real encrypted v2 notes/recovery file still open using the same Vault key without rewriting IDs/timestamps/body',async()=>{
    const original=await Private.importKey(key),dataKey=await Private.newKey(),identity={id:'note',userId:'owner',bookId:'emotion',createdAt:1234567890};
    const entry={...identity,...await Private.create(identity,original,dataKey,'암호화된 원문을 그대로 보존한다.')},kit=await Private.recoveryFile({id:'owner',loginId:'original-id',authUserId:OWNER},[dataKey],[original]);
    await db.query('update public.private_entries set data=$1 where id=\'note\'',[JSON.stringify(entry)]);const before=await snapshot();await prepare();const restored=await Private.importKey((await get()).keyB64);assert.equal((await Private.read(entry,restored)).text,'암호화된 원문을 그대로 보존한다.');assert.equal((await Private.recover(entry,kit)).text,'암호화된 원문을 그대로 보존한다.');assert.equal(await snapshot(),before);
  });
  test('access-generation CAS rejects a late A-to-B request after A-to-B-to-A instead of accepting a digest-only ABA match',async()=>{
    const original=await prepare();await claims({amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]});
    const second=await rotate(),third=await rotate(digest(nextKey),key,second.accessId);
    assert.equal(third.keyDigest,original.keyDigest);assert.notEqual(third.accessId,original.accessId);
    await assert.rejects(rotate(digest(key),nextKey,original.accessId),codeIs('40001'));assert.deepEqual(await get(),third);assert.deepEqual(await counts(),{secrets:3,keys:1,history:2});
    assert.deepEqual(await rotate(digest(nextKey),key,second.accessId),third,'only an exact predecessor-to-current generation retry is idempotent');
  });
  test('account deletion only blocks access; retained secret cannot be rebound to a new Auth UUID or recreated old profile',async()=>{
    await prepare();await db.exec("delete from public.profiles where id='owner'");await assert.rejects(get(),codeIs('42501'));await assert.rejects(register(),codeIs('42501'));assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});
    await claims({},NEW);const result=await register(nextKey);assert.notEqual(result.profile.id,'owner');assert.equal(result.keyB64,null);assert.deepEqual(await counts(),{secrets:2,keys:2,history:0});
  });
  test('future broad Vault access causes both reading and new enrollment to fail closed without modifying current key',async()=>{
    await prepare();await db.exec('grant select on vault.decrypted_secrets to authenticated');await assert.rejects(get(),codeIs('42501'));await claims({},NEW);await assert.rejects(register(),codeIs('42501'));assert.deepEqual(await counts(),{secrets:1,keys:1,history:0});await db.exec('revoke select on vault.decrypted_secrets from authenticated');
  });
  test('the trusted service role keeps existing Vault worker privileges but never receives the new client RPC or key-table grants',async()=>{
    await db.exec('grant usage on schema vault to service_role;grant select on vault.secrets,vault.decrypted_secrets to service_role;grant execute on function vault.create_secret(text,text,text,uuid) to service_role');
    try{
      const ready=await prepare();assert.equal(ready.keyB64,key);assert.deepEqual(await get(),ready);
      await assert.rejects(rpc('growell_google_record_access_get',[],'service_role'),codeIs('42501'));
      const permissions=(await db.query("select has_schema_privilege('service_role','vault','USAGE') as usage,has_table_privilege('service_role','vault.decrypted_secrets','SELECT') as worker_read,has_function_privilege('service_role','vault.create_secret(text,text,text,uuid)','EXECUTE') as worker_write")).rows[0];
      assert.deepEqual(permissions,{usage:true,worker_read:true,worker_write:true});
    }finally{await db.exec('revoke all on schema vault from service_role;revoke all on vault.secrets,vault.decrypted_secrets from service_role;revoke all on function vault.create_secret(text,text,text,uuid) from service_role');}
  });
  test('the actual-Vault verification script returns only aggregate checks and rolls back every synthetic row even on success',async()=>{
    const verification=fs.readFileSync(path.join(__dirname,'../server/google-record-access-verification.sql'),'utf8'),before=await snapshot(),keyCounts=await counts();
    const results=await db.exec(verification),report=results.flatMap(result=>result.rows||[]).find(row=>row.google_record_access_verification)?.google_record_access_verification;
    assert.equal(report?.ok,true,JSON.stringify(report));assert.equal(report.synthetic_rows_remaining,0);assert.equal(await snapshot(),before);assert.deepEqual(await counts(),keyCounts);assert.doesNotMatch(JSON.stringify(report),/keyB64|password-wrapper|11111111/);
  });
});

test('deployment rolls back all new contracts when an existing broad Vault grant could expose secrets',async()=>{
  const db=await fixture(false);try{
    await db.exec('grant select on vault.decrypted_secrets to authenticated');await assert.rejects(db.exec(migration),codeIs('42501'));await db.exec('rollback');
    assert.equal((await db.query("select to_regclass('public.growell_google_record_access') as table_id,to_regnamespace('growell_record_access_private') as schema_id")).rows[0].table_id,null);
    assert.equal((await db.query('select count(*)::int as count from vault.secrets')).rows[0].count,0);
  }finally{await db.close();}
});
