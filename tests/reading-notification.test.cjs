'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {MessageChannel}=require('node:worker_threads');
const Domain=require('../readingTimerDomain.js');
const Alerts=require('../timerAlerts.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const timerSource=fs.readFileSync(path.join(__dirname,'../timerAlerts.js'),'utf8');
const workerSource=fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function timer(now=0){return Domain.create({id:'rl-synthetic',userId:'PRIVATE_MEMBER',bookId:'emotion',startPage:5},now);}
function notificationHarness(options={}){
  const calls={prompts:0,notifications:[],closed:0},listed=[];
  const registration={active:{state:'activated'},showNotification(title,settings){calls.notifications.push({title,settings});listed.push({data:settings.data,close(){calls.closed++;}});return options.delayedShow||Promise.resolve();},getNotifications:async()=>listed};
  const root={Promise,Date,Math,JSON,Array,Number,Uint8Array,setTimeout,clearTimeout,isSecureContext:true,Notification:{permission:options.permission||'granted',maxActions:options.maxActions,requestPermission(){calls.prompts++;return Promise.resolve('granted');}},
    navigator:{serviceWorker:{register:async()=>registration,getRegistration:async()=>registration}},localStorage:{getItem:()=>null,setItem(){}}};
  vm.createContext(root);vm.runInContext(timerSource,root);return {root,api:root.GrowellTimerAlerts,calls,registration,listed};
}
test('ongoing reading notification uses one tag, safe generic content and explicit pause/resume plus finish actions',async()=>{
  const h=notificationHarness(),raw=timer(Date.now()),view=h.api.sessionView({timer:raw,userId:raw.userId});
  assert.equal(await h.api.showSession(view,()=>true),true);const first=h.calls.notifications[0];
  assert.equal(first.settings.tag,'growell-reading-session');assert.equal(first.settings.requireInteraction,true);assert.equal(first.settings.silent,true);assert.equal(first.settings.renotify,false);
  assert.deepEqual(clone(first.settings.actions),[{action:'pause',title:'일시정지'},{action:'finish',title:'끝내기'}]);
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE_MEMBER|startPage|access_token|keyB64/);assert.match(first.settings.badge,/notification-badge-96/);
  await h.api.showSession(view,()=>true);assert.equal(h.calls.notifications.length,1,'rerenders do not recreate the same notification');
  const paused=Domain.pause(raw,Date.now()),next=h.api.sessionView({timer:paused,userId:raw.userId});await h.api.showSession(next,()=>true);
  assert.equal(h.calls.notifications[1].settings.tag,first.settings.tag);assert.equal(h.calls.notifications[1].settings.actions[0].action,'resume');assert.equal(h.calls.prompts,0);
});
test('default/denied permissions never auto-prompt; note writing offers only a safe return action and action limits are respected',async()=>{
  for(const permission of ['default','denied']){const h=notificationHarness({permission}),raw=timer();assert.equal(await h.api.showSession(h.api.sessionView({timer:raw,userId:raw.userId}),()=>true),false);assert.equal(h.calls.prompts,0);assert.equal(h.calls.notifications.length,0);}
  const h=notificationHarness({maxActions:1}),raw=Domain.pause(timer(),5000);await h.api.showSession(h.api.sessionView({timer:raw,userId:raw.userId,note:true}),()=>true);
  assert.deepEqual(clone(h.calls.notifications[0].settings.actions),[{action:'open',title:'타이머 보기'}]);
  const zero=notificationHarness({maxActions:0});await zero.api.showSession(zero.api.sessionView({timer:raw,userId:raw.userId}),()=>true);assert.equal(zero.calls.notifications[0].settings.actions.length,0);
});
test('finish/save and logout close only the ongoing session notification and stale async displays cannot survive account change',async()=>{
  const h=notificationHarness(),raw=timer(Date.now());await h.api.showSession(h.api.sessionView({timer:raw,userId:raw.userId}),()=>true);
  const paused=Domain.pause(raw,Date.now());paused.phase='save';await h.api.showSession(h.api.sessionView({timer:paused,userId:raw.userId}),()=>true);assert.equal(h.calls.closed,1);
  let finish,current=true;const delayed=new Promise(resolve=>{finish=resolve;}),old=notificationHarness({delayedShow:delayed});const pending=old.api.showSession(old.api.sessionView({timer:raw,userId:raw.userId}),()=>current);await flush();current=false;finish();assert.equal(await pending,false);assert.equal(old.calls.closed,1);
});
test('explicitly showing a dismissed ongoing notification creates it again without asking permission',async()=>{
  const h=notificationHarness(),raw=timer(Date.now()),view=h.api.sessionView({timer:raw,userId:raw.userId});await h.api.showSession(view,()=>true);await h.api.showSession(view,()=>true,true);
  assert.equal(h.calls.notifications.length,2);assert.equal(h.calls.notifications[0].settings.tag,h.calls.notifications[1].settings.tag);assert.equal(h.calls.prompts,0);
});
test('a late old-owner registration lookup cannot close a newer session notification',async()=>{
  const h=notificationHarness(),old=timer(Date.now());let finish;h.root.navigator.serviceWorker.getRegistration=()=>new Promise(resolve=>{finish=resolve;});
  const closing=h.api.closeSession(h.api.sessionView({timer:old,userId:old.userId}));await flush();
  const next=Domain.create({id:'rl-new-member',userId:'ANOTHER_MEMBER',bookId:'thought'},Date.now());await h.api.showSession(h.api.sessionView({timer:next,userId:next.userId}),()=>true);finish(h.registration);
  assert.equal(await closing,false);assert.equal(h.calls.closed,0);assert.equal(h.calls.notifications.length,1);
});
test('a late old-session notification listing cannot close the newly displayed timer',async()=>{
  const h=notificationHarness(),old=timer(Date.now());await h.api.showSession(h.api.sessionView({timer:old,userId:old.userId}),()=>true);
  let finish;h.registration.getNotifications=()=>new Promise(resolve=>{finish=resolve;});const closing=h.api.closeSession();await flush();
  const next=Domain.create({id:'rl-new-reading',userId:old.userId,bookId:'thought'},Date.now());await h.api.showSession(h.api.sessionView({timer:next,userId:next.userId}),()=>true);
  finish([h.listed.at(-1)]);assert.equal(await closing,false);assert.equal(h.calls.closed,0);assert.equal(h.calls.notifications.length,2);
});

