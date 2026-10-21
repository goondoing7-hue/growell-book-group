'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const OAuth=require('../oauthDomain.js'),Private=require('../privateCrypto.js'),MemberAccess=require('../memberAccess.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const authId='11111111-2222-3333-4444-555555555555';
const profile={id:'u-social',auth_user_id:authId,login_id:'social_test',name:'회원',is_admin:false,pbkdf2_salt:'0123456789abcdef0123456789abcdef',is_deleted:false,approval_status:'approved'};
const user={id:authId,identities:[{provider:'google'}],app_metadata:{providers:['google']}};
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
function harness(options={}){
  const memory=options.memory||new Map(),sessionMemory=options.sessionMemory||new Map(),authUser=options.user||user,calls=[],logs=[],nodes={},listeners={},timers=new Map();let timerId=0;
  const url=new URL(options.href||'https://app.example/'),c={Promise,URL,URLSearchParams,JSON,Date,
    setTimeout(callback,delay=0){if(delay<1000)return setTimeout(callback,delay);const id={id:++timerId};timers.set(id,{callback,delay});return id;},
    clearTimeout(id){if(!timers.delete(id))clearTimeout(id);},
    console:Object.fromEntries(['log','info','warn','error','debug'].map(method=>[method,(...args)=>logs.push(args)])),Uint8Array,atob,crypto:require('node:crypto').webcrypto,
    STATE:{users:{},posts:{},comments:{},privateEntries:{},habits:{},readingMeta:{},readingLogs:{},worksheets:{},materialNotes:{}},SESSION:null,
    authFlowEpoch:0,saveSessionEpoch:0,sharedPostsLoadState:'idle',BOOTING:true,BOOT_FAILED:false,
    GrowellOAuth:OAuth,GrowellMemberAccess:MemberAccess,GrowellPasswordHint:require('../passwordHint.js'),keyFromB64:Private.importKey,SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-test-key',authMode:'login',
    loginEmailFor:id=>id+'@growell.local',editingAnnouncement:false,composerDraftPending:0,composerDrafts:{},saving:false,activeSave:null,saveQueue:[],captureComposerDraft(){calls.push(['draft-capture']);},
    location:{href:url.href,hash:url.hash||'#/',pathname:url.pathname,search:url.search,assign(url){calls.push(['redirect',url]);}},
    history:{replaceState(a,b,value){calls.push(['clean-url',value]);const next=new URL(value,c.location.href);Object.assign(c.location,{href:next.href,hash:next.hash,pathname:next.pathname,search:next.search});}},
    localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
    sessionStorage:{getItem:key=>sessionMemory.get(key)||null,setItem:(key,value)=>sessionMemory.set(key,value),removeItem:key=>sessionMemory.delete(key)},
    document:{visibilityState:'visible',hidden:false,querySelector(){return null;},querySelectorAll(){return [];},getElementById:id=>nodes[id]||null,
      addEventListener(type,callback){(listeners['document:'+type]||(listeners['document:'+type]=[])).push(callback);}},
    navigator:{onLine:true},
    addEventListener(type,callback){(listeners['window:'+type]||(listeners['window:'+type]=[])).push(callback);},
    fetch:async()=>{calls.push(['provider-settings']);return {ok:true,json:async()=>({external:{google:true,kakao:false}})};},
    render(){calls.push(['render']);},showToast(message){calls.push(['toast',message]);},esc:value=>String(value),
    mapProfileRow:r=>({id:r.id,name:r.name,authUserId:r.auth_user_id,salt:r.pbkdf2_salt,isAdmin:r.is_admin,loginId:r.login_id}),
    resetSaveSession(){c.saveSessionEpoch++;return Promise.resolve();},clearMemberSession(){if(c.cancelMemberSessionRestore)c.cancelMemberSessionRestore();c.SESSION=null;c.STATE.privateEntries={};memory.delete('growell_session');calls.push(['clear']);},
    loadMemberData:async()=>{calls.push(['load-member']);return options.loadMemberData?options.loadMemberData():true;},
    sb:{auth:{getSession:async()=>{calls.push(['get-session']);return options.getSession?options.getSession():{data:{session:options.guest?null:{user:authUser}}};},
      getUser:async()=>{calls.push(['verify-user']);return options.getUser?options.getUser():options.invalidAuth?{error:new Error('expired')}:{data:{user:authUser},error:null};},
      onAuthStateChange(callback){c.authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};},
      exchangeCodeForSession:async code=>{calls.push(['exchange',code]);return {error:null};},
      signInWithPassword:async input=>{calls.push(['password-auth',input]);return options.passwordAuth?options.passwordAuth(input):{data:{user:authUser},error:null};},
      linkIdentity:async input=>{calls.push(['link-identity',input]);return options.linkIdentity?options.linkIdentity(input):{data:{url:'https://accounts.google.com/o/oauth2/v2/auth?opaque=authorization'},error:null};},
      signOut:async()=>{calls.push(['signout']);return {};},
      signInWithOAuth:async input=>{calls.push(['oauth',input]);return {data:{url:'https://project.supabase.co/auth/v1/authorize?provider='+input.provider}};}
    },from(table){const query={select(){return query;},eq(key,value){calls.push(['read',table,key,value]);return query;},maybeSingle:async()=>options.getProfile?options.getProfile():({data:options.profile===undefined?profile:options.profile,error:null})};return query;},
    rpc:async(name,args)=>{calls.push(['rpc',name,args]);if(options.rpc)return options.rpc(name,args);return {data:{status:'new',profile:null,envelope:null}};}}
  };
  c.window=c;
  vm.createContext(c);
  vm.runInContext(section('/* ---------------- OAuth login and private-space unlock ---------------- */','/* ---------------- render: login ---------------- */'),c);
  vm.runInContext(section('function bootApp(){','function currentUser(){'),c);
  return {c,memory,sessionMemory,calls,nodes,logs,timers,listeners,
    dispatch(type,target='window'){for(const callback of listeners[target+':'+type]||[])callback({type});},
    async fireTimer(){const entry=timers.entries().next().value;assert.ok(entry,'a retry should be scheduled');timers.delete(entry[0]);await entry[1].callback();await settle();return entry[1].delay;}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle(){await new Promise(resolve=>setTimeout(resolve,5));}
async function cacheMember(h,extra={}){const keyB64=await Private.exportKey(await Private.newKey());const saved=JSON.stringify({userId:profile.id,name:'old name',keyB64,authKind:'password',...extra});h.memory.set('growell_session',saved);return {keyB64,saved};}
test('Google entry is existing-link login only while Kakao and social signup remain hidden',async()=>{
  const {c,calls}=harness({guest:true});
  vm.runInContext(section('function loginHtml(){','function profilePhotoPickerHtml('),c);
  vm.runInContext(section('function signupFormHtml(){','function forgotPasswordFormHtml('),c);
  c.profilePhotoPickerHtml=()=>'';c.pendingSignupAvatar=null;
  await c.loadOAuthProviderSettings();
  c.oauthProviders={state:'ready',google:true,kakao:true};
  await c.startOAuth('kakao');
  assert.equal(c.SOCIAL_AUTH_VISIBLE,false);
  assert.equal(c.socialSignupStatusHtml(),'');
  for(const mode of ['login','signup']){
    c.authMode=mode;const markup=c.loginHtml();
    if(mode==='login'){assert.match(markup,/Google로 로그인/);assert.match(markup,/기존 회원 계정에서 Google 로그인을 연결/);assert.doesNotMatch(markup,/data-oauth-provider="kakao"/);
      assert.match(markup,/<svg class="auth-provider-icon"[^>]*aria-hidden="true"[^>]*focusable="false"/);
      for(const color of ['#EA4335','#4285F4','#FBBC05','#34A853'])assert.ok(markup.includes('fill="'+color+'"'));}
    else assert.doesNotMatch(markup,/data-oauth-provider|Google|카카오/);
    assert.match(markup,/>회원가입<\/button>/);
    assert.match(markup,mode==='login'?/id="li-pw"/:/id="su-pw"/);
  }
  assert.ok(!calls.some(call=>['oauth','redirect','signout','clear'].includes(call[0])));
});

test('choosing another authentication form clears only the previous status message',()=>{
  const handlers={},nodes={};
  for(const id of ['link-forgot-password','link-back-to-login'])nodes[id]={addEventListener:(event,callback)=>{handlers[id]=callback;}};
  const tabs=['signup','login'].map(mode=>({getAttribute:()=>mode,addEventListener:(event,callback)=>{handlers[mode]=callback;}}));
  const c={authMode:'login',oauthMessage:'가입 승인 대기 중이에요.',authFlowEpoch:12,
    document:{getElementById:id=>nodes[id]||null},app:{querySelectorAll:()=>tabs},bindProfilePhotoPicker(){},render(){}};
  vm.createContext(c);vm.runInContext(section("  app.querySelectorAll('[data-auth-tab]')",'  var grantAdminBtn ='),c);
  for(const [id,mode] of [['signup','signup'],['login','login'],['link-forgot-password','forgot'],['link-back-to-login','login']]){
    c.oauthMessage='이전 안내';handlers[id]();assert.equal(c.authMode,mode);assert.equal(c.oauthMessage,'');assert.equal(c.authFlowEpoch,12);
  }
});

test('signup completion is a standalone confirmation without authentication tabs or forms and returns to login',()=>{
  const {c}=harness({guest:true}),handlers={};
  c.authMode='signup-complete';c.svgIcon=()=>'<svg/>';c.I_CHECK='';
  vm.runInContext(section('function loginHtml(){','function profilePhotoPickerHtml('),c);
  const markup=c.loginHtml();
  assert.match(markup,/가입 신청이 완료되었어요/);assert.match(markup,/관리자가 승인하면 로그인할 수 있어요\./);
  assert.match(markup,/id="link-back-to-login">로그인 화면으로<\/button>/);
  assert.doesNotMatch(markup,/data-auth-tab|id="(?:li|su)-(?:id|pw)|<input|<select/);
  c.document.getElementById=id=>id==='link-back-to-login'?{addEventListener:(event,callback)=>{handlers.back=callback;}}:null;
  c.app={querySelectorAll:()=>[]};c.bindProfilePhotoPicker=()=>{};
  vm.runInContext(section("  app.querySelectorAll('[data-auth-tab]')",'  var grantAdminBtn ='),c);
  handlers.back();assert.equal(c.authMode,'login');assert.match(c.loginHtml(),/id="li-id"/);
});

test('native login restores from persistent storage in a fresh app with no tab session storage',async()=>{
  const nativeUser={id:authId,identities:[{provider:'email'}],app_metadata:{providers:['email']}};
  const first=harness({user:nativeUser}),keyB64=await Private.exportKey(await Private.newKey());
  first.c.localStorage.setItem('growell_session',JSON.stringify({userId:profile.id,name:'old name',keyB64,authKind:'password'}));
  const fresh=harness({user:nativeUser,memory:first.memory});
  await fresh.c.bootApp();
  assert.equal(fresh.c.SESSION.authKind,'password');
  assert.equal(fresh.c.SESSION.keyB64,keyB64);
  assert.equal(fresh.c.SESSION.name,profile.name);
  assert.ok(fresh.calls.some(call=>call[0]==='load-member'));
  assert.ok(!fresh.calls.some(call=>['oauth','signout'].includes(call[0])));
});
test('returned and thrown session refresh failures preserve the private key and offer connection retry',async()=>{
  for(const thrown of [false,true]){
    const h=harness({getSession:async()=>{const error=new TypeError('Failed to fetch');if(thrown)throw error;return {data:{session:null},error};}});
    const cached=await cacheMember(h);await h.c.bootApp();
    assert.equal(h.c.SESSION,null);assert.equal(h.c.BOOTING,false);assert.equal(h.c.authRestoreState,'retry');
    assert.equal(h.memory.get('growell_session'),cached.saved,'a failed refresh is not an explicit logout');
    assert.ok(!h.calls.some(call=>['read','verify-user','load-member','signout','clear'].includes(call[0])));
    assert.match(h.c.memberSessionRestoreHtml(),/다시|연결/);
    assert.doesNotMatch(h.c.oauthMessage,/다시 로그인/);
    assert.equal(h.timers.size,1);
  }
});

test('verification and profile connection failures recover the same key after approved identity verification',async()=>{
  for(const stage of ['user','profile']){
    let failed=true;
    const h=harness({
      getUser:async()=>stage==='user'&&failed?{error:{status:503,message:'network unavailable'}}:{data:{user},error:null},
      getProfile:async()=>stage==='profile'&&failed?{data:null,error:{status:503,message:'network unavailable'}}:{data:profile,error:null}
    });
    const cached=await cacheMember(h);await h.c.bootApp();
    assert.equal(h.c.SESSION,null);assert.equal(h.c.authRestoreState,'retry');
    assert.equal(h.memory.get('growell_session'),cached.saved);
    assert.ok(!h.calls.some(call=>call[0]==='load-member'));
    failed=false;await h.c.retryMemberSession();
    assert.equal(h.c.SESSION.userId,profile.id);assert.equal(h.c.SESSION.keyB64,cached.keyB64);
    assert.equal(h.c.SESSION.name,profile.name);assert.equal(h.c.authRestoreState,'idle');assert.equal(h.timers.size,0);
    assert.equal(h.calls.filter(call=>call[0]==='load-member').length,1);
    assert.ok(h.calls.some(call=>call[0]==='read'&&call[2]==='auth_user_id'&&call[3]===authId));
    assert.equal(JSON.parse(h.memory.get('growell_session')).keyB64,cached.keyB64);
  }
});

test('definitively absent or revoked Auth sessions clear cached access without scheduling a retry',async()=>{
  for(const result of [
    {data:{session:null},error:null},
    {data:{session:null},error:{status:400,code:'refresh_token_not_found',message:'revoked refresh token'}}
  ]){
    const h=harness({getSession:async()=>result});await cacheMember(h);await h.c.bootApp();
    assert.equal(h.c.SESSION,null);assert.equal(h.memory.has('growell_session'),false);
    assert.equal(h.c.authRestoreState,'idle');assert.equal(h.timers.size,0);
    assert.ok(!h.calls.some(call=>['read','load-member'].includes(call[0])));
  }
});

test('an expired access token is refreshed once and reverified before private records load',async()=>{
  for(const unavailable of [false,true]){
    let verified=0;
    const h=harness({getUser:async()=>++verified===1?{error:{status:401,code:'jwt_expired'}}:{data:{user},error:null}});
    h.c.sb.auth.refreshSession=async()=>{h.calls.push(['refresh-session']);return unavailable?{error:{status:503}}:{data:{session:{user}},error:null};};
    const cached=await cacheMember(h);await h.c.bootApp();
    assert.equal(h.calls.filter(call=>call[0]==='refresh-session').length,1);
    assert.equal(h.memory.get('growell_session'),cached.saved);
    if(unavailable){assert.equal(h.c.SESSION,null);assert.equal(h.c.authRestoreState,'retry');assert.ok(!h.calls.some(call=>call[0]==='load-member'));}
    else{assert.equal(verified,2);assert.equal(h.c.SESSION.keyB64,cached.keyB64);assert.equal(h.calls.filter(call=>call[0]==='load-member').length,1);}
  }
});

test('recovery never unlocks a cached profile for a different verified user or mismatched profile',async()=>{
  for(const changed of [
    {getUser:async()=>({data:{user:{...user,id:'66666666-7777-8888-9999-000000000000'}},error:null})},
    {profile:{...profile,id:'another-profile'}}
  ]){
    const h=harness(changed);const cached=await cacheMember(h);await h.c.bootApp();
    assert.equal(h.c.SESSION,null);assert.ok(!h.calls.some(call=>call[0]==='load-member'));
    assert.ok(!Object.values(h.c.STATE.users).some(row=>row.id===profile.id));
    assert.notEqual(h.c.SESSION&&h.c.SESSION.keyB64,cached.keyB64);
  }
});

test('concurrent restore attempts share one verification and cancellation ignores late completion',async()=>{
  const pending=deferred(),h=harness({getUser:()=>pending.promise});await cacheMember(h);
  const first=h.c.restoreMemberSession(),second=h.c.restoreMemberSession();
  assert.equal(first,second);await settle();
  assert.equal(h.calls.filter(call=>call[0]==='verify-user').length,1);
  h.c.authFlowEpoch++;h.c.clearMemberSession();
  pending.resolve({data:{user},error:null});await Promise.all([first,second]);
  assert.equal(h.c.SESSION,null);assert.equal(h.memory.has('growell_session'),false);
  assert.ok(!h.calls.some(call=>call[0]==='read'||call[0]==='load-member'));
  assert.equal(h.c.authRestoreState,'idle');assert.equal(h.timers.size,0);
});

test('logout and an Auth account change during restoration cannot resurrect the previous private session',async()=>{
  for(const event of ['SIGNED_OUT','SIGNED_IN']){
    const pending=deferred(),h=harness({getUser:()=>pending.promise});await cacheMember(h);
    const boot=h.c.bootApp();await settle();
    h.c.authCallback(event,event==='SIGNED_OUT'?null:{user:{id:'another-auth-user'}});await settle();
    pending.resolve({data:{user},error:null});await boot;
    assert.equal(h.c.SESSION,null,event);assert.equal(h.memory.has('growell_session'),false,event);
    assert.ok(!h.calls.some(call=>call[0]==='load-member'),event);
    assert.equal(h.c.authRestoreState,'idle');assert.equal(h.timers.size,0);
  }
});

test('a late previous-account response cannot clear or replace a newly restored account',async()=>{
  const pending=deferred(),nextUser={...user,id:'66666666-7777-8888-9999-000000000000'},nextProfile={...profile,id:'next-profile',auth_user_id:'66666666-7777-8888-9999-000000000000'};
  let next=false;
  const h=harness({
    getSession:async()=>({data:{session:{user:next?nextUser:user}},error:null}),
    getUser:()=>next?Promise.resolve({data:{user:nextUser},error:null}):pending.promise,
    getProfile:async()=>({data:next?nextProfile:profile,error:null})
  });
  await cacheMember(h);const previous=h.c.restoreMemberSession();await settle();
  h.c.authFlowEpoch++;h.c.clearMemberSession();next=true;
  const cached=await cacheMember(h,{userId:nextProfile.id});await h.c.restoreMemberSession();
  assert.equal(h.c.SESSION.userId,nextProfile.id);
  pending.resolve({data:{user},error:null});await previous;
  assert.equal(h.c.SESSION.userId,nextProfile.id);assert.equal(h.c.SESSION.keyB64,cached.keyB64);
  assert.equal(h.memory.get('growell_session'),cached.saved);assert.equal(h.c.authRestoreState,'idle');assert.equal(h.timers.size,0);
  assert.equal(h.calls.filter(call=>call[0]==='load-member').length,1);
});

test('automatic recovery is bounded and reopening online retries without disturbing a restored session',async()=>{
  let failed=true;
  const h=harness({getSession:async()=>failed?{data:{session:null},error:{status:503}}:{data:{session:{user}},error:null}});
  const cached=await cacheMember(h);await h.c.bootApp();
  const delays=[];
  while(h.timers.size){assert.ok(delays.length<4,'automatic retries must stop');delays.push(await h.fireTimer());}
  assert.deepEqual(delays,[1500,5000,15000]);assert.equal(h.c.authRestoreState,'retry');
  assert.equal(h.memory.get('growell_session'),cached.saved);
  failed=false;h.dispatch('online');await settle();
  assert.equal(h.c.SESSION.keyB64,cached.keyB64);assert.equal(h.c.authRestoreState,'idle');
  const callCount=h.calls.length;
  h.dispatch('online');h.dispatch('pageshow');h.dispatch('visibilitychange','document');await settle();
  assert.equal(h.calls.length,callCount,'lifecycle events must not re-render or refetch a healthy member session');
  assert.equal(h.timers.size,0);
});

test('a restored login route is replaced with home while a reading route remains unchanged',async()=>{
  for(const route of ['#/login','#/book/emotion/mine']){
    const h=harness({href:'https://app.example/'+route});await cacheMember(h);await h.c.bootApp();
    assert.ok(h.c.SESSION);
    assert.equal(h.c.location.hash,route==='#/login'?'#/':route);
    const changes=h.calls.filter(call=>call[0]==='clean-url');
    assert.equal(changes.length,route==='#/login'?1:0);
  }
});

test('guest boot never reads member tables or verifies an absent Auth session',async()=>{
  const {c,calls,memory}=harness({guest:true});memory.set('growell_session','{"userId":"stale"}');await c.bootApp();
  assert.equal(c.SESSION,null);assert.equal(calls.filter(v=>v[0]==='read').length,0);assert.equal(memory.has('growell_session'),false);
});
test('cached session is restored only after verified Auth user and matching own profile',async()=>{
  const {c,memory,calls}=harness();memory.set('growell_session',JSON.stringify({userId:profile.id,name:'old name',keyB64:await Private.exportKey(await Private.newKey()),authKind:'oauth'}));
  await c.bootApp();assert.equal(c.SESSION.name,profile.name);assert.equal(c.SESSION.authKind,'oauth');
  assert.ok(calls.some(v=>v[0]==='read'&&v[2]==='auth_user_id'&&v[3]===authId));assert.ok(calls.some(v=>v[0]==='load-member'));
});
test('unverified cached Auth session cannot restore membership or read profiles',async()=>{
  const {c,calls}=harness({invalidAuth:true});await c.bootApp();assert.equal(c.SESSION,null);assert.ok(!calls.some(v=>v[0]==='read'));
});

test('cached authentication does not restore pending, rejected or deleted membership',async()=>{
  for(const extra of [{approval_status:'pending'},{approval_status:'rejected'},{is_deleted:true},{approval_status:undefined}]){
    const {c,memory,calls}=harness({profile:{...profile,...extra}});
    memory.set('growell_session',JSON.stringify({userId:profile.id,keyB64:await Private.exportKey(await Private.newKey())}));
    await c.bootApp();assert.equal(c.SESSION,null);assert.ok(!calls.some(call=>call[0]==='load-member'));
    assert.ok(calls.some(call=>call[0]==='signout'));
  }
});
test('PKCE callback is exchanged exactly once and code is removed from visible URL',async()=>{
  const {c,calls}=harness({href:'https://app.example/?code=one-time-code',profile:null});await c.bootApp();
  assert.equal(calls.filter(v=>v[0]==='exchange').length,1);assert.ok(calls.some(v=>v[0]==='clean-url'&&!v[1].includes('code=')));assert.equal(c.oauthPending.status,'new');
});

test('only explicit access_denied callbacks show cancellation, for query or reordered fragment parameters',async()=>{
  for(const suffix of ['?error=access_denied&error_code=access_denied&error_description=private-detail',
    '#error_description=private-detail&error_code=access_denied&error=access_denied']){
    const {c,calls,logs,memory}=harness({href:'https://app.example/'+suffix});
    await c.bootApp();
    assert.equal(c.oauthMessage,'간편 로그인을 취소했어요. 다시 선택할 수 있어요.');
    assert.equal(c.SESSION,null);assert.equal(c.BOOTING,false);
    assert.ok(!calls.some(call=>['exchange','read','rpc','load-member'].includes(call[0])));
    const cleaned=calls.find(call=>call[0]==='clean-url');assert.ok(cleaned);
    assert.doesNotMatch(cleaned[1],/error|private-detail/);
    assert.equal(logs.length,0);assert.equal(memory.size,0);
  }
});

test('provider failures show a safe connection message and discard descriptions and codes without exchange or member reads',async()=>{
  for(const suffix of [
    '?error=server_error&error_code=unexpected_failure&error_description=private-provider-detail&code=do-not-exchange',
    '#error_description=private-provider-detail&error_code=unexpected_failure&error=server_error',
    '?error=access_denied&error_code=provider_disabled&error_description=private-provider-detail',
    '?error_code=unexpected_failure&error_description=private-provider-detail',
    '#error_description=private-provider-detail',
    '#%65rror_description=private-provider-detail&%65rror=server_error',
    '?error=access_denied#error=server_error&error_description=private-provider-detail'
  ]){
    const {c,calls,logs,memory}=harness({href:'https://app.example/'+suffix});
    await c.bootApp();
    assert.equal(c.oauthMessage,'간편 로그인 서비스에 연결하지 못했어요. 잠시 후 다시 시도해주세요.');
    assert.equal(c.SESSION,null);assert.equal(c.BOOTING,false);
    assert.ok(!calls.some(call=>['exchange','read','rpc','load-member'].includes(call[0])));
    assert.ok(calls.some(call=>call[0]==='clean-url'));
    assert.doesNotMatch(JSON.stringify(calls)+c.oauthMessage,/private-provider-detail|do-not-exchange|server_error|unexpected_failure|provider_disabled/);
    assert.equal(logs.length,0);assert.equal(memory.size,0);
  }
});
test('new social member sends only an encrypted vault, then unlocks the returned envelope',async()=>{
  let payload;const {c,calls}=harness({rpc:async(name,args)=>{payload=args;return {data:{status:'ready',profile,envelope:args.p_envelope}};}});
  c.SOCIAL_AUTH_VISIBLE=true;c.oauthPending={status:'new',authUserId:authId};
  assert.equal(await c.completeOAuthMember('회원','private-password','private-password'),true);
  assert.equal(c.SESSION.authKind,'oauth');assert.ok(!JSON.stringify(payload).includes('private-password'));assert.ok(!JSON.stringify(payload).includes(c.SESSION.keyB64));assert.ok(calls.some(v=>v[0]==='load-member'));
});
test('retry with an already stored vault never uses a newly generated key',async()=>{
  const stored=await OAuth.createVault('first-password',profile.pbkdf2_salt,authId);
  const {c}=harness({rpc:async()=>({data:{status:'ready',profile,envelope:stored.envelope}})});c.oauthPending={status:'new',authUserId:authId};
  assert.equal(await c.completeOAuthMember('회원','different-password','different-password'),false);assert.equal(c.SESSION,null);
});
test('legacy identity refuses automatic registration and profile overwrite',async()=>{
  const {c,calls}=harness();c.oauthPending={status:'legacy',authUserId:authId,profile};
  assert.equal(await c.completeOAuthMember('회원','private-password','private-password'),false);assert.ok(!calls.some(v=>v[0]==='rpc'));
});
test('cross-tab signout and a different Auth user clear local private records',async()=>{
  const {c}=harness();c.BOOTING=false;c.SESSION={userId:profile.id};c.STATE.users[profile.id]={authUserId:authId};c.STATE.privateEntries.note={data:'private'};c.bindOAuthAuthWatcher();
  c.authCallback('SIGNED_IN',{user:{id:'other-user'}});await new Promise(r=>setTimeout(r,5));assert.equal(c.SESSION,null);assert.equal(Object.keys(c.STATE.privateEntries).length,0);
});
test('the same user token refresh does not clear private keys or cancel writing',async()=>{
  const {c,calls}=harness();c.SESSION={userId:profile.id,keyB64:'keep'};c.STATE.users[profile.id]={authUserId:authId};c.bindOAuthAuthWatcher();c.authCallback('TOKEN_REFRESHED',{user});
  await new Promise(r=>setTimeout(r,5));assert.equal(c.SESSION.keyB64,'keep');assert.ok(!calls.some(v=>v[0]==='clear'));
});
test('provider status controls launch and returned redirect stays on configured Supabase',async()=>{
  const {c,calls}=harness();c.SOCIAL_AUTH_VISIBLE=true;await c.loadOAuthProviderSettings();await c.startOAuth('kakao');assert.ok(!calls.some(v=>v[0]==='oauth'));await c.startOAuth('google');
  assert.ok(calls.some(v=>v[0]==='redirect'&&v[1].startsWith('https://project.supabase.co/auth/v1/authorize')));
});

test('Kakao overrides provider scope to nickname only while Google keeps its original OAuth options',async()=>{
  for(const provider of ['kakao','google']){
    const {c,calls}=harness({href:'https://app.example/?obsolete=discard#/book/emotion/share'});
    c.SOCIAL_AUTH_VISIBLE=true;
    c.oauthProviders={state:'ready',google:true,kakao:true};
    await c.startOAuth(provider);
    const requests=calls.filter(call=>call[0]==='oauth');assert.equal(requests.length,1);
    const requested=JSON.parse(JSON.stringify(requests[0][1]));
    const expected={provider,options:{redirectTo:'https://app.example/',skipBrowserRedirect:true}};
    if(provider==='kakao')expected.options.queryParams={scope:'profile_nickname'};
    assert.deepEqual(requested,expected);
    assert.ok(!Object.hasOwn(requested.options,'scopes'),'additive scopes must not reintroduce defaults');
    assert.doesNotMatch(JSON.stringify(requested),/account_email|profile_image/);
    assert.ok(calls.some(call=>call[0]==='redirect'&&call[1].endsWith('provider='+provider)));
  }
});

test('verified provider metadata suggests an escaped bounded nickname without replacing an existing profile or granting roles',async()=>{
  const {c}=harness();
  c.SOCIAL_AUTH_VISIBLE=true;
  vm.runInContext(section('function esc(s){','function nlToBr('),c);
  for(const [metadata,expected] of [
    [{preferred_username:'  책친구  ',full_name:'다른 이름'},'책친구'],
    [{preferred_username:' ',full_name:'봄'.repeat(35)},'봄'.repeat(30)],
    [{full_name:{name:'무시'},name:'이름'},'이름'],
    [{nickname:'카카오 별명'},'카카오 별명'],
    [{name:'\"/><img src=x onerror=1>',is_admin:true,role:'admin'},'\"/><img src=x onerror=1>'],
    [{nickname:77},'']
  ]){
    await c.prepareOAuthMember({...user,user_metadata:metadata},c.authFlowEpoch);
    assert.equal(c.oauthPending.name,expected);
    const markup=c.oauthMemberHtml();
    assert.ok(markup.includes('value="'+c.esc(expected)+'"'));
    assert.doesNotMatch(markup,/<img\b/i);
    assert.equal(c.SESSION,null);assert.equal(Object.keys(c.STATE.users).length,0);
  }
  c.sb.rpc=async()=>({data:{status:'legacy',profile,envelope:null}});
  await c.prepareOAuthMember({...user,user_metadata:{preferred_username:'바뀌면 안 됨',is_admin:true}},c.authFlowEpoch);
  assert.equal(c.oauthPending.name,profile.name);assert.equal(c.oauthPending.profile.is_admin,false);
});

const nativeUser={id:authId,identities:[{provider:'email'}],app_metadata:{providers:['email']}};
const linkedUser={...nativeUser,identities:[{provider:'email'},{provider:'google'}],app_metadata:{providers:['email','google']}};
const memberPassword='member-current-password';
async function nativeMaterial(passwordValue=memberPassword,saltValue=profile.pbkdf2_salt){
  const crypt=require('node:crypto').webcrypto,base=await crypt.subtle.importKey('raw',new TextEncoder().encode(passwordValue),'PBKDF2',false,['deriveBits']);
  return Buffer.from(await crypt.subtle.deriveBits({name:'PBKDF2',salt:Buffer.from(saltValue,'hex'),iterations:150000,hash:'SHA-256'},base,256)).toString('base64');
}
async function linkingHarness(options={}){
  const h=harness({user:nativeUser,rpc:async(name,args)=>({data:{status:'prepared',profile,envelope:args.p_envelope},error:null}),...options});
  h.c.SESSION={userId:profile.id,name:profile.name,keyB64:await nativeMaterial(),authKind:'password'};
  h.c.STATE.users[profile.id]=h.c.mapProfileRow(profile);
  h.c.STATE.privateEntries.note={id:'note-preserve',data:'existing-ciphertext'};
  return h;
}
test('new Google identities never register a member while social signup is disabled',async()=>{
  const h=harness();h.c.oauthPending={status:'new',authUserId:authId};
  assert.equal(await h.c.completeOAuthMember('ignored',memberPassword,memberPassword),false);
  assert.ok(!h.calls.some(call=>call[0]==='rpc'||call[0]==='load-member'));
  assert.match(h.c.oauthMemberHtml(),/기존 회원 계정에서 연결/);assert.doesNotMatch(h.c.oauthMemberHtml(),/id="oauth-password"|가입하고 시작/);
});
test('existing member linking reauthenticates and saves only an encrypted exact-key vault before redirect',async()=>{
  const h=await linkingHarness(),before=JSON.stringify(h.c.STATE),material=h.c.SESSION.keyB64;
  assert.equal((await h.c.connectExistingGoogleLogin(memberPassword,()=>true)).redirected,true);
  const sequence=h.calls.map(call=>call[0]);assert.ok(sequence.indexOf('password-auth')<sequence.indexOf('rpc'));assert.ok(sequence.indexOf('rpc')<sequence.indexOf('link-identity'));assert.ok(sequence.indexOf('link-identity')<sequence.indexOf('redirect'));
  const request=h.calls.find(call=>call[0]==='rpc');assert.equal(request[1],'growell_oauth_link_prepare');
  assert.equal(await OAuth.unlockVault(memberPassword,request[2].p_envelope,authId),material);
  assert.doesNotMatch(JSON.stringify(request[2]),new RegExp(memberPassword));assert.ok(!JSON.stringify(request[2]).includes(material));
  const marker=JSON.parse(h.sessionMemory.get('growell_google_login_link_v1'));assert.deepEqual(Object.keys(marker).sort(),['authUserId','createdAt','nonce','profileId']);
  assert.ok(!JSON.stringify(marker).includes(material));assert.ok(!JSON.stringify(marker).includes(memberPassword));
  const input=h.calls.find(call=>call[0]==='link-identity')[1];assert.equal(input.provider,'google');assert.equal(new URL(input.options.redirectTo).searchParams.get('google-login-link'),marker.nonce);
  assert.equal(JSON.stringify(h.c.STATE),before);assert.equal(h.c.SESSION.keyB64,material);
});
test('incorrect password, changed profile, changed session key and unsaved edits stop before linking',async()=>{
  for(const failure of ['password','profile','key','draft']){
    const h=await linkingHarness(failure==='password'?{passwordAuth:async()=>({error:{code:'invalid_credentials'}})}:failure==='profile'?{profile:{...profile,id:'another-profile'}}:{});
    if(failure==='key')h.c.SESSION.keyB64=Buffer.alloc(32,9).toString('base64');
    if(failure==='draft')h.c.composerDrafts.unsaved={userId:profile.id,unsaved:true};
    const before=JSON.stringify(h.c.STATE);
    await assert.rejects(h.c.connectExistingGoogleLogin(memberPassword,()=>true));
    assert.ok(!h.calls.some(call=>['link-identity','redirect'].includes(call[0])),failure);
    assert.equal(JSON.stringify(h.c.STATE),before,failure);
    if(failure==='password'||failure==='draft')assert.ok(!h.calls.some(call=>call[0]==='rpc'));
  }
});
test('storage failure and an identity collision cannot redirect or create or merge profiles',async()=>{
  for(const failure of ['storage','identity']){
    const h=await linkingHarness(failure==='identity'?{linkIdentity:async()=>({error:{code:'identity_already_exists'}})}:{}),before=JSON.stringify(h.c.STATE);
    if(failure==='storage')h.c.sessionStorage.setItem=()=>{throw new Error('storage denied');};
    await assert.rejects(h.c.connectExistingGoogleLogin(memberPassword,()=>true));
    assert.ok(!h.calls.some(call=>call[0]==='redirect'));
    assert.ok(!h.calls.some(call=>call[0]==='rpc'&&call[1]==='growell_oauth_register'));
    assert.equal(JSON.stringify(h.c.STATE),before);
    if(failure==='storage')assert.ok(!h.calls.some(call=>call[0]==='link-identity'));
  }
});
test('a fresh current-password proof repairs an old vault using exact-envelope CAS and preserves all content',async()=>{
  const old=await OAuth.createVault('old-record-password',OAuth.newSalt(),authId),rpc=[];
  const h=await linkingHarness({user:linkedUser,rpc:async(name,args)=>{rpc.push([name,args]);return name==='growell_oauth_link_prepare'?{data:{status:'prepared',profile,envelope:old.envelope}}:{data:{status:'prepared',profile,envelope:args.p_envelope}};}});
  const before=JSON.stringify(h.c.STATE),material=h.c.SESSION.keyB64;
  assert.equal((await h.c.connectExistingGoogleLogin(memberPassword,()=>true)).connected,true);
  assert.deepEqual(rpc.map(value=>value[0]),['growell_oauth_link_prepare','growell_oauth_link_rotate']);
  assert.deepEqual(rpc[1][1].p_expected_envelope,old.envelope);
  assert.equal(await OAuth.unlockVault(memberPassword,rpc[1][1].p_envelope,authId),material);
  assert.ok(!h.calls.some(call=>call[0]==='link-identity'||call[0]==='redirect'));
  assert.equal(JSON.stringify(h.c.STATE),before);
});
test('an old password cannot open a stale Google vault after native password reset',async()=>{
  const oldPassword='outdated-record-password',old=await OAuth.createVault(oldPassword,OAuth.newSalt(),authId,await nativeMaterial(oldPassword));
  const h=harness({user:linkedUser,passwordAuth:async()=>({error:{code:'invalid_credentials'}})});
  h.c.oauthPending={status:'ready',authUserId:authId,profile,envelope:old.envelope};
  assert.equal(await h.c.completeOAuthMember('',oldPassword,''),false);assert.equal(h.c.SESSION,null);
  assert.ok(h.calls.some(call=>call[0]==='password-auth'));
  assert.ok(!h.calls.some(call=>call[0]==='load-member'));assert.match(h.c.oauthMessage,/현재 GROWELL 비밀번호/);
});
test('linked password members keep their password account kind and original key after Google login',async()=>{
  const material=await nativeMaterial(),vault=await OAuth.createLinkedVault(memberPassword,profile.pbkdf2_salt,authId,material),h=harness({user:linkedUser});
  h.c.oauthPending={status:'ready',authUserId:authId,profile,envelope:vault.envelope};
  assert.equal(await h.c.completeOAuthMember('',memberPassword,''),true);
  assert.equal(h.c.SESSION.authKind,'password');assert.equal(h.c.SESSION.keyB64,material);assert.equal(h.c.SESSION.userId,profile.id);
  assert.ok(h.calls.some(call=>call[0]==='load-member'));
});
test('link callback requires a single matching nonce, a live marker and the exact original member identity',async()=>{
  const nonce='a'.repeat(32),marker={authUserId:authId,profileId:profile.id,nonce,createdAt:Date.now()};
  for(const failure of ['missing','duplicate','expired','other-user','other-profile','no-google']){
    const suffix=failure==='missing'?'?code=one':'?code=one&google-login-link='+nonce+(failure==='duplicate'?'&google-login-link='+nonce:'');
    const sessionMemory=new Map([['growell_google_login_link_v1',JSON.stringify({...marker,createdAt:failure==='expired'?Date.now()-16*60*1000:Date.now()})]]);
    const h=harness({sessionMemory,href:'https://app.example/'+suffix,user:failure==='other-user'?{...linkedUser,id:'99999999-2222-3333-4444-555555555555'}:failure==='no-google'?nativeUser:linkedUser,profile:failure==='other-profile'?{...profile,id:'not-original'}:profile});
    await assert.rejects(h.c.finishOAuthCallback());
    assert.ok(!h.calls.some(call=>call[0]==='load-member'));
    assert.ok(h.calls.some(call=>call[0]==='clean-url'&&!call[1].includes('google-login-link')));
    if(['missing','duplicate','expired'].includes(failure))assert.ok(!h.calls.some(call=>call[0]==='exchange'),failure);
  }
});
test('a valid link callback verifies Google and the original profile without replacing the cached member key',async()=>{
  const nonce='b'.repeat(32),marker={authUserId:authId,profileId:profile.id,nonce,createdAt:Date.now()},sessionMemory=new Map([['growell_google_login_link_v1',JSON.stringify(marker)]]);
  const h=harness({user:linkedUser,sessionMemory,href:'https://app.example/?code=one&google-login-link='+nonce}),cached=await cacheMember(h);
  await h.c.bootApp();assert.equal(h.c.SESSION.userId,profile.id);assert.equal(h.c.SESSION.keyB64,cached.keyB64);assert.equal(h.c.SESSION.authKind,'password');
  assert.equal(h.calls.filter(call=>call[0]==='exchange').length,1);assert.equal(sessionMemory.has('growell_google_login_link_v1'),false);
  assert.ok(!h.calls.some(call=>call[0]==='rpc'&&call[1]==='growell_oauth_register'));
});
test('password login vault synchronization retains the record key and CAS failure never changes member content',async()=>{
  for(const failed of [false,true]){
    const old=await OAuth.createVault('previous-password',OAuth.newSalt(),authId),h=await linkingHarness({user:linkedUser,rpc:async(name,args)=>name==='growell_oauth_link_prepare'?{data:{status:'prepared',profile,envelope:old.envelope}}:failed?{error:{code:'conflict'}}:{data:{status:'prepared',profile,envelope:args.p_envelope}}});
    const before=JSON.stringify(h.c.STATE),material=h.c.SESSION.keyB64;
    if(failed)await assert.rejects(h.c.syncGoogleLoginAfterPassword(memberPassword,()=>{}));
    else assert.equal(await h.c.syncGoogleLoginAfterPassword(memberPassword,()=>{}),true);
    assert.equal(h.c.SESSION.keyB64,material);assert.equal(JSON.stringify(h.c.STATE),before);
    assert.ok(h.calls.some(call=>call[0]==='rpc'&&call[1]==='growell_oauth_link_rotate'));
    assert.ok(!h.calls.some(call=>call[0]==='link-identity'||call[0]==='redirect'));
  }
  const h=await linkingHarness();assert.equal(await h.c.syncGoogleLoginAfterPassword(memberPassword,()=>{}),true);
  assert.ok(!h.calls.some(call=>call[0]==='rpc'),'ordinary members without Google do not get a vault implicitly');
});
test('a cancelled callback cannot sign out a newer session or remove a newer link marker',async()=>{
  const nonce='c'.repeat(32),marker={authUserId:authId,profileId:profile.id,nonce,createdAt:Date.now()},sessionMemory=new Map([['growell_google_login_link_v1',JSON.stringify(marker)]]),pending=deferred();
  const h=harness({sessionMemory,user:linkedUser,href:'https://app.example/?code=one&google-login-link='+nonce,getUser:()=>pending.promise});
  const callback=h.c.finishOAuthCallback();await settle();h.c.authFlowEpoch++;
  const newer={...marker,nonce:'d'.repeat(32)};sessionMemory.set('growell_google_login_link_v1',JSON.stringify(newer));
  pending.resolve({data:{user:linkedUser},error:null});await assert.rejects(callback,/auth-flow-cancelled/);
  assert.equal(sessionMemory.get('growell_google_login_link_v1'),JSON.stringify(newer));
  assert.ok(!h.calls.some(call=>call[0]==='signout'||call[0]==='read'||call[0]==='load-member'));
});
test('expired or corrupted pending link markers reject nonce-free callbacks before exchanging a code',async()=>{
  for(const raw of [JSON.stringify({authUserId:authId,profileId:profile.id,nonce:'e'.repeat(32),createdAt:Date.now()-16*60*1000}),'{corrupted']){
    const sessionMemory=new Map([['growell_google_login_link_v1',raw]]),h=harness({sessionMemory,href:'https://app.example/?code=one'});
    await assert.rejects(h.c.finishOAuthCallback(),/oauth-link-mismatch/);
    assert.ok(!h.calls.some(call=>['exchange','verify-user','read','load-member'].includes(call[0])));
    assert.ok(h.calls.some(call=>call[0]==='clean-url'&&!call[1].includes('code=')));
  }
  const ordinary=harness({href:'https://app.example/?code=normal-login'});
  await ordinary.c.finishOAuthCallback();assert.equal(ordinary.calls.filter(call=>call[0]==='exchange').length,1);
});
test('unreadable pending-link storage stops a callback without removing the cached record key',async()=>{
  const h=harness({href:'https://app.example/?code=one'}),cached=await cacheMember(h);
  h.c.sessionStorage.getItem=()=>{throw new Error('storage unavailable');};
  await assert.rejects(h.c.finishOAuthCallback(),/oauth-link-mismatch/);
  assert.ok(!h.calls.some(call=>call[0]==='exchange'||call[0]==='signout'||call[0]==='read'));
  assert.equal(h.memory.get('growell_session'),cached.saved);
});
