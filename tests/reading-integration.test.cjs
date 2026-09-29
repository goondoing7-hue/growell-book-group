const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const domain=require('../readingTimerDomain.js');
const createPopupHistory=require('../popupHistory.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a,start);return html.slice(a,b);
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function historyDialogHarness(){
  const nodes=[],popups=new Map(),focus=[];
  const book={id:'emotion',title:'테스트 <책>',totalPages:200,accent:'primary'};
  const c={SESSION:{userId:'reader'},STATE:{readingLogs:{own:{id:'own',bookId:'emotion',userId:'reader',seconds:60,startPage:10,page:20,createdAt:1},other:{id:'other',bookId:'emotion',userId:'other',seconds:900,page:100,createdAt:2}},readingMeta:{emotion_reader:{currentPage:20}}},
    location:{hash:'#/book/emotion/mine'},bookById:id=>id===book.id?book:null,isBookLocked:()=>false,readingDataReady:()=>true,
    esc:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),fmtDate:()=> '2026.09.28',fmtElapsed:ms=>ms/1000+'초',fmtDurationHuman:seconds=>seconds+'초',
    svgIcon:value=>'<svg>'+value+'</svg>',I_CLOSE:'close',I_TRASH:'trash',I_DOC:'history',I_CHECK:'check',confirm:()=>true,
    GrowellPopupHistory:{open:(key,value)=>popups.set(key,value),closed:key=>popups.delete(key)},
    document:{activeElement:null,body:{appendChild(node){nodes.push(node);}},createElement(){
      const handlers={},body={innerHTML:'',scrollTop:0},count={textContent:''};
      return {open:false,removed:false,innerHTML:'',setAttribute(){},querySelector(selector){return selector==='[data-reading-history-body]'?body:count;},
        addEventListener:(name,handler)=>{handlers[name]=handler;},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;},
        fire:(name,event)=>handlers[name](event),body,count};
    }},saveState(mutate,options){mutate(c.STATE);options.onSuccess();return Promise.resolve(true);}};
  vm.createContext(c);
  vm.runInContext(section('function myReadingLogs(bookId){','function saveCurrentPage('),c);
  vm.runInContext(section('function deleteReadingLog(','function readingTimerElapsedMs('),c);
  vm.runInContext(section('function readingHistoryHtml(','function readingCardHtml('),c);
  const trigger={isConnected:true,focus:options=>focus.push(options)};
  return {c,nodes,popups,trigger,focus,book};
}

test('reading history icon opens an owner-only popup and Back restores the same space',()=>{
  const {c,nodes,popups,trigger,focus,book}=historyDialogHarness();
  c.openReadingHistoryDialog(book.id,trigger);
  const node=nodes[0];assert.equal(node.open,true);assert.match(node.innerHTML,/테스트 &lt;책&gt;/);
  assert.match(node.body.innerHTML,/p10-p20/);assert.doesNotMatch(node.body.innerHTML,/900초|data-del-reading-log="other"/);
  assert.equal(node.count.textContent,'1회 · 총 60초');
  popups.get('reading-history').close();
  assert.equal(node.open,false);assert.equal(node.removed,true);assert.equal(c.location.hash,'#/book/emotion/mine');
  assert.equal(focus.length,1);assert.equal(focus[0].preventScroll,true);
});

test('deleting history preserves the popup scroll and saved page, and cannot delete another reader log',async()=>{
  const {c,nodes,trigger}=historyDialogHarness();c.openReadingHistoryDialog('emotion',trigger);
  const node=nodes[0];node.body.scrollTop=172;
  await c.deleteReadingLog('other',null);assert.ok(c.STATE.readingLogs.other);
  await c.deleteReadingLog('own',null);
  assert.equal(node.open,true);assert.equal(nodes.length,1);assert.equal(node.body.scrollTop,172);
  assert.match(node.body.innerHTML,/아직 읽은 기록이 없어요/);assert.equal(node.count.textContent,'0회 · 총 0초');
  assert.equal(c.STATE.readingMeta.emotion_reader.currentPage,20);
  assert.equal(c.location.hash,'#/book/emotion/mine');
});

test('history popup closes on account or route change and the summary never expands inline',()=>{
  for(const change of [c=>{c.SESSION={userId:'other'};},c=>{c.SESSION=null;},c=>{c.location.hash='#/book/emotion/share';}]){
    const {c,nodes,book}=historyDialogHarness();c.openReadingHistoryDialog(book.id);
    change(c);c.refreshReadingHistoryDialog();assert.equal(nodes[0].open,false);assert.equal(c.readingHistoryDialog,null);
  }
  const {c,book}=historyDialogHarness();c.myCurrentPage=()=>20;
  vm.runInContext(section('function readingStatusKey(book){','function myReadingLogs(bookId){'),c);
  const summary=c.readingStatusPanelHtml(book);
  assert.match(summary,/aria-haspopup="dialog"/);assert.match(summary,/aria-label="읽은 기록 보기 \(1회\)"/);
  assert.doesNotMatch(summary,/reading-toggle-row|reading-log-list/);
  c.readingHistoryOpenFor=book.id;assert.equal(c.readingStatusBodyHtml(book),'');
});

