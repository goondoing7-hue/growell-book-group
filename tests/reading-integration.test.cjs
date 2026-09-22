const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const domain=require('../readingTimerDomain.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a,start);return html.slice(a,b);
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({now=10000,owner='reader',memory=new Map(),server={logs:{},meta:{}},failMeta=0,loseResponse=0,beforeMeta}={}){
  let clock=now,metaFailures=failMeta,lostResponses=loseResponse;
  const requests=[],toasts=[];
  const books=[{id:'emotion',title:'감정',totalPages:300},{id:'thought',title:'생각',totalPages:200}];
  const c={
    console,Promise,Uint8Array,atob,setTimeout,clearInterval(){},
    Date:class extends Date{static now(){return clock;}},
    GrowellReadingTimer:domain,BOOKS:books,
    STATE:{users:{[owner]:{id:owner,name:'독서회원'}},posts:{},comments:{},privateEntries:{},materialNotes:{},worksheets:{},habits:{},
      readingLogs:{},readingMeta:{},bookLocks:{},announcement:{next:{},reading:{}}},
    SESSION:{userId:owner,name:'독서회원',keyB64:'memory-only'},CURRENT_KEY:null,
    location:{hash:'#/book/emotion/mine'},document:{querySelectorAll:()=>[]},
    localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
    sessionStorage:{setItem(){}},urlFromPhoto:()=>null,render(){},showToast:(...args)=>toasts.push(args),
    bookById:id=>books.find(book=>book.id===id),isBookLocked:()=>false,
    myCurrentPage:()=>0,uid:()=> 'rl-test',esc:value=>String(value),
    sb:{from(table){
      let operation='select',payload,filters=[],single=false;
      const query={
        select(){return query;},eq(key,value){filters.push([key,value]);return query;},maybeSingle(){single=true;return query;},
        insert(value){operation='insert';payload=clone(value);return query;},
        upsert(value){operation='upsert';payload=clone(value);return query;},
        update(value){operation='update';payload=clone(value);return query;},delete(){operation='delete';return query;},
        then(resolve,reject){return Promise.resolve().then(async()=>{
          const request={table,operation,payload,filters};requests.push(request);
          if(table==='reading_logs'){
            if(operation==='select'){
              const rows=Object.values(server.logs).filter(row=>filters.every(([key,value])=>row[key]===value));
              return {data:clone(single?(rows[0]||null):rows),error:null};
            }
            assert.equal(operation,'insert');
            if(server.logs[payload.id])return {error:{code:'23505'}};
            server.logs[payload.id]=clone(payload);
            if(lostResponses>0){lostResponses--;return {error:new Error('response lost after commit')};}
            return {data:null,error:null};
          }
          assert.equal(table,'reading_meta');assert.equal(operation,'upsert');
          if(beforeMeta){const result=await beforeMeta(request);if(result&&result.error)return result;}
          if(metaFailures>0){metaFailures--;return {error:new Error('temporary metadata failure')};}
          server.meta[payload.book_id+'_'+payload.user_id]=clone(payload);
          return {data:null,error:null};
        }).then(resolve,reject);}
      };return query;
    }}
  };
  vm.createContext(c);
  vm.runInContext(section('function readingMetaKey(', 'function mapProfileRow('),c);
  vm.runInContext(section('function mapReadingMetaRow(', 'function mapBookLockRow('),c);
  vm.runInContext(section('function mapHabitRow(', '\nvar STATE ='),c);
  vm.runInContext(section('var readingTimer =', 'var worksheetOpenFor ='),c);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'),c);
  vm.runInContext(section('function submitReadingLog(', 'function todayReadSeconds('),c);
  c.memberLoadState={privateEntries:'ready',habits:'ready',readingLogs:'ready',readingMeta:'ready'};
  Object.values(server.logs).filter(row=>row.user_id===owner).forEach(row=>{const mapped=c.mapReadingLogRow(row);c.STATE.readingLogs[mapped.id]=mapped;});
  Object.values(server.meta).filter(row=>row.user_id===owner).forEach(row=>{const mapped=c.mapReadingMetaRow(row,c.STATE.users);c.STATE.readingMeta[c.readingMetaKey(mapped.bookId,mapped.userId)]=mapped;});
  function prepared({id='rl-session',startPage=10,elapsedMs=10000}={}){
    c.readingTimer=domain.pause(domain.create({id,userId:owner,bookId:'emotion',startPage},0),elapsedMs);
    c.readingTimer.phase='save';c.readingSavePanelOpen=true;c.readingTimerRestoreOwner=owner;
    return c.readingTimer;
  }
  return {c,memory,server,requests,toasts,prepared,setNow:value=>{clock=value;}};
}

test('failed metadata save keeps a frozen retry payload, then clears timer only after complete success',async()=>{
  const {c,memory,server,requests,prepared,setNow}=harness({failMeta:1});
  prepared();c.persistReadingTimer();
  assert.equal(await c.submitReadingLog('emotion',999,15,{}),false);
  const frozen=clone(c.readingSaveAttempt);
  assert.equal(frozen.seconds,10);assert.equal(frozen.page,15);assert.equal(frozen.createdAt,10000);
  assert.equal(c.readingSaveBusy,false);assert.equal(c.readingSaveError,true);assert.ok(c.readingTimer);
  assert.equal(server.logs[frozen.id].page,15,'immutable log may have committed before metadata failed');
  assert.ok(memory.has(c.readingTimerStorageKey('reader')));
  setNow(120000);
  assert.equal(await c.submitReadingLog('emotion',888,20,{}),true);
  const inserts=requests.filter(request=>request.table==='reading_logs'&&request.operation==='insert');
  assert.equal(inserts.length,2);assert.deepEqual(inserts[0].payload,inserts[1].payload,'retry preserves ID, seconds, page and createdAt');
  assert.equal(Object.keys(server.logs).length,1);
  assert.equal(server.meta.emotion_reader.current_page,15);
  assert.equal(c.STATE.readingLogs[frozen.id].seconds,10);assert.equal(c.STATE.readingMeta.emotion_reader.currentPage,15);
  assert.equal(c.readingTimer,null);assert.equal(c.readingSaveAttempt,null);assert.equal(c.readingSavePanelOpen,false);
  assert.equal(c.readingHistoryOpenFor,'emotion');assert.equal(c.readingSaveBusy,false);
  assert.equal(memory.has(c.readingTimerStorageKey('reader')),false);
});

test('a lost insert response is verified against the existing row without duplicating reading time',async()=>{
  const {c,server,requests,prepared}=harness({loseResponse:1});prepared({startPage:0});
  assert.equal(await c.submitReadingLog('emotion',0,'0',{}),true);
  assert.equal(Object.keys(server.logs).length,1);assert.equal(server.logs['rl-session'].seconds,10);
  assert.equal(server.logs['rl-session'].page,0);assert.equal(server.meta.emotion_reader.current_page,0);
  assert.ok(requests.some(request=>request.table==='reading_logs'&&request.operation==='select'));
});

test('duplicate submit clicks during an in-flight save cannot create another request or snapshot',async()=>{
  const gate=deferred();
  const {c,requests,prepared}=harness({beforeMeta:()=>gate.promise});prepared();
  const first=c.submitReadingLog('emotion',0,15,{});await tick();
  const frozen=clone(c.readingSaveAttempt);
  assert.equal(c.readingSaveBusy,true);
  assert.equal(c.submitReadingLog('emotion',0,99,{}),undefined);
  assert.deepEqual(clone(c.readingSaveAttempt),frozen);
  gate.resolve({error:null});assert.equal(await first,true);
  assert.equal(requests.filter(request=>request.table==='reading_logs'&&request.operation==='insert').length,1);
});

test('refresh restores the failed attempt and retries its original values even when the immutable row is already loaded',async()=>{
  const memory=new Map(),server={logs:{},meta:{}};
  const first=harness({memory,server,failMeta:1});first.prepared();
  assert.equal(await first.c.submitReadingLog('emotion',0,15,{}),false);
  const frozen=clone(first.c.readingSaveAttempt);
  const reloaded=harness({memory,server,now:900000});
  reloaded.c.syncReadingTimer();
  assert.deepEqual(clone(reloaded.c.readingSaveAttempt),frozen);
  assert.equal(reloaded.c.readingSavePanelOpen,true);assert.equal(reloaded.c.readingTimer.running,false);
  assert.equal(reloaded.c.readingTimerElapsedMs(),10000);
  assert.equal(await reloaded.c.submitReadingLog('emotion',0,100,{}),true);
  assert.equal(server.meta.emotion_reader.current_page,15);assert.equal(Object.keys(server.logs).length,1);
  assert.equal(reloaded.requests.filter(request=>request.table==='reading_logs'&&request.operation==='insert').length,0);
});

test('retrying an older failed record preserves a newer page position already loaded from another device',async()=>{
  const memory=new Map(),server={logs:{},meta:{}};
  const first=harness({memory,server,failMeta:1});first.prepared();
  assert.equal(await first.c.submitReadingLog('emotion',0,15,{}),false);
  server.meta.emotion_reader={book_id:'emotion',user_id:'reader',current_page:50,updated_at:15000};
  const reloaded=harness({memory,server,now:20000});reloaded.c.syncReadingTimer();
  assert.equal(reloaded.c.STATE.readingMeta.emotion_reader.currentPage,50);
  assert.equal(await reloaded.c.submitReadingLog('emotion',0,15,{}),true);
  assert.equal(server.logs['rl-session'].page,15,'the immutable older reading record remains correct');
  assert.equal(server.meta.emotion_reader.current_page,50,'the newer current position does not regress');
  assert.equal(server.meta.emotion_reader.updated_at,15000);
  assert.equal(reloaded.c.STATE.readingMeta.emotion_reader.currentPage,50);
  assert.equal(reloaded.requests.filter(request=>request.table==='reading_meta').length,0);
  assert.equal(reloaded.c.readingTimer,null,'the confirmed older record can still finish successfully');
});

test('refresh preserves a valid edited ending page before first submit and rejects an invalid stored page',()=>{
  const memory=new Map();
  const first=harness({memory});first.prepared();first.c.readingEndPage=27;first.c.persistReadingTimer();
  const restored=harness({memory,now:90000});restored.c.syncReadingTimer();
  assert.equal(restored.c.readingSavePanelOpen,true);assert.equal(restored.c.readingEndPage,27);
  assert.equal(restored.c.readingSaveAttempt,null);
  const key=restored.c.readingTimerStorageKey('reader');
  const stored=JSON.parse(memory.get(key));stored.endPage=301;memory.set(key,JSON.stringify(stored));
  const invalid=harness({memory});invalid.c.syncReadingTimer();
  assert.equal(invalid.c.readingEndPage,null);assert.ok(invalid.c.readingTimer);
});

test('persistence and refresh never reveal another account timer, even if its payload is copied to the wrong owner key',()=>{
  const memory=new Map();
  const first=harness({memory});first.prepared();first.c.persistReadingTimer();
  const firstKey=first.c.readingTimerStorageKey('reader'),firstStored=memory.get(firstKey);
  const other=harness({memory,owner:'other'});other.c.syncReadingTimer();
  assert.equal(other.c.readingTimer,null);assert.equal(other.c.readingSaveAttempt,null);assert.equal(memory.get(firstKey),firstStored);
  const otherKey=other.c.readingTimerStorageKey('other');memory.set(otherKey,firstStored);
  other.c.readingTimerRestoreOwner=null;other.c.syncReadingTimer();
  assert.equal(other.c.readingTimer,null);assert.equal(memory.get(otherKey),firstStored,'unreadable stored data is not removed as a side effect of loading');
});

test('logout pauses and preserves the old owner timer while clearing its live session state',()=>{
  const {c,memory,setNow}=harness({now:5000});
  c.readingTimer=domain.create({id:'running',userId:'reader',bookId:'emotion',startPage:0},0);
  c.clearMemberSession();
  assert.equal(c.SESSION,null);assert.equal(c.readingTimer,null);assert.equal(c.readingSaveAttempt,null);
  const stored=JSON.parse(memory.get(c.readingTimerStorageKey('reader')));
  assert.equal(stored.timer.running,false);assert.equal(stored.timer.elapsedMs,5000);
  c.SESSION={userId:'reader',name:'독서회원'};setNow(100000);c.syncReadingTimer();
  assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(c.readingTimer.running,false);
});

test('read-load failures and invalid page values prevent writes without discarding the current timer',async()=>{
  const {c,requests,prepared}=harness();prepared();
  c.memberLoadState.readingLogs='error';
  assert.equal(c.submitReadingLog('emotion',0,15,{}),undefined);
  c.memberLoadState.readingLogs='ready';
  for(const page of ['',-1,9,301,10.5]) assert.equal(c.submitReadingLog('emotion',0,page,{}),undefined);
  assert.equal(requests.length,0);assert.ok(c.readingTimer);assert.equal(c.readingSaveAttempt,null);
});

test('corrupt timer data is preserved but never installed as an active timer',()=>{
  const {c,memory}=harness();
  const key=c.readingTimerStorageKey('reader');memory.set(key,'not-json');
  c.syncReadingTimer();assert.equal(c.readingTimer,null);assert.equal(memory.get(key),'not-json');
  const wrongBook={v:1,timer:domain.create({id:'unknown',userId:'reader',bookId:'missing',startPage:0},0)};
  memory.set(key,JSON.stringify(wrongBook));c.readingTimerRestoreOwner=null;c.syncReadingTimer();
  assert.equal(c.readingTimer,null);assert.deepEqual(JSON.parse(memory.get(key)),wrongBook);
});

test('restored retry snapshots reject impossible durations and negative or fractional creation timestamps',()=>{
  for(const patch of [{seconds:1.5},{seconds:999},{createdAt:-1},{createdAt:1.5}]){
    const {c,memory,prepared}=harness();
    const current=prepared();
    const attempt={id:current.id,userId:'reader',bookId:'emotion',startPage:10,page:15,seconds:10,createdAt:10000,...patch};
    memory.set(c.readingTimerStorageKey('reader'),JSON.stringify({v:1,timer:current,attempt}));
    c.readingTimerRestoreOwner=null;c.syncReadingTimer();
    assert.equal(c.readingSaveAttempt,null,JSON.stringify(patch));
    assert.ok(c.readingTimer,'the underlying valid timer remains recoverable');
  }
});

test('countdown expiry and refresh automatically offer page saving at the exact goal',()=>{
  const {c,memory,setNow}=harness({now:0});
  c.readingTimer=domain.setCountdown(domain.create({id:'expiry',userId:'reader',bookId:'emotion',startPage:32},0),60000,0);
  c.readingTimerRestoreOwner='reader';c.persistReadingTimer();
  setNow(180000);c.syncReadingTimer();
  assert.equal(c.readingSavePanelOpen,true);assert.equal(c.readingTimer.phase,'save');
  assert.equal(c.readingTimerElapsedMs(),60000);assert.equal(c.readingTimer.running,false);
  const refreshed=harness({memory,now:900000});refreshed.c.syncReadingTimer();
  assert.equal(refreshed.c.readingSavePanelOpen,true);assert.equal(refreshed.c.readingTimerElapsedMs(),60000);
  const newMemory=new Map();newMemory.set(c.readingTimerStorageKey('reader'),JSON.stringify({v:1,timer:domain.setCountdown(domain.create({id:'asleep',userId:'reader',bookId:'emotion',startPage:0},0),60000,0)}));
  const asleep=harness({memory:newMemory,now:900000});asleep.c.syncReadingTimer();
  assert.equal(asleep.c.readingSavePanelOpen,true,'a countdown that expired while the page was closed opens its save panel too');
});

function noteHarness(options){
  const fixture=harness(options),{c}=fixture;
  c.document.getElementById=()=>null;
  c.captureComposerDraft=()=>null;
  c.openComposerWithDraft=(type,book,edit,open)=>Promise.resolve(open(null));
  c.resetMineComposer=()=>{c.mineComposerOpenFor=null;};
  c.resetShareComposer=()=>{c.shareComposerOpenFor=null;};
  vm.runInContext(section('function openReadingNote(', 'function tickReadingTimer('),c);
  c.readingTimer=domain.setCountdown(domain.create({id:'note-timer',userId:'reader',bookId:'emotion',startPage:32},0),60000,0);
  c.readingTimerRestoreOwner='reader';
  return fixture;
}

test('both note destinations use the existing composer and return only after the matching note completes',async()=>{
  for(const type of ['share','mine']){
    const {c,setNow}=noteHarness({now:5000});
    await c.openReadingNote(type);
    assert.equal(c.location.hash,'#/book/emotion/'+type);
    assert.equal(type==='share'?c.shareComposerOpenFor:c.mineComposerOpenFor,'emotion');
    assert.equal(c.readingTimer.running,false);assert.equal(c.readingTimer.elapsedMs,5000);
    setNow(100000);
    assert.equal(c.completeReadingNote(type==='share'?'mine':'share','emotion'),false);
    assert.equal(c.completeReadingNote(type,'thought'),false);
    assert.equal(c.readingTimer.running,false,'an unrelated note cannot restart this timer');
    assert.equal(c.completeReadingNote(type,'emotion'),true);
    assert.equal(c.location.hash,'#/book/emotion/mine');assert.equal(c.readingTimer.running,true);
    assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(c.readingTimer.targetMs,60000);
    assert.equal(c.readingNoteReturn,null);
  }
});

test('failed draft opening restores the previous timer state without changing existing notes',async()=>{
  const {c}=noteHarness({now:5000});
  c.STATE.privateEntries.kept={id:'kept',data:'unchanged ciphertext'};
  c.openComposerWithDraft=()=>Promise.resolve();
  await c.openReadingNote('mine');
  assert.equal(c.readingTimer.running,true);assert.equal(c.readingTimerElapsedMs(),5000);
  assert.equal(c.readingNoteReturn,null);assert.equal(c.STATE.privateEntries.kept.data,'unchanged ciphertext');
});

test('note return metadata survives refresh without storing content or counting the writing interval',async()=>{
  const memory=new Map(),first=noteHarness({memory,now:5000});
  await first.c.openReadingNote('mine');
  const raw=JSON.parse(memory.get(first.c.readingTimerStorageKey('reader')));
  assert.deepEqual(Object.keys(raw.noteReturn).sort(),['bookId','timerId','type','userId','wasRunning']);
  const second=noteHarness({memory,now:100000});second.c.readingTimerRestoreOwner=null;second.c.syncReadingTimer();
  assert.equal(second.c.readingTimer.running,false);assert.equal(second.c.readingTimerElapsedMs(),5000);
  assert.equal(second.c.completeReadingNote('mine','emotion'),true);
  assert.equal(second.c.readingTimer.running,true);assert.equal(second.c.readingTimerElapsedMs(),5000);
  const other=harness({memory,owner:'other'});other.c.syncReadingTimer();assert.equal(other.c.readingNoteReturn,null);
});
