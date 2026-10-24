'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const OAuth=require('../oauthDomain.js'),Private=require('../privateCrypto.js');
const migration=fs.readFileSync(path.join(__dirname,'../server/oauth-members.sql'),'utf8');
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const SESSION='33333333-3333-4333-8333-333333333333',OTHER_SESSION='44444444-4444-4444-8444-444444444444';
const salt='a'.repeat(32),envelope=(owner=OWNER,extra={})=>({format:'growell-oauth-vault-v1',version:1,owner,
  kdf:{name:'PBKDF2',hash:'SHA-256',iterations:150000,salt},
  iv:Buffer.alloc(12,4).toString('base64'),data:Buffer.alloc(96,5).toString('base64'),...extra});
const codeIs=code=>error=>error.code===code;

// PostgreSQL privileges, isolation, locking and immutable vault semantics in
// isolated memory. No live Auth account, member data or credential is used.
describe('existing member Google login link SQL preserves account and records',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role supabase_auth_admin nologin;create role service_role nologin;
      create schema auth;grant usage on schema public,auth to anon,authenticated,supabase_auth_admin,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
      create table auth.identities(provider_id text,user_id uuid references auth.users(id),identity_data jsonb,provider text,unique(provider_id,provider));
      create table public.profiles(id text primary key default gen_random_uuid()::text,auth_user_id uuid unique not null references auth.users(id),
        login_id text unique not null,name text,is_admin boolean default false,avatar_url text default 'synthetic-photo',
        pbkdf2_salt text,created_at bigint default 1234567890,is_deleted boolean default false,
        approval_status text default 'approved',approved_at timestamptz,approved_by text,
        recovery_key text default 'synthetic-recovery-untouched',hint_hash text default 'synthetic-hint-untouched');
      create table public.private_entries(id text primary key,user_id text references public.profiles(id),created_at bigint,data text);
      create table public.posts(id text primary key,user_id text references public.profiles(id),body text);
      create table public.habits(id text primary key,user_id text references public.profiles(id),checked_dates jsonb);`);
    await db.exec(`create table public.growell_signup_notifications(profile_id text primary key references public.profiles(id) on delete cascade,applicant_name text not null,login_id text not null);
      create function public.growell_guard_member_approval() returns trigger language plpgsql as $$begin new.approval_status:='pending';new.is_admin:=false;return new;end$$;`);
    await db.exec(migration);
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate auth.users,public.profiles cascade');
    await db.query('insert into auth.users values($1::uuid),($2::uuid)',[OWNER,OTHER]);
    await db.query("insert into auth.identities(provider_id,user_id,provider) values($1::text,$1::text::uuid,'email'),($2::text,$2::text::uuid,'email')",[OWNER,OTHER]);
    await db.query('insert into auth.sessions values($1::uuid,$2::uuid),($3::uuid,$4::uuid)',[SESSION,OWNER,OTHER_SESSION,OTHER]);
    await db.query("insert into public.profiles(id,auth_user_id,login_id,name,pbkdf2_salt) values('original-owner',$1::uuid,'original-id','원래 이름',$3),('other-owner',$2::uuid,'other-id','다른 회원',$3)",[OWNER,OTHER,'c'.repeat(32)]);
    await db.exec("insert into public.private_entries values('old-note','original-owner',1234567890,'original-encrypted-v2-data');insert into public.posts values('old-post','original-owner','원문 그대로');insert into public.habits values('old-habit','original-owner','[\"2026-10-20\"]')");
    await claims();
  });
  after(async()=>{if(db)await db.close();});
  async function claims(overrides={},owner=OWNER){
    const value={sub:owner,role:'authenticated',is_anonymous:false,session_id:owner===OWNER?SESSION:OTHER_SESSION,
      amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}],...overrides};
    await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner||'',JSON.stringify(value)]);
  }
  async function asRole(role,action){await db.exec('set role '+role);try{return await action();}finally{await db.exec('reset role');}}
  const prepare=(value=envelope())=>asRole('authenticated',async()=>(await db.query('select public.growell_oauth_link_prepare($1::jsonb) as value',[JSON.stringify(value)])).rows[0].value);
  const rotate=(previous,value)=>asRole('authenticated',async()=>(await db.query('select public.growell_oauth_link_rotate($1::jsonb,$2::jsonb) as value',[JSON.stringify(previous),JSON.stringify(value)])).rows[0].value);
  const current=()=>asRole('authenticated',async()=>(await db.query('select public.growell_oauth_profile() as value')).rows[0].value);
  const snapshot=async()=>JSON.stringify((await db.query(`select
      (select jsonb_agg(to_jsonb(p) order by id) from public.profiles p) as profiles,
      (select jsonb_agg(to_jsonb(n) order by id) from public.private_entries n) as private_entries,
      (select jsonb_agg(to_jsonb(p) order by id) from public.posts p) as posts,
      (select jsonb_agg(to_jsonb(h) order by id) from public.habits h) as habits,
      (select jsonb_agg(to_jsonb(i) order by provider_id,provider) from auth.identities i) as identities`)).rows[0]);

  test('prepares before Google redirect, preserves identifiers/salt/content, then same UUID becomes ready',async()=>{
    const before=await snapshot(),prepared=await prepare();
    assert.equal(prepared.status,'prepared');assert.equal(prepared.profile.id,'original-owner');
    assert.equal(prepared.profile.auth_user_id,OWNER);assert.equal(prepared.profile.login_id,'original-id');
    assert.equal(prepared.profile.pbkdf2_salt,'c'.repeat(32),'vault KDF salt must not replace native login salt');
    assert.equal(prepared.profile.approval_status,'approved');assert.deepEqual(prepared.envelope,envelope());
    assert.equal(await snapshot(),before);
    await assert.rejects(current(),codeIs('42501'),'preparation does not itself grant a Google identity');
    await db.query("insert into auth.identities(provider_id,user_id,provider) values('synthetic-google-sub',$1::uuid,'google')",[OWNER]);
    const ready=await current();assert.equal(ready.status,'ready');assert.equal(ready.profile.id,prepared.profile.id);
    assert.deepEqual(ready.envelope,prepared.envelope);assert.equal(ready.profile.approval_status,'approved');
  });
  test('retry and competing tab proposals return the first envelope without overwriting',async()=>{
    const first=await prepare(),before=await snapshot();
    for(const candidate of [envelope(OWNER,{data:Buffer.alloc(64,9).toString('base64')}),envelope()])assert.deepEqual(await prepare(candidate),first);
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vaults')).rows[0].count,1);
    assert.equal(await snapshot(),before);
  });
  test('another account cannot submit or read the owner vault and no profile merge occurs',async()=>{
    await prepare();await claims({},OTHER);const before=await snapshot();
    await assert.rejects(prepare(envelope()),codeIs('22023'));
    assert.equal(await snapshot(),before);
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vaults')).rows[0].count,1);
    await assert.rejects(asRole('authenticated',()=>db.query('select * from public.growell_oauth_vaults')),codeIs('42501'));
  });
  test('pending/rejected/deleted/missing profiles cannot prepare and leave all prior data intact',async()=>{
    for(const condition of ["approval_status='pending'","approval_status='rejected'","is_deleted=true"]){
      await db.exec('update public.profiles set '+condition+" where id='original-owner'");const before=await snapshot();
      await assert.rejects(prepare(),codeIs('42501'));assert.equal(await snapshot(),before);
      await db.exec("update public.profiles set approval_status='approved',is_deleted=false where id='original-owner'");
    }
    await db.exec("delete from public.profiles where id='other-owner'");await claims({},OTHER);
    await assert.rejects(prepare(envelope(OTHER)),codeIs('42501'));
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vaults')).rows[0].count,0);
  });
  test('requires live own Auth session and recently reauthenticated password, not refresh or editable metadata',async()=>{
    const now=Math.floor(Date.now()/1000),before=await snapshot();
    for(const invalid of [
      {session_id:null},{session_id:'bad'},{session_id:OTHER_SESSION},{is_anonymous:true},
      {amr:null},{amr:{}},{amr:[{method:'oauth',timestamp:now}]},
      {amr:[{method:'password',timestamp:now-1200},{method:'token_refresh',timestamp:now}]},
      {amr:[{method:'password',timestamp:now+300}]},{amr:[{method:'password',timestamp:'not-a-number'}]},
      {amr:[],user_metadata:{amr:[{method:'password',timestamp:now}],approval_status:'approved'}}
    ]){await claims(invalid);await assert.rejects(prepare(),codeIs('42501'));}
    await claims();await db.exec("delete from auth.sessions where id='"+SESSION+"'");await assert.rejects(prepare(),codeIs('42501'));
    assert.equal(await snapshot(),before);
  });
  test('password identity is required even when the caller has a recent password claim',async()=>{
    await db.exec("update auth.identities set provider='google' where user_id='"+OWNER+"'");
    await assert.rejects(prepare(),codeIs('42501'));
  });
  test('invalid/foreign envelope and extra plaintext fields fail without partial writes',async()=>{
    const base=envelope(),before=await snapshot();
    for(const candidate of [null,[],envelope(OTHER),{...base,version:'1'},
      {...base,key:'plain-private-key'},{...base,password:'plain-password'},
      {...base,kdf:{...base.kdf,iterations:'150000'}},{...base,kdf:{...base.kdf,salt:'bad'}},
      {...base,kdf:{...base.kdf,password:'plain-password'}},
      {...base,iv:Buffer.alloc(11).toString('base64')},{...base,data:'A'.repeat(5000)},
      {...base,data:Buffer.alloc(16).toString('base64')}
    ])await assert.rejects(prepare(candidate),codeIs('22023'));
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vaults')).rows[0].count,0);
    assert.equal(await snapshot(),before);
  });
  test('RPC grants, RLS and empty search path prevent anonymous or direct vault access',async()=>{
    await assert.rejects(asRole('anon',()=>db.query('select public.growell_oauth_link_prepare($1::jsonb)',[JSON.stringify(envelope())])),codeIs('42501'));
    await assert.rejects(asRole('service_role',()=>db.query('select public.growell_oauth_link_prepare($1::jsonb)',[JSON.stringify(envelope())])),codeIs('42501'));
    for(const role of ['anon','authenticated']){
      await assert.rejects(asRole(role,()=>db.query('select * from public.growell_oauth_vaults')),codeIs('42501'));
      await assert.rejects(asRole(role,()=>db.query('delete from public.growell_oauth_vaults')),codeIs('42501'));
    }
    const permissions=(await db.query("select has_function_privilege('authenticated','public.growell_oauth_link_prepare(jsonb)','EXECUTE') as owner_rpc,has_function_privilege('anon','public.growell_oauth_link_prepare(jsonb)','EXECUTE') as anon_rpc,(select relrowsecurity from pg_class where oid='public.growell_oauth_vaults'::regclass) as rls,(select proconfig from pg_proc where oid='public.growell_oauth_link_prepare(jsonb)'::regprocedure) as config")).rows[0];
    assert.equal(permissions.owner_rpc,true);assert.equal(permissions.anon_rpc,false);assert.equal(permissions.rls,true);assert.deepEqual(permissions.config,['search_path=""']);
    await claims({},null);await assert.rejects(prepare(),codeIs('42501'));
  });
  test('wrong Google identity collision cannot change any existing profile or vault',async()=>{
    const first=await prepare();
    await db.query("insert into auth.identities(provider_id,user_id,provider) values('already-used-google',$1::uuid,'google')",[OTHER]);
    const before=await snapshot();
    await assert.rejects(db.query("insert into auth.identities(provider_id,user_id,provider) values('already-used-google',$1::uuid,'google')",[OWNER]),codeIs('23505'));
    assert.equal(await snapshot(),before);assert.deepEqual(await prepare(),first);
    await assert.rejects(current(),codeIs('42501'));
  });
  test('recovery rotation retains previous encrypted wrapper, preserves member data, and retries idempotently',async()=>{
    const first=await prepare(),before=await snapshot(),next=envelope(OWNER,{data:Buffer.alloc(80,7).toString('base64')});
    const rotated=await rotate(first.envelope,next);assert.deepEqual(rotated.envelope,next);assert.deepEqual(rotated.profile,first.profile);
    assert.equal(await snapshot(),before);
    const history=(await db.query('select auth_user_id,profile_id,envelope from public.growell_oauth_vault_history')).rows;
    assert.deepEqual(history,[{auth_user_id:OWNER,profile_id:'original-owner',envelope:first.envelope}]);
    assert.deepEqual(await rotate(first.envelope,next),rotated);
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vault_history')).rows[0].count,1);
    assert.deepEqual((await prepare()).envelope,next,'prepare cannot restore the old wrapper');
  });
  test('actual encrypted v2 notes and prior recovery files keep the same key/identity through prepare and CAS rewrap',async()=>{
    const privateKey=await Private.newKey(),rawKey=await Private.exportKey(privateKey),dataKey=await Private.newKey();
    const identity={id:'old-note',userId:'original-owner',bookId:'emotion',createdAt:1234567890};
    const entry={...identity,...await Private.create(identity,privateKey,dataKey,'원래 기록의 내용')};
    const kit=await Private.recoveryFile({id:'original-owner',loginId:'original-id',authUserId:OWNER},[dataKey],[privateKey]);
    await db.query('update public.private_entries set data=$1 where id=$2',[JSON.stringify(entry),'old-note']);
    const before=await snapshot(),first=await OAuth.createVault('original-password',salt,OWNER,rawKey);
    const prepared=await prepare(first.envelope);
    assert.equal(await OAuth.unlockVault('original-password',prepared.envelope,OWNER),rawKey);
    const next=await OAuth.createVault('changed-private-password','b'.repeat(32),OWNER,rawKey);
    const rotated=await rotate(prepared.envelope,next.envelope);
    const reopened=await Private.importKey(await OAuth.unlockVault('changed-private-password',rotated.envelope,OWNER));
    const stored=JSON.parse((await db.query('select data from public.private_entries where id=$1',['old-note'])).rows[0].data);
    assert.equal((await Private.read(stored,reopened)).text,'원래 기록의 내용');
    assert.equal((await Private.recover(stored,kit)).text,'원래 기록의 내용');
    assert.equal(await snapshot(),before,'key wrapping never rewrites the saved note or its owner/ID/time');
    assert.equal(JSON.stringify(prepared.envelope).includes(rawKey),false);
    assert.equal(JSON.stringify(rotated.envelope).includes('changed-private-password'),false);
  });
  test('rotation rejects stale CAS, malformed new material, other owners and stale password without replacing/history loss',async()=>{
    const first=await prepare(),second=envelope(OWNER,{data:Buffer.alloc(90,6).toString('base64')}),third=envelope(OWNER,{data:Buffer.alloc(70,7).toString('base64')});
    await rotate(first.envelope,second);
    await assert.rejects(rotate(first.envelope,third),codeIs('40001'));
    await assert.rejects(rotate(second,{...third,key:'plaintext'}),codeIs('22023'));
    await assert.rejects(rotate(null,third),codeIs('22023'));
    await claims({},OTHER);await assert.rejects(rotate(second,third),codeIs('22023'));
    await claims({amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)-3600}]});await assert.rejects(rotate(second,third),codeIs('42501'));
    await claims();assert.deepEqual((await prepare()).envelope,second);
    assert.equal((await db.query('select count(*)::int as count from public.growell_oauth_vault_history')).rows[0].count,1);
    for(const role of ['anon','authenticated'])await assert.rejects(asRole(role,()=>db.query('select * from public.growell_oauth_vault_history')),codeIs('42501'));
    await assert.rejects(asRole('anon',()=>db.query('select public.growell_oauth_link_rotate($1::jsonb,$2::jsonb)',[JSON.stringify(second),JSON.stringify(third)])),codeIs('42501'));
    await assert.rejects(asRole('service_role',()=>db.query('select public.growell_oauth_link_rotate($1::jsonb,$2::jsonb)',[JSON.stringify(second),JSON.stringify(third)])),codeIs('42501'));
  });
  test('stateless Auth hook permits only new Google users and trusts no user-editable provider claim',async()=>{
    const hook=event=>asRole('supabase_auth_admin',async()=>(await db.query('select public.growell_before_user_created($1::jsonb) as value',[JSON.stringify(event)])).rows[0].value);
    const before=await snapshot();
    const allowed=await hook({user:{app_metadata:{provider:'google'},user_metadata:{provider:'email'}}});
    assert.deepEqual(allowed,{});
    for(const blocked of [
      {user:{app_metadata:{provider:'email'},user_metadata:{provider:'google',is_admin:true}}},
      {user:{app_metadata:{provider:'kakao'}}},{user:{user_metadata:{provider:'google'}}},
      {user:{app_metadata:{provider:'google'},is_anonymous:true}},null
    ])assert.equal((await hook(blocked)).error.http_code,403);
    assert.equal(await snapshot(),before);
    for(const role of ['anon','authenticated','service_role'])await assert.rejects(asRole(role,()=>db.query("select public.growell_before_user_created('{}'::jsonb)")),codeIs('42501'));
    const meta=(await db.query("select prosecdef,provolatile,proconfig from pg_proc where oid='public.growell_before_user_created(jsonb)'::regprocedure")).rows[0];
    assert.equal(meta.prosecdef,false);assert.equal(meta.provolatile,'i');assert.deepEqual(meta.proconfig,['search_path=""']);
  });
  test('Google-only follow-up registers one pending member, exact vault and one notice while preserving old member records',async()=>{
    const followup=fs.readFileSync(path.join(__dirname,'../server/google-only-enrollment.sql'),'utf8');await db.exec(followup);
    const fresh='55555555-5555-4555-8555-555555555555',before=await snapshot();
    await db.query('insert into auth.users values($1::uuid)',[fresh]);
    await db.query("insert into auth.identities(provider_id,user_id,provider) values('fresh-google',$1::uuid,'google')",[fresh]);await claims({},fresh);
    const register=value=>asRole('authenticated',async()=>(await db.query('select public.growell_oauth_register($1,$2,$3::jsonb) as value',['임시 별명',salt,JSON.stringify(value)])).rows[0].value);
    const made=await register(envelope(fresh));assert.equal(made.status,'ready');assert.equal(made.profile.approval_status,'pending');assert.equal(made.profile.is_admin,false);assert.equal(made.profile.auth_user_id,fresh);assert.deepEqual(made.envelope,envelope(fresh));
    assert.deepEqual(await register(envelope(fresh,{data:Buffer.alloc(96,8).toString('base64')})),made);
    assert.equal((await db.query('select count(*)::int as n from public.growell_signup_notifications')).rows[0].n,1);
    const existing=JSON.parse(before),after=JSON.parse(await snapshot());
    for(const field of ['private_entries','posts','habits'])assert.deepEqual(after[field],existing[field]);
    assert.deepEqual(after.profiles.filter(p=>p.auth_user_id!==fresh),existing.profiles);
    assert.deepEqual(after.identities.filter(i=>i.user_id!==fresh),existing.identities);
  });
  test('existing Kakao profiles remain readable but an unregistered Kakao identity cannot become a member',async()=>{
    await db.exec(fs.readFileSync(path.join(__dirname,'../server/google-only-enrollment.sql'),'utf8'));
    await db.query("insert into auth.identities(provider_id,user_id,provider) values('old-kakao',$1::uuid,'kakao')",[OWNER]);
    const before=await snapshot();const result=await asRole('authenticated',async()=>(await db.query('select public.growell_oauth_register($1,$2,$3::jsonb) as value',['ignored',salt,JSON.stringify(envelope())])).rows[0].value);
    assert.equal(result.profile.id,'original-owner');assert.equal(result.status,'legacy');assert.equal(await snapshot(),before);
    const fresh='66666666-6666-4666-8666-666666666666';await db.query('insert into auth.users values($1::uuid)',[fresh]);
    await db.query("insert into auth.identities(provider_id,user_id,provider) values('new-kakao',$1::uuid,'kakao')",[fresh]);await claims({},fresh);
    await assert.rejects(asRole('authenticated',()=>db.query('select public.growell_oauth_register($1,$2,$3::jsonb)',['blocked',salt,JSON.stringify(envelope(fresh))])),codeIs('42501'));
    assert.equal((await db.query('select count(*)::int as n from public.profiles where auth_user_id=$1::uuid',[fresh])).rows[0].n,0);
  });
  test('standalone rollback verification succeeds without leaving synthetic Auth/profile/vault rows',async()=>{
    const verification=fs.readFileSync(path.join(__dirname,'../server/oauth-verification.sql'),'utf8');
    const section=verification.split('-- BEGIN EXISTING_MEMBER_GOOGLE_LINK_VERIFICATION')[1].split('-- END EXISTING_MEMBER_GOOGLE_LINK_VERIFICATION')[0];
    const before=await snapshot(),results=await db.exec(section);
    const result=results.flatMap(entry=>entry.rows||[]).find(row=>row.oauth_link_verification);
    assert.ok(result);assert.equal(result.oauth_link_verification.ok,true,JSON.stringify(result));
    assert.equal(result.oauth_link_verification.synthetic_rows_remaining,0);assert.equal(await snapshot(),before);
  });
});
