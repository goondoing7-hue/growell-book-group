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
  const requests=[],toasts=[],notifications=[],storageWrites=[];
  const dialogs=new Map();
  const document={querySelectorAll:()=>[],getElementById:id=>dialogs.get(id)||null,
    body:{appendChild(dialog){dialogs.set(dialog.id,dialog);}},
    createElement(tag){
      assert.equal(tag,'dialog');
      const attributes={},handlers={},buttonHandlers={};
      return {id:'',open:false,innerHTML:'',setAttribute:(key,value)=>{attributes[key]=value;},getAttribute:key=>attributes[key],
        querySelector:()=>({addEventListener:(event,handler)=>{buttonHandlers[event]=handler;}}),
        addEventListener:(event,handler)=>{handlers[event]=handler;},
        showModal(){this.open=true;},close(){this.open=false;},remove(){dialogs.delete(this.id);},
        confirm(){buttonHandlers.click();},cancel(){handlers.cancel({preventDefault(){}});}};
    }};
  const books=[{id:'emotion',title:'감정',totalPages:300},{id:'thought',title:'생각',totalPages:200}];
  const c={
    console,Promise,Uint8Array,atob,setTimeout,clearInterval(){},
    Date:class extends Date{static now(){return clock;}},
    GrowellReadingTimer:domain,BOOKS:books,GrowellTimerAlerts:{notify:details=>{notifications.push(clone(details));return Promise.resolve();}},
    STATE:{users:{[owner]:{id:owner,name:'독서회원'}},posts:{},comments:{},privateEntries:{},materialNotes:{},worksheets:{},habits:{},
      readingLogs:{},readingMeta:{},bookLocks:{},announcement:{next:{},reading:{}}},
    SESSION:{userId:owner,name:'독서회원',keyB64:'memory-only'},CURRENT_KEY:null,
    location:{hash:'#/book/emotion/mine'},document,
    localStorage:{getItem:key=>memory.has(key)?memory.get(key):null,setItem:(key,value)=>{storageWrites.push({key,value});memory.set(key,value);},removeItem:key=>memory.delete(key)},
    sessionStorage:{setItem(){}},urlFromPhoto:()=>null,render(){},showToast:(...args)=>toasts.push(args),
    bookById:id=>books.find(book=>book.id===id),isBookLocked:()=>false,
    myCurrentPage:()=>0,uid:()=> 'rl-test',esc:value=>String(value),fmtDurationHuman:seconds=>seconds+'초',
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
  return {c,memory,server,requests,toasts,notifications,storageWrites,dialogs,prepared,setNow:value=>{clock=value;}};
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
  assert.deepEqual(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))),{v:2,timer:null});
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

test('countdown expiry shows one notice while elapsed continues; refresh does not repeat the alert',()=>{
  const {c,memory,setNow,notifications,storageWrites,dialogs}=harness({now:0});
  c.readingTimer=domain.setCountdown(domain.create({id:'expiry',userId:'reader',bookId:'emotion',startPage:32},0),60000,0);
  c.readingTimerRestoreOwner='reader';c.persistReadingTimer();
  setNow(180000);c.syncReadingTimer();
  assert.equal(c.readingSavePanelOpen,false);assert.equal(c.readingTimer.phase,'timer');
  assert.equal(c.readingTimerElapsedMs(),180000);assert.equal(c.readingTimer.running,true);
  assert.equal(notifications.length,1);assert.equal(notifications[0].durationSeconds,60);
  assert.equal(notifications[0].countdownId,c.readingTimer.countdownId);
  const dialog=dialogs.get('reading-countdown-ended');assert.equal(dialog.open,true);
  const saved=storageWrites.length;
  setNow(181000);c.syncReadingTimer();
  assert.equal(dialogs.get('reading-countdown-ended'),dialog);assert.equal(notifications.length,1);
  assert.equal(storageWrites.length,saved,'tick synchronization does not write again or cause cross-tab storage loops');
  const refreshed=harness({memory,now:900000});refreshed.c.syncReadingTimer();
  assert.equal(refreshed.c.readingSavePanelOpen,false);assert.equal(refreshed.c.readingTimerElapsedMs(),900000);
  assert.equal(refreshed.notifications.length,0);assert.equal(refreshed.dialogs.size,1,'unacknowledged notice survives refresh');
  refreshed.dialogs.get('reading-countdown-ended').confirm();
  assert.equal(refreshed.c.readingTimer.running,true);assert.equal(refreshed.c.readingTimer.countdownAcknowledged,true);
  assert.equal(refreshed.dialogs.size,0);
  refreshed.setNow(910000);refreshed.c.syncReadingTimer();
  assert.equal(refreshed.c.readingTimerElapsedMs(),910000);assert.equal(refreshed.dialogs.size,0);
  const acknowledged=harness({memory,now:920000});acknowledged.c.syncReadingTimer();
  assert.equal(acknowledged.dialogs.size,0);assert.equal(acknowledged.notifications.length,0);
  const newMemory=new Map();newMemory.set(c.readingTimerStorageKey('reader'),JSON.stringify({v:1,timer:domain.setCountdown(domain.create({id:'asleep',userId:'reader',bookId:'emotion',startPage:0},0),60000,0)}));
  const asleep=harness({memory:newMemory,now:900000});asleep.c.syncReadingTimer();
  assert.equal(asleep.c.readingSavePanelOpen,false);assert.equal(asleep.c.readingTimerElapsedMs(),900000);
  assert.equal(asleep.dialogs.size,1);assert.equal(asleep.notifications.length,1,'expiry while closed is delivered once on return');
});

