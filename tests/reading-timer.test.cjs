const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const timer=require('../readingTimerDomain.js');
const input={id:'rt-example',userId:'reader',bookId:'emotion',startPage:12};
const start=(now=0)=>timer.create(input,now);

test('a new timer starts correctly at timestamp zero and keeps original fields',()=>{
  const current=start(0);
  assert.deepEqual(current,{...input,createdAt:0,startedAt:0,elapsedMs:0,running:true,targetMs:null,goalReached:false,phase:'timer'});
  assert.equal(timer.elapsed(current,1500),1500);
  assert.equal(timer.remaining(current,1500),null);
  assert.equal(current.elapsedMs,0);
});

test('pause and resume preserve elapsed time without counting a paused interval',()=>{
  const original=Object.freeze(start(0));
  const paused=timer.pause(original,5000);
  assert.equal(paused.elapsedMs,5000);assert.equal(paused.startedAt,null);assert.equal(paused.running,false);
  assert.equal(timer.elapsed(paused,15000),5000);
  const resumed=timer.resume(Object.freeze(paused),20000);
  assert.equal(timer.elapsed(resumed,22500),7500);
  assert.equal(timer.elapsed(timer.resume(resumed,22500),23000),8000,'resume on a running timer loses no elapsed time');
  assert.equal(original.elapsedMs,0);assert.equal(paused.running,false);
});

test('a countdown starts from the current elapsed time and pauses do not consume it',()=>{
  const countdown=timer.setCountdown(start(),60000,5000);
  assert.equal(countdown.targetMs,65000);assert.equal(countdown.elapsedMs,5000);
  assert.equal(timer.remaining(countdown,15000),50000);
  const paused=timer.pause(countdown,15000);
  assert.equal(timer.remaining(paused,95000),50000);
  const resumed=timer.resume(paused,100000);
  assert.equal(timer.remaining(resumed,110000),40000);
});

test('late wake-up clamps at the exact goal and pauses instead of recording background overrun',()=>{
  const countdown=timer.setCountdown(start(),60000,5000);
  assert.equal(timer.elapsed(countdown,300000),65000);
  assert.equal(timer.remaining(countdown,300000),0);
  const reached=timer.settle(countdown,300000);
  assert.equal(reached.elapsedMs,65000);assert.equal(reached.startedAt,null);assert.equal(reached.running,false);assert.equal(reached.goalReached,true);
  assert.equal(timer.elapsed(reached,600000),65000);
  assert.deepEqual(timer.settle(reached,600000),reached);
});

test('resuming a reached goal clears that target and continues counting',()=>{
  const reached=timer.settle(timer.setCountdown(start(),10000,0),20000);
  const resumed=timer.resume(reached,25000);
  assert.equal(resumed.targetMs,null);assert.equal(resumed.goalReached,false);assert.equal(resumed.running,true);
  assert.equal(timer.elapsed(resumed,27000),12000);assert.equal(timer.remaining(resumed,27000),null);
});

test('changing and clearing a countdown preserve accumulated time and paused/running state',()=>{
  const first=timer.setCountdown(start(),60000,10000);
  const changed=timer.setCountdown(first,30000,20000);
  assert.equal(changed.targetMs,50000);assert.equal(changed.elapsedMs,20000);
  const cleared=timer.clearCountdown(changed,25000);
  assert.equal(cleared.elapsedMs,25000);assert.equal(cleared.targetMs,null);assert.equal(cleared.running,true);
  assert.equal(timer.elapsed(cleared,35000),35000);
  const paused=timer.pause(cleared,35000);
  const planned=timer.setCountdown(paused,10000,40000);
  assert.equal(planned.running,false);assert.equal(planned.targetMs,45000);
  const finished=timer.settle(timer.setCountdown(start(),1000,0),2000);
  assert.equal(timer.clearCountdown(finished,4000).running,false,'clearing a reached target does not silently restart');
});

test('restoring a running JSON timer includes time since the last render and survives another refresh',()=>{
  const original=start(1000);
  const restored=timer.restore(JSON.stringify(original),'reader',['emotion'],9000);
  assert.equal(timer.elapsed(restored,9000),8000);assert.equal(restored.id,original.id);
  const again=timer.restore(JSON.stringify(restored),'reader',new Set(['emotion']),12000);
  assert.equal(timer.elapsed(again,12000),11000);
  assert.equal(again.createdAt,1000);assert.equal(again.startPage,12);
});

