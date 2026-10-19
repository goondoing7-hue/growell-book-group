'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {MessageChannel}=require('node:worker_threads');
const Domain=require('../readingTimerDomain.js');
const State=require('../readingNotificationState.js');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

// Synthetic origin-local storage only. Requests run in serial transactions;
// writes are committed atomically, and an aborted transaction keeps old values.
function databaseHarness(){
  const databases=new Map(),audit=[];let tail=Promise.resolve(),failNext=false;
  const api={open(name,version){
    const request={};audit.push({type:'open',name,version});
    setImmediate(()=>{
      var existing=databases.get(name),oldVersion=existing?existing.version:0;
      if(existing&&version<oldVersion){request.error={name:'VersionError'};if(request.onerror)request.onerror();return;}
      if(!existing){existing={version:0,stores:new Map()};databases.set(name,existing);}
      var stores=existing.stores;
      request.result={
        objectStoreNames:{contains:key=>stores.has(key)},
        createObjectStore:key=>{if(!stores.has(key))stores.set(key,new Map());return {};},close(){},
        transaction(names,mode){
          const keys=Array.isArray(names)?names:[names],ops=[],tx={};
          const working=new Map();let stopped=false;
          function abort(){if(stopped)return;stopped=true;if(tx.onabort)tx.onabort();}
          tx.abort=abort;
          tx.objectStore=name=>{
            if(!keys.includes(name)||!stores.has(name))throw new Error('synthetic unknown object store');
            return {
              get(key){const result={};ops.push(()=>{result.result=clone(working.get(name).get(key));if(result.onsuccess)result.onsuccess();});return result;},
              put(value,key){ops.push(()=>working.get(name).set(key,clone(value)));return {};},
              delete(key){ops.push(()=>working.get(name).delete(key));return {};},
              getAll(){const result={};ops.push(()=>{result.result=clone([...working.get(name).values()]);if(result.onsuccess)result.onsuccess();});return result;},
              getAllKeys(){const result={};ops.push(()=>{result.result=[...working.get(name).keys()];if(result.onsuccess)result.onsuccess();});return result;}
            };
          };
          tail=tail.then(()=>new Promise(resolve=>setImmediate(()=>{
            for(const key of keys){if(!stores.has(key)){abort();resolve();return;}working.set(key,new Map([...stores.get(key)].map(([k,v])=>[k,clone(v)])));}
            try{
              for(let i=0;i<ops.length&&!stopped;i++)ops[i]();
              if(failNext){failNext=false;abort();}
              if(!stopped){if(mode==='readwrite')for(const key of keys)stores.set(key,working.get(key));if(tx.oncomplete)tx.oncomplete();}
            }catch(error){abort();}
            resolve();
          })));
          return tx;
        }
      };
      if(version>oldVersion&&request.onupgradeneeded)request.onupgradeneeded({oldVersion,newVersion:version});
      existing.version=version;
      if(request.onsuccess)request.onsuccess();
    });
    return request;
  }};
  return {api,databases,audit,failNextTransaction(){failNext=true;},dump(){return clone([...databases].map(([name,db])=>({name,version:db.version,stores:[...db.stores].map(([store,rows])=>[store,[...rows]])})));}};
}

