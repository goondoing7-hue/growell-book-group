'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=name=>fs.readFileSync(path.join(__dirname,'../server',name),'utf8');
const patch=read('meeting-records-preparation-end-time.sql');
const AUTH='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',MEMBER='33333333-3333-4333-8333-333333333333';
const ID='55555555-5555-4555-8555-555555555555',LEGACY='99999999-9999-4999-8999-999999999997';
const preparation=()=>({date:'2026-11-07',time:'13:30',place:'원문 장소  ',reading:'2장\n원문 범위  ',sharing:'',habit:''});
const record=extra=>({id:ID,bookId:'emotion',round:2,date:'2026-10-24',topic:'모임 내용',
  sections:[{id:'section-1',summary:'원문 요약',detail:'  원문 본문\n\n😀 그대로  '}],concepts:[],thoughtQuestions:[{id:'question-1',text:'원문 질문'}],
  materialIds:['mn_owner'],nextMeeting:preparation(),status:'draft',userId:'owner',...extra});
const codeIs=code=>error=>error.code===code;

describe('Optional next-meeting end time preserves records and older saves',()=>{
  let db,legacySnapshot,saveDefinition,serializeDefinition;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;
      grant usage on schema public to anon,authenticated;create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
      create table public.profiles(id text primary key,auth_user_id uuid unique,is_deleted boolean default false,is_admin boolean default false,approval_status text default 'approved');
      create table public.book_locks(book_id text primary key,locked boolean);
      create table public.material_notes(id text primary key,user_id text,book_id text,html text);
      create table public.private_entries(id text primary key,data text);
      create function public.growell_is_active_member() returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.profiles where auth_user_id=auth.uid() and not is_deleted and approval_status='approved')$$;
      create function public.growell_is_approved_admin() returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.profiles where auth_user_id=auth.uid() and not is_deleted and approval_status='approved' and is_admin)$$;
      insert into public.profiles(id,auth_user_id,is_admin) values('owner','${AUTH}',true),('other','${OTHER}',true),('member','${MEMBER}',false);
      insert into public.material_notes values('mn_owner','owner','emotion','  SOURCE MATERIAL ORIGINAL  ');
      insert into public.private_entries values('private','ENCRYPTED PRIVATE ORIGINAL');`);
    for(const name of ['meeting-records.sql','meeting-records-next-preparation.sql','meeting-records-thought-questions.sql'])await db.exec(read(name));
    await db.query(`insert into public.growell_meeting_records(id,book_id,round,meeting_date,topic,sections,concepts,thought_questions,material_ids,next_meeting,status,user_id,revision,created_at,updated_at)
      values($1,'emotion',1,'2026-10-10','기존 기록','[{"id":"original","summary":"원래 요약","detail":"  원문 😀  "}]','[]','[]','{}',$2::jsonb,'published','owner',17,'2026-10-10T10:00:00Z','2026-10-10T11:00:00Z')`,[LEGACY,JSON.stringify(preparation())]);
    legacySnapshot=(await db.query('select to_jsonb(r) as value from public.growell_meeting_records r where id=$1',[LEGACY])).rows[0].value;
    saveDefinition=(await db.query("select pg_get_functiondef('public.growell_save_meeting_record(jsonb,bigint)'::regprocedure) as value")).rows[0].value;
    serializeDefinition=(await db.query("select pg_get_functiondef('public.growell_meeting_record_json(public.growell_meeting_records)'::regprocedure) as value")).rows[0].value;
    await db.exec(patch);
  });
  beforeEach(async()=>{await db.exec('reset role');await db.query('delete from public.growell_meeting_records where id<>$1',[LEGACY]);});
  after(async()=>{await db?.close();});
  async function as(auth,operation,role='authenticated'){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[auth||'']);await db.exec('set role '+role);
    try{return await operation();}finally{await db.exec('reset role');}
  }
  const save=(value=record(),revision=0,auth=AUTH)=>as(auth,async()=>(await db.query('select public.growell_save_meeting_record($1::jsonb,$2::bigint) as value',[JSON.stringify(value),revision])).rows[0].value);
  const list=(auth=AUTH)=>as(auth,async()=>(await db.query("select public.growell_get_meeting_records('emotion') as value")).rows[0].value);

  test('patch changes no authored rows or serializers and keeps every other save check byte-for-byte',async()=>{
    const current=(await db.query('select to_jsonb(r) as value from public.growell_meeting_records r where id=$1',[LEGACY])).rows[0].value;
    assert.deepEqual(current,legacySnapshot);
    const definition=(await db.query("select pg_get_functiondef('public.growell_save_meeting_record(jsonb,bigint)'::regprocedure) as value")).rows[0].value;
    const addition=/\n  -- An older editor knows the other preparation fields but omits endTime\.[\s\S]*?\n  end if;/;
    assert.match(definition,addition);assert.equal(definition.replace(addition,''),saveDefinition.replace(/\r/g,''));
    assert.equal((await db.query("select pg_get_functiondef('public.growell_meeting_record_json(public.growell_meeting_records)'::regprocedure) as value")).rows[0].value,serializeDefinition);
    assert.equal((await db.query("select html from public.material_notes where id='mn_owner'")).rows[0].html,'  SOURCE MATERIAL ORIGINAL  ');
    assert.equal((await db.query('select data from public.private_entries')).rows[0].data,'ENCRYPTED PRIVATE ORIGINAL');
    await db.exec(patch);assert.equal((await db.query("select pg_get_functiondef('public.growell_save_meeting_record(jsonb,bigint)'::regprocedure) as value")).rows[0].value,definition);
  });
  test('the exact optional range survives RPC, list, retry, publication and patch reapplication',async()=>{
    const nextMeeting={...preparation(),endTime:'15:00'},saved=await save(record({nextMeeting}));
    assert.deepEqual(saved.nextMeeting,nextMeeting);assert.deepEqual(await save(record({nextMeeting})),saved);
    assert.deepEqual((await list()).find(row=>row.id===ID),saved);assert.equal((await list(MEMBER)).some(row=>row.id===ID),false);
    await db.exec(patch);assert.deepEqual((await list()).find(row=>row.id===ID),saved);
    const published=await save({...saved,status:'published'},1);assert.deepEqual((await list(MEMBER)).find(row=>row.id===ID).nextMeeting,nextMeeting);
    assert.equal(published.createdAt,saved.createdAt);assert.deepEqual(published.sections,saved.sections);assert.equal(published.userId,saved.userId);
  });
  test('old editors preserve stored end time and omitted preparation with idempotent retries',async()=>{
    const saved=await save(record({nextMeeting:{...preparation(),endTime:'15:00'}}));
    const legacy={...saved,nextMeeting:{...preparation(),place:'수정한 장소'}};delete legacy.thoughtQuestions;
    const edited=await save(legacy,1);assert.equal(edited.nextMeeting.endTime,'15:00');assert.equal(edited.nextMeeting.place,'수정한 장소');assert.deepEqual(edited.thoughtQuestions,saved.thoughtQuestions);
    assert.deepEqual(await save(legacy,1),edited);
    const noPreparation={...edited,topic:'주제만 수정'};delete noPreparation.nextMeeting;
    const title=await save(noPreparation,2);assert.deepEqual(title.nextMeeting,edited.nextMeeting);
    const cleared=await save({...title,nextMeeting:{...title.nextMeeting,endTime:''}},3);assert.equal(cleared.nextMeeting.endTime,'');
    const removed=await save({...cleared,nextMeeting:null},4);assert.equal(removed.nextMeeting,null);assert.deepEqual(removed.sections,saved.sections);
  });
  test('invalid end times and retained end times made inconsistent by an old editor fail atomically',async()=>{
    const saved=await save(record({nextMeeting:{...preparation(),endTime:'15:00'}}));
    for(const endTime of [null,15,{},[],'24:00','15:60','3:00','13:30','13:29','00:00'])
      await assert.rejects(save({...saved,nextMeeting:{...saved.nextMeeting,endTime}},1),codeIs('22023'));
    await assert.rejects(save({...saved,nextMeeting:{...preparation(),time:'16:00'}},1),codeIs('22023'));
    assert.deepEqual((await list()).find(row=>row.id===ID),saved);
    const legacy=await save({...saved,nextMeeting:{...preparation(),endTime:'',time:''}},1);assert.equal(legacy.nextMeeting.endTime,'');
  });
  test('owner checks, helper privileges, conflict fences and original record remain intact',async()=>{
    const saved=await save(record({nextMeeting:{...preparation(),endTime:'15:00'}}));
    for(const [auth,userId] of [[OTHER,'other'],[MEMBER,'member'],[null,'owner']])await assert.rejects(save({...saved,userId},1,auth),codeIs('42501'));
    for(const role of ['anon','authenticated'])await assert.rejects(as(AUTH,()=>db.exec("select public.growell_valid_meeting_preparation('{}')"),role),codeIs('42501'));
    await assert.rejects(save({...saved,topic:'충돌'},0),codeIs('40001'));
    assert.deepEqual((await list()).find(row=>row.id===ID),saved);
    assert.deepEqual((await db.query('select to_jsonb(r) as value from public.growell_meeting_records r where id=$1',[LEGACY])).rows[0].value,legacySnapshot);
  });
});
