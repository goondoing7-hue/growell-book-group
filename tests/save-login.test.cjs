const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function section(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
function tick() { return new Promise(resolve => setImmediate(resolve)); }
function freshState() {
  return {users:{u1:{id:'u1',name:'회원',authUserId:'auth1'}}, posts:{}, comments:{}, privateEntries:{}, materialNotes:{}, worksheets:{}, readingLogs:{}, habits:{h1:{id:'h1',bookId:'emotion',userId:'u1',name:'읽기',checkedDates:[],createdAt:1}}, readingMeta:{}, bookLocks:{}, announcement:{next:{},reading:{}}};
}
function harness({read, write, signIn, signup} = {}) {
  const writes = [], reads = [], auth = [], toasts = [];
  const memory = new Map();
  const context = {
    console, Promise, Date, Uint8Array, atob, setTimeout,
    STATE:freshState(), SESSION:{userId:'u1',name:'회원',keyB64:'old'}, CURRENT_KEY:'cached',
    document:{querySelectorAll:()=>[]}, location:{hash:'#/login'},
    localStorage:{setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
    sessionStorage:{setItem(){}},
    showToast:(...args)=>toasts.push(args), render(){},
    esc:s=>String(s), urlFromPhoto:()=>null,
    deriveKey:()=>Promise.resolve('key'),keyToB64:()=>Promise.resolve('b64'),
    randomSaltHex:()=> 'salt', pendingSignupAvatar:null,
    callEdgeFunction:()=>signup ? signup() : Promise.resolve({__status:200,ok:true,profile:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2'}}),
    loginEmailFor:id=>id+'@growell.internal',
    currentRoute:()=>({view:'login'}),
    clearPrivateCryptoState(){},
    completePendingPrivateRecovery:()=>Promise.resolve(true),
    mapPrivateEntryRow:r=>({id:r.id,userId:r.user_id,data:r.data,iv:r.iv}),
    mapProfileRow:r=>({id:r.id,name:r.name,salt:r.pbkdf2_salt,authUserId:r.auth_user_id}),
    sb:{
      auth:{
        signInWithPassword:credentials=>{auth.push('signIn'); return signIn ? signIn(credentials) : Promise.resolve({data:{session:{}}});},
        signOut:()=>{auth.push('signOut');return Promise.resolve({error:null});}
      },
      from(table){
        let operation='select', payload, filters=[];
        const query = {
          select(){return query;}, eq(k,v){filters.push([k,v]);return query;}, maybeSingle(){return query;},
          insert(data){operation='insert';payload=data;return query;},
          update(data){operation='update';payload=data;return query;},
          delete(){operation='delete';return query;},
          upsert(data){operation='upsert';payload=data;return query;},
          then(yes,no){
            const request={table,operation,payload,filters};
            if(operation==='select'){
              reads.push(request);
              return Promise.resolve(read ? read(request) : {data:[],error:null}).then(yes,no);
            }
            writes.push(request);
            return Promise.resolve(write ? write(request) : {data:{id:filters.find(([key])=>key==='id')?.[1]},error:null}).then(yes,no);
          }
        };
        return query;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(section('function mapHabitRow(', '\nvar STATE ='), context);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'), context);
  vm.runInContext(section('function habitWithPendingChecks(', '/* ---------------- 나의 공간: 독서 진행률'), context);
  vm.runInContext(section('function doLogin(', '/* 계정 삭제'), context);
  vm.runInContext(section('function doSignup(', '/* 관리자 코드 승격'), context);
  return {context,writes,reads,auth,toasts,memory};
}

test('rapid different-day checks save in order, using the latest committed state', async()=>{
  const first = deferred();
  let count=0;
  const {context:c,writes} = harness({write:()=>++count===1 ? first.promise : {error:null}});
  const a=c.toggleHabitDate('h1','2026-09-19');
  const b=c.toggleHabitDate('h1','2026-09-20');
  const d=c.toggleHabitDate('h1','2026-09-21');
  await tick();
  assert.equal(writes.length,1);
  assert.deepEqual(Array.from(c.habitWithPendingChecks(c.STATE.habits.h1).checkedDates),['2026-09-19','2026-09-20','2026-09-21']);
  first.resolve({error:null});
  assert.deepEqual(await Promise.all([a,b,d]),[true,true,true]);
  assert.deepEqual(Array.from(c.STATE.habits.h1.checkedDates),['2026-09-19','2026-09-20','2026-09-21']);
  assert.match(c.habitSaveStatusHtml('h1'),/모든 체크가 저장/);
});

test('two rapid presses on the same day leave it unchecked', async()=>{
  const first=deferred(); let count=0;
  const {context:c}=harness({write:()=>++count===1 ? first.promise : {error:null}});
  const a=c.toggleHabitDate('h1','2026-09-21');
  const b=c.toggleHabitDate('h1','2026-09-21');
  first.resolve({error:null});
  assert.deepEqual(await Promise.all([a,b]),[true,true]);
  assert.deepEqual(Array.from(c.STATE.habits.h1.checkedDates),[]);
});

test('a failed check remains visible, offers retry, and preserves later successful days', async()=>{
  let fail=true;
  const {context:c}=harness({write:()=>fail ? (fail=false,{error:new Error('offline')}) : {error:null}});
  assert.equal(await c.toggleHabitDate('h1','2026-09-20'),false);
  assert.match(c.habitSaveStatusHtml('h1'),/다시 저장/);
  assert.deepEqual(Array.from(c.habitWithPendingChecks(c.STATE.habits.h1).checkedDates),['2026-09-20']);
  assert.equal(await c.toggleHabitDate('h1','2026-09-21'),true);
  await c.retryHabitChecks('h1');
  assert.deepEqual(Array.from(c.STATE.habits.h1.checkedDates),['2026-09-20','2026-09-21']);
  assert.match(c.habitSaveStatusHtml('h1'),/모든 체크가 저장/);
});

test('logout cancels queued changes and does not install an in-flight result into another session', async()=>{
  const blocked=deferred();
  const {context:c,writes,auth}=harness({write:()=>blocked.promise});
  const a=c.toggleHabitDate('h1','2026-09-20');
  const b=c.toggleHabitDate('h1','2026-09-21');
  await tick();
  const logout=c.doLogout();
  assert.equal(c.SESSION,null);
  assert.equal(c.CURRENT_KEY,null);
  assert.equal(await b,false);
  assert.equal(auth.includes('signOut'),false,'auth waits for the old request to settle');
  blocked.resolve({error:null});
  assert.equal(await a,false);
  await logout;
  assert.equal(writes.length,1);
  assert.equal(Object.keys(c.STATE.habits).length,0);
  assert.deepEqual(auth,['signOut']);
});

test('a collection loaded during a save is preserved when that save completes',async()=>{
  const blocked=deferred();
  const {context:c}=harness({write:()=>blocked.promise});
  const save=c.toggleHabitDate('h1','2026-09-21');
  await tick();
  c.STATE.privateEntries.pe={id:'pe',userId:'u1',iv:'iv',data:'loaded'};
  blocked.resolve({error:null});
  assert.equal(await save,true);
  assert.equal(c.STATE.privateEntries.pe.data,'loaded');
});

test('login fetches existing habits and private notes before welcoming the user', async()=>{
  let recoveryCalled=false;
  const {context:c,reads}=harness({read:r=>r.table==='profiles'
    ? {data:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2'}}
    : r.table==='habits' ? {data:[{id:'h2',user_id:'u2',checked_dates:['2026-09-20']}]}
    : {data:[{id:'p2',user_id:'u2',data:'cipher'}]}});
  c.completePendingPrivateRecovery=()=>{ recoveryCalled=true; assert.ok(c.STATE.habits.h2); assert.ok(c.STATE.privateEntries.p2); return Promise.resolve(false); };
  await c.doLogin(' member ','password',{});
  assert.equal(c.SESSION.userId,'u2');
  assert.equal(c.CURRENT_KEY,null);
  assert.equal(c.memberLoadState.habits,'ready');
  assert.ok(c.STATE.habits.h2);
  assert.equal(c.STATE.habits.h1,undefined);
  assert.equal(recoveryCalled,true);
  assert.ok(reads.some(r=>r.table==='habits' && r.filters.some(([k,v])=>k==='user_id' && v==='u2')));
});

test('failed member fetch is shown as a load error and does not erase existing records',async()=>{
  let offline=true;
  const {context:c}=harness({read:r=>r.table==='habits' && offline ? {data:null,error:new Error('offline')} : {data:[]}});
  assert.equal(await c.loadMemberData(),false);
  assert.ok(c.STATE.habits.h1);
  assert.match(c.memberDataStatusHtml('habits'),/다시 불러오기/);
  assert.doesNotMatch(c.memberDataStatusHtml('habits'),/아직 만든 습관이 없/);
  offline=false;
  assert.equal(await c.loadMemberData(),true);
  assert.equal(c.memberLoadState.habits,'ready');
});

test('logout during authentication cannot resurrect the cancelled login',async()=>{
  const blocked=deferred();
  const {context:c,auth}=harness({signIn:()=>blocked.promise});
  const login=c.doLogin('member','password',{});
  await tick();
  const logout=c.doLogout();
  blocked.resolve({data:{session:{}}});
  await Promise.all([login,logout]);
  assert.equal(c.SESSION,null);
  assert.deepEqual(auth,['signIn','signOut']);
});

test('private recovery compare-and-set uses the expected IV and reports remote conflicts',async()=>{
  const {context:c,writes}=harness({write:()=>({data:null,error:null})});
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',bookId:'emotion',iv:'old-iv',data:'old-cipher',createdAt:1};
  let failed=false;
  const ok=await c.saveState(next=>{ next.privateEntries.p1.data='new-cipher'; next.privateEntries.p1.iv='new-iv'; },{
    expectedPrivateEntries:{p1:'old-cipher'}, expectedPrivateIVs:{p1:'old-iv'}, onFailure:()=>{failed=true;}
  });
  assert.equal(ok,false);
  assert.equal(failed,true);
  assert.equal(c.STATE.privateEntries.p1.data,'old-cipher');
  assert.ok(writes[0].filters.some(([key,value])=>key==='iv' && value==='old-iv'));
  assert.equal(writes[0].filters.some(([key])=>key==='data'),false,'ciphertext is never placed in a potentially oversized filter URL');
});

test('private recovery updates a remotely discovered note without trying to insert its existing ID',async()=>{
  const {context:c,writes}=harness();
  const ok=await c.saveState(next=>{next.privateEntries.p2={id:'p2',userId:'u1',bookId:'emotion',iv:'new',data:'rewrapped',createdAt:1};},{
    expectedPrivateEntries:{p2:'remote-cipher'}, expectedPrivateIVs:{p2:'remote-iv'}
  });
  assert.equal(ok,true);
  assert.equal(writes[0].operation,'update');
  assert.ok(writes[0].filters.some(([key,value])=>key==='iv' && value==='remote-iv'));
  assert.equal(c.STATE.privateEntries.p2.data,'rewrapped');
});

test('private recovery rejects a stale local snapshot without issuing a remote write',async()=>{
  const {context:c,writes}=harness();
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',iv:'edited-iv',data:'edited-cipher'};
  const ok=await c.saveState(next=>{next.privateEntries.p1.data='rewrapped';},{expectedPrivateEntries:{p1:'old-cipher'}});
  assert.equal(ok,false);
  assert.equal(writes.length,0);
  assert.equal(c.STATE.privateEntries.p1.data,'edited-cipher');
});

test('partial CAS conversion retries from fresh remote rows while comparing the original local snapshot',async()=>{
  const remote={p1:{iv:'old-iv-1',data:'old-1'},p2:{iv:'old-iv-2',data:'old-2'}};
  let failSecond=true;
  const {context:c,writes}=harness({write:request=>{
    const id=request.filters.find(([key])=>key==='id')[1];
    const iv=request.filters.find(([key])=>key==='iv')[1];
    if(remote[id].iv!==iv) return {data:null,error:null};
    if(id==='p2' && failSecond){failSecond=false;return {error:new Error('offline')};}
    remote[id]={iv:request.payload.iv,data:request.payload.data};
    return {data:{id},error:null};
  }});
  for(const id of ['p1','p2']) c.STATE.privateEntries[id]={id,userId:'u1',bookId:'emotion',...remote[id]};
  const baseline={p1:'old-1',p2:'old-2'};
  assert.equal(await c.saveState(next=>{
    next.privateEntries.p1.iv='v1-1';next.privateEntries.p1.data='converted-1';
    next.privateEntries.p2.iv='v1-2';next.privateEntries.p2.data='converted-2';
  },{expectedPrivateEntries:baseline,expectedPrivateLocalData:baseline,expectedPrivateIVs:{p1:'old-iv-1',p2:'old-iv-2'}}),false);
  assert.equal(remote.p1.data,'converted-1');
  assert.equal(c.STATE.privateEntries.p1.data,'old-1');
  const expectedRemote={p1:remote.p1.data,p2:remote.p2.data};
  const remoteIVs={p1:remote.p1.iv,p2:remote.p2.iv};
  assert.equal(await c.saveState(next=>{
    next.privateEntries.p1.iv='v2-1';next.privateEntries.p1.data='retry-1';
    next.privateEntries.p2.iv='v2-2';next.privateEntries.p2.data='retry-2';
  },{expectedPrivateEntries:expectedRemote,expectedPrivateLocalData:baseline,expectedPrivateIVs:remoteIVs}),true);
  assert.equal(writes.length,4);
  assert.equal(c.STATE.privateEntries.p1.data,'retry-1');
  assert.equal(remote.p2.data,'retry-2');
});

test('conversion retry rejects a local edit made after the remote-read snapshot',async()=>{
  const {context:c,writes}=harness();
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',iv:'local-new-iv',data:'local-new'};
  const ok=await c.saveState(next=>{next.privateEntries.p1.data='converted';},{
    expectedPrivateEntries:{p1:'remote-new'},expectedPrivateIVs:{p1:'remote-new-iv'},expectedPrivateLocalData:{p1:'local-old'}
  });
  assert.equal(ok,false);
  assert.equal(writes.length,0);
  assert.equal(c.STATE.privateEntries.p1.data,'local-new');
});

test('conversion does not overwrite a locally created record absent at snapshot time',async()=>{
  const {context:c,writes}=harness();
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',iv:'local-iv',data:'local-added'};
  const ok=await c.saveState(next=>{next.privateEntries.p1.data='converted';},{
    expectedPrivateEntries:{p1:'remote'},expectedPrivateIVs:{p1:'remote-iv'},expectedPrivateLocalData:{}
  });
  assert.equal(ok,false);
  assert.equal(writes.length,0);
});

test('login recovery can await a queued save without waiting on its own auth promise',{timeout:1000},async()=>{
  const {context:c}=harness({read:r=>r.table==='profiles'
    ? {data:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2'}}
    : r.table==='private_entries' ? {data:[{id:'p2',user_id:'u2',data:'old',iv:'old-iv'}]} : {data:[]}});
  c.completePendingPrivateRecovery=()=>c.saveState(next=>{next.privateEntries.p2.data='recovered';next.privateEntries.p2.iv='new-iv';},{render:false});
  await c.doLogin('member','password',{});
  assert.equal(c.STATE.privateEntries.p2.data,'recovered');
});

test('signup clears the old cached key and member data before establishing the new session',async()=>{
  const {context:c}=harness();
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',data:'old'};
  await c.doSignup('새 회원','newuser','password','password','hint','',null,{});
  assert.equal(c.SESSION.userId,'u2');
  assert.equal(c.CURRENT_KEY,null);
  assert.equal(Object.keys(c.STATE.privateEntries).length,0);
  assert.equal(Object.keys(c.STATE.habits).length,0);
  assert.equal(c.memberLoadState.privateEntries,'ready');
});

test('logout during signup prevents its response from signing the user in later',async()=>{
  const blocked=deferred();
  const {context:c,auth}=harness({signup:()=>blocked.promise});
  const signup=c.doSignup('새 회원','newuser','password','password','hint','',null,{});
  await tick();
  const logout=c.doLogout();
  blocked.resolve({__status:200,ok:true,profile:{id:'u2',name:'새 회원',pbkdf2_salt:'salt'}});
  await Promise.all([signup,logout]);
  assert.equal(c.SESSION,null);
  assert.deepEqual(auth,['signOut']);
});