test('compact My Space card keeps timer and history beside progress and page editing in the status row',()=>{
  const {c,book}=historyDialogHarness();
  Object.assign(c,{myCurrentPage:()=>20,readingNoteReturn:false,readingTimer:null,readingSavePanelOpen:false,readingEditOpenFor:null,
    I_TIMER:'timer',I_EDIT:'edit',GrowellBookDetails:{coverHtml:()=>'<img alt="책 표지">',hintHtml:()=>'<span>읽는 부분: 첫 장</span>'}});
  vm.runInContext(section('function readingStatusKey(book){','function myReadingLogs(bookId){'),c);
  vm.runInContext(section('function readingCardHtml(', '/* ---------------- 습관 만들기(전용 탭)'),c);
  const markup=c.readingCardHtml(book);
  assert.match(markup,/p\. 20 \/ 200/);assert.match(markup,/10%/);assert.match(markup,/aria-valuenow="10"/);
  const actions=markup.slice(markup.indexOf('class="reading-card-actions"'),markup.indexOf('<div class="reading-split-right">'));
  for(const id of ['btn-reading-start','btn-reading-history-toggle']){
    assert.ok(actions.includes('id="'+id+'"'));
  }
  assert.doesNotMatch(actions,/btn-reading-edit-open/);
  const statusRow=markup.slice(markup.indexOf('<div class="reading-split-right">'));
  assert.match(statusRow,/읽는 중[\s\S]*총 읽은 시간[\s\S]*id="btn-reading-edit-open"/);
  assert.doesNotMatch(markup,/reading-card-footer/);
  for(const id of ['btn-reading-start','btn-reading-edit-open','btn-reading-history-toggle'])assert.equal((markup.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
  assert.match(markup.slice(markup.indexOf('<div class="reading-split-right">')),/읽는 중[\s\S]*총 읽은 시간/);
  assert.doesNotMatch(markup,/노트 작성|reading-log-list|reading-toggle-row/);
  for(const state of [{running:true},{running:false},{running:false,save:true},{running:false,note:true}]){
    c.readingTimer={id:'same-reading',bookId:book.id,running:state.running};
    c.readingSavePanelOpen=!!state.save;c.readingNoteReturn=state.note?{type:'mine'}:null;c.mineComposerOpenFor=book.id;
    const active=c.readingCardHtml(book);
    assert.match(active,/reading-compact-card/);assert.match(active,/aria-label="타이머로 돌아가기"/);
    assert.doesNotMatch(active,/reading-timer-card|reading-save-card|reading-note-paused|노트 작성/);
    assert.match(active,/p\. 20 \/ 200/);
  }
});

let timerSequence=0;
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
    // These independent habit popups stay closed during reading-route tests.
    habitValueSummaryDialog:null,habitValueGuideDialog:null,
    location:{hash:'#/book/emotion/mine'},document,
    localStorage:{getItem:key=>memory.has(key)?memory.get(key):null,setItem:(key,value)=>{storageWrites.push({key,value});memory.set(key,value);},removeItem:key=>memory.delete(key)},
    sessionStorage:{setItem(){}},urlFromPhoto:()=>null,render(){},showToast:(...args)=>toasts.push(args),
    bookById:id=>books.find(book=>book.id===id),isBookLocked:()=>false,
    myCurrentPage:()=>0,uid:()=> 'rl-test-'+(++timerSequence),esc:value=>String(value),fmtDurationHuman:seconds=>seconds+'초',
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
  for(const id of ['btn-reading-toggle-pause','btn-reading-done','btn-reading-cancel','btn-reading-save-back']){
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

test('switching shared books parks the previous timer and restores each original ID paused without counting time away',()=>{
  const memory=new Map(),first=harness({memory,now:0}),{c}=first;
  c.location.hash='#/';c.startReading('emotion');const emotionId=c.readingTimer.id;
  c.readingTimer=domain.setCountdown(c.readingTimer,60000,0);c.readingEndPage=14;c.persistReadingTimer();
  first.setNow(5000);c.location.hash='#/book/thought/mine';c.startReading('thought');const thoughtId=c.readingTimer.id;
  assert.notEqual(thoughtId,emotionId);assert.equal(c.readingTimer.bookId,'thought');assert.equal(c.readingTimer.running,true);
  const emotion=c.readingParkedSessions.emotion;
  assert.equal(emotion.timer.id,emotionId);assert.equal(emotion.timer.running,false);assert.equal(emotion.timer.elapsedMs,5000);
  assert.equal(emotion.returnView,'home');assert.equal(emotion.endPage,14);assert.equal(emotion.timer.targetMs,60000);
  assert.equal(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))).parked.emotion.timer.elapsedMs,5000);
  first.setNow(7000);c.startReading('emotion');
  assert.equal(c.readingTimer.id,emotionId);assert.equal(c.readingTimer.running,false);assert.equal(c.readingTimerElapsedMs(),5000);
  assert.equal(c.readingEndPage,14);assert.equal(c.readingParkedSessions.thought.timer.elapsedMs,2000);
  const restored=harness({memory,now:36000000});restored.c.syncReadingTimer();
  assert.equal(restored.c.readingTimerElapsedMs(),5000);assert.equal(restored.c.readingTimer.running,false);
  const events=timerBrowserEvents(restored);events.buttons.get('btn-reading-toggle-pause').click();
  restored.setNow(36001000);assert.equal(restored.c.readingTimerElapsedMs(),6000);
  restored.c.startReading('thought');
  assert.equal(restored.c.readingTimer.id,thoughtId);assert.equal(restored.c.readingTimer.running,false);assert.equal(restored.c.readingTimerElapsedMs(),2000);
  assert.equal(restored.c.readingParkedSessions.emotion.timer.elapsedMs,6000);
});

