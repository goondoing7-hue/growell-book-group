'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Shared=require('../sharedReadingFormat.js'),Archive=require('../archiveDomain.js'),Format=require('../readingFormatDomain.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));}
function sample(overrides={}){return Archive.prepare({title:'테스트 책',authors:['작성자'],totalPages:200,currentPage:40,status:'reading',linkedBookId:'emotion',
  notes:[{id:'note1',text:'보존할 책 속 문장',createdAt:1000}],readingSessions:[{id:'paper1',startPage:20,endPage:40,seconds:300,createdAt:2000}],...overrides});}
function percentSession(overrides={}){return {id:'ebook1',unit:'percent',startPercent:null,endPercent:25,sectionId:'s1',sectionTitle:'1장 · 실제 목차',progressKind:'estimated',estimateBasis:'equal-sections',seconds:120,createdAt:3000,...overrides};}
function harness(){
  let current={userId:'memberA'},epoch=1,status='ready',allowed=true,serial=0,changed=0,reader=null,saveHook=null,entryHook=null;
  const entries=new Map(),books=new Map(),reads=[],saves=[],catalog=sample({notes:[],readingSessions:[],currentPage:40});
  const idFor=(owner=current.userId,id='emotion')=>Archive.recordId(owner,'arc_shared_'+id);
  function put(book,owner=current.userId,id='emotion'){
    const key=idFor(owner,id),before=entries.get(key),entry={id:key,bookId:Archive.STORAGE_BOOK_ID,userId:owner,iv:'iv'+(++serial),data:'cipher'+serial,createdAt:before?.createdAt||1000};
    entries.set(key,entry);books.set(key,Archive.prepare(book));return clone(entry);
  }
  const adapter={session:()=>current,epoch:()=>epoch,status:()=>status,catalog:id=>id==='emotion'?clone(catalog):null,allowed:()=>allowed,
    entry:id=>entryHook?entryHook(id):entries.get(id),
    async read(entry){reads.push(clone(entry));if(reader)return reader(entry);return {entry:clone(entry),book:clone(books.get(entry.id))};},
    async save(row,book,createId){
      saves.push({row:clone(row),book:clone(book),createId});if(saveHook)return saveHook(row,book,createId);
      const key=Archive.recordId(current.userId,createId),existing=entries.get(key);
      if(row?(!existing||existing.data!==row.entry.data||existing.iv!==row.entry.iv):existing)throw new Error('다른 곳에서 바뀐 원본');
      const entry=put(book);return {entry,book:clone(book)};
    },changed(){changed++;}};
  return {api:Shared.create(adapter),adapter,entries,books,reads,saves,idFor,put,catalog,
    setOwner(owner){current={userId:owner};epoch++;},setEpoch(){epoch++;},setStatus(value){status=value;},setAllowed(value){allowed=value;},
    setReader(value){reader=value;},setSave(value){saveHook=value;},setEntry(value){entryHook=value;},get changed(){return changed;}};
}

test('missing personal settings default to paper without writing or converting old page progress',()=>{
  const h=harness(),view=h.api.view('emotion');assert.equal(view.status,'ready');assert.equal(view.settings.format,'paper');
  assert.equal(view.book.currentPage,40);assert.equal(view.settings.ebook.progressPercent,null);assert.deepEqual(view.sessions,[]);
  assert.equal(h.saves.length,0);assert.equal(h.entries.size,0);assert.equal(h.api.view('unknown').settings,null);
});

