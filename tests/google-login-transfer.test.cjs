'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!global.crypto)Object.defineProperty(global,'crypto',{value:crypto.webcrypto});
const transfer=require('../googleLoginTransfer.js');
const TARGET='11111111-1111-4111-8111-111111111111',SOURCE='22222222-2222-4222-8222-222222222222';
const GOOGLE='33333333-3333-4333-8333-333333333333',OTHER='44444444-4444-4444-8444-444444444444';
const clone=v=>JSON.parse(JSON.stringify(v));
function emailIdentity(id,address){return {identity_id:'55555555-5555-4555-8555-555555555555',id,provider:'email',user_id:id,identity_data:{sub:id,email:address,email_verified:true}};}
function googleIdentity(id=GOOGLE,subject='fixture-google-subject',owner=SOURCE,address='fixture@example.test'){return {identity_id:id,id:subject,provider:'google',provider_id:subject,user_id:owner,identity_data:{sub:subject,email:address,email_verified:true}};}
function fixture(){
  const data=new Map(),events=[];
  let time=1792670400000,sourceUnavailable=false,nativeUnavailable=false,unlinkMode='success',rollbackMode='success',storageMode='normal';
  let nativeUser={id:TARGET,email:'fixture@growell.internal',email_confirmed_at:'2026-10-22T00:00:00Z',identities:[emailIdentity(TARGET,'fixture@growell.internal')]};
  let sourceUser={id:SOURCE,email:'fixture@example.test',email_confirmed_at:'2026-10-22T00:00:00Z',identities:[emailIdentity(SOURCE,'fixture@example.test'),googleIdentity()]};
  let nativeContext={authUserId:TARGET,profileId:'u-fixture-member',profileSalt:'a'.repeat(32),keyDigest:'b'.repeat(64)};
  let rpcResult={status:'new',profile:null,envelope:null};
  const storage={getItem:k=>data.has(k)?data.get(k):null,setItem(k,v){if(storageMode==='throw')throw new Error('private transport detail');if(storageMode==='drop')return;data.set(k,v);},removeItem:k=>data.delete(k)};
  const nativeClient={auth:{
    async getUser(){if(nativeUnavailable)throw new Error('secret-token');return {data:{user:clone(nativeUser)}};},
    async exchangeCodeForSession(code){events.push(['native-exchange',code]);return {data:{session:{}}};},
    async linkIdentity(input){events.push(['native-link',clone(input)]);return {data:{url:'https://accounts.google.test/native'}};},
    async unlinkIdentity(identity){events.push(['native-unlink',clone(identity)]);if(rollbackMode==='fail')return {error:new Error('secret')};if(rollbackMode==='unknown'){nativeUnavailable=true;throw new Error('secret');}nativeUser.identities=nativeUser.identities.filter(i=>i.identity_id!==identity.identity_id);if(rollbackMode==='lost')throw new Error('lost response');return {};}
  }};
  const proofClient={auth:{
    async getUser(){if(sourceUnavailable)throw new Error('private-google-token');return {data:{user:clone(sourceUser)}};},
    async signInWithOAuth(input){events.push(['proof-login',clone(input)]);return {data:{url:'https://accounts.google.test/proof'}};},
    async exchangeCodeForSession(code){events.push(['proof-exchange',code]);return {data:{session:{}}};},
    async unlinkIdentity(identity){events.push(['source-unlink',clone(identity)]);if(unlinkMode==='fail')return {error:new Error('secret')};if(unlinkMode==='unknown'){sourceUnavailable=true;throw new Error('secret');}sourceUser.identities=sourceUser.identities.filter(i=>i.identity_id!==identity.identity_id);if(unlinkMode==='lost')throw new Error('lost response');return {};},
    async linkIdentity(input){events.push(['source-link',clone(input)]);return {data:{url:'https://accounts.google.test/restore'}};},
    async signOut(input){events.push(['proof-signout',clone(input)]);return {};}
  },async rpc(name){events.push(['proof-rpc',name]);return {data:clone(rpcResult)};}};
  const options={nativeClient,createProofClient:()=>proofClient,storage,now:()=>time,getNativeContext:()=>clone(nativeContext),buildRedirectUrl:({nonce,step})=>'https://growell.test/?google-login-transfer='+nonce+'&transfer-step='+step};
  const f={data,events,storage,nativeClient,proofClient,options,engine:transfer.create(options),get nativeUser(){return nativeUser;},set nativeUser(v){nativeUser=v;},get sourceUser(){return sourceUser;},set sourceUser(v){sourceUser=v;},get nativeContext(){return nativeContext;},set rpc(v){rpcResult=v;},set unlinkMode(v){unlinkMode=v;},set rollbackMode(v){rollbackMode=v;},set storageMode(v){storageMode=v;},set sourceUnavailable(v){sourceUnavailable=v;},set nativeUnavailable(v){nativeUnavailable=v;},advance(ms){time+=ms;},state(){return data.has(transfer.STORAGE_KEY)?JSON.parse(data.get(transfer.STORAGE_KEY)):null;},reopen(){this.engine=transfer.create(options);return this.engine;}};
  return f;
}
async function proven(f){const begun=await f.engine.startProof();const result=await f.engine.finishProof('temporary-proof-code',begun.nonce);assert.equal(result.stage,'confirmed');return begun.nonce;}
async function released(f){const value=await proven(f);await f.engine.confirmTransfer();return value;}
async function targetFlow(f){const value=await released(f);await f.engine.resumeLink();return value;}
function targetGoogle(f,subject='fixture-google-subject',id=OTHER){f.nativeUser.identities.push(googleIdentity(id,subject,TARGET));}
function restoredGoogle(f,subject='fixture-google-subject'){f.sourceUser.identities.push(googleIdentity(OTHER,subject,SOURCE));}
function calls(f,name){return f.events.filter(e=>e[0]===name);}