const State=require('../readingNotificationState.js');
function appHarness(options={}){
  let clock=5000,nonce=0;const records=options.records||new Map(),values=options.values||new Map(),calls={renders:0,prompts:0,saves:0,acks:0,requests:[],toasts:[]};let active=options.active||null;
  const draft={body:'작성 중인 원문 <b>그대로</b>',photos:['original-photo']};
  const c={Promise,Date:class extends Date{static now(){return clock;}},Number,Math,JSON,URL,console,
    SESSION:{userId:'PRIVATE_MEMBER'},saveSessionEpoch:3,memberPushPromptSession:{},currentMemberPushPrompt:()=>!options.unverified,
    GrowellReadingTimer:Domain,GrowellReadingNotificationState:State,BOOKS:[{id:'emotion',totalPages:100},{id:'thought',totalPages:200},{id:'body',totalPages:200},{id:'action',totalPages:200}],
    readingTimer:timer(0),readingParkedSessions:{},readingTimerStorageOwner:'PRIVATE_MEMBER',readingTimerStorageSnapshot:null,readingTimerStorageWritable:true,readingTimerRestoreOwner:'PRIVATE_MEMBER',readingTimerMemoryWarning:false,
    readingSaveBusy:false,readingSaveAttempt:null,readingSavePanelOpen:false,readingFinishKind:'finish',readingEndPage:9,readingNoteReturn:null,readingHomeReturn:false,readingHomeDialogFor:null,readingHomeDialogPosition:null,readingNotificationDialogRoute:null,
    readingNotificationBusy:false,readingNotificationPending:null,readingNotificationBound:false,readingNotificationLast:'',readingNotificationCheckpoint:null,readingNotificationArchiveBlocked:false,readingNotificationGuard:false,readingNotificationTask:null,readingNotificationLease:null,readingNotificationApply:false,readingNotificationOpenedIntent:'',readingNotificationNoteChoice:null,readingCountdownOpen:false,
    readingDataReady:()=>true,bookById:id=>c.BOOKS.find(b=>b.id===id),isBookLocked:()=>!!options.locked,myCurrentPage:()=>7,uid:()=> 'rl-book-'+(++nonce),
    localStorage:{getItem:key=>values.get(key)??null,setItem(key,value){if(options.failStorage)throw Error('storage');values.set(key,value);}},
    readingTimerStorageKey:owner=>'timer:'+owner,previousReadingTimerStorageKey:owner=>'timer-old:'+owner,legacyReadingTimerStorageKey:owner=>'timer-legacy:'+owner,
    location:{hash:'#/book/emotion/share',origin:'https://growell-book.vercel.app'},document:{getElementById:()=>null,querySelector:()=>null},navigator:{serviceWorker:{addEventListener(){}}},
    syncReadingTimer(){if(c.readingTimer)c.readingTimer=Domain.settle(c.readingTimer,clock);},
    render(){calls.renders++;},showToast(text){calls.toasts.push(text);},captureComposerDraft(){},closeReadingCountdownNotice(){},prepareReadingTimerAlerts(){},
    isReadingHomeRoute:()=>false,closeReadingHomeDialog(){c.readingHomeDialogFor=null;},GrowellArchiveTimer:{pauseOthers:()=>true},
    readingSaveError:false,readingSaveFailure:'',esc:String,svgIcon:()=>'',I_CLOSE:'close',readingCardHtml:()=>'',mineComposerOpenFor:null,shareComposerOpenFor:null};
  c.GrowellTimerAlerts={...Alerts,notificationStatus:()=>({supported:options.supported!==false,permission:options.permission||'granted'}),newGeneration:()=> 'rn-'+String(++nonce).padStart(32,'0'),newLease:()=> 'rh-'+String(++nonce).padStart(32,'0'),enableNotifications(){calls.prompts++;return Promise.resolve({enabled:true});},closeSession:async()=>true,
    async sessionState(request){
      calls.requests.push(clone(request));if(options.beforeRequest)await options.beforeRequest(request,c);if(options.failRpc)return {ok:false,code:options.failRpc};
      const id=request.snapshot||request.identity,key=id.ownerKey+':'+id.timerId,old=records.get(key)||null;
      if(request.type==='arm'&&active&&!State.matches(active,request.expectedActive))return {ok:false,code:'active-conflict',active,state:old};
      if(!['read','arm','ack','revoke'].includes(request.type)&&(!active||!State.matches(active,State.head(old))))return {ok:false,code:'inactive',active,state:old};
      const changed=State.transition(old,request,clock),result=clone(changed.result);result.active=active;
      if(result.ok&&request.type!=='read'){records.set(key,clone(changed.record));if(request.type==='arm'||active&&State.same(active,changed.record)){active=State.head(changed.record);result.active=clone(active);}}
      if(request.type==='ack'){calls.acks++;if(options.loseAck){options.loseAck=false;return {ok:false,code:'timeout'};}}
      if(options.afterRequest)await options.afterRequest(request,result,c);
      return result;
    }};
  vm.createContext(c);
  vm.runInContext(section('function captureReadingTimerState(){','function prepareReadingTimerAlerts(){'),c);
  vm.runInContext(section('function readingSessionNotificationSettingsHtml(){','function readingCountdownRingHtml(){'),c);
  vm.runInContext(section('function startReading(bookId){','function todayReadSeconds('),c);
  const parked=Domain.pause(Domain.create({id:'rl-parked',userId:'PRIVATE_MEMBER',bookId:'body',startPage:11},0),1200);
  if(!values.has('timer:PRIVATE_MEMBER'))values.set('timer:PRIVATE_MEMBER',JSON.stringify({v:3,timer:c.readingTimer,attempt:null,finishKind:'finish',endPage:9,noteReturn:null,returnView:'mine',parked:{body:{timer:parked,attempt:null,finishKind:'finish',endPage:12,noteReturn:null,returnView:'mine'}}}));
  function restore(){const raw=values.get('timer:PRIVATE_MEMBER');c.readingTimerStorageSnapshot=raw;const saved=JSON.parse(raw);c.applyReadingTimerState(saved);c.readingParkedSessions=saved.parked||{};}
  restore();
  function currentRecord(){const view=c.readingNotificationView();return view&&records.get(view.data.ownerKey+':'+view.data.timerId);}
  function action(kind,at){clock=at;const old=currentRecord();assert.ok(old,'timer must be armed');const changed=State.transition(old,{type:'action',identity:State.head(old),action:kind},at);assert.equal(changed.result.ok,true,changed.result.code);records.set(old.ownerKey+':'+old.timerId,clone(changed.record));active=State.head(changed.record);return changed.record;}
  return {c,calls,draft,values,records,options,restore,action,record:currentRecord,get active(){return active;},setNow:n=>{clock=n;},arm:()=>c.withReadingNotificationMutation(null)};
}

