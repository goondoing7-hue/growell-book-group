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
function harness({now=10000,owner='reader',memory=new Map(),server={logs:{},meta:{}},failMeta=0,loseResponse=0,beforeMeta,authSession,refreshError=null}={}){
  let clock=now,metaFailures=failMeta,lostResponses=loseResponse;
  const auth={session:authSession===undefined?{access_token:'synthetic-token',expires_at:1000000000000,user:{id:'auth-'+owner}}:authSession,refreshError,getCalls:0,refreshCalls:0};
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
    STATE:{users:{[owner]:{id:owner,name:'독서회원',authUserId:'auth-'+owner}},posts:{},comments:{},privateEntries:{},materialNotes:{},worksheets:{},habits:{},
      readingLogs:{},readingMeta:{},bookLocks:{},announcement:{next:{},reading:{}}},
    SESSION:{userId:owner,name:'독서회원',keyB64:'memory-only'},CURRENT_KEY:null,
    location:{hash:'#/book/emotion/mine'},document,
    localStorage:{getItem:key=>memory.has(key)?memory.get(key):null,setItem:(key,value)=>{storageWrites.push({key,value});memory.set(key,value);},removeItem:key=>memory.delete(key)},
    sessionStorage:{setItem(){}},urlFromPhoto:()=>null,render(){},showToast:(...args)=>toasts.push(args),
    bookById:id=>books.find(book=>book.id===id),isBookLocked:()=>false,
    myCurrentPage:()=>0,uid:()=> 'rl-test',esc:value=>String(value),fmtDurationHuman:seconds=>seconds+'초',
    sb:{auth:{
      getSession(){auth.getCalls++;return Promise.resolve({data:{session:auth.session},error:null});},
      refreshSession(){auth.refreshCalls++;return Promise.resolve({data:{session:auth.session},error:auth.refreshError});}
    },from(table){
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
  vm.runInContext(section('function currentRoute(){', "window.addEventListener('hashchange'"),c);
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
  return {c,memory,server,requests,toasts,notifications,storageWrites,dialogs,prepared,auth,setNow:value=>{clock=value;}};
}

function timerBrowserEvents(fixture){
  const {c}=fixture,buttons=new Map(),documentEvents={},windowEvents={};
  for(const id of ['btn-reading-toggle-pause','btn-reading-done','btn-reading-cancel']){
    const handlers={};buttons.set(id,{addEventListener:(event,handler)=>{handlers[event]=handler;},click:()=>handlers.click()});
  }
  const originalElement=c.document.getElementById;
  c.document.getElementById=id=>id==='app'?{querySelectorAll:()=>[]}:buttons.get(id)||originalElement(id);
  c.document.addEventListener=(event,handler)=>{documentEvents[event]=handler;};
  c.window={addEventListener:(event,handler)=>{windowEvents[event]=handler;}};
  c.setInterval=()=>1;c.confirm=()=>true;
  vm.runInContext(section('function readingCountdownHtml(', 'function submitWorksheet('),c);
  c.bindReadingTimerEvents();
  return {buttons,documentEvents,windowEvents};
}

test('a frozen tab cannot overwrite another tab pause on pagehide or count the hours away',()=>{
  const memory=new Map(),active=harness({memory,now:0});active.c.startReading('emotion');
  const sleeping=harness({memory,now:0});sleeping.c.syncReadingTimer();
  const events=timerBrowserEvents(sleeping);
  active.setNow(5000);active.c.readingTimer=domain.pause(active.c.readingTimer,5000);active.c.persistReadingTimer();
  const key=active.c.readingTimerStorageKey('reader'),paused=memory.get(key),writes=sleeping.storageWrites.length;
  sleeping.setNow(10*60*60*1000);events.windowEvents.pagehide();
  assert.equal(memory.get(key),paused,'late pagehide preserves the pause saved by the active tab');
  assert.equal(sleeping.c.readingTimer.running,false);assert.equal(sleeping.c.readingTimerElapsedMs(),5000);
  sleeping.c.document.hidden=true;events.documentEvents.visibilitychange();
  assert.equal(memory.get(key),paused);assert.equal(sleeping.storageWrites.length,writes,'unchanged lifecycle checkpoints do not write or echo storage events');
  const reopened=harness({memory,now:24*60*60*1000});reopened.c.syncReadingTimer();
  assert.equal(reopened.c.readingTimerElapsedMs(),5000);assert.equal(reopened.c.readingTimer.running,false);
});

test('returning to a frozen tab refreshes a pause before a stale pause button can resume it',()=>{
  const memory=new Map(),active=harness({memory,now:0});active.c.startReading('emotion');
  const sleeping=harness({memory,now:0});sleeping.c.syncReadingTimer();const events=timerBrowserEvents(sleeping);
  active.setNow(5000);active.c.readingTimer=domain.pause(active.c.readingTimer,5000);active.c.persistReadingTimer();
  const key=active.c.readingTimerStorageKey('reader'),paused=memory.get(key);
  sleeping.setNow(3600000);events.buttons.get('btn-reading-toggle-pause').click();
  assert.equal(memory.get(key),paused);assert.equal(sleeping.c.readingTimer.running,false);
  assert.equal(sleeping.c.readingTimerElapsedMs(),5000,'the stale click refreshes instead of toggling the newly paused state');
  events.buttons.get('btn-reading-toggle-pause').click();
  assert.equal(sleeping.c.readingTimer.running,true);assert.equal(sleeping.c.readingTimerElapsedMs(),5000);
  active.setNow(3601000);assert.equal(active.c.refreshReadingTimerFromStorage(),true);
  assert.equal(active.c.readingTimerElapsedMs(),6000,'a later intentional resume still works across tabs');
  sleeping.c.readingTimer=domain.pause(sleeping.c.readingTimer,3601000);sleeping.c.persistReadingTimer();
  active.c.document.hidden=false;const activeEvents=timerBrowserEvents(active);activeEvents.documentEvents.visibilitychange();
  assert.equal(active.c.readingTimer.running,false);assert.equal(active.c.readingTimerElapsedMs(),6000);
});

test('a saved timer stays completed when a sleeping tab later persists its old running session',async()=>{
  const memory=new Map(),server={logs:{},meta:{}},active=harness({memory,server,now:0});active.c.startReading('emotion');
  const sleeping=harness({memory,server,now:0});sleeping.c.syncReadingTimer();const events=timerBrowserEvents(sleeping);
  active.setNow(5000);active.c.readingTimer=domain.pause(active.c.readingTimer,5000);active.c.readingTimer.phase='save';active.c.readingSavePanelOpen=true;active.c.persistReadingTimer();
  assert.equal(await active.c.submitReadingLog('emotion',0,15,{}),true);
  const key=active.c.readingTimerStorageKey('reader'),completed=memory.get(key);
  sleeping.setNow(36000000);events.windowEvents.pagehide();
  assert.equal(memory.get(key),completed);assert.equal(sleeping.c.readingTimer,null);
  assert.deepEqual(JSON.parse(completed),{v:2,timer:null});assert.equal(Object.keys(server.logs).length,1);
});

test('a stale tab restores the other tab immutable failed attempt without replacing its time or page',async()=>{
  const memory=new Map(),server={logs:{},meta:{}},active=harness({memory,server,now:0,failMeta:1});active.c.startReading('emotion');
  const sleeping=harness({memory,server,now:0});sleeping.c.syncReadingTimer();const events=timerBrowserEvents(sleeping);
  active.setNow(5000);active.c.readingTimer=domain.pause(active.c.readingTimer,5000);active.c.readingTimer.phase='save';active.c.readingSavePanelOpen=true;active.c.persistReadingTimer();
  assert.equal(await active.c.submitReadingLog('emotion',0,15,{}),false);
  const frozen=clone(active.c.readingSaveAttempt),key=active.c.readingTimerStorageKey('reader'),pending=memory.get(key);
  sleeping.setNow(36000000);events.buttons.get('btn-reading-done').click();
  assert.equal(memory.get(key),pending);assert.deepEqual(clone(sleeping.c.readingSaveAttempt),frozen);
  assert.equal(sleeping.c.readingTimerElapsedMs(),5000);assert.equal(sleeping.c.readingSavePanelOpen,true);
  assert.equal(await sleeping.c.submitReadingLog('emotion',0,99,{}),true);
  assert.equal(Object.keys(server.logs).length,1);assert.equal(server.logs[frozen.id].seconds,5);assert.equal(server.logs[frozen.id].page,15);
});

test('lifecycle persistence preserves unreadable or wrong-owner stored timers after refresh',()=>{
  for(const raw of ['not-json','',JSON.stringify({v:2,timer:{bad:'record'}}),JSON.stringify({v:2,timer:domain.create({id:'other-timer',userId:'other',bookId:'emotion'},0)})]){
    const fixture=harness(),key=fixture.c.readingTimerStorageKey('reader');fixture.memory.set(key,raw);fixture.c.syncReadingTimer();
    const events=timerBrowserEvents(fixture);events.windowEvents.pagehide();fixture.c.document.hidden=true;events.documentEvents.visibilitychange();
    assert.equal(fixture.memory.get(key),raw);assert.equal(fixture.c.readingTimer,null);
  }
});

test('a long paused session survives missing auth and saves its exact frozen record after the same account reconnects',async()=>{
  const memory=new Map(),server={logs:{},meta:{}},pausedMs=35459000;
  const missing={name:'AuthSessionMissingError',status:400};
  const first=harness({memory,server,now:pausedMs,authSession:null,refreshError:missing});
  first.prepared({elapsedMs:pausedMs,startPage:50});first.c.persistReadingTimer();
  first.setNow(pausedMs+10*60*60*1000);
  assert.equal(first.c.readingTimerElapsedMs(),pausedMs,'ten hours away do not count after pausing');
  assert.equal(await first.c.submitReadingLog('emotion',0,50,{}),false);
  const frozen=clone(first.c.readingSaveAttempt),key=first.c.readingTimerStorageKey('reader');
  assert.equal(frozen.seconds,35459);assert.equal(frozen.page,50);assert.equal(first.c.readingSaveFailure,'login');
  assert.equal(first.requests.length,0,'no reading data is sent without a matching authenticated session');
  assert.deepEqual(JSON.parse(memory.get(key)).attempt,frozen);
  const other=harness({memory,server,owner:'another-member'});other.c.syncReadingTimer();
  assert.equal(other.c.readingTimer,null);assert.equal(other.c.readingSaveAttempt,null);
  const reconnected=harness({memory,server,now:pausedMs+24*60*60*1000});reconnected.c.syncReadingTimer();
  assert.equal(reconnected.c.readingTimerElapsedMs(),pausedMs);assert.deepEqual(clone(reconnected.c.readingSaveAttempt),frozen);
  assert.equal(await reconnected.c.submitReadingLog('emotion',0,70,{}),true);
  assert.equal(Object.keys(server.logs).length,1);assert.equal(server.logs[frozen.id].seconds,35459);
  assert.equal(server.logs[frozen.id].page,50);assert.equal(server.logs[frozen.id].created_at,frozen.createdAt);
  assert.equal(reconnected.c.readingTimer,null);assert.deepEqual(JSON.parse(memory.get(key)),{v:2,timer:null});
});

test('a preserved reading attempt is never submitted through a different authenticated account',async()=>{
  const wrongSession={access_token:'synthetic-other-token',expires_at:1000000000000,user:{id:'auth-other'}};
  const fixture=harness({authSession:wrongSession});fixture.prepared({elapsedMs:35459000,startPage:50});fixture.c.persistReadingTimer();
  assert.equal(await fixture.c.submitReadingLog('emotion',0,50,{}),false);
  assert.equal(fixture.requests.length,0);assert.equal(fixture.auth.refreshCalls,0);
  assert.equal(fixture.c.readingSaveFailure,'login');assert.equal(fixture.c.readingSaveAttempt.seconds,35459);
  assert.equal(fixture.c.readingTimer.userId,'reader');assert.equal(fixture.c.readingTimer.running,false);
});

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


test('home popup closes without stopping a timer and reopens the same session on home',()=>{
  const {c,dialogs,memory,setNow}=harness({now:0});
  c.location.hash='#/';c.startReading('emotion');
  const id=c.readingTimer.id;
  assert.equal(c.location.hash,'#/');assert.equal(c.readingHomeDialogFor,id);assert.equal(c.readingHomeReturn,true);
  c.readingCardHtml=(book,inDialog)=>{assert.equal(book.id,'emotion');assert.equal(inDialog,true);return '<div data-timer-fixture></div>';};
  c.svgIcon=()=>'';c.I_CLOSE='close';
  const markup=c.readingHomeDialogHtml({view:'home'});
  assert.match(markup,/^<dialog /);assert.match(markup,/aria-labelledby="reading-home-title"/);assert.match(markup,/data-reading-home-close/);
  const dialog=c.document.createElement('dialog');dialog.id='reading-home-dialog';c.document.body.appendChild(dialog);
  c.showReadingHomeDialog();assert.equal(dialog.open,true);
  setNow(5000);dialog.cancel();
  assert.equal(dialog.open,false);assert.equal(c.readingHomeDialogFor,null);assert.equal(c.readingTimer.running,true);assert.equal(c.readingTimerElapsedMs(),5000);
  assert.equal(c.location.hash,'#/');assert.equal(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))).timer.id,id);
  c.startReading('emotion');assert.equal(c.readingTimer.id,id);assert.equal(c.readingHomeDialogFor,id);
  assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(c.location.hash,'#/');
  c.location.hash='#/book/emotion/mine';
  assert.equal(c.readingHomeDialogHtml({view:'book',bookId:'emotion',tab:'mine'}),'');assert.equal(c.readingHomeDialogFor,null);
  c.startReading('emotion');assert.equal(c.location.hash,'#/book/emotion/mine');assert.equal(c.readingHomeReturn,false);
  assert.equal(c.readingTimer.id,id);assert.equal(dialogs.size,1);
});