test('countdown reset, cancellation and owner logout close an obsolete completion notice',()=>{
  const {c,setNow,dialogs,notifications}=harness({now:0});
  c.readingTimer=domain.setCountdown(domain.create({id:'reset',userId:'reader',bookId:'emotion'},0),1000,0);
  c.readingTimerRestoreOwner='reader';setNow(1000);c.syncReadingTimer();
  assert.equal(dialogs.size,1);
  const firstId=c.readingTimer.countdownId;
  c.readingTimer=domain.setCountdown(c.readingTimer,1000,1000);c.persistReadingTimer();c.syncReadingTimer();
  assert.equal(dialogs.size,0);assert.notEqual(c.readingTimer.countdownId,firstId);
  setNow(2000);c.syncReadingTimer();assert.equal(notifications.length,2);
  c.readingTimer=domain.clearCountdown(c.readingTimer,2000);c.persistReadingTimer();c.syncReadingTimer();
  assert.equal(dialogs.size,0);assert.equal(c.readingTimer.running,true);
  c.readingTimer=domain.setCountdown(c.readingTimer,1000,2000);setNow(3000);c.syncReadingTimer();
  assert.equal(dialogs.size,1);c.clearMemberSession();assert.equal(dialogs.size,0);
});

test('v1 migration creates an independent v2 session that survives old tabs overwriting or deleting v1',()=>{
  const memory=new Map(),first=harness({memory,now:2000});
  const oldTimer={id:'old-running',userId:'reader',bookId:'emotion',startPage:12,createdAt:0,startedAt:0,elapsedMs:0,running:true,targetMs:60000,goalReached:false,phase:'timer'};
  const oldKey=first.c.legacyReadingTimerStorageKey('reader'),newKey=first.c.readingTimerStorageKey('reader');
  const original=JSON.stringify({v:1,timer:oldTimer,finishKind:'finish',endPage:null,noteReturn:null});memory.set(oldKey,original);
  first.c.syncReadingTimer();
  assert.equal(first.c.readingTimer.id,'old-running');assert.equal(first.c.readingTimerElapsedMs(),2000);
  assert.equal(memory.get(oldKey),original,'migration never edits or deletes the old record');
  assert.equal(JSON.parse(memory.get(newKey)).v,2);
  memory.delete(oldKey);
  const next=harness({memory,now:65000});next.c.syncReadingTimer();
  assert.equal(next.c.readingTimerElapsedMs(),65000);assert.equal(next.c.readingTimer.running,true);
  assert.equal(next.c.readingTimer.goalReached,true);assert.equal(next.notifications.length,1);
  memory.set(oldKey,JSON.stringify({v:1,timer:null}));
  const third=harness({memory,now:67000});third.c.syncReadingTimer();
  assert.equal(third.c.readingTimer.id,'old-running');assert.equal(third.c.readingTimerElapsedMs(),67000);
  assert.equal(third.c.readingTimer.goalReached,true);assert.equal(third.notifications.length,0);
  third.c.readingTimer=null;third.c.persistReadingTimer();
  memory.set(oldKey,original);
  const finished=harness({memory,now:900000});finished.c.syncReadingTimer();
  assert.equal(finished.c.readingTimer,null,'a completed v2 marker prevents the old timer from returning');
  assert.equal(memory.get(oldKey),original);
});