test('background clock is reconciled once into v3 while parked books, original draft and page choices are preserved',async()=>{
  const h=appHarness(),draft=clone(h.draft);assert.equal(await h.arm(),true);const parked=JSON.parse(h.values.get('timer:PRIVATE_MEMBER')).parked;
  h.action('pause',10000);h.action('resume',100000);h.action('finish',103000);h.setNow(800000);
  assert.equal(await h.c.consumeReadingSessionNotificationAction(),true);
  assert.equal(h.c.readingTimer.phase,'save');assert.equal(h.c.readingTimer.running,false);assert.equal(h.c.readingTimer.elapsedMs,13000);assert.equal(h.c.readingSaveAttempt,null);assert.equal(h.c.readingEndPage,9);
  assert.deepEqual(JSON.parse(h.values.get('timer:PRIVATE_MEMBER')).parked,parked);assert.deepEqual(h.draft,draft);assert.equal(h.c.location.hash,'#/book/emotion/share');
  assert.equal(h.record().journal.length,0);assert.equal(h.calls.acks,1);assert.equal(h.calls.saves,0);
  await h.c.consumeReadingSessionNotificationAction();assert.equal(h.c.readingTimer.elapsedMs,13000);
});

test('a failed local commit keeps every background action unacknowledged and retry never doubles elapsed time',async()=>{
  const h=appHarness();await h.arm();h.action('pause',10000);const before=h.values.get('timer:PRIVATE_MEMBER');h.options.failStorage=true;
  assert.equal(await h.arm(),false);assert.equal(h.values.get('timer:PRIVATE_MEMBER'),before);assert.equal(h.record().journal.length,1);assert.equal(h.calls.acks,0);
  h.options.failStorage=false;assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.elapsedMs,10000);assert.equal(h.record().journal.length,0);
  await h.arm();assert.equal(h.c.readingTimer.elapsedMs,10000);
});