test('home completion keeps its popup and paused retry state until save succeeds, then updates home progress',async()=>{
  const {c,prepared,server}=harness({failMeta:1});
  prepared({elapsedMs:70000,startPage:10});c.location.hash='#/';c.readingHomeReturn=true;c.readingHomeDialogFor=c.readingTimer.id;
  const dialog=c.document.createElement('dialog');dialog.id='reading-home-dialog';c.document.body.appendChild(dialog);dialog.showModal();
  await c.submitReadingLog('emotion',0,25,null);
  assert.equal(c.readingHomeDialogFor,c.readingTimer.id);assert.equal(dialog.open,true);assert.equal(c.readingSavePanelOpen,true);assert.equal(c.readingSaveError,true);
  assert.equal(c.location.hash,'#/');assert.equal(c.readingSaveAttempt.seconds,70);
  await c.submitReadingLog('emotion',0,25,null);
  assert.equal(c.location.hash,'#/');assert.equal(c.readingHomeDialogFor,null);assert.equal(dialog.open,false);assert.equal(c.readingTimer,null);
  assert.equal(c.STATE.readingMeta.emotion_reader.currentPage,25);assert.equal(Object.keys(server.logs).length,1);
});

test('home note handoff returns to the home popup after a matching saved note, including refresh',async()=>{
  for(const type of ['mine','share']){
    const memory=new Map(),first=noteHarness({memory,now:5000});
    first.c.readingHomeReturn=true;first.c.readingHomeDialogFor=first.c.readingTimer.id;first.c.location.hash='#/';
    await first.c.openReadingNote(type);
    assert.equal(first.c.location.hash,'#/book/emotion/'+type);assert.equal(first.c.readingTimer.running,false);
    assert.equal(JSON.parse(memory.get(first.c.readingTimerStorageKey('reader'))).returnView,'home');
    const next=noteHarness({memory,now:900000});next.c.readingTimerRestoreOwner=null;next.c.syncReadingTimer();
    assert.equal(next.c.readingHomeReturn,true);assert.equal(next.c.readingTimerElapsedMs(),5000);
    assert.equal(next.c.completeReadingNote(type,'emotion'),true);assert.equal(next.c.location.hash,'#/');
    assert.equal(next.c.readingHomeDialogFor,next.c.readingTimer.id);assert.equal(next.c.readingTimer.running,true);
    next.setNow(901000);assert.equal(next.c.readingTimerElapsedMs(),6000);
  }
});

