'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const sql=fs.readFileSync(path.join(__dirname,'../server/meeting-mail.sql'),'utf8');
const activate=fs.readFileSync(path.join(__dirname,'../server/meeting-mail-activate.sql'),'utf8');
const consentPatch=fs.readFileSync(path.join(__dirname,'../server/google-toggle-consent.sql'),'utf8');
const questionsPatch=fs.readFileSync(path.join(__dirname,'../server/meeting-mail-thought-questions.sql'),'utf8');
function configureDefinition(source){const start=source.indexOf('create or replace function public.growell_meeting_mail_configure('),end=source.indexOf('$function$;',start);assert.ok(start>=0&&end>start);return source.slice(start,end+'$function$;'.length).replace(/\r\n/g,'\n');}
function applyDefinition(source){const start=source.indexOf('create or replace function public.growell_meeting_mail_apply('),end=source.indexOf('$function$;',start);assert.ok(start>=0&&end>start);return source.slice(start,end+'$function$;'.length).replace(/\r\n/g,'\n');}
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const R1='33333333-3333-4333-8333-333333333333',R2='44444444-4444-4444-8444-444444444444',R3='55555555-5555-4555-8555-555555555555';
const codeIs=code=>error=>error.code===code;
describe('Automatic meeting PDF mail SQL preserves authored records and delivery receipts',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table public.profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false,name text default '공개 이름',email text default 'PROFILE-EMAIL-PRIVATE');
      create table public.growell_drive_backup_connections(owner_id text primary key references public.profiles(id),auth_user_id uuid,account_id text,account_email text,token_cipher text);
      create table public.growell_meeting_calendar_connections(like public.growell_drive_backup_connections including all);
      create table public.book_locks(book_id text primary key,locked boolean);
      create table public.growell_meeting_records(id uuid primary key,book_id text,round integer,meeting_date date,topic text,sections jsonb,concepts jsonb,thought_questions jsonb,next_meeting jsonb,material_ids text[],status text,user_id text,revision bigint default 1,created_at timestamptz default now(),deleted_at timestamptz);
      create table public.material_notes(id text primary key,book_id text,user_id text,title text,html text);
      create table public.posts(id text primary key,user_id text,html text,q1 text,q2 text,q3 text,book_id text,note_type text,meeting_no text,created_at bigint,
        deleted_at timestamptz,is_deleted boolean default false,is_private boolean default false,visibility text default 'public');
      create table public.private_entries(id text primary key,user_id text,data text);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('growell_habit_sync_worker_secret','synthetic-worker-secret-not-an-operating-credential');`);
    await db.exec(sql);
    assert.equal(configureDefinition(consentPatch),configureDefinition(sql),'standalone production patch must match the canonical configure function');
    await db.exec(configureDefinition(consentPatch));
    assert.equal(applyDefinition(questionsPatch),applyDefinition(sql),'the additive snapshot patch must match the canonical mail function');
    await db.exec(questionsPatch);
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.growell_meeting_mail_jobs,public.growell_meeting_mail_subscriptions,public.growell_meeting_records,public.material_notes,public.posts,public.private_entries,public.growell_drive_backup_connections,public.growell_meeting_calendar_connections,public.profiles,public.book_locks');
    await db.query("insert into public.profiles(id,auth_user_id) values('owner',$1::uuid),('other',$2::uuid)",[AUTH,OTHER]);
    for(const table of ['growell_drive_backup_connections','growell_meeting_calendar_connections'])await db.query(`insert into public.${table} values('owner',$1::uuid,'google-owner','Member@Example.test','synthetic-token'),('other',$2::uuid,'google-other','other@example.test','synthetic-token')`,[AUTH,OTHER]);
    await record(R1,1,'2026-10-10');await record(R2,2,'2026-10-17');
  });
  after(async()=>{await db.close();});
  async function as(role,action){await db.exec('set role '+role);try{return await action();}finally{await db.exec('reset role');}}
  async function rpc(name,args){const expressions={configure:'$1,$2::uuid,$3,$4::jsonb',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb',worker_authorized:'$1',worker_secret:''};
    return as('service_role',async()=>{const result=await db.query('select public.growell_meeting_mail_'+name+'('+expressions[name]+') as value',args.map(a=>typeof a==='object'&&a!==null?JSON.stringify(a):a));return result.rows[0].value;});}
  const configure=(op='connect',payload={},owner='owner',auth=AUTH)=>rpc('configure',[owner,auth,op,payload]);
  const claim=(limit=1)=>rpc('claim',[limit]);
  const apply=async(job,op,payload={})=>{
    if(op==='prepare'&&!Object.hasOwn(payload,'content_hash')){const snapshot=await rpc('apply',[job.id,job.lease_token,'snapshot',{}]);payload={...payload,content_hash:snapshot.content_hash||'0'.repeat(64)};}
    return rpc('apply',[job.id,job.lease_token,op,payload]);
  };
  const rows=()=>db.query('select * from public.growell_meeting_mail_jobs order by created_at,id').then(r=>r.rows);
  async function record(id,round,date,book='emotion',status='published'){
    await db.query(`insert into public.growell_meeting_records(id,book_id,round,meeting_date,topic,sections,concepts,next_meeting,material_ids,status,user_id)
      values($1::uuid,$2,$3,$4::date,'내용 중심 모임 기록','[{"id":"balance","summary":"균형 살피기","detail":"보존해야 하는 전체 모임 내용이다."}]',
      '[{"id":"emotion","word":"감정","meaning":"몸과 마음의 신호이다."}]','{"date":"","time":"","place":"교육관","reading":"3장","sharing":"통찰 정리","habit":"작은 실천"}',array['material'],$5,'operator')`,[id,book,round,date,status]);
  }
  test('initial OAuth OFF queues no mail and existing OFF survives omitted reconnect until an explicit ON choice',async()=>{
    const originals=(await db.query('select * from public.growell_meeting_records order by id')).rows;
    assert.equal((await configure('connect',{enabled:false})).enabled,false);assert.deepEqual(await rows(),[]);assert.deepEqual(await claim(),[]);
    assert.equal((await configure()).enabled,false);assert.deepEqual(await rows(),[]);
    const enabled=await configure('connect',{enabled:true});assert.equal(enabled.enabled,true);assert.equal(enabled.pendingCount,1);
    const firstRows=await rows();assert.equal((await configure('connect',{enabled:false})).enabled,false);assert.deepEqual(await claim(),[]);assert.deepEqual(await rows(),firstRows);
    assert.deepEqual((await db.query('select * from public.growell_meeting_records order by id')).rows,originals);
  });
  test('non-boolean OAuth mail choices and extra recipient fields cannot create subscriptions',async()=>{
    for(const key of ['enabled','default_enabled'])for(const value of [null,'false',0,{},[]])await assert.rejects(configure('connect',{[key]:value}),codeIs('22023'));
    await assert.rejects(configure('connect',{enabled:false,account_email:'other@example.invalid'}),codeIs('22023'));
    assert.equal((await db.query('select count(*)::int as n from public.growell_meeting_mail_subscriptions')).rows[0].n,0);assert.deepEqual(await rows(),[]);
  });
  test('unselected mail defaults OFF once and retains a newer ON or OFF without replacing receipts',async()=>{
    assert.equal((await configure('connect',{default_enabled:false})).enabled,false);assert.deepEqual(await rows(),[]);
    await configure('settings',{enabled:true});const queued=await rows();
    assert.equal((await configure('connect',{default_enabled:false})).enabled,true,'newer ON survives an unrelated service consent');
    await configure('settings',{enabled:false});
    assert.equal((await configure('connect',{default_enabled:false})).enabled,false,'newer OFF also survives');assert.deepEqual(await claim(),[]);assert.deepEqual(await rows(),queued);
    assert.equal((await configure('connect',{enabled:true,default_enabled:false})).enabled,true,'selected-service ON has explicit precedence');
  });
  test('installation and repeat installation never enroll members or modify authored data',async()=>{
    await db.exec("insert into public.posts(id,user_id,html,q1,q2,q3) values('p','other','PUBLIC STORY MUST NOT ENTER PDF','q1','q2','q3');insert into public.private_entries values('e','owner','ENCRYPTED PRIVATE DATA');insert into public.material_notes values('material','emotion','operator','자료 제목','COMPLETE MATERIAL BODY');");
    const before={};for(const table of ['profiles','growell_meeting_records','posts','private_entries','material_notes','growell_drive_backup_connections','growell_meeting_calendar_connections'])before[table]=(await db.query('select * from public.'+table)).rows;
    await db.exec(sql);
    for(const table of Object.keys(before))assert.deepEqual((await db.query('select * from public.'+table)).rows,before[table],table);
    assert.deepEqual(await claim(),[]);assert.equal((await rows()).length,0);
  });
  test('one verified Google connection queues only the latest public record and reconnect does not duplicate it',async()=>{
    const status=await configure();assert.equal(status.accountEmail,'member@example.test');assert.equal(status.enabled,true);assert.equal(status.pendingCount,1);assert.equal(status.latestStatus,'pending');
    assert.deepEqual((await rows()).map(j=>j.record_id),[R2]);await configure();assert.equal((await rows()).length,1);
    await assert.rejects(configure('connect',{account_email:'attacker@example.test'}),codeIs('22023'));
  });
  test('matching approved owner identity is required in both Google connectors',async()=>{
    await assert.rejects(configure('connect',{},'owner',OTHER),codeIs('42501'));
    await db.query("update public.growell_meeting_calendar_connections set account_id='different-google' where owner_id='owner'");await assert.rejects(configure(),codeIs('55000'));
    await db.query("update public.growell_meeting_calendar_connections set account_id='google-owner',account_email='wrong@example.test' where owner_id='owner'");await assert.rejects(configure(),codeIs('55000'));
    await db.query("update public.growell_meeting_calendar_connections set account_email='Member@Example.test',token_cipher=null where owner_id='owner'");await assert.rejects(configure(),codeIs('55000'));
    assert.equal((await rows()).length,0);
  });
  test('a malformed Google recipient is rejected even if both connector stores contain the same value',async()=>{
    for(const email of ['not-an-address','valid@example.test\r\nBcc: victim@example.test','two@@example.test','space person@example.test']){
      for(const table of ['growell_drive_backup_connections','growell_meeting_calendar_connections'])await db.query(`update public.${table} set account_email=$1 where owner_id='owner'`,[email]);
      await assert.rejects(configure(),codeIs('55000'));assert.equal((await rows()).length,0);
    }
  });
  test('a new publication queues each approved subscriber once, ordinary edits and republishing never mail duplicates',async()=>{
    await configure();await configure('connect',{},'other',OTHER);await record(R3,3,'2026-10-24','emotion','draft');assert.equal((await rows()).length,2);
    await db.query("update public.growell_meeting_records set status='published' where id=$1::uuid",[R3]);assert.equal((await rows()).length,4);
    await db.query("update public.growell_meeting_records set topic='Updated text',revision=revision+1 where id=$1::uuid",[R3]);assert.equal((await rows()).length,4);
    await db.query("update public.growell_meeting_records set status='draft' where id=$1::uuid",[R3]);await db.query("update public.growell_meeting_records set status='published' where id=$1::uuid",[R3]);assert.equal((await rows()).length,4);
  });
  test('snapshot allowlists operator preparation, public material titles and selected matching-round public insights',async()=>{
    await db.exec("insert into public.posts(id,user_id,html,q1,q2,q3) values('p','other','PUBLIC STORY MUST NOT ENTER PDF','q1','q2','q3');insert into public.private_entries values('e','owner','ENCRYPTED PRIVATE DATA');insert into public.material_notes values('material','emotion','operator','자료 제목','COMPLETE MATERIAL BODY');");
    await configure();const work=(await claim())[0],snapshot=await apply(work,'snapshot');
    assert.equal(snapshot.applied,true);assert.equal(snapshot.recipient,'member@example.test');assert.equal(snapshot.record.sections[0].detail,'보존해야 하는 전체 모임 내용이다.');assert.equal(snapshot.record.nextMeeting.place,'교육관');
    assert.deepEqual(snapshot.materials,[{id:'material',title:'자료 제목'}]);
    assert.deepEqual(snapshot.insights,[]);assert.match(snapshot.content_hash,/^[0-9a-f]{64}$/);
    const encoded=JSON.stringify(snapshot);for(const value of ['PUBLIC STORY','ENCRYPTED PRIVATE','COMPLETE MATERIAL BODY','operator','auth_user_id','q1'])assert.equal(encoded.includes(value),false,value);
    assert.equal((await rows())[0].status,'claimed','PDF rendering alone cannot start delivery');
  });
  test('thought questions enter the canonical mail snapshot and hash without changing queue or delivery receipts',async()=>{
    await configure();const work=(await claim())[0],legacy=await apply(work,'snapshot');assert.deepEqual(legacy.record.thoughtQuestions,[]);
    const questions=[{id:'question-1',text:'  감정은 무엇을 알려주는가?\n생각과 어떻게 연결되는가?  '}];
    await db.query('update public.growell_meeting_records set thought_questions=$1::jsonb where id=$2::uuid',[JSON.stringify(questions),R2]);
    const snapshot=await apply(work,'snapshot');assert.deepEqual(snapshot.record.thoughtQuestions,questions);assert.notEqual(snapshot.content_hash,legacy.content_hash);
    assert.deepEqual(await apply(work,'prepare',{record_revision:legacy.record.revision,content_hash:legacy.content_hash}),{applied:false});
    const before=(await rows());await db.exec(questionsPatch);assert.deepEqual(await rows(),before);
    assert.deepEqual((await apply(work,'snapshot')).record.thoughtQuestions,questions);
    for(const role of ['anon','authenticated'])await assert.rejects(as(role,()=>db.query('select public.growell_meeting_mail_apply($1,$2,$3,$4)',[work.id,work.lease_token,'snapshot','{}'])),codeIs('42501'));
  });
  test('only public insights in this book and round from approved active authors are included with no private profile fields',async()=>{
    const insert=async(id,book='emotion',round='2',kind='insight',extra={})=>db.query(`insert into public.posts(id,user_id,html,q1,q2,q3,book_id,note_type,meeting_no,created_at,is_private,visibility,is_deleted,deleted_at)
      values($1,'other','POST HTML MUST NOT BE EXPORTED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,[id,'모임 소감 '+id,'새로운 깨달음 '+id,'실천할 배움 '+id,book,kind,round,extra.date||1791600000000,extra.private||false,extra.visibility||'public',extra.deleted||false,extra.deletedAt||null]);
    await insert('first','emotion','02','insight',{date:1791599990000});await insert('second');await insert('wrong-book','thought');await insert('wrong-round','emotion','1');await insert('other-kind','emotion','2','thought');
    await insert('private','emotion','2','insight',{private:true});await insert('draft','emotion','2','insight',{visibility:'private'});await insert('deleted','emotion','2','insight',{deleted:true});await insert('tombstone','emotion','2','insight',{deletedAt:'2026-10-10'});
    await configure();const work=(await claim())[0],snapshot=await apply(work,'snapshot');assert.deepEqual(snapshot.insights.map(i=>i.q1),['모임 소감 first','모임 소감 second']);
    assert.deepEqual(Object.keys(snapshot.insights[0]).sort(),['authorName','date','q1','q2','q3']);assert.equal(snapshot.insights[0].authorName,'공개 이름');assert.match(snapshot.insights[0].date,/^2026-10-10T/);
    const encoded=JSON.stringify(snapshot);for(const marker of ['PROFILE-EMAIL-PRIVATE','POST HTML MUST NOT','wrong-book','wrong-round','private','tombstone','auth_user_id'])assert.equal(encoded.includes(marker),false,marker);
    await db.query("update public.profiles set approval_status='pending' where id='other'");assert.deepEqual((await apply(work,'snapshot')).insights,[]);
    await db.query("update public.profiles set approval_status='approved',is_deleted=true where id='other'");assert.deepEqual((await apply(work,'snapshot')).insights,[]);
  });
  test('public insight edits or author visibility changes invalidate a rendered PDF even without changing the meeting record revision',async()=>{
    await db.exec("insert into public.posts(id,user_id,q1,q2,q3,book_id,note_type,meeting_no,created_at) values('insight','other','원문','배움','실천','emotion','insight','2',1791600000000)");
    await configure();const work=(await claim())[0],before=await apply(work,'snapshot');await db.query("update public.posts set q2='수정한 배움' where id='insight'");
    const newer=await apply(work,'snapshot');assert.equal(newer.record.revision,before.record.revision);assert.notEqual(newer.content_hash,before.content_hash);
    assert.deepEqual(await apply(work,'prepare',{record_revision:before.record.revision,content_hash:before.content_hash}),{applied:false});assert.equal((await rows())[0].status,'claimed');
    await db.query("update public.profiles set name='새 공개 이름' where id='other'");assert.deepEqual(await apply(work,'prepare',{record_revision:newer.record.revision,content_hash:newer.content_hash}),{applied:false});
    const renamed=await apply(work,'snapshot');await db.query("update public.profiles set is_deleted=true where id='other'");assert.deepEqual(await apply(work,'prepare',{record_revision:renamed.record.revision,content_hash:renamed.content_hash}),{applied:false});
    const final=await apply(work,'snapshot');assert.deepEqual(final.insights,[]);assert.equal((await apply(work,'prepare',{record_revision:final.record.revision,content_hash:final.content_hash})).applied,true);
  });
  test('invalid or absent rendered-content hash cannot start delivery',async()=>{
    await configure();const work=(await claim())[0];
    for(const content_hash of [undefined,'broken','A'.repeat(64)])await assert.rejects(rpc('apply',[work.id,work.lease_token,'prepare',{record_revision:1,content_hash}]),codeIs('22023'));
    assert.equal((await rows())[0].status,'claimed');
  });
  test('an edited record revision invalidates the rendered PDF immediately before delivery',async()=>{
    await configure();const work=(await claim())[0],snapshot=await apply(work,'snapshot');await db.query("update public.growell_meeting_records set revision=revision+1,topic='Revised' where id=$1::uuid",[R2]);
    assert.deepEqual(await apply(work,'prepare',{record_revision:snapshot.record.revision}),{applied:false});assert.equal((await rows())[0].status,'claimed');
    const fresh=await apply(work,'snapshot');assert.equal(fresh.record.revision,2);assert.equal((await apply(work,'prepare',{record_revision:2})).applied,true);assert.equal((await rows())[0].status,'sending');
  });
  test('membership revocation, account disconnect, book lock, draft and deletion are checked again before SMTP',async()=>{
    for(const command of ["update public.profiles set approval_status='pending' where id='owner'","update public.growell_drive_backup_connections set token_cipher=null where owner_id='owner'","insert into public.book_locks values('emotion',true)","update public.growell_meeting_records set status='draft' where id='"+R2+"'","update public.growell_meeting_records set deleted_at=now() where id='"+R2+"'"]){
      await configure();const work=(await claim())[0];await db.exec(command);assert.deepEqual(await apply(work,'prepare',{record_revision:1}),{applied:false},command);
      await db.exec("update public.profiles set approval_status='approved';update public.growell_drive_backup_connections set token_cipher='synthetic-token';truncate public.book_locks;update public.growell_meeting_records set status='published',deleted_at=null;truncate public.growell_meeting_mail_jobs,public.growell_meeting_mail_subscriptions");
    }
  });
  test('locked categories are excluded for members while approved operators retain access',async()=>{
    await record(R3,3,'2026-10-24','thought');await configure();assert.deepEqual((await rows()).map(j=>j.record_id),[R2]);
    await db.query("update public.profiles set is_admin=true where id='other'");await configure('connect',{},'other',OTHER);assert.equal((await rows()).find(j=>j.owner_id==='other').record_id,R3);
  });
  test('pause prevents sends and reconnect respects the same-account OFF preference',async()=>{
    await configure();const work=(await claim())[0];await configure('settings',{enabled:false});assert.deepEqual(await apply(work,'prepare',{record_revision:1}),{applied:false});
    assert.equal((await configure()).enabled,false);assert.equal((await configure('status')).latestStatus,'paused');assert.deepEqual(await claim(),[]);
    await configure('settings',{enabled:true});await db.exec("update public.growell_meeting_mail_jobs set lease_until=now()-interval '1 second'");assert.equal((await claim()).length,1);
  });
  test('PDF failure can retry with durable backoff, expired rendering leases recover without duplicating delivery',async()=>{
    await configure();const work=(await claim())[0];await apply(work,'retry',{error_code:'pdf-unavailable',retry_after:60});assert.deepEqual(await claim(),[]);
    await db.exec("update public.growell_meeting_mail_jobs set available_at=now()-interval '1 second'");const next=(await claim())[0];assert.notEqual(next.lease_token,work.lease_token);assert.deepEqual(await apply(work,'guard'),{applied:false});
    await db.exec("update public.growell_meeting_mail_jobs set lease_until=now()-interval '1 second'");assert.equal((await claim()).length,1);
  });
  test('repeated pre-SMTP failure stops after five attempts and is labelled failed instead of delivery uncertainty',async()=>{
    await configure();for(let n=1;n<=5;n++){
      const work=(await claim())[0];assert.equal(work.attempts,n);assert.equal((await rows())[0].status,'claimed');
      await apply(work,'retry',{error_code:'pdf-unavailable',retry_after:60});await db.exec("update public.growell_meeting_mail_jobs set available_at=now()-interval '1 second'");
    }
    assert.deepEqual(await claim(),[]);assert.equal((await rows())[0].status,'review');const status=await configure('status');assert.equal(status.latestStatus,'failed');assert.equal(status.errorCode,'pdf-unavailable');assert.equal(status.sentCount,0);
  });
  test('repeated abrupt rendering crashes also stop after five expired claims',async()=>{
    await configure();for(let n=1;n<=5;n++){const work=(await claim())[0];assert.equal(work.attempts,n);await db.exec("update public.growell_meeting_mail_jobs set lease_until=now()-interval '1 second'");}
    assert.deepEqual(await claim(),[]);assert.equal((await rows())[0].status,'review');assert.equal((await configure('status')).latestStatus,'failed');
  });
  test('accepted SMTP receipt survives settings changes and cannot be claimed or sent again',async()=>{
    await configure();const work=(await claim())[0];await apply(work,'prepare',{record_revision:1});await configure('settings',{enabled:false});
    assert.deepEqual(await apply(work,'accepted',{provider_id:'smtp-response',message_id:'test-message'}),{applied:true});assert.equal((await rows())[0].status,'sent');
    await configure('settings',{enabled:true});await configure();assert.deepEqual(await claim(),[]);const status=await configure('status');assert.equal(status.sentCount,1);assert.equal(status.latestStatus,'sent');assert.ok(status.lastSentAt);
    assert.deepEqual(await apply(work,'uncertain'),{applied:false});
  });
  test('uncertain SMTP and expired sending leases never automatically resend',async()=>{
    await configure();let work=(await claim())[0];await apply(work,'prepare',{record_revision:1});await apply(work,'uncertain');await configure();assert.deepEqual(await claim(),[]);assert.equal((await configure('status')).latestStatus,'uncertain');
    await record(R3,3,'2026-10-24');work=(await claim())[0];await apply(work,'prepare',{record_revision:1});await db.exec("update public.growell_meeting_mail_jobs set lease_until=now()-interval '1 second' where status='sending'");assert.deepEqual(await claim(),[]);assert.equal((await rows()).filter(j=>j.status==='review').length,2);
  });
  test('same Google recipient shared by two member profiles receives one copy per record',async()=>{
    await configure();for(const table of ['growell_drive_backup_connections','growell_meeting_calendar_connections'])await db.query(`update public.${table} set account_id='google-owner',account_email='member@example.test' where owner_id='other'`);
    await configure('connect',{},'other',OTHER);assert.equal((await rows()).length,1);
  });
  test('a changed Google account gets a fresh recipient and retains the old account receipt untouched',async()=>{
    await configure();const first=(await claim())[0];await apply(first,'prepare',{record_revision:1});await apply(first,'accepted',{message_id:'old-receipt'});
    const old=(await rows())[0];for(const table of ['growell_drive_backup_connections','growell_meeting_calendar_connections'])await db.query(`update public.${table} set account_id='new-google',account_email='new@example.test' where owner_id='owner'`);
    const status=await configure();assert.equal(status.accountEmail,'new@example.test');assert.equal(status.sentCount,0);assert.equal(status.pendingCount,1);assert.equal(status.lastSentAt,null);
    assert.deepEqual((await rows()).find(j=>j.id===old.id),old);const next=(await claim())[0];assert.equal((await apply(next,'snapshot')).recipient,'new@example.test');
  });
  test('an explicit owner OFF preference survives changing Google accounts and only a direct ON action resumes mail',async()=>{
    await configure();await configure('settings',{enabled:false});const old=(await rows())[0];
    for(const table of ['growell_drive_backup_connections','growell_meeting_calendar_connections'])await db.query(`update public.${table} set account_id='new-google',account_email='new@example.test' where owner_id='owner'`);
    const paused=await configure();assert.equal(paused.connected,true);assert.equal(paused.enabled,false);assert.equal(paused.latestStatus,'paused');assert.equal(paused.pendingCount,0);assert.deepEqual(await claim(),[]);assert.deepEqual(await rows(),[old]);
    const enabled=await configure('settings',{enabled:true});assert.equal(enabled.enabled,true);assert.equal(enabled.pendingCount,1);assert.equal((await rows()).length,2);assert.equal((await claim()).length,1);
  });
  test('explicit activation enrolls existing unified connections latest-only, never edits authored content',async()=>{
    const before=(await db.query('select * from public.growell_meeting_records order by id')).rows;await db.exec(activate);assert.equal((await rows()).length,2);assert.equal((await rows()).every(j=>j.record_id===R2),true);
    await db.exec(activate);assert.equal((await rows()).length,2);assert.deepEqual((await db.query('select * from public.growell_meeting_records order by id')).rows,before);
  });
  test('browser roles cannot inspect recipients, change subscriptions, claim delivery, or read worker secrets',async()=>{
    for(const role of ['anon','authenticated'])for(const statement of ['select * from public.growell_meeting_mail_subscriptions','select * from public.growell_meeting_mail_jobs',"select public.growell_meeting_mail_configure('owner','"+AUTH+"','connect','{}')",'select public.growell_meeting_mail_claim(1)','select public.growell_meeting_mail_worker_secret()',"select public.growell_meeting_mail_worker_authorized('pretend-secret')"]){await assert.rejects(as(role,()=>db.exec(statement)),codeIs('42501'),role+statement);}
    assert.equal(await rpc('worker_authorized',['synthetic-worker-secret-not-an-operating-credential']),true);assert.equal(await rpc('worker_authorized',['wrong-secret-long-enough-for-validation']),false);
    await assert.rejects(claim(6),codeIs('22023'));
  });
  test('duplicate or missing worker secret definitions fail closed without exposing any secret',async()=>{
    await db.exec("insert into vault.decrypted_secrets values('growell_habit_sync_worker_secret','duplicate-fixture-value-that-must-not-be-selected')");
    assert.equal(await rpc('worker_authorized',['synthetic-worker-secret-not-an-operating-credential']),false);await assert.rejects(rpc('worker_secret',[]),codeIs('55000'));
    await db.exec("delete from vault.decrypted_secrets where decrypted_secret='duplicate-fixture-value-that-must-not-be-selected'");
    assert.equal(await rpc('worker_authorized',['synthetic-worker-secret-not-an-operating-credential']),true);
  });
});
