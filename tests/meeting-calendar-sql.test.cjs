'use strict';

const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync(path.join(__dirname,'../server/meeting-calendar.sql'),'utf8');
const scheduler=fs.readFileSync(path.join(__dirname,'../server/meeting-calendar-schedule.sql'),'utf8');
const consentPatch=fs.readFileSync(path.join(__dirname,'../server/google-toggle-consent.sql'),'utf8');
function configureDefinition(source){const start=source.indexOf('create or replace function public.growell_meeting_calendar_configure('),end=source.indexOf('$function$;',start);assert.ok(start>=0&&end>start);return source.slice(start,end+'$function$;'.length).replace(/\r\n/g,'\n');}
const AUTH='11111111-1111-4111-8111-111111111111';
const OTHER_AUTH='22222222-2222-4222-8222-222222222222';
const GEN='33333333-3333-4333-8333-333333333333';
const NEXT_GEN='44444444-4444-4444-8444-444444444444';
const THIRD_GEN='55555555-5555-4555-8555-555555555555';
const TOKEN='synthetic-encrypted-token-for-tests';
const EVENT='a'.repeat(64);
const codeIs=code=>error=>error.code===code;

// Isolated, real PostgreSQL semantics. No production records, credentials,
// external account, Calendar API, browser storage or live database is used.
describe('Per-member Google Calendar SQL preservation and durability',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid unique not null,
        approval_status text not null default 'approved',is_deleted boolean not null default false);
      create table public.announcement(book_id text primary key,next_date text,next_time text,next_place text,next_note text,
        reading_book_id text,reading_meeting_no text,reading_chapter text,reading_range text,reading_concept text,reading_note text);
      create table public.posts(id text primary key,user_id text not null references public.profiles(id),html text,q1 text,q2 text,q3 text,created_at bigint);
      create table public.habits(id text primary key,user_id text not null references public.profiles(id),name text,checked_dates text[]);
      create table public.private_entries(id text primary key,user_id text not null references public.profiles(id),iv text,data text);
      create table public.material_notes(id text primary key,user_id text not null references public.profiles(id),html text);
      grant select,insert,update,delete on all tables in schema public to service_role;
      grant select,insert,update on public.announcement to authenticated;`);
    await db.exec(migration);
    assert.equal(configureDefinition(consentPatch),configureDefinition(migration),'standalone production patch must match the canonical configure function');
    await db.exec(configureDefinition(consentPatch));
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.profiles cascade;truncate public.announcement;truncate public.growell_meeting_calendar_schedules cascade');
    await db.query('insert into public.profiles(id,auth_user_id) values($1,$2::uuid),($3,$4::uuid)',['owner',AUTH,'other',OTHER_AUTH]);
    await db.query(`insert into public.announcement(book_id,next_date,next_time,next_place,next_note,reading_book_id,reading_meeting_no,reading_chapter,reading_range,reading_concept,reading_note)
      values('global','10월 24일(토)','오후 1시 30분','교육관','모임 안내 원문','emotion','2','3장','80~120쪽','보존할 개념','읽기 안내 원문')`);
  });
  after(async()=>{if(db)await db.close();});
  async function asRole(role,action){
    assert.ok(['anon','authenticated','service_role'].includes(role));await db.exec('set role '+role);
    try{return await action();}finally{await db.exec('reset role');}
  }
  async function rpc(name,args){
    const queries={configure:'select public.growell_meeting_calendar_configure($1,$2::uuid,$3,$4::jsonb) as value',
      oauth:'select public.growell_meeting_calendar_oauth($1,$2::jsonb) as value',
      claim:'select public.growell_meeting_calendar_claim($1,$2::integer) as value',
      apply:'select public.growell_meeting_calendar_apply($1,$2::uuid,$3::uuid,$4,$5::jsonb) as value'};
    assert.ok(queries[name]);return (await db.query(queries[name],args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;
  }
  const configure=(op,payload={},owner='owner',auth=AUTH)=>asRole('service_role',()=>rpc('configure',[owner,auth,op,payload]));
  const connect=(generation=GEN,account='google-account',owner='owner',auth=AUTH)=>configure('connect',{
    generation,token_cipher:TOKEN,account_id:account,account_email:'test@example.invalid'},owner,auth);
  const claim=(owner='owner',limit=1)=>asRole('service_role',()=>rpc('claim',[owner,limit]));
  const apply=(claim,op,payload={})=>asRole('service_role',()=>rpc('apply',[
    claim.connection.owner_id,claim.connection.generation,claim.connection.lease_token,op,payload]));
  const oauth=(op,payload)=>asRole('service_role',()=>rpc('oauth',[op,payload]));
  const connection=(owner='owner')=>db.query('select * from public.growell_meeting_calendar_connections where owner_id=$1',[owner]).then(r=>r.rows[0]);
  const announcement=()=>db.query("select * from public.announcement where book_id='global'").then(r=>r.rows[0]);
  const jobs=(owner='owner',generation=GEN)=>db.query('select * from public.growell_meeting_calendar_jobs where owner_id=$1 and generation=$2::uuid order by schedule_id',[owner,generation]).then(r=>r.rows);
  const schedule=(date='2026-10-24',start='13:30',end='15:00')=>asRole('authenticated',()=>db.query(
    "update public.announcement set next_calendar_date=$1,next_calendar_start=$2,next_calendar_end=$3 where book_id='global'",[date,start,end]));
  const jobPayload=(work,index=0)=>({schedule_id:work.jobs[index].schedule_id,revision:work.jobs[index].revision});
  const succeed=(work,index=0)=>apply(work,'success',{...jobPayload(work,index),event_id:EVENT});

  test('first OAuth OFF creates no current-meeting job and later ON catches up without changing authored content',async()=>{
    await schedule();const original=await announcement();
    await configure('connect',{generation:GEN,token_cipher:TOKEN,account_id:'google-account',account_email:'test@example.invalid',enabled:false});
    assert.equal((await connection()).enabled,false);assert.deepEqual(await jobs(),[]);assert.deepEqual(await claim(),[]);
    await connect(NEXT_GEN);assert.equal((await connection()).enabled,false);assert.deepEqual(await jobs('owner',NEXT_GEN),[]);assert.deepEqual(await claim(),[]);
    await configure('settings',{enabled:true});assert.equal((await jobs('owner',NEXT_GEN)).length,1);
    await configure('settings',{enabled:true});assert.equal((await jobs('owner',NEXT_GEN))[0].revision,1,'retrying ON does not queue a duplicate revision');
    assert.equal((await claim()).length,1);assert.deepEqual(await announcement(),original);
  });
  test('explicit OAuth choices override existing state and malformed choices cannot enroll a calendar',async()=>{
    const input={generation:GEN,token_cipher:TOKEN,account_id:'google-account',account_email:'test@example.invalid'};
    for(const key of ['enabled','default_enabled'])for(const value of [null,'false',0,{},[]])await assert.rejects(configure('connect',{...input,[key]:value}),codeIs('22023'));
    assert.equal(await connection(),undefined);await schedule();await configure('connect',{...input,enabled:true});
    await configure('connect',{...input,generation:NEXT_GEN,enabled:false});assert.equal((await connection()).enabled,false);assert.deepEqual(await claim(),[]);
    await configure('connect',{...input,generation:THIRD_GEN,enabled:true});assert.equal((await connection()).enabled,true);assert.equal((await claim()).length,1);
  });
  test('unselected Calendar preserves latest ON or OFF under the row lock while new connections default OFF',async()=>{
    await schedule();const original=await announcement(),input={token_cipher:TOKEN,account_id:'google-account',account_email:'test@example.invalid',default_enabled:false};
    assert.equal((await configure('connect',{...input,generation:GEN})).enabled,false);assert.deepEqual(await jobs(),[]);
    await configure('settings',{enabled:true});
    assert.equal((await configure('connect',{...input,generation:NEXT_GEN})).enabled,true,'a newer ON choice is not replaced by the initial false default');
    await configure('settings',{enabled:false});
    assert.equal((await configure('connect',{...input,generation:THIRD_GEN})).enabled,false,'a newer OFF choice is not turned on by unrelated consent');
    assert.deepEqual(await claim(),[]);assert.deepEqual(await announcement(),original);
  });

  test('installation and reinstallation preserve all authored content and do not enroll anyone',async()=>{
    await db.query("insert into public.posts values('p','owner','original full HTML','answer1','answer2','answer3',123)");
    await db.query("insert into public.habits values('h','owner','독서',array['2026-10-01','2026-10-03'])");
    await db.query("insert into public.private_entries values('e','owner','original-IV','original-ciphertext')");
    await db.query("insert into public.material_notes values('m','owner','original video summary')");
    const originals={};for(const table of ['announcement','posts','habits','private_entries','material_notes'])originals[table]=(await db.query('select * from public.'+table)).rows;
    await db.exec(migration);
    for(const table of Object.keys(originals))assert.deepEqual((await db.query('select * from public.'+table)).rows,originals[table],table);
    assert.equal(await connection(),undefined);assert.deepEqual(await claim(null,10),[]);
    assert.equal((await announcement()).calendar_schedule_id,null,'legacy free text has not been guessed');
  });

  test('structured calendar fields do not replace legacy date, time, place, reading or notes',async()=>{
    const original=await announcement();await schedule();const after=await announcement();
    for(const field of ['next_date','next_time','next_place','next_note','reading_book_id','reading_meeting_no','reading_chapter','reading_range','reading_concept','reading_note'])assert.equal(after[field],original[field],field);
    assert.match(after.calendar_schedule_id,/^[a-f0-9-]{36}$/);assert.equal(after.next_calendar_date,'2026-10-24');
  });

  test('legacy or incomplete/invalid dates never create guessed events',async()=>{
    await connect();assert.deepEqual(await claim(),[]);
    for(const input of [['10/24','13:30','15:00'],['2026-02-31','13:30','15:00'],['2026-10-24','오후 1시','15:00'],['2026-10-24','13:30',''],['2026-10-24','13:30','13:30'],['2026-10-24','24:00','25:00']]){
      await assert.rejects(schedule(...input),codeIs('22023'));assert.equal((await announcement()).calendar_schedule_id,null);assert.deepEqual(await jobs(),[]);
    }
  });

  test('a saved meeting queues only approved connected members and safely includes place and reading range',async()=>{
    await connect();await db.query("update public.profiles set approval_status='pending' where id='other'");await schedule();
    assert.equal(await connection('other'),undefined);assert.equal((await jobs()).length,1);
    const work=(await claim())[0];assert.equal(work.jobs.length,1);assert.deepEqual(work.jobs[0].desired,{
      schedule_id:(await announcement()).calendar_schedule_id,meeting_date:'2026-10-24',start_time:'13:30',end_time:'15:00',
      place:'교육관',book_id:'emotion',meeting_no:'2',chapter:'3장',reading_range:'80~120쪽',note:'모임 안내 원문'});
    assert.equal(JSON.stringify(work.jobs).includes('original-ciphertext'),false);
  });

  test('a new member connection queues the current structured meeting without reading other members content',async()=>{
    await schedule();const before=await announcement();const result=await connect();
    assert.equal(result.token_cipher,undefined);assert.equal(result.lease_token,undefined);
    assert.equal((await jobs()).length,1);assert.equal((await jobs())[0].schedule_id,before.calendar_schedule_id);
    await connect(NEXT_GEN,'other-google','other',OTHER_AUTH);const work=await claim(null,10);
    assert.deepEqual(work.map(row=>row.connection.owner_id).sort(),['other','owner']);
    assert.equal(work.every(row=>row.jobs.every(job=>job.owner_id===row.connection.owner_id)),true);
  });

  test('date, time, place, range and notes edits update the same schedule and no-op saves create no extra revision',async()=>{
    await schedule();await connect();const original=await announcement(),before=(await jobs())[0];
    await schedule('2026-10-25','14:00','15:30');assert.equal((await announcement()).calendar_schedule_id,original.calendar_schedule_id);
    await db.query("update public.announcement set next_place='도서관',reading_range='121~160쪽',next_note='변경 안내' where book_id='global'");
    const changed=(await jobs())[0];assert.equal(changed.revision,before.revision+2);assert.equal(changed.desired.place,'도서관');
    await db.query("update public.announcement set reading_note=reading_note,next_place=next_place where book_id='global'");
    assert.equal((await jobs())[0].revision,changed.revision);
    await db.query("update public.announcement set calendar_schedule_id=$1::uuid where book_id='global'",[THIRD_GEN]);
    assert.equal((await announcement()).calendar_schedule_id,original.calendar_schedule_id,'client cannot change remote identity');
  });

  test('a new meeting or book gets a new schedule and leaves previous jobs, event receipts and reading text intact',async()=>{
    await schedule();await connect();let work=(await claim())[0];await succeed(work);await apply(work,'release');const first=(await jobs())[0];
    await db.query("update public.announcement set reading_meeting_no='3' where book_id='global'");
    assert.notEqual((await announcement()).calendar_schedule_id,first.schedule_id);assert.equal((await jobs()).length,2);
    const historical=(await jobs()).find(row=>row.schedule_id===first.schedule_id);assert.equal(historical.event_id,EVENT);assert.equal(historical.synced_revision,first.synced_revision);
    await db.query("update public.announcement set reading_book_id='thought' where book_id='global'");assert.equal((await jobs()).length,3);
    assert.equal((await db.query('select count(*)::integer as n from public.growell_meeting_calendar_schedules')).rows[0].n,3);
    assert.equal((await announcement()).next_date,'10월 24일(토)');
  });

  test('lease and job revision fences prevent stale writes while preserving edits completed during delivery',async()=>{
    await schedule();await connect();const work=(await claim())[0],original=jobPayload(work);
    assert.deepEqual(await apply(work,'guard',original),{applied:true});assert.deepEqual(await claim(),[]);
    await db.query("update public.announcement set next_place='새 장소' where book_id='global'");
    assert.deepEqual(await apply(work,'guard',original),{applied:false});
    assert.deepEqual(await apply(work,'created',{...original,event_id:EVENT}),{applied:true},'already-created remote event remains identified');
    assert.deepEqual(await succeed(work),{applied:true});let saved=(await jobs())[0];
    assert.equal(saved.revision,original.revision+1);assert.equal(saved.synced_revision,original.revision);assert.equal(saved.desired.place,'새 장소');
    await apply(work,'release');const next=(await claim())[0];assert.equal(next.jobs[0].event_id,EVENT);assert.equal(next.jobs[0].revision,saved.revision);
    assert.deepEqual(await apply(work,'success',{...original,event_id:EVENT}),{applied:false},'old lease cannot acknowledge a replacement worker');
  });

  test('success can only acknowledge a revision actually claimed and keeps an immutable remote event ID',async()=>{
    await schedule();await connect();const work=(await claim())[0],payload=jobPayload(work);
    assert.deepEqual(await apply(work,'success',{...payload,revision:payload.revision+1,event_id:EVENT}),{applied:false});
    await apply(work,'created',{...payload,event_id:EVENT});
    await assert.rejects(apply(work,'created',{...payload,event_id:'b'.repeat(64)}),codeIs('22023'));
    await assert.rejects(apply(work,'success',{...payload,event_id:'unsafe/remote'}),codeIs('22023'));
    await succeed(work);await apply(work,'release');assert.deepEqual(await claim(),[]);
    assert.ok((await connection()).last_synced_at);assert.ok((await jobs())[0].last_synced_at);
  });

  test('an obsolete failure cannot block a corrected new schedule revision or overwrite its retry status',async()=>{
    await schedule();await connect();const work=(await claim())[0],old=jobPayload(work);
    await db.query("update public.announcement set next_place='수정한 장소' where book_id='global'");
    assert.deepEqual(await apply(work,'failure',{...old,error_code:'invalid-schedule',retry_after:86400}),{applied:false});
    assert.equal((await jobs())[0].last_error,null);assert.equal((await connection()).error_code,null);
    await apply(work,'release');const corrected=(await claim())[0];assert.equal(corrected.jobs[0].revision,old.revision+1);
    assert.equal(corrected.jobs[0].desired.place,'수정한 장소');
  });

  test('worker leases expire and stale or missing generation/lease arguments cannot write',async()=>{
    await schedule();await connect();const work=(await claim())[0];
    for(const operation of ['disconnect','sync','settings'])await assert.rejects(configure(operation,{enabled:false}),codeIs('40001'));
    for(const field of ['generation','lease_token']){
      const stale={...work,connection:{...work.connection,[field]:null}};assert.deepEqual(await apply(stale,'guard',jobPayload(work)),{applied:false});
    }
    await db.query("update public.growell_meeting_calendar_connections set lease_until=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await apply(work,'guard',jobPayload(work)),{applied:false});const replacement=(await claim())[0];
    assert.notEqual(replacement.connection.lease_token,work.connection.lease_token);assert.deepEqual(await apply(work,'release'),{applied:false});
  });

  test('durable outage backoff survives schedule edits and explicit sync can retry',async()=>{
    await schedule();await connect();const work=(await claim())[0];
    await apply(work,'failure',{...jobPayload(work),error_code:'calendar-unavailable',retry_after:300});await apply(work,'release');
    const before=await connection(),old=(await jobs())[0];await db.query("update public.announcement set next_place='도서관' where book_id='global'");
    assert.equal((await connection()).next_sync_at.getTime(),before.next_sync_at.getTime());assert.equal((await jobs())[0].next_sync_at.getTime(),old.next_sync_at.getTime());
    assert.equal((await jobs())[0].revision,old.revision+1);assert.deepEqual(await claim(),[]);
    await configure('sync');assert.equal((await claim()).length,1);
  });

  test('remote deletion or unsafe event stops automatic retries without deleting a source or creating a fresh event',async()=>{
    await schedule();await connect();const work=(await claim())[0];await apply(work,'created',{...jobPayload(work),event_id:EVENT});
    await apply(work,'failure',{...jobPayload(work),error_code:'calendar-remote-missing',retry_after:5});await apply(work,'release');
    await db.exec("update public.growell_meeting_calendar_connections set next_sync_at=clock_timestamp();update public.growell_meeting_calendar_jobs set next_sync_at=clock_timestamp()");
    assert.deepEqual(await claim(),[]);assert.equal((await jobs())[0].event_id,EVENT);assert.equal((await jobs())[0].event_created,true);
    await configure('sync');assert.equal((await claim()).length,1,'explicit retry remains available');assert.equal((await announcement()).next_note,'모임 안내 원문');
  });

  test('pausing queues future edits while manual sync leaves the enabled setting paused',async()=>{
    await schedule();await connect();await configure('settings',{enabled:false});await db.query("update public.announcement set next_place='도서관' where book_id='global'");
    assert.deepEqual(await claim(),[]);await configure('sync');const work=(await claim())[0];assert.equal(work.connection.enabled,false);
    await succeed(work);await apply(work,'release');assert.equal((await connection()).enabled,false);assert.equal((await connection()).manual_requested,false);assert.deepEqual(await claim(),[]);
  });

  test('disconnect and reconnect to the same Google account preserve event history and prevent duplication',async()=>{
    await schedule();await connect();const work=(await claim())[0];await succeed(work);await apply(work,'release');await configure('disconnect');
    assert.equal((await connection()).token_cipher,null);assert.equal((await jobs()).length,1);
    await connect(NEXT_GEN);const restored=(await jobs('owner',NEXT_GEN))[0];assert.equal(restored.event_id,EVENT);assert.equal(restored.event_created,true);assert.equal(restored.synced_revision,1);
    assert.equal((await connection()).enabled,false,'reconnecting without an explicit ON preserves the paused preference');assert.deepEqual(await claim(),[]);
    await configure('settings',{enabled:true});
    assert.deepEqual(await claim(),[],'an unchanged already-synced meeting is not sent again on resume');
    await db.query("update public.announcement set next_place='다시 확인한 교육관' where book_id='global'");
    const next=(await claim())[0];assert.equal(next.jobs[0].event_id,EVENT);assert.equal(next.jobs[0].revision,2);await apply(next,'release');
    assert.equal((await jobs('owner',GEN))[0].event_id,EVENT,'old delivery receipt is retained');
  });

  test('connecting another Google account never reuses the previous account remote IDs',async()=>{
    await schedule();await connect();const work=(await claim())[0];await succeed(work);await apply(work,'release');
    await connect(NEXT_GEN,'new-google-account');const fresh=(await jobs('owner',NEXT_GEN))[0];assert.equal(fresh.event_id,null);assert.equal(fresh.event_created,false);assert.equal(fresh.synced_revision,0);
    assert.equal((await jobs('owner',GEN))[0].event_id,EVENT);assert.deepEqual(await apply(work,'guard',jobPayload(work)),{applied:false});
  });

  test('membership revocation removes usable tokens and pending OAuth without changing authored rows or delivery receipts',async()=>{
    await db.query("insert into public.posts values('p','owner','whole original post','q1','q2','q3',123)");
    const original=(await db.query('select * from public.posts')).rows;await schedule();await connect();const work=(await claim())[0];
    await apply(work,'created',{...jobPayload(work),event_id:EVENT});await db.query("update public.profiles set approval_status='pending' where id='owner'");
    assert.equal((await connection()).token_cipher,null);assert.equal((await connection()).enabled,false);assert.deepEqual(await claim(),[]);
    assert.deepEqual(await apply(work,'success',{...jobPayload(work),event_id:EVENT}),{applied:false});
    assert.equal((await jobs())[0].event_id,EVENT);assert.deepEqual((await db.query('select * from public.posts')).rows,original);
    await assert.rejects(configure('connect',{generation:NEXT_GEN,token_cipher:TOKEN,account_id:'x'}),codeIs('42501'));
  });

  test('authentication identity changes invalidate an in-flight worker and cannot borrow prior account receipts',async()=>{
    await schedule();await connect();const work=(await claim())[0];await apply(work,'created',{...jobPayload(work),event_id:EVENT});
    await db.query("update public.profiles set auth_user_id=$1::uuid where id='owner'",[THIRD_GEN]);
    assert.deepEqual(await apply(work,'guard',jobPayload(work)),{applied:false});await assert.rejects(configure('sync'),codeIs('42501'));
    await configure('connect',{generation:NEXT_GEN,token_cipher:TOKEN,account_id:'google-account',account_email:'test@example.invalid',enabled:true},'owner',THIRD_GEN);assert.equal((await jobs('owner',NEXT_GEN))[0].event_id,null);
  });

  test('OAuth states are bounded, owner-bound, short-lived and atomically consumed once',async()=>{
    const payload={state_hash:'a'.repeat(64),owner_id:'owner',auth_user_id:AUTH,verifier_cipher:TOKEN,expires_at:new Date(Date.now()+300000).toISOString()};
    await oauth('put',payload);assert.equal((await oauth('consume',{state_hash:payload.state_hash})).owner_id,'owner');
    assert.equal(await oauth('consume',{state_hash:payload.state_hash}),null);
    await assert.rejects(oauth('put',{...payload,expires_at:new Date(Date.now()+3600000).toISOString()}),codeIs('22023'));
    await assert.rejects(oauth('put',{...payload,auth_user_id:OTHER_AUTH}),codeIs('42501'));
    await oauth('put',payload);await db.query("update public.growell_meeting_calendar_oauth_states set expires_at=clock_timestamp()-interval '1 second'");
    assert.equal(await oauth('consume',{state_hash:payload.state_hash}),null);assert.equal((await db.query('select count(*)::integer as n from public.growell_meeting_calendar_oauth_states')).rows[0].n,0);
  });

  test('another member cannot configure or operate the owner calendar and generations cannot be reused',async()=>{
    await assert.rejects(configure('connect',{generation:GEN,token_cipher:TOKEN,account_id:'x'},'owner',OTHER_AUTH),codeIs('42501'));
    await schedule();await connect();await assert.rejects(connect(GEN),codeIs('22023'));
    assert.deepEqual(await claim('other'),[]);await assert.rejects(configure('sync',{},'other',OTHER_AUTH),codeIs('55000'));
    await connect(NEXT_GEN);await assert.rejects(connect(GEN),codeIs('22023'));
  });

  test('claim caps each member batch at three jobs and later claims drain remaining meetings',async()=>{
    await schedule();await connect();for(let i=3;i<=6;i++)await db.query("update public.announcement set reading_meeting_no=$1 where book_id='global'",[String(i)]);
    let work=(await claim())[0];assert.equal(work.jobs.length,3);for(let i=0;i<work.jobs.length;i++)await succeed(work,i);await apply(work,'release');
    work=(await claim())[0];assert.equal(work.jobs.length,2);for(let i=0;i<work.jobs.length;i++)await succeed(work,i);await apply(work,'release');assert.deepEqual(await claim(),[]);
    await assert.rejects(claim('owner',0),codeIs('22023'));await assert.rejects(claim(null,11),codeIs('22023'));
  });

  test('credentials, schedule history, queues and all RPCs are denied to browser roles',async()=>{
    await schedule();await connect();for(const role of ['anon','authenticated'])await asRole(role,async()=>{
      for(const table of ['connections','oauth_states','schedules','jobs'])await assert.rejects(db.query('select * from public.growell_meeting_calendar_'+table),codeIs('42501'));
      for(const query of ["select public.growell_meeting_calendar_configure('owner','"+AUTH+"','disconnect','{}')",
        "select public.growell_meeting_calendar_oauth('consume','{}')",'select public.growell_meeting_calendar_claim()',
        "select public.growell_meeting_calendar_apply('owner','"+GEN+"','"+NEXT_GEN+"','guard','{}')"])await assert.rejects(db.query(query),codeIs('42501'));
    });
    const rows=(await db.query("select relrowsecurity from pg_class where relname like 'growell_meeting_calendar_%' and relkind='r'")).rows;
    assert.equal(rows.length,4);assert.equal(rows.every(row=>row.relrowsecurity),true);
  });

  test('configuration refuses invalid booleans and reconnect-required disables future writes without deleting receipts',async()=>{
    await schedule();await connect();await assert.rejects(configure('settings',{enabled:'yes'}),codeIs('22023'));
    const work=(await claim())[0];await apply(work,'created',{...jobPayload(work),event_id:EVENT});
    await apply(work,'failure',{...jobPayload(work),error_code:'reconnect-required',retry_after:60,disable:true});
    assert.deepEqual(await apply(work,'guard',jobPayload(work)),{applied:false});await apply(work,'release');assert.deepEqual(await claim(),[]);
    assert.equal((await connection()).enabled,false);assert.equal((await jobs())[0].event_id,EVENT);assert.equal((await jobs())[0].synced_revision,0);
  });

  test('migration refuses a missing critical source column instead of delivering incomplete meetings',async()=>{
    await db.exec('alter table public.announcement rename column reading_range to preserved_reading_range');
    try{await assert.rejects(db.exec(migration),error=>error.message.includes('announcement.reading_range'));}
    finally{await db.exec('rollback;alter table public.announcement rename column preserved_reading_range to reading_range');}
    await db.exec(migration);
  });

  test('scheduler has a separate job and reuses Vault worker authentication without replacing existing jobs',()=>{
    assert.match(scheduler,/cron\.schedule\('growell-meeting-calendar','\* \* \* \* \*'/);
    assert.match(scheduler,/\/api\/meeting-calendar\?action=worker/);assert.match(scheduler,/growell_habit_sync_worker_secret/);
    assert.doesNotMatch(scheduler,/cron\.(unschedule|alter_job)/);assert.doesNotMatch(scheduler,/cron\.schedule\('growell-(habit-sync|drive-backup)'/);
    assert.doesNotMatch(migration,/delete\s+from\s+public\.(posts|private_entries|habits|material_notes|announcement)\b/i);
  });
});
