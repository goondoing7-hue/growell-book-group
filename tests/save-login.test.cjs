const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PasswordHint=require('../passwordHint.js');
const validHint={questionId:'first_school',answer:'테스트 학교'};

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
function harness({read, write, signIn, signup, signOutEvent} = {}) {
  const writes = [], reads = [], auth = [], toasts = [];
  const memory = new Map();
  const context = {
    console, Promise, Date, Uint8Array, atob, setTimeout, GrowellHabits:require('../habitDomain.js'),
    GrowellMemberAccess:require('../memberAccess.js'),GrowellProfile:require('../profile.js'),GrowellPasswordHint:PasswordHint,authMode:'signup',oauthMessage:'',
    oauthWatcherBound:false,oauthPending:null,authRestoreUserId:null,BOOTING:false,oauthBusy:false,
    STATE:freshState(), SESSION:{userId:'u1',name:'회원',keyB64:'old'}, CURRENT_KEY:'cached',
    document:{querySelectorAll:()=>[]}, location:{hash:'#/login'},
    localStorage:{setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
    sessionStorage:{setItem(){}},
    showToast:(...args)=>toasts.push(args), render(){},
    // The isolated persistence harness has no value-summary popup to refresh.
    refreshHabitValueSummary(){},
    esc:s=>String(s), urlFromPhoto:()=>null,
    deriveKey:()=>Promise.resolve('key'),keyToB64:()=>Promise.resolve('b64'),
    randomSaltHex:()=> 'salt', pendingSignupAvatar:null,
    callEdgeFunction:(name,body)=>signup ? signup(name,body) : Promise.resolve({__status:200,ok:true,profile:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2'}}),
    loginEmailFor:id=>id+'@growell.internal',
    currentRoute:()=>({view:'login'}),
    clearPrivateCryptoState(){},
    completePendingPrivateRecovery:()=>Promise.resolve(true),
    mapPrivateEntryRow:r=>({id:r.id,userId:r.user_id,data:r.data,iv:r.iv}),
    mapProfileRow:r=>({id:r.id,name:r.name,salt:r.pbkdf2_salt,authUserId:r.auth_user_id}),
    sb:{
      auth:{
        signInWithPassword:credentials=>{auth.push('signIn'); return signIn ? signIn(credentials) : Promise.resolve({data:{session:{}}});},
        signOut:()=>{auth.push('signOut');if(signOutEvent==='sync')context.authCallback('SIGNED_OUT',null);if(signOutEvent==='queued')setTimeout(()=>context.authCallback('SIGNED_OUT',null),0);return Promise.resolve({error:null});},
        onAuthStateChange(callback){context.authCallback=callback;}
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
  vm.runInContext(section('function readingMetaKey(', 'function mapProfileRow('), context);
  vm.runInContext(section('function mapReadingMetaRow(', 'function mapBookLockRow('), context);
  vm.runInContext(section('function mapHabitRow(', '\nvar STATE ='), context);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'), context);
  vm.runInContext(section('function habitWithPendingChecks(', '/* ---------------- 나의 공간: 독서 진행률'), context);
  vm.runInContext(section('function doLogin(', '/* 계정 삭제'), context);
  vm.runInContext(section('function doSignup(', '/* 관리자 코드 승격'), context);
  vm.runInContext(section('function bindOAuthAuthWatcher(', 'async function prepareOAuthMember('),context);
  if(signOutEvent)context.bindOAuthAuthWatcher();
  return {context,writes,reads,auth,toasts,memory};
}

test('announcement writes use the global row and require an active administrator at the database request',async()=>{
  for(const role of ['admin','member','deleted']){
    const {context:c,writes}=harness();
    c.STATE.users.u1.isAdmin=role!=='member';c.STATE.users.u1.isDeleted=role==='deleted';
    c.currentUser=()=>c.SESSION&&c.STATE.users[c.SESSION.userId];
    vm.runInContext(section('function canEditAnnouncement(){','function announcementEditFields(){'),c);
    c.STATE.announcement={next:{date:'이전 일정',note:'준비물'},reading:{bookId:'emotion',meetingNo:'2',range:'10쪽',note:'기존 메모'}};
    const saved=await c.saveState(next=>{next.announcement.next.date='9월 28일';next.announcement.next.place='교육관';});
    assert.equal(saved,role==='admin',role);
    if(role==='admin'){
      assert.equal(writes.length,1);assert.equal(writes[0].table,'announcement');
      assert.equal(writes[0].payload.book_id,'global');assert.equal(writes[0].payload.next_date,'9월 28일');
      assert.equal(writes[0].payload.next_note,'준비물');assert.equal(writes[0].payload.reading_note,'기존 메모');
    }else{assert.equal(writes.length,0);assert.equal(c.STATE.announcement.next.date,'이전 일정');}
  }
});

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

test('login fetches own habits, private notes, reading logs and progress before welcoming the user', async()=>{
  let recoveryCalled=false;
  const {context:c,reads}=harness({read:r=>r.table==='profiles'
    ? {data:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2',approval_status:'approved'}}
    : r.table==='habits' ? {data:[{id:'h2',user_id:'u2',checked_dates:['2026-09-20']}]}
    : r.table==='reading_logs' ? {data:[{id:'r2',book_id:'emotion',user_id:'u2',seconds:600,page:42,start_page:30,created_at:100}]}
    : r.table==='reading_meta' ? {data:[{book_id:'emotion',user_id:'u2',current_page:42,updated_at:100}]}
    : {data:[{id:'p2',user_id:'u2',data:'cipher'}]}});
  c.completePendingPrivateRecovery=()=>{ recoveryCalled=true; assert.ok(c.STATE.habits.h2); assert.ok(c.STATE.privateEntries.p2); assert.ok(c.STATE.readingLogs.r2); assert.equal(c.STATE.readingMeta.emotion_u2.currentPage,42); return Promise.resolve(false); };
  await c.doLogin(' member ','password',{});
  assert.equal(c.SESSION.userId,'u2');
  assert.equal(c.CURRENT_KEY,null);
  assert.equal(c.memberLoadState.habits,'ready');
  assert.ok(c.STATE.habits.h2);
  assert.equal(c.STATE.habits.h1,undefined);
  assert.equal(recoveryCalled,true);
  assert.ok(reads.some(r=>r.table==='habits' && r.filters.some(([k,v])=>k==='user_id' && v==='u2')));
  assert.ok(reads.some(r=>r.table==='reading_logs' && r.filters.some(([k,v])=>k==='user_id' && v==='u2')));
  assert.ok(reads.some(r=>r.table==='reading_meta' && r.filters.some(([k,v])=>k==='user_id' && v==='u2')));
  assert.equal(c.memberLoadState.readingLogs,'ready');assert.equal(c.memberLoadState.readingMeta,'ready');
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
    ? {data:{id:'u2',name:'새 회원',pbkdf2_salt:'salt',auth_user_id:'auth2',approval_status:'approved'}}
    : r.table==='private_entries' ? {data:[{id:'p2',user_id:'u2',data:'old',iv:'old-iv'}]} : {data:[]}});
  c.completePendingPrivateRecovery=()=>c.saveState(next=>{next.privateEntries.p2.data='recovered';next.privateEntries.p2.iv='new-iv';},{render:false});
  await c.doLogin('member','password',{});
  assert.equal(c.STATE.privateEntries.p2.data,'recovered');
});

test('signup clears old keys and member data and stays signed out pending administrator approval',async()=>{
  const {context:c,auth,reads}=harness();
  c.STATE.privateEntries.p1={id:'p1',userId:'u1',data:'old'};
  await c.doSignup('새 회원','newuser','password','password',validHint,'','data:image/png;base64,aGVsbG8=',{});
  assert.equal(c.SESSION,null);
  assert.equal(c.CURRENT_KEY,null);
  assert.equal(Object.keys(c.STATE.privateEntries).length,0);
  assert.equal(Object.keys(c.STATE.habits).length,0);
  assert.equal(c.memberLoadState.privateEntries,'idle');assert.deepEqual(auth,['signOut']);assert.equal(reads.length,0);
  assert.equal(c.oauthMessage,'');assert.equal(c.authMode,'signup-complete');
});

test('logout during signup prevents its response from signing the user in later',async()=>{
  const blocked=deferred();
  const {context:c,auth}=harness({signup:()=>blocked.promise});
  const signup=c.doSignup('새 회원','newuser','password','password',validHint,'','data:image/png;base64,aGVsbG8=',{});
  await tick();
  const logout=c.doLogout();
  blocked.resolve({__status:200,ok:true,profile:{id:'u2',name:'새 회원',pbkdf2_salt:'salt'}});
  await Promise.all([signup,logout]);
  assert.equal(c.SESSION,null);
  assert.deepEqual(auth,['signOut']);
});

test('signup rejects an unsafe supplied photo before sending a registration request',async()=>{
  for(const avatar of [false,{},'javascript:alert(1)','data:image/svg+xml;base64,PHN2Zy8+']){
    let called=false;const {context:c,toasts}=harness({signup:()=>{called=true;return Promise.resolve({});}});
    await c.doSignup('새 회원','newuser','password','password',validHint,'',avatar,{});
    assert.equal(called,false);assert.match(toasts[0][0],/프로필 사진/);assert.equal(c.SESSION.userId,'u1');
  }
});

test('signup without a photo sends only a bounded question-and-answer digest and remains pending',async()=>{
  for(const avatar of [null,undefined,'']){
    const requests=[],h=harness({signup:async(name,body)=>{requests.push({name,body});return {__status:200,ok:true,profile:{}};}});
    await h.context.doSignup('새 회원','newuser','password','password',validHint,'',avatar,{});
    assert.equal(requests.length,1);assert.equal(requests[0].body.avatarDataUrl,null);
    assert.equal(requests[0].body.pwHint,await PasswordHint.encode(validHint));assert.equal(requests[0].body.pwHint.length,69);
    assert.doesNotMatch(JSON.stringify(requests[0].body),/테스트 학교|first_school/);
    assert.equal(h.context.SESSION,null);assert.equal(h.context.authMode,'signup-complete');
  }
});
test('signup requires both a selected question and answer without a raw or legacy fallback',async()=>{
  for(const value of ['hint',{questionId:'',answer:'답'},{questionId:'first_school',answer:''},{questionId:'legacy',answer:'기존 힌트'}]){
    const requests=[],h=harness({signup:async()=>{requests.push(true);return {};}});
    await h.context.doSignup('새 회원','newuser','password','password',value,'',null,{});
    assert.equal(requests.length,0);assert.equal(h.context.SESSION.userId,'u1');assert.match(h.toasts[0][0],/질문|답/);
  }
});
test('intentional signup sign-out events do not cancel success feedback or advance the auth flow',async()=>{
  for(const signOutEvent of ['sync','queued']){
    const h=harness({signOutEvent}),c=h.context;
    await c.doSignup('새 회원','newuser','password','password',validHint,'',null,{});
    const flow=c.authFlowEpoch;await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(c.authFlowEpoch,flow);assert.equal(c.SESSION,null);assert.equal(c.authMode,'signup-complete');
    assert.equal(c.oauthMessage,'');
  }
});

test('signup changes to its completion screen only after server success and leaves failed forms intact',async()=>{
  for(const result of [{__status:200,ok:true,profile:{}},{__status:400,ok:false,error:'duplicate_id'}]){
    const pending=deferred(),started=deferred();
    const {context:c,toasts}=harness({signup:()=>{started.resolve();return pending.promise;}});
    let renders=0;c.render=()=>{renders++;};
    const avatar='data:image/png;base64,aGVsbG8=';c.pendingSignupAvatar=avatar;
    const button={},work=c.doSignup('새 회원','newuser','password','password',validHint,'',avatar,button);
    await started.promise;
    assert.equal(c.authMode,'signup');assert.equal(renders,0);assert.equal(button.disabled,true);
    pending.resolve(result);await work;
    if(result.ok){assert.equal(c.authMode,'signup-complete');assert.equal(renders,1);assert.equal(c.pendingSignupAvatar,null);}
    else{assert.equal(c.authMode,'signup');assert.equal(renders,0);assert.equal(c.pendingSignupAvatar,avatar);assert.equal(button.disabled,false);assert.match(toasts.at(-1)[0],/이미 사용 중/);}
  }
});
test('pending login sign-out events preserve the precise approval message and never unlock records',async()=>{
  for(const signOutEvent of ['sync','queued']){
    const h=harness({signOutEvent,read:()=>({data:{id:'pending',auth_user_id:'pending-auth',approval_status:'pending'}})}),c=h.context;
    assert.equal(await c.doLogin('pending','password',{}),false);const flow=c.authFlowEpoch;
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(c.authFlowEpoch,flow);assert.equal(c.SESSION,null);
    assert.equal(c.oauthMessage,'가입 승인 대기 중이에요. 관리자가 승인하면 로그인할 수 있어요.');
    assert.deepEqual(h.reads.map(r=>r.table),['profiles']);
  }
});
test('a genuine external sign-out still clears an established member and their private data',async()=>{
  const h=harness({signOutEvent:'sync'}),c=h.context;c.STATE.privateEntries.private={data:'opaque'};
  const flow=c.authFlowEpoch;c.authCallback('SIGNED_OUT',null);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(c.authFlowEpoch,flow+1);assert.equal(c.SESSION,null);assert.equal(Object.keys(c.STATE.privateEntries).length,0);
  assert.equal(c.oauthMessage,'로그아웃되었어요. 다시 로그인해주세요.');
});

test('password verification cannot activate pending or rejected members or load their private records',async()=>{
  for(const status of ['pending','rejected',undefined]){
    const {context:c,reads,auth}=harness({read:()=>({data:{id:'pending-user',name:'대기 회원',pbkdf2_salt:'salt',auth_user_id:'pending-auth',approval_status:status}})});
    let derived=false;c.deriveKey=async()=>{derived=true;return 'key';};
    assert.equal(await c.doLogin('pending','password',{}),false);
    assert.equal(c.SESSION,null);assert.equal(derived,false);assert.deepEqual(auth,['signIn','signOut']);
    assert.deepEqual(reads.map(row=>row.table),['profiles']);assert.match(c.oauthMessage,/관리자|승인/);
  }
});
