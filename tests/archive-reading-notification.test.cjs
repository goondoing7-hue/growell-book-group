'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../archiveReadingNotification.js'),P=require('../readingNotificationState.js'),D=require('../readingTimerDomain.js'),ArchiveTimer=require('../archiveTimer.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function worker(){
  const records=new Map(),requests=[];let active=null,serial=0,at=Date.now(),permission='granted',readHook=null,failRevoke=false;
  const key=id=>id.ownerKey+':'+id.timerId;
  function operation(request){
    requests.push(clone(request));const identity=request.snapshot||request.identity,raw=records.get(key(identity))||null;
    if(request.type==='arm'&&active&&!P.matches(active,request.expectedActive))return {ok:false,code:'active-conflict',active,state:raw};
    if(request.type==='hold'&&(!active||!P.matches(active,P.head(raw))))return {ok:false,code:'inactive',active,state:raw};
    const changed=P.transition(raw,request,at),result=changed.result;
    if(result.ok&&request.type!=='read'){records.set(key(identity),changed.record);if(request.type==='arm'||active&&P.same(active,changed.record))active=P.head(changed.record);}
    return {...clone(result),active:clone(active)};
  }
  const alerts={notificationStatus:()=>({supported:true,permission}),newGeneration:()=> 'rn-'+(++serial).toString(16).padStart(32,'0'),newLease:()=> 'rh-'+(++serial).toString(16).padStart(32,'0'),
    sessionSnapshot({timer,userId,generation,blocked}){return {ownerKey:P.hash('member:'+userId),timerId:timer.id,bookId:timer.bookId,generation,baseRevision:P.hash(JSON.stringify([timer.id,timer.userId,timer.bookId,timer.elapsedMs,timer.startedAt,timer.running,timer.phase,false,blocked||''])),clock:{elapsedMs:timer.elapsedMs,startedAt:timer.running?timer.startedAt:null,running:timer.running,phase:timer.phase},blocked:timer.phase==='save'?'save':blocked||''};},
    async sessionState(request){if(readHook&&request.type==='read')await readHook(request);if(failRevoke&&request.type==='revoke')return {ok:false,code:'timeout'};return operation(request);}};
  return {alerts,requests,records,operation,setAt(value){at=value;},get at(){return at;},permission(value){permission=value;},setReadHook(value){readHook=value;},failRevoke(value){failRevoke=value;},state(){return clone([...records.values()].at(-1)||null);},action(action){return operation({type:'action',identity:active,action});}};
}
function fixture(){
  const w=worker(),owner='member',entry='private_archive_member_arc_shared_emotion';let current=true,revision=1,error='',changed=0;
  let value={timer:D.create({id:'art_one',userId:owner,bookId:entry},w.at),notification:null,blocked:false,attempt:null,busy:false};
  const adapter={ownerId:owner,bookId:'emotion',alerts:w.alerts,current:()=>current,snapshot:()=>({...clone(value),revision}),
    commit(expected,next){if(expected.revision!==revision)return false;value={...value,...clone(next)};revision++;return true;},changed(){changed++;},error(message){error=message;}};
  const api=N.create(adapter);
  function mutateTimer(next){value.timer=next;if(value.notification){const snapshot=w.alerts.sessionSnapshot({timer:{...next,bookId:'emotion'},userId:owner,generation:value.notification.generation,blocked:value.blocked?'archive':''});value.notification.sourceRevision=snapshot.baseRevision;}revision++;return true;}
  return {w,api,adapter,owner,entry,get value(){return value;},get changed(){return changed;},get error(){return error;},loseOwner(){current=false;},mutateTimer,setBusy(){value.busy=true;},bump(){revision++;},clear(){value.timer=null;revision++;}};
}

test('ebook notification proxy exposes only the public book and exact clock, while the archive timer identity stays unchanged',async()=>{
  const f=fixture();assert.equal(await f.api.sync(),true);assert.equal(f.w.state().bookId,'emotion');assert.equal(f.w.state().timerId,'art_one');assert.equal(f.value.timer.bookId,f.entry);
  assert.equal(f.value.notification.generation,f.w.state().generation);assert.ok(f.w.requests.every(request=>!JSON.stringify(request).includes(f.entry)));
});

