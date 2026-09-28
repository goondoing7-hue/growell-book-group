'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const domain=require('../archiveDomain.js');
const privateCrypto=require('../privateCrypto.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function flush(){for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));}
const clone=value=>JSON.parse(JSON.stringify(value));
const book=()=>domain.prepare({title:'테스트 독서 기록',authors:['가상 저자'],startDate:'2026-09-01',endDate:'2026-09-28',rating:4,review:'다시 읽고 싶은 책이다.'});
async function harness(){
  const passwordKey=await privateCrypto.newKey(),dataKey=await privateCrypto.newKey(),db={},requests=[],toasts=[];
  let adapter,id=0;
  const h={db,requests,toasts,intercept:null};
  const c={Promise,Date,Uint8Array,atob,console,URL,JSON,Error,
    SESSION:{userId:'owner',keyB64:'key-owner'},
    STATE:{users:{},posts:{},comments:{},privateEntries:{},materialNotes:{},worksheets:{},readingLogs:{},habits:{},readingMeta:{},bookLocks:{},announcement:{next:{},reading:{}}},
    location:{hash:'#/archive'},localStorage:{setItem(){}},sessionStorage:{setItem(){}},
    render(){},showToast:(...args)=>toasts.push(args),uid:prefix=>prefix+'_'+(++id),
    GrowellArchiveDomain:domain,GrowellArchive:{configure:value=>{adapter=value;}},
    ownPrivateEntries:()=>Object.values(c.STATE.privateEntries).filter(e=>e.userId===c.SESSION?.userId),
    ensureKey:async()=>passwordKey,
    decryptPrivateRecord:async(entry,key)=>(await privateCrypto.read(entry,key)).text,
    encryptPrivateRecord:(entry,key,text)=>privateCrypto.create(entry,key,dataKey,text),
    sb:{from(table){
      let operation='select',payload,filters=[];
      const query={select(){return query;},eq(k,v){filters.push([k,v]);return query;},maybeSingle(){return query;},
        insert(value){operation='insert';payload=value;return query;},update(value){operation='update';payload=value;return query;},
        then(yes,no){const request={table,operation,payload:payload&&clone(payload),filters:clone(filters)};requests.push(request);
          const perform=()=>{
            assert.equal(table,'private_entries');
            if(operation==='insert'){
              if(db[payload.id])return {error:{code:'23505'}};
              db[payload.id]=clone(payload);return {data:null,error:null};
            }
            const row=Object.values(db).find(item=>filters.every(([key,value])=>item[key]===value));
            if(operation==='select')return {data:row?clone(row):null,error:null};
            if(!row)return {data:null,error:null};
            db[row.id]={...row,...clone(payload)};return {data:{id:row.id},error:null};
          };
          return Promise.resolve(h.intercept?h.intercept(request,perform):perform()).then(yes,no);
        }};return query;
    }}
  };
  vm.createContext(c);
  vm.runInContext(section('function mapPrivateEntryRow(', 'function mapMaterialNoteRow('),c);
  vm.runInContext(section('var saving = false;', '/* ---------------- toast'),c);
  c.memberLoadState.privateEntries='ready';
  vm.runInContext(section('GrowellArchive.configure({','/* ---------------- member access adapter'),c);
  Object.assign(h,{c,adapter,passwordKey,dataKey});return h;
}

test('archive creation, editing and trash restoration preserve encrypted IDs and original creation time',async()=>{
  const h=await harness(),{c,adapter}=h;
  await adapter.save(null,book(),'arc_stable');
  const id=domain.recordId('owner','arc_stable'),original=clone(c.STATE.privateEntries[id]);
  assert.equal(Object.keys(h.db).length,1);assert.equal(original.id,id);
  assert.equal(original.data.includes(book().review),false);
  const [row]=await adapter.read([original]);assert.deepEqual(row.book,book());
  await adapter.save(row,{...book(),rating:5,review:'다시 읽고 평가를 수정했다.'});
  const changed=c.STATE.privateEntries[id];
  assert.equal(changed.createdAt,original.createdAt);assert.ok(changed.updatedAt>=original.createdAt);
  assert.notEqual(changed.data,original.data);
  const update=h.requests.find(r=>r.operation==='update');
  assert.deepEqual(update.filters,[['id',id],['iv',original.iv]],'server update must compare the original IV');
  const [updated]=await adapter.read([changed]);
  await adapter.save(updated,{...updated.book,deleted:true});
  const [trashed]=await adapter.read([c.STATE.privateEntries[id]]);assert.equal(trashed.book.deleted,true);
  await adapter.save(trashed,{...trashed.book,deleted:false});
  assert.equal((await adapter.read([c.STATE.privateEntries[id]]))[0].book.deleted,false);
  assert.equal(c.STATE.privateEntries[id].createdAt,original.createdAt);
  assert.equal(h.requests.some(r=>r.operation==='delete'),false);
});

test('remote edits fail compare-and-swap without overwriting the other device or local snapshot',async()=>{
  const h=await harness();await h.adapter.save(null,book(),'arc_stable');
  const id=domain.recordId('owner','arc_stable'),before=clone(h.c.STATE.privateEntries[id]);
  const [row]=await h.adapter.read([before]);h.db[id].iv='another-device-iv';h.db[id].data='another-device-data';
  await assert.rejects(()=>h.adapter.save(row,{...book(),rating:1}),/다른 기기/);
  assert.equal(h.db[id].data,'another-device-data');assert.deepEqual(clone(h.c.STATE.privateEntries[id]),before);
});

test('local edits made after opening an archive cannot be overwritten by a stale dialog',async()=>{
  const h=await harness();await h.adapter.save(null,book(),'arc_stable');
  const id=domain.recordId('owner','arc_stable'),[row]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  h.c.STATE.privateEntries[id]={...h.c.STATE.privateEntries[id],iv:'new-iv',data:'new-data'};
  const requests=h.requests.length;
  await assert.rejects(()=>h.adapter.save(row,{...book(),rating:1}));
  assert.equal(h.requests.length,requests);assert.equal(h.c.STATE.privateEntries[id].data,'new-data');
});

test('an insert committed before a lost response is confirmed by owner and plaintext without a duplicate',async()=>{
  const h=await harness();h.intercept=(request,perform)=>{const result=perform();return request.operation==='insert'?{error:new Error('response lost')}:result;};
  await h.adapter.save(null,book(),'arc_stable');
  const id=domain.recordId('owner','arc_stable');
  assert.equal(Object.keys(h.db).length,1);assert.equal(h.c.STATE.privateEntries[id].data,h.db[id].data);
  const read=h.requests.find(r=>r.operation==='select');
  assert.deepEqual(read.filters,[['id',id],['user_id','owner']]);
  await h.adapter.save(null,book(),'arc_stable');
  assert.equal(Object.keys(h.db).length,1);
});

test('retry after an unconfirmed insert keeps the ID and refuses changed content',async()=>{
  const h=await harness();let offline=true;
  h.intercept=(request,perform)=>{
    if(offline&&request.operation==='select')return {error:new Error('offline')};
    const result=perform();return offline&&request.operation==='insert'?{error:new Error('response lost')}:result;
  };
  await assert.rejects(()=>h.adapter.save(null,book(),'arc_stable'));
  assert.equal(Object.keys(h.c.STATE.privateEntries).length,0);offline=false;
  await assert.rejects(()=>h.adapter.save(null,{...book(),review:'다른 내용'},'arc_stable'),/다른 내용/);
  assert.equal(Object.keys(h.db).length,1);assert.equal(Object.keys(h.c.STATE.privateEntries).length,0);
  await h.adapter.save(null,book(),'arc_stable');
  assert.equal(Object.keys(h.c.STATE.privateEntries).length,1);
  assert.equal((await h.adapter.read(Object.values(h.c.STATE.privateEntries)))[0].book.review,book().review);
});

test('lost update acknowledgement confirms the exact timer payload without recording the session twice',async()=>{
  const h=await harness(),initial=domain.prepare({...book(),status:'reading',totalPages:200,currentPage:10,notes:[{id:'note_1',text:'보존할 노트',createdAt:1000}]});
  await h.adapter.save(null,initial,'arc_stable');const id=domain.recordId('owner','arc_stable');
  const [row]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  const updated=domain.addReadingSession(row.book,{id:'timer_1',seconds:300,startPage:10,endPage:25,createdAt:2000});
  h.intercept=(request,perform)=>{const result=perform();return request.operation==='update'?{error:new Error('response lost')}:result;};
  await h.adapter.save(row,updated);
  const [saved]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  assert.equal(saved.book.currentPage,25);assert.equal(domain.totalReadingSeconds(saved.book),300);
  assert.equal(saved.book.readingSessions.length,1);assert.equal(saved.book.notes[0].text,'보존할 노트');
  assert.equal(saved.entry.createdAt,row.entry.createdAt);
  assert.ok(h.requests.some(r=>r.operation==='select'&&r.filters.some(([key,value])=>key==='user_id'&&value==='owner')));
});

test('a timer retry after update and confirmation responses are lost restores the committed record exactly once',async()=>{
  const h=await harness();await h.adapter.save(null,{...book(),status:'reading',totalPages:200,currentPage:10},'arc_stable');
  const id=domain.recordId('owner','arc_stable'),[row]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  const updated=domain.addReadingSession(row.book,{id:'timer_retry',seconds:60,startPage:10,endPage:15,createdAt:2000});
  let offline=true;
  h.intercept=(request,perform)=>{
    if(offline&&request.operation==='select')return {error:new Error('offline')};
    const result=perform();return offline&&request.operation==='update'?{error:new Error('response lost')}:result;
  };
  await assert.rejects(()=>h.adapter.save(row,updated));
  assert.equal(h.c.STATE.privateEntries[id].data,row.entry.data,'unconfirmed local snapshot is preserved');
  offline=false;await h.adapter.save(row,updated);
  const [saved]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  assert.equal(saved.book.readingSessions.length,1);assert.equal(domain.totalReadingSeconds(saved.book),60);
  assert.equal(saved.book.currentPage,15);assert.equal(saved.entry.createdAt,row.entry.createdAt);
});

test('timer saves cannot erase a remote note appended after the dialog snapshot',async()=>{
  const h=await harness();await h.adapter.save(null,{...book(),status:'reading',totalPages:200,currentPage:10},'arc_stable');
  const id=domain.recordId('owner','arc_stable'),[row]=await h.adapter.read([h.c.STATE.privateEntries[id]]);
  const remoteBook=domain.upsertNote(row.book,{id:'remote_note',text:'다른 기기에서 작성한 기록',createdAt:2000});
  const encrypted=await privateCrypto.create(row.entry,h.passwordKey,h.dataKey,domain.encode(remoteBook));
  h.db[id]={...h.db[id],iv:encrypted.iv,data:encrypted.data};
  const timerBook=domain.addReadingSession(row.book,{id:'timer_stale',seconds:90,startPage:10,endPage:30,createdAt:3000});
  await assert.rejects(()=>h.adapter.save(row,timerBook));
  assert.equal(h.db[id].data,encrypted.data);assert.equal(h.c.STATE.privateEntries[id].data,row.entry.data);
  const stored=domain.decode((await privateCrypto.read(h.c.mapPrivateEntryRow(h.db[id]),h.passwordKey)).text);
  assert.equal(stored.notes[0].text,'다른 기기에서 작성한 기록');assert.equal(stored.readingSessions.length,0);
});

test('account, key and session-generation changes abort an archive save before any request',async()=>{
  for(const change of [c=>{c.SESSION={userId:'other',keyB64:'other'};},c=>{c.SESSION.keyB64='replacement';},c=>{c.saveSessionEpoch++;}]){
    const h=await harness(),pending=deferred();h.c.ensureKey=()=>pending.promise;
    const saving=h.adapter.save(null,book(),'arc_stable'),rejected=assert.rejects(saving,/로그인/);
    change(h.c);pending.resolve(h.passwordKey);await rejected;assert.equal(h.requests.length,0);
  }
});

test('in-flight archive writes and late decryptions never install data into another account',async()=>{
  const h=await harness(),pending=deferred();h.intercept=(request,perform)=>request.operation==='insert'?pending.promise.then(perform):perform();
  const saving=h.adapter.save(null,book(),'arc_stable'),rejected=assert.rejects(saving,/로그인/);await flush();
  h.c.SESSION={userId:'other',keyB64:'other'};h.c.saveSessionEpoch++;h.c.STATE.privateEntries={};pending.resolve();await rejected;
  assert.equal(Object.keys(h.c.STATE.privateEntries).length,0);
  const h2=await harness();await h2.adapter.save(null,book(),'arc_stable');
  const decryption=deferred();h2.c.decryptPrivateRecord=()=>decryption.promise;
  const reading=h2.adapter.read(Object.values(h2.c.STATE.privateEntries)),failed=assert.rejects(reading,/로그인/);await flush();
  h2.c.SESSION={userId:'other',keyB64:'other'};decryption.resolve(domain.encode(book()));await failed;
});

test('archive adapter rejects foreign and unrelated private records before reading or writing them',async()=>{
  const h=await harness();let decrypts=0;h.c.decryptPrivateRecord=()=>{decrypts++;throw new Error('unexpected decrypt');};
  for(const entry of [{id:domain.recordId('other','arc_x'),userId:'other',bookId:'emotion'},
    {id:'note-owner',userId:'owner',bookId:'emotion'}]){
    await assert.rejects(()=>h.adapter.read([entry]),/아카이브/);
    await assert.rejects(()=>h.adapter.save({entry,book:book()},book()),/내 기록/);
  }
  assert.equal(decrypts,0);assert.equal(h.requests.length,0);
});

function uiHarness(){
  const events={},history=[],elements=[],trigger={dataset:{archiveOpen:domain.recordId('owner','arc_ui')},isConnected:true,focus(){}};
  let session={userId:'owner'},read=()=>Promise.resolve([{entry:{id:trigger.dataset.archiveOpen,userId:'owner',bookId:'emotion',createdAt:1},book:book()}]);
  const page={querySelectorAll:selector=>selector==='[data-archive-open]'?[trigger]:[],querySelector:()=>null};
  const c={URL,Promise,Set,FormData,AbortController,console,crypto:require('node:crypto').webcrypto,GrowellArchiveDomain:domain,confirm:()=>true,
    addEventListener:(name,fn)=>{events[name]=fn;},
    GrowellPopupHistory:{open:(key,options)=>history.push({type:'open',key,options}),closed:key=>history.push({type:'closed',key})},
    document:{querySelector:selector=>selector==='.archive-page'?page:null,querySelectorAll:selector=>selector==='.archive-page,.archive-records'?[page]:[],getElementById:()=>null,
      body:{appendChild:node=>elements.push(node)},createElement(){
        const closeButton={},body={innerHTML:'',querySelector:()=>({insertAdjacentHTML(){}}),querySelectorAll:()=>[]};
        return {className:'',innerHTML:'',listeners:{},setAttribute(){},querySelector:selector=>selector==='[data-archive-close]'?closeButton:selector==='.archive-dialog-body'?body:null,
          querySelectorAll:()=>[],addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;}};
      }}
  };c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../archive.js'),'utf8'),c);
  const adapter={session:()=>session,status:()=> 'ready',entries:()=>[{id:trigger.dataset.archiveOpen,userId:session.userId,bookId:'emotion',data:'cipher'}],
    read:entries=>read(entries),render(){},toast(){},statusHtml:()=>'',reload(){}};
  c.GrowellArchive.configure(adapter);
  return {c,events,history,elements,trigger,setSession:value=>{session=value;},setRead:value=>{read=value;}};
}

