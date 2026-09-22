const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const snapshot={id:'rl-fixed-session',bookId:'emotion',userId:'u1',seconds:600,page:42,startPage:30,createdAt:100};
function logRow(log){return {id:log.id,book_id:log.bookId,user_id:log.userId,seconds:log.seconds,page:log.page,start_page:log.startPage,created_at:log.createdAt};}
function harness(options={}){
  const remoteLogs=Object.fromEntries((options.logs||[]).map(row=>[row.id,clone(row)])),remoteMeta={},calls=[];
  let metadataAttempts=0,insertAttempts=0;
  const c={Promise,Date,Number,JSON,console,setTimeout,clearInterval(){},
    SESSION:{userId:'u1',name:'회원',keyB64:'key'},CURRENT_KEY:null,CURRENT_KEY_OWNER:null,CURRENT_KEY_MATERIAL:null,
    STATE:{users:{u1:{id:'u1',name:'회원'}},posts:{},comments:{},privateEntries:{},worksheets:{},materialNotes:{},habits:{},
      readingLogs:{},readingMeta:{emotion_u1:{bookId:'emotion',userId:'u1',currentPage:30,updatedAt:50}},bookLocks:{},announcement:{next:{},reading:{}}},
    localStorage:{setItem(){},removeItem(){}},sessionStorage:{setItem(){}},location:{hash:'#/book/emotion/mine'},
    document:{querySelectorAll:()=>[]},render(){},showToast(){},esc:String,urlFromPhoto:()=>null,
    sb:{from(table){
      let operation='select',payload,filters=[],single=false;
      const query={
        select(){return query;},eq(key,value){filters.push([key,value]);return query;},maybeSingle(){single=true;return query;},
        insert(value){operation='insert';payload=clone(value);return query;},
        update(value){operation='update';payload=clone(value);return query;},
        upsert(value){operation='upsert';payload=clone(value);return query;},
        delete(){operation='delete';return query;},
        then(resolve,reject){return Promise.resolve().then(()=>{
          const request={table,operation,payload,filters,single};calls.push(request);
          if(operation==='select'){
            if(options.read){const result=options.read(request);if(result!==undefined)return result;}
            const rows=table==='reading_logs'?Object.values(remoteLogs):table==='reading_meta'?Object.values(remoteMeta):[];
            const filtered=rows.filter(row=>filters.every(([key,value])=>row[key]===value));
            return {data:clone(single?(filtered[0]||null):filtered),error:null};
          }
          if(table==='reading_logs'&&operation==='insert'){
            insertAttempts++;
            if(remoteLogs[payload.id])return {data:null,error:{code:'23505',message:'duplicate key'}};
            if(options.rejectInsert)return {data:null,error:{message:'network failed before insert'}};
            remoteLogs[payload.id]=clone(payload);
            return options.loseInsertResponse&&insertAttempts===1?{data:null,error:{message:'response lost'}}:{data:null,error:null};
          }
          if(table==='reading_meta'&&operation==='upsert'){
            metadataAttempts++;
            if(options.failFirstMeta&&metadataAttempts===1)return {data:null,error:{message:'metadata temporarily offline'}};
            remoteMeta[payload.book_id+'_'+payload.user_id]=clone(payload);return {data:null,error:null};
          }
          throw new Error('unexpected write '+table+' '+operation);
        }).then(resolve,reject);}
      };return query;
    }}
  };
  vm.createContext(c);
  vm.runInContext(section('function readingMetaKey(','function mapProfileRow('),c);
  vm.runInContext(section('function mapPrivateEntryRow(','function mapMaterialNoteRow('),c);
  vm.runInContext(section('function mapReadingMetaRow(','function mapBookLockRow('),c);
  vm.runInContext(section('function mapHabitRow(','\nvar STATE ='),c);
  vm.runInContext(section('var saving = false;','/* ---------------- toast'),c);
  function save(log=snapshot){
    const frozen=clone(log);
    return c.saveState(next=>{
      next.readingLogs[frozen.id]=clone(frozen);
      next.readingMeta[frozen.bookId+'_'+frozen.userId]={bookId:frozen.bookId,userId:frozen.userId,userName:'회원',currentPage:frozen.page,updatedAt:frozen.createdAt};
    },{render:false});
  }
  return {c,save,calls,remoteLogs,remoteMeta};
}

