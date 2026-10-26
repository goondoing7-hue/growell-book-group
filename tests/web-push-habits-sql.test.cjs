'use strict';
const {test,describe,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=n=>fs.readFileSync(path.join(__dirname,'../server/'+n),'utf8');
const migration=read('web-push-habits.sql'),verification=read('web-push-habits-verification.sql');
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const DAY='2026-10-26',HASH='a'.repeat(64),CIPHER='synthetic-cipher-is-not-a-real-push-subscription';
const codeIs=code=>error=>error.code===code;
// All source records, dates, devices and clocks in this suite are synthetic.
test('habit upgrade never writes member data, sends network traffic, replaces cron, or backfills a queue',()=>{
  assert.doesNotMatch(migration,/\b(?:insert\s+into|update|delete\s+from|truncate)\s+(?:public\.)?(?:habits|profiles|posts|private_entries|material_notes|growell_meeting_records)\b/i);
  assert.doesNotMatch(migration,/http_post|http_get|cron\.schedule|create policy|alter table public\.habits/i);
  assert.doesNotMatch(verification.replace(/'(?:''|[^'])*'/g,"''"),/select\s+\*|\b(?:insert|update|delete|truncate)\b/i);
});
describe('23:00 KST habit reminders use live today eligibility and durable per-device deduplication',()=>{
  let db;
  const clockSql="create schema test_clock;create table test_clock.clock(now timestamptz);insert into test_clock.clock values('2026-10-26T23:00:00+09:00');create function test_clock.now() returns timestamptz language sql stable as $$select now from test_clock.clock$$;";
  const syntheticClock=sql=>sql.replace(/clock_timestamp\(\)/g,'test_clock.now()');
  before(async()=>{
    db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;${clockSql}
      create table profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false);
      create table book_locks(book_id text primary key,locked boolean);
      create table posts(id text primary key,user_id text,book_id text,html text);
      create table material_notes(id text primary key,user_id text,book_id text,html text);
      create table private_entries(id text primary key,user_id text,data text);
      create table habits(id text primary key,user_id text,book_id text,name text,goal text,start_date text,end_date text,weekdays integer[],checked_dates text[],created_at bigint,is_deleted boolean default false,deleted_at timestamptz);
      create table growell_meeting_records(id uuid primary key,book_id text,round integer,status text,user_id text,deleted_at timestamptz);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);`);
    for(const file of ['web-push.sql','web-push-materials.sql','web-push-meetings.sql','web-push-habits.sql'])await db.exec(syntheticClock(read(file)));
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate growell_web_push_jobs,growell_web_push_subscriptions,growell_web_push_meeting_publications,posts,material_notes,private_entries,habits,growell_meeting_records,profiles,book_locks');
    await db.exec("update test_clock.clock set now='2026-10-26T23:00:00+09:00'");
    await db.query("insert into profiles(id,auth_user_id) values('owner',$1::uuid),('other',$2::uuid)",[AUTH,OTHER]);
  });
  after(async()=>{await db?.close();});
  async function as(role,action){await db.exec('set role '+role);try{return await action();}finally{await db.exec('reset role');}}
  async function rpc(name,args=[]){const types={configure:'$1,$2::uuid,$3,$4::jsonb',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb',tick:'$1::timestamptz'};return as('service_role',async()=>{const r=await db.query('select public.growell_web_push_'+name+'('+types[name]+') as value',args.map(v=>v&&typeof v==='object'?JSON.stringify(v):v));return r.rows[0].value;});}
  const config=(op='connect',extra={},owner='owner',auth=AUTH)=>rpc('configure',[owner,auth,op,{fingerprint:HASH,...(op==='connect'?{subscription_cipher:CIPHER}:{}),...extra}]);
  const tick=(at=DAY+'T23:00:00+09:00')=>rpc('tick',[at]);
  const claim=()=>rpc('claim',[20]),apply=(j,op,p={})=>rpc('apply',[j.id,j.lease_token,op,p]);
  const jobs=()=>db.query('select * from growell_web_push_jobs order by owner_id,subscription_id').then(r=>r.rows);
  const clock=at=>db.query('update test_clock.clock set now=$1::timestamptz',[at]);
  const habit=(extra={})=>{const h={id:'h',owner:'owner',book:'emotion',start:null,end:null,weekdays:[0,1,2,3,4,5,6],checked:[],...extra};return db.query("insert into habits(id,user_id,book_id,name,goal,start_date,end_date,weekdays,checked_dates,created_at) values($1,$2,$3,'FULL ORIGINAL HABIT','FULL GOAL',$4,$5,$6::integer[],$7::text[],1234)",[h.id,h.owner,h.book,h.start,h.end,h.weekdays,h.checked]);};
  async function snapshot(){const out={};for(const t of ['profiles','habits','posts','private_entries','material_notes','growell_meeting_records'])out[t]=(await db.query('select * from '+t+' order by id')).rows;return out;}
  test('installation/reinstallation preserve every source, preference and existing queued job without dispatch',async()=>{
    await config();await config('settings',{new_posts:false,daily_verse:false,habit_check:false});await habit();await db.exec("insert into private_entries values('e','owner','FULL PRIVATE CIPHERTEXT')");
    const before=await snapshot(),devices=(await db.query('select * from growell_web_push_subscriptions')).rows;
    await db.exec(syntheticClock(migration));assert.deepEqual(await snapshot(),before);assert.deepEqual((await db.query('select * from growell_web_push_subscriptions')).rows,devices);assert.deepEqual(await jobs(),[]);
  });
  test('no habit, another owner habit, all checks complete and unscheduled habits never queue',async()=>{
    await config();assert.equal((await tick()).queued,0);await habit({owner:'other'});assert.equal((await tick()).queued,0);
    await habit({id:'done',checked:[DAY]});await habit({id:'rest',weekdays:[0,2,3,4,5,6]});await habit({id:'future',start:'2026-10-27'});await habit({id:'ended',end:'2026-10-25'});
    assert.equal((await tick()).queued,0);assert.deepEqual(await jobs(),[]);
  });
  test('today unchecked habits queue once per active device and never copy source text or checks',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)});await habit();await habit({id:'h2',checked:[DAY]});
    const before=await snapshot();assert.equal((await tick()).queued,2);assert.equal((await tick()).queued,0);
    const queued=await jobs();assert.equal(queued.length,2);for(const job of queued){assert.equal(job.kind,'habit');assert.equal(job.source_key,DAY);assert.equal(new Date(job.expires_at).toISOString(),'2026-10-26T14:30:00.000Z');}
    assert.doesNotMatch(JSON.stringify(queued),/FULL ORIGINAL|FULL GOAL|PRIVATE CIPHERTEXT|synthetic-cipher|checked_dates/);
    const work=await claim();assert.equal(work.length,2);for(const j of work){assert.equal((await apply(j,'snapshot')).habit_day,DAY);assert.equal((await apply(j,'prepare')).applied,true);await apply(j,'accepted');}
    assert.equal((await tick()).queued,0);assert.deepEqual(await claim(),[]);assert.deepEqual(await snapshot(),before);
  });
  test('23:00 inclusion, 23:15 queue cutoff, 23:30 expiry and Korean-day rollover are enforced',async()=>{
    await config();await habit();await clock(DAY+'T22:59:59+09:00');assert.equal((await tick(DAY+'T22:59:59+09:00')).queued,0);
    await clock(DAY+'T23:00:00+09:00');assert.equal((await tick()).queued,1);
    await clock(DAY+'T23:14:59+09:00');await config('connect',{fingerprint:'b'.repeat(64)});assert.equal((await tick(DAY+'T23:14:59+09:00')).queued,1);
    await clock(DAY+'T23:15:00+09:00');await config('connect',{fingerprint:'c'.repeat(64)});assert.equal((await tick(DAY+'T23:15:00+09:00')).queued,0);
    await clock(DAY+'T23:30:00+09:00');assert.deepEqual(await claim(),[]);assert.equal((await jobs()).every(j=>j.status==='cancelled'),true);
    await clock('2026-10-27T00:00:00+09:00');assert.equal((await tick('2026-10-27T00:00:00+09:00')).queued,0);
  });
  test('live completion before claim or prepare cancels the already queued reminder',async()=>{
    await config();await habit();await tick();await db.query('update habits set checked_dates=$1::text[]',[[DAY]]);assert.deepEqual(await claim(),[]);assert.equal((await jobs())[0].status,'cancelled');
    await db.exec('truncate growell_web_push_jobs;update habits set checked_dates=ARRAY[]::text[]');await tick();const j=(await claim())[0];assert.equal((await apply(j,'snapshot')).applied,true);
    await db.query('update habits set checked_dates=$1::text[]',[[DAY]]);assert.deepEqual(await apply(j,'prepare'),{applied:false});
  });
  test('revoked approval, device OFF, habit preference OFF, lock and removed schedule cancel before sending',async()=>{
    for(const change of ["update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set habit_check=false","insert into book_locks values('emotion',true)","update habits set weekdays=ARRAY[2]","update habits set end_date='2026-10-25'","update habits set is_deleted=true"]){
      await config();await habit({id:change});await tick();const j=(await claim())[0];await db.exec(change);assert.deepEqual(await apply(j,'prepare'),{applied:false},change);
      await db.exec("truncate growell_web_push_jobs,growell_web_push_subscriptions,habits,book_locks;update profiles set approval_status='approved',is_deleted=false");
    }
  });
  test('invalid dates and weekday lists fail closed while null legacy schedule values mean every day',async()=>{
    await config();for(const extra of [{id:'badstart',start:'2026-02-31'},{id:'badend',end:'not-a-date'},{id:'empty',weekdays:[]},{id:'invalid',weekdays:[1,99]},{id:'nullitem',weekdays:[1,null]}])await habit(extra);
    assert.equal((await tick()).queued,0);await habit({id:'legacy',weekdays:null});assert.equal((await tick()).queued,1);
  });
  test('reconnect keeps OFF choices and generation fencing without requeueing the same endpoint and day',async()=>{
    await config();await habit();await tick();const old=(await claim())[0];await config('settings',{habit_check:false,new_posts:false});
    const saved=await config('connect',{habit_check:true,new_posts:true,daily_verse:false});assert.equal(saved.habitCheck,false);assert.equal(saved.newPosts,false);assert.equal(saved.dailyVerse,true);
    assert.deepEqual(await apply(old,'prepare'),{applied:false});await config('settings',{habit_check:true});assert.equal((await tick()).queued,0);
    await config('connect',{},'other',OTHER);const stale=await config('status');assert.equal(stale.deviceId,null);assert.equal(stale.connected,false);
  });
  test('private RPCs stay blocked for anonymous and member roles; malformed settings cannot change preferences',async()=>{
    await config();for(const role of ['anon','authenticated'])for(const q of ["select public.growell_web_push_habit_pending('owner','2026-10-26')","select public.growell_web_push_habit_date('2026-10-26')","select public.growell_web_push_tick()","select * from public.growell_web_push_jobs"])await assert.rejects(as(role,()=>db.exec(q)),codeIs('42501'));
    for(const habit_check of [null,1,'true',{},[]])await assert.rejects(config('settings',{habit_check}),codeIs('22023'));
    assert.equal((await config('status')).habitCheck,true);
  });
  test('existing verse scheduling and post/material/meeting kinds still work after the extension',async()=>{
    await config();await clock(DAY+'T09:00:00+09:00');assert.equal((await tick(DAY+'T09:00:00+09:00')).queued,1);assert.equal((await jobs())[0].kind,'verse');
    await db.exec("insert into posts values('p','other','emotion','FULL POST');insert into material_notes values('m','other','emotion','FULL MATERIAL')");
    await db.exec("update profiles set is_admin=true where id='other';insert into growell_meeting_records values('33333333-3333-4333-8333-333333333333','emotion',2,'published','other',null)");
    const work=await claim();assert.deepEqual(new Set(work.map(j=>j.kind)),new Set(['verse','post','material','meeting']));for(const j of work){assert.equal((await apply(j,'prepare')).applied,true);await apply(j,'accepted');}
  });
  test('the production date columns and JSONB check history use the same eligibility without mutating checks',async()=>{
    await config();await habit({start:'2026-10-26',end:'2026-10-26',checked:['2026-10-25']});
    await db.exec('alter table habits alter column start_date type date using start_date::date;alter table habits alter column end_date type date using end_date::date;alter table habits alter column checked_dates type jsonb using to_jsonb(checked_dates)');
    const before=await snapshot();assert.equal((await tick()).queued,1);const j=(await claim())[0];assert.equal((await apply(j,'snapshot')).habit_day,DAY);
    await db.query('update habits set checked_dates=$1::jsonb',[JSON.stringify(['2026-10-25',DAY])]);assert.deepEqual(await apply(j,'prepare'),{applied:false});
    const after=await snapshot();assert.deepEqual(after.habits[0].checked_dates,['2026-10-25',DAY]);for(const key of Object.keys(before))if(key!=='habits')assert.deepEqual(after[key],before[key]);
  });
});
