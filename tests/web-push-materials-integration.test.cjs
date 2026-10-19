'use strict';
const {describe,test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const Service=require('../server/webPushService.cjs'),Backup=require('../server/driveBackupDomain.cjs');
const ROOT=path.join(__dirname,'..'),sql=fs.readFileSync(path.join(ROOT,'server/web-push.sql'),'utf8');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),workerSource=fs.readFileSync(path.join(ROOT,'timer-alert-sw.js'),'utf8');
const AUTH={reader:'11111111-1111-4111-8111-111111111111',author:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333'};
const BOOKS={emotion:'감정을 마주하면 길이 보인다',thought:'생각이 너무 많은 어른들을 위한 심리학',body:'몸이 나를 위로한다',action:'습관이 영성이다'};
const ec=crypto.createECDH('prime256v1');ec.generateKeys();
const config=Service.getConfig({SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',GROWELL_SYNC_KEY:Buffer.alloc(32,8).toString('base64'),GROWELL_WEB_PUSH_PUBLIC_KEY:ec.getPublicKey().toString('base64url'),GROWELL_WEB_PUSH_PRIVATE_KEY:ec.getPrivateKey().toString('base64url')});
function subscription(owner){return {endpoint:'https://fcm.googleapis.com/fcm/send/SYNTHETIC_'+owner,expirationTime:null,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,3).toString('base64url')}};}
function source(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function appMaterialWrite(existing){
  let saved;const context={SESSION:{userId:'author',name:'SYNTHETIC AUTHOR'},STATE:{materialNotes:existing?{[existing.id]:existing}:{}},Date,
    location:{hash:'#/book/emotion/materials'},isAdmin:()=>true,showToast(){throw new Error('unexpected toast');},
    buildMaterialFields:payload=>({ok:true,fields:payload}),captureComposerDraft:()=>({}),uid:()=> 'mn_actual_new',
    saveState(mutate){saved={materialNotes:{...context.STATE.materialNotes}};mutate(saved);},urlFromPhoto:photo=>photo&&photo.dataUrl||null};
  vm.createContext(context);vm.runInContext(source('var GENERIC_COLLECTIONS = {','function diffDict('),context);
  vm.runInContext(source('function submitMaterialPost(','function deleteMaterialNote('),context);
  const fields={title:'PRIVATE SOURCE TITLE',html:'FULL SOURCE BODY',noteType:'article',driveLinks:[{title:'PRIVATE LINK TITLE',driveUrl:'https://example.org/source'}]};
  if(existing)context.editMaterialPost(existing.id,fields);else context.submitMaterialPost('emotion',fields);
  assert.ok(saved);const record=saved.materialNotes[existing?existing.id:'mn_actual_new'];
  return {record,row:JSON.parse(JSON.stringify(context.GENERIC_COLLECTIONS.materialNotes.toRow(record)))};
}
function worker(windows=[]){
  const events={},shown=[],opened=[],focused=[];
  const context={URL,Promise,self:{location:{origin:'https://growell-book.vercel.app'},addEventListener:(name,fn)=>{events[name]=fn;},registration:{showNotification:async(title,options)=>{shown.push({title,options});}},
    clients:{matchAll:async()=>windows.map(url=>({url,focus:async()=>{focused.push(url);}})),openWindow:async url=>{opened.push(url);}}}};
  vm.createContext(context);vm.runInContext(workerSource,context);
  return {shown,opened,focused,async push(payload){let task;events.push({data:{json:()=>payload},waitUntil:value=>{task=value;}});if(task)await task;},
    async click(data){let task;events.notificationclick({notification:{data,close(){}},waitUntil:value=>{task=value;}});if(task)await task;}};
}

describe('Actual material insert → durable queue → server payload → service worker',()=>{
  let db;
  before(async()=>{
    db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create table profiles(id text primary key,auth_user_id uuid unique not null,approval_status text default 'approved',is_deleted boolean default false,is_admin boolean default false);
      create table book_locks(book_id text primary key,locked boolean);
      create table posts(id text primary key,user_id text,book_id text,html text);
      create table material_notes(id text primary key,user_id text,book_id text,title text,html text,drive_links jsonb default '[]',created_at bigint,updated_at bigint,
        is_private boolean default false,visibility text default 'public',is_deleted boolean default false,deleted_at timestamptz);
      create table private_entries(id text primary key,user_id text,data text);
      create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);`);await db.exec(sql);
  });
  beforeEach(async()=>{
    await db.exec('truncate growell_web_push_jobs,growell_web_push_subscriptions,material_notes,posts,private_entries,book_locks,profiles');
    for(const owner of Object.keys(AUTH))await db.query('insert into profiles(id,auth_user_id,is_admin) values($1,$2::uuid,$3)',[owner,AUTH[owner],owner==='author']);
  });
  after(async()=>{await db.close();});
  async function rpc(name,args=[]){const types={configure:'$1,$2::uuid,$3,$4::jsonb',tick:'$1::timestamptz',claim:'$1::integer',apply:'$1::uuid,$2::uuid,$3,$4::jsonb'};
    return (await db.query('select growell_web_push_'+name+'('+types[name]+') as value',args.map(value=>value&&typeof value==='object'?JSON.stringify(value):value))).rows[0].value;}
  async function connect(owner='reader',settings={}){const sub=subscription(owner),fingerprint=Service.fingerprint(sub.endpoint),subscription_cipher=Backup.seal(sub,config.key,Service.context(owner,AUTH[owner],fingerprint));
    return rpc('configure',[owner,AUTH[owner],'connect',{fingerprint,subscription_cipher,...settings}]);}
  async function insert(id='mn_source',owner='author',book='emotion',extra={}){await db.query(`insert into material_notes(id,user_id,book_id,title,html,drive_links,created_at,is_private,visibility,is_deleted,deleted_at)
    values($1,$2,$3,'PRIVATE SOURCE TITLE','FULL SOURCE BODY','[{"title":"PRIVATE LINK TITLE","driveUrl":"https://example.org/source"}]',1,$4,$5,$6,$7::timestamptz)`,[id,owner,book,extra.private||false,extra.visibility||'public',extra.deleted||false,extra.deletedAt||null]);}
  const jobs=()=>db.query('select * from growell_web_push_jobs order by created_at,id').then(value=>value.rows);
  const originals=()=>db.query('select * from material_notes order by id').then(value=>value.rows);
  const claim=()=>rpc('claim',[10]);
  const apply=(job,operation)=>rpc('apply',[job.id,job.lease_token,operation,{}]);

  test('real app new and edit paths keep the same source identity and only a new insert queues readers',async()=>{
    await connect();await connect('author');await connect('other',{new_posts:false});
    const fresh=appMaterialWrite(),row=fresh.row;
    await db.query('insert into material_notes(id,user_id,book_id,title,html,drive_links,created_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)',[row.id,row.user_id,row.book_id,row.title,row.html,JSON.stringify(row.drive_links),row.created_at]);
    const pending=await jobs();assert.equal(pending.length,1);assert.equal(pending[0].owner_id,'reader');assert.equal(pending[0].kind,'material');assert.equal(pending[0].material_id,row.id);assert.equal(pending[0].book_id,'emotion');
    const modified=appMaterialWrite(fresh.record).row;assert.equal(modified.id,row.id);assert.equal(modified.created_at,row.created_at);assert.ok(modified.updated_at);
    await db.query('update material_notes set html=$1,updated_at=$2 where id=$3',[modified.html,modified.updated_at,modified.id]);assert.equal((await jobs()).length,1,'an edit never becomes a new-material notification');
    const text=JSON.stringify(pending);for(const secret of ['FULL SOURCE BODY','PRIVATE SOURCE TITLE','PRIVATE LINK TITLE','https://example.org/source'])assert.equal(text.includes(secret),false);
  });
  test('install, repeat install and new device connection never backfill or change existing materials',async()=>{
    await insert();await db.exec("insert into private_entries values('private','reader','ENCRYPTED ORIGINAL')");const before=await originals();
    await db.exec(sql);await connect();assert.deepEqual(await jobs(),[]);assert.deepEqual(await originals(),before);
    assert.equal((await db.query("select data from private_entries where id='private'")).rows[0].data,'ENCRYPTED ORIGINAL');
  });
  test('private, removed, unapproved and locked material sources do not queue ordinary readers',async()=>{
    await connect();for(const [id,extra]of [['private',{private:true}],['hidden',{visibility:'private'}],['removed',{deleted:true}],['tombstone',{deletedAt:'2026-10-19'}]])await insert(id,'author','emotion',extra);
    await insert('future','author','thought');await db.exec("update profiles set approval_status='pending' where id='author'");await insert('pending');
    await db.exec("update profiles set approval_status='approved',is_deleted=true where id='author'");await insert('deleted_author');assert.deepEqual(await jobs(),[]);
  });
  test('source deletion, book move, late lock, revoked approval or preference cancel a claimed material',async()=>{
    for(const change of ["delete from material_notes where id='mn_source'","update material_notes set book_id='thought' where id='mn_source'","insert into book_locks values('emotion',true)","update profiles set approval_status='pending' where id='reader'","update growell_web_push_subscriptions set new_posts=false"]){
      await connect();await insert();const job=(await claim())[0];assert.ok(job,change);await db.exec(change);assert.deepEqual(await apply(job,'prepare'),{applied:false},change);
      await db.exec("truncate growell_web_push_jobs,growell_web_push_subscriptions,material_notes,book_locks;update profiles set approval_status='approved'");
    }
  });
  test('actual SQL snapshot survives server validation and reaches the actual worker without copying source text',async()=>{
    await connect('reader',{daily_verse:false});await insert();const before=await originals(),sent=[];
    const store={tick:stamp=>rpc('tick',[new Date(stamp).toISOString()]),claim:limit=>rpc('claim',[limit]),apply:(job,operation,payload={})=>rpc('apply',[job.id,job.lease_token,operation,payload])};
    const service=Service.createService({config,store,provider:{send:async(...args)=>{sent.push(args);}}});const result=await service.run();
    assert.equal(result.accepted,1);assert.equal(sent.length,1);const payload=sent[0][1];assert.equal(payload.type,'material');assert.equal(payload.materialId,'mn_source');assert.equal(payload.bookId,'emotion');
    assert.deepEqual(Object.keys(payload).sort(),['version','type','bookId','materialId','tag','body'].sort());
    const sw=worker();await sw.push({...payload,body:'DO NOT DISPLAY SOURCE BODY',title:'PRIVATE TITLE',url:'https://attacker.example/'});
    assert.equal(sw.shown.length,1);assert.equal(sw.shown[0].title,'GROWELL 새 자료');assert.equal(sw.shown[0].options.body,'『'+BOOKS.emotion+'』 자료실에 새 자료가 올라왔어요.');
    assert.equal(sw.shown[0].options.data.materialId,'mn_source');assert.deepEqual(await originals(),before);assert.equal((await jobs())[0].status,'sent');
    const wire=JSON.stringify([payload,sw.shown]);for(const sensitive of ['PRIVATE SOURCE TITLE','FULL SOURCE BODY','PRIVATE LINK TITLE','SYNTHETIC_reader','DO NOT DISPLAY SOURCE BODY','attacker'])assert.equal(wire.includes(sensitive),false,sensitive);
  });
});

test('every allowed material book opens its real detail route while another tab and its draft stay untouched',async()=>{
  for(const [book,title]of Object.entries(BOOKS)){
    const payload=Service.payloadFor({kind:'material',material_id:'mn_own-path-1',book_id:book},Date.now()),route='https://growell-book.vercel.app/#/book/'+book+'/materials/post/mn_own-path-1';
    const other='https://growell-book.vercel.app/#/book/emotion/mine',sw=worker([other]);await sw.push(payload);assert.equal(sw.shown[0].options.body,'『'+title+'』 자료실에 새 자료가 올라왔어요.');
    await sw.click(sw.shown[0].options.data);assert.deepEqual(sw.opened,[route]);assert.deepEqual(sw.focused,[],'a different tab is never navigated or replaced');
    const exact=worker([other,route]);await exact.push(payload);await exact.click(exact.shown[0].options.data);assert.deepEqual(exact.focused,[route]);assert.deepEqual(exact.opened,[]);
  }
});
test('malformed material routes cannot escape the worker allowlist or impersonate a shared post',async()=>{
  const base={version:1,type:'material',bookId:'emotion',materialId:'mn_safe',tag:'growell-material-mn_safe'};
  for(const patch of [{bookId:'../../admin'},{bookId:'unknown'},{materialId:'../share'},{materialId:'mn_x?next=evil'},{materialId:''},{materialId:'a'.repeat(101)},{materialId:undefined,postId:'p_forged'}]){
    const sw=worker();await sw.push({...base,...patch});assert.equal(sw.shown.length,0);assert.throws(()=>Service.payloadFor({kind:'material',book_id:({...base,...patch}).bookId,material_id:({...base,...patch}).materialId},Date.now()),error=>error.code==='push-unavailable');
  }
  const sw=worker();await sw.click({kind:'growell-push',type:'material',bookId:'emotion',materialId:'../../escape'});assert.deepEqual(sw.opened,['https://growell-book.vercel.app/#/']);
});
