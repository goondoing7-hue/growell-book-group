'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../memberAccess.js'),'utf8');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(){
  const requests=[],queue=[],c={Promise,document:{querySelectorAll:()=>[]},SESSION:{userId:'member'},saveSessionEpoch:1,isAdmin:()=>false,esc:String};
  c.sb={rpc(name,args){requests.push({name,args});return queue.shift()||Promise.resolve({data:[]});}};
  vm.createContext(c);vm.runInContext(source,c);c.GrowellMemberAccess.configure(c);
  return {c,api:c.GrowellMemberAccess,requests,queue};
}
test('approval is explicit; missing, pending, rejected and deleted profiles do not count as members',()=>{
  const {api}=harness();assert.equal(api.approved({approval_status:'approved',is_deleted:false}),true);
  for(const row of [null,{}, {approval_status:'pending'}, {approval_status:'rejected'}, {approval_status:'approved',is_deleted:true}])assert.equal(api.approved(row),false);
});
test('worksheet permission starts locked and opens only the exact confirmed book',async()=>{
  const {c,api,queue}=harness();assert.equal(api.canOpen('emotion'),false);
  queue.push(Promise.resolve({data:[{book_id:'emotion',locked:false,revision:2},{book_id:'thought',locked:true,revision:4}]}));
  assert.equal(await api.load(),true);assert.equal(api.canOpen('emotion'),true);assert.equal(api.canOpen('thought'),false);assert.equal(api.canOpen('body'),false);
  c.SESSION=null;assert.equal(api.canOpen('emotion'),false);c.SESSION={userId:'admin'};c.isAdmin=()=>true;assert.equal(api.canOpen('thought'),true);
});
test('failed lock refresh fails closed while preserving administrator access',async()=>{
  const {c,api,queue}=harness();queue.push(Promise.resolve({data:[{book_id:'emotion',locked:false,revision:1}]}));await api.load();
  queue.push(Promise.resolve({error:{code:'network'}}));assert.equal(await api.load(),false);assert.equal(api.canOpen('emotion'),false);
  c.isAdmin=()=>true;assert.equal(api.canOpen('emotion'),true);assert.match(api.panel('emotion'),/다시 불러오기/);
});
test('late lock responses cannot reopen a worksheet after logout or account reset',async()=>{
  for(const reset of [h=>{h.c.SESSION=null;},h=>{h.c.SESSION={userId:'other'};h.c.saveSessionEpoch++;},h=>h.api.reset()]){
    const h=harness(),pending=deferred();h.queue.push(pending.promise);const load=h.api.load();reset(h);
    pending.resolve({data:[{book_id:'emotion',locked:false,revision:1}]});assert.equal(await load,false);assert.equal(h.api.canOpen('emotion'),false);
  }
});
