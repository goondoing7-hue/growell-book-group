'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{webcrypto}=require('node:crypto');
const Access=require('../googleRecordAccess.js'),Private=require('../privateCrypto.js'),OAuth=require('../oauthDomain.js'),MemberAccess=require('../memberAccess.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const authId='11111111-2222-4333-8444-555555555555',profile={id:'u-existing',auth_user_id:authId,login_id:'existing',name:'독서회원',pbkdf2_salt:'0123456789abcdef0123456789abcdef',approval_status:'approved',is_deleted:false,is_admin:false};
const user={id:authId,identities:[{provider:'google'},{provider:'email'}],email:'existing@growell.internal',app_metadata:{providers:['google','email']}};
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(options={}){
  const material=await Private.exportKey(await Private.newKey()),key=await Private.importKey(material),identity={id:'entry-original',userId:profile.id,bookId:'emotion',createdAt:1760000000000};
  const record={...identity,...await Private.create(identity,key,await Private.newKey(),'기존 기록 보존')},rows=[{id:record.id,user_id:record.userId,iv:record.iv,data:record.data}];
  const memory=new Map(),sessionMemory=new Map(),calls=[],logs=[];let storedKey=options.missing?null:material;
  const url=new URL('https://growell-book.vercel.app/#/login');
  const c={Promise,URL,URLSearchParams,JSON,Date,Error,Uint8Array,TextEncoder,TextDecoder,atob,btoa,crypto:webcrypto,
    setTimeout:()=>0,clearTimeout(){},console:Object.fromEntries(['log','warn','error','info','debug'].map(m=>[m,(...args)=>logs.push(args)])),
    STATE:{users:{},posts:{},comments:{},privateEntries:{},habits:{},readingMeta:{},readingLogs:{},worksheets:{},materialNotes:{}},SESSION:null,authMode:'login',authFlowEpoch:0,saveSessionEpoch:0,
    memberLoadState:{privateEntries:'ready'},sharedPostsLoadState:'idle',BOOTING:false,BOOT_FAILED:false,pendingPrivateRecovery:null,privateRecoveryBusy:false,saving:false,activeSave:null,saveQueue:[],composerDraftPending:0,composerDrafts:{},composerDraftWrites:{},editingAnnouncement:false,
    GrowellGoogleRecordAccess:Access,GrowellPrivateCrypto:Private,GrowellOAuth:OAuth,GrowellMemberAccess:MemberAccess,GrowellPasswordHint:require('../passwordHint.js'),
    SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-key',keyFromB64:Private.importKey,keyToB64:Private.exportKey,
    loginEmailFor:id=>id+'@growell.internal',captureComposerDraft(){},composerDraftStatus(){},
    document:{querySelectorAll:()=>[],querySelector:()=>null,getElementById:()=>null,addEventListener(){}},navigator:{onLine:true},addEventListener(){},
    location:{href:url.href,hash:url.hash,pathname:url.pathname,search:'',assign(value){calls.push(['redirect',value]);}},history:{replaceState(a,b,value){calls.push(['clean-url',value]);c.location.hash=value;}},
    localStorage:{get length(){return memory.size;},key:i=>[...memory.keys()][i]||null,getItem:k=>memory.has(k)?memory.get(k):null,setItem(k,v){if(options.writeFailure&&(k.startsWith('growell_draft_v33:')||options.writeFailure==='all'&&k.startsWith('growell_draft_key_recovery_v1:')))throw new Error('storage unavailable');memory.set(k,v);},removeItem:k=>memory.delete(k)},
    sessionStorage:{getItem:k=>sessionMemory.get(k)||null,setItem:(k,v)=>sessionMemory.set(k,v),removeItem:k=>sessionMemory.delete(k)},
    fetch:async()=>({ok:true,json:async()=>({external:{google:true}})}),render(){calls.push(['render']);},showToast(message){calls.push(['toast',message]);},esc:value=>String(value),
    mapProfileRow:r=>({id:r.id,name:r.name,authUserId:r.auth_user_id,salt:r.pbkdf2_salt,loginId:r.login_id,approvalStatus:r.approval_status,isDeleted:r.is_deleted,isAdmin:r.is_admin}),
    resetSaveSession(){c.saveSessionEpoch++;return Promise.resolve();},clearMemberSession(){if(c.cancelMemberSessionRestore)c.cancelMemberSessionRestore();c.SESSION=null;c.googleRecordAccessTask=null;c.googleRecordAccessPrepared=null;c.STATE.privateEntries={};if(!c.googleDraftMigrationBlocked)memory.delete('growell_session');},
    loadMemberData:async()=>{calls.push(['load']);c.STATE.privateEntries[record.id]=clone(record);return true;},
    decryptText:async(key,iv,data)=>new TextDecoder().decode(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(iv,'base64')},key,Buffer.from(data,'base64'))),
    encryptText:async(key,text)=>{const iv=webcrypto.getRandomValues(new Uint8Array(12)),cipher=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text));return {iv:Buffer.from(iv).toString('base64'),data:Buffer.from(cipher).toString('base64')};}
  };
  c.sb={auth:{getUser:async()=>{calls.push(['user']);return options.getUser?options.getUser():{data:{user},error:null};},getSession:async()=>({data:{session:{user}},error:null}),signOut:async()=>{calls.push(['signout']);return {};},signInWithOAuth:async input=>{calls.push(['oauth',input]);return {data:{url:'https://project.supabase.co/auth/v1/authorize?provider=google'}};},signInWithPassword:async()=>{calls.push(['password']);return {data:{user}};}},
    from(table){const q={select:()=>q,eq:()=>q,order:()=>q,maybeSingle:async()=>({data:clone(profile),error:null}),range:async(start,end)=>({data:clone(rows.slice(start,end+1)),count:rows.length,error:null})};return q;},
    rpc:async(name,args)=>{calls.push(['rpc',name,clone(args||{})]);if(options.rpc)return options.rpc(name,args,{material,profile,record});
      if(name==='growell_oauth_profile')return {data:options.newMember?{status:'new',profile:null,envelope:null}:{status:'ready',profile:clone(profile),envelope:{invalid:'unused v1 envelope'}}};
      if(name==='growell_google_register')return {data:{status:'approval-required',profile:{...profile,approval_status:'pending'},keyB64:null,keyDigest:null,accessId:null,version:1}};
      if(name==='growell_google_record_access_prepare'){if(options.conflict)return {error:{code:'40001'}};storedKey=args.p_key_b64;}
      if(name==='growell_google_record_access_rotate')storedKey=args.p_key_b64;
      return {data:{status:storedKey?'ready':'missing',profile:clone(profile),keyB64:storedKey,keyDigest:storedKey?await Access.digest(storedKey):null,accessId:storedKey?'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee':null,version:1}};
    }};
  c.window=c;vm.createContext(c);
  vm.runInContext(section('/* ---------------- OAuth login and private-space unlock ---------------- */','/* ---------------- render: login ---------------- */'),c);
  vm.runInContext(section('function bootApp(){','function currentUser(){'),c);
  vm.runInContext(section('async function migratePrivateDraftKeys(','/* Call only after a successful server save.'),c);
  function pending(status='ready'){c.oauthPending={status,authUserId:authId,profile:status==='new'?null:clone(profile),name:'독서회원'};}
  function logged(){const member=c.mapProfileRow(profile);c.STATE.users[member.id]=member;c.SESSION={userId:member.id,name:member.name,keyB64:material,authKind:'password'};memory.set('growell_session',JSON.stringify(c.SESSION));}
  return {c,memory,sessionMemory,calls,logs,material,record,rows,pending,logged};
}
test('Google account screens use nickname only for signup and never ask for a record password',async()=>{
  const h=await fixture();for(const status of ['new','ready','native','legacy']){h.pending(status);const markup=h.c.oauthMemberHtml();assert.doesNotMatch(markup,/type="password"|oauth-password|oauth-confirm|나의 기록 열기|현재 GROWELL 비밀번호/);assert.equal(markup.includes('id="oauth-name"'),status==='new');assert.match(markup,/기존 아이디로 로그인/);}
});
test('a verified Google member opens their original records without native password authentication',async()=>{
  const h=await fixture();h.pending();assert.equal(await h.c.completeGoogleOnlyMember(''),true);assert.equal(h.c.SESSION.keyB64,h.material);assert.equal(h.c.SESSION.userId,profile.id);
  assert.equal((await Private.read(h.record,await Private.importKey(h.c.SESSION.keyB64))).text,'기존 기록 보존');assert.ok(!h.calls.some(c=>c[0]==='password'));
  assert.equal(JSON.parse(h.memory.get('growell_session')).keyB64,h.material);assert.ok(!JSON.stringify(h.logs).includes(h.material));
});
test('missing server access offers migration/retry and preserves the existing ID login escape',async()=>{
  const h=await fixture({missing:true});h.pending();assert.equal(await h.c.completeGoogleOnlyMember(''),false);assert.equal(h.c.SESSION,null);assert.equal(h.c.oauthPending.recordAccessState,'missing');assert.match(h.c.oauthMessage,/기존에 로그인한 기기/);assert.match(h.c.oauthMemberHtml(),/연결 다시 확인/);
  assert.ok(!h.calls.some(c=>c[0]==='rpc'&&/register|prepare|rotate/.test(c[1])));await h.c.cancelOAuth();assert.equal(h.c.authOtherAccount,true);
});
test('new Google signup sends a nickname and returns approval confirmation without a password step',async()=>{
  const h=await fixture({newMember:true});h.pending('new');assert.equal(await h.c.completeGoogleOnlyMember('새회원'),false);assert.equal(h.c.authMode,'signup-complete');assert.equal(h.c.SESSION,null);assert.equal(h.c.oauthPending,null);
  const args=h.calls.find(c=>c[0]==='rpc'&&c[1]==='growell_google_register')[2];assert.equal(args.p_name,'새회원');assert.deepEqual(Object.keys(args).sort(),['p_key_b64','p_name','p_salt']);assert.ok(!h.calls.some(c=>c[0]==='password'));
});
test('Google restoration is independent of an unused damaged v1 password envelope',async()=>{
  const h=await fixture();await h.c.prepareOAuthMember(user,h.c.authFlowEpoch);assert.equal(h.c.SESSION.keyB64,h.material);assert.equal(h.c.oauthPending,null);assert.ok(!h.calls.some(c=>c[0]==='password'));
});
test('background enrollment requires a ready own session and skips recovery, drafts, writes and changed epochs',async()=>{
  for(const block of [c=>c.memberLoadState.privateEntries='error',c=>c.pendingPrivateRecovery={},c=>c.privateRecoveryBusy=true,c=>c.saving=true,c=>c.composerDraftPending=1,c=>c.saveQueue.push({}),c=>c.composerDrafts.d={userId:profile.id,unsaved:true}]){
    const h=await fixture();h.logged();block(h.c);assert.equal(await h.c.maybePrepareGoogleRecordAccess(),false);assert.ok(!h.calls.some(c=>c[0]==='rpc'));
  }
  const h=await fixture();h.logged();assert.equal(await h.c.maybePrepareGoogleRecordAccess(),true);assert.equal(h.calls.filter(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_prepare').length,1);
  await h.c.maybePrepareGoogleRecordAccess();assert.equal(h.calls.filter(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_prepare').length,1);
});
test('a delayed Google verification cannot reopen a logged out or switched session',async()=>{
  for(const change of [c=>{c.authFlowEpoch++;c.SESSION=null;},c=>{c.saveSessionEpoch++;},c=>{c.oauthPending={};}]){
    const gate=deferred(),h=await fixture({getUser:()=>gate.promise});h.pending();const result=h.c.completeGoogleOnlyMember('');change(h.c);gate.resolve({data:{user},error:null});assert.equal(await result,false);assert.equal(h.c.SESSION,null);assert.ok(!h.calls.some(c=>c[0]==='rpc'));assert.equal(h.memory.has('growell_session'),false);
  }
});
test('starting Google OAuth retains only the original session cache and excludes keys from URLs and markers',async()=>{
  const h=await fixture();h.logged();const before=h.memory.get('growell_session');h.c.oauthProviders={state:'ready',google:true,kakao:false};await h.c.startOAuth('google');
  assert.equal(h.memory.get('growell_session'),before);assert.equal(h.c.SESSION,null);assert.ok(h.calls.some(c=>c[0]==='redirect'));
  assert.ok(!JSON.stringify([...h.sessionMemory]).includes(h.material));assert.ok(!JSON.stringify(h.calls.filter(c=>['redirect','oauth','clean-url'].includes(c[0]))).includes(h.material));
});
test('stale cached Google keys are replaced by the proved server key before record loading',async()=>{
  const h=await fixture(),old=await Private.exportKey(await Private.newKey());h.memory.set('growell_session',JSON.stringify({userId:profile.id,keyB64:old,name:'기존 이름'}));
  assert.equal(await h.c.restoreMemberSession(),true);assert.equal(h.c.SESSION.keyB64,h.material);assert.equal(JSON.parse(h.memory.get('growell_session')).keyB64,h.material);
  assert.ok(!h.calls.some(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_prepare'));assert.equal(h.calls.filter(c=>c[0]==='load').length,1);
});
test('missing server access provisions the exact cached key only after proof; stale keys remain closed and preserved',async()=>{
  for(const stale of [false,true]){
    const h=await fixture({missing:true}),key=stale?await Private.exportKey(await Private.newKey()):h.material,raw=JSON.stringify({userId:profile.id,keyB64:key,name:'회원'});h.memory.set('growell_session',raw);
    assert.equal(await h.c.restoreMemberSession(),!stale);
    if(stale){assert.equal(h.c.SESSION,null);assert.equal(h.memory.get('growell_session'),raw);assert.ok(!h.calls.some(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_prepare'));}
    else assert.equal(h.calls.find(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_prepare')[2].p_key_b64,h.material);
  }
});
async function staleDraft(h,old){
  const name='growell_draft_v33:'+JSON.stringify([profile.id,'emotion','mine','new']),draft={userId:profile.id,bookId:'emotion',type:'mine',editId:null,revision:1,updatedAt:1760000000000,variants:{text:{body:'작성 중이던 원본 글'}}};
  const box=await h.c.encryptText(await Private.importKey(old),JSON.stringify(draft)),raw=JSON.stringify({v:1,...box});h.memory.set(name,raw);return {name,draft,raw};
}
test('switching a stale cache safely rewraps existing local drafts before discarding the old key',async()=>{
  const h=await fixture(),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old);h.memory.set('growell_session',JSON.stringify({userId:profile.id,keyB64:old}));
  assert.equal(await h.c.restoreMemberSession(),true);const box=JSON.parse(h.memory.get(draft.name));assert.deepEqual(JSON.parse(await h.c.decryptText(await Private.importKey(h.material),box.iv,box.data)),draft.draft);assert.equal(h.c.SESSION.keyB64,h.material);
});
test('failed local draft rewrapping preserves encrypted draft and old cache key and does not open a session',async()=>{
  for(const callback of [false,true]){
    const h=await fixture({writeFailure:true}),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old),cached=JSON.stringify({userId:profile.id,keyB64:old});h.memory.set('growell_session',cached);
    if(callback){h.pending();assert.equal(await h.c.completeGoogleOnlyMember(''),false);}else assert.equal(await h.c.restoreMemberSession(),false);
    assert.equal(h.c.SESSION,null);assert.equal(h.memory.get('growell_session'),cached);assert.equal(h.memory.get(draft.name),draft.raw);assert.ok(!h.calls.some(c=>c[0]==='load'));
  }
});
test('a failed draft write protects its final key before the ID-login fallback clears the original cache',async()=>{
  const options={writeFailure:true},h=await fixture(options),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old),cached=JSON.stringify({userId:profile.id,keyB64:old});h.memory.set('growell_session',cached);h.pending();
  assert.equal(await h.c.completeGoogleOnlyMember(''),false);assert.equal(h.c.SESSION,null);assert.equal(h.memory.get('growell_session'),cached);
  const backupPath='growell_draft_key_recovery_v1:'+encodeURIComponent(profile.id),backup=h.memory.get(backupPath);assert.ok(backup);assert.ok(!backup.includes(old));assert.ok(!backup.includes('작성 중이던 원본 글'));
  assert.deepEqual(await Access.openDraftKeys(h.c.mapProfileRow(profile),h.material,JSON.parse(backup)),[old]);
  await h.c.cancelOAuth();assert.equal(h.c.authOtherAccount,true);assert.equal(h.memory.has('growell_session'),false);assert.equal(h.memory.get(draft.name),draft.raw);assert.equal(h.memory.get(backupPath),backup);
  // The existing ID-login path can later decrypt the protected recovery box and
  // migrate the draft after local storage becomes writable again.
  options.writeFailure=false;h.c.authTransition=Promise.resolve();h.c.deriveKey=async()=>Private.importKey(h.material);h.c.completePendingPrivateRecovery=async()=>true;h.c.syncGoogleLoginAfterPassword=async()=>true;h.c.currentRoute=()=>({view:'login'});
  vm.runInContext(section('function doLogin(','function doLogout('),h.c);await h.c.doLogin(profile.login_id,'synthetic-password-never-sent-to-record-RPC');
  assert.equal(h.c.SESSION.keyB64,h.material);assert.equal(h.memory.has(backupPath),false);const box=JSON.parse(h.memory.get(draft.name));assert.deepEqual(JSON.parse(await h.c.decryptText(await Private.importKey(h.material),box.iv,box.data)),draft.draft);
});
test('a fresh Google connection restores the protected draft key even after its old session cache was cleared',async()=>{
  const options={writeFailure:true},h=await fixture(options),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old);h.memory.set('growell_session',JSON.stringify({userId:profile.id,keyB64:old}));h.pending();
  assert.equal(await h.c.completeGoogleOnlyMember(''),false);await h.c.cancelOAuth();options.writeFailure=false;h.pending();
  assert.equal(await h.c.completeGoogleOnlyMember(''),true);const box=JSON.parse(h.memory.get(draft.name));assert.deepEqual(JSON.parse(await h.c.decryptText(await Private.importKey(h.material),box.iv,box.data)),draft.draft);
});
test('if even encrypted key backup fails, all fallback paths keep the final old key and require a retry',async()=>{
  const h=await fixture({writeFailure:'all'}),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old),cached=JSON.stringify({userId:profile.id,keyB64:old});h.memory.set('growell_session',cached);h.pending();
  assert.equal(await h.c.completeGoogleOnlyMember(''),false);assert.ok(h.c.googleDraftMigrationBlocked);assert.equal(h.memory.get('growell_session'),cached);
  assert.equal(await h.c.cancelOAuth(),false);h.c.authTransition=Promise.resolve();vm.runInContext(section('function doLogin(','function doLogout('),h.c);assert.equal(await h.c.doLogin('another-member','synthetic'),false);assert.ok(!h.calls.some(c=>c[0]==='password'));
  vm.runInContext(section('function clearMemberSession(){','function memberDataStatusHtml('),h.c);h.c.clearMemberSession();assert.equal(h.memory.get('growell_session'),cached);assert.equal(h.memory.get(draft.name),draft.raw);assert.equal(h.c.SESSION,null);
});
test('an external Auth account change cannot erase another owner\'s final protected cache key',async()=>{
  const h=await fixture({writeFailure:'all'}),old=await Private.exportKey(await Private.newKey()),draft=await staleDraft(h,old),cached=JSON.stringify({userId:profile.id,keyB64:old});h.memory.set('growell_session',cached);h.pending();
  assert.equal(await h.c.completeGoogleOnlyMember(''),false);const count=h.calls.filter(c=>c[0]==='rpc').length;
  h.c.authFlowEpoch++;h.c.oauthPending={status:'ready',authUserId:'99999999-2222-4333-8444-555555555555',profile:{...profile,id:'other',auth_user_id:'99999999-2222-4333-8444-555555555555'}};
  assert.equal(await h.c.completeGoogleOnlyMember(''),false);assert.equal(h.c.SESSION,null);assert.equal(h.memory.get('growell_session'),cached);assert.equal(h.memory.get(draft.name),draft.raw);assert.equal(h.c.googleDraftMigrationBlocked.owner,profile.id);assert.equal(h.calls.filter(c=>c[0]==='rpc').length,count);
});
test('ordinary key enrollment cannot fall back to rotation on a server conflict',async()=>{
  const h=await fixture({conflict:true});h.logged();assert.equal(await h.c.maybePrepareGoogleRecordAccess(),false);assert.ok(!h.calls.some(c=>c[0]==='rpc'&&c[1]==='growell_google_record_access_rotate'));assert.equal(h.c.SESSION.keyB64,h.material);
});
test('formal recovery is the only native-login path that requests CAS rotation',async()=>{
  const recovery=html.slice(html.indexOf('async function completePendingPrivateRecovery('),html.indexOf('function privateRecoveryHtml('));
  assert.match(recovery,/googleRecordRecoveryCompleted=\{session:SESSION,keyB64:keyB64\}/);
  const sync=section('async function syncGoogleLoginAfterPassword(','async function connectExistingGoogleLogin(');
  assert.match(sync,/if\(recoveredRecords===true\)await googleRecordAccessClient\(\)\.rotate\(context\);else await googleRecordAccessClient\(\)\.prepare\(context\)/);
  const c={SESSION:{userId:profile.id,keyB64:'synthetic-current-key'},STATE:{users:{[profile.id]:{id:profile.id,authUserId:authId,salt:profile.pbkdf2_salt,approvalStatus:'approved'}}},saveSessionEpoch:1,memberLoadState:{privateEntries:'ready'},GrowellGoogleRecordAccess:{},sb:{auth:{getUser:async()=>({data:{user}})},rpc:async()=>({data:{}})},rememberVerifiedLoginChoice(){},googleMemberIdentity:()=>true,passwordMemberIdentity:()=>true,GrowellOAuth:{createLinkedVault:async()=>({envelope:{}})},checkedLinkedVault:async()=>({}),googleRecordAccessBlocked:()=>false,googleRecordSessionContext:()=>({current:()=>true}),googleRecordAccessClient:()=>({prepare:async()=>c.calls.push('prepare'),rotate:async()=>c.calls.push('rotate')}),calls:[]};
  vm.createContext(c);vm.runInContext(sync,c);await c.syncGoogleLoginAfterPassword('not-exported',()=>{},false);await c.syncGoogleLoginAfterPassword('not-exported',()=>{},true);assert.deepEqual(c.calls,['prepare','rotate']);
});