test('lost acknowledgement replies and a new action during prefix acknowledgement remain idempotent after reload',async()=>{
  const h=appHarness();await h.arm();h.action('pause',10000);h.options.loseAck=true;
  assert.equal(await h.arm(),false);assert.equal(h.c.readingNotificationCheckpoint.throughSeq,1);assert.equal(h.c.readingTimer.elapsedMs,10000);h.restore();
  assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.elapsedMs,10000);
  h.action('resume',100000);let injected=false;h.options.beforeRequest=async request=>{if(request.type==='ack'&&!injected){injected=true;h.action('pause',103000);}};
  assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.elapsedMs,13000);assert.equal(h.record().journal.length,0);assert.equal(h.c.readingNotificationCheckpoint.throughSeq,3);
});

test('app timer mutations hold the exact worker revision until the new source is durably published',async()=>{
  const h=appHarness();await h.arm();let seen=false;
  assert.equal(await h.c.withReadingNotificationMutation(()=>{const record=h.record();seen=true;assert.ok(record.held);const denied=State.transition(record,{type:'action',identity:State.head(record),action:'pause'},9000);assert.equal(denied.result.code,'blocked');const next=h.c.captureReadingTimerState();next.timer=Domain.pause(next.timer,8000);return h.c.commitReadingTimerState(next);}),true);
  assert.equal(seen,true);assert.equal(h.record().held,null);assert.equal(h.record().clock.elapsedMs,8000);assert.equal(h.c.readingTimer.running,false);
});

