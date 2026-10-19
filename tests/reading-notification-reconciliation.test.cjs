'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Domain=require('../readingTimerDomain.js'),Alerts=require('../timerAlerts.js'),State=require('../readingNotificationState.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),fixture=fs.readFileSync(path.join(__dirname,'reading-notification.test.cjs'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
// Reuse the inert app harness, not its registered tests. Its persistence/commit
// and reconciliation functions are the actual production index source.
const start=fixture.indexOf('function appHarness(options={}){'),end=fixture.indexOf("\ntest('background clock",start);
assert.ok(start>=0&&end>start);
const loader={vm,Domain,Alerts,State,section,clone,assert,Promise,Date,Number,Math,JSON,URL,console,timer:(at=0)=>Domain.create({id:'rl-synthetic',userId:'PRIVATE_MEMBER',bookId:'emotion',startPage:5},at)};
vm.createContext(loader);vm.runInContext(fixture.slice(start,end)+'\nthis.buildAppHarness=appHarness;',loader);
const appHarness=options=>loader.buildAppHarness(options);

test('a lost logout request preserves its cutoff beside the original and restores only time before logout',async()=>{
  const h=appHarness();await h.arm();h.action('pause',8000);h.setNow(10000);
  vm.runInContext(section('function pauseReadingBeforeLogout(){','function isReadingHomeRoute(){'),h.c);
  h.options.failRpc='storage';h.c.pauseReadingBeforeLogout();
  const marked=JSON.parse(h.values.get('timer:PRIVATE_MEMBER'));
  assert.equal(marked.notification.logoutAt,10000);assert.equal(marked.timer.running,true,'a pending background action is not overwritten on logout');
  assert.equal([...h.records.values()][0].journal.length,1);
  const reopened=appHarness({records:h.records,values:h.values,active:h.active});reopened.c.GrowellTimerAlerts.newGeneration=()=> 'rn-'+'f'.repeat(32);reopened.setNow(500000);
  assert.equal(await reopened.arm(),true);assert.equal(reopened.c.readingTimer.running,false);assert.equal(reopened.c.readingTimer.elapsedMs,8000);
  assert.equal(reopened.record().journal.length,0);assert.equal(reopened.c.readingNotificationCheckpoint.logoutAt,undefined);
  assert.deepEqual(JSON.parse(h.values.get('timer:PRIVATE_MEMBER')).parked,marked.parked);
});

test('revoking OS permission after connection never leaves the app controls blocked behind a held lease',async()=>{
  const h=appHarness();await h.arm();h.action('pause',10000);h.options.permission='denied';h.setNow(20000);
  assert.equal(await h.c.withReadingNotificationMutation(()=>{const next=h.c.captureReadingTimerState();next.timer=Domain.resume(next.timer,20000);return h.c.commitReadingTimerState(next);}),true);
  assert.equal(h.c.readingTimer.running,true);assert.equal(h.record().held,null);assert.equal(h.record().revoked,true);
  h.setNow(25000);assert.equal(await h.c.withReadingNotificationMutation(()=>{const next=h.c.captureReadingTimerState();next.timer=Domain.pause(next.timer,25000);return h.c.commitReadingTimerState(next);}),true);
  assert.equal(h.c.readingTimer.elapsedMs,15000);assert.equal(h.c.readingTimer.running,false);assert.equal(h.calls.prompts,0);
});

test('another tab committing the same background clock prevents a stale local write and can still acknowledge once',async()=>{
  const h=appHarness();await h.arm();h.action('pause',10000);let replaced=false,otherRaw;
  h.options.afterRequest=async(request,result)=>{
    if(request.type!=='read'||replaced||!result.state?.journal.length)return;replaced=true;
    const saved=JSON.parse(h.values.get('timer:PRIVATE_MEMBER'));saved.timer={...saved.timer,...result.state.clock};
    saved.notification={generation:result.state.generation,throughSeq:result.state.seq,sourceRevision:Alerts.sessionSnapshot({timer:saved.timer,userId:'PRIVATE_MEMBER',generation:result.state.generation}).baseRevision};
    otherRaw=JSON.stringify(saved);h.values.set('timer:PRIVATE_MEMBER',otherRaw);
  };
  assert.equal(await h.arm(),false);assert.equal(h.values.get('timer:PRIVATE_MEMBER'),otherRaw);assert.equal(h.calls.acks,0);assert.equal(h.record().journal.length,1);
  h.options.afterRequest=null;h.restore();assert.equal(await h.arm(),true);assert.equal(h.c.readingTimer.elapsedMs,10000);assert.equal(h.record().journal.length,0);assert.equal(h.calls.acks,1);
});

test('an armed timer still settles and alerts once when its open-page countdown reaches zero',async()=>{
  const h=appHarness();const next=h.c.captureReadingTimerState();next.timer=Domain.setCountdown(next.timer,1000,5000);assert.equal(h.c.commitReadingTimerState(next),true);await h.arm();
  let notices=0;h.c.notifyReadingCountdown=()=>{if(!h.c.readingTimer.countdownNotified){notices++;h.c.readingTimer=Domain.markCountdownNotified(h.c.readingTimer,h.c.Date.now());h.c.persistReadingTimer();}};
  h.c.document.querySelectorAll=()=>[];h.c.readingTimerElapsedMs=()=>Domain.elapsed(h.c.readingTimer,h.c.Date.now());h.c.fmtElapsed=String;
  vm.runInContext(section('function syncReadingTimer(){','function pauseReadingBeforeLogout(){'),h.c);
  vm.runInContext(section('function tickReadingTimer(){','function bindReadingTimerEvents(){'),h.c);
  h.setNow(7000);h.c.tickReadingTimer();if(h.c.readingNotificationTask)await h.c.readingNotificationTask;
  assert.equal(h.c.readingTimer.goalReached,true);assert.equal(h.c.readingTimer.countdownNotified,true);assert.equal(notices,1);
  h.c.tickReadingTimer();if(h.c.readingNotificationTask)await h.c.readingNotificationTask;assert.equal(notices,1);
});