test('home modal cannot expose an old owner or locked book and logout closes it without erasing the timer',()=>{
  const {c,memory}=harness({now:0});c.location.hash='#/';c.startReading('emotion');
  c.SESSION={userId:'other'};
  assert.equal(c.readingHomeDialogHtml({view:'home'}),'');assert.equal(c.readingHomeDialogFor,null);
  c.SESSION={userId:'reader'};c.readingHomeDialogFor=c.readingTimer.id;c.isBookLocked=()=>true;
  assert.equal(c.readingHomeDialogHtml({view:'home'}),'');assert.equal(c.readingHomeDialogFor,null);
  c.isBookLocked=()=>false;c.readingHomeDialogFor=c.readingTimer.id;
  const dialog=c.document.createElement('dialog');dialog.id='reading-home-dialog';c.document.body.appendChild(dialog);dialog.showModal();
  c.pauseReadingBeforeLogout();assert.equal(dialog.open,false);assert.equal(c.readingHomeDialogFor,null);assert.equal(c.readingHomeReturn,false);
  assert.equal(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))).timer.running,false);
});

test('popup Back callbacks close the home timer without stopping or losing a pending save',()=>{
  const {c,setNow}=harness({now:0}),popups=new Map();
  c.GrowellPopupHistory={open:(key,options)=>popups.set(key,options),closed:key=>popups.delete(key)};
  c.location.hash='#/';c.startReading('emotion');
  const timerId=c.readingTimer.id;
  const dialog=c.document.createElement('dialog');dialog.id='reading-home-dialog';c.document.body.appendChild(dialog);
  c.showReadingHomeDialog();setNow(5000);
  popups.get('reading-home').close();
  assert.equal(dialog.open,false);assert.equal(c.location.hash,'#/');
  assert.equal(c.readingTimer.id,timerId);assert.equal(c.readingTimer.running,true);assert.equal(c.readingTimerElapsedMs(),5000);
  c.readingTimer=domain.pause(c.readingTimer,5000);c.readingTimer.phase='save';c.readingSavePanelOpen=true;
  c.readingSaveAttempt={id:timerId,seconds:5,page:20};c.readingHomeDialogFor=timerId;c.showReadingHomeDialog();
  popups.get('reading-home').close();
  assert.equal(c.readingSaveAttempt.page,20);assert.equal(c.readingSavePanelOpen,true);assert.equal(c.readingTimer.running,false);
  c.startReading('emotion');c.showReadingHomeDialog();
  assert.equal(dialog.open,true);assert.equal(c.readingSaveAttempt.seconds,5);
});

