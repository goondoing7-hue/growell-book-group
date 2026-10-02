'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const clientModule=require('../habitReminder.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let n=0;n<4;n++)await flush();}
function install(c,from,to){const begin=source.indexOf(from),end=source.indexOf(to,begin+from.length);assert.ok(begin>=0&&end>begin,'integration source functions exist');vm.runInContext(source.slice(begin,end),c);}
const authResult=(id='auth-owner',token='SYNTHETIC_ACCESS_TOKEN')=>({data:{session:{user:{id},access_token:token}},error:null});
function harness(extra={}){
  const calls=[],opened=[],jobs=[],toasts=[];let sdkReads=0,renderCount=0;
  const habit={id:'h1',userId:'owner',bookId:'emotion',name:'독서',place:'집',time:'21:00',goal:'10쪽',startDate:'2026-10-01',endDate:'2026-10-31',checkedDates:[],createdAt:123,privateField:'PRIVATE_HABIT_FIELD'};
  const c={Date,URL,Promise,AbortController,setTimeout,clearTimeout,
    SESSION:{userId:'owner',name:'합성 회원',keyB64:'PRIVATE_ENCRYPTION_KEY'},saveSessionEpoch:7,
    STATE:{users:{owner:{id:'owner',authUserId:'auth-owner'}},habits:{h1:habit}},memberLoadState:{habits:'ready'},
    sb:{auth:{getSession:async()=>{sdkReads++;return authResult();}}},
    location:{origin:'https://growell-book.vercel.app',href:'https://growell-book.vercel.app/#/book/emotion/habit'},
    window:{fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({configured:true})};}},
    GrowellHabitReminder:clientModule,GrowellHabits:require('../habitDomain.js'),GrowellReadingHabits:require('../readingHabit.js'),
    bookById:id=>['emotion','thought','body','action'].includes(id)?{id,title:'합성 책'}:null,
    ymd:()=> '2026-10-02',showToast:(...args)=>toasts.push(args),uid:()=> 'new-habit',confirm:()=>true,
    saveState:(mutation,options)=>{jobs.push({mutation,options});return Promise.resolve(true);},render:()=>{renderCount++;},
    habitEditingId:null,habitHistoryOpenFor:null,habitHistoryMonth:null,habitSaveIntents:{},habitSaveVersion:0,
    document:{querySelectorAll:()=>[],querySelector:()=>null},esc:value=>String(value).replaceAll('"','&quot;'),
    ...extra};
  vm.createContext(c);
  install(c,'function validateHabitPeriod(','function readingMetaKey(');
  install(c,'function habitSyncAccessToken(','function habitCardHtml(');
  c.refreshHabitSaveUI=()=>{};
  return {c,calls,opened,jobs,toasts,habit,get sdkReads(){return sdkReads;},get renders(){return renderCount;}};
}
const payload={name:'기도',place:'책상',time:'09:00',goal:'감사 한 가지',startDate:'2026-10-02',endDate:'2026-10-31'};

test('SDK access token is returned only for the current profile authentication identity',async()=>{
  const h=harness(),session=h.c.SESSION;assert.equal(await h.c.habitSyncAccessToken(session,7),'SYNTHETIC_ACCESS_TOKEN');assert.equal(h.sdkReads,1);
  for(const result of [authResult('different-auth'),{data:{session:null}},{data:{}},{error:{message:'private'}},authResult('auth-owner','')]){
    h.c.sb.auth.getSession=async()=>result;await assert.rejects(h.c.habitSyncAccessToken(session,7),/auth_required/);
  }
  h.c.sb.auth.getSession=async()=>authResult();delete h.c.STATE.users.owner;
  await assert.rejects(h.c.habitSyncAccessToken(session,7),/auth_required/);
});

test('stale session object, epoch or logout prevents SDK token lookup entirely',async()=>{
  for(const change of ['logout','same-owner-new-session','epoch']){
    const h=harness(),session=h.c.SESSION;
    if(change==='logout')h.c.SESSION=null;else if(change==='epoch')h.c.saveSessionEpoch++;else h.c.SESSION={...session};
    await assert.rejects(h.c.habitSyncAccessToken(session,7),/session_changed/);assert.equal(h.sdkReads,0,change);
  }
});