test('archive popup registers Back dismissal and closes on route or account changes',async()=>{
  const h=uiHarness();h.c.GrowellArchive.html();await flush();h.c.GrowellArchive.bind();h.trigger.onclick();
  const first=h.elements[0];assert.equal(first.open,true);assert.equal(h.history[0].key,'archive');
  h.history[0].options.close();assert.equal(first.removed,true);assert.equal(h.history.at(-1).type,'closed');
  h.trigger.onclick();const second=h.elements[1];h.events.hashchange();assert.equal(second.removed,true);
  h.trigger.onclick();const third=h.elements[2];third._dirty=true;h.c.confirm=()=>false;
  h.setSession({userId:'other'});h.c.GrowellArchive.bind();assert.equal(third.removed,true,'account cleanup must never retain a dirty private dialog');
});

test('archive loader discards previous-account plaintext arriving after a switch',async()=>{
  const h=uiHarness(),pending=deferred();h.setRead(()=>pending.promise);h.c.GrowellArchive.html();
  h.setSession({userId:'other'});h.c.GrowellArchive.bind();pending.resolve([{entry:{id:'old',createdAt:1},book:{...book(),title:'previous-account secret'}}]);await flush();
  assert.doesNotMatch(h.c.GrowellArchive.html(),/previous-account secret/);
});