test('a completed second book leaves the first book pending and each immutable save attempt can finish without resurrection',async()=>{
  const memory=new Map(),server={logs:{},meta:{}},first=harness({memory,server,now:10000,failMeta:1}),{c}=first;
  first.prepared({id:'pending-emotion',elapsedMs:10000,startPage:10});c.readingHomeReturn=true;c.readingFinishKind='complete';c.readingEndPage=300;c.persistReadingTimer();
  assert.equal(await c.submitReadingLog('emotion',0,300,{}),false);
  const attempt=clone(c.readingSaveAttempt);
  c.startReading('thought');const thoughtId=c.readingTimer.id;
  assert.deepEqual(clone(c.readingParkedSessions.emotion.attempt),attempt);assert.equal(c.readingParkedSessions.emotion.finishKind,'complete');
  first.setNow(15000);c.readingTimer=domain.pause(c.readingTimer,15000);c.readingTimer.phase='save';c.readingSavePanelOpen=true;c.persistReadingTimer();
  assert.equal(await c.submitReadingLog('thought',0,8,{}),true);
  const afterSecond=JSON.parse(memory.get(c.readingTimerStorageKey('reader')));
  assert.equal(afterSecond.timer,null);assert.equal(afterSecond.parked.emotion.attempt.id,'pending-emotion');assert.equal(afterSecond.parked.thought,undefined);
  const next=harness({memory,server,now:36000000});next.c.syncReadingTimer();next.c.startReading('emotion');
  assert.equal(next.c.readingTimer.running,false);assert.equal(next.c.readingSavePanelOpen,true);assert.equal(next.c.readingFinishKind,'complete');assert.equal(next.c.readingEndPage,300);
  assert.deepEqual(clone(next.c.readingSaveAttempt),attempt);assert.equal(await next.c.submitReadingLog('emotion',0,20,{}),true);
  assert.equal(Object.keys(server.logs).length,2);assert.equal(server.logs['pending-emotion'].page,300);assert.equal(server.logs[thoughtId].seconds,5);
  assert.deepEqual(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))),{v:3,timer:null});
  next.c.startReading('thought');assert.notEqual(next.c.readingTimer.id,thoughtId);assert.equal(next.c.readingTimerElapsedMs(),0);
});

test('an atomic book switch rolls back on quota failure and the previous running or parked sessions remain recoverable',()=>{
  const fixture=harness({now:0}),{c,memory}=fixture;c.startReading('emotion');const originalId=c.readingTimer.id;
  fixture.setNow(5000);const key=c.readingTimerStorageKey('reader'),raw=memory.get(key),write=c.localStorage.setItem;
  c.localStorage.setItem=()=>{throw new Error('quota');};c.startReading('thought');
  assert.equal(memory.get(key),raw);assert.equal(c.readingTimer.id,originalId);assert.equal(c.readingTimer.running,true);assert.deepEqual(clone(c.readingParkedSessions),{});
  c.localStorage.setItem=write;c.startReading('thought');const thoughtId=c.readingTimer.id,switched=memory.get(key);
  fixture.setNow(8000);c.localStorage.setItem=()=>{throw new Error('quota');};c.startReading('emotion');
  assert.equal(memory.get(key),switched);assert.equal(c.readingTimer.id,thoughtId);assert.equal(c.readingTimer.running,true);assert.equal(c.readingParkedSessions.emotion.timer.id,originalId);
  c.localStorage.setItem=write;c.startReading('emotion');
  assert.equal(c.readingTimer.id,originalId);assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(c.readingParkedSessions.thought.timer.elapsedMs,3000);
});