function workerHarness(options={}){
  const database=options.database||databaseHarness(),events={},shown=[],opened=[],messages=[];
  let clock=options.now===undefined?10000:options.now,notificationClosed=0;
  const c={URL,Promise,Number,Math,JSON,Array,Map,Set,MessageChannel,setTimeout,clearTimeout,TextEncoder,crypto:require('node:crypto').webcrypto,
    Date:class extends Date{static now(){return clock;}},
    location:{origin:'https://growell-book.vercel.app'},
    indexedDB:options.noStorage?undefined:database.api,
    Notification:{maxActions:options.maxActions===undefined?2:options.maxActions},
    registration:{showNotification:async(title,settings)=>{if(options.showError)throw new Error('synthetic display unavailable');shown.push({title,settings:clone(settings)});}},
    addEventListener:(name,handler)=>{events[name]=handler;},skipWaiting:async()=>{},
    clients:{claim:async()=>{},matchAll:async()=>options.windows||[],openWindow:async url=>{opened.push(url);return {url};}},
    fetch:()=>{throw new Error('synthetic background controls cannot access a server or saved member records');}
  };
  c.self=c;
  c.importScripts=(...urls)=>{for(const url of urls){assert.equal(url,'/readingNotificationState.js');vm.runInContext(fs.readFileSync(path.join(__dirname,'..',url.slice(1)),'utf8'),c);}};
  Object.defineProperty(c,'localStorage',{get(){throw new Error('a background worker must not access window localStorage');}});
  vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8'),c);
  async function message(data,source='https://growell-book.vercel.app/#/'){
    let completion,response;
    events.message({data:clone(data),source:{url:source,id:'synthetic-client'},ports:[{postMessage:value=>{response=clone(value);messages.push(response);}}],waitUntil:promise=>{completion=promise;}});
    if(completion)await completion;
    return response;
  }
  async function click(data,action='pause'){
    let completion;events.notificationclick({action,notification:{data:clone(data),close(){notificationClosed++;}},waitUntil:promise=>{completion=promise;}});
    if(completion)await completion;
  }
  async function push(data){let completion;events.push({data:{json:()=>clone(data)},waitUntil:promise=>{completion=promise;}});if(completion)await completion;}
  return {c,database,events,shown,opened,messages,message,click,push,setNow:value=>{clock=value;},get closed(){return notificationClosed;}};
}

function snapshot(overrides={}){
  const timer=Domain.create({id:'rl-background-fixture',userId:'PRIVATE_MEMBER',bookId:'emotion',startPage:17},1000);
  return {ownerKey:State.hash('member:'+timer.userId),timerId:timer.id,bookId:timer.bookId,generation:'rn-'+'1'.repeat(32),baseRevision:State.hash('synthetic-original-revision'),clock:{elapsedMs:timer.elapsedMs,startedAt:timer.startedAt,running:timer.running,phase:timer.phase},blocked:'',...overrides};
}
async function request(h,operation,source){
  const response=await h.message({type:'growell-reading-state',request:operation},source);
  if(!response)return undefined;assert.equal(response.type,'growell-reading-state-result');return response.result;
}
const read=(h,identity)=>request(h,{type:'read',identity});
const notification=h=>clone(h.shown.at(-1).settings.data);
async function arm(h,value=snapshot(),expected=null,expectedActive=null,lease){
  const result=await request(h,{type:'arm',snapshot:value,expected,expectedActive,...(lease?{lease}:{})});assert.equal(result.ok,true,result.code);return result;
}

test('a closed page can pause, resume and finish entirely in the worker while saved records remain untouched',async()=>{
  const h=workerHarness(),value=snapshot();let current=await arm(h,value);
  assert.equal(current.displayed,true);assert.equal(h.shown[0].settings.actions[0].action,'pause');
  await h.click(notification(h),'pause');current=await read(h,current.head);
  assert.deepEqual(current.state.clock,{elapsedMs:9000,startedAt:null,running:false,phase:'timer'});
  assert.equal(current.state.journal.length,1);assert.equal(h.shown.at(-1).settings.actions[0].action,'resume');
  h.setNow(50000);await h.click(notification(h),'resume');current=await read(h,current.head);
  assert.deepEqual(current.state.clock,{elapsedMs:9000,startedAt:50000,running:true,phase:'timer'});
  h.setNow(55000);await h.click(notification(h),'finish');current=await read(h,current.head);
  assert.deepEqual(current.state.clock,{elapsedMs:14000,startedAt:null,running:false,phase:'save'});
  assert.deepEqual(current.state.journal.map(event=>[event.seq,event.action,event.at]),[[1,'pause',10000],[2,'resume',50000],[3,'finish',55000]]);
  assert.deepEqual(h.shown.at(-1).settings.actions,[{action:'save',title:'기록 저장'}]);
  assert.equal(h.opened.length,0,'control buttons must not focus or open the app');
  assert.equal(h.closed,3);assert.equal(h.shown.every(item=>item.settings.tag==='growell-reading-session'),true);
  assert.doesNotMatch(JSON.stringify(h.database.dump()),/PRIVATE_MEMBER|startPage|readingLogs|keyB64|access_token/);
});

