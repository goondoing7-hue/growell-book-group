'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=name=>fs.readFileSync(path.join(__dirname,'../server/'+name),'utf8');
const base=read('web-push.sql'),materials=read('web-push-materials.sql'),migration=read('web-push-meetings.sql'),verification=read('web-push-meetings-verification.sql');
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',AUTHOR='33333333-3333-4333-8333-333333333333',ADMIN='44444444-4444-4444-8444-444444444444';
const ID='55555555-5555-4555-8555-555555555555',ID2='66666666-6666-4666-8666-666666666666';
const HASH='a'.repeat(64),CIPHER='synthetic-cipher-is-not-an-operating-subscription';
function definition(sql,name){const start=sql.indexOf('create or replace function public.'+name+'('),end=sql.indexOf('$function$;',start);assert.ok(start>=0&&end>start);return sql.slice(start,end+'$function$;'.length);}

test('meeting upgrade only adds schema/functions/trigger without source edits, outbound requests or alert job backfill',()=>{
  assert.doesNotMatch(migration,/\b(?:insert\s+into|update|delete\s+from|truncate)\s+(?:public\.)?(?:posts|material_notes|private_entries|habits|profiles|growell_meeting_records)\b/i);
  assert.doesNotMatch(migration,/http_post|http_get|pg_net|create policy/i);
  assert.match(migration,/after insert or update on public\.growell_meeting_records/);
  assert.match(migration,/on conflict\(subscription_id,kind,source_key\) do nothing/);
  assert.match(verification,/read only/);assert.doesNotMatch(verification.replace(/'(?:''|[^'])*'/g,"''"),/select\s+\*|\b(?:insert|update|delete|truncate)\b/i);
  // Existing source tests keep exercising their original functions. This new
  // migration must not replace capture/configuration/verse scheduling helpers.
  for(const name of ['growell_web_push_capture','growell_web_push_capture_material','growell_web_push_configure','growell_web_push_tick'])assert.doesNotMatch(migration,new RegExp('create or replace function public\\.'+name+'\\('));
  const oldEligible=definition(materials,'growell_web_push_eligible');
  const newEligible=definition(migration,'growell_web_push_eligible');
  assert.equal(newEligible.slice(0,newEligible.indexOf("        or (p_kind='meeting'")).trimEnd(),oldEligible.slice(0,oldEligible.lastIndexOf('));\n$function$;')).trimEnd());
});