test('logout, replacement session or epoch change while SDK getSession is pending discards its token',async()=>{
  for(const change of ['logout','same-owner-new-session','epoch','profile-auth-changed']){
    const pending=deferred(),h=harness(),session=h.c.SESSION;h.c.sb.auth.getSession=()=>pending.promise;
    const result=h.c.habitSyncAccessToken(session,7);await flush();
    if(change==='logout')h.c.SESSION=null;else if(change==='epoch')h.c.saveSessionEpoch++;else if(change==='same-owner-new-session')h.c.SESSION={...session};else h.c.STATE.users.owner.authUserId='changed-auth';
    pending.resolve(authResult());await assert.rejects(result,change==='profile-auth-changed'?/auth_required/:/session_changed/);
  }
});

test('background worker kick sends only the SDK bearer token and never the private encryption key or habit body',async()=>{
  const h=harness(),before=JSON.stringify(h.c.STATE);h.c.runHabitReminderSync();await settle();
  assert.deepEqual(h.calls.map(call=>call.url),['/api/habit-sync?action=config','/api/habit-sync?action=run']);
  const request=h.calls[1];assert.equal(request.options.method,'POST');assert.equal(request.options.body,'{}');
  assert.equal(request.options.headers.Authorization,'Bearer SYNTHETIC_ACCESS_TOKEN');
  assert.doesNotMatch(JSON.stringify(h.calls),/PRIVATE_ENCRYPTION_KEY|PRIVATE_HABIT_FIELD|감사|checkedDates|auth-owner/);
  assert.equal(JSON.stringify(h.c.STATE),before);assert.equal(h.sdkReads,1);
});

test('unconfigured service, signed-out session and missing module never kick the worker',async()=>{
  const h=harness();h.c.window.fetch=async(url,options)=>{h.calls.push({url,options});return {ok:true,status:200,json:async()=>({configured:false})};};
  h.c.runHabitReminderSync();await settle();assert.deepEqual(h.calls.map(call=>call.url),['/api/habit-sync?action=config']);assert.equal(h.sdkReads,0);
  h.calls.length=0;h.c.SESSION=null;h.c.runHabitReminderSync();await settle();assert.equal(h.calls.length,0);
  h.c.SESSION={userId:'owner'};delete h.c.GrowellHabitReminder;assert.doesNotThrow(()=>h.c.runHabitReminderSync());
});

test('a session switch during a config check prevents an old worker kick',async()=>{
  const pending=deferred(),h=harness();h.c.window.fetch=async(url,options)=>{h.calls.push({url,options});return pending.promise;};
  h.c.runHabitReminderSync();await flush();h.c.saveSessionEpoch++;
  pending.resolve({ok:true,status:200,json:async()=>({configured:true})});await settle();
  assert.equal(h.calls.length,1);assert.equal(h.sdkReads,0);
});

test('background connector failures are contained and the request client is always disposed',async()=>{
  for(const failAt of ['config','run']){
    let disposed=0;const actions=[],h=harness();h.c.GrowellHabitReminder={createClient:options=>({
      request:async action=>{actions.push(action);assert.equal(options.isCurrent(),true);if(action===failAt)throw new Error('PRIVATE_SERVER_FAILURE');return {configured:true};},
      dispose:()=>{disposed++;}
    })};
    assert.doesNotThrow(()=>h.c.runHabitReminderSync());await settle();assert.equal(disposed,1);
    assert.deepEqual(actions,failAt==='config'?['config']:['config','run']);assert.equal(h.toasts.length,0);
  }
});

