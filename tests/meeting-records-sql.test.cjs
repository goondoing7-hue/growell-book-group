'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync(path.join(__dirname,'../server/meeting-records.sql'),'utf8');
const verification=fs.readFileSync(path.join(__dirname,'../server/meeting-records-verification.sql'),'utf8');
const AUTH='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const MEMBER='33333333-3333-4333-8333-333333333333';
const PENDING='44444444-4444-4444-8444-444444444444';
const ID='55555555-5555-4555-8555-555555555555';
const ID2='66666666-6666-4666-8666-666666666666';
const errorCode=code=>error=>error.code===code;
const record=overrides=>({id:ID,bookId:'emotion',round:1,date:'2026-10-11',topic:'함께 생각한 내용',
  sections:[{id:'section-1',summary:'감정을 알아차리기',detail:'서로 다른 의견을 듣고 대화를 이어 갔습니다.'}],
  concepts:[{id:'concept-1',word:'공감',meaning:'상대의 경험을 이해하려고 듣기'}],materialIds:['mn_owner'],status:'draft',userId:'owner',...overrides});

// Isolated PostgreSQL execution: no network, real member data, or live secrets.
describe('Meeting records PostgreSQL authorization and persistence',()=>{
  let db;
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;
      grant usage on schema public to anon,authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
      create table public.profiles(id text primary key,auth_user_id uuid unique not null,is_deleted boolean not null default false,
        is_admin boolean not null default false,approval_status text not null default 'pending',private_key text default 'never-expose',
        login_id text,name text,pbkdf2_salt text,avatar_url text);
      create table public.book_locks(book_id text primary key,locked boolean not null,note text);
      create table public.material_notes(id text primary key,user_id text not null references public.profiles(id),book_id text not null,html text default 'original material',note_type text,title text,created_at bigint);
      create table public.private_entries(id text primary key,data text);
      insert into public.private_entries values('private-1','encrypted-private-content');
      create function public.growell_is_active_member() returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.profiles where auth_user_id=auth.uid() and not is_deleted and approval_status='approved')$$;
      create function public.growell_is_approved_admin() returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.profiles where auth_user_id=auth.uid() and not is_deleted and approval_status='approved' and is_admin)$$;`);
    await db.exec(migration);
  });
  beforeEach(async()=>{
    await db.exec('reset role;truncate public.growell_meeting_records,public.material_notes,public.profiles,public.book_locks');
    await db.query(`insert into public.profiles(id,auth_user_id,is_admin,approval_status) values
      ('owner',$1,true,'approved'),('other',$2,true,'approved'),('member',$3,false,'approved'),('pending',$4,true,'pending')`,[AUTH,OTHER,MEMBER,PENDING]);
    await db.exec(`insert into public.material_notes(id,user_id,book_id) values
      ('mn_owner','owner','emotion'),('mn_other','other','emotion'),('mn_other_book','owner','thought'),('mn_member','member','emotion');`);
  });
  after(async()=>{await db?.close();});
  async function as(auth,operation,role='authenticated'){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[auth||'']);
    await db.exec('set role '+role);
    try{return await operation();}finally{await db.exec('reset role');}
  }
  const save=(value=record(),revision=0,auth=AUTH)=>as(auth,async()=>
    (await db.query('select public.growell_save_meeting_record($1::jsonb,$2::bigint) as value',[JSON.stringify(value),revision])).rows[0].value);
  const list=(auth=AUTH,book='emotion')=>as(auth,async()=>
    (await db.query('select public.growell_get_meeting_records($1) as value',[book])).rows[0].value);
  const remove=(revision=1,auth=AUTH,id=ID)=>as(auth,async()=>
    (await db.query('select public.growell_delete_meeting_record($1::uuid,$2::bigint) as value',[id,revision])).rows[0].value);
  const stored=()=>db.query('select * from public.growell_meeting_records order by id').then(result=>result.rows);

  test('browser roles cannot bypass RPC authorization with direct table or internal helper access',async()=>{
    await save();
    for(const role of ['anon','authenticated']){
      for(const query of ['select * from public.growell_meeting_records','delete from public.growell_meeting_records',
        "select public.growell_meeting_record_json(null::public.growell_meeting_records)"]){
        await assert.rejects(as(AUTH,()=>db.exec(query),role),errorCode('42501'));
      }
    }
    for(const query of ["select public.growell_get_meeting_records('emotion')",
      "select public.growell_save_meeting_record('{}',0)",`select public.growell_delete_meeting_record('${ID}',1)`]){
      await assert.rejects(as(null,()=>db.exec(query),'anon'),errorCode('42501'));
    }
    assert.equal((await db.query("select relrowsecurity from pg_class where relname='growell_meeting_records'")).rows[0].relrowsecurity,true);
  });
  test('only active approved admins write, and authority is checked for each operation',async()=>{
    for(const auth of [null,MEMBER,PENDING,'77777777-7777-4777-8777-777777777777']){
      await assert.rejects(save(record(),0,auth),errorCode('42501'));
      await assert.rejects(remove(1,auth),errorCode('42501'));
    }
    await save();
    await db.exec("update public.profiles set is_admin=false where id='owner'");
    await assert.rejects(save(record({topic:'changed'}),1),errorCode('42501'));
    await db.exec("update public.profiles set is_admin=true,is_deleted=true where id='owner'");
    await assert.rejects(save(record({topic:'changed'}),1),errorCode('42501'));
    await assert.rejects(list(),errorCode('42501'));
    assert.equal((await stored())[0].topic,record().topic);
  });
  test('drafts are visible only to their admin owner and incomplete work can be saved',async()=>{
    const incomplete=record({date:null,topic:'',sections:[],concepts:[{id:'draft-word',word:'',meaning:''}],materialIds:[]});
    const saved=await save(incomplete);
    assert.equal(saved.revision,1);assert.equal(saved.date,null);assert.deepEqual(saved.sections,[]);
    assert.deepEqual(await list(),[saved]);assert.deepEqual(await list(OTHER),[]);assert.deepEqual(await list(MEMBER),[]);
    await assert.rejects(list(PENDING),errorCode('42501'));
    const blankSection=record({sections:[{id:'one',summary:'',detail:''}],materialIds:[]});
    assert.equal((await save(blankSection,1)).revision,2);
  });
  test('publishing exposes only the approved DTO and withdrawing removes it from member reads',async()=>{
    const saved=await save(record({status:'published'}));
    assert.deepEqual(await list(MEMBER),[saved]);assert.deepEqual(await list(OTHER),[saved]);
    assert.deepEqual(Object.keys(saved).sort(),['id','bookId','round','date','topic','sections','concepts','materialIds','status','userId','revision','createdAt','updatedAt'].sort());
    const originalPrivate=(await db.query('select * from public.private_entries')).rows;
    const originalMaterial=(await db.query('select * from public.material_notes order by id')).rows;
    await save(record({status:'draft'}),1);assert.deepEqual(await list(MEMBER),[]);
    assert.deepEqual((await db.query('select * from public.private_entries')).rows,originalPrivate);
    assert.deepEqual((await db.query('select * from public.material_notes order by id')).rows,originalMaterial);
  });
  test('book lock and pending/deleted status deny reads even after a prior authorized read',async()=>{
    await save(record({status:'published'}));await list(MEMBER);
    await db.exec("insert into public.book_locks(book_id,locked) values('emotion',true)");
    await assert.rejects(list(MEMBER),errorCode('42501'));assert.equal((await list()).length,1);
    await assert.rejects(list(MEMBER,'thought'),errorCode('42501'));
    await db.exec("update public.book_locks set locked=false;update public.profiles set approval_status='pending' where id='member'");
    await assert.rejects(list(MEMBER),errorCode('42501'));
    await db.exec("update public.profiles set approval_status='approved',is_deleted=true where id='member'");
    await assert.rejects(list(MEMBER),errorCode('42501'));
  });
  test('other administrators cannot edit, delete, or impersonate a meeting owner',async()=>{
    await save(record({status:'published'}));
    await assert.rejects(save(record({userId:'other'}),1,OTHER),errorCode('42501'));
    await assert.rejects(save(record(),1,OTHER),errorCode('42501'));
    await assert.rejects(remove(1,OTHER),errorCode('42501'));
    assert.equal((await stored())[0].revision,1);
  });
  test('same-ID identical retries are idempotent, stale writes conflict, and creation time survives edits',async()=>{
    const first=await save();assert.deepEqual(await save(),first);
    const second=await save(record({topic:'수정 내용',status:'published'}),1);
    assert.equal(second.revision,2);assert.equal(second.createdAt,first.createdAt);
    assert.deepEqual(await save(record({topic:'수정 내용',status:'published'}),1),second);
    await assert.rejects(save(record({topic:'다른 기기'}),1),errorCode('40001'));
    await assert.rejects(save(),errorCode('40001'));
    await assert.rejects(save(record({id:ID2}),0),errorCode('23505'));
    await assert.rejects(save(record({bookId:'thought',materialIds:[]}),2),errorCode('22023'));
    assert.equal((await stored()).length,1);assert.equal((await stored())[0].revision,2);
  });
  test('deleted records are tombstoned, retry safely, never appear in reads, and cannot be recreated',async()=>{
    await save(record({status:'published'}));
    await assert.rejects(remove(2),errorCode('40001'));
    const deletion=await remove();assert.deepEqual(deletion,{id:ID,deleted:true,revision:2});assert.deepEqual(await remove(),deletion);
    assert.deepEqual(await list(),[]);assert.deepEqual(await list(MEMBER),[]);
    await assert.rejects(save(record(),2),errorCode('40001'));
    await assert.rejects(save(),errorCode('40001'));
    const replacement=await save(record({id:ID2}));assert.equal(replacement.revision,1);
    const rows=await stored();assert.equal(rows.length,2);assert.ok(rows[0].deleted_at);assert.equal(rows[0].topic,record().topic);
  });
  test('materials must exist in the same book and belong to the writing administrator',async()=>{
    for(const materialIds of [['missing'],['mn_other'],['mn_other_book'],['mn_member'],['mn_owner','mn_owner'],['../private'],['private-1']]){
      await assert.rejects(save(record({materialIds})),errorCode('22023'));
    }
    await save();await db.exec("delete from public.material_notes where id='mn_owner'");
    await assert.rejects(save(record({topic:'keep link'}),1),errorCode('22023'));
    assert.equal((await stored())[0].revision,1);
    assert.equal((await save(record({materialIds:[]}),1)).revision,2);
  });
  test('published records require complete sections, concepts, topic and a real date',async()=>{
    const bad=[{date:null},{date:'2026-02-30'},{date:'2026-13-01'},{date:'2026-1-01'},{date:'0000-01-01'},
      {topic:'  '},{sections:[]},{sections:[{id:'s',summary:'',detail:'text'}]},
      {sections:[{id:'s',summary:'text',detail:'  '}]},{concepts:[{id:'c',word:'',meaning:'text'}]},
      {concepts:[{id:'c',word:'text',meaning:''}]}];
    for(const fields of bad)await assert.rejects(save(record({...fields,status:'published'})),errorCode('22023'));
    assert.equal((await stored()).length,0);
  });
  test('malformed, oversized, duplicate, and extra-field input is rejected without truncating or saving',async()=>{
    const section={id:'s',summary:'text',detail:'detail'},concept={id:'c',word:'word',meaning:'meaning'};
    const bad=[{round:0},{round:10000},{round:'1'},{bookId:'private'},{status:'unknown'},{topic:'x'.repeat(161)},
      {sections:null},{sections:[section,section]},{sections:[{...section,detail:'x'.repeat(10001)}]},
      {sections:[{...section,summary:'x'.repeat(121)}]},{sections:[{...section,secret:'unexpected'}]},
      {sections:Array.from({length:21},(_,i)=>({...section,id:'s'+i}))},{sections:[null]},
      {concepts:[concept,concept]},{concepts:[{...concept,word:'x'.repeat(81)}]},
      {concepts:[{...concept,meaning:'x'.repeat(4001)}]},{concepts:Array.from({length:31},(_,i)=>({...concept,id:'c'+i}))},
      {materialIds:Array.from({length:31},(_,i)=>'m'+i)},{materialIds:[null]},{privateEntries:{secret:'never allowed'}}];
    for(const fields of bad)await assert.rejects(save(record(fields)),errorCode('22023'));
    for(const value of [null,[],{},'text'])await assert.rejects(save(value),errorCode('22023'));
    for(const revision of [null,-1,9007199254740991])await assert.rejects(save(record(),revision),errorCode('22023'));
    assert.equal((await stored()).length,0);
  });
  test('migration is repeatable and retains existing records and source tables',async()=>{
    const saved=await save();await db.exec(migration);assert.deepEqual(await list(),[saved]);
    assert.equal((await db.query('select count(*)::int as n from public.private_entries')).rows[0].n,1);
  });
  test('production rollback verification executes and leaves no synthetic changes behind',async()=>{
    const saved=await save();
    const beforeProfiles=(await db.query('select * from public.profiles order by id')).rows;
    const beforeSources=(await db.query('select * from public.material_notes order by id')).rows;
    const output=await db.exec(migration.replace(/commit;\s*$/i,'')+'\n'+verification);
    assert.ok(output.some(result=>result.rows?.[0]?.verification?.ok===true));
    assert.deepEqual(await list(),[saved]);
    assert.deepEqual((await db.query('select * from public.profiles order by id')).rows,beforeProfiles);
    assert.deepEqual((await db.query('select * from public.material_notes order by id')).rows,beforeSources);
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n,0);
  });
});