test('a stale tab cannot discard parked books or revive the old active book after a newer switch or cancellation',()=>{
  const memory=new Map(),first=harness({memory,now:0});first.c.startReading('emotion');
  const sleeping=harness({memory,now:0});sleeping.c.syncReadingTimer();const sleepingEvents=timerBrowserEvents(sleeping);
  first.setNow(5000);first.c.startReading('thought');const key=first.c.readingTimerStorageKey('reader'),raw=memory.get(key);
  sleeping.setNow(1000000);sleepingEvents.windowEvents.pagehide();
  assert.equal(memory.get(key),raw);assert.equal(sleeping.c.readingTimer.bookId,'thought');assert.equal(sleeping.c.readingParkedSessions.emotion.timer.elapsedMs,5000);
  const events=timerBrowserEvents(first);events.buttons.get('btn-reading-cancel').click();const cancelled=memory.get(key);
  sleepingEvents.windowEvents.pagehide();assert.equal(memory.get(key),cancelled);assert.equal(sleeping.c.readingTimer,null);
  sleeping.c.startReading('emotion');assert.equal(sleeping.c.readingTimerElapsedMs(),5000);assert.equal(sleeping.c.readingTimer.running,false);
});

test('corrupt or foreign parked sessions prevent writes instead of being silently dropped',()=>{
  const active=domain.create({id:'active',userId:'reader',bookId:'thought'},0);
  const valid={timer:domain.create({id:'parked',userId:'reader',bookId:'emotion',running:false,elapsedMs:5000},0),attempt:null,endPage:null,noteReturn:null,returnView:'home'};
  const invalid=[null,[],{emotion:{bad:true}},{emotion:{...valid,timer:{...valid.timer,userId:'other'}}},
    {emotion:{...valid,timer:{...valid.timer,running:true,startedAt:0}}},{missing:valid},
    {emotion:{...valid,attempt:{id:'unrecoverable-save'}}},{emotion:{...valid,noteReturn:{type:'mine'}}}];
  for(const parked of invalid){
    const fixture=harness(),{c,memory}=fixture,key=c.readingTimerStorageKey('reader'),raw=JSON.stringify({v:3,timer:active,parked});memory.set(key,raw);
    c.syncReadingTimer();assert.equal(c.readingTimerStorageWritable,false);c.startReading('emotion');c.persistReadingTimer();
    assert.equal(memory.get(key),raw);assert.equal(c.pauseSharedReadingForArchive('reader'),false);
  }
});

test('v2 migration preserves the newest timer and old v2 tabs cannot erase the new parked records',()=>{
  const memory=new Map(),first=harness({memory,now:5000}),{c}=first;
  const oldKey=c.previousReadingTimerStorageKey('reader'),ancientKey=c.legacyReadingTimerStorageKey('reader'),key=c.readingTimerStorageKey('reader');
  const old=JSON.stringify({v:2,timer:domain.create({id:'v2-current',userId:'reader',bookId:'emotion',startPage:20},0),endPage:24,returnView:'home'});
  memory.set(oldKey,old);memory.set(ancientKey,JSON.stringify({v:1,timer:domain.create({id:'v1-old',userId:'reader',bookId:'thought'},0)}));
  c.syncReadingTimer();assert.equal(c.readingTimer.id,'v2-current');assert.equal(c.readingEndPage,24);assert.equal(JSON.parse(memory.get(key)).v,3);assert.equal(memory.get(oldKey),old);
  c.startReading('thought');const latest=memory.get(key);memory.set(oldKey,JSON.stringify({v:2,timer:null}));
  const next=harness({memory,now:10000});next.c.syncReadingTimer();assert.equal(next.c.readingTimer.bookId,'thought');assert.equal(next.c.readingParkedSessions.emotion.timer.id,'v2-current');assert.equal(memory.get(key),latest);
  for(const invalid of ['', 'null', 'not-json']){
    const damaged=new Map([[oldKey,invalid],[ancientKey,old]]),safe=harness({memory:damaged});safe.c.syncReadingTimer();safe.c.startReading('emotion');
    assert.equal(safe.c.readingTimer,null);assert.equal(damaged.get(oldKey),invalid);assert.equal(damaged.has(key),false,'damaged newer legacy storage never falls back to a stale timer');
  }
});

test('parked sessions stay owner-scoped even if persistence occurs immediately after an account change',()=>{
  const fixture=harness({now:0}),{c,memory}=fixture;c.startReading('emotion');fixture.setNow(1000);c.startReading('thought');
  const readerKey=c.readingTimerStorageKey('reader'),readerRaw=memory.get(readerKey);
  c.SESSION={userId:'other',name:'다른 회원'};assert.equal(c.persistReadingTimer(),false);
  assert.equal(memory.get(readerKey),readerRaw);assert.equal(memory.has(c.readingTimerStorageKey('other')),false);
  c.syncReadingTimer();assert.equal(c.readingTimer,null);assert.deepEqual(clone(c.readingParkedSessions),{});
  c.SESSION={userId:'reader',name:'독서회원'};c.syncReadingTimer();assert.equal(c.readingTimer.bookId,'thought');assert.equal(c.readingParkedSessions.emotion.timer.elapsedMs,1000);
});