test('retry after committed reading insert and failed metadata writes one immutable log',async()=>{
  const h=harness({failFirstMeta:true});
  assert.equal(await h.save(),false);assert.equal(Object.keys(h.remoteLogs).length,1);
  assert.equal(h.c.STATE.readingLogs[snapshot.id],undefined);
  assert.equal(await h.save(),true);assert.equal(Object.keys(h.remoteLogs).length,1);
  assert.deepEqual(h.remoteLogs[snapshot.id],logRow(snapshot));assert.equal(h.remoteMeta.emotion_u1.current_page,42);
  assert.equal(Object.keys(h.c.STATE.readingLogs).length,1);
  assert.equal(h.calls.filter(call=>call.table==='reading_logs'&&call.operation==='update').length,0);
  assert.ok(h.calls.some(call=>call.table==='reading_logs'&&call.operation==='select'&&call.filters.some(([key,value])=>key==='user_id'&&value==='u1')));
});

test('lost insert response is verified by owner and exact immutable payload before metadata saves',async()=>{
  const h=harness({loseInsertResponse:true});assert.equal(await h.save(),true);
  assert.equal(Object.keys(h.remoteLogs).length,1);assert.equal(h.c.STATE.readingLogs[snapshot.id].seconds,600);
  assert.equal(h.remoteMeta.emotion_u1.current_page,42);
});

test('an existing ID with different content or owner is never accepted as the same reading session',async()=>{
  for(const patch of [{seconds:601},{page:43},{start_page:29},{created_at:101},{book_id:'other-book'},{user_id:'other-member'}]){
    const existing={...logRow(snapshot),...patch},h=harness({logs:[existing]});
    assert.equal(await h.save(),false,JSON.stringify(patch));assert.deepEqual(h.remoteLogs[snapshot.id],existing);
    assert.equal(h.c.STATE.readingLogs[snapshot.id],undefined);assert.equal(Object.keys(h.remoteMeta).length,0);
  }
});

test('failed insert with no verified remote row remains a failure and never advances progress',async()=>{
  const h=harness({rejectInsert:true});assert.equal(await h.save(),false);
  assert.equal(Object.keys(h.remoteLogs).length,0);assert.equal(Object.keys(h.remoteMeta).length,0);
  assert.equal(h.c.STATE.readingMeta.emotion_u1.currentPage,30);
});

test('member fetch loads only owner reading logs and uses book/user keys for progress',async()=>{
  const h=harness({read:request=>request.table==='reading_logs'?{data:[logRow(snapshot),{...logRow(snapshot),id:'foreign',user_id:'other'}]}:
    request.table==='reading_meta'?{data:[{book_id:'emotion',user_id:'u1',current_page:42,updated_at:100},{book_id:'emotion',user_id:'other',current_page:99,updated_at:200}]}:undefined});
  assert.equal(await h.c.loadMemberData(),true);
  assert.deepEqual(Object.keys(h.c.STATE.readingLogs),[snapshot.id]);assert.deepEqual(Object.keys(h.c.STATE.readingMeta),['emotion_u1']);
  assert.equal(h.c.STATE.readingMeta.emotion_u1.currentPage,42);
  assert.equal(h.c.memberLoadState.readingLogs,'ready');assert.equal(h.c.memberLoadState.readingMeta,'ready');
  for(const table of ['reading_logs','reading_meta'])assert.ok(h.calls.some(call=>call.table===table&&call.filters.some(([key,value])=>key==='user_id'&&value==='u1')));
});

test('failed reading fetch keeps the existing own data and exposes retry state',async()=>{
  const h=harness({read:request=>['reading_logs','reading_meta'].includes(request.table)?{data:null,error:{message:'offline'}}:undefined});
  h.c.STATE.readingLogs[snapshot.id]=clone(snapshot);
  assert.equal(await h.c.loadMemberData(),false);assert.equal(h.c.STATE.readingLogs[snapshot.id].seconds,600);
  assert.equal(h.c.STATE.readingMeta.emotion_u1.currentPage,30);
  assert.equal(h.c.memberLoadState.readingLogs,'error');assert.equal(h.c.memberLoadState.readingMeta,'error');
});

test('logout clears reading data and a late owner response cannot restore it',async()=>{
  const pending=deferred(),h=harness({read:request=>request.table==='reading_logs'?pending.promise:undefined});
  h.c.STATE.readingLogs[snapshot.id]=clone(snapshot);
  const loaded=h.c.loadMemberData();await new Promise(resolve=>setImmediate(resolve));
  h.c.resetSaveSession();h.c.clearMemberSession();
  assert.equal(Object.keys(h.c.STATE.readingLogs).length,0);assert.equal(Object.keys(h.c.STATE.readingMeta).length,0);
  h.c.SESSION={userId:'other',keyB64:'other-key'};
  pending.resolve({data:[logRow(snapshot)],error:null});assert.equal(await loaded,false);
  assert.equal(Object.keys(h.c.STATE.readingLogs).length,0);assert.equal(h.c.memberLoadState.readingLogs,'idle');
});