test('Back from a completed countdown acknowledges only its notice while reading continues',()=>{
  const {c,dialogs,setNow}=harness({now:0}),popups=new Map();
  c.GrowellPopupHistory={open:(key,options)=>popups.set(key,options),closed:key=>popups.delete(key)};
  c.svgIcon=()=>'';c.I_CLOSE='close';c.location.hash='#/';c.startReading('emotion');
  c.readingTimer=domain.setCountdown(c.readingTimer,60000,0);
  setNow(60000);c.syncReadingTimer();
  assert.ok(popups.has('reading-home'));assert.ok(popups.has('reading-countdown-ended'));
  popups.get('reading-countdown-ended').close();
  assert.equal(dialogs.has('reading-countdown-ended'),false);assert.equal(c.readingTimer.countdownAcknowledged,true);
  setNow(65000);c.syncReadingTimer();
  assert.equal(dialogs.has('reading-countdown-ended'),false);assert.equal(c.readingTimerElapsedMs(),65000);
  assert.ok(popups.has('reading-home'));assert.equal(c.readingHomeDialogFor,c.readingTimer.id);
});

test('leaving My Space closes reading history and returning does not reopen it or change the active timer',()=>{
  const destinations=['#/book/emotion/share','#/book/emotion/worksheet','#/book/emotion/materials',
    '#/book/emotion/habit','#/book/thought/mine','#/book/body/mine','#/book/action/mine',
    '#/book/thought/share','#/','#/community','#/profile/edit','#/book/emotion/mine/post/example'];
  for(const destination of destinations){
    const {c}=harness({now:0}),events={};
    Object.assign(c,{shareComposerOpenFor:null,mineComposerOpenFor:null,materialsComposerOpenFor:null,
      habitFormOpenFor:null,habitHistoryOpenFor:null,window:{addEventListener:(name,handler)=>{events[name]=handler;}}});
    vm.runInContext(section('function closeStaleComposersForRoute(', '/* 나의 공간 독서 타이머'),c);
    vm.runInContext(section('function currentRoute(){', '/* 작성/수정 창이 열려 있는 동안'),c);
    c.startReading('emotion');const timer=c.readingTimer;
    c.readingHistoryOpenFor='emotion';
    c.location.hash=destination;events.hashchange();
    assert.equal(c.readingHistoryOpenFor,null,destination);
    assert.equal(c.readingTimer,timer,destination);assert.equal(timer.running,true);
    c.location.hash='#/book/emotion/mine';events.hashchange();
    assert.equal(c.readingHistoryOpenFor,null,'returning from '+destination);
    c.readingHistoryOpenFor='emotion';events.hashchange();c.render();
    assert.equal(c.readingHistoryOpenFor,'emotion','same-screen updates preserve the expanded list');
  }
});