test('mode and ebook-session saves preserve notes, legacy pages, session IDs and created time',async()=>{
  const h=harness(),original=sample(),before=clone(original),entry=h.put(original);
  const selected=Format.selectSection({format:'paper'},Format.tocEntries([{id:'s1',title:'실제 목차'},{id:'s2',title:'다음 목차'}]),'s1',2500);
  await h.api.saveSettings('emotion',selected);await h.api.saveSession('emotion',percentSession());
  const saved=h.books.get(entry.id);assert.equal(saved.currentPage,40);assert.deepEqual(saved.notes,before.notes);
  assert.deepEqual(saved.readingSessions[0],before.readingSessions[0]);assert.equal(saved.readingSessions[1].unit,'percent');assert.equal(saved.readingSettings.ebook.progressPercent,25);
  assert.equal(h.entries.get(entry.id).createdAt,entry.createdAt);assert.equal(h.saves[0].createId,'arc_shared_emotion');
  await h.api.saveSettings('emotion',Format.changeFormat(saved.readingSettings,'paper'));
  const paper=h.books.get(entry.id);assert.equal(paper.currentPage,40);assert.equal(paper.readingSettings.ebook.progressPercent,25);assert.equal(paper.readingSessions.length,2);
  await h.api.saveSettings('emotion',{format:'ebook'});assert.equal(h.books.get(entry.id).readingSettings.ebook.progressPercent,25,'a format-only change does not erase an existing ebook position');
  await assert.rejects(h.api.saveSettings('emotion',null),/읽는 방식/);assert.equal(h.books.get(entry.id).readingSettings.ebook.progressPercent,25);
  assert.equal(JSON.stringify(original),JSON.stringify(before));
});

test('a saved record creates exactly the deterministic own archive ID and a lost response retries the same session',async()=>{
  const h=harness();let first=true;
  h.setSave(async(row,book,createId)=>{assert.equal(createId,'arc_shared_emotion');const entry=h.put(book);if(first){first=false;throw new Error('응답 유실');}return {entry,book:clone(book)};});
  await assert.rejects(h.api.saveSession('emotion',percentSession()),/응답 유실/);
  assert.equal(h.entries.size,1);await h.api.saveSession('emotion',percentSession());
  assert.equal(h.entries.size,1);assert.equal(h.books.get(h.idFor()).readingSessions.filter(s=>s.id==='ebook1').length,1);
  assert.ok(h.saves.every(call=>call.createId==='arc_shared_emotion'));
  await assert.rejects(h.api.saveSession('emotion',percentSession({seconds:121})),/같은 독서 기록/);
  assert.equal(h.books.get(h.idFor()).readingSessions[0].seconds,120);
});

test('loading, locked books, logout and epoch changes fail closed without rewriting encrypted source',async()=>{
  const h=harness(),entry=h.put(sample()),before=clone(h.books.get(entry.id));
  for(const state of ['loading','error']){h.setStatus(state);assert.equal(h.api.view('emotion').settings,null);await assert.rejects(h.api.saveSettings('emotion',{format:'ebook'}),/먼저 확인/);}
  h.setStatus('ready');h.setAllowed(false);assert.equal(h.api.view('emotion').settings,null);await assert.rejects(h.api.ensure('emotion'),/먼저 확인/);h.setAllowed(true);
  const pending=deferred();h.setReader(()=>pending.promise);const request=h.api.saveSettings('emotion',{format:'ebook'});h.setEpoch();pending.resolve({entry,book:before});
  await assert.rejects(request,/연결 상태가 바뀌/);assert.deepEqual(h.books.get(entry.id),before);assert.equal(h.saves.length,0);
});

test('a changed cipher while reading cannot cache or save the superseded plaintext',async()=>{
  const h=harness(),old=sample(),entry=h.put(old),pending=deferred();h.setReader(()=>pending.promise);
  const request=h.api.saveSettings('emotion',{format:'ebook'}),newBook=sample({review:'다른 기기의 새 글'});h.put(newBook);
  pending.resolve({entry,book:old});await assert.rejects(request,/다른 곳에서 바뀐/);assert.equal(h.saves.length,0);assert.equal(h.books.get(entry.id).review,'다른 기기의 새 글');
});

test('new owner reads start immediately while the previous owner has a pending read; late results stay isolated',async()=>{
  const h=harness(),a=sample({review:'A의 개인 내용'}),b=sample({review:'B의 개인 내용'}),entryA=h.put(a),entryB=h.put(b,'memberB'),late=deferred();
  h.setReader(entry=>entry.userId==='memberA'?late.promise:Promise.resolve({entry,book:b}));
  assert.equal(h.api.view('emotion').status,'loading');assert.equal(h.reads.length,1);h.setOwner('memberB');
  assert.equal(h.api.view('emotion').status,'loading');assert.equal(h.reads.length,2);await flush();
  assert.equal(h.api.view('emotion').book.review,'B의 개인 내용');late.resolve({entry:entryA,book:a});await flush();
  assert.equal(h.api.view('emotion').book.review,'B의 개인 내용');assert.equal(h.entries.get(entryB.id).data,entryB.data);
});