test('v2 values are authoritative even when empty or unreadable and never revive a valid v1 timer',()=>{
  for(const value of ['not-json','',JSON.stringify({v:2,timer:null}),'null']){
    const {c,memory}=harness();
    const old=JSON.stringify({v:1,timer:domain.create({id:'old',userId:'reader',bookId:'emotion'},0)});
    memory.set(c.legacyReadingTimerStorageKey('reader'),old);memory.set(c.readingTimerStorageKey('reader'),value);
    c.syncReadingTimer();
    assert.equal(c.readingTimer,null);assert.equal(memory.get(c.readingTimerStorageKey('reader')),value);
    assert.equal(memory.get(c.legacyReadingTimerStorageKey('reader')),old);
  }
  const blank=harness();blank.c.syncReadingTimer();
  assert.deepEqual(JSON.parse(blank.memory.get(blank.c.readingTimerStorageKey('reader'))),{v:2,timer:null},'an empty first load records that migration already completed');
});

test('migrating a failed v1 save retains its immutable retry snapshot and does not duplicate a saved log',async()=>{
  const memory=new Map(),server={logs:{},meta:{}};
  const old=harness({memory,server,failMeta:1});old.prepared();
  assert.equal(await old.c.submitReadingLog('emotion',0,15,{}),false);
  const snapshot=clone(old.c.readingSaveAttempt),newKey=old.c.readingTimerStorageKey('reader'),oldKey=old.c.legacyReadingTimerStorageKey('reader');
  const envelope=JSON.parse(memory.get(newKey));envelope.v=1;
  memory.set(oldKey,JSON.stringify(envelope));memory.delete(newKey);
  const oldRaw=memory.get(oldKey),next=harness({memory,server,now:900000});next.c.syncReadingTimer();
  assert.deepEqual(clone(next.c.readingSaveAttempt),snapshot);assert.equal(next.c.readingTimerElapsedMs(),10000);
  assert.equal(next.c.readingTimer.phase,'save');assert.equal(next.c.readingTimer.running,false);
  assert.deepEqual(JSON.parse(memory.get(newKey)).attempt,snapshot);assert.equal(memory.get(oldKey),oldRaw);
  assert.equal(await next.c.submitReadingLog('emotion',0,99,{}),true);
  assert.equal(Object.keys(server.logs).length,1);assert.equal(server.meta.emotion_reader.current_page,15);
  const again=harness({memory,server,now:910000});again.c.syncReadingTimer();assert.equal(again.c.readingTimer,null);
});

