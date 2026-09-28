'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ArchiveTimer=require('../archiveTimer.js');
const Domain=require('../readingTimerDomain.js');
const ArchiveDomain=require('../archiveDomain.js');
function fixture(overrides={}){
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),get length(){return values.size;},key:i=>Array.from(values.keys())[i]??null};
  let at=1000,owner='member',saves=[];
  const options={ownerId:'member',book:{id:'arc_book',title:'나의 책',currentPage:15,pageCount:300},storage,now:()=>at,
    adapter:{getOwnerId:()=>owner,saveSession:async(bookId,session,meta)=>{saves.push({bookId,session,meta});}},...overrides};
  return {options,values,storage,saves,clock:n=>{at=n;},owner:n=>{owner=n;},create:()=>ArchiveTimer.createController(options)};
}

test('running archive timer survives reload and excludes paused time',()=>{
  const f=fixture(),timer=f.create();f.clock(11000);assert.equal(timer.elapsed(),10000);timer.pause();
  f.clock(36011000);const restored=f.create();assert.equal(restored.state().timer.running,false);assert.equal(restored.elapsed(),10000);
  restored.resume();f.clock(36014000);assert.equal(restored.elapsed(),13000);
});

test('local timer storage separates both members and archive books',()=>{
  assert.notEqual(ArchiveTimer.storageKey('a','arc_one'),ArchiveTimer.storageKey('b','arc_one'));
  assert.notEqual(ArchiveTimer.storageKey('a','arc_one'),ArchiveTimer.storageKey('a','arc_two'));
  assert.notEqual(ArchiveTimer.storageKey('a:b','c'),ArchiveTimer.storageKey('a','b:c'));
});

test('countdown ends without stopping elapsed reading and retains acknowledgment',()=>{
  const f=fixture(),timer=f.create();timer.setCountdown(5000);f.clock(9000);timer.poll();
  let state=timer.state();assert.equal(state.timer.goalReached,true);assert.equal(state.timer.running,true);assert.equal(timer.elapsed(),8000);
  assert.equal(Domain.countdownRatio(state.timer,9000),0);timer.markNotified();timer.acknowledge();
  state=f.create().state();assert.equal(state.timer.countdownNotified,true);assert.equal(state.timer.countdownAcknowledged,true);
});

