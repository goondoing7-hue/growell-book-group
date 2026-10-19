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
  assert.deepEqual(clone(first.settings.actions),[{action:'pause',title:'멈춤'},{action:'finish',title:'끝내기'}]);
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
function fakeIndexedDB(){
  const values=new Map(),names=new Set();let tail=Promise.resolve();
  const api={open(name,version){assert.equal(name,'growell-reading-notification-v1');assert.equal(version,1);const request={};
    setImmediate(()=>{request.result={objectStoreNames:{contains:key=>names.has(key)},createObjectStore:key=>names.add(key),close(){},transaction(store,mode){assert.equal(store,'pending');assert.equal(mode,'readwrite');const ops=[],tx={objectStore(){return {put(value,key){ops.push(()=>values.set(key,clone(value)));},delete(key){ops.push(()=>values.delete(key));},get(key){const result={};ops.push(()=>{result.result=values.has(key)?clone(values.get(key)):undefined;if(result.onsuccess)result.onsuccess();});return result;}};}};
      tail=tail.then(()=>new Promise(resolve=>setImmediate(()=>{try{for(let i=0;i<ops.length;i++)ops[i]();if(tx.oncomplete)tx.oncomplete();}catch(error){if(tx.onerror)tx.onerror(error);}resolve();})));return tx;}};
      if(!names.has('pending')&&request.onupgradeneeded)request.onupgradeneeded();if(request.onsuccess)request.onsuccess();});return request;}};
  return {api,values};
}
function workerHarness(options={}){
  let clock=10000;const database=fakeIndexedDB(),events={},opened=[],root={URL,Promise,Number,Date:class extends Date{static now(){return clock;}},MessageChannel,setTimeout,clearTimeout,
    self:{location:{origin:'https://growell-book.vercel.app'},indexedDB:options.noStorage?undefined:database.api,addEventListener:(name,handler)=>events[name]=handler,skipWaiting:async()=>{},clients:{claim:async()=>{},matchAll:async()=>options.windows||[],openWindow:async url=>{opened.push(url);return {};}}}};
  vm.createContext(root);vm.runInContext(workerSource,root);
  async function click(data,action='pause'){let waiting,closed=0;events.notificationclick({action,notification:{data,close(){closed++;}},waitUntil:value=>{waiting=value;}});if(waiting)await waiting;assert.equal(closed,1);}
  async function claim(identity,source='https://growell-book.vercel.app/#/'){let waiting,result;events.message({data:{type:'growell-reading-claim',identity},source:{url:source},ports:[{postMessage:value=>{result=value;}}],waitUntil:value=>{waiting=value;}});if(waiting)await waiting;return result&&result.command;}
  async function clear(ownerKey){let waiting;events.message({data:{type:'growell-reading-clear',ownerKey},source:{url:'https://growell-book.vercel.app/#/'},waitUntil:value=>{waiting=value;}});if(waiting)await waiting;}
  return {root,database,events,opened,click,claim,clear,setNow(value){clock=value;}};
}
const identity=()=>Alerts.sessionView({timer:timer(0),userId:'PRIVATE_MEMBER'}).data;
test('worker queues only opaque metadata, opens a safe route for a closed app, and consumes a command once atomically',async()=>{
  const h=workerHarness(),data=identity();await h.click(data,'pause');assert.deepEqual(h.opened,['https://growell-book.vercel.app/#/book/emotion/mine']);
  assert.equal(h.database.values.size,1);assert.doesNotMatch(JSON.stringify([...h.database.values]),/PRIVATE_MEMBER|access_token|keyB64|PRIVATE_BODY/);
  const [first,second]=await Promise.all([h.claim(data),h.claim(data)]);assert.equal(first.action,'pause');assert.equal(second,null);assert.equal(h.database.values.size,0);
});
test('a later click replaces the single queued command and expiry, stale state or another member cannot execute it',async()=>{
  const h=workerHarness(),data=identity();await h.click(data,'pause');await h.click(data,'finish');assert.equal(h.database.values.size,1);assert.equal((await h.claim(data)).action,'finish');
  await h.click(data,'pause');assert.equal(await h.claim({...data,ownerKey:'t1-dead-beef'}),null);assert.equal(h.database.values.size,1);
  assert.equal(await h.claim({...data,revision:'t1-abc-def'}),null);assert.equal(h.database.values.size,1);assert.equal((await h.claim(data)).action,'pause');
  await h.click(data,'pause');h.setNow(310001);assert.equal(await h.claim(data),null);assert.equal(h.database.values.size,0);
});
test('foreign windows, invalid book/session actions and absent IndexedDB never mutate a saved timer or expose commands',async()=>{
  const h=workerHarness(),data=identity();await h.click(data,'pause');assert.equal(await h.claim(data,'https://evil.example/#/'),undefined);assert.equal(h.database.values.size,1);
  for(const [invalid,action] of [[{...data,bookId:'../../evil'},'pause'],[{...data,timerId:'https://evil.example'},'pause'],[data,'delete'],[data,'resume']])await h.click(invalid,action);
  assert.equal(h.database.values.size,1);const blocked=workerHarness({noStorage:true});await blocked.click(data,'finish');assert.equal(blocked.database.values.size,0);assert.equal(blocked.opened.length,1);
});
test('an already open matching client receives a message without navigation, so another page draft stays intact',async()=>{
  let focused=0,navigated=0,messages=0;const client={url:'https://growell-book.vercel.app/#/book/emotion/share',postMessage(message,ports){assert.equal(message.type,'growell-reading-pending');messages++;ports[0].postMessage({accepted:true});},focus:async()=>{focused++;},navigate(){navigated++;}};
  const h=workerHarness({windows:[client]});await h.click(identity(),'finish');assert.equal(messages,1);assert.equal(focused,1);assert.equal(navigated,0);assert.equal(h.opened.length,0);
});
test('logout clears only the former owner queued action so a paused timer cannot resume after a later login',async()=>{
  const h=workerHarness(),data=identity();await h.click(data,'pause');await h.clear('t1-dead-beef');assert.equal(h.database.values.size,1);await h.clear(data.ownerKey);assert.equal(h.database.values.size,0);assert.equal(await h.claim(data),null);
});
function appHarness(options={}){
  let clock=5000;const calls={renders:0,captures:0,commits:0,clears:0},draft={id:'draft-fixed',body:'작성 중인 원문 그대로'},book={id:'emotion',title:'책',totalPages:100};
  const c={Promise,Date:class extends Date{static now(){return clock;}},Number,Math,JSON,URL,
    SESSION:{userId:'PRIVATE_MEMBER'},saveSessionEpoch:3,memberPushPromptSession:{},currentMemberPushPrompt:()=>!options.unverified,
    GrowellReadingTimer:Domain,GrowellTimerAlerts:{sessionView:Alerts.sessionView,claimSessionAction:()=>options.claim||Promise.resolve(null),showSession:async()=>true,closeSession:async()=>{calls.clears++;}},
    readingTimer:timer(0),readingSaveBusy:false,readingSaveAttempt:null,readingNoteReturn:null,readingHomeReturn:false,readingHomeDialogFor:null,readingHomeDialogPosition:null,readingNotificationDialogRoute:null,readingNotificationBusy:false,readingNotificationPending:null,readingNotificationBound:false,readingNotificationLast:'',readingCountdownOpen:false,
    readingDataReady:()=>true,refreshReadingTimerFromStorage:()=>false,bookById:()=>book,isBookLocked:()=>false,pauseArchiveReadingBeforeSharedStart:()=>options.archiveBlocked!==true,
    captureReadingTimerState(){return {timer:clone(c.readingTimer),noteReturn:c.readingNoteReturn,returnView:'mine'};},
    commitReadingTimerState(next){calls.commits++;if(options.failStorage)return false;c.readingTimer=clone(next.timer);c.readingNoteReturn=next.noteReturn;c.readingSavePanelOpen=c.readingTimer.phase==='save';return true;},
    location:{hash:'#/book/emotion/share',origin:'https://growell-book.vercel.app'},document:{getElementById:()=>null,querySelector:()=>null},navigator:{serviceWorker:{addEventListener(){}}},
    captureComposerDraft(){calls.captures++;},render(){calls.renders++;c.captureComposerDraft();},showToast(){},mineComposerOpenFor:'emotion',shareComposerOpenFor:null,
    resetMineComposer(){c.mineComposerOpenFor=null;},resetShareComposer(){c.shareComposerOpenFor=null;},
    esc:String,svgIcon:()=>'',I_CLOSE:'close',readingCardHtml:()=>'<div data-existing-reading-card></div>'};
  vm.createContext(c);vm.runInContext(section('function readingSessionNotificationSettingsHtml(){','function readingCountdownRingHtml(){'),c);
  vm.runInContext(section('function isReadingHomeRoute(){','function startReading('),c);
  vm.runInContext(section('function completeReadingNote(','function tickReadingTimer(){'),c);
  function command(action='pause'){return {...c.readingNotificationView().data,action,createdAt:clock,expiresAt:clock+300000};}
  return {c,calls,draft,command,setNow(value){clock=value;}};
}
test('notification pause/resume exclude paused time and finish freezes the same session without automatic saving',()=>{
  const h=appHarness(),id=h.c.readingTimer.id,initial=clone(h.draft);let command=h.command('pause');assert.equal(h.c.applyReadingNotificationCommand(command,command),true);assert.equal(h.c.readingTimer.running,false);assert.equal(Domain.elapsed(h.c.readingTimer,5000),5000);
  h.setNow(100000);command=h.command('resume');assert.equal(h.c.applyReadingNotificationCommand(command,command),true);h.setNow(103000);assert.equal(Domain.elapsed(h.c.readingTimer,103000),8000);
  command=h.command('finish');assert.equal(h.c.applyReadingNotificationCommand(command,command),true);assert.equal(h.c.readingTimer.running,false);assert.equal(h.c.readingTimer.phase,'save');assert.equal(h.c.readingSaveAttempt,null);assert.equal(h.c.readingTimer.id,id);
  assert.equal(h.c.location.hash,'#/book/emotion/share');assert.equal(h.c.readingHomeDialogFor,id);assert.match(h.c.readingHomeDialogHtml({view:'book',bookId:'emotion',tab:'share'}),/읽은 기록 저장/);assert.deepEqual(h.draft,initial);
});
test('stale, expired, wrong-owner and already saving notifications never alter the current timer',()=>{
  for(const edit of [cmd=>{cmd.ownerKey='t1-wrong-owner';},cmd=>{cmd.timerId='rl-old';},cmd=>{cmd.revision='t1-stale-revision';},cmd=>{cmd.expiresAt=1;},cmd=>{cmd.action='delete';}]){
    const h=appHarness(),before=clone(h.c.readingTimer),command=h.command();edit(command);assert.equal(h.c.applyReadingNotificationCommand(command,h.c.readingNotificationView().data),false);assert.deepEqual(clone(h.c.readingTimer),before);assert.equal(h.calls.commits,0);
  }
  const saved=appHarness();saved.c.readingSaveAttempt={id:'immutable-attempt'};const command=saved.command('finish');assert.equal(saved.c.applyReadingNotificationCommand(command,command),false);assert.equal(saved.calls.commits,0);
});
test('failed local persistence preserves the original time and pending note handoff remains on the existing draft-safe path',()=>{
  const failed=appHarness({failStorage:true}),before=clone(failed.c.readingTimer),cmd=failed.command('finish');assert.equal(failed.c.applyReadingNotificationCommand(cmd,cmd),false);assert.deepEqual(clone(failed.c.readingTimer),before);
  for(const action of ['resume','finish']){
    const h=appHarness(),handoff=Domain.beginNote(h.c.readingTimer,'mine',5000);h.c.readingTimer=handoff.timer;h.c.readingNoteReturn=handoff.handoff;h.setNow(100000);const draftBefore=clone(h.draft),command=h.command(action);
    assert.equal(h.c.applyReadingNotificationCommand(command,command),true);assert.equal(h.c.readingNoteReturn,null);assert.equal(h.c.readingTimer.phase,'timer');assert.equal(Domain.elapsed(h.c.readingTimer,100000),5000);assert.ok(h.calls.captures>0);assert.deepEqual(h.draft,draftBefore);
  }
});
test('an account or Auth epoch replaced during command claim prevents applying a former member action',async()=>{
  for(const change of ['account','epoch']){let finish;const pending=new Promise(resolve=>{finish=resolve;}),h=appHarness({claim:pending}),command=h.command('finish');const operation=h.c.consumeReadingSessionNotificationAction();
    if(change==='account')h.c.SESSION={userId:'OTHER_MEMBER'};else h.c.saveSessionEpoch++;
    finish(command);assert.equal(await operation,false);assert.equal(h.calls.commits,0);assert.equal(h.c.readingTimer.phase,'timer');
  }
  const unverified=appHarness({unverified:true});assert.equal(await unverified.c.consumeReadingSessionNotificationAction(),false);assert.equal(unverified.calls.commits,0);
});
test('notification messages coalesce with a pending restore claim and the same command never toggles twice',async()=>{
  let finish;const waiting=new Promise(resolve=>{finish=resolve;}),h=appHarness({claim:waiting}),command=h.command('pause');
  const first=h.c.consumeReadingSessionNotificationAction(),second=h.c.consumeReadingSessionNotificationAction();assert.equal(first,second);finish(command);assert.equal(await first,true);assert.equal(await second,true);assert.equal(h.calls.commits,1);
  assert.equal(h.c.applyReadingNotificationCommand(command,command),false);assert.equal(h.calls.commits,1);
});
test('a sleeping tab refreshes shared storage before claiming so its old revision cannot drain the current command',async()=>{
  const current=appHarness(),sleeping=appHarness();current.c.readingTimer=Domain.pause(current.c.readingTimer,5000);const latest=clone(current.c.readingTimer),command=current.command('resume');
  let claimed=null,refreshes=0;sleeping.c.refreshReadingTimerFromStorage=()=>{refreshes++;sleeping.c.readingTimer=clone(latest);return true;};
  sleeping.c.GrowellTimerAlerts.claimSessionAction=async view=>{claimed=clone(view.data);return command;};
  assert.equal(await sleeping.c.consumeReadingSessionNotificationAction(),true);assert.ok(refreshes>=1);assert.equal(claimed.revision,command.revision);assert.equal(sleeping.c.readingTimer.running,true);assert.equal(sleeping.calls.commits,1);
  assert.equal(Domain.elapsed(sleeping.c.readingTimer,5000),5000);
});
