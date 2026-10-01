'use strict';

const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

// This is an isolated, in-memory PostgreSQL instance. No application database,
// credentials, browser storage or external reminder API is used by these tests.
const migration=fs.readFileSync(path.join(__dirname,'../server/habit-sync.sql'),'utf8');
const AUTH='11111111-1111-4111-8111-111111111111';
const OTHER_AUTH='22222222-2222-4222-8222-222222222222';
const GEN='33333333-3333-4333-8333-333333333333';
const NEXT_GEN='44444444-4444-4444-8444-444444444444';
const TOKEN='synthetic-encrypted-token-for-tests';
describe('habit synchronization PostgreSQL migration',()=>{
let db;

before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create table public.profiles (
      id text primary key,auth_user_id uuid not null unique,
      approval_status text not null default 'approved',is_deleted boolean not null default false
    );
    create table public.habits (
      id text primary key,user_id text not null references public.profiles(id) on delete cascade,
      name text not null,goal text,time text,place text,start_date text,end_date text,
      behavior_type text not null default 'do',book_id text not null,
      checked_dates text[] not null default '{}',created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
    grant select,insert,update,delete on public.profiles,public.habits to service_role;
    grant insert,update,delete on public.habits to authenticated;
  `);
  await db.exec(migration);
});
beforeEach(async()=>{
  await db.exec('reset role;truncate table public.profiles cascade');
  await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid),($3,$4::uuid)',['owner',AUTH,'other',OTHER_AUTH]);
});
after(async()=>{if(db)await db.close();});

async function asRole(role,action){
  assert.ok(['anon','authenticated','service_role'].includes(role));
  await db.exec('set role '+role);
  try{return await action();}finally{await db.exec('reset role');}
}
async function rpc(name,args){
  const queries={
    configure:'select public.growell_habit_sync_configure($1,$2::uuid,$3,$4::jsonb) as value',
    oauth:'select public.growell_habit_sync_oauth($1,$2::jsonb) as value',
    claim:'select public.growell_habit_sync_claim($1,$2::integer) as value',
    apply:'select public.growell_habit_sync_apply($1,$2::uuid,$3::uuid,$4,$5::jsonb) as value'
  };
  assert.ok(queries[name]);
  return (await db.query(queries[name],args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;
}
const configure=(operation,payload={},owner='owner',auth=AUTH)=>asRole('service_role',()=>rpc('configure',[owner,auth,operation,payload]));
const connect=(generation=GEN,owner='owner',auth=AUTH)=>configure('connect',{generation,token_cipher:TOKEN,account_id:'synthetic-account',default_time:'09:00'},owner,auth);
const claim=(owner='owner',limit=5)=>asRole('service_role',()=>rpc('claim',[owner,limit]));
const apply=(job,operation,payload={})=>asRole('service_role',()=>rpc('apply',[job.connection.owner_id,job.connection.generation,job.connection.lease_token,operation,payload]));
const oauth=(operation,payload)=>asRole('service_role',()=>rpc('oauth',[operation,payload]));
async function habit(id='new-habit',owner='owner'){
  return db.query(`insert into public.habits(id,user_id,name,goal,time,place,start_date,end_date,book_id)
    values($1,$2,'독서','하루 10쪽','저녁 9시','집','2026-10-01','2026-10-31','emotion')`,[id,owner]);
}
async function rows(table='queue'){
  assert.ok(['queue','connections','oauth_states'].includes(table));
  return (await db.query('select * from public.growell_habit_sync_'+table+' order by owner_id')).rows;
}
const statePayload=(hash='a'.repeat(64),owner='owner',auth=AUTH)=>({state_hash:hash,owner_id:owner,auth_user_id:auth,verifier_cipher:'synthetic-encrypted-verifier',expires_at:new Date(Date.now()+5*60*1000).toISOString()});
const codeIs=code=>error=>error.code===code;

test('habit-sync migration executes and can be reapplied without backfilling existing habits',async()=>{
  await habit('before-connect');
  const configured=await connect();
  assert.equal(configured.enabled,true);assert.equal(configured.token_cipher,undefined);assert.equal(configured.lease_token,undefined);
  assert.deepEqual(await rows(),[]);
  await db.exec(migration);
  assert.deepEqual(await rows(),[]);
  await db.query("update public.habits set name='수정한 이전 습관' where id='before-connect'");
  assert.deepEqual(await rows(),[],'ordinary editing does not enroll an old habit');
  await asRole('authenticated',()=>habit('after-connect'));
  const queued=await rows();assert.equal(queued.length,1);assert.equal(queued[0].habit_id,'after-connect');assert.equal(queued[0].generation,GEN);
  assert.deepEqual(Object.keys(queued[0].desired).sort(),['id','user_id','name','goal','time','place','start_date','end_date','behavior_type','book_id'].sort());
  assert.equal(queued[0].desired.checked_dates,undefined);assert.equal(queued[0].desired.created_at,undefined);
});

test('actual habit triggers ignore check changes, enqueue metadata revisions and retain deletion tombstones',async()=>{
  await connect();await habit();let item=(await rows())[0];const marker=item.marker;assert.equal(item.revision,1);
  await db.query("update public.habits set checked_dates=array['2026-10-01'],updated_at=clock_timestamp() where id='new-habit'");
  item=(await rows())[0];assert.equal(item.revision,1);assert.equal(item.marker,marker);
  await db.query("update public.habits set goal='하루 20쪽',time='오전 7시',place='책상' where id='new-habit'");
  item=(await rows())[0];assert.equal(item.revision,2);assert.equal(item.marker,marker);assert.equal(item.desired.goal,'하루 20쪽');assert.equal(item.desired.time,'오전 7시');assert.equal(item.desired.place,'책상');
  await db.query("delete from public.habits where id='new-habit'");
  item=(await rows())[0];assert.equal(item.revision,3);assert.equal(item.desired,null);assert.equal(item.pending,true);assert.equal(item.marker,marker);
  const job=(await claim())[0];assert.deepEqual(await apply(job,'success',{habit_id:item.habit_id,revision:item.revision}),{applied:true});assert.deepEqual(await rows(),[]);
});

test('paused connections exclude new habits, retain edits to linked habits and require explicit import for older data',async()=>{
  await habit('old-habit');await habit('foreign-habit','other');await connect();await habit('linked-habit');
  await configure('settings',{enabled:false});await habit('while-paused');
  await db.query("update public.habits set goal='변경한 목표' where id='linked-habit'");
  assert.deepEqual((await rows()).map(item=>item.habit_id),['linked-habit']);assert.deepEqual(await claim(),[]);
  await assert.rejects(configure('import',{}),codeIs('55000'));
  await configure('settings',{enabled:true});assert.deepEqual((await rows()).map(item=>item.habit_id),['linked-habit']);
  assert.deepEqual(await configure('import',{habit_id:'old-habit'}),{queued:1});assert.equal((await rows()).length,2);
  await assert.rejects(configure('import',{habit_id:'foreign-habit'}),codeIs('42501'));
  assert.deepEqual(await configure('import',{}),{queued:3});assert.equal((await rows()).length,3);assert.ok((await rows()).every(item=>item.owner_id==='owner'));
});

test('lease, revision and connection generation checks prevent stale workers from completing newer work',async()=>{
  await connect();await habit();const first=(await claim())[0],original=first.queue[0];
  assert.ok(first.connection.lease_token);assert.equal(first.connection.token_cipher,TOKEN);assert.deepEqual(await claim(),[]);
  await assert.rejects(configure('settings',{enabled:false}),codeIs('40001'));
  assert.deepEqual(await apply(first,'guard',{habit_id:original.habit_id,revision:original.revision}),{applied:true});
  await db.query("update public.habits set goal='수정 이후의 목표' where id='new-habit'");
  assert.deepEqual(await apply(first,'guard',{habit_id:original.habit_id,revision:original.revision}),{applied:false});
  assert.deepEqual(await apply(first,'sending',{habit_id:original.habit_id,revision:original.revision}),{applied:false});
  // A previously sent create may return its task ID after an edit. Keep that
  // remote identity to avoid duplicates, but never mark the newer revision done.
  assert.deepEqual(await apply(first,'success',{habit_id:original.habit_id,revision:original.revision,task_id:'remote-task'}),{applied:true});
  let current=(await rows())[0];assert.equal(current.desired.goal,'수정 이후의 목표');assert.equal(current.pending,true);assert.equal(current.task_id,'remote-task');assert.equal(current.revision,original.revision+1);
  assert.deepEqual(await apply(first,'success',{habit_id:current.habit_id,revision:current.revision,task_id:'remote-task'}),{applied:true});assert.equal((await rows())[0].pending,false);
  await apply(first,'release');await connect(NEXT_GEN);assert.deepEqual(await rows(),[]);await configure('import',{habit_id:'new-habit'});const second=(await claim())[0];
  assert.equal(second.connection.generation,NEXT_GEN);assert.notEqual(second.connection.lease_token,first.connection.lease_token);
  assert.deepEqual(await apply(first,'success',{habit_id:'new-habit',revision:1,task_id:'stale-task'}),{applied:false});
  current=(await rows())[0];assert.equal(current.generation,NEXT_GEN);assert.equal(current.task_id,null);assert.equal(current.pending,true);
  await db.exec("update public.growell_habit_sync_connections set lease_until=clock_timestamp()-interval '1 second'");
  assert.deepEqual(await apply(second,'guard',{habit_id:'new-habit',revision:current.revision}),{applied:false});
});

test('OAuth states are single-use, expire and cannot be created for a mismatched or unapproved member',async()=>{
  const state=statePayload();assert.deepEqual(await oauth('put',state),{saved:true});
  const consumed=await oauth('consume',{state_hash:state.state_hash});assert.equal(consumed.owner_id,'owner');assert.equal(consumed.auth_user_id,AUTH);assert.equal(consumed.verifier_cipher,state.verifier_cipher);
  assert.equal(await oauth('consume',{state_hash:state.state_hash}),null);assert.deepEqual(await rows('oauth_states'),[]);
  const replacement=statePayload('b'.repeat(64));await oauth('put',state);await oauth('put',replacement);assert.equal(await oauth('consume',{state_hash:state.state_hash}),null);
  await db.exec("update public.growell_habit_sync_oauth_states set expires_at=clock_timestamp()-interval '1 second'");
  assert.equal(await oauth('consume',{state_hash:replacement.state_hash}),null);assert.deepEqual(await rows('oauth_states'),[]);
  await assert.rejects(oauth('put',statePayload('c'.repeat(64),'owner',OTHER_AUTH)),codeIs('42501'));
  await assert.rejects(oauth('put',{...statePayload(),expires_at:new Date(Date.now()+30*60*1000).toISOString()}),codeIs('22023'));
  await db.query("update public.profiles set approval_status='pending' where id='owner'");await assert.rejects(oauth('put',state),codeIs('42501'));
});

test('revocation, soft deletion and Auth identity replacement destroy credentials, states and queued work',async()=>{
  for(const change of ["approval_status='pending'","is_deleted=true","auth_user_id='55555555-5555-4555-8555-555555555555'::uuid"]){
    await db.query("update public.profiles set approval_status='approved',is_deleted=false,auth_user_id=$1::uuid where id='owner'",[AUTH]);
    await connect();await db.query("delete from public.habits where id='member-habit'");await habit('member-habit');await oauth('put',statePayload());
    assert.equal((await rows()).length,1);assert.equal((await rows('connections')).length,1);assert.equal((await rows('oauth_states')).length,1);
    await db.exec("update public.profiles set "+change+" where id='owner'");
    assert.deepEqual(await rows('connections'),[]);assert.deepEqual(await rows('oauth_states'),[]);assert.deepEqual(await rows(),[]);assert.deepEqual(await claim(),[]);
  }
});

test('disconnect rotates generation, clears sensitive fields and prevents automatic capture until reconnection',async()=>{
  await connect();await habit();await oauth('put',statePayload());const disconnected=await configure('disconnect');
  assert.notEqual(disconnected.generation,GEN);assert.equal(disconnected.enabled,false);assert.equal(disconnected.account_id,null);assert.equal(disconnected.list_id,null);
  assert.equal((await rows('connections'))[0].token_cipher,null);assert.deepEqual(await rows(),[]);assert.deepEqual(await rows('oauth_states'),[]);
  await habit('after-disconnect');assert.deepEqual(await rows(),[]);assert.deepEqual(await claim(),[]);
});

test('anonymous and authenticated roles cannot call connector RPCs or read token tables and RLS fails closed',async()=>{
  await connect();await habit();await oauth('put',statePayload());
  const policies=(await db.query("select c.relname,c.relrowsecurity,(select count(*)::integer from pg_policy p where p.polrelid=c.oid) as policies from pg_class c where c.relname in ('growell_habit_sync_connections','growell_habit_sync_queue','growell_habit_sync_oauth_states')")).rows;
  assert.equal(policies.length,3);assert.ok(policies.every(item=>item.relrowsecurity&&item.policies===0));
  for(const role of ['anon','authenticated']){
    await asRole(role,async()=>{
      for(const table of ['connections','queue','oauth_states'])await assert.rejects(rows(table),codeIs('42501'));
      for(const [name,args] of [['configure',['owner',AUTH,'disconnect',{}]],['oauth',['consume',{state_hash:'a'.repeat(64)}]],['claim',[null,5]],['apply',['owner',GEN,GEN,'guard',{}]]])await assert.rejects(rpc(name,args),codeIs('42501'));
    });
  }
  await asRole('service_role',async()=>{assert.equal((await rows('connections'))[0].token_cipher,TOKEN);await assert.rejects(db.query("select public.growell_habit_sync_enqueue('owner','new-habit',null,false)"),codeIs('42501'));});
  // Verify RLS itself as well as explicit revocations: even a future accidental
  // SELECT grant must not expose another member's encrypted credentials.
  await db.exec('grant select,insert on public.growell_habit_sync_connections,public.growell_habit_sync_queue,public.growell_habit_sync_oauth_states to anon,authenticated');
  try{
    for(const role of ['anon','authenticated'])await asRole(role,async()=>{
      for(const table of ['connections','queue','oauth_states'])assert.deepEqual(await rows(table),[]);
      await assert.rejects(db.query('insert into public.growell_habit_sync_connections(owner_id,auth_user_id,generation) values($1,$2::uuid,$3::uuid)',['other',OTHER_AUTH,NEXT_GEN]),codeIs('42501'));
    });
  }finally{await db.exec('revoke all on public.growell_habit_sync_connections,public.growell_habit_sync_queue,public.growell_habit_sync_oauth_states from anon,authenticated');}
});
});