test('duplicate and stale notification clicks are fenced by the durable revision even across concurrent events',async()=>{
  const h=workerHarness(),armed=await arm(h),original=notification(h);
  await Promise.all([h.click(original,'pause'),h.click(original,'pause')]);
  const current=await read(h,armed.head);assert.equal(current.state.seq,1);assert.equal(current.state.journal.length,1);assert.equal(h.shown.length,2);
  await h.click(original,'finish');assert.equal((await read(h,armed.head)).state.seq,1);assert.equal(h.opened.length,0);
  for(const invalid of [{...notification(h),generation:'rn-'+'2'.repeat(32)},{...notification(h),ownerKey:'t1-dead-beef'},{...notification(h),timerId:'rl-unrelated'},{...notification(h),bookId:'../../elsewhere'}])await h.click(invalid,'resume');
  assert.equal((await read(h,armed.head)).state.seq,1);assert.equal(h.shown.length,2);
});

test('a slow IndexedDB transaction freezes time at the notification click rather than its later commit',async()=>{
  const h=workerHarness(),armed=await arm(h),data=notification(h);
  const clicking=h.click(data,'pause');h.setNow(40000);await clicking;
  const current=await read(h,armed.head);
  assert.equal(current.state.clock.elapsedMs,9000,'storage latency must not be counted as time spent reading');
  assert.equal(current.state.journal[0].at,10000,'the journal keeps the user gesture time for later restoration');
});

test('worker termination and a next-day restart preserve every unacknowledged action without a five-minute expiry',async()=>{
  const database=databaseHarness(),first=workerHarness({database}),armed=await arm(first);
  await first.click(notification(first),'pause');first.setNow(20000);await first.click(notification(first),'resume');
  const before=(await read(first,armed.head)).state;
  const restarted=workerHarness({database,now:86400000+30000}),after=await read(restarted,armed.head);
  assert.deepEqual(after.state,before);assert.equal(after.state.journal.length,2);assert.equal(restarted.opened.length,0);
});

test('reads never consume actions; only an explicit bounded acknowledgement drops its committed prefix',async()=>{
  const h=workerHarness(),armed=await arm(h);await h.click(notification(h),'pause');h.setNow(20000);await h.click(notification(h),'resume');h.setNow(23000);await h.click(notification(h),'finish');
  const observed=await read(h,armed.head);assert.equal(observed.state.journal.length,3);
  assert.deepEqual((await read(h,armed.head)).state,observed.state,'a failed local-storage write needs to be able to read again');
  let result=await request(h,{type:'ack',identity:observed.head,throughSeq:2,committedRevision:State.hash('committed-prefix-two')});
  assert.equal(result.ok,true);assert.equal(result.state.ackSeq,2);assert.deepEqual(result.state.journal.map(event=>event.seq),[3]);
  const repeated=await request(h,{type:'ack',identity:observed.head,throughSeq:2,committedRevision:State.hash('committed-prefix-two')});assert.deepEqual(repeated.state,result.state);
  result=await request(h,{type:'ack',identity:observed.head,throughSeq:4,committedRevision:State.hash('invalid-future')});assert.equal(result.ok,false);assert.equal((await read(h,armed.head)).state.journal.length,1);
  result=await request(h,{type:'ack',identity:observed.head,throughSeq:3,committedRevision:State.hash('committed-all')});assert.equal(result.ok,true);assert.equal(result.state.journal.length,0);assert.equal(result.state.clock.phase,'save');
  const finalState=clone(result.state),late=await request(h,{type:'ack',identity:observed.head,throughSeq:2,committedRevision:State.hash('stale-prefix-must-not-return')});assert.deepEqual(late.state,finalState,'an old acknowledgement cannot change a later committed revision');
});