test('completion stage pauses duration and saves only archive adapter session',async()=>{
  const f=fixture(),timer=f.create();f.clock(4500);timer.done();timer.setPage(21);f.clock(104500);
  const result=await timer.save();assert.ok(result);assert.equal(f.saves.length,1);
  assert.deepEqual({...f.saves[0].session,id:'stable'},{id:'stable',startPage:15,endPage:21,seconds:3,createdAt:104500});
  assert.equal(f.saves[0].bookId,'arc_book');assert.deepEqual(f.saves[0].meta,{complete:false});
  assert.equal(JSON.parse(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book'))).timer,null);
});

test('uncertain save preserves frozen attempt across reload and retry',async()=>{
  const f=fixture();let reject=true;
  f.options.adapter.saveSession=async(bookId,session,meta)=>{f.saves.push({bookId,session,meta});if(reject)throw Error('network');};
  const timer=f.create();f.clock(9000);timer.done();timer.setPage(44);assert.equal(await timer.save(),false);
  const first=timer.state().attempt;assert.ok(first);timer.setPage(80);timer.resume();assert.equal(timer.state().endPage,44);assert.equal(timer.state().timer.phase,'save');
  f.clock(3609000);reject=false;const restored=f.create();assert.ok(await restored.save());
  assert.deepEqual(f.saves[0],f.saves[1]);assert.equal(f.saves[1].session.id,first.id);
});

test('double save clicks do not issue two adapter writes',async()=>{
  const f=fixture();let resolve;
  f.options.adapter.saveSession=()=>new Promise(r=>{resolve=r;});
  const timer=f.create();f.clock(3000);timer.done();const one=timer.save();assert.equal(timer.state().busy,true);assert.equal(await timer.save(),false);resolve();assert.ok(await one);
});

test('finish book chooses final page and preserves complete intent on retry',async()=>{
  const f=fixture(),timer=f.create();f.clock(3000);timer.done();timer.setComplete(true);
  assert.equal(timer.state().endPage,300);assert.ok(await timer.save());assert.deepEqual(f.saves[0].meta,{complete:true});
});

test('invalid pages and zero duration never save an old/default page accidentally',async()=>{
  const f=fixture(),timer=f.create();timer.done();assert.equal(await timer.save(),false);assert.equal(f.saves.length,0);
  assert.equal(timer.setPage(301),false);assert.equal(timer.setPage(14),false);assert.equal(timer.setPage(''),false);
  assert.equal(timer.state().endPage,15);
});

test('newer cross-tab timer is adopted before mutations instead of overwritten',()=>{
  const f=fixture(),one=f.create(),two=f.create();f.clock(4000);two.pause();const raw=f.storage.getItem(ArchiveTimer.storageKey('member','arc_book'));
  assert.equal(one.toggle(),false);assert.equal(one.state().timer.running,false);assert.equal(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book')),raw);
  assert.equal(one.toggle(),true);assert.equal(one.state().timer.running,true);
});

test('corrupt local timer is retained and never silently replaced',()=>{
  const f=fixture(),key=ArchiveTimer.storageKey('member','arc_book');f.storage.setItem(key,'{broken');const timer=f.create();
  assert.equal(timer.state().writable,false);assert.equal(timer.state().timer,null);assert.equal(timer.toggle(),false);assert.equal(f.storage.getItem(key),'{broken');
});

test('owner change blocks writes while reset can pause only the captured owner timer',async()=>{
  const f=fixture(),timer=f.create();f.clock(5000);f.owner('different');assert.equal(timer.done(),false);assert.equal(await timer.save(),false);
  assert.equal(timer.pauseForReset(),true);f.clock(95000);f.owner('member');assert.equal(f.create().elapsed(),4000);assert.equal(f.saves.length,0);
});

test('account change during save never clears the captured stored attempt',async()=>{
  const f=fixture();let resolve;f.options.adapter.saveSession=()=>new Promise(r=>{resolve=r;});
  const timer=f.create();f.clock(5000);timer.done();const pending=timer.save();f.owner('other');resolve();assert.equal(await pending,false);
  const saved=JSON.parse(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book')));assert.ok(saved.attempt);assert.equal(saved.timer.phase,'save');
});

test('failed local persistence rolls back a pause without losing accumulated time',()=>{
  const f=fixture(),timer=f.create();f.clock(5000);const original=f.storage.setItem;f.storage.setItem=()=>{throw Error('quota');};
  assert.equal(timer.pause(),false);assert.equal(timer.state().timer.running,true);assert.equal(timer.elapsed(),4000);f.storage.setItem=original;
  assert.equal(timer.pause(),true);f.clock(500000);assert.equal(timer.elapsed(),4000);
});

test('unknown total pages still respect archive limits before freezing a save attempt',async()=>{
  const f=fixture({book:{id:'arc_unknown',title:'쪽수 미상',currentPage:0,pageCount:null}}),timer=f.create();
  f.clock(5000);timer.done();assert.equal(timer.setPage(100001),false);assert.equal(timer.state().attempt,null);
  assert.equal(timer.setPage(123),true);assert.ok(await timer.save());assert.equal(f.saves[0].session.endPage,123);
});

test('a failed local discard keeps the existing elapsed timer available',()=>{
  const f=fixture(),timer=f.create();f.clock(5000);f.storage.setItem=()=>{throw Error('quota');};
  assert.equal(timer.discard(),false);assert.ok(timer.state().timer);assert.equal(timer.elapsed(),4000);
});

test('archive-domain retry after committed but lost response does not double elapsed totals',async()=>{
  const f=fixture();let book=ArchiveDomain.prepare({title:'나의 책',status:'reading',totalPages:300,currentPage:15}),dropResponse=true;
  f.options.adapter.saveSession=async function(_bookId,session,options){book=ArchiveDomain.addReadingSession(book,session,options);if(dropResponse)throw Error('response lost');};
  const timer=f.create();f.clock(61000);timer.done();timer.setPage(32);assert.equal(await timer.save(),false);
  assert.equal(book.readingSessions.length,1);assert.equal(ArchiveDomain.totalReadingSeconds(book),60);
  dropResponse=false;assert.ok(await f.create().save());assert.equal(book.readingSessions.length,1);assert.equal(book.currentPage,32);assert.equal(ArchiveDomain.totalReadingSeconds(book),60);
});

test('starting another archive book pauses the first and resuming reverses them without counting idle time',()=>{
  const f=fixture(),first=f.create();f.clock(11000);
  const second=ArchiveTimer.createController({...f.options,book:{...f.options.book,id:'arc_second'}});
  first.poll();assert.equal(first.state().timer.running,false);assert.equal(first.elapsed(),10000);assert.equal(second.state().timer.running,true);
  f.clock(111000);assert.equal(first.elapsed(),10000);assert.equal(first.resume(),true);second.poll();
  assert.equal(second.state().timer.running,false);assert.equal(second.elapsed(),100000);assert.equal(first.state().timer.running,true);
  f.clock(116000);assert.equal(first.elapsed(),15000);assert.equal(second.elapsed(),100000);
});

test('shared-book coordinator can pause stored archive timers after the original controller is gone',()=>{
  const f=fixture();f.create();f.clock(21000);
  assert.equal(ArchiveTimer.pauseOthers('member',undefined,{storage:f.storage,now:f.options.now}),true);
  const raw=JSON.parse(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book')));
  assert.equal(raw.timer.running,false);assert.equal(raw.timer.elapsedMs,20000);
});

test('beforeStart hook pauses shared reading before archive creation and every resume',()=>{
  const f=fixture();let sharedRunning=true,calls=0;
  f.options.adapter.beforeStart=function(owner,book){assert.equal(owner,'member');assert.equal(book,'arc_book');calls++;sharedRunning=false;return true;};
  const timer=f.create();assert.equal(calls,1);assert.equal(sharedRunning,false);timer.pause();sharedRunning=true;
  assert.equal(timer.resume(),true);assert.equal(calls,2);assert.equal(sharedRunning,false);timer.pause();assert.equal(timer.toggle(),true);assert.equal(calls,3);
});

test('failed shared pause blocks starting or resuming the archive timer',()=>{
  const f=fixture();f.options.adapter.beforeStart=()=>false;const timer=f.create();
  assert.equal(timer.state().timer.running,false);assert.equal(timer.resume(),false);assert.match(timer.state().error,/일시정지/);
  f.options.adapter.beforeStart=()=>true;assert.equal(timer.resume(),true);
});

test('pauseOthers does not read or rewrite other owners and preserves pending save payloads',async()=>{
  const f=fixture(),timer=f.create();f.clock(4000);timer.done();timer.setPage(20);
  f.options.adapter.saveSession=async()=>{throw Error('offline');};await timer.save();
  const ownKey=ArchiveTimer.storageKey('member','arc_book'),before=f.storage.getItem(ownKey),otherKey=ArchiveTimer.storageKey('member-other','arc_book');
  f.storage.setItem(otherKey,'secret unreadable data');assert.equal(ArchiveTimer.pauseOthers('member',undefined,{storage:f.storage,now:f.options.now}),true);
  assert.equal(f.storage.getItem(ownKey),before);assert.equal(f.storage.getItem(otherKey),'secret unreadable data');
});

test('corrupt same-owner timer or failed storage pause prevents another running timer',()=>{
  const f=fixture();f.create();f.clock(8000);f.storage.setItem(ArchiveTimer.storageKey('member','arc_corrupt'),'{broken');
  const firstBefore=f.storage.getItem(ArchiveTimer.storageKey('member','arc_book'));
  assert.equal(ArchiveTimer.pauseOthers('member','arc_new',{storage:f.storage,now:f.options.now}),false);
  assert.equal(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book')),firstBefore);
  const next=ArchiveTimer.createController({...f.options,book:{...f.options.book,id:'arc_new'}});assert.equal(next.state().timer.running,false);
  f.values.delete(ArchiveTimer.storageKey('member','arc_corrupt'));
  const realSet=f.storage.setItem;f.storage.setItem=(k,v)=>{if(k===ArchiveTimer.storageKey('member','arc_book'))throw Error('quota');realSet(k,v);};
  assert.equal(next.resume(),false);assert.equal(next.state().timer.running,false);
});

test('pauseOthers detects a cross-tab change before overwriting that timer',()=>{
  const f=fixture();f.create();f.clock(9000);const storeKey=ArchiveTimer.storageKey('member','arc_book'),original=f.storage.getItem(storeKey),get=f.storage.getItem;
  let reads=0;f.storage.getItem=k=>{if(k===storeKey&&++reads===2){const concurrent=JSON.parse(original);concurrent.timer.elapsedMs=777;concurrent.timer.running=false;concurrent.timer.startedAt=null;f.values.set(k,JSON.stringify(concurrent));}return get(k);};
  assert.equal(ArchiveTimer.pauseOthers('member',undefined,{storage:f.storage,now:f.options.now}),false);
  assert.equal(JSON.parse(get(storeKey)).timer.elapsedMs,777);
});

test('opening a paused timer does not interrupt another book until explicit resume',()=>{
  const f=fixture();let starts=0;f.options.adapter.beforeStart=()=>{starts++;return true;};
  const first=f.create();first.pause();const second=ArchiveTimer.createController({...f.options,book:{...f.options.book,id:'arc_second'}});
  const count=starts,openedAgain=f.create();assert.equal(starts,count);assert.equal(second.state().timer.running,true);
  assert.equal(openedAgain.resume(),true);assert.equal(starts,count+1);second.poll();assert.equal(second.state().timer.running,false);
  // Reopening the already-running book also checks the shared-book coordinator.
  f.create();assert.equal(starts,count+2);
});

test('logout reset pauses every captured-owner timer even when the open book was already paused',()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),f=fixture();
  class Clock extends Date{static now(){return f.options.now();}}
  function node(){return {open:false,innerHTML:'',setAttribute(){},querySelectorAll(){return [];},querySelector(){return null;},showModal(){this.open=true;},close(){this.open=false;},remove(){}};}
  const browser={GrowellReadingTimer:Domain,localStorage:f.storage,Date:Clock,document:{createElement:node,body:{appendChild(){}}},setInterval:()=>1,clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../archiveTimer.js'),'utf8'),browser);
  const api=browser.GrowellArchiveTimer,secondOptions={...f.options,book:{...f.options.book,id:'arc_second'}};
  api.createController(secondOptions).pause();api.createController(f.options);
  const foreignKey=ArchiveTimer.storageKey('different','arc_foreign');
  f.storage.setItem(foreignKey,JSON.stringify({v:1,timer:Domain.create({id:'foreign',userId:'different',bookId:'arc_foreign'},1000),endPage:0,complete:false,attempt:null}));
  assert.equal(api.open(secondOptions),true);f.clock(21000);f.owner(null);api.reset();
  const first=JSON.parse(f.storage.getItem(ArchiveTimer.storageKey('member','arc_book'))),second=JSON.parse(f.storage.getItem(ArchiveTimer.storageKey('member','arc_second')));
  assert.equal(first.timer.running,false);assert.equal(first.timer.elapsedMs,20000);assert.equal(second.timer.running,false);
  assert.equal(JSON.parse(f.storage.getItem(foreignKey)).timer.running,true);
});

function timerView(book){
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),f=fixture();
  let dialog,done;
  class Clock extends Date{static now(){return f.options.now();}}
  function node(){return dialog={open:false,innerHTML:'',setAttribute(){},
    querySelectorAll(selector){return selector==='[data-at-done]'?[{addEventListener(_name,handler){done=handler;}}]:[];},
    querySelector(){return null;},showModal(){this.open=true;},close(){this.open=false;},remove(){}};}
  const browser={URL,GrowellReadingTimer:Domain,GrowellArchiveDomain:ArchiveDomain,localStorage:f.storage,Date:Clock,
    document:{createElement:node,body:{appendChild(){}}},setInterval:()=>1,clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../archiveTimer.js'),'utf8'),browser);
  assert.equal(browser.GrowellArchiveTimer.open({...f.options,book:{...f.options.book,...book}}),true);
  const timerHtml=dialog.innerHTML;f.clock(5000);done();
  const saveHtml=dialog.innerHTML;browser.GrowellArchiveTimer.reset();
  return {timerHtml,saveHtml};
}

test('YES24 search source retains canonical attribution in both timer and save views',()=>{
  for(const source of ['yes24','YES24']){
    const views=timerView({source,sourceUrl:'https://www.yes24.com/product/goods/123?tracking=unused#reviews'});
    assert.match(views.timerHtml,/reading-timer-book/);assert.match(views.saveHtml,/reading-save-book/);
    for(const html of Object.values(views)){
      assert.match(html,/도서 정보: <a href="https:\/\/www\.yes24\.com\/product\/goods\/123" target="_blank" rel="noopener noreferrer">YES24<\/a>/);
      assert.equal(html.includes('tracking=unused'),false);
    }
  }
});

test('timer attribution never links an unsafe or unrelated YES24 source URL',()=>{
  for(const sourceUrl of ['https://www.yes24.com.evil.test/product/goods/123','http://www.yes24.com/product/goods/123',
    'https://user@www.yes24.com/product/goods/123','https://www.yes24.com:8443/product/goods/123',
    'https://www.yes24.com/product/goods/0','https://www.yes24.com/product/goods/123/edit',
    'https://www.yes24.com/support','javascript:alert(1)','//www.yes24.com/product/goods/123']){
    for(const html of Object.values(timerView({source:'yes24',sourceUrl})))assert.equal(html.includes('도서 정보:'),false,sourceUrl);
  }
  for(const source of ['Google Books',undefined]){
    for(const html of Object.values(timerView({source,sourceUrl:'https://www.yes24.com/product/goods/123'})))assert.equal(html.includes('도서 정보:'),false);
  }
});