test('background pause, resume and finish actions are acknowledged only after a durable clock checkpoint',async()=>{
  const f=fixture();await f.api.sync();f.w.setAt(f.w.at+2000);assert.equal(f.w.action('pause').ok,true);f.api.forget();assert.equal(await f.api.sync(),true);
  assert.equal(f.value.timer.running,false);assert.equal(f.value.timer.elapsedMs,2000);assert.equal(f.w.state().journal.length,0);
  f.w.setAt(f.w.at+3000);assert.equal(f.w.action('resume').ok,true);f.api.forget();await f.api.sync();assert.equal(f.value.timer.running,true);
  f.w.setAt(f.w.at+1000);assert.equal(f.w.action('finish').ok,true);f.api.forget();await f.api.sync();assert.equal(f.value.timer.phase,'save');assert.equal(f.value.timer.elapsedMs,3000);assert.equal(f.value.timer.bookId,f.entry);
});

test('local mutation holds the worker action journal, persists the new clock, then releases it through arm',async()=>{
  const f=fixture();await f.api.sync();let blocked;
  const result=await f.api.mutate(()=>{blocked=f.w.action('pause');return f.mutateTimer(D.pause(f.value.timer,f.w.at+500));});
  assert.equal(result,true);assert.equal(blocked.ok,false);assert.equal(blocked.code,'blocked');assert.equal(f.w.state().held,null);assert.equal(f.w.state().clock.elapsedMs,500);
});

test('failed clock CAS leaves remote actions unacknowledged and prevents the requested local mutation',async()=>{
  const f=fixture();await f.api.sync();f.w.setAt(f.w.at+1000);f.w.action('pause');let ran=false;f.adapter.commit=()=>false;f.api.forget();
  assert.equal(await f.api.mutate(()=>{ran=true;}),false);assert.equal(ran,false);assert.equal(f.w.state().journal.length,1);assert.match(f.error,/다시 눌러/);
});

test('a late worker response from a previous account cannot arm or apply its clock',async()=>{
  const f=fixture();let resolve;const wait=new Promise(yes=>{resolve=yes;});f.w.setReadHook(()=>wait);const request=f.api.sync();await Promise.resolve();f.loseOwner();resolve();assert.equal(await request,false);assert.equal(f.w.records.size,0);
});

test('no-permission users keep existing synchronous timer semantics without worker state requests',async()=>{
  const f=fixture();f.w.permission('denied');let ran=false;assert.equal(await f.api.mutate(()=>{ran=true;return 5;}),5);assert.equal(ran,true);assert.equal(f.w.requests.length,0);
});

test('logout pauses at its cutoff and a subsequent owner-bound coordinator recovers pending actions before remaining blocked',async()=>{
  const f=fixture();await f.api.sync();f.w.setAt(f.w.at+1000);f.w.action('pause');f.w.setAt(f.w.at+2000);f.w.action('resume');f.w.setAt(f.w.at+500);
  await f.api.shutdown(f.w.at);f.loseOwner();assert.equal(f.value.blocked,true);assert.equal(f.w.state().revoked,true);
  const restored=N.create({...f.adapter,current:()=>true});await restored.sync();
  assert.equal(f.value.timer.running,false);assert.equal(f.value.timer.elapsedMs,1500);assert.equal(f.w.state().journal.length,0);assert.equal(f.value.notification.logoutAt,f.w.at);
});