test('a delayed page arm cannot overwrite background edits, and app mutation leases fence notification control',async()=>{
  const h=workerHarness(),value=snapshot(),armed=await arm(h,value);await h.click(notification(h),'pause');
  const stale=await request(h,{type:'arm',snapshot:value,expected:armed.head,expectedActive:armed.active});assert.equal(stale.ok,false);
  let current=await read(h,armed.head);assert.equal(current.state.journal.length,1);assert.equal(current.state.clock.running,false);
  const stillPending=await request(h,{type:'arm',snapshot:value,expected:current.head,expectedActive:current.active});assert.equal(stillPending.ok,false);assert.equal(stillPending.code,'pending');
  current=await request(h,{type:'ack',identity:current.head,throughSeq:1,committedRevision:State.hash('local-paused')});
  const lease='rh-'+'3'.repeat(32),held=await request(h,{type:'hold',identity:current.head,expected:current.head,lease});assert.equal(held.ok,true);
  const before=await read(h,armed.head);await h.click({...held.head,kind:'growell-reading-session',version:2},'resume');assert.deepEqual((await read(h,armed.head)).state,before.state);
  const busy=await request(h,{type:'arm',snapshot:value,expected:held.head,expectedActive:held.active,lease:'rh-'+'4'.repeat(32)});assert.equal(busy.ok,false);assert.equal(busy.code,'held');
  await arm(h,{...value,clock:{elapsedMs:9000,startedAt:null,running:false,phase:'timer'}},held.head,held.active,lease);assert.equal(h.shown.at(-1).settings.actions[0].action,'resume');
});

test('a crashed page lease can be recovered after fifteen seconds without reviving an older lease or CAS token',async()=>{
  const h=workerHarness(),value=snapshot(),armed=await arm(h,value),leaseA='rh-'+'7'.repeat(32),leaseB='rh-'+'8'.repeat(32);
  const first=await request(h,{type:'hold',identity:armed.head,expected:armed.head,lease:leaseA});assert.equal(first.ok,true);
  h.setNow(24999);const early=await request(h,{type:'hold',identity:first.head,expected:first.head,lease:leaseB});assert.equal(early.ok,false);
  h.setNow(25000);const recovered=await request(h,{type:'hold',identity:first.head,expected:first.head,lease:leaseB});assert.equal(recovered.ok,true);
  h.setNow(40000);const staleArm=await request(h,{type:'arm',snapshot:value,expected:first.head,expectedActive:first.active,lease:leaseA});
  assert.equal(staleArm.ok,false,'lease expiry never makes a stale compare-and-swap token current again');
  const current=await read(h,recovered.head);assert.equal(current.state.held,leaseB);
  assert.notEqual(recovered.head.revision,first.head.revision,'different mutation leases need different durable revisions');
});

test('note, archive and save states expose safe app actions and cannot independently restart or finish',async()=>{
  for(const blocked of ['note','archive','save']){
    const h=workerHarness(),value=snapshot({blocked,clock:{elapsedMs:5000,startedAt:null,running:false,phase:blocked==='save'?'save':'timer'}}),armed=await arm(h,value),data=notification(h);
    assert.deepEqual(h.shown.at(-1).settings.actions.map(action=>action.action),[blocked==='save'?'save':'open']);
    await h.click(data,'resume');await h.click(data,'finish');const after=await read(h,armed.head);
    assert.equal(after.state.seq,0);assert.equal(after.state.journal.length,0);assert.equal(after.state.clock.running,false);assert.equal(h.opened.length,0);
    await h.click(data,blocked==='save'?'save':'open');assert.deepEqual(h.opened,['https://growell-book.vercel.app/#/book/emotion/mine']);
  }
});

test('another member or timer becomes active without old revocations or old actions changing that new session',async()=>{
  const h=workerHarness(),first=await arm(h),firstData=notification(h);await h.click(firstData,'pause');const old=await read(h,first.head);
  const otherValue=snapshot({ownerKey:State.hash('member:ANOTHER_PRIVATE_MEMBER'),timerId:'rl-other-member',generation:'rn-'+'5'.repeat(32),bookId:'thought'});
  const second=await arm(h,otherValue,null,old.active),nextData=notification(h);
  await request(h,{type:'revoke',identity:old.head});await h.click(firstData,'finish');assert.deepEqual((await read(h,second.head)).state,second.state);
  const former=await read(h,old.head);assert.equal(former.state.revoked,true);assert.equal(former.state.journal.length,1,'logout never discards an action not yet committed to the old timer');
  await h.click(nextData,'pause');assert.equal((await read(h,second.head)).state.seq,1);
});