test('proof uses an isolated client and stores only bounded owner evidence',async()=>{
  const f=fixture(),before=clone(f.nativeUser),n=await proven(f),s=f.state(),raw=JSON.stringify(s);
  assert.equal(n.length,32);assert.equal(s.authUserId,TARGET);assert.equal(s.sourceAuthUserId,SOURCE);assert.equal(s.targetInitiallyUnlinked,true);
  assert.equal(s.subjectHash,crypto.createHash('sha256').update('fixture-google-subject').digest('hex'));
  for(const secret of ['fixture@example.test','fixture-google-subject','temporary-proof-code','private-google-token'])assert.ok(!raw.includes(secret));
  assert.deepEqual(f.nativeUser,before);assert.equal(calls(f,'source-unlink').length,0);assert.equal(calls(f,'native-exchange').length,0);
  const request=calls(f,'proof-login')[0][1];assert.equal(request.options.skipBrowserRedirect,true);assert.equal(request.options.queryParams.prompt,'select_account');assert.ok(request.options.redirectTo.endsWith('transfer-step=proof'));
});
test('successful transfer preserves target context and clears only the local proof login after exact callback',async()=>{
  const f=fixture(),before=clone(f.nativeContext),n=await targetFlow(f);targetGoogle(f);
  const result=await f.engine.completeNativeLink('temporary-native-code',n,'target');
  assert.equal(result.stage,'complete');assert.equal(f.state(),null);assert.deepEqual(f.nativeContext,before);assert.equal(f.sourceUser.identities.length,1);
  assert.equal(calls(f,'source-unlink')[0][1].identity_id,GOOGLE);assert.deepEqual(calls(f,'proof-signout')[0][1],{scope:'local'});
  const request=calls(f,'native-link')[0][1];assert.equal(request.options.queryParams.login_hint,'fixture@example.test');assert.equal(request.options.queryParams.prompt,'select_account');
});
test('new engine revalidates proof owner and recovers email from fresh getUser instead of storage',async()=>{
  const f=fixture();await proven(f);f.reopen();const v=await f.engine.inspect();assert.equal(v.sourceEmail,'fixture@example.test');assert.equal(v.canConfirm,true);assert.ok(!f.data.get(transfer.STORAGE_KEY).includes('@'));
});
for(const field of ['authUserId','profileId','profileSalt','keyDigest'])test('changed native '+field+' stops before unlink',async()=>{
  const f=fixture();await proven(f);f.nativeContext[field]=field==='authUserId'?SOURCE:field==='profileSalt'?'c'.repeat(32):field==='keyDigest'?'c'.repeat(64):'different-member';
  await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_native_changed'});assert.equal(calls(f,'source-unlink').length,0);assert.equal(f.state().stage,'confirmed');
});
test('native session and context UUID must both match',async()=>{
  const f=fixture();await proven(f);f.nativeUser.id=SOURCE;await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_native_changed'});assert.equal(calls(f,'source-unlink').length,0);
});
test('same client cannot be used as isolated proof authentication',async()=>{
  const f=fixture();f.options.createProofClient=()=>f.nativeClient;const engine=transfer.create(f.options);await assert.rejects(engine.startProof(),{code:'transfer_state'});assert.equal(calls(f,'proof-login').length,0);
});
for(const invalid of [
  {status:'legacy',profile:{id:'fixture'},envelope:null},
  {status:'ready',profile:{id:'fixture'},envelope:{data:'encrypted'}},
  {status:'new',profile:{id:'fixture'},envelope:null},
  {status:'new',profile:null,envelope:{data:'encrypted'}},
  {status:'new'}
])test('source must have exactly new/null profile/null envelope '+JSON.stringify(invalid),async()=>{
  const f=fixture();f.rpc=invalid;const n=await f.engine.startProof();await assert.rejects(f.engine.finishProof('code',n.nonce),{code:'transfer_source_ineligible'});assert.equal(calls(f,'source-unlink').length,0);
});
test('source profile is checked again immediately before explicit confirmation',async()=>{
  const f=fixture();await proven(f);f.rpc={status:'legacy',profile:{id:'later-member'},envelope:null};await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_source_ineligible'});assert.equal(calls(f,'source-unlink').length,0);
});
for(const change of ['same-owner','missing-email','unverified-google','unverified-email','mismatched-primary','extra-google'])test('source eligibility fails closed for '+change,async()=>{
  const f=fixture();if(change==='same-owner')f.sourceUser.id=TARGET;
  if(change==='missing-email')f.sourceUser.identities=f.sourceUser.identities.filter(i=>i.provider!=='email');
  if(change==='unverified-google')f.sourceUser.identities[1].identity_data.email_verified=false;
  if(change==='unverified-email')f.sourceUser.identities[0].identity_data.email_verified=false;
  if(change==='mismatched-primary')f.sourceUser.email='other@example.test';
  if(change==='extra-google')f.sourceUser.identities.push(googleIdentity(OTHER,'other-subject'));
  const n=await f.engine.startProof();await assert.rejects(f.engine.finishProof('code',n.nonce));assert.equal(calls(f,'source-unlink').length,0);
});
test('a changed source subject cannot be unlinked using stale proof',async()=>{
  const f=fixture();await proven(f);f.sourceUser.identities[1].identity_data.sub='changed-subject';f.sourceUser.identities[1].provider_id='changed-subject';f.sourceUser.identities[1].id='changed-subject';await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_source_changed'});assert.equal(calls(f,'source-unlink').length,0);
});
for(const mode of ['throw','drop'])test('writeahead storage '+mode+' prevents the unlink request',async()=>{
  const f=fixture();await proven(f);f.storageMode=mode;await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_storage'});assert.equal(calls(f,'source-unlink').length,0);assert.equal(f.state().stage,'confirmed');
});
test('unlink response loss is reconciled read-only without repeating a successful mutation',async()=>{
  const f=fixture();await proven(f);f.unlinkMode='lost';const v=await f.engine.confirmTransfer();assert.equal(v.stage,'relink');assert.equal(calls(f,'source-unlink').length,1);await f.engine.inspect();assert.equal(calls(f,'source-unlink').length,1);
});
test('unlink refusal preserves source and permits a fresh explicit retry',async()=>{
  const f=fixture();await proven(f);f.unlinkMode='fail';await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_unlink_failed'});assert.equal(f.state().stage,'confirmed');assert.equal(f.sourceUser.identities.length,2);assert.equal(calls(f,'proof-signout').length,0);
});
test('unknown unlink outcome keeps proof session and cannot trigger another mutation',async()=>{
  const f=fixture();await proven(f);f.unlinkMode='unknown';await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_unknown'});assert.equal(f.state().stage,'unknown');await assert.rejects(f.engine.restoreSource(),{code:'transfer_proof_unavailable'});
  const cancelled=await f.engine.cancel();assert.equal(cancelled.needsRecovery,true);assert.equal(calls(f,'source-unlink').length,1);assert.equal(calls(f,'proof-signout').length,0);assert.equal(calls(f,'source-link').length,0);
  f.sourceUnavailable=false;assert.equal((await f.engine.inspect()).stage,'confirmed');
});
test('post-unlink unknown outcome can recover to relink by reading the owned proof session',async()=>{
  const f=fixture();await proven(f);f.unlinkMode='unknown';await assert.rejects(f.engine.confirmTransfer());f.sourceUnavailable=false;f.sourceUser.identities=f.sourceUser.identities.filter(i=>i.provider!=='google');assert.equal((await f.engine.inspect()).stage,'relink');assert.equal(calls(f,'source-unlink').length,1);
});
test('cancellation before unlink clears proof only and changes no remote identities',async()=>{
  const f=fixture();await proven(f);assert.equal((await f.engine.cancel()).stage,'cancelled');assert.equal(f.state(),null);assert.equal(f.sourceUser.identities.length,2);assert.equal(calls(f,'source-unlink').length,0);assert.equal(calls(f,'proof-signout').length,1);
});
test('cancellation after unlink preserves marker and proof session for restoration',async()=>{
  const f=fixture();await released(f);assert.equal((await f.engine.cancel()).needsRecovery,true);assert.equal(f.state().stage,'relink');assert.equal(calls(f,'proof-signout').length,0);
});
test('expired pre-unlink proof cannot modify identities',async()=>{
  const f=fixture();await proven(f);f.advance(transfer.MAX_AGE+1);await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_expired'});assert.equal(calls(f,'source-unlink').length,0);await f.engine.cancel();assert.equal(f.state(),null);
});
test('expired post-unlink marker allows restoration but cannot initiate target linkage',async()=>{
  const f=fixture();await released(f);f.advance(transfer.MAX_AGE+1);await assert.rejects(f.engine.resumeLink(),{code:'transfer_expired'});assert.equal((await f.engine.restoreSource()).stage,'source');assert.equal(calls(f,'source-link').length,1);assert.equal(calls(f,'proof-signout').length,0);
});
test('source restoration accepts the same Google subject with its newly created identity UUID',async()=>{
  const f=fixture(),n=await released(f);await f.engine.restoreSource();restoredGoogle(f);assert.equal((await f.engine.completeNativeLink('restore-code',n,'source')).stage,'complete');assert.equal(f.state(),null);assert.equal(f.nativeUser.identities.filter(i=>i.provider==='google').length,0);
});
test('wrong callback nonce never exchanges a code or deletes proof state',async()=>{
  const f=fixture(),n=await f.engine.startProof();await assert.rejects(f.engine.finishProof('secret','0'.repeat(32)),{code:'transfer_callback'});assert.equal(calls(f,'proof-exchange').length,0);assert.equal(f.state().nonce,n.nonce);
});
test('wrong Google target callback persists exact unexpected identity and never claims success',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('target-code',n),{code:'transfer_target_mismatch'});
  assert.equal(f.state().stage,'target-mismatch');assert.equal(f.state().unexpectedIdentityId,OTHER);assert.equal(calls(f,'proof-signout').length,0);assert.equal(calls(f,'native-unlink').length,0);assert.equal((await f.engine.inspect()).canRestore,true);
});
test('explicit rollback unlinks only the exact observed wrong Google identity and restores source',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('target-code',n));
  const restored=await f.engine.restoreSource();assert.equal(restored.stage,'source');assert.equal(calls(f,'native-unlink').length,1);assert.equal(calls(f,'native-unlink')[0][1].identity_id,OTHER);assert.equal(f.nativeUser.identities.length,1);restoredGoogle(f);await f.engine.completeNativeLink('restore-code',n,'source');assert.equal(f.state(),null);
});
test('wrong Google rollback response loss is reconciled without a second unlink',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('code',n));f.rollbackMode='lost';assert.equal((await f.engine.restoreSource()).stage,'source');assert.equal(calls(f,'native-unlink').length,1);
});
test('wrong Google rollback refusal retains proof and exact marker',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('code',n));f.rollbackMode='fail';await assert.rejects(f.engine.restoreSource(),{code:'transfer_rollback_failed'});assert.equal(f.state().stage,'target-mismatch');assert.equal(calls(f,'source-link').length,0);assert.equal(calls(f,'proof-signout').length,0);
});
test('uncertain rollback never starts source linking or deletes recovery state',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('code',n));f.rollbackMode='unknown';await assert.rejects(f.engine.restoreSource(),{code:'transfer_unknown'});assert.equal(f.state().stage,'target-rollback');assert.equal(calls(f,'source-link').length,0);assert.equal(calls(f,'proof-signout').length,0);
});
test('additional or changed native Google identities stop rollback without mutation',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'unexpected-subject');await assert.rejects(f.engine.completeNativeLink('code',n));f.nativeUser.identities.push(googleIdentity(GOOGLE,'another-new-subject',TARGET));await assert.rejects(f.engine.restoreSource(),{code:'transfer_source_changed'});assert.equal(calls(f,'native-unlink').length,0);
});
test('callback cannot finish another target even with the expected Google subject',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f);f.nativeUser.id=SOURCE;await assert.rejects(f.engine.completeNativeLink('code',n),{code:'transfer_native_changed'});assert.equal(calls(f,'proof-signout').length,0);assert.equal(calls(f,'native-exchange').length,0);assert.equal(f.state().stage,'target');
});
test('wrong source restore account cannot be reported as restored',async()=>{
  const f=fixture(),n=await released(f);await f.engine.restoreSource();restoredGoogle(f,'wrong-restore-subject');await assert.rejects(f.engine.completeNativeLink('code',n,'source'),{code:'transfer_source_changed'});assert.equal(calls(f,'proof-signout').length,0);assert.equal(f.state().stage,'source');
});
test('errors do not expose transport tokens and malformed persistent state is retained',async()=>{
  const f=fixture();await proven(f);f.sourceUnavailable=true;await assert.rejects(f.engine.confirmTransfer(),e=>e.code==='transfer_proof_unavailable'&&!e.message.includes('private-google-token'));
  const before=f.data.get(transfer.STORAGE_KEY);f.data.set(transfer.STORAGE_KEY,'not-json');await assert.rejects(f.engine.inspect(),{code:'transfer_state'});assert.equal(f.data.get(transfer.STORAGE_KEY),'not-json');assert.ok(before);
});
test('concurrent engine commands cannot issue duplicate unlink requests',async()=>{
  const f=fixture();await proven(f);let release;const wait=new Promise(r=>release=r),original=f.proofClient.auth.getUser;f.proofClient.auth.getUser=async()=>{await wait;return original();};
  const pending=f.engine.confirmTransfer();await assert.rejects(f.engine.confirmTransfer(),{code:'transfer_busy'});release();await pending;assert.equal(calls(f,'source-unlink').length,1);
});
test('expired proof access token is refreshed once by the isolated SDK and its owner is rechecked',async()=>{
  const f=fixture();await proven(f);const original=f.proofClient.auth.getUser;let refreshed=false,refreshCount=0;
  f.proofClient.auth.getUser=async()=>refreshed?original():{error:{status:401,code:'jwt_expired'}};
  f.proofClient.auth.refreshSession=async()=>{refreshCount++;refreshed=true;return {data:{session:{}}};};
  const v=await f.engine.inspect();assert.equal(v.canConfirm,true);assert.equal(refreshCount,1);assert.equal(calls(f,'source-unlink').length,0);
});
test('refresh never substitutes a different proof owner',async()=>{
  const f=fixture();await proven(f);const original=f.proofClient.auth.getUser;let refreshed=false;
  f.proofClient.auth.getUser=async()=>refreshed?original():{error:{status:401}};
  f.proofClient.auth.refreshSession=async()=>{refreshed=true;f.sourceUser.id='66666666-6666-4666-8666-666666666666';return {data:{session:{}}};};
  await assert.rejects(f.engine.confirmTransfer());assert.equal(calls(f,'source-unlink').length,0);assert.equal(f.state().stage,'confirmed');
});
test('network proof failures do not refresh, sign out, or clear pending recovery',async()=>{
  const f=fixture();await released(f);let count=0;f.proofClient.auth.getUser=async()=>{throw {status:503,code:'network_error'};};f.proofClient.auth.refreshSession=async()=>{count++;return {};};
  await assert.rejects(f.engine.restoreSource(),{code:'transfer_proof_unavailable'});assert.equal(count,0);assert.equal(f.state().stage,'relink');assert.equal(calls(f,'proof-signout').length,0);
});
test('revoked proof refresh stops safely without retry loops',async()=>{
  const f=fixture();await released(f);let count=0;f.proofClient.auth.getUser=async()=>({error:{status:401,code:'jwt_expired'}});f.proofClient.auth.refreshSession=async()=>{count++;return {error:{code:'refresh_token_not_found'}};};
  await assert.rejects(f.engine.restoreSource(),{code:'transfer_proof_unavailable'});assert.equal(count,1);assert.equal(calls(f,'source-link').length,0);assert.ok(f.state());
});
test('target completion is independently provable after the old proof session is revoked',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f);f.sourceUnavailable=true;
  const v=await f.engine.inspect();assert.equal(v.canComplete,true);assert.equal(v.canRestore,false);
  f.proofClient.auth.signOut=async()=>({error:{name:'AuthSessionMissingError'}});
  assert.equal((await f.engine.completeNativeLink(undefined,n)).stage,'complete');assert.equal(f.state(),null);
});
test('network cleanup failure retains completed owner evidence for retry',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f);f.proofClient.auth.signOut=async()=>{throw {status:503};};
  await assert.rejects(f.engine.completeNativeLink('code',n),{code:'transfer_cleanup'});assert.ok(f.state());assert.equal((await f.engine.inspect()).canComplete,true);
  f.proofClient.auth.signOut=async()=>({});assert.equal((await f.engine.completeNativeLink(undefined,n)).stage,'complete');
});
test('a foreign Google added outside the target OAuth stage is never marked for removal',async()=>{
  const f=fixture(),n=await released(f);targetGoogle(f,'unrelated-subject');await assert.rejects(f.engine.completeNativeLink(undefined,n),{code:'transfer_source_changed'});assert.equal(f.state().stage,'relink');assert.equal(f.state().unexpectedIdentityId,undefined);assert.equal(calls(f,'native-unlink').length,0);
});
test('target baseline must still be unlinked immediately before source unlink and target OAuth',async()=>{
  const first=fixture();await proven(first);targetGoogle(first,'outside-subject');await assert.rejects(first.engine.confirmTransfer(),{code:'transfer_native_changed'});assert.equal(calls(first,'source-unlink').length,0);
  const second=fixture();await released(second);targetGoogle(second,'outside-subject');await assert.rejects(second.engine.resumeLink(),{code:'transfer_native_changed'});assert.equal(calls(second,'native-link').length,0);
});
test('the mismatch evidence cannot be overwritten to remove a later different Google identity',async()=>{
  const f=fixture(),n=await targetFlow(f);targetGoogle(f,'first-unexpected');await assert.rejects(f.engine.completeNativeLink('code',n));const before=clone(f.state());f.nativeUser.identities[1]=googleIdentity(GOOGLE,'later-google',TARGET);
  await assert.rejects(f.engine.completeNativeLink(undefined,n),{code:'transfer_source_changed'});assert.deepEqual(f.state(),before);await assert.rejects(f.engine.restoreSource(),{code:'transfer_source_changed'});assert.equal(calls(f,'native-unlink').length,0);
});
test('source restoration requires fresh original owner, verified Google and empty membership before cleanup',async()=>{
  const f=fixture(),n=await released(f);await f.engine.restoreSource();restoredGoogle(f);f.rpc={status:'legacy',profile:{id:'unexpected-profile'},envelope:null};await assert.rejects(f.engine.completeNativeLink('code',n,'source'),{code:'transfer_source_ineligible'});assert.ok(f.state());assert.equal(calls(f,'proof-signout').length,0);
});
test('real SDK identity_id UUID is distinct from the numeric Google provider id',async()=>{
  const f=fixture(),subject='123456789012345678901';f.sourceUser.identities[1]=googleIdentity(GOOGLE,subject);
  const n=await proven(f);await f.engine.confirmTransfer();assert.equal(calls(f,'source-unlink')[0][1].identity_id,GOOGLE);assert.equal(calls(f,'source-unlink')[0][1].id,subject);
  await f.engine.resumeLink();targetGoogle(f,subject);await f.engine.completeNativeLink('code',n);assert.equal(f.state(),null);
});
test('provider id cannot be mistaken for the identity row UUID when identity_id is absent',async()=>{
  const f=fixture();delete f.sourceUser.identities[1].identity_id;f.sourceUser.identities[1].id=GOOGLE;const n=await f.engine.startProof();await assert.rejects(f.engine.finishProof('code',n.nonce),{code:'transfer_source_changed'});assert.equal(calls(f,'source-unlink').length,0);
});
test('changed target private key blocks code exchange before the SDK touches current authentication',async()=>{
  const f=fixture(),n=await targetFlow(f);f.nativeContext.keyDigest='c'.repeat(64);await assert.rejects(f.engine.completeNativeLink('code',n),{code:'transfer_native_changed'});assert.equal(calls(f,'native-exchange').length,0);assert.equal(calls(f,'proof-signout').length,0);
});