test('restoring a countdown after refresh clamps a passed target and preserves save phase',()=>{
  const current=timer.setCountdown(start(),60000,0);
  const restored=timer.restore(JSON.stringify(current),'reader',['emotion'],600000);
  assert.equal(restored.elapsedMs,60000);assert.equal(restored.running,false);assert.equal(restored.goalReached,true);
  const save={...timer.pause(start(),5000),phase:'save'};
  const pending=timer.restore(save,'reader',['emotion'],20000);
  assert.equal(pending.phase,'save');assert.equal(timer.elapsed(pending,20000),5000);
  assert.equal(timer.resume(pending,20000).phase,'timer');
});

test('restoration rejects other accounts, unknown books, missing identities and malformed input',()=>{
  const valid=start();
  assert.equal(timer.restore(valid,'other',['emotion'],100),null);
  assert.equal(timer.restore(valid,'reader',['thought'],100),null);
  assert.equal(timer.restore(valid,'reader',null,100),null);
  for(const raw of ['not-json','null','[]',null,[],{}, {...valid,id:''},{...valid,userId:undefined},
    {bookId:'emotion',startedAt:0,elapsedMs:0,running:true}]){
    assert.equal(timer.restore(raw,'reader',['emotion'],100),null);
  }
});

test('malformed numeric and contradictory timer fields cannot become a restored record',()=>{
  const valid=start();
  for(const patch of [
    {elapsedMs:-1},{elapsedMs:Infinity},{elapsedMs:NaN},{elapsedMs:'12'},{elapsedMs:1.5},
    {startedAt:null},{startedAt:-1},{startedAt:'0'},{running:'true'},
    {createdAt:NaN},{startPage:-1},{startPage:3.5},{targetMs:-1},{targetMs:'60000'},
    {elapsedMs:10,targetMs:5},{goalReached:true},{phase:'unknown'},{phase:'save'},
    {running:false,elapsedMs:5,targetMs:10,goalReached:true}
  ]) assert.equal(timer.restore({...valid,...patch},'reader',['emotion'],100),null,JSON.stringify(patch));
  assert.equal(timer.restore(valid,'reader',['emotion'],NaN),null);
});

test('optional extension fields are recovered without trusting a timer from an unknown owner',()=>{
  const older={id:'older',userId:'reader',bookId:'emotion',startedAt:0,elapsedMs:50,running:true};
  const recovered=timer.restore(older,'reader',['emotion'],100);
  assert.equal(recovered.startPage,0);assert.equal(recovered.createdAt,0);assert.equal(recovered.phase,'timer');
  assert.equal(recovered.targetMs,null);assert.equal(timer.elapsed(recovered,100),150);
});

test('backward wall-clock adjustment never makes elapsed negative or stalls the restored timer',()=>{
  const original=start(10000);
  assert.equal(timer.elapsed(original,5000),0);
  const restored=timer.restore(original,'reader',['emotion'],5000);
  assert.equal(restored.startedAt,5000);assert.equal(restored.createdAt,10000);
  assert.equal(timer.elapsed(restored,6000),1000);
});

test('invalid creation and countdown durations are rejected without mutating a valid timer',()=>{
  const valid=Object.freeze(start());
  for(const value of [0,-1,NaN,Infinity,'60000',1.5]) assert.equal(timer.setCountdown(valid,value,0),null);
  for(const patch of [{id:''},{userId:''},{bookId:''},{startPage:-1},{createdAt:Infinity},{running:'true'}]){
    assert.equal(timer.create({...input,...patch},0),null);
  }
  assert.equal(timer.create(input,-1),null);assert.equal(timer.create(null,0),null);
  assert.equal(timer.pause(null,0),null);assert.equal(timer.resume(null,0),null);
  assert.equal(timer.elapsed(null,0),0);assert.equal(timer.remaining(null,0),null);
  assert.equal(valid.targetMs,null);
});

test('page validation accepts zero and repeated reading of the same page',()=>{
  assert.deepEqual(timer.validatePages(0,0,300),{ok:true,page:0});
  assert.deepEqual(timer.validatePages(' 12 ','12',300),{ok:true,page:12});
  assert.deepEqual(timer.validatePages(0,'300',300),{ok:true,page:300});
  assert.deepEqual(timer.validatePages(0,0,0),{ok:true,page:0});
  assert.deepEqual(timer.validatePages(2,1000,null),{ok:true,page:1000});
});

