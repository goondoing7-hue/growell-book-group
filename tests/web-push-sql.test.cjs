'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const sql=fs.readFileSync(path.join(__dirname,'../server/web-push.sql'),'utf8');
const schedule=fs.readFileSync(path.join(__dirname,'../server/web-push-schedule.sql'),'utf8');
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',AUTHOR='33333333-3333-4333-8333-333333333333';
const HASH='a'.repeat(64),CIPHER='synthetic-encrypted-subscription-never-a-real-endpoint';
const codeIs=code=>error=>error.code===code;

describe('Opt-in web push SQL preserves authored content and fences every recipient',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false,name text default '공개 이름',email text default 'PRIVATE EMAIL');
      create table public.book_locks(book_id text primary key,locked boolean);
      create table public.posts(id text primary key,user_id text,book_id text,html text,q1 text,q2 text,q3 text,
        is_private boolean default false,visibility text default 'public',is_deleted boolean default false,deleted_at timestamptz);
      create table public.private_entries(id text primary key,user_id text,data text);
      create table public.habits(id text primary key,user_id text,data text);
      create table public.material_notes(id text primary key,user_id text,html text);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('growell_habit_sync_worker_secret','synthetic-worker-secret-not-an-operating-credential');`);
    await db.exec(sql);
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.growell_web_push_jobs,public.growell_web_push_subscriptions,public.posts,public.private_entries,public.habits,public.material_notes,public.profiles,public.book_locks');
    await db.query("insert into profiles(id,auth_user_id) values('owner',$1::uuid),('other',$2::uuid),('author',$3::uuid)",[AUTH,OTHER,AUTHOR]);
  });
  after(async()=>{await db.close();});
  async function as(role,action){await db.exec('set role '+role);try{return await action();}finally{await db.exec('reset role');}}
  async function rpc(name,args=[]){const expressions={configure:'$1,$2::uuid,$3,$4::jsonb',tick:'$1::timestamptz',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb',worker_authorized:'$1'};
    return as('service_role',async()=>{const r=await db.query('select public.growell_web_push_'+name+'('+expressions[name]+') as value',args.map(x=>x&&typeof x==='object'?JSON.stringify(x):x));return r.rows[0].value;});}
  const config=(operation='connect',payload={},owner='owner',auth=AUTH)=>rpc('configure',[owner,auth,operation,{fingerprint:HASH,...(operation==='connect'?{subscription_cipher:CIPHER}:{}),...payload}]);
  const claim=(limit=10)=>rpc('claim',[limit]);
  const apply=(job,operation,payload={})=>rpc('apply',[job.id,job.lease_token,operation,payload]);
  const jobs=()=>db.query('select * from growell_web_push_jobs order by created_at,id').then(r=>r.rows);
  const post=(id='p',owner='author',book='emotion',extra={})=>db.query(`insert into posts(id,user_id,book_id,html,q1,q2,q3,is_private,visibility,is_deleted,deleted_at)
    values($1,$2,$3,'FULL PUBLIC POST BODY','FULL QUESTION ONE','FULL QUESTION TWO','FULL QUESTION THREE',$4,$5,$6,$7::timestamptz)`,
    [id,owner,book,extra.private||false,extra.visibility||'public',extra.deleted||false,extra.deletedAt||null]);
  async function dataSnapshot(){const result={};for(const table of ['profiles','posts','private_entries','habits','material_notes'])result[table]=(await db.query('select * from '+table+' order by id')).rows;return result;}

  test('installation and repeat installation never enroll, backfill or edit any authored content',async()=>{
    await post();await db.exec("insert into private_entries values('e','owner','ENCRYPTED PRIVATE CONTENT');insert into habits values('h','owner','FULL HABIT CHECK HISTORY');insert into material_notes values('m','owner','FULL MATERIAL BODY');");
    const before=await dataSnapshot();await db.exec(sql);assert.deepEqual(await dataSnapshot(),before);assert.deepEqual(await jobs(),[]);
    await config();assert.deepEqual(await jobs(),[],'connecting does not backfill old posts');
  });
  test('approved verified owner and private server-only RPCs are mandatory',async()=>{
    await assert.rejects(config('connect',{},'owner',OTHER),codeIs('42501'));
    await db.exec("update profiles set approval_status='pending' where id='owner'");await assert.rejects(config(),codeIs('42501'));
    await db.exec("update profiles set approval_status='approved',is_deleted=true where id='owner'");await assert.rejects(config(),codeIs('42501'));
    for(const role of ['anon','authenticated'])for(const query of ['select * from growell_web_push_subscriptions','select * from growell_web_push_jobs','select public.growell_web_push_claim(10)',"select public.growell_web_push_configure('owner','"+AUTH+"','status','{}')","select public.growell_web_push_worker_authorized('not-a-secret')"])
      await assert.rejects(as(role,()=>db.exec(query)),codeIs('42501'),role+query);
  });
  test('a post queues once per opted-in device, excludes self, and never copies body or endpoint into jobs',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await config('connect',{fingerprint:'c'.repeat(64)},'author',AUTHOR);
    const before=await post();const queued=await jobs();assert.equal(queued.length,2);assert.deepEqual(new Set(queued.map(j=>j.owner_id)),new Set(['owner','other']));
    const encoded=JSON.stringify(queued);for(const secret of ['FULL PUBLIC POST BODY','FULL QUESTION','PRIVATE EMAIL',CIPHER,'https://'])assert.equal(encoded.includes(secret),false,secret);
    await db.exec("update posts set html='EDITED ORIGINAL',q1='EDITED QUESTION' where id='p'");assert.equal((await jobs()).length,2);
    const originals=await dataSnapshot();const work=(await claim())[0],snapshot=await apply(work,'snapshot');assert.equal(snapshot.applied,true);assert.equal(snapshot.subscription_cipher,CIPHER);assert.equal(snapshot.endpoint_hash.length,64);assert.equal(snapshot.expires_at!==null,true);
    assert.equal(JSON.stringify(snapshot).includes('EDITED ORIGINAL'),false);assert.deepEqual(await dataSnapshot(),originals);
  });
  test('private, deleted and unapproved authors are excluded at insert and before delivery',async()=>{
    await config();for(const [id,extra] of [['private',{private:true}],['hidden',{visibility:'private'}],['deleted',{deleted:true}],['tombstone',{deletedAt:'2026-10-10'}]])await post(id,'author','emotion',extra);
    await db.exec("update profiles set approval_status='pending' where id='author'");await post('pending');assert.equal((await jobs()).length,0);
    await db.exec("update profiles set approval_status='approved' where id='author'");await post('public');let work=(await claim())[0];await db.exec("update posts set is_private=true where id='public'");assert.deepEqual(await apply(work,'prepare'),{applied:false});
    await post('public2');work=(await claim())[0];await db.exec("update profiles set is_deleted=true where id='author'");assert.deepEqual(await apply(work,'prepare'),{applied:false});
  });
  test('book lock defaults and later lock changes protect members while operators retain permission',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await db.exec("update profiles set is_admin=true where id='other'");
    await post('unknown','author','unopened');assert.deepEqual((await jobs()).map(j=>j.owner_id),['other']);
    await post('open');let work=(await claim()).find(j=>j.post_id==='open');await db.exec("insert into book_locks values('emotion',true)");
    if((await db.query('select owner_id from growell_web_push_jobs where id=$1::uuid',[work.id])).rows[0].owner_id==='owner')assert.deepEqual(await apply(work,'prepare'),{applied:false});
    const admin=(await jobs()).find(j=>j.owner_id==='other'&&j.post_id==='open');assert.equal(admin.status,'claimed');assert.equal((await apply(admin,'prepare')).applied,true);
  });
  test('approval revocation, disconnect, disabled preference and changed post category cancel a claimed send',async()=>{
    for(const change of ["update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set new_posts=false","update posts set book_id='other' where id='p'"]){
      await config();await post();const work=(await claim())[0];await db.exec(change);assert.deepEqual(await apply(work,'prepare'),{applied:false},change);
      await db.exec("update profiles set approval_status='approved',is_deleted=false;truncate growell_web_push_jobs,growell_web_push_subscriptions,posts");
    }
  });
  test('explicit endpoint transfer cannot be used by the previous account to send, view, disable or reclaim it',async()=>{
    await config();await post();const old=(await claim())[0];const before=await dataSnapshot();
    const transferred=await config('connect',{subscription_cipher:CIPHER+'-new-account'},'other',OTHER);assert.equal(transferred.connected,true);
    assert.deepEqual(await apply(old,'prepare'),{applied:false});const previous=await config('status');assert.equal(previous.connected,false);assert.equal(previous.deviceId,null);
    for(const operation of ['settings','disconnect','test'])await assert.rejects(config(operation),codeIs('42501'));
    assert.equal((await config('status',{},'other',OTHER)).connected,true);assert.deepEqual(await dataSnapshot(),before);
  });
  test('same-account reconnect preserves OFF preferences and invalidates old claims',async()=>{
    await config();await post();const old=(await claim())[0];await config('settings',{new_posts:false,daily_verse:false});const reconnected=await config('connect',{new_posts:true,daily_verse:true});
    assert.equal(reconnected.newPosts,false);assert.equal(reconnected.dailyVerse,false);assert.deepEqual(await apply(old,'prepare'),{applied:false});
    await config('disconnect');assert.equal((await config('status')).connected,false);assert.equal((await db.query('select subscription_cipher from growell_web_push_subscriptions')).rows[0].subscription_cipher,null);
    const afterDisconnect=await config('connect',{new_posts:true,daily_verse:true});assert.equal(afterDisconnect.newPosts,false);assert.equal(afterDisconnect.dailyVerse,false);
    const explicitSettings=await config('settings',{new_posts:true,daily_verse:true});assert.equal(explicitSettings.newPosts,true);assert.equal(explicitSettings.dailyVerse,true);
  });
  test('only explicit boolean preferences and bounded encrypted subscriptions are accepted',async()=>{
    await assert.rejects(config('connect',{subscription_cipher:'short'}),codeIs('22023'));
    await assert.rejects(config('connect',{new_posts:'true'}),codeIs('22023'));
    await assert.rejects(config('connect',{recipient:'other'}),codeIs('22023'));
    assert.equal((await config('status',{fingerprint:''})).connected,false);
    for(let n=0;n<5;n++)await config('connect',{fingerprint:String(n).repeat(64)});
    await assert.rejects(config('connect',{fingerprint:'f'.repeat(64)}),codeIs('54000'));
    assert.equal((await config('connect',{fingerprint:'0'.repeat(64)})).connected,true,'same device does not consume another slot');
  });
  test('test alerts are durable, bounded to one per minute and never require public-post content',async()=>{
    await config();await config('test');await assert.rejects(config('test'),codeIs('54000'));
    const testJob=(await claim())[0];assert.equal(testJob.kind,'test');
    assert.equal((await apply(testJob,'snapshot')).post_id,null);assert.equal((await apply(testJob,'prepare')).applied,true);assert.deepEqual(await apply(testJob,'accepted'),{applied:true});assert.deepEqual(await claim(),[]);
    await config('connect',{new_posts:true,daily_verse:true});await assert.rejects(config('test'),codeIs('54000'),'reconnect cannot bypass cooldown');
  });
  test('the Korean-day verse window queues once per device and never catches up after the window',async()=>{
    await config();const day=(await db.query("select (clock_timestamp() at time zone 'Asia/Seoul')::date::text as day")).rows[0].day;
    assert.equal((await rpc('tick',[day+'T08:59:59+09:00'])).queued,0);assert.equal((await rpc('tick',[day+'T09:00:00+09:00'])).queued,1);
    assert.equal((await rpc('tick',[day+'T09:14:59+09:00'])).queued,0);assert.equal((await rpc('tick',[day+'T09:15:00+09:00'])).queued,0);
    const queued=(await jobs())[0];assert.equal(queued.source_key,day);assert.equal(new Date(queued.verse_day).toISOString(),day+'T00:00:00.000Z');
    assert.equal(new Date(queued.expires_at).toISOString(),new Date(day+'T10:00:00+09:00').toISOString());
    await config('settings',{daily_verse:false});assert.equal((await rpc('tick',['2099-10-17T09:00:00+09:00'])).queued,0);
  });
  test('yesterday verses and expired new-post jobs are cancelled before provider delivery',async()=>{
    await config();await rpc('tick',['2000-01-01T09:00:00+09:00']);await post();await db.exec("update growell_web_push_jobs set available_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await claim(),[]);assert.equal((await jobs()).every(j=>j.status==='cancelled'),true);
  });
  test('a verse cannot use an extended expiry to deliver yesterday, and its OFF preference is checked again',async()=>{
    await config();await rpc('tick',['2000-01-01T09:00:00+09:00']);await db.exec("update growell_web_push_jobs set expires_at=clock_timestamp()+interval '1 hour',available_at=clock_timestamp()-interval '1 minute'");
    assert.deepEqual(await claim(),[]);assert.equal((await jobs())[0].last_error,'not-eligible');
    await db.exec('truncate growell_web_push_jobs');
    const day=(await db.query("select (clock_timestamp() at time zone 'Asia/Seoul')::date::text as day")).rows[0].day;
    await rpc('tick',[day+'T09:00:00+09:00']);await db.exec("update growell_web_push_jobs set expires_at=clock_timestamp()+interval '1 hour',available_at=clock_timestamp()-interval '1 minute'");
    const work=(await claim())[0];assert.equal(work.kind,'verse');assert.equal((await apply(work,'snapshot')).applied,true);
    await config('settings',{daily_verse:false});assert.deepEqual(await apply(work,'prepare'),{applied:false});
  });
  test('retry uses backoff, expired claims recover, stale leases cannot send and five failures stop',async()=>{
    await config();await post();let work=(await claim())[0];await apply(work,'retry',{error_code:'rate-limited',retry_after:1});assert.deepEqual(await claim(),[]);
    await db.exec("update growell_web_push_jobs set available_at=clock_timestamp()-interval '1 second'");let newer=(await claim())[0];assert.notEqual(newer.lease_token,work.lease_token);assert.deepEqual(await apply(work,'prepare'),{applied:false});
    for(let attempt=2;attempt<=5;attempt++){
      assert.equal(newer.attempts,attempt);await apply(newer,'retry',{error_code:'push-unavailable',retry_after:60});await db.exec("update growell_web_push_jobs set available_at=clock_timestamp()-interval '1 second'");if(attempt<5)newer=(await claim())[0];
    }
    assert.deepEqual(await claim(),[]);assert.equal((await jobs())[0].status,'review');
  });
  test('accepted and uncertain provider outcomes never resend, and a dead endpoint deactivates only its generation',async()=>{
    await config();await post('sent');let work=(await claim())[0];await apply(work,'prepare');await apply(work,'accepted');assert.deepEqual(await claim(),[]);
    await post('uncertain');work=(await claim())[0];await apply(work,'prepare');await apply(work,'uncertain');assert.deepEqual(await claim(),[]);
    await post('crash');work=(await claim())[0];await apply(work,'prepare');await db.exec("update growell_web_push_jobs set lease_until=clock_timestamp()-interval '1 second' where status='sending'");assert.deepEqual(await claim(),[]);
    await post('gone');work=(await claim())[0];await apply(work,'prepare');await config();await apply(work,'gone');assert.equal((await config('status')).connected,true,'old provider response cannot disable replacement subscription');
    await post('current-gone');work=(await claim())[0];await apply(work,'prepare');await apply(work,'gone');assert.equal((await config('status')).connected,false);
  });
  test('every delivery transition preserves original posts, private entries, habits and resources byte-for-byte',async()=>{
    await config();await post();await db.exec("insert into private_entries values('e','owner','PRIVATE ENCRYPTED ORIGINAL');insert into habits values('h','owner','HISTORY ORIGINAL');insert into material_notes values('m','owner','MATERIAL ORIGINAL');");
    const before=await dataSnapshot(),work=(await claim())[0];await apply(work,'snapshot');await apply(work,'prepare');await apply(work,'accepted');await config('disconnect');assert.deepEqual(await dataSnapshot(),before);
  });
  test('worker authorization fails closed for absent or duplicate Vault definitions',async()=>{
    assert.equal(await rpc('worker_authorized',['synthetic-worker-secret-not-an-operating-credential']),true);assert.equal(await rpc('worker_authorized',['incorrect-worker-secret-with-sufficient-length']),false);
    await db.exec("insert into vault.decrypted_secrets values('growell_habit_sync_worker_secret','duplicate-secret-with-enough-characters')");assert.equal(await rpc('worker_authorized',['synthetic-worker-secret-not-an-operating-credential']),false);
    await db.exec("delete from vault.decrypted_secrets where decrypted_secret='duplicate-secret-with-enough-characters'");
    await assert.rejects(claim(21),codeIs('22023'));assert.match(schedule,/https:\/\/growell-book\.vercel\.app\/api\/web-push\?action=worker/);assert.match(schedule,/'\* \* \* \* \*'/);assert.match(schedule,/x-growell-worker-secret/);assert.equal(schedule.includes('eyJ'),false);
  });
});