test('archive start pauses shared reading durably while wrong owners, in-flight saves, and failed storage cannot start another timer',()=>{
  const fixture=harness({now:0}),{c,memory}=fixture;c.startReading('emotion');fixture.setNow(5000);
  const key=c.readingTimerStorageKey('reader'),before=memory.get(key);
  assert.equal(c.pauseSharedReadingForArchive('other'),false);assert.equal(memory.get(key),before);
  c.readingSaveBusy=true;assert.equal(c.pauseSharedReadingForArchive('reader'),false);c.startReading('thought');assert.equal(c.readingTimer.bookId,'emotion');c.readingSaveBusy=false;
  const write=c.localStorage.setItem;c.localStorage.setItem=()=>{throw new Error('quota');};
  assert.equal(c.pauseSharedReadingForArchive('reader'),false);assert.equal(c.readingTimer.running,true);assert.equal(memory.get(key),before);
  c.localStorage.setItem=write;assert.equal(c.pauseSharedReadingForArchive('reader'),true);
  assert.equal(c.readingTimer.running,false);assert.equal(c.readingTimerElapsedMs(),5000);
  fixture.setNow(36000000);assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(JSON.parse(memory.get(key)).timer.elapsedMs,5000);
});

test('every shared resume path pauses archive timers first and a failed archive pause leaves shared reading stopped',async()=>{
  const fixture=harness({now:0}),{c}=fixture,calls=[];let allowed=false;
  c.GrowellArchiveTimer={pauseOthers:owner=>{calls.push(owner);return allowed;}};
  c.startReading('emotion');assert.equal(c.readingTimer,null);allowed=true;c.startReading('emotion');assert.equal(c.readingTimer.running,true);
  const events=timerBrowserEvents(fixture);events.buttons.get('btn-reading-toggle-pause').click();assert.equal(c.readingTimer.running,false);
  allowed=false;events.buttons.get('btn-reading-toggle-pause').click();assert.equal(c.readingTimer.running,false);
  allowed=true;events.buttons.get('btn-reading-toggle-pause').click();assert.equal(c.readingTimer.running,true);
  events.buttons.get('btn-reading-done').click();allowed=false;events.buttons.get('btn-reading-save-back').click();assert.equal(c.readingTimer.phase,'save');
  allowed=true;events.buttons.get('btn-reading-save-back').click();assert.equal(c.readingTimer.running,true);assert.ok(calls.length>=6);assert.ok(calls.every(owner=>owner==='reader'));
  const notes=noteHarness({now:5000});notes.c.GrowellArchiveTimer={pauseOthers:()=>allowed};await notes.c.openReadingNote('mine');
  allowed=false;assert.equal(notes.c.completeReadingNote('mine','emotion'),false);assert.equal(notes.c.readingTimer.running,false);assert.ok(notes.c.readingNoteReturn);
  allowed=true;assert.equal(notes.c.completeReadingNote('mine','emotion'),true);assert.equal(notes.c.readingTimer.running,true);assert.equal(notes.c.readingTimerElapsedMs(),5000);
});

test('real archive and shared controllers alternate without overlapping elapsed time or changing saved reading totals',()=>{
  const archiveTimer=require('../archiveTimer.js'),memory=new Map(),fixture=harness({memory,now:0}),{c}=fixture;
  let now=0;const advance=value=>{now=value;fixture.setNow(value);};
  const storage=c.localStorage;Object.defineProperty(storage,'length',{get:()=>memory.size});storage.key=index=>Array.from(memory.keys())[index]||null;
  c.GrowellArchiveTimer={pauseOthers:owner=>archiveTimer.pauseOthers(owner,undefined,{storage,now:()=>now})};
  c.startReading('emotion');advance(5000);
  const archive=archiveTimer.createController({ownerId:'reader',book:{id:'arc-synthetic',title:'개인 독서',currentPage:0,pageCount:200},storage,now:()=>now,
    adapter:{getOwnerId:()=>c.SESSION.userId,beforeStart:owner=>c.pauseSharedReadingForArchive(owner)}});
  assert.equal(c.readingTimer.running,false);assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(archive.state().timer.running,true);
  advance(9000);const events=timerBrowserEvents(fixture);events.buttons.get('btn-reading-toggle-pause').click();
  archive.poll();assert.equal(archive.state().timer.running,false);assert.equal(archive.elapsed(),4000);assert.equal(c.readingTimer.running,true);
  advance(12000);assert.equal(archive.resume(),true);assert.equal(c.readingTimer.running,false);assert.equal(c.readingTimerElapsedMs(),8000);
  advance(15000);c.startReading('thought');archive.poll();
  assert.equal(c.readingTimer.bookId,'thought');assert.equal(c.readingTimer.running,true);assert.equal(c.readingParkedSessions.emotion.timer.elapsedMs,8000);
  assert.equal(archive.state().timer.running,false);assert.equal(archive.elapsed(),7000);
  assert.deepEqual(clone(c.STATE.readingLogs),{});assert.deepEqual(clone(c.STATE.readingMeta),{},'only explicit completion updates saved shared totals');
});