test('page validation rejects missing, negative, fractional, backwards and oversized page numbers clearly',()=>{
  for(const [first,last,total] of [[0,'',300],['',10,300],[0,'  ',300],[0,-1,300],[0,1.5,300],
    [0,'1.5',300],[0,'1e2',300],[0,Infinity,300],[0,NaN,300],[0,true,300],[0,undefined,300]]){
    const result=timer.validatePages(first,last,total);assert.equal(result.ok,false);assert.match(result.error,/정수/);
  }
  assert.match(timer.validatePages(12,11,300).error,/앞설/);
  assert.match(timer.validatePages(0,301,300).error,/전체 300쪽/);
  assert.match(timer.validatePages(301,301,300).error,/전체 300쪽/);
  assert.match(timer.validatePages(0,1,0).error,/전체 0쪽/);
  assert.match(timer.validatePages(0,1,'').error,/전체 쪽수/);
});

test('browser and CommonJS expose the same timer API without needing browser state',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','readingTimerDomain.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.GrowellReadingTimer).sort(),Object.keys(timer).sort());
  const current=context.GrowellReadingTimer.create(input,0);
  assert.equal(context.GrowellReadingTimer.elapsed(current,1000),1000);
});

test('countdown sliders accept only a positive duration within hours and minutes bounds',()=>{
  assert.equal(timer.countdownDuration('0','1'),60000);
  assert.equal(timer.countdownDuration(1,20),4800000);
  assert.equal(timer.countdownDuration(23,59),86340000);
  for(const values of [[0,0],[24,0],[0,60],[-1,2],['',20],[0,1.5],[true,5]])assert.equal(timer.countdownDuration(...values),null);
});

test('page slider progress reports exact pages read and a rounded whole-book percentage',()=>{
  assert.deepEqual(timer.pageProgress(32,'48',364),{ok:true,page:48,pagesRead:16,percent:13.2});
  assert.deepEqual(timer.pageProgress(32,364,364),{ok:true,page:364,pagesRead:332,percent:100});
  assert.deepEqual(timer.pageProgress(0,0,0),{ok:true,page:0,pagesRead:0,percent:0});
  for(const values of [[32,31,364],[32,365,364],[32,'',364],[32,40,null]])assert.equal(timer.pageProgress(...values).ok,false);
});

test('writing a note excludes writing time, preserves remaining countdown and restores running state',()=>{
  const running=timer.setCountdown(start(),60000,5000);
  const writing=timer.beginNote(Object.freeze(running),'share',15000);
  assert.equal(writing.timer.running,false);assert.equal(writing.timer.elapsedMs,15000);
  assert.equal(timer.remaining(writing.timer,900000),50000);
  const resumed=timer.finishNote(Object.freeze(writing.timer),writing.handoff,900000);
  assert.equal(resumed.id,running.id);assert.equal(resumed.targetMs,65000);assert.equal(resumed.running,true);
  assert.equal(timer.elapsed(resumed,910000),25000);assert.equal(timer.remaining(resumed,910000),40000);
  assert.equal(running.running,true,'original timer is not mutated');
});

test('notes opened from an already paused timer return paused and expired goals cannot enter the writer',()=>{
  const paused=timer.pause(start(),10000),writing=timer.beginNote(paused,'mine',20000);
  const finished=timer.finishNote(writing.timer,writing.handoff,50000);
  assert.equal(finished.running,false);assert.equal(finished.elapsedMs,10000);
  assert.equal(timer.beginNote(timer.setCountdown(start(),10000,0),'mine',10000),null);
  assert.equal(timer.beginNote({...paused,phase:'save'},'mine',20000),null);
  assert.equal(timer.beginNote(start(),'public',100),null);
});

test('restored note handoff is identity-bound and rejects a replacement, running or other-owner timer',()=>{
  const writing=timer.beginNote(start(),'mine',5000);
  const restored=timer.restore(JSON.stringify(writing.timer),'reader',['emotion'],30000);
  assert.deepEqual(timer.restoreNoteHandoff(JSON.parse(JSON.stringify(writing.handoff)),restored),writing.handoff);
  assert.equal(timer.finishNote(restored,writing.handoff,30000).running,true);
  for(const patch of [{id:'new-session'},{userId:'other'},{bookId:'thought'},{phase:'save'},{running:true,startedAt:5000}]){
    assert.equal(timer.restoreNoteHandoff(writing.handoff,{...restored,...patch}),null);
    assert.equal(timer.finishNote({...restored,...patch},writing.handoff,30000),null);
  }
  assert.equal(timer.restoreNoteHandoff({...writing.handoff,wasRunning:'true'},restored),null);
});
