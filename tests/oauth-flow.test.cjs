'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const OAuth=require('../oauthDomain.js'),Private=require('../privateCrypto.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const authId='11111111-2222-3333-4444-555555555555';
const profile={id:'u-social',auth_user_id:authId,login_id:'social_test',name:'회원',is_admin:false,pbkdf2_salt:'0123456789abcdef0123456789abcdef',is_deleted:false};
const user={id:authId,identities:[{provider:'google'}],app_metadata:{providers:['google']}};
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
function harness(options={}){
  const memory=new Map(),calls=[],nodes={},c={Promise,URL,JSON,Date,setTimeout,clearTimeout,console,Uint8Array,atob,
    STATE:{users:{},posts:{},comments:{},privateEntries:{},habits:{},readingMeta:{},readingLogs:{},worksheets:{},materialNotes:{}},SESSION:null,
    authFlowEpoch:0,saveSessionEpoch:0,sharedPostsLoadState:'idle',BOOTING:true,BOOT_FAILED:false,
    GrowellOAuth:OAuth,keyFromB64:Private.importKey,SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-test-key',authMode:'login',
    location:{href:options.href||'https://app.example/',hash:'#/',assign(url){calls.push(['redirect',url]);}},
    history:{replaceState(a,b,url){calls.push(['clean-url',url]);}},
    localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
    sessionStorage:{getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)},
    document:{querySelector(){return null;},querySelectorAll(){return [];},getElementById:id=>nodes[id]||null},
    fetch:async()=>({ok:true,json:async()=>({external:{google:true,kakao:false}})}),
    render(){calls.push(['render']);},showToast(message){calls.push(['toast',message]);},esc:value=>String(value),
    mapProfileRow:r=>({id:r.id,name:r.name,authUserId:r.auth_user_id,salt:r.pbkdf2_salt,isAdmin:r.is_admin,loginId:r.login_id}),
    resetSaveSession(){c.saveSessionEpoch++;return Promise.resolve();},clearMemberSession(){c.SESSION=null;c.STATE.privateEntries={};calls.push(['clear']);},
    loadMemberData:async()=>{calls.push(['load-member']);return true;},
    sb:{auth:{getSession:async()=>({data:{session:options.guest?null:{user}}}),getUser:async()=>options.invalidAuth?{error:new Error('expired')}:{data:{user},error:null},
      onAuthStateChange(callback){c.authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};},
      exchangeCodeForSession:async code=>{calls.push(['exchange',code]);return {error:null};},
      signOut:async()=>{calls.push(['signout']);return {};},
      signInWithOAuth:async input=>{calls.push(['oauth',input]);return {data:{url:'https://project.supabase.co/auth/v1/authorize?provider=google'}};}
    },from(table){const query={select(){return query;},eq(key,value){calls.push(['read',table,key,value]);return query;},maybeSingle:async()=>({data:options.profile===undefined?profile:options.profile,error:null})};return query;},
    rpc:async(name,args)=>{calls.push(['rpc',name,args]);if(options.rpc)return options.rpc(name,args);return {data:{status:'new',profile:null,envelope:null}};}}
  };
  vm.createContext(c);
  vm.runInContext(section('/* ---------------- OAuth login and private-space unlock ---------------- */','/* ---------------- render: login ---------------- */'),c);
  vm.runInContext(section('function bootApp(){','function currentUser(){'),c);
  return {c,memory,calls,nodes};
}
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
test('PKCE callback is exchanged exactly once and code is removed from visible URL',async()=>{
  const {c,calls}=harness({href:'https://app.example/?code=one-time-code',profile:null});await c.bootApp();
  assert.equal(calls.filter(v=>v[0]==='exchange').length,1);assert.ok(calls.some(v=>v[0]==='clean-url'&&!v[1].includes('code=')));assert.equal(c.oauthPending.status,'new');
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
  const {c,calls}=harness();await c.loadOAuthProviderSettings();await c.startOAuth('kakao');assert.ok(!calls.some(v=>v[0]==='oauth'));await c.startOAuth('google');
  assert.ok(calls.some(v=>v[0]==='redirect'&&v[1].startsWith('https://project.supabase.co/auth/v1/authorize')));
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
