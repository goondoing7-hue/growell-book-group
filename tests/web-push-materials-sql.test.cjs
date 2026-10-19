'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const base=fs.readFileSync(path.join(__dirname,'../server/web-push.sql'),'utf8');
const migration=fs.readFileSync(path.join(__dirname,'../server/web-push-materials.sql'),'utf8');
const verification=fs.readFileSync(path.join(__dirname,'../server/web-push-materials-verification.sql'),'utf8');
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',AUTHOR='33333333-3333-4333-8333-333333333333',ADMIN='44444444-4444-4444-8444-444444444444';
const HASH='a'.repeat(64),CIPHER='synthetic-cipher-is-not-an-operating-subscription';
function definition(sql,name){const start=sql.indexOf('create or replace function public.'+name+'('),end=sql.indexOf('$function$;',start);assert.ok(start>=0&&end>start);return sql.slice(start,end+'$function$;'.length);}

test('base installation and additive migration share the exact material eligibility and worker guards',()=>{
  for(const name of ['growell_web_push_eligible','growell_web_push_capture_material','growell_web_push_claim','growell_web_push_apply'])assert.equal(definition(migration,name),definition(base,name),name);
  assert.doesNotMatch(migration,/\b(?:insert\s+into|update|delete\s+from|truncate)\s+(?:public\.)?(?:posts|material_notes|private_entries|habits|profiles)\b/i);
  assert.match(migration,/after insert on public\.material_notes/);assert.doesNotMatch(migration,/after update|http_post|http_get/i);
  assert.match(verification,/read only/);assert.doesNotMatch(verification,/select\s+\*|\b(?:insert|update|delete|truncate)\b/i);
});