test('opening a habit or overview gives the connector fresh guarded SDK credentials and a safe snapshot',async()=>{
  for(const habitId of ['h1',null]){
    const h=harness();h.c.GrowellHabitReminder={open:options=>h.opened.push(options)};
    const trigger={isConnected:true,focus(){}};h.c.openHabitReminder(habitId,trigger);assert.equal(h.opened.length,1);
    const options=h.opened[0];assert.equal(options.habitId,habitId);assert.equal(await options.getAccessToken(),'SYNTHETIC_ACCESS_TOKEN');
    const snapshot=options.getHabit();assert.equal(snapshot.name,habitId?'독서':'전체 습관');
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_|checkedDates|userId|authUserId/);
    h.c.STATE.habits.h1.goal='20쪽';if(habitId)assert.equal(options.getHabit().goal,'20쪽');
    h.c.saveSessionEpoch++;assert.equal(options.getHabit(),null);await assert.rejects(options.getAccessToken(),/session_changed/);
  }
});

test('OAuth return opens a current habit or account status after cleaning the URL and restores focus without an overview control',()=>{
  for(const habitId of ['h1',null]){
    const h=harness(),order=[],focused=[];
    const habitButton={isConnected:true,getAttribute:name=>name==='data-habit-reminder'?'h1':null,focus:()=>focused.push('habit')};
    const createButton={focus:()=>focused.push('create')};
    if(!habitId)delete h.c.STATE.habits.h1;
    h.c.location.href='https://growell-book.vercel.app/?keep=yes&habit-sync=connected#/book/emotion/habit';
    h.c.history={state:{},replaceState:(state,title,url)=>{order.push('clean-url');h.c.location.href=url;}};
    h.c.document={querySelector:selector=>selector==='[data-habit-reminder]'&&habitId?habitButton:null,getElementById:id=>id==='btn-open-habit-form'?createButton:null};
    h.c.GrowellHabitReminder={open:options=>{order.push('open');h.opened.push(options);assert.equal(new URL(h.c.location.href).searchParams.has('habit-sync'),false);}};
    h.c.handleHabitSyncReturn();
    assert.deepEqual(order,['clean-url','open']);assert.equal(h.opened.length,1);assert.equal(h.opened[0].habitId,habitId);
    assert.equal(h.opened[0].getHabit().name,habitId?'독서':'전체 습관');
    assert.equal(new URL(h.c.location.href).searchParams.get('keep'),'yes');assert.equal(new URL(h.c.location.href).hash,'#/book/emotion/habit');
    h.opened[0].restoreFocus();assert.deepEqual(focused,[habitId?'habit':'create']);
    assert.equal(h.toasts.length,0);h.c.handleHabitSyncReturn();assert.equal(h.opened.length,1,'refreshing the same route does not reopen the result');
  }
});

test('OAuth errors and cancellation still show connection feedback without an overview button',()=>{
  for(const result of ['error','failed','cancelled']){
    const h=harness();
    h.c.location.href='https://growell-book.vercel.app/?habit-sync='+result+'#/book/emotion/habit';
    h.c.history={state:null,replaceState:(state,title,url)=>{h.c.location.href=url;}};
    h.c.GrowellHabitReminder={open:options=>h.opened.push(options)};
    h.c.handleHabitSyncReturn();
    assert.equal(h.opened.length,1);assert.equal(h.opened[0].habitId,null);
    assert.deepEqual(h.toasts,[[result==='cancelled'?'연결을 취소했어요.':'계정을 연결하지 못했어요. 다시 시도해주세요.',result!=='cancelled']]);
  }
});

test('habit connector cannot open another owner and loses access on route, load or ownership changes',()=>{
  for(const change of ['owner','route','loading','removed','logout']){
    const h=harness();h.c.GrowellHabitReminder={open:options=>h.opened.push(options)};
    h.c.openHabitReminder('h1',null);assert.equal(h.opened.length,1);
    if(change==='owner')h.c.STATE.habits.h1.userId='other';else if(change==='route')h.c.location.href+='/changed';else if(change==='loading')h.c.memberLoadState.habits='loading';else if(change==='removed')delete h.c.STATE.habits.h1;else h.c.SESSION=null;
    assert.equal(h.opened[0].getHabit(),null,change);
  }
  const h=harness();h.c.GrowellHabitReminder={open:options=>h.opened.push(options)};h.habit.userId='other';h.c.openHabitReminder('h1',null);assert.equal(h.opened.length,0);
});