test('switching A to B and back preserves parked clocks and creates no stuck worker lease',async()=>{
  const h=appHarness();await h.arm();h.action('pause',10000);h.setNow(12000);await h.c.startReading('thought');
  assert.equal(h.c.readingTimer.bookId,'thought');assert.equal(h.c.readingParkedSessions.emotion.timer.elapsedMs,10000);const first=h.c.readingParkedSessions.emotion.timer.id;
  h.setNow(16000);await h.c.startReading('emotion');assert.equal(h.c.readingTimer.id,first);assert.equal(h.c.readingTimer.elapsedMs,10000);assert.equal(h.c.readingTimer.running,false);assert.equal(h.record().held,null);assert.equal(h.record().revoked,false);
  assert.equal(h.c.readingParkedSessions.thought.timer.elapsedMs,4000);assert.ok(h.c.readingParkedSessions.body);
});

test('a resumed archive timer blocks independent shared resume and note/save attempts also block all timer actions',async()=>{
  const h=appHarness();await h.arm();h.setNow(10000);assert.equal(await h.c.pauseSharedReadingForArchive('PRIVATE_MEMBER'),true);assert.equal(h.record().blocked,'archive');
  assert.equal(State.transition(h.record(),{type:'action',identity:State.head(h.record()),action:'resume'},20000).result.ok,false);
  await h.c.withReadingNotificationMutation(()=>{const next=h.c.captureReadingTimerState();next.noteReturn={timerId:next.timer.id,userId:'PRIVATE_MEMBER',bookId:'emotion',type:'mine',wasRunning:true};next.notificationArchiveBlocked=false;return h.c.commitReadingTimerState(next);});
  assert.equal(h.record().blocked,'note');assert.equal(State.transition(h.record(),{type:'action',identity:State.head(h.record()),action:'finish'},20000).result.ok,false);
  const before=clone(h.draft);await h.c.withReadingNotificationMutation(()=>{const next=h.c.captureReadingTimerState();next.noteReturn=null;next.timer.phase='save';return h.c.commitReadingTimerState(next);});assert.equal(h.record().blocked,'save');assert.deepEqual(h.draft,before);
});

test('a changed account or epoch during the read cannot touch the former source or acknowledge its pending clock',async()=>{
  for(const mode of ['account','epoch']){const h=appHarness();await h.arm();h.action('pause',10000);const before=h.values.get('timer:PRIVATE_MEMBER');let changed=false;
    h.options.afterRequest=async request=>{if(request.type==='read'&&!changed){changed=true;if(mode==='account')h.c.SESSION={userId:'OTHER'};else h.c.saveSessionEpoch++;}};
    assert.equal(await h.arm(),false);assert.equal(h.values.get('timer:PRIVATE_MEMBER'),before);assert.equal(h.record()?.journal.length||[...h.records.values()][0].journal.length,1);assert.equal(h.calls.acks,0);
  }
});