test('a reading save finishing after navigation cannot reopen history on the next My Space visit',async()=>{
  for(const destination of ['#/book/emotion/share','#/book/emotion/materials','#/book/thought/mine','#/']){
    const pending=deferred(),{c,prepared}=harness({beforeMeta:()=>pending.promise}),events={};
    Object.assign(c,{shareComposerOpenFor:null,mineComposerOpenFor:null,materialsComposerOpenFor:null,
      habitFormOpenFor:null,habitHistoryOpenFor:null,window:{addEventListener:(name,handler)=>{events[name]=handler;}}});
    vm.runInContext(section('function closeStaleComposersForRoute(', '/* 나의 공간 독서 타이머'),c);
    vm.runInContext(section('function currentRoute(){', '/* 작성/수정 창이 열려 있는 동안'),c);
    prepared();c.readingHistoryOpenFor='emotion';
    const saved=c.submitReadingLog('emotion',0,15,{});await tick();
    c.location.hash=destination;events.hashchange();assert.equal(c.readingHistoryOpenFor,null);
    pending.resolve({error:null});assert.equal(await saved,true);
    assert.equal(c.readingHistoryOpenFor,null,'a late completion while at '+destination+' keeps the list collapsed');
    c.location.hash='#/book/emotion/mine';events.hashchange();
    assert.equal(c.readingHistoryOpenFor,null,'returning after the completed save stays collapsed');
  }
});