test('switching books preserves a note handoff and countdown, and returning excludes the entire writing interval',async()=>{
  const memory=new Map(),first=noteHarness({memory,now:5000});first.c.readingHomeReturn=true;await first.c.openReadingNote('mine');
  const handoff=clone(first.c.readingNoteReturn),id=first.c.readingTimer.id;first.setNow(10000);first.c.startReading('thought');
  assert.deepEqual(clone(first.c.readingParkedSessions.emotion.noteReturn),handoff);assert.equal(first.c.readingParkedSessions.emotion.returnView,'home');
  const next=noteHarness({memory,now:36000000});next.c.readingTimerRestoreOwner=null;next.c.syncReadingTimer();next.c.startReading('emotion');
  assert.equal(next.c.readingTimer.id,id);assert.equal(next.c.readingTimer.running,false);assert.deepEqual(clone(next.c.readingNoteReturn),handoff);
  assert.equal(next.c.readingTimer.targetMs,60000);assert.equal(next.c.completeReadingNote('mine','emotion'),true);assert.equal(next.c.readingTimerElapsedMs(),5000);
});

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
  assert.deepEqual(JSON.parse(completed),{v:3,timer:null});assert.equal(Object.keys(server.logs).length,1);
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
  assert.equal(reconnected.c.readingTimer,null);assert.deepEqual(JSON.parse(memory.get(key)),{v:3,timer:null});
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
  assert.deepEqual(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))),{v:3,timer:null});
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