test('explicit completion at countdown expiry keeps save phase and freezes the actual overrun for retry',async()=>{
  const {c,memory,setNow,dialogs,notifications,server}=harness({now:0,failMeta:1});
  c.readingTimer=domain.setCountdown(domain.create({id:'manual-done',userId:'reader',bookId:'emotion'},0),60000,0);
  c.readingTimerRestoreOwner='reader';setNow(75000);
  c.readingTimer=domain.pause(c.readingTimer,75000);c.readingTimer.phase='save';c.readingSavePanelOpen=true;
  c.persistReadingTimer();c.syncReadingTimer();
  assert.equal(dialogs.size,0);assert.equal(notifications.length,0);assert.equal(c.readingTimer.running,false);
  assert.equal(c.readingSavePanelOpen,true);assert.equal(c.readingTimer.countdownAcknowledged,true);
  assert.equal(await c.submitReadingLog('emotion',0,15,{}),false);
  assert.equal(c.readingSaveAttempt.seconds,75);
  const refreshed=harness({memory,server,now:900000});refreshed.c.syncReadingTimer();
  assert.equal(refreshed.c.readingSaveAttempt.seconds,75);assert.equal(refreshed.c.readingTimerElapsedMs(),75000);
  assert.equal(refreshed.dialogs.size,0);
  assert.equal(await refreshed.c.submitReadingLog('emotion',0,90,{}),true);
  assert.equal(server.logs['manual-done'].seconds,75);assert.equal(server.logs['manual-done'].page,15);
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

test('opening a note at countdown expiry and refreshing preserves the note handoff and excludes writing time',async()=>{
  const memory=new Map(),first=noteHarness({memory,now:61000});
  await first.c.openReadingNote('mine');
  first.c.syncReadingTimer();
  assert.equal(first.c.readingTimer.goalReached,true);assert.equal(first.c.readingTimer.running,false);
  assert.equal(first.c.readingTimer.phase,'timer');assert.equal(first.c.readingSavePanelOpen,false);
  assert.equal(first.notifications.length,1);assert.equal(first.c.readingNoteReturn.type,'mine');
  const second=noteHarness({memory,now:900000});second.c.readingTimerRestoreOwner=null;second.c.syncReadingTimer();
  assert.equal(second.c.readingNoteReturn.type,'mine');assert.equal(second.c.readingTimerElapsedMs(),61000);
  assert.equal(second.notifications.length,0);
  assert.equal(second.c.completeReadingNote('mine','emotion'),true);
  assert.equal(second.c.readingTimer.running,true);assert.equal(second.c.readingTimer.goalReached,true);
  second.setNow(902000);assert.equal(second.c.readingTimerElapsedMs(),63000);
  assert.equal(second.c.readingNoteReturn,null);
});

test('v1 migration preserves note handoff and the writing pause before returning to the timer',async()=>{
  const memory=new Map(),first=noteHarness({memory,now:5000});await first.c.openReadingNote('share');
  const newKey=first.c.readingTimerStorageKey('reader'),oldKey=first.c.legacyReadingTimerStorageKey('reader');
  const envelope=JSON.parse(memory.get(newKey));envelope.v=1;memory.set(oldKey,JSON.stringify(envelope));memory.delete(newKey);
  const next=noteHarness({memory,now:900000});next.c.readingTimerRestoreOwner=null;next.c.syncReadingTimer();
  assert.deepEqual(clone(next.c.readingNoteReturn),envelope.noteReturn);assert.equal(next.c.readingTimerElapsedMs(),5000);
  assert.equal(next.c.readingTimer.running,false);assert.deepEqual(JSON.parse(memory.get(newKey)).noteReturn,envelope.noteReturn);
  assert.equal(next.c.completeReadingNote('share','emotion'),true);next.setNow(901000);
  assert.equal(next.c.readingTimerElapsedMs(),6000);assert.equal(next.c.readingTimer.running,true);
});

test('notification permission is requested only by the explicit button; countdown and resume only prepare audio',async()=>{
  const {c}=harness({now:0});
  const elements=new Map();
  function control(id,value){
    const handlers={};const el={id,value,disabled:false,textContent:'',
      addEventListener:(event,handler)=>{handlers[event]=handler;},setAttribute(){},click:()=>handlers.click()};
    elements.set(id,el);return el;
  }
  const settings=control('btn-reading-notifications'),label=control('reading-notification-status');
  const countdown=control('btn-reading-countdown-save'),pause=control('btn-reading-toggle-pause');
  control('reading-countdown-hours','0');control('reading-countdown-minutes','1');
  elements.set('app',{querySelectorAll:()=>[]});
  c.document={getElementById:id=>elements.get(id)||null,_readingLifecycleBound:true};
  c.setInterval=()=>1;
  let permission='default',requested=0,prepared=0;
  c.GrowellTimerAlerts={prepare(){prepared++;return Promise.resolve();},
    notificationStatus:()=>({supported:true,permission,enabled:permission==='granted',label:permission==='granted'?'알림 켜짐':'알림 선택 가능'}),
    enableNotifications(){requested++;permission='granted';return Promise.resolve(this.notificationStatus());}};
  vm.runInContext(section('function readingCountdownHtml(', 'function submitWorksheet('),c);
  c.readingTimer=domain.create({id:'gesture',userId:'reader',bookId:'emotion'},0);c.readingTimerRestoreOwner='reader';
  c.bindReadingTimerEvents();
  assert.equal(requested,0);assert.equal(prepared,0);
  countdown.click();assert.equal(requested,0);assert.equal(prepared,1);
  pause.click();pause.click();assert.equal(requested,0);assert.equal(prepared,2);
  settings.click();await tick();assert.equal(requested,1);
  assert.equal(settings.disabled,true);assert.equal(settings.textContent,'휴대폰 알림 켜짐');assert.equal(label.textContent,'알림 켜짐');
  settings.click();assert.equal(requested,1,'already granted permission is not requested again');
  permission='denied';settings.click();assert.equal(requested,1,'denied permission is not requested again');
});