describe('Resource push SQL extends only new public material insertions',()=>{
  let db;
  before(async()=>{
    db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false);
      create table book_locks(book_id text primary key,locked boolean);
      create table posts(id text primary key,user_id text,book_id text,html text);
      create table material_notes(id text primary key,user_id text,book_id text,title text,html text,drive_links jsonb,created_at bigint,updated_at bigint,
        is_private boolean default false,visibility text default 'public',is_deleted boolean default false,deleted_at timestamptz);
      create table private_entries(id text primary key,user_id text,data text);create table habits(id text primary key,user_id text,data text);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);`);
    await db.exec(base);
  });
  async function reset(){await db.exec('reset role;truncate growell_web_push_jobs,growell_web_push_subscriptions,posts,material_notes,private_entries,habits,profiles,book_locks');await db.query("insert into profiles(id,auth_user_id,is_admin) values('owner',$1,false),('other',$2,false),('author',$3,true),('admin',$4,true)",[AUTH,OTHER,AUTHOR,ADMIN]);}
  beforeEach(reset);after(async()=>{await db.close();});
  async function rpc(name,args){await db.exec('set role service_role');try{const types={configure:'$1,$2::uuid,$3,$4::jsonb',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb'};return (await db.query('select public.growell_web_push_'+name+'('+types[name]+') as value',args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;}finally{await db.exec('reset role');}}
  const config=(operation='connect',payload={},owner='owner',auth=AUTH)=>rpc('configure',[owner,auth,operation,{fingerprint:HASH,...(operation==='connect'?{subscription_cipher:CIPHER}:{}),...payload}]);
  const claim=()=>rpc('claim',[20]),apply=(job,operation,payload={})=>rpc('apply',[job.id,job.lease_token,operation,payload]);
  const jobs=()=>db.query('select * from growell_web_push_jobs order by kind,source_key,owner_id').then(result=>result.rows);
  const material=(id='m',book='emotion',owner='author',extra={})=>db.query(`insert into material_notes(id,user_id,book_id,title,html,drive_links,created_at,updated_at,is_private,visibility,is_deleted,deleted_at)
    values($1,$2,$3,'PRIVATE ORIGINAL TITLE','COMPLETE ORIGINAL MATERIAL BODY','[{"url":"https://example.test/original-file"}]',1700000000000,1700000000001,$4,$5,$6,$7)`,[id,owner,book,extra.private||false,extra.visibility||'public',extra.deleted||false,extra.deletedAt||null]);
  async function originals(){const result={};for(const table of ['profiles','posts','material_notes','private_entries','habits'])result[table]=(await db.query('select * from '+table+' order by id')).rows;return result;}

  test('upgrade and repeat upgrade leave existing sources, preferences and pending or sending jobs byte-for-byte intact without backfill',async()=>{
    await material('old');await db.exec("insert into private_entries values('private','owner','ENCRYPTED ORIGINAL');insert into habits values('habit','owner','COMPLETE HISTORY');");
    await config();await db.exec("insert into posts values('p','author','emotion','ORIGINAL POST')");const sending=(await claim())[0];await apply(sending,'prepare');
    await config('test');await config('settings',{daily_verse:false});
    // Reconstruct the deployed pre-material shape without changing any source or job row.
    await db.exec("drop trigger growell_web_push_new_material on material_notes;alter table growell_web_push_jobs drop column material_id;alter table growell_web_push_jobs drop constraint growell_web_push_jobs_kind_check;alter table growell_web_push_jobs add constraint growell_web_push_jobs_kind_check check(kind in ('post','verse','test'))");
    const before=await originals(),oldJobs=(await jobs()),preferences=(await db.query('select * from growell_web_push_subscriptions')).rows;
    await db.exec(migration);await db.exec(migration);
    const afterJobs=(await jobs()).map(({material_id,...row})=>row);assert.deepEqual(afterJobs,oldJobs);assert.deepEqual(await originals(),before);assert.deepEqual((await db.query('select * from growell_web_push_subscriptions')).rows,preferences);
    assert.equal((await jobs()).some(job=>job.kind==='material'),false);assert.equal((await jobs()).find(job=>job.id===sending.id).status,'sending');
    await db.exec(verification);assert.deepEqual(await originals(),before);
  });
  test('base reinstallation retains the material column and one INSERT-only trigger and never notifies old materials',async()=>{
    await material('old');await config();const before=await originals();await db.exec(migration);await db.exec(base);await db.exec(base);assert.deepEqual(await originals(),before);assert.deepEqual(await jobs(),[]);
    const triggers=(await db.query("select tgname from pg_trigger where not tgisinternal and tgrelid='material_notes'::regclass and tgname='growell_web_push_new_material'")).rows;assert.equal(triggers.length,1);
    await material('new');assert.equal((await jobs()).length,1);assert.equal((await jobs())[0].material_id,'new');
  });
  test('a new material queues once per opted-in device, excludes its author and keeps all original content outside jobs and snapshots',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await config('connect',{fingerprint:'c'.repeat(64)},'author',AUTHOR);await config('connect',{fingerprint:'d'.repeat(64),new_posts:false},'admin',ADMIN);
    await material();await db.exec("insert into posts values('m','author','emotion','ORIGINAL POST BODY')");const queued=await jobs();assert.equal(queued.length,4);assert.deepEqual(queued.filter(job=>job.kind==='material').map(job=>job.owner_id),['other','owner']);
    assert.equal(queued.filter(job=>job.kind==='material').every(job=>job.material_id==='m'&&job.post_id===null),true);
    const before=await originals(),work=(await claim()).find(job=>job.kind==='material'),snapshot=await apply(work,'snapshot');assert.equal(snapshot.kind,'material');assert.equal(snapshot.material_id,'m');assert.equal(snapshot.post_id,null);assert.equal(snapshot.book_id,'emotion');assert.equal(snapshot.applied,true);
    for(const secret of ['PRIVATE ORIGINAL TITLE','COMPLETE ORIGINAL MATERIAL BODY','original-file',CIPHER,'ORIGINAL POST BODY'])assert.equal(JSON.stringify(queued).includes(secret),false,secret);
    for(const secret of ['PRIVATE ORIGINAL TITLE','COMPLETE ORIGINAL MATERIAL BODY','original-file','ORIGINAL POST BODY'])assert.equal(JSON.stringify(snapshot).includes(secret),false,secret);
    assert.equal((await apply(work,'prepare')).applied,true);await apply(work,'accepted');assert.deepEqual(await originals(),before);
  });
  test('editing and upsert updates do not create another alert and unchanged material IDs are deduplicated',async()=>{
    await config();await material();const first=await jobs();await db.exec("update material_notes set title='EDITED TITLE',html='EDITED BODY',drive_links='[]',updated_at=1700000000002 where id='m';insert into material_notes(id,user_id,book_id,html) values('m','author','emotion','UPDATED AGAIN') on conflict(id) do update set html=excluded.html");
    assert.deepEqual(await jobs(),first);assert.equal((await db.query("select html from material_notes where id='m'")).rows[0].html,'UPDATED AGAIN');
  });
  test('private, deleted, missing-book and inactive-author materials are never initially queued',async()=>{
    await config();for(const [id,extra] of [['private',{private:true}],['hidden',{visibility:'private'}],['deleted',{deleted:true}],['tombstone',{deletedAt:'2026-10-01'}]])await material(id,'emotion','author',extra);
    await material('missing',null);await material('no-author','emotion',null);await db.exec("update profiles set approval_status='pending' where id='author'");await material('pending-author');await db.exec("update profiles set approval_status='approved',is_deleted=true where id='author'");await material('deleted-author');assert.deepEqual(await jobs(),[]);
  });
  test('recipient ownership, generation, approval and OFF settings remain common fences for the material OR branch',async()=>{
    for(const change of ["update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update profiles set auth_user_id='55555555-5555-4555-8555-555555555555' where id='owner'","update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set new_posts=false","update growell_web_push_subscriptions set subscription_cipher=null"]){
      await reset();await config();await db.exec(change);await material();assert.deepEqual(await jobs(),[],change);
    }
    await reset();await config();const device=(await db.query('select id,generation from growell_web_push_subscriptions')).rows[0];await material();await config();
    assert.equal((await db.query("select public.growell_web_push_eligible($1::uuid,'material','m',$2::uuid) as value",[device.id,device.generation])).rows[0].value,false);assert.deepEqual(await claim(),[]);
  });
  test('every source and recipient permission is checked again after snapshot and immediately before send',async()=>{
    for(const change of ["update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update profiles set approval_status='pending' where id='author'","update profiles set is_deleted=true where id='author'","update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set new_posts=false","update material_notes set is_private=true where id='m'","update material_notes set visibility='private' where id='m'","update material_notes set is_deleted=true where id='m'","update material_notes set deleted_at=clock_timestamp() where id='m'","update material_notes set book_id='thought' where id='m'","delete from material_notes where id='m'","insert into book_locks values('emotion',true)"]){
      await reset();await config();await material();const work=(await claim())[0];assert.equal((await apply(work,'snapshot')).applied,true);await db.exec(change);assert.deepEqual(await apply(work,'prepare'),{applied:false},change);assert.equal((await jobs())[0].status,'cancelled');
    }
  });
  test('book lock defaults remain closed and administrators retain their current read permissions',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'admin',ADMIN);await material('closed','thought');assert.deepEqual((await jobs()).map(job=>job.owner_id),['admin']);
    await db.exec("insert into book_locks values('thought',false)");await material('open','thought');const work=(await claim()).find(job=>job.material_id==='open'&&(job.id!==null));
    await db.exec("update book_locks set locked=true where book_id='thought'");const owner=(await jobs()).find(job=>job.owner_id==='owner');assert.deepEqual(await apply(owner,'prepare'),{applied:false});
    const admin=(await jobs()).find(job=>job.owner_id==='admin'&&job.material_id==='open');assert.equal((await apply(admin,'prepare')).applied,true);
  });
  test('moves and deletions before claim, endpoint transfers and expiry cancel material jobs without changing authored content',async()=>{
    for(const change of ["update material_notes set book_id='thought' where id='m'","delete from material_notes where id='m'","update growell_web_push_jobs set expires_at=clock_timestamp()-interval '1 second'"]){await reset();await config();await material();await db.exec(change);const before=await originals();assert.deepEqual(await claim(),[]);assert.equal((await jobs())[0].status,'cancelled');assert.deepEqual(await originals(),before);}
    await reset();await config();await material();const work=(await claim())[0],before=await originals();await config('connect',{},'other',OTHER);assert.deepEqual(await apply(work,'prepare'),{applied:false});assert.deepEqual(await originals(),before);
  });
  test('new trigger helper and private queues never become executable or readable by browser roles',async()=>{
    await config();await material();for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{for(const query of ['select * from growell_web_push_jobs',"select public.growell_web_push_eligible(null,'material','m')",'select public.growell_web_push_capture_material()'])await assert.rejects(db.exec(query),error=>error.code==='42501');}finally{await db.exec('reset role');}}
  });
});
