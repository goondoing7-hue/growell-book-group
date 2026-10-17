'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};}
const tick=()=>new Promise(r=>setImmediate(r));
function harness(){
  const remote=deferred(),token=deferred(),events=[];let adapter;
  const source={post:{id:'synthetic-post',body:'작성한 나눔 원문',userId:'one'}};
  const context={Promise,Date,setTimeout,SESSION:{userId:'one'},STATE:{users:{one:{authUserId:'auth-one'}},posts:source,privateEntries:{},habits:{},readingLogs:{},readingMeta:{}},
    saveSessionEpoch:4,authFlowEpoch:0,authTransition:Promise.resolve(),pushDetachPending:Promise.resolve(),
    resetSaveSession(){context.saveSessionEpoch++;return Promise.resolve();},render(){},location:{hash:'#/'},localStorage:{removeItem(){}},
    sb:{auth:{getSession:()=>token.promise,signOut:async()=>{events.push('signOut');}}},
    GrowellWebPush:{detach(value){adapter=value;events.push('detach');return remote.promise;},reset(){events.push('reset');}}};
  vm.createContext(context);vm.runInContext(section('function clearMemberSession(){','function memberDataStatusHtml('),context);
  vm.runInContext(section('function doLogout(){','/* 계정 삭제'),context);
  return {context,remote,token,events,source,adapter:()=>adapter};
}
test('logout clears only browser session state and waits for bounded push detach before signing out',async()=>{
  const h=harness(),before=JSON.stringify(h.source),done=h.context.doLogout();await tick();
  assert.equal(h.context.SESSION,null);assert.deepEqual(h.events,['detach','reset']);assert.equal(h.adapter().isCurrent(),true);
  const access=h.adapter().getAccessToken();h.token.resolve({data:{session:{user:{id:'auth-one'},access_token:'SYNTHETIC_PREVIOUS_TOKEN'}}});
  assert.equal(await access,'SYNTHETIC_PREVIOUS_TOKEN');h.remote.resolve(true);await done;
  assert.deepEqual(h.events,['detach','reset','signOut']);assert.equal(JSON.stringify(h.source),before);
});
test('account or epoch replacement prevents obtaining a prior member token for push detach',async()=>{
  for(const change of ['member','epoch','auth']){
    const h=harness();h.context.clearMemberSession();const pending=h.adapter().getAccessToken();
    if(change==='member')h.context.SESSION={userId:'two'};
    if(change==='epoch')h.context.saveSessionEpoch++;
    h.token.resolve({data:{session:{user:{id:change==='auth'?'auth-two':'auth-one'},access_token:'NEVER_SEND_THIS_TOKEN'}}});
    await assert.rejects(pending,/session_changed/);if(change!=='auth')assert.equal(h.adapter().isCurrent(),false);h.remote.resolve(false);
  }
});

