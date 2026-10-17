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