test('logout freezes its running generation once and cannot revive or revoke a later generation of the same timer',async()=>{
  const h=workerHarness(),value=snapshot(),armed=await arm(h,value),data=notification(h);
  let revoked=await request(h,{type:'revoke',identity:armed.head,pause:true});assert.equal(revoked.ok,true);assert.equal(revoked.state.revoked,true);
  assert.deepEqual(revoked.state.clock,{elapsedMs:9000,startedAt:null,running:false,phase:'timer'});assert.deepEqual(revoked.state.journal.map(event=>[event.action,event.at]),[['pause',10000]]);
  h.setNow(50000);const repeated=await request(h,{type:'revoke',identity:armed.head,pause:true});assert.deepEqual(repeated.state,revoked.state);
  await h.click(data,'pause');assert.equal((await read(h,armed.head)).state.seq,1);
  revoked=await request(h,{type:'ack',identity:revoked.head,throughSeq:1,committedRevision:State.hash('logout-committed')});
  const revived=await request(h,{type:'arm',snapshot:value,expected:revoked.head,expectedActive:revoked.active});assert.equal(revived.ok,false);assert.equal(revived.code,'revoked');
  const next=await arm(h,{...value,generation:'rn-'+'6'.repeat(32),clock:{elapsedMs:9000,startedAt:null,running:false,phase:'timer'}},revoked.head,revoked.active);
  const oldRevoke=await request(h,{type:'revoke',identity:armed.head,pause:true});assert.equal(oldRevoke.ok,false);assert.deepEqual((await read(h,next.head)).state,next.state);
});

test('foreign windows and malformed requests cannot read or mutate durable timer metadata',async()=>{
  const h=workerHarness(),armed=await arm(h),before=h.database.dump();
  for(const source of ['https://evil.example/#/','https://growell-book.vercel.app/guide.html'])assert.equal(await request(h,{type:'read',identity:armed.head},source),undefined);
  for(const operation of [{type:'read',identity:{...armed.head,ownerKey:'raw-member-id'}},{type:'arm',snapshot:snapshot({bookId:'../../evil'})},{type:'action',identity:armed.head,action:'delete'},{type:'ack',identity:armed.head,throughSeq:-1,committedRevision:'raw'}]){
    const result=await request(h,operation);if(operation.type==='action')assert.equal(result,undefined,'messages cannot bypass the notification-click action handler');else assert.equal(result.ok,false);
  }
  assert.deepEqual(h.database.dump(),before);assert.equal(h.opened.length,0);
});

test('an IndexedDB abort preserves the old clock and the same valid click can be retried',async()=>{
  const h=workerHarness(),armed=await arm(h),data=notification(h),before=h.database.dump();
  h.database.failNextTransaction();await h.click(data,'pause');assert.deepEqual(h.database.dump(),before);assert.equal(h.shown.length,1);
  await h.click(data,'pause');assert.equal((await read(h,armed.head)).state.seq,1);assert.equal(h.opened.length,0);
  const unavailable=workerHarness({noStorage:true}),response=await request(unavailable,{type:'arm',snapshot:snapshot(),expected:null,expectedActive:null});assert.equal(response.ok,false);assert.equal(response.code,'storage');assert.equal(unavailable.shown.length,0);
});

test('an unreadable future state is preserved instead of being replaced by an older page snapshot',async()=>{
  const h=workerHarness(),value=snapshot(),armed=await arm(h,value);
  const stored=h.database.databases.get('growell-reading-notification-v1').stores.get('pending');
  const key='session:'+value.ownerKey+':'+value.timerId;
  stored.set(key,{...clone(armed.state),version:99,futureUnacknowledgedControl:'must-preserve'});
  const before=h.database.dump();
  const result=await request(h,{type:'arm',snapshot:value,expected:null,expectedActive:armed.active});
  assert.equal(result.ok,false,'a previous app version cannot interpret and replace newer state');
  assert.deepEqual(h.database.dump(),before);
});

test('a display failure after the durable commit never loses the background action or writes a member record',async()=>{
  const h=workerHarness(),armed=await arm(h),data=notification(h);h.c.registration.showNotification=async()=>{throw new Error('synthetic display failed');};
  await h.click(data,'pause');const current=await read(h,armed.head);assert.equal(current.state.clock.elapsedMs,9000);assert.equal(current.state.journal.length,1);assert.equal(current.state.seq,1);assert.equal(h.opened.length,0);
});