test('server notification payloads reach the actual worker display handler',async()=>{
  const {payloadFor}=require('../server/webPushService.cjs');
  const events={},displayed=[];
  const context={URL,Promise,self:{addEventListener(name,fn){events[name]=fn;},registration:{showNotification(title,options){displayed.push({title,options});return Promise.resolve();}}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8'),context);
  const jobs=[{kind:'test'},{kind:'post',book_id:'emotion',post_id:'synthetic_post_1'},{kind:'verse',verse_day:'2026-10-17'}];
  const now=Date.parse('2026-10-17T00:00:00Z'),id='12345678-1234-4123-8123-123456789abc';
  for(const job of jobs){
    const payload=payloadFor(job,now,id);let waiting;
    events.push({data:{json:()=>payload},waitUntil(promise){waiting=promise;}});
    assert.ok(waiting,'every legitimate server payload must register a notification task');await waiting;
  }
  assert.equal(displayed.length,3);assert.deepEqual(displayed.map(value=>value.title),['GROWELL 알림 연결','새로운 나눔','오늘의 말씀']);
  for(const value of displayed){assert.match(value.options.tag,/^growell-[A-Za-z0-9:_-]+$/);assert.equal(value.options.data.kind,'growell-push');}
});

function invitationHarness(){
  const calls=[],member={id:'synthetic-member',authUserId:'synthetic-auth',approvalStatus:'approved',isDeleted:false},record={body:'작성 중 원문',id:'preserved-record'};
  const c={Promise,SESSION:{userId:member.id},STATE:{users:{[member.id]:member},posts:{record}},saveSessionEpoch:2,
    memberPushPromptSession:null,memberPushPromptLifecycleBound:false,BOOTING:false,BOOT_FAILED:false,authRestoreState:'idle',oauthBusy:false,saving:false,
    memberLoadState:{privateEntries:'ready'},habitFormOpenFor:null,editingAnnouncement:false,route:{view:'home'},composing:false,
    currentRoute(){return c.route;},anyComposerOpen(){return c.composing;},habitSyncAccessToken(session,epoch){assert.equal(session,c.SESSION);assert.equal(epoch,c.saveSessionEpoch);return Promise.resolve('SYNTHETIC_ACCESS');},
    document:{hidden:false,activeElement:null,querySelector(){return c.blockingDialog||null;},getElementById(){return c.menu||null;},addEventListener(){}},window:{addEventListener(){}},
    memberPushPromptManager:{maybeShow(adapter){calls.push(adapter);return Promise.resolve(true);},reset(){calls.push('reset');}}};
  vm.createContext(c);vm.runInContext(section('function markMemberPushPromptSession(){','/* ---------------- master render ---------------- */'),c);
  return {c,calls,record,member};
}
test('automatic invitation requires a verified marker and rejects a stale member, epoch or withdrawn approval',async()=>{
  const h=invitationHarness();assert.equal(await h.c.maybePromptMemberForPush(),false);assert.equal(h.calls.length,0);
  h.c.markMemberPushPromptSession();assert.equal(await h.c.maybePromptMemberForPush(),true);const adapter=h.calls[0];
  assert.equal(await adapter.getAccessToken(),'SYNTHETIC_ACCESS');assert.equal(adapter.isCurrent(),true);
  h.c.saveSessionEpoch++;assert.equal(adapter.isCurrent(),false);h.c.saveSessionEpoch--;
  h.c.SESSION={userId:h.member.id};assert.equal(adapter.isCurrent(),false);
  h.c.markMemberPushPromptSession();h.member.approvalStatus='pending';assert.equal(await h.c.maybePromptMemberForPush(),false);
  h.member.approvalStatus='approved';h.c.resetMemberPushPrompt();assert.equal(h.calls.at(-1),'reset');assert.equal(h.c.memberPushPromptSession,null);
});
test('automatic invitation waits for editors, dialogs, loading and active inputs without changing authored content',()=>{
  const h=invitationHarness(),before=JSON.stringify(h.record);h.c.markMemberPushPromptSession();const marker=h.c.memberPushPromptSession;
  assert.equal(h.c.canPresentMemberPushPrompt(marker),true);
  const blocks=[['BOOTING',true],['BOOT_FAILED',true],['authRestoreState','checking'],['oauthBusy',true],['saving',true],['composing',true],['habitFormOpenFor','emotion'],['editingAnnouncement',true],['blockingDialog',{}],['menu',{hidden:false}]];
  for(const [key,value]of blocks){const original=h.c[key];h.c[key]=value;assert.equal(h.c.canPresentMemberPushPrompt(marker),false,key);h.c[key]=original;}
  h.c.document.activeElement={matches:()=>true};assert.equal(h.c.canPresentMemberPushPrompt(marker),false);h.c.document.activeElement=null;
  h.c.memberLoadState.privateEntries='loading';assert.equal(h.c.canPresentMemberPushPrompt(marker),false);h.c.memberLoadState.privateEntries='ready';
  for(const view of ['login','profile-edit','admin-users']){h.c.route={view};assert.equal(h.c.canPresentMemberPushPrompt(marker),false);}
  assert.equal(JSON.stringify(h.record),before);
});
test('all approved login paths mark the session and render checks only after restoring existing editors',()=>{
  assert.ok(html.indexOf('src="webPushPrompt.js"')>html.indexOf('src="webPush.js"'));
  for(const [start,end]of [['function restoreMemberSession(){','function retryMemberSession('],['function doLogin(','function doLogout('],['async function completeOAuthMember(','async function cancelOAuth(']]){
    const source=section(start,end);assert.ok(source.indexOf('markMemberPushPromptSession()')>source.indexOf('GrowellMemberAccess.approved('));
  }
  const render=section('function render(){','function restoreDraftIfAny(');
  assert.ok(render.lastIndexOf('maybePromptMemberForPush();')>render.lastIndexOf('showSpaceComposerDialog();'));
  assert.ok(section('function clearMemberSession(){','function memberDataStatusHtml(').includes('resetMemberPushPrompt()'));
});
