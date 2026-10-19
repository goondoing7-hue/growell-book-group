'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,start);return html.slice(a,b);}
function harness(response){
  const warnings=[],failures=[],writes=[];
  const c={Promise,Date,JSON,Number,Uint8Array,atob,console:{warn:(...args)=>warnings.push(args)},
    SESSION:{userId:'u1',name:'회원',keyB64:'PRIVATE KEY MUST NOT BE LOGGED'},
    STATE:{users:{u1:{id:'u1',authUserId:'auth-owner'}},posts:{},privateEntries:{},comments:{},materialNotes:{},worksheets:{},readingLogs:{},readingMeta:{},habits:{},bookLocks:{},announcement:{next:{},reading:{}}},
    location:{hash:'#/book/emotion/mine'},localStorage:{setItem(){}},sessionStorage:{setItem(){}},
    showToast(){},render(){},esc:String,urlFromPhoto:()=>null,document:{querySelectorAll:()=>[]},
    sb:{from(table){let operation='select',payload;const q={
      insert(row){operation='insert';payload=row;return q;},update(row){operation='update';payload=row;return q;},upsert(row){operation='upsert';payload=row;return q;},
      select(){return q;},eq(){return q;},maybeSingle(){return q;},
      then(yes,no){writes.push({table,operation,payload});return Promise.resolve(response?response({table,operation,payload}):{error:null,status:201}).then(yes,no);}
    };return q;}}
  };
  vm.createContext(c);vm.runInContext(section('var saving = false;','/* ---------------- toast'),c);
  return {c,warnings,failures,writes,save:mutate=>c.saveState(mutate,{render:false,onFailure:error=>failures.push(error)})};
}
const secretError=()=>({code:'PGRST204',message:'PRIVATE MESSAGE AND MEMBER TEXT',details:'PRIVATE DETAILS WITH TOKEN',hint:'PRIVATE HINT',query:'PRIVATE QUERY',headers:{Authorization:'Bearer PRIVATE AUTH'},url:'https://private-endpoint.test/member'});

test('all three record save paths report only fixed table, operation, standard code and HTTP status',async()=>{
  const mutations={
    posts:next=>{next.posts.p={id:'PRIVATE POST ID',bookId:'emotion',userId:'u1',html:'PRIVATE SHARED BODY',createdAt:123};},
    private_entries:next=>{next.privateEntries.e={id:'PRIVATE ENTRY ID',bookId:'emotion',userId:'u1',iv:'PRIVATE IV',data:'PRIVATE ENCRYPTED BODY',createdAt:123};},
    reading_logs:next=>{next.readingLogs.r={id:'PRIVATE LOG ID',bookId:'emotion',userId:'u1',seconds:60,page:5,startPage:0,createdAt:123};}
  };
  for(const [table,mutate] of Object.entries(mutations)){
    const error=secretError(),h=harness(()=>({error,status:400}));
    assert.equal(await h.save(mutate),false);assert.equal(h.failures.length,1);assert.equal(h.failures[0],error);
    const events=h.warnings.map(args=>{assert.equal(args[0],'growell: record-save');assert.equal(args.length,2);return JSON.parse(args[1]);});
    assert.ok(events.some(event=>event.table===table&&event.operation==='insert'&&event.code==='PGRST204'&&event.status===400));
    for(const event of events)assert.deepEqual(Object.keys(event).sort(),['code','operation','status','table']);
    const output=JSON.stringify(h.warnings);for(const marker of ['PRIVATE','PRIVATE AUTH','PRIVATE POST ID','PRIVATE LOG ID','PRIVATE ENTRY ID','private-endpoint','Bearer','encrypted'])assert.equal(output.includes(marker),false,marker);
    assert.equal(Object.keys(h.c.STATE.posts).length,0);assert.equal(Object.keys(h.c.STATE.privateEntries).length,0);assert.equal(Object.keys(h.c.STATE.readingLogs).length,0);
  }
});
test('reading progress upsert diagnostics retain SQLSTATE without accepting unsafe error text',async()=>{
  const error={...secretError(),code:'42P10'},h=harness(()=>({error,status:400}));
  assert.equal(await h.save(next=>{next.readingMeta.emotion_u1={bookId:'emotion',userId:'u1',currentPage:7,updatedAt:123};}),false);
  assert.deepEqual(JSON.parse(h.warnings[0][1]),{table:'reading_meta',operation:'upsert',code:'42P10',status:400});assert.equal(h.failures[0],error);
});
test('successful saves produce no diagnostic and keep the normal saved row',async()=>{
  const h=harness();assert.equal(await h.save(next=>{next.posts.p={id:'p',bookId:'emotion',userId:'u1',html:'보존할 원문',createdAt:123};}),true);
  assert.equal(h.warnings.length,0);assert.equal(h.failures.length,0);assert.equal(h.c.STATE.posts.p.html,'보존할 원문');
});
test('unsafe codes and status values become null and arbitrary table or operation names cannot enter logs',()=>{
  const h=harness();h.c.reportRecordSaveFailure('posts','insert',{code:'PRIVATE TOKEN OR TEXT',status:'403'},999);
  assert.deepEqual(JSON.parse(h.warnings[0][1]),{table:'posts',operation:'insert',code:null,status:null});
  h.c.reportRecordSaveFailure('PRIVATE TABLE','insert',secretError(),400);h.c.reportRecordSaveFailure('posts','PRIVATE OPERATION',secretError(),400);assert.equal(h.warnings.length,1);
});
test('network rejection and a broken console preserve the original error object and failure semantics',async()=>{
  const h=harness(),error={...secretError(),code:'42501',status:403};
  await assert.rejects(h.c.checkedRecordSaveRequest(Promise.reject(error),'private_entries','insert'),value=>value===error);
  assert.deepEqual(JSON.parse(h.warnings[0][1]),{table:'private_entries',operation:'insert',code:'42501',status:403});
  h.c.console.warn=()=>{throw new Error('console unavailable');};
  await assert.rejects(h.c.checkedRecordSaveRequest(Promise.resolve({error,status:403}),'posts','insert'),value=>value===error);
});