test('a home timer save keeps reading history collapsed until the reader opens it',async()=>{
  const {c,prepared}=harness();prepared();c.location.hash='#/';c.readingHomeReturn=true;
  assert.equal(await c.submitReadingLog('emotion',0,15,{}),true);
  assert.equal(c.readingHistoryOpenFor,null);assert.equal(c.location.hash,'#/');
});

test('leaving and returning before an earlier reading save finishes keeps the new visit collapsed',async()=>{
  for(const destination of ['#/book/emotion/share','#/book/emotion/materials','#/book/thought/mine']){
    const pending=deferred(),{c,prepared}=harness({beforeMeta:()=>pending.promise}),events={};
    Object.assign(c,{shareComposerOpenFor:null,mineComposerOpenFor:null,materialsComposerOpenFor:null,
      habitFormOpenFor:null,habitHistoryOpenFor:null,window:{addEventListener:(name,handler)=>{events[name]=handler;}}});
    vm.runInContext(section('function closeStaleComposersForRoute(', '/* 나의 공간 독서 타이머'),c);
    vm.runInContext(section('function currentRoute(){', '/* 작성/수정 창이 열려 있는 동안'),c);
    prepared();c.readingHistoryOpenFor='emotion';
    const saved=c.submitReadingLog('emotion',0,15,{});await tick();
    c.location.hash=destination;events.hashchange();
    c.location.hash='#/book/emotion/mine';events.hashchange();assert.equal(c.readingHistoryOpenFor,null);
    pending.resolve({error:null});assert.equal(await saved,true);
    assert.equal(c.readingHistoryOpenFor,null,'the response from the previous visit via '+destination+' cannot expand this visit');
    assert.equal(c.STATE.readingMeta.emotion_reader.currentPage,15,'the record still saves normally');
    assert.equal(c.readingTimer,null);
  }
});
