'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const OAuth=require('../oauthDomain.js'),Private=require('../privateCrypto.js'),MemberAccess=require('../memberAccess.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const authId='11111111-2222-3333-4444-555555555555';
const profile={id:'u-social',auth_user_id:authId,login_id:'social_test',name:'회원',is_admin:false,pbkdf2_salt:'0123456789abcdef0123456789abcdef',is_deleted:false,approval_status:'approved'};
const user={id:authId,identities:[{provider:'google'}],app_metadata:{providers:['google']}};
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
function harness(options={}){
  const memory=options.memory||new Map(),sessionMemory=new Map(),authUser=options.user||user,calls=[],logs=[],nodes={},listeners={},timers=new Map();let timerId=0;
  const url=new URL(options.href||'https://app.example/'),c={Promise,URL,URLSearchParams,JSON,Date,
    setTimeout(callback,delay=0){if(delay<1000)return setTimeout(callback,delay);const id={id:++timerId};timers.set(id,{callback,delay});return id;},
    clearTimeout(id){if(!timers.delete(id))clearTimeout(id);},
    console:Object.fromEntries(['log','info','warn','error','debug'].map(method=>[method,(...args)=>logs.push(args)])),Uint8Array,atob,
    STATE:{users:{},posts:{},comments:{},privateEntries:{},habits:{},readingMeta:{},readingLogs:{},worksheets:{},materialNotes:{}},SESSION:null,
    authFlowEpoch:0,saveSessionEpoch:0,sharedPostsLoadState:'idle',BOOTING:true,BOOT_FAILED:false,
    GrowellOAuth:OAuth,GrowellMemberAccess:MemberAccess,keyFromB64:Private.importKey,SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-test-key',authMode:'login',
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
      signOut:async()=>{calls.push(['signout']);return {};},
      signInWithOAuth:async input=>{calls.push(['oauth',input]);return {data:{url:'https://project.supabase.co/auth/v1/authorize?provider='+input.provider}};}
    },from(table){const query={select(){return query;},eq(key,value){calls.push(['read',table,key,value]);return query;},maybeSingle:async()=>options.getProfile?options.getProfile():({data:options.profile===undefined?profile:options.profile,error:null})};return query;},
    rpc:async(name,args)=>{calls.push(['rpc',name,args]);if(options.rpc)return options.rpc(name,args);return {data:{status:'new',profile:null,envelope:null}};}}
  };
  c.window=c;
  vm.createContext(c);
  vm.runInContext(section('/* ---------------- OAuth login and private-space unlock ---------------- */','/* ---------------- render: login ---------------- */'),c);
  vm.runInContext(section('function bootApp(){','function currentUser(){'),c);
  return {c,memory,calls,nodes,logs,timers,listeners,
    dispatch(type,target='window'){for(const callback of listeners[target+':'+type]||[])callback({type});},
    async fireTimer(){const entry=timers.entries().next().value;assert.ok(entry,'a retry should be scheduled');timers.delete(entry[0]);await entry[1].callback();await settle();return entry[1].delay;}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle(){await new Promise(resolve=>setTimeout(resolve,5));}
async function cacheMember(h,extra={}){const keyB64=await Private.exportKey(await Private.newKey());const saved=JSON.stringify({userId:profile.id,name:'old name',keyB64,authKind:'password',...extra});h.memory.set('growell_session',saved);return {keyB64,saved};}
test('hidden social entry points make no provider probe or launch and leave only native login and signup',async()=>{
  const {c,calls}=harness({guest:true});
  vm.runInContext(section('function loginHtml(){','function profilePhotoPickerHtml('),c);
  vm.runInContext(section('function signupFormHtml(){','function forgotPasswordFormHtml('),c);
  c.profilePhotoPickerHtml=()=>'';c.pendingSignupAvatar=null;
  await c.loadOAuthProviderSettings();
  c.oauthProviders={state:'ready',google:true,kakao:true};
  for(const provider of ['google','kakao'])await c.startOAuth(provider);
  assert.equal(c.SOCIAL_AUTH_VISIBLE,false);
  assert.equal(c.socialSignupStatusHtml(),'');
  for(const mode of ['login','signup']){
    c.authMode=mode;const markup=c.loginHtml();
    assert.doesNotMatch(markup,/data-oauth-provider|간편|Google|카카오|일반 회원가입|auth-email-heading/);
    assert.match(markup,/>회원가입<\/button>/);
    assert.match(markup,mode==='login'?/id="li-pw"/:/id="su-pw"/);
  }
  assert.ok(!calls.some(call=>['provider-settings','oauth','redirect','signout','clear'].includes(call[0])));
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
  assert.ok(!fresh.calls.some(call=>['oauth','provider-settings','signout'].includes(call[0])));
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
  c.oauthPending={status:'new',authUserId:authId};
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