function storageFixture(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),get length(){return values.size;},key:index=>[...values.keys()][index]??null,values};}
test('stored ebook pause reconciles a background action before switching books and preserves all unrelated fields and owners',async()=>{
  const w=worker(),storage=storageFixture(),entry='private_archive_member_arc_shared_emotion',key=ArchiveTimer.storageKey('member',entry),timer=D.create({id:'art_stored',userId:'member',bookId:entry},w.at);
  storage.setItem(key,JSON.stringify({v:1,timer,attempt:null,endPage:14,complete:false,reading:{format:'ebook',startPercent:25,ebook:{sectionId:'real',sectionTitle:'원래 목차',progressPercent:25,progressKind:'estimated',estimateBasis:'equal-sections',updatedAt:1}}}));
  const otherKey=ArchiveTimer.storageKey('someone','private_archive_someone_arc_shared_emotion');storage.setItem(otherKey,'opaque other account bytes');
  assert.equal(await N.syncStored('member',storage,{alerts:w.alerts}),true);w.setAt(w.at+1000);w.action('pause');
  assert.equal(await N.pauseStored('member',storage,{alerts:w.alerts}),true);const result=JSON.parse(storage.getItem(key));
  assert.equal(result.timer.running,false);assert.equal(result.timer.elapsedMs,1000);assert.equal(result.reading.ebook.sectionTitle,'원래 목차');assert.equal(result.endPage,14);assert.equal(result.notificationBlocked,true);assert.equal(w.state().revoked,true);assert.equal(w.state().journal.length,0);
  assert.equal(storage.getItem(otherKey),'opaque other account bytes');assert.equal(N.hasStored('member',storage),false);assert.equal(N.active('member',storage),null);
});

test('the real archive controller uses remote actions and freezes an uncertain percent save without page fabrication',async()=>{
  const w=worker(),storage=storageFixture(),owner='member',entry='private_archive_member_arc_shared_emotion',saves=[];let at=w.at;
  const options={ownerId:owner,storage,now:()=>at,notificationAlerts:w.alerts,book:{id:entry,linkedBookId:'emotion',title:'공유 전자책',currentPage:40,pageCount:200,readingSettings:{format:'ebook',ebook:{sectionId:'one',sectionTitle:'실제 목차',progressPercent:25,progressKind:'estimated',estimateBasis:'equal-sections',updatedAt:1}}},adapter:{getOwnerId:()=>owner,async saveSession(id,session){saves.push({id,session});throw new Error('응답 없음');}}};
  const timer=ArchiveTimer.createController(options);await timer.notificationSync();w.setAt(at+2000);w.action('finish');await timer.notificationSync();assert.equal(timer.state().timer.phase,'save');
  assert.equal(await timer.save(),false);assert.equal(saves.length,1);assert.equal(saves[0].session.unit,'percent');assert.equal(saves[0].session.seconds,2);assert.equal(saves[0].session.startPage,undefined);
  const attempt=timer.state().attempt;assert.ok(attempt);assert.equal(timer.state().timer.bookId,entry);
});

test('failed revoke blocks repeated book handoff until confirmed, preserving the recoverable paused clock',async()=>{
  const w=worker(),storage=storageFixture(),entry='private_archive_member_arc_shared_emotion',key=ArchiveTimer.storageKey('member',entry),timer=D.create({id:'art_handoff',userId:'member',bookId:entry},w.at);
  storage.setItem(key,JSON.stringify({v:1,timer,attempt:null,endPage:0,complete:false,reading:{format:'ebook',startPercent:null,ebook:{sectionId:'',sectionTitle:'',progressPercent:null,progressKind:'',estimateBasis:'',updatedAt:0}}}));
  await N.syncStored('member',storage,{alerts:w.alerts});w.failRevoke(true);
  assert.equal(await N.pauseStored('member',storage,{alerts:w.alerts}),false);assert.equal(N.hasStored('member',storage),true);assert.equal(JSON.parse(storage.getItem(key)).timer.running,false);
  assert.equal(await N.pauseStored('member',storage,{alerts:w.alerts}),false);assert.equal(N.hasStored('member',storage),true,'the next start cannot bypass an unresolved blocked checkpoint');
  w.failRevoke(false);w.setAt(w.at+16000);assert.equal(await N.pauseStored('member',storage,{alerts:w.alerts}),true);assert.equal(N.hasStored('member',storage),false);assert.equal(JSON.parse(storage.getItem(key)).notification.revoked,true);
});