test('the timer worker keeps existing public push display and safe click routing independent of timer control',async()=>{
  const h=workerHarness();await h.push({version:1,type:'post',bookId:'thought',postId:'synthetic-post',tag:'synthetic-post',body:'MUST NOT BE DISPLAYED'});
  assert.equal(h.shown[0].title,'새로운 나눔');assert.doesNotMatch(h.shown[0].settings.body,/MUST NOT/);assert.equal(h.opened.length,0);
  await h.click(h.shown[0].settings.data,'');assert.deepEqual(h.opened,['https://growell-book.vercel.app/#/book/thought/share/post/synthetic-post']);
  await h.push({version:1,type:'verse',tag:'growell-verse-synthetic',body:'합성 말씀 · 합성 1:1'});assert.equal(h.shown[1].title,'오늘의 말씀');assert.equal(h.shown[1].settings.body,'합성 말씀 · 합성 1:1');
  await h.push({version:1,type:'post',bookId:'../../evil',postId:'synthetic-post',tag:'bad'});assert.equal(h.shown.length,2);
  assert.deepEqual(Object.keys(h.events).sort(),['activate','install','message','notificationclick','push']);
});

test('every timer notification uses the fixed public book title and cover without private draft metadata',async()=>{
  const books={emotion:'감정을 마주하면 길이 보인다',thought:'생각이 너무 많은 어른들을 위한 심리학',body:'몸이 나를 위로한다',action:'습관이 영성이다'};
  for(const [bookId,title] of Object.entries(books)){
    const h=workerHarness();await arm(h,snapshot({bookId,title:'PRIVATE_DRAFT_TITLE',icon:'https://untrusted.example/private-photo'}));
    const item=h.shown.at(-1);assert.equal(item.title,'독서 타이머');assert.equal(item.settings.body.split('\n')[0],title);assert.equal(item.settings.icon,'/covers/'+bookId+'.jpg');
    assert.equal(item.settings.actions[0].title,'일시정지');assert.equal(item.settings.requireInteraction,true);assert.equal(item.settings.silent,true);
    assert.doesNotMatch(JSON.stringify(item),/PRIVATE_DRAFT_TITLE|untrusted|PRIVATE_MEMBER|페이지|access_token/);
    assert.doesNotMatch(item.settings.body,/갱신|업데이트|시간.*다시/);
  }
});

test('three-action devices offer a note button while two-action and zero-action devices keep the body note gesture',async()=>{
  for(const maximum of [0,1,2,3,5]){
    const h=workerHarness({maxActions:maximum});await arm(h);
    const expected=[{action:'pause',title:'일시정지'},{action:'finish',title:'끝내기'},...(maximum>=3?[{action:'note',title:'기록하기'}]:[])].slice(0,maximum);
    assert.deepEqual(h.shown.at(-1).settings.actions,expected);assert.equal(notification(h).defaultAction,'note');
    if(maximum){await h.click(notification(h),'pause');assert.equal(h.shown.at(-1).settings.actions[0].title,'시작');}
  }
});

test('native note buttons and notification body taps durably pause at the click and remember whether reading was running',async()=>{
  for(const [maximum,action] of [[3,'note'],[2,''],[0,'']])for(const wasRunning of [true,false]){
    const h=workerHarness({maxActions:maximum}),armed=await arm(h,snapshot(wasRunning?{}:{clock:{elapsedMs:4000,startedAt:null,running:false,phase:'timer'}}));
    const clicking=h.click(notification(h),action);h.setNow(90000);await clicking;
    const current=await read(h,armed.head);assert.equal(current.state.clock.elapsedMs,wasRunning?9000:4000);assert.equal(current.state.clock.running,false);assert.equal(current.state.blocked,'note');
    assert.deepEqual(current.state.journal.map(event=>[event.action,event.at,event.wasRunning]),[['note',10000,wasRunning]]);
    assert.deepEqual(current.state.openIntent,{at:10000,action:'note',wasRunning});assert.equal(notification(h).defaultAction,'open');
    assert.deepEqual(h.opened,['https://growell-book.vercel.app/#/book/emotion/mine']);assert.equal(h.closed,1);
    await h.click(notification(h),'resume');assert.equal((await read(h,armed.head)).state.seq,1,'writing and choosing a destination cannot restart from the notification');
  }
});