test('create, edit and delete request synchronization only after successful source persistence',()=>{
  for(const operation of ['create','edit','delete']){
    const h=harness();let syncs=0;h.c.runHabitReminderSync=()=>{syncs++;};
    if(operation==='create')h.c.submitHabit('emotion',payload,null);else if(operation==='edit')h.c.editHabit('h1',payload,null);else h.c.deleteHabit('h1',null);
    assert.equal(h.jobs.length,1);assert.equal(syncs,0,operation+' is not sent while save is pending');
    const job=h.jobs[0],next=structuredClone(h.c.STATE);job.mutation(next);assert.equal(syncs,0,operation+' mutation alone is not successful persistence');
    if(job.options.onFailure)job.options.onFailure(new Error('source save failed'));assert.equal(syncs,0);
    h.c.STATE=next;job.options.onSuccess();assert.equal(syncs,1);assert.equal(h.renders,1);
    if(operation==='delete')assert.equal(h.c.STATE.habits.h1,undefined);else assert.equal(h.c.STATE.habits[operation==='create'?'new-habit':'h1'].name,payload.name);
  }
});

test('a failed reminder service after save does not revert a created, edited or deleted habit',async()=>{
  for(const operation of ['create','edit','delete']){
    const h=harness();h.c.window.fetch=async()=>{throw new Error('synthetic network outage');};
    if(operation==='create')h.c.submitHabit('emotion',payload,null);else if(operation==='edit')h.c.editHabit('h1',payload,null);else h.c.deleteHabit('h1',null);
    const job=h.jobs[0];job.mutation(h.c.STATE);const saved=JSON.stringify(h.c.STATE);assert.doesNotThrow(()=>job.options.onSuccess());await settle();
    assert.equal(JSON.stringify(h.c.STATE),saved);assert.equal(h.jobs.length,1);assert.equal(h.renders,1);
  }
});

test('habit success checkbox persistence and retries do not trigger reminder synchronization',()=>{
  const h=harness();let syncs=0;h.c.runHabitReminderSync=()=>{syncs++;};
  h.c.queueHabitCheck('h1','2026-10-02',true);assert.equal(h.jobs.length,1);h.jobs[0].mutation(h.c.STATE);h.jobs[0].options.onSuccess();
  assert.deepEqual(Array.from(h.c.STATE.habits.h1.checkedDates),['2026-10-02']);assert.equal(syncs,0);
  h.c.queueHabitCheck('h1','2026-10-02',false);h.jobs[1].options.onFailure();assert.equal(syncs,0);
  h.c.retryHabitChecks('h1');assert.equal(h.jobs.length,3);h.jobs[2].mutation(h.c.STATE);h.jobs[2].options.onSuccess();assert.equal(syncs,0);assert.deepEqual(Array.from(h.c.STATE.habits.h1.checkedDates),[]);
});

test('overview omits automatic-sync controls initially and after refresh while individual habits retain them',()=>{
  const h=harness();
  const panel={innerHTML:'',contains:()=>true,querySelectorAll:()=>[]};
  h.c.document={activeElement:null,querySelectorAll:selector=>selector==='[data-habit-overview]'?[panel]:[],querySelector:()=>null};
  h.c.refreshHabitValueSummary=()=>{};h.c.refreshHomeHabits=()=>{};h.c.habitOverviewBodyHtml=()=>'<div>synthetic summary</div>';
  install(h.c,'function habitOverviewHtml(','/* 월요일 시작 기준');
  install(h.c,'function habitReminderActionHtml(','function habitSyncAccessToken(');
  install(h.c,'function refreshHabitSaveUI(','function queueHabitCheck(');
  const initial=h.c.habitOverviewHtml();
  assert.match(initial,/synthetic summary/);assert.doesNotMatch(initial,/data-habit-sync-settings|알림 자동 연동/);
  h.c.refreshHabitSaveUI('h1');
  assert.match(panel.innerHTML,/synthetic summary/);assert.doesNotMatch(panel.innerHTML,/data-habit-sync-settings|알림 자동 연동/);
  const action=h.c.habitReminderActionHtml(h.habit);
  assert.match(action,/data-habit-reminder="h1"/);assert.match(action,/알림 자동 연동/);
});