describe('Meeting push SQL alerts only the first global publication and preserves authored records',()=>{
  let db;
  before(async()=>{
    db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false);
      create table book_locks(book_id text primary key,locked boolean);
      create table posts(id text primary key,user_id text,book_id text,html text);
      create table material_notes(id text primary key,user_id text,book_id text,title text,html text,drive_links jsonb,created_at bigint);
      create table private_entries(id text primary key,user_id text,data text);create table habits(id text primary key,user_id text,data text);
      create table growell_meeting_records(id uuid primary key,book_id text,round integer,status text,user_id text,deleted_at timestamptz,
        topic text,sections jsonb,concepts jsonb,thought_questions jsonb,next_meeting jsonb,material_ids text[],revision bigint,created_at timestamptz,updated_at timestamptz);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);`);
    await db.exec(base);await db.exec(materials);await db.exec(migration);
  });
  async function reset(){await db.exec('reset role;truncate growell_web_push_jobs,growell_web_push_subscriptions,growell_web_push_meeting_publications,posts,material_notes,private_entries,habits,growell_meeting_records,profiles,book_locks');await db.query("insert into profiles(id,auth_user_id,is_admin) values('owner',$1,false),('other',$2,false),('author',$3,true),('admin',$4,true)",[AUTH,OTHER,AUTHOR,ADMIN]);}
  beforeEach(reset);after(async()=>{await db?.close();});
  async function rpc(name,args){await db.exec('set role service_role');try{const types={configure:'$1,$2::uuid,$3,$4::jsonb',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb',tick:'$1::timestamptz'};return (await db.query('select public.growell_web_push_'+name+'('+types[name]+') as value',args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;}finally{await db.exec('reset role');}}
  const config=(operation='connect',payload={},owner='owner',auth=AUTH)=>rpc('configure',[owner,auth,operation,{fingerprint:HASH,...(operation==='connect'?{subscription_cipher:CIPHER}:{}),...payload}]);
  const claim=()=>rpc('claim',[20]),apply=(job,operation,payload={})=>rpc('apply',[job.id,job.lease_token,operation,payload]);
  const jobs=()=>db.query('select * from growell_web_push_jobs order by kind,source_key,owner_id').then(result=>result.rows);
  const meeting=(overrides={})=>{const row={id:ID,book:'emotion',round:2,status:'draft',author:'author',deleted:null,...overrides};return db.query(`insert into growell_meeting_records(id,book_id,round,status,user_id,deleted_at,topic,sections,concepts,thought_questions,next_meeting,material_ids,revision,created_at,updated_at)
    values($1::uuid,$2,$3,$4,$5,$6,'PRIVATE ORIGINAL TOPIC','[{"summary":"COMPLETE SUMMARY","detail":"COMPLETE ORIGINAL MEETING BODY"}]','[{"word":"ORIGINAL CONCEPT"}]','[{"text":"ORIGINAL PRIVATE QUESTION"}]','{"reading":"ORIGINAL PREPARATION"}',array['material-original'],17,'2026-10-10T10:00:00Z','2026-10-10T11:00:00Z')`,[row.id,row.book,row.round,row.status,row.author,row.deleted]);};
  const publish=()=>db.query("update growell_meeting_records set status='published' where id=$1::uuid",[ID]);
  const observations=()=>db.query('select * from growell_web_push_meeting_publications order by record_id').then(result=>result.rows);
  async function originals(){const result={};for(const table of ['profiles','posts','material_notes','private_entries','habits','growell_meeting_records'])result[table]=(await db.query('select * from '+table+' order by id')).rows;return result;}
  const secretValues=['PRIVATE ORIGINAL TOPIC','COMPLETE SUMMARY','COMPLETE ORIGINAL MEETING BODY','ORIGINAL CONCEPT','ORIGINAL PRIVATE QUESTION','ORIGINAL PREPARATION','material-original'];

  test('draft insertion and edits stay quiet; first publish captures only IDs/book/round and no content',async()=>{
    await config();await meeting();await db.exec("update growell_meeting_records set revision=18,updated_at=clock_timestamp()");assert.deepEqual(await jobs(),[]);
    await publish();const queued=await jobs();assert.equal(queued.length,1);assert.equal(queued[0].kind,'meeting');assert.equal(queued[0].meeting_id,ID);assert.equal(queued[0].source_key,ID);assert.equal(queued[0].meeting_round,2);assert.equal(queued[0].book_id,'emotion');assert.equal(queued[0].post_id,null);assert.equal(queued[0].material_id,null);
    const before=await originals(),work=(await claim())[0],snapshot=await apply(work,'snapshot');assert.equal(snapshot.applied,true);assert.equal(snapshot.meeting_id,ID);assert.equal(snapshot.meeting_round,2);
    for(const value of secretValues){assert.equal(JSON.stringify(queued).includes(value),false,value);assert.equal(JSON.stringify(snapshot).includes(value),false,value);}
    assert.equal(JSON.stringify(queued).includes(CIPHER),false);assert.equal((await apply(work,'prepare')).applied,true);await apply(work,'accepted');assert.deepEqual(await originals(),before);
  });
  test('published INSERT queues once per opted-in non-author device, with separate device generations',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await config('connect',{fingerprint:'c'.repeat(64)},'author',AUTHOR);await config('connect',{fingerprint:'d'.repeat(64),new_posts:false},'admin',ADMIN);
    await config('connect',{fingerprint:'e'.repeat(64)});await meeting({status:'published'});const queued=await jobs();assert.equal(queued.length,3);assert.deepEqual(queued.map(job=>job.owner_id),['other','owner','owner']);assert.equal(new Set(queued.map(job=>job.subscription_id)).size,3);
  });
  test('published edits and draft-to-published retries never duplicate an existing per-device record alert',async()=>{
    await config();await meeting({status:'published'});const before=await jobs();await db.exec("update growell_meeting_records set topic='EDITED TOPIC',sections='[{\"detail\":\"FULL EDITED CONTENT\"}]',revision=18");assert.deepEqual(await jobs(),before);
    await db.exec("update growell_meeting_records set status='draft'");await publish();await publish();assert.deepEqual(await jobs(),before);
    const work=(await claim())[0];await apply(work,'prepare');await apply(work,'accepted');await db.exec("update growell_meeting_records set status='draft'");await publish();assert.equal((await jobs()).length,1);assert.equal((await jobs())[0].status,'sent');
  });
  test('a new device connected after first publication never receives a historical republish alert',async()=>{
    await config();await meeting({status:'published'});const firstJobs=await jobs(),firstObservations=await observations();assert.equal(firstJobs.length,1);assert.equal(firstObservations.length,1);assert.equal(firstObservations[0].record_id,ID);
    await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await config('connect',{fingerprint:'c'.repeat(64)});await db.exec("update growell_meeting_records set status='draft'");await publish();await db.exec("update growell_meeting_records set topic='EDITED AFTER REPUBLISH'");assert.deepEqual(await jobs(),firstJobs);assert.deepEqual(await observations(),firstObservations);
    assert.equal((await jobs()).some(job=>job.owner_id==='other'),false);
  });
  test('publication with no eligible devices is still observed once and cannot alert devices added later',async()=>{
    await meeting({status:'published'});assert.equal((await observations()).length,1);assert.deepEqual(await jobs(),[]);await config();await db.exec("update growell_meeting_records set status='draft'");await publish();assert.deepEqual(await jobs(),[]);
  });
  test('missing, nonadmin, inactive or deleted authors and deleted/draft sources never queue',async()=>{
    await config();for(const change of ["update profiles set approval_status='pending' where id='author'","update profiles set is_deleted=true where id='author'","update profiles set is_admin=false where id='author'"]){await reset();await config();await db.exec(change);await meeting({status:'published'});assert.deepEqual(await jobs(),[],change);}
    await reset();await config();await meeting({status:'published',author:'missing'});await meeting({id:ID2,status:'published',deleted:'2026-10-24'});assert.deepEqual(await jobs(),[]);
  });
  test('meeting eligibility keeps shared recipient approval, owner identity, ON preferences and generation fences',async()=>{
    for(const change of ["update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update profiles set auth_user_id='77777777-7777-4777-8777-777777777777' where id='owner'","update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set new_posts=false","update growell_web_push_subscriptions set subscription_cipher=null"]){await reset();await config();await db.exec(change);await meeting({status:'published'});assert.deepEqual(await jobs(),[],change);}
    await reset();await config();const device=(await db.query('select id,generation from growell_web_push_subscriptions')).rows[0];await meeting({status:'published'});await config();assert.equal((await db.query("select public.growell_web_push_eligible($1::uuid,'meeting',$2,$3::uuid) as value",[device.id,ID,device.generation])).rows[0].value,false);assert.deepEqual(await claim(),[]);
  });
  test('book locks default closed for members and retain approved administrators current read permission',async()=>{
    await config();await config('connect',{fingerprint:'b'.repeat(64)},'admin',ADMIN);await meeting({status:'published',book:'thought'});assert.deepEqual((await jobs()).map(job=>job.owner_id),['admin']);
    await db.exec("insert into book_locks values('thought',false)");await meeting({id:ID2,status:'published',book:'thought',round:3});assert.equal((await jobs()).filter(job=>job.meeting_id===ID2).length,2);
    const work=await claim();await db.exec("update book_locks set locked=true where book_id='thought'");
    const rows=await jobs(),ownerJob=work.find(job=>job.id===rows.find(row=>row.owner_id==='owner').id),adminJob=work.find(job=>job.id===rows.find(row=>row.owner_id==='admin'&&row.meeting_id===ID2).id);
    assert.equal((await apply(ownerJob,'prepare')).applied,false);assert.equal((await apply(adminJob,'prepare')).applied,true);
  });
  const revokedChanges=[
    "update profiles set approval_status='pending' where id='owner'","update profiles set is_deleted=true where id='owner'","update profiles set auth_user_id='77777777-7777-4777-8777-777777777777' where id='owner'",
    "update profiles set approval_status='pending' where id='author'","update profiles set is_deleted=true where id='author'","update profiles set is_admin=false where id='author'",
    "update growell_web_push_subscriptions set enabled=false","update growell_web_push_subscriptions set new_posts=false","update growell_web_push_subscriptions set subscription_cipher=null","update growell_web_push_subscriptions set generation=gen_random_uuid()",
    "update growell_web_push_subscriptions set owner_id='other',auth_user_id='22222222-2222-4222-8222-222222222222'",
    "update growell_meeting_records set status='draft'","update growell_meeting_records set deleted_at=clock_timestamp()","update growell_meeting_records set book_id='thought'","update growell_meeting_records set round=3",
    "delete from growell_meeting_records","insert into book_locks values('emotion',true)","update growell_web_push_jobs set expires_at=clock_timestamp()-interval '1 second'"
  ];
  test('all source/recipient/round/book/generation changes cancel before claim without modifying authored content',async()=>{
    for(const change of revokedChanges){await reset();await config();await meeting({status:'published'});await db.exec(change);const before=await originals();assert.deepEqual(await claim(),[],change);assert.equal((await jobs())[0].status,'cancelled',change);assert.deepEqual(await originals(),before,change);}
  });
  test('snapshot and prepare each independently recheck current source, permissions and device generation',async()=>{
    for(const stage of ['snapshot','prepare'])for(const change of revokedChanges){await reset();await config();await meeting({status:'published'});const work=(await claim())[0];if(stage==='prepare')assert.equal((await apply(work,'snapshot')).applied,true);await db.exec(change);const before=await originals();assert.deepEqual(await apply(work,stage),{applied:false},stage+': '+change);assert.equal((await jobs())[0].status,'cancelled');assert.deepEqual(await originals(),before);}
  });
  test('round metadata constraints reject malformed new meeting jobs without touching originals',async()=>{
    await config();await meeting({status:'published'});const before=await jobs();for(const change of ["meeting_round=0","meeting_round=10000","meeting_round=null","meeting_id=null","book_id=null","source_key='different'"]){await assert.rejects(db.exec('update growell_web_push_jobs set '+change),error=>error.code==='23514',change);assert.deepEqual(await jobs(),before);}
    const work=(await claim())[0];await db.exec('update growell_web_push_jobs set meeting_round=3');assert.equal((await apply(work,'prepare')).applied,false);
  });
  test('repeat upgrade and read-only verification preserve every source, subscription and pending/sending job without backfill',async()=>{
    // Seed sources while the meeting trigger is absent, like pre-upgrade records.
    await db.exec('drop trigger growell_web_push_new_meeting on growell_meeting_records');await meeting({status:'published'});await config();await db.exec("insert into private_entries values('private','owner','ENCRYPTED ORIGINAL');insert into habits values('habit','owner','COMPLETE HISTORY');insert into posts values('post','author','emotion','ORIGINAL POST');insert into material_notes values('material','author','emotion','ORIGINAL MATERIAL TITLE','ORIGINAL MATERIAL BODY','[]',1700000000000)");
    const work=(await claim())[0];await apply(work,'prepare');await config('test');await config('settings',{daily_verse:false});
    // Reconstruct the deployed pre-meeting queue shape. Existing row values and
    // source IDs/times stay untouched while the additive columns are absent.
    await db.exec("alter table growell_web_push_jobs drop constraint growell_web_push_jobs_meeting_check;alter table growell_web_push_jobs drop column meeting_id;alter table growell_web_push_jobs drop column meeting_round;alter table growell_web_push_jobs drop constraint growell_web_push_jobs_kind_check;alter table growell_web_push_jobs add constraint growell_web_push_jobs_kind_check check(kind in ('post','material','verse','test'))");
    const before=await originals(),oldJobs=await jobs(),devices=(await db.query('select * from growell_web_push_subscriptions')).rows;
    await db.exec(migration);assert.deepEqual((await jobs()).map(({meeting_id,meeting_round,...job})=>job),oldJobs);assert.equal((await jobs()).every(job=>job.meeting_id===null&&job.meeting_round===null),true);
    const firstUpgrade=await jobs(),firstObservations=await observations();assert.deepEqual(firstObservations.map(row=>row.record_id),[ID]);assert.notEqual(new Date(firstObservations[0].observed_at).toISOString(),'2026-10-10T10:00:00.000Z');
    await db.exec(migration);await db.exec(verification);assert.deepEqual(await originals(),before);assert.deepEqual(await jobs(),firstUpgrade);assert.deepEqual(await observations(),firstObservations);assert.deepEqual((await db.query('select * from growell_web_push_subscriptions')).rows,devices);assert.equal((await jobs()).some(job=>job.kind==='meeting'),false);assert.equal((await jobs()).find(job=>job.id===work.id).status,'sending');
    const triggers=(await db.query("select tgname from pg_trigger where not tgisinternal and tgrelid='growell_meeting_records'::regclass and tgname='growell_web_push_new_meeting'")).rows;assert.equal(triggers.length,1);await publish();assert.equal((await jobs()).some(job=>job.kind==='meeting'),false);
    await config('connect',{fingerprint:'b'.repeat(64)},'other',OTHER);await db.exec("update growell_meeting_records set status='draft'");await publish();assert.deepEqual(await jobs(),firstUpgrade);assert.deepEqual(await observations(),firstObservations);
  });
  test('transaction rollback cancels publication and queue atomically while keeping the original draft intact',async()=>{
    await config();await meeting();const before=await originals(),devices=(await db.query('select * from growell_web_push_subscriptions')).rows;await db.exec('begin');await publish();assert.equal((await jobs()).length,1);assert.equal((await observations()).length,1);await db.exec('rollback');assert.deepEqual(await jobs(),[]);assert.deepEqual(await observations(),[]);assert.deepEqual(await originals(),before);assert.deepEqual((await db.query('select * from growell_web_push_subscriptions')).rows,devices);
    // The migration can also be reviewed and rolled back without changing rows.
    await db.exec(migration.replace(/^begin;/m,'begin;').replace(/commit;\s*$/,'rollback;'));assert.deepEqual(await originals(),before);assert.deepEqual(await jobs(),[]);
  });
  test('a queue insertion failure rolls back the publication marker and source transition atomically',async()=>{
    await config();await meeting();const before=await originals();await db.exec("create function public.test_fail_meeting_job() returns trigger language plpgsql as $$begin if new.kind='meeting' then raise exception 'Synthetic queue failure';end if;return new;end$$;create trigger test_fail_meeting_job before insert on growell_web_push_jobs for each row execute function public.test_fail_meeting_job()");
    try{await assert.rejects(publish(),/Synthetic queue failure/);assert.deepEqual(await jobs(),[]);assert.deepEqual(await observations(),[]);assert.deepEqual(await originals(),before);}finally{await db.exec('drop trigger test_fail_meeting_job on growell_web_push_jobs;drop function public.test_fail_meeting_job()');}
    await publish();assert.equal((await jobs()).length,1);assert.equal((await observations()).length,1);
  });
  test('legacy post/material/test/verse paths keep original selection and lease semantics',async()=>{
    await config();await db.exec("insert into posts values('post','author','emotion','ORIGINAL POST');insert into material_notes values('material','author','emotion','ORIGINAL TITLE','ORIGINAL BODY','[]',1700000000000)");await config('test');
    const localDay=(await db.query("select ((clock_timestamp() at time zone 'Asia/Seoul')::date)::text as day")).rows[0].day;
    await db.exec(`insert into growell_web_push_jobs(subscription_id,owner_id,auth_user_id,generation,kind,source_key,verse_day,expires_at) select id,owner_id,auth_user_id,generation,'verse','${localDay}','${localDay}',clock_timestamp()+interval '1 day' from growell_web_push_subscriptions`);
    const before=await originals(),work=await claim();assert.deepEqual(work.map(job=>job.kind).sort(),['material','post','test','verse']);for(const job of work){const snapshot=await apply(job,'snapshot');assert.equal(snapshot.applied,true);assert.equal(snapshot.meeting_id,null);assert.equal(snapshot.meeting_round,null);assert.equal((await apply(job,'prepare')).applied,true);assert.equal((await apply(job,'accepted')).applied,true);}assert.deepEqual(await originals(),before);
    assert.deepEqual(await claim(),[]);assert.equal((await jobs()).every(job=>job.status==='sent'),true);
  });
  test('browser roles cannot read queues, call meeting capture/eligibility or invoke service worker operations',async()=>{
    await config();await meeting({status:'published'});for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{for(const query of ['select * from growell_web_push_jobs','select * from growell_web_push_subscriptions','select * from growell_web_push_meeting_publications',"insert into growell_web_push_meeting_publications(record_id) values('77777777-7777-4777-8777-777777777777')","update growell_web_push_meeting_publications set observed_at=clock_timestamp()","delete from growell_web_push_meeting_publications", "select public.growell_web_push_eligible(null,'meeting',null)",'select public.growell_web_push_capture_meeting()','select public.growell_web_push_claim(1)',"select public.growell_web_push_apply(null,null,'snapshot')"])await assert.rejects(db.exec(query),error=>error.code==='42501',role+': '+query);}finally{await db.exec('reset role');}}
    const security=(await db.query("select prosecdef,proconfig from pg_proc where oid='public.growell_web_push_capture_meeting()'::regprocedure")).rows[0];assert.equal(security.prosecdef,true);assert.deepEqual(security.proconfig,['search_path=""']);
    const markerSecurity=(await db.query("select relrowsecurity from pg_class where oid='public.growell_web_push_meeting_publications'::regclass")).rows[0];assert.equal(markerSecurity.relrowsecurity,true);
    await db.exec('set role service_role');try{await assert.rejects(db.exec('select * from growell_web_push_meeting_publications'),error=>error.code==='42501');}finally{await db.exec('reset role');}
  });
});