test('v1 migration creates an independent current session that survives old tabs overwriting or deleting v1',()=>{
  const memory=new Map(),first=harness({memory,now:2000});
  const oldTimer={id:'old-running',userId:'reader',bookId:'emotion',startPage:12,createdAt:0,startedAt:0,elapsedMs:0,running:true,targetMs:60000,goalReached:false,phase:'timer'};
  const oldKey=first.c.legacyReadingTimerStorageKey('reader'),newKey=first.c.readingTimerStorageKey('reader');
  const original=JSON.stringify({v:1,timer:oldTimer,finishKind:'finish',endPage:null,noteReturn:null});memory.set(oldKey,original);
  first.c.syncReadingTimer();
  assert.equal(first.c.readingTimer.id,'old-running');assert.equal(first.c.readingTimerElapsedMs(),2000);
  assert.equal(memory.get(oldKey),original,'migration never edits or deletes the old record');
  assert.equal(JSON.parse(memory.get(newKey)).v,3);
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

test('current storage values are authoritative even when empty or unreadable and never revive a valid v1 timer',()=>{
  for(const value of ['not-json','',JSON.stringify({v:3,timer:null}),'null']){
    const {c,memory}=harness();
    const old=JSON.stringify({v:1,timer:domain.create({id:'old',userId:'reader',bookId:'emotion'},0)});
    memory.set(c.legacyReadingTimerStorageKey('reader'),old);memory.set(c.readingTimerStorageKey('reader'),value);
    c.syncReadingTimer();
    assert.equal(c.readingTimer,null);assert.equal(memory.get(c.readingTimerStorageKey('reader')),value);
    assert.equal(memory.get(c.legacyReadingTimerStorageKey('reader')),old);
  }
  const blank=harness();blank.c.syncReadingTimer();
  assert.deepEqual(JSON.parse(blank.memory.get(blank.c.readingTimerStorageKey('reader'))),{v:3,timer:null},'an empty first load records that migration already completed');
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

test('My Space timer opens its original paused session in a popup and Back keeps the same space and pending save',async()=>{
  const fixture=harness({now:0}),{c,setNow,server,memory}=fixture,popups=new Map();
  c.GrowellPopupHistory={open:(key,options)=>popups.set(key,options),closed:key=>popups.delete(key)};
  c.startReading('emotion');const id=c.readingTimer.id;
  const events=timerBrowserEvents(fixture);
  setNow(5000);events.buttons.get('btn-reading-toggle-pause').click();
  assert.equal(c.readingTimer.running,false);c.closeReadingHomeDialog();setNow(3600000);
  c.startReading('emotion');
  assert.equal(c.readingTimer.id,id);assert.equal(c.readingTimerElapsedMs(),5000);assert.equal(c.readingTimer.running,false);
  assert.equal(c.readingHomeReturn,false);assert.equal(c.readingHomeDialogFor,id);assert.equal(c.location.hash,'#/book/emotion/mine');
  c.svgIcon=()=>'';c.I_CLOSE='close';
  c.readingCardHtml=(book,inDialog)=>{assert.equal(book.id,'emotion');assert.equal(inDialog,true);return c.readingSavePanelOpen?'<div data-save-view></div>':'<div data-timer-view></div>';};
  assert.match(c.readingHomeDialogHtml(c.currentRoute()),/타이머 닫고 나의 공간으로 돌아가기[\s\S]*data-timer-view/);
  const dialog=c.document.createElement('dialog');dialog.id='reading-home-dialog';c.document.body.appendChild(dialog);c.showReadingHomeDialog();
  popups.get('reading-home').close();assert.equal(dialog.open,false);assert.equal(c.location.hash,'#/book/emotion/mine');
  assert.equal(JSON.parse(memory.get(c.readingTimerStorageKey('reader'))).timer.id,id);
  c.startReading('emotion');c.showReadingHomeDialog();events.buttons.get('btn-reading-done').click();
  assert.match(c.readingHomeDialogHtml(c.currentRoute()),/data-save-view/);assert.equal(c.readingSavePanelOpen,true);
  popups.get('reading-home').close();assert.equal(c.readingTimer.phase,'save');assert.equal(c.readingTimerElapsedMs(),5000);
  c.startReading('emotion');c.showReadingHomeDialog();await c.submitReadingLog('emotion',0,25,null);
  assert.equal(c.location.hash,'#/book/emotion/mine');assert.equal(dialog.open,false);assert.equal(c.readingHomeDialogFor,null);assert.equal(c.readingTimer,null);
  assert.equal(server.logs[id].seconds,5);assert.equal(server.logs[id].page,25);
});

test('My Space timer popup leaves note writing visible and reopens only after returning from the note',async()=>{
  const {c}=noteHarness({now:5000});c.readingHomeReturn=false;c.readingHomeDialogFor=c.readingTimer.id;
  c.svgIcon=()=>'';c.I_CLOSE='close';c.readingCardHtml=()=>'<div data-timer-view></div>';
  await c.openReadingNote('mine');
  assert.equal(c.readingHomeDialogHtml(c.currentRoute()),'');assert.equal(c.readingHomeDialogFor,null);
  assert.equal(c.readingNoteReturn.type,'mine');assert.equal(c.readingTimer.running,false);
  assert.equal(c.completeReadingNote('mine','emotion'),true);
  assert.equal(c.location.hash,'#/book/emotion/mine');assert.match(c.readingHomeDialogHtml(c.currentRoute()),/data-timer-view/);
  c.location.hash='#/book/emotion/share';assert.equal(c.readingHomeDialogHtml(c.currentRoute()),'');
  c.location.hash='#/book/emotion/mine';assert.equal(c.readingHomeDialogHtml(c.currentRoute()),'');
});

test('closing a timer note popup by X, Escape or Back returns once to the original home or My Space timer',async()=>{
  for(const type of ['mine','share'])for(const fromHome of [false,true])for(const wasRunning of [false,true])for(const way of ['x','escape','back']){
    const {c,setNow}=noteHarness({now:5000}),popups=new Map(),handlers={},classes=new Set();
    if(!wasRunning)c.readingTimer=domain.pause(c.readingTimer,4000);
    const originalId=c.readingTimer.id,elapsed=wasRunning?5000:4000;
    c.readingHomeReturn=fromHome;c.location.hash=fromHome?'#/':'#/book/emotion/mine';
    await c.openReadingNote(type);
    assert.equal(c.readingTimer.running,false);assert.equal(c.readingNoteReturn.wasRunning,wasRunning);
    const node={open:false,scrollTop:0,getAttribute:name=>name==='data-composer-type'?type:null,
      querySelector:()=>null,contains:()=>false,showModal(){this.open=true;},close(){this.open=false;},
      addEventListener:(name,handler)=>{handlers[name]=handler;}};
    c.document.body.classList={add:name=>classes.add(name),remove:name=>classes.delete(name)};
    c.document.getElementById=id=>id==='space-composer-dialog'?node:null;
    c.GrowellPopupHistory={open:(key,options)=>popups.set(key,options),closed:key=>popups.delete(key)};
    vm.runInContext(section('var spaceComposerDialogPosition=', 'function closeStaleComposersForRoute('),c);
    let returned=0;const originalReturn=c.returnToReadingTimer;
    c.returnToReadingTimer=()=>{returned++;originalReturn();};
    c.showSpaceComposerDialog();assert.equal(node.open,true);setNow(100000);
    if(way==='escape'){let prevented=false;handlers.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);}
    else if(way==='back')popups.get('space-composer').close();
    else c.closeSpaceComposerDialog();
    assert.equal(returned,1);assert.equal(node.open,false);assert.equal(popups.has('space-composer'),false);
    assert.equal(c.location.hash,fromHome?'#/':'#/book/emotion/mine');
    assert.equal(c.readingTimer.id,originalId);assert.equal(c.readingHomeDialogFor,originalId);
    assert.equal(c.readingTimer.running,wasRunning);assert.equal(c.readingTimerElapsedMs(),elapsed);
    assert.equal(c.readingNoteReturn,null);assert.equal(type==='mine'?c.mineComposerOpenFor:c.shareComposerOpenFor,null);
    assert.deepEqual(clone(c.STATE.readingLogs),{});assert.deepEqual(clone(c.STATE.readingMeta),{});
    setNow(101000);assert.equal(c.readingTimerElapsedMs(),elapsed+(wasRunning?1000:0));
  }
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

test('saving a shared timer note retires its popup before the return route opens a timer, without a ghost Back stop',async()=>{
  for(const fromHome of [false,true])for(const wasRunning of [false,true]){
    const {c,setNow}=noteHarness({now:5000});
    c.mineComposerOpenFor=null;
    if(!wasRunning)c.readingTimer=domain.pause(c.readingTimer,4000);
    c.readingHomeReturn=fromHome;
    await c.openReadingNote('share');
    const timerId=c.readingTimer.id,elapsed=c.readingTimerElapsedMs();
    const listeners={},pending=[],history=[{url:'https://example.test/'+c.location.hash,state:null}];
    let index=0,depth=0,maxDepth=0;
    const location={
      get href(){return history[index].url;},
      get hash(){return new URL(this.href).hash;},
      set hash(hash){if(hash!==this.hash)browser.history.pushState(null,'','https://example.test/'+hash);}
    };
    const browser={location,addEventListener(name,callback){(listeners[name]||=[]).push(callback);},history:{
      get state(){return history[index].state;},
      replaceState(state,unused,url){history[index]={state,url};},
      pushState(state,unused,url){history.splice(index+1);history.push({state,url});index++;},
      go(delta){pending.push(delta);}
    }};
    function emit(name,event){(listeners[name]||[]).slice().forEach(callback=>callback(event));}
    function back(){
      browser.history.go(-1);let steps=0;
      while(pending.length){
        assert.ok(++steps<20,'retired history entries must settle');
        const target=index+pending.shift();if(target<0||target>=history.length)continue;
        const oldUrl=location.href;index=target;emit('popstate',{state:browser.history.state});
        if(oldUrl!==location.href)emit('hashchange',{});
      }
    }
    c.location=location;c.GrowellPopupHistory=createPopupHistory(browser);
    const nodes=new Map(),classes=new Set();
    function dialog(id,type){return {id,open:false,scrollTop:0,
      getAttribute:name=>name==='data-composer-type'?type:null,querySelector:()=>null,contains:()=>false,
      showModal(){this.open=true;},close(){this.open=false;},addEventListener(){}};}
    c.document.getElementById=id=>nodes.get(id)||null;
    c.document.body.classList={add:name=>classes.add(name),remove:name=>classes.delete(name)};
    vm.runInContext(section('var spaceComposerDialogPosition=', 'function closeStaleComposersForRoute('),c);
    nodes.set('space-composer-dialog',dialog('space-composer-dialog','share'));c.showSpaceComposerDialog();
    // Match render's order: replace the old composer, bind/show the timer, then
    // showSpaceComposerDialog cleans up the absent composer. Hash events are later.
    c.render=()=>{
      depth++;maxDepth=Math.max(maxDepth,depth);nodes.delete('space-composer-dialog');
      nodes.set('reading-home-dialog',dialog('reading-home-dialog'));
      c.showReadingHomeDialog();c.showSpaceComposerDialog();depth--;
    };
    setNow(100000);c.resetShareComposer();
    assert.equal(c.completeReadingNote('share','emotion'),true);c.render();
    emit('hashchange',{});
    assert.equal(maxDepth,1,'a retired composer callback must not re-enter the new timer render');
    assert.equal(location.hash,fromHome?'#/':'#/book/emotion/mine');
    assert.equal(nodes.get('reading-home-dialog').open,true);assert.equal(classes.size,0);
    assert.equal(c.readingTimer.id,timerId);assert.equal(c.readingTimer.running,wasRunning);
    assert.equal(c.readingTimerElapsedMs(),elapsed);assert.equal(c.readingNoteReturn,null);
    c.closeReadingHomeDialog();back();
    assert.equal(location.hash,'#/book/emotion/share','one Back after X must leave the returned timer screen');
    assert.equal(c.readingTimer.id,timerId);assert.equal(c.readingTimerElapsedMs(),elapsed);
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