test('a restarted worker preserves the note handoff until its clock is committed and its exact open intent is acknowledged',async()=>{
  const database=databaseHarness(),h=workerHarness({database}),armed=await arm(h);await h.click(notification(h),'');
  const restarted=workerHarness({database,now:20000});let current=await read(restarted,armed.head);
  assert.equal(current.state.journal[0].wasRunning,true);assert.equal(current.state.openIntent.action,'note');
  const pending=await request(restarted,{type:'arm',snapshot:snapshot(),expected:current.head,expectedActive:current.active});assert.equal(pending.code,'pending');
  current=await request(restarted,{type:'ack',identity:current.head,throughSeq:1,committedRevision:State.hash('note-clock-committed')});
  assert.equal(current.state.journal.length,0);assert.deepEqual(current.state.openIntent,{at:10000,action:'note',wasRunning:true});
  const wrong=await request(restarted,{type:'open-ack',identity:current.head,at:9999});assert.deepEqual(wrong.state.openIntent,current.state.openIntent);
  const ack=await request(restarted,{type:'open-ack',identity:current.head,at:10000});assert.equal(ack.ok,true);assert.equal(ack.state.openIntent,undefined);assert.equal(ack.state.blocked,'note');assert.equal(ack.state.clock.elapsedMs,9000);
  assert.equal(restarted.opened.length,0,'reading or acknowledging the journal alone never opens the app');
});

test('a failed note transaction never opens the app while a later display failure cannot discard a committed note',async()=>{
  const h=workerHarness(),armed=await arm(h),data=notification(h),before=h.database.dump();
  h.database.failNextTransaction();await h.click(data,'');assert.deepEqual(h.database.dump(),before);assert.equal(h.opened.length,0);assert.equal(h.closed,0);
  h.c.registration.showNotification=async()=>{throw new Error('synthetic rendering unavailable');};
  await h.click(data,'');const current=await read(h,armed.head);assert.equal(current.state.journal[0].action,'note');assert.equal(current.state.clock.elapsedMs,9000);assert.equal(current.state.openIntent.wasRunning,true);assert.equal(h.opened.length,1);
  await h.click(data,'note');assert.equal((await read(h,armed.head)).state.seq,1,'a stale body tap cannot create another note or another app window');assert.equal(h.opened.length,1);
});

test('note opens an existing app with its newly committed head and never navigates away from an existing draft',async()=>{
  const notices=[];let focused=0;
  const existing={url:'https://growell-book.vercel.app/#/book/thought/share',postMessage:value=>notices.push(clone(value)),focus:async()=>{focused++;}};
  const h=workerHarness({windows:[existing]}),armed=await arm(h);await h.click(notification(h),'');
  const current=await read(h,armed.head),opened=notices.find(item=>item.type==='growell-reading-open');assert.ok(opened);assert.deepEqual(opened.identity,State.head(current.state));assert.equal(opened.identity.seq,1);
  assert.equal(focused,1);assert.equal(h.opened.length,0);assert.equal(existing.url,'https://growell-book.vercel.app/#/book/thought/share');
  assert.equal(notices.some(item=>item.type==='growell-reading-changed'),true);
});

test('save body taps create only a save intent and page messages cannot forge native actions or open intents',async()=>{
  const h=workerHarness(),armed=await arm(h);await h.click(notification(h),'finish');let current=await read(h,armed.head);
  assert.equal(notification(h).defaultAction,'save');h.setNow(12000);await h.click(notification(h),'');current=await read(h,armed.head);
  assert.deepEqual(current.state.openIntent,{at:12000,action:'save'});assert.equal(current.state.clock.phase,'save');assert.equal(current.state.journal.length,1);assert.equal(current.state.journal[0].action,'finish');assert.equal(h.opened.length,1);
  const before=h.database.dump();for(const operation of [{type:'open-intent',identity:current.head,action:'open'},{type:'action',identity:current.head,action:'note'}])assert.equal(await request(h,operation),undefined);
  assert.deepEqual(h.database.dump(),before);assert.equal(h.opened.length,1);
  h.setNow(13000);await h.click(notification(h),'');current=await read(h,armed.head);assert.equal(current.state.openIntent.at,13000);
  const late=await request(h,{type:'open-ack',identity:current.head,at:12000});assert.equal(late.state.openIntent.at,13000,'an older page acknowledgement must preserve a newer tap');
});