test('reset invalidates in-flight reads even when session identity and epoch are unchanged',async()=>{
  const h=harness(),book=sample(),entry=h.put(book),late=deferred();h.setReader(()=>late.promise);h.api.view('emotion');h.api.reset();
  late.resolve({entry,book});await flush();assert.equal(h.changed,0,'a reset request does not announce or refill the cache');
  h.setReader(null);assert.equal(h.api.view('emotion').status,'loading');await flush();assert.equal(h.api.view('emotion').status,'ready');
});

test('read errors preserve source and a successful explicit ensure recovers without a write',async()=>{
  const h=harness(),entry=h.put(sample()),original=clone(entry);h.setReader(async()=>{throw new Error('연결 실패');});
  assert.equal(h.api.view('emotion').status,'loading');await flush();assert.equal(h.api.view('emotion').status,'error');assert.deepEqual(h.entries.get(entry.id),original);assert.equal(h.saves.length,0);
  h.setReader(null);await h.api.ensure('emotion');assert.equal(h.api.view('emotion').status,'ready');assert.equal(h.saves.length,0);
});

test('cached view data is copied and another source entry cannot be substituted for the exact owner/book ID',async()=>{
  const h=harness(),entry=h.put(sample());await h.api.ensure('emotion');const visible=h.api.view('emotion');visible.book.notes[0].text='화면에서 바꾼 임시 값';visible.book.readingSessions.length=0;
  assert.equal(h.api.view('emotion').book.notes[0].text,'보존할 책 속 문장');assert.equal(h.api.view('emotion').book.readingSessions.length,1);
  const other={...entry,id:Archive.recordId('memberA','arc_shared_thought')};h.setEntry(()=>other);
  assert.equal(h.api.view('emotion').status,'error');await assert.rejects(h.api.ensure('emotion'),/내 책의 기록만/);assert.equal(h.saves.length,0);
});

test('soft-deleted archive books remain preserved and cannot be silently restored by settings or session saves',async()=>{
  const h=harness(),entry=h.put(sample({deleted:true})),before=clone(h.books.get(entry.id));
  await assert.rejects(h.api.ensure('emotion'),/휴지통/);await assert.rejects(h.api.saveSettings('emotion',{format:'ebook'}),/휴지통/);await assert.rejects(h.api.saveSession('emotion',percentSession()),/휴지통/);
  assert.deepEqual(h.books.get(entry.id),before);assert.equal(h.saves.length,0);
});

test('ebook completion never fills legacy paper pages when switching back to paper mode',async()=>{
  const h=harness(),original=sample({status:'completed',currentPage:40,readingSettings:{format:'ebook',ebook:{progressPercent:100,progressKind:'estimated',estimateBasis:'equal-sections',updatedAt:4000}}}),entry=h.put(original);
  await h.api.saveSettings('emotion',Format.changeFormat(original.readingSettings,'paper'));
  const book=h.books.get(entry.id);assert.equal(book.currentPage,40);assert.equal(book.totalPages,200);assert.equal(book.status,'reading');assert.equal(book.readingSettings.ebook.progressPercent,100);
});

test('a stale selected section cannot roll back a newer durable ebook position; format-only changes keep it',async()=>{
  const h=harness(),latest=sample({readingSettings:{format:'ebook',ebook:{sectionId:'new',sectionTitle:'새 목차',progressPercent:80,estimateBasis:'equal-sections',updatedAt:9000}}}),entry=h.put(latest);
  const old={format:'ebook',ebook:{sectionId:'old',sectionTitle:'이전 목차',progressPercent:25,estimateBasis:'equal-sections',updatedAt:8000}};
  await assert.rejects(h.api.saveSettings('emotion',old),/다른 화면/);assert.equal(h.saves.length,0);assert.equal(h.books.get(entry.id).readingSettings.ebook.sectionId,'new');
  await h.api.saveSettings('emotion',{...old,format:'paper'});assert.equal(h.books.get(entry.id).readingSettings.ebook.sectionId,'new');assert.equal(h.books.get(entry.id).readingSettings.format,'paper');
});