test('initial notification failures and denied/default permission do not disable reading, while a known checkpoint fails closed',async()=>{
  for(const permission of ['default','denied']){const h=appHarness({permission,failRpc:'storage'});let ran=false;assert.equal(h.c.withReadingNotificationMutation(()=>{ran=true;return true;}),true);assert.equal(ran,true);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.prompts,0);}
  const missing=appHarness({failRpc:'storage'});let ran=false;assert.equal(await missing.c.withReadingNotificationMutation(()=>{ran=true;return true;}),true);assert.equal(ran,true);
  const known=appHarness();await known.arm();known.options.failRpc='storage';let mutated=false;assert.equal(await known.c.withReadingNotificationMutation(()=>{mutated=true;}),false);assert.equal(mutated,false);
});

test('locked or unopened books never request notification permission, and a real start gesture requests it before async work',async()=>{
  const locked=appHarness({permission:'default',locked:true});await locked.c.startReading('thought');assert.equal(locked.calls.prompts,0);
  const denied=appHarness({permission:'denied'});await denied.c.startReading('thought');assert.equal(denied.calls.prompts,0);
  const start=appHarness({permission:'default'});const pending=start.c.startReading('thought');assert.equal(start.calls.prompts,1);await pending;
  const view=start.c.readingTimer.id;await start.c.startReading('thought');assert.equal(start.calls.prompts,1);assert.equal(start.c.readingTimer.id,view);
});


test('explicit notification save intent opens the actual save popup over the current route and acknowledges only that intent',async()=>{
  const h=appHarness();await h.arm();h.action('finish',10000);const old=h.record();const opened=State.transition(old,{type:'open-intent',identity:State.head(old),action:'save'},10001);assert.equal(opened.result.ok,true);h.records.set(old.ownerKey+':'+old.timerId,opened.record);h.setNow(10002);
  assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.phase,'save');assert.equal(h.c.readingHomeDialogFor,h.c.readingTimer.id);assert.equal(h.c.readingNotificationDialogRoute,'#/book/emotion/share');assert.equal(h.c.location.hash,'#/book/emotion/share');assert.equal(h.record().openIntent,undefined);assert.equal(h.calls.saves,0);
});

test('notification note intent pauses at the click, preserves original running state and excludes choice and writing time',async()=>{
  for(const wasRunning of [true,false]){const h=appHarness();await h.arm();if(!wasRunning){h.action('pause',6000);await h.arm();}const originalDraft=clone(h.draft);h.action('note',10000);h.setNow(100000);
    assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.running,false);assert.equal(h.c.readingNotificationNoteChoice.wasRunning,wasRunning);assert.equal(h.c.readingTimer.elapsedMs,wasRunning?10000:6000);
    h.c.memberLoadState={privateEntries:'ready'};h.c.openComposerWithDraft=(type,book,id,opened)=>{opened(null);return Promise.resolve();};
    vm.runInContext(section('function readingNoteDialogHtml(){','function tickReadingTimer(){'),h.c);
    await h.c.openReadingNote('mine');assert.equal(h.c.readingNoteReturn.wasRunning,wasRunning);assert.equal(h.c.readingNotificationNoteChoice,null);assert.equal(h.c.readingTimer.running,false);
    h.setNow(300000);assert.equal(h.c.completeReadingNote('mine','emotion'),true);assert.equal(h.c.readingTimer.running,wasRunning);assert.equal(Domain.elapsed(h.c.readingTimer,300000),wasRunning?10000:6000);assert.deepEqual(h.draft,originalDraft);
  }
});

test('closing notification note-choice resumes only a previously running timer without counting the selection interval',async()=>{
  const h=appHarness();await h.arm();h.action('note',10000);h.setNow(100000);await h.arm();
  vm.runInContext(section('function closeReadingNoteDialog(','function openReadingNote('),h.c);
  await h.c.closeReadingNoteDialog();assert.equal(h.c.readingNotificationNoteChoice,null);assert.equal(h.c.readingTimer.running,true);assert.equal(Domain.elapsed(h.c.readingTimer,100000),10000);assert.equal(h.record().blocked,'');
});
