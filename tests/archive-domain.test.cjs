'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const archive=require('../archiveDomain.js');
const crypto=require('../privateCrypto.js');

function sample(overrides={}){
  return {...archive.prepare({title:'임시 테스트 책'}),title:'감정을 읽는 시간',authors:['테스트 저자'],
    description:'감정을 돌아보는 책이다.',startDate:'2026-09-01',endDate:'2026-09-28',rating:4,
    review:'내 마음을 살펴보는 데 도움이 되었다.',...overrides};
}

test('archive IDs are owner-scoped and cannot select unrelated notes or categories',()=>{
  const e={id:archive.recordId('owner-a','arc_test'),userId:'owner-a',bookId:archive.STORAGE_BOOK_ID};
  assert.equal(e.id,'private_archive_owner-a_arc_test');
  assert.equal(archive.isArchiveEntry(e),true);
  assert.equal(archive.archiveId(e),'arc_test');
  for(const invalid of [null,[],{}, {...e,userId:'owner-b'}, {...e,bookId:'thought'},
    {...e,id:'e_regular'}, {...e,id:'private_categories_emotion_owner-a'},
    {...e,id:e.id+'/other'}, {...e,id:'private_archive_owner-a_arc_'}, {...e,userId:undefined}]){
    assert.equal(archive.isArchiveEntry(invalid),false);
    assert.equal(archive.archiveId(invalid),null);
  }
  for(const bad of ['',null,1,' owner ','owner/path']) assert.throws(()=>archive.recordId(bad,'arc_test'));
  for(const bad of ['',null,1,'test','arc_','arc_test/path']) assert.throws(()=>archive.recordId('owner-a',bad));
  assert.notEqual(archive.recordId('owner-a','arc_test'),archive.recordId('owner-b','arc_test'));
});

test('archive metadata preserves reader prose as plain text and ignores unrecognized fields',()=>{
  const input=Object.freeze(sample({title:'  테스트 책  ',authors:Object.freeze([' 한 작가 ','두 작가','한 작가']),
    review:'<script>평가도 문자로만 저장한다.</script>',isAdmin:true}));
  const result=archive.prepare(input);
  assert.equal(result.title,'테스트 책');
  assert.deepEqual(result.authors,['한 작가','두 작가']);
  assert.equal(result.review,input.review);
  assert.equal(result.isAdmin,undefined);
  assert.equal(input.title,'  테스트 책  ');
  result.authors.push('세 번째');
  assert.equal(input.authors.length,3);
  assert.deepEqual(archive.prepare({title:'제목만'}).authors,[]);
  assert.deepEqual(archive.prepare({title:'책',authors:'한 작가, 두 작가'}).authors,['한 작가','두 작가']);
});

test('real calendar dates and reading order are validated without inventing unknown dates',()=>{
  assert.equal(archive.prepare(sample({startDate:'2024-02-29',endDate:''})).startDate,'2024-02-29');
  assert.equal(archive.prepare(sample({startDate:'',endDate:''})).endDate,'');
  for(const value of ['2026-02-29','2026-09-31','2026-13-01','2026-00-01','2026-1-01','0000-01-01','today']){
    assert.throws(()=>archive.prepare(sample({startDate:value})));
    assert.throws(()=>archive.prepare(sample({endDate:value})));
  }
  assert.throws(()=>archive.prepare(sample({startDate:'2026-09-28',endDate:'2026-09-01'})));
  assert.equal(archive.prepare(sample({startDate:'2026-09-28',endDate:'2026-09-28'})).endDate,'2026-09-28');
});

test('book contents preserve section breaks across storage and subsequent personal reading updates',()=>{
  const tableOfContents='1부 마음을 알아차리기\n\n1장 감정의 시작 · 26\n  내 마음의 이야기 · 30\n\n2부 다시 읽기\n2장 회복 · 120';
  const book=archive.decode(archive.encode(sample({tableOfContents,status:'reading',currentPage:0,totalPages:200})));
  assert.equal(book.tableOfContents,tableOfContents);
  const session={id:'ars_toc',seconds:60,startPage:0,endPage:10,createdAt:1000};
  const afterReading=archive.addReadingSession(book,session);
  const afterNote=archive.upsertNote(afterReading,{id:'an_toc',text:'첫 장을 읽었다.',createdAt:2000});
  const edited=archive.upsertNote(afterNote,{id:'an_toc',text:'첫 장에서 배운 점을 남겼다.',createdAt:2000,updatedAt:3000});
  const reloaded=archive.decode(archive.encode(edited));
  assert.equal(reloaded.tableOfContents,tableOfContents);
  assert.equal(reloaded.currentPage,10);
  assert.equal(reloaded.notes[0].text,'첫 장에서 배운 점을 남겼다.');
  assert.equal(archive.removeNote(reloaded,'an_toc',4000).tableOfContents,tableOfContents);
  assert.equal(book.currentPage,0,'updates preserve the original book snapshot');
});

test('legacy archives without contents remain readable and contents have a Unicode-aware limit',()=>{
  const legacy={format:archive.FORMAT,book:{title:'기존 책',description:'기존 소개'}};
  assert.equal(archive.decode(JSON.stringify(legacy)).tableOfContents,'');
  for(const tableOfContents of [undefined,null,''])assert.equal(archive.prepare({title:'책',tableOfContents}).tableOfContents,'');
  const maximum='📚'.repeat(20000);
  assert.equal(archive.decode(archive.encode({title:'책',tableOfContents:maximum})).tableOfContents,maximum);
  assert.throws(()=>archive.prepare({title:'책',tableOfContents:maximum+'가'}),/20000/);
  for(const tableOfContents of [[],{},42,true])assert.throws(()=>archive.prepare({title:'책',tableOfContents}),/형식/);
});

test('fixed note categories survive reading, edits and storage without classifying old notes',()=>{
  const legacy=archive.upsertNote({title:'책',status:'reading',totalPages:100},{id:'old',text:'기존 기록',createdAt:100});
  assert.equal(legacy.notes[0].category,'');
  let book=legacy;
  for(const category of ['quote','thought','question','insight']){
    book=archive.upsertNote(book,{id:category,text:category,category,createdAt:200});
  }
  book=archive.addReadingSession(book,{id:'reading_categories',seconds:60,startPage:0,endPage:20,createdAt:300});
  book=archive.upsertNote(book,{...book.notes[1],text:'다듬은 문장',category:'insight',updatedAt:400});
  const restored=archive.decode(archive.encode(archive.removeNote(book,'question',500)));
  assert.equal(restored.notes[0].category,'');
  assert.equal(restored.notes[1].category,'insight');
  assert.equal(restored.notes[1].createdAt,200);
  assert.equal(restored.notes.find(n=>n.id==='question').category,'question');
  assert.equal(restored.notes.find(n=>n.id==='question').deleted,true);
  for(const category of ['emotion','pcat_custom',42,{},[]])assert.throws(()=>archive.upsertNote(book,{id:'invalid',text:'기록',category,createdAt:600}));
});

test('optional author introduction stays plain text and survives archive storage without inventing metadata',()=>{
  assert.equal(archive.prepare({title:'기존 책'}).authorIntro,'');
  const authorIntro='<b>저자 이름</b>은 글을 쓰는 작가이다.\n두 번째 소개 문장이다.';
  const book=archive.decode(archive.encode({title:'책',authorIntro}));
  assert.equal(book.authorIntro,authorIntro);
  assert.equal(archive.upsertNote(book,{id:'author_note',text:'문장',createdAt:1}).authorIntro,authorIntro);
  assert.throws(()=>archive.prepare({title:'책',authorIntro:'가'.repeat(8001)}),/8000/);
  assert.throws(()=>archive.prepare({title:'책',authorIntro:{}}),/형식/);
});

test('unrated books are distinct from five-star ratings and invalid ratings fail',()=>{
  for(const rating of [undefined,null,'',0,'0']) assert.equal(archive.prepare(sample({rating})).rating,0);
  for(const rating of [1,2,3,4,5,'1','5']) assert.equal(archive.prepare(sample({rating})).rating,Number(rating));
  for(const rating of [-1,6,1.5,'3.5','6',true,NaN,Infinity,{}]) assert.throws(()=>archive.prepare(sample({rating})));
  assert.deepEqual(archive.summary([sample({rating:0}),sample({rating:5}),sample({rating:3})]),
    {count:3,ratedCount:2,averageRating:4});
  assert.deepEqual(archive.summary([]),{count:0,ratedCount:0,averageRating:0});
});

test('cover and source URLs reject script, data, credentials and insecure remote resources',()=>{
  const allowed='https://example.test/cover.jpg?width=200';
  assert.equal(archive.prepare(sample({coverUrl:allowed,sourceUrl:allowed})).coverUrl,allowed);
  assert.equal(archive.prepare(sample({coverUrl:'covers/emotion-cover.webp'})).coverUrl,'covers/emotion-cover.webp');
  for(const url of ['javascript:alert(1)','data:image/svg+xml,<svg>','http://example.test/a',
    '//example.test/a','https://user:secret@example.test/a','/covers/../private','file:///image.jpg']){
    assert.throws(()=>archive.prepare(sample({coverUrl:url})));
    assert.throws(()=>archive.prepare(sample({sourceUrl:url})));
  }
});

test('versioned archive records reject malformed storage instead of generating empty replacements',()=>{
  const value=sample({pageCount:364,providerId:'test-volume-id',source:'Google Books'});
  const encoded=archive.encode(value);
  assert.deepEqual(archive.decode(encoded),value);
  for(const text of [null,{},'', 'null','[]','not json',JSON.stringify(value),
    JSON.stringify({format:'growell-book-archive-v2',book:value}),
    JSON.stringify({format:archive.FORMAT,book:{title:''}})]) assert.throws(()=>archive.decode(text));
  assert.throws(()=>archive.decode(' '.repeat(900001)));
  assert.throws(()=>archive.prepare(sample({title:'가'.repeat(301)})));
  assert.throws(()=>archive.prepare(sample({review:'가'.repeat(10001)})));
  assert.throws(()=>archive.prepare(sample({authors:Array(31).fill('저자')})));
  assert.throws(()=>archive.prepare(sample({pageCount:0})));
});

test('uploaded JPEG covers are bounded and safe cover resolution never emits executable URLs',()=>{
  const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,0,16,255,217]).toString('base64');
  assert.equal(archive.prepare(sample({coverUrl:jpeg})).coverUrl,jpeg);
  assert.equal(archive.safeCoverUrl(jpeg),jpeg);
  for(const invalid of ['data:image/svg+xml,<svg/>','data:image/jpeg;base64,/9j/AAAA',
    'data:image/jpeg;base64,/9j/????','data:image/jpeg;base64,/9j/'+'A'.repeat(700*1024),
    'javascript:alert(1)','covers/test.svg','covers/../secret.jpg']){
    assert.equal(archive.safeCoverUrl(invalid),'');
    assert.throws(()=>archive.prepare(sample({coverUrl:invalid})));
  }
});

test('archive tombstones preserve the book and review while disappearing from active statistics',()=>{
  const original=sample(),deleted=archive.decode(archive.encode({...original,deleted:true}));
  assert.equal(deleted.deleted,true);
  assert.equal(deleted.review,original.review);
  assert.equal(deleted.title,original.title);
  assert.deepEqual(archive.summary([deleted,sample({rating:5})]),{count:1,ratedCount:1,averageRating:5});
  assert.equal(archive.prepare({title:'이전 버전 책'}).deleted,false);
  assert.throws(()=>archive.prepare(sample({deleted:'true'})));
});

test('archive review and reading dates use existing owner-bound private encryption and recovery',async()=>{
  const entry={id:archive.recordId('owner-a','arc_test'),userId:'owner-a',bookId:archive.STORAGE_BOOK_ID,createdAt:1};
  const passwordKey=await crypto.newKey(),dataKey=await crypto.newKey();
  const plain=archive.encode(sample());
  const stored={...entry,...await crypto.create(entry,passwordKey,dataKey,plain)};
  assert.equal(stored.data.includes('내 마음'),false);
  assert.deepEqual(archive.decode((await crypto.read(stored,passwordKey)).text),sample());
  await assert.rejects(()=>crypto.read({...stored,userId:'owner-b'},passwordKey));
  await assert.rejects(()=>crypto.read({...stored,id:archive.recordId('owner-a','arc_other')},passwordKey));
  const recovery=await crypto.recoveryFile({id:'owner-a',loginId:'qa-member'},[dataKey],[passwordKey]);
  const restored=await crypto.recover(stored,recovery);
  assert.equal(restored.text,plain);
  const nextPassword=await crypto.newKey();
  const rewrapped={...stored,...await crypto.rewrap(stored,nextPassword,restored.dataKey)};
  assert.equal(rewrapped.id,entry.id);
  assert.equal(rewrapped.createdAt,1);
  assert.equal((await crypto.read(rewrapped,nextPassword)).text,plain);
});

test('browser module exposes archive helpers without requiring Node',()=>{
  const browser={URL};vm.createContext(browser);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../archiveDomain.js'),'utf8'),browser);
  assert.deepEqual(Object.keys(browser.GrowellArchiveDomain).sort(),Object.keys(archive).sort());
  assert.equal(browser.GrowellArchiveDomain.encode(sample()),archive.encode(sample()));
});

test('note page, paper and attachment survive edits and encrypted archive roundtrips',()=>{
  const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,0,16,255,217]).toString('base64');
  const note={id:'note-media',text:'책 속 문장',html:'<p>책 속 문장</p>',page:103,bgColor:'#E4EEE6',photo:jpeg,createdAt:10};
  const original=archive.upsertNote(sample(),note);
  const saved=archive.decode(archive.encode(original));
  assert.equal(saved.notes[0].page,103);assert.equal(saved.notes[0].bgColor,'#E4EEE6');assert.equal(saved.notes[0].photo,jpeg);
  const edited=archive.upsertNote(saved,{...saved.notes[0],text:'다시 읽은 문장',updatedAt:20});
  assert.equal(edited.notes[0].photo,jpeg);assert.equal(edited.notes[0].createdAt,10);
  const deleted=archive.removeNote(edited,'note-media',30);
  assert.equal(deleted.notes[0].deleted,true);assert.equal(deleted.notes[0].page,103);assert.equal(deleted.notes[0].photo,jpeg);
  const legacy=archive.prepare(sample({notes:[{id:'old',text:'기존 기록',createdAt:1}]})).notes[0];
  assert.equal(legacy.page,null);assert.equal(legacy.bgColor,'');assert.equal(legacy.photo,'');
});

test('note presentation fields reject unsafe URLs, unsupported paper and invalid page bounds',()=>{
  const base={id:'note-check',text:'노트',createdAt:1};
  for(const patch of [{page:-1},{page:100001},{page:1.5},{bgColor:'red;position:fixed'},{bgColor:'#ffffff'},
    {photo:'javascript:alert(1)'},{photo:'data:image/svg+xml,<svg/>'},{photo:'http://example.org/image.jpg'}]){
    assert.throws(()=>archive.upsertNote(sample(),{...base,...patch}));
  }
  assert.equal(archive.upsertNote(sample(),{...base,page:'0',photo:'https://example.org/note.jpg'}).notes[0].page,0);
});

test('legacy finished books migrate to completed while new reading states validate page progress',()=>{
  const legacy={format:archive.FORMAT,book:{title:'이전에 읽은 책',pageCount:200,rating:4}};
  const migrated=archive.decode(JSON.stringify(legacy));
  assert.equal(migrated.status,'completed');assert.equal(migrated.currentPage,200);assert.equal(migrated.totalPages,200);
  assert.deepEqual(migrated.readingSessions,[]);assert.deepEqual(migrated.notes,[]);
  const reading=archive.prepare({title:'읽는 책',status:'reading',currentPage:'37',totalPages:'200'});
  assert.deepEqual(archive.progress(reading),{currentPage:37,totalPages:200,percent:19});
  assert.deepEqual(archive.progress({title:'쪽수 미상',status:'reading',currentPage:37}),{currentPage:37,totalPages:null,percent:null});
  assert.equal(archive.prepare({...reading,status:'unread'}).currentPage,0);
  assert.equal(archive.prepare({...reading,status:'completed'}).currentPage,200);
  for(const change of [{status:'future'},{status:null},{currentPage:-1},{currentPage:2.4},{currentPage:201},
    {totalPages:0},{totalPages:Infinity},{totalPages:1.5},{totalPages:100001}]){
    assert.throws(()=>archive.prepare({...reading,...change}));
  }
});

test('reading sessions are idempotent, accumulate only their own book time and complete at the last page',()=>{
  const initial=archive.prepare({title:'독서 기록',status:'unread',totalPages:100});
  const session={id:'ars_one',seconds:90,startPage:0,endPage:10,createdAt:1000};
  const reading=archive.addReadingSession(initial,session);
  assert.equal(reading.status,'reading');assert.equal(reading.currentPage,10);assert.equal(archive.totalReadingSeconds(reading),90);
  assert.equal(initial.readingSessions.length,0,'helpers do not mutate the caller snapshot');
  assert.deepEqual(archive.addReadingSession(reading,session),reading);
  assert.throws(()=>archive.addReadingSession(reading,{...session,seconds:91}),/다른 내용/);
  const complete=archive.addReadingSession(reading,{id:'ars_two',seconds:600,startPage:10,endPage:100,createdAt:2000});
  assert.equal(complete.status,'completed');assert.equal(archive.progress(complete).percent,100);assert.equal(archive.totalReadingSeconds(complete),690);
  assert.equal(archive.totalReadingSeconds({title:'다른 책'}),0);
  const noTotal=archive.addReadingSession({title:'전체 쪽수 모름',status:'reading'},session,{complete:true});
  assert.equal(noTotal.status,'completed');assert.equal(noTotal.totalPages,null);assert.equal(noTotal.currentPage,10);
});

test('older timer recovery preserves newer progress while a later re-read can move to an earlier page',()=>{
  const first=archive.addReadingSession({title:'다시 읽기',status:'reading',totalPages:200},{id:'latest',seconds:60,startPage:70,endPage:90,createdAt:3000});
  const recovered=archive.addReadingSession(first,{id:'older',seconds:20,startPage:0,endPage:10,createdAt:1000},{complete:true});
  assert.equal(recovered.currentPage,90);assert.equal(recovered.status,'reading');assert.equal(archive.totalReadingSeconds(recovered),80);
  const reread=archive.addReadingSession(recovered,{id:'reread',seconds:80,startPage:5,endPage:20,createdAt:4000});
  assert.equal(reread.currentPage,20);assert.equal(archive.totalReadingSeconds(reread),160);
});

test('legacy unknown starting pages retain display and time totals but remain explicitly unknown after storage',()=>{
  const known={id:'known',seconds:30,startPage:0,endPage:10,createdAt:1000};
  const missing={id:'missing',seconds:60,endPage:20,createdAt:2000};
  const marked={id:'marked',seconds:90,startPage:0,endPage:30,createdAt:3000,startPageKnown:false};
  const input={title:'이전 독서 기록',status:'reading',currentPage:30,totalPages:100,readingSessions:[known,missing,marked]};
  const original=JSON.stringify(input),prepared=archive.prepare(input),restored=archive.decode(archive.encode(prepared));
  assert.deepEqual(restored.readingSessions,[known,{...missing,startPage:0,startPageKnown:false},marked]);
  assert.equal(restored.currentPage,30);assert.equal(archive.totalReadingSeconds(restored),180);
  assert.deepEqual(archive.prepare(restored),restored);assert.equal(JSON.stringify(input),original);
  assert.deepEqual(archive.prepare({title:'명시된 기록',readingSessions:[{...known,startPageKnown:true}]}).readingSessions,[known]);
  const nullStart=archive.prepare({title:'누락된 쪽수',readingSessions:[{...missing,startPage:null}]}).readingSessions[0];
  assert.equal(nullStart.startPage,0);assert.equal(nullStart.startPageKnown,false);
  assert.deepEqual(archive.addReadingSession(restored,missing),restored,'retrying a legacy session stays idempotent');
});

test('corrupt session arrays and invalid reading values fail without dropping the original history',()=>{
  const session={id:'ars_1',seconds:30,startPage:0,endPage:10,createdAt:1000};
  for(const change of [{id:''},{id:'bad/id'},{seconds:-1},{seconds:0.1},{seconds:31536001},{createdAt:0},
    {createdAt:Infinity},{startPage:-1},{startPage:11},{endPage:100001}]){
    assert.throws(()=>archive.prepare({title:'책',readingSessions:[{...session,...change}]}));
  }
  for(const readingSessions of [null,{},[null],[session,session],Array(1)]) assert.throws(()=>archive.prepare({title:'책',readingSessions}));
  assert.throws(()=>archive.addReadingSession({title:'책',status:'reading',totalPages:5},session));
});

test('personal archive notes preserve identity and timestamps through edit and soft deletion',()=>{
  const original=archive.prepare({title:'기록할 책',status:'reading'}),note={id:'an_1',text:'읽으며 든 생각',createdAt:1000};
  const added=archive.upsertNote(original,note);
  assert.equal(original.notes.length,0);assert.equal(added.notes.length,1);
  assert.equal(added.notes[0].deleted,false);assert.equal(added.notes[0].updatedAt,null);
  const edited=archive.upsertNote(added,{...note,text:'생각을 더 적는다.',updatedAt:2000});
  assert.equal(edited.notes[0].createdAt,1000);assert.equal(edited.notes[0].text,'생각을 더 적는다.');
  assert.throws(()=>archive.upsertNote(edited,{...note,createdAt:999,updatedAt:3000}),/시각/);
  assert.throws(()=>archive.upsertNote(edited,{...note,updatedAt:1500}),/다른 곳/);
  const removed=archive.removeNote(edited,'an_1',3000);
  assert.equal(removed.notes[0].deleted,true);assert.equal(removed.notes[0].text,'생각을 더 적는다.');
  assert.equal(removed.notes[0].createdAt,1000);assert.equal(removed.notes[0].updatedAt,3000);
  assert.deepEqual(archive.removeNote(removed,'an_1',4000),removed);
  assert.deepEqual(archive.decode(archive.encode(removed)),removed);
});

test('archive notes reject corrupt or oversized data instead of silently removing user writing',()=>{
  const note={id:'an_1',text:'본문',createdAt:1000};
  for(const change of [{text:''},{text:'가'.repeat(10001)},{id:'<script>'},{createdAt:0},{updatedAt:999},{deleted:'yes'}]){
    assert.throws(()=>archive.prepare({title:'책',notes:[{...note,...change}]}));
  }
  for(const notes of [null,{},[null],[note,note],Array(1)]) assert.throws(()=>archive.prepare({title:'책',notes}));
  assert.throws(()=>archive.removeNote({title:'책'},'an_missing',2000),/찾을 수/);
});

test('archive classifications normalize optional legacy fields without sharing caller arrays',()=>{
  const legacy=archive.decode(JSON.stringify({format:archive.FORMAT,book:{title:'이전 책'}}));
  assert.deepEqual(legacy.genres,[]);assert.deepEqual(legacy.themes,[]);assert.equal(legacy.linkedBookId,'');assert.equal(legacy.genreSource,'');
  const genres=[' 심리학 ','자기계발','심리학'],themes=['emotion','thought','emotion'];
  const book=archive.prepare({title:'책',genres,themes,linkedBookId:'emotion',genreSource:'yes24'});
  assert.deepEqual(book.genres,['심리학','자기계발']);assert.deepEqual(book.themes,['emotion','thought']);
  book.genres.push('철학');book.themes.push('body');assert.equal(genres.length,3);assert.equal(themes.length,3);
  for(const genreSource of ['','yes24','google','manual'])assert.equal(archive.prepare({title:'책',genreSource}).genreSource,genreSource);
  for(const linkedBookId of ['','emotion','thought','body','action'])assert.equal(archive.prepare({title:'책',linkedBookId}).linkedBookId,linkedBookId);
  const maximum=Array.from({length:8},(_,i)=>String(i)+'📚'.repeat(79));
  assert.deepEqual(archive.decode(archive.encode({title:'책',genres:maximum})).genres,maximum);
  for(const change of [{genres:'심리학'},{genres:['']},{genres:[{}]},{genres:Array(1)},{genres:Array.from({length:9},(_,i)=>'장르'+i)},
    {genres:['가'.repeat(81)]},{themes:['unknown']},{themes:'emotion'},{linkedBookId:'other'},{genreSource:'unsupported'}]){
    assert.throws(()=>archive.prepare({title:'책',...change}));
  }
});

test('rich note metadata survives edit, storage, reading updates and deletion while plain text remains mandatory',()=>{
  const original={id:'note_rich',text:'중요한 문장\n나의 생각',title:'첫 장의 기록',html:'<p><strong>중요한 문장</strong></p>\n<p>나의 생각</p>',createdAt:1000};
  const book=archive.upsertNote({title:'책',status:'reading',totalPages:100,genres:['문학'],themes:['thought']},original);
  const read=archive.addReadingSession(book,{id:'reading_rich',seconds:30,startPage:0,endPage:10,createdAt:2000});
  const edited=archive.upsertNote(read,{...original,title:'다듬은 기록',updatedAt:3000});
  const reloaded=archive.decode(archive.encode(archive.removeNote(edited,original.id,4000)));
  assert.equal(reloaded.notes[0].html,original.html);assert.equal(reloaded.notes[0].title,'다듬은 기록');
  assert.equal(reloaded.notes[0].text,original.text);assert.equal(reloaded.notes[0].deleted,true);
  assert.deepEqual(reloaded.genres,['문학']);assert.deepEqual(reloaded.themes,['thought']);
  const plain=archive.upsertNote({title:'기존 책'},{id:'legacy',text:'예전 글',createdAt:1}).notes[0];
  assert.equal(plain.html,'');assert.equal(plain.title,'');
  assert.equal(archive.upsertNote({title:'책'},{...original,title:'가'.repeat(300),html:'가'.repeat(100000)}).notes[0].html.length,100000);
  for(const change of [{text:''},{text:'가'.repeat(10001)},{title:'가'.repeat(301)},{html:'가'.repeat(100001)},{html:[]},{title:42}]){
    assert.throws(()=>archive.upsertNote({title:'책'},{...original,...change}));
  }
});

function linkedRow(id='arc_personal',book={},owner='owner-a'){
  return {entry:{id:archive.recordId(owner,id),userId:owner,bookId:archive.STORAGE_BOOK_ID,createdAt:100},book:archive.prepare({title:'모임 책',authors:['작가'],status:'reading',totalPages:200,...book})};
}
function sharedSnapshot(change={}){
  return {bookId:'emotion',book:archive.prepare({title:'모임 책',authors:['작가'],totalPages:200,description:'책 소개',genres:['심리학']}),
    currentPage:20,totalPages:200,readingSessions:[{id:'shared_log',seconds:120,startPage:0,endPage:20,createdAt:2000}],startedAt:1000,updatedAt:3000,active:false,...change};
}

test('shared reading creates a deterministic owner-specific virtual archive without changing inputs',()=>{
  const snapshot=sharedSnapshot(),original=structuredClone(snapshot);
  const rows=archive.mergeLinkedRows([], [snapshot], 'owner-a');
  assert.equal(rows.length,1);assert.equal(rows[0].virtual,true);
  assert.deepEqual(rows[0].entry,{id:'private_archive_owner-a_arc_shared_emotion',userId:'owner-a',bookId:archive.STORAGE_BOOK_ID,createdAt:1000,updatedAt:3000});
  assert.equal(rows[0].book.linkedBookId,'emotion');assert.deepEqual(rows[0].book.themes,['emotion']);
  assert.deepEqual(rows[0].book.genres,['심리학']);assert.equal(rows[0].book.description,'책 소개');
  assert.equal(archive.progress(rows[0].book).percent,10);assert.equal(archive.totalReadingSeconds(rows[0].book),120);
  assert.deepEqual(snapshot,original);
  const again=archive.mergeLinkedRows(rows,[snapshot],'owner-a');assert.deepEqual(again,rows);
  assert.notEqual(archive.mergeLinkedRows([],[snapshot],'owner-b')[0].entry.id,rows[0].entry.id);
});

test('automatic shared books appear only after progress, a session or an active timer and derive reading state',()=>{
  const idle=sharedSnapshot({currentPage:0,readingSessions:[],startedAt:undefined,updatedAt:undefined});
  assert.deepEqual(archive.mergeLinkedRows([],[idle],'owner-a'),[]);
  for(const change of [{active:true},{currentPage:1},{readingSessions:[{id:'time_only',seconds:10,startPage:0,endPage:0,createdAt:2}]}]){
    const row=archive.mergeLinkedRows([],[{...idle,...change}],'owner-a')[0];assert.equal(row.book.status,'reading');assert.equal(row.entry.createdAt,1);
  }
  const complete=archive.mergeLinkedRows([],[sharedSnapshot({currentPage:200})],'owner-a')[0];
  assert.equal(complete.book.status,'completed');assert.equal(complete.book.currentPage,200);
  const noTotal=archive.mergeLinkedRows([],[sharedSnapshot({totalPages:null})],'owner-a')[0];
  assert.equal(noTotal.book.status,'reading');assert.equal(noTotal.book.totalPages,null);
  assert.equal(archive.mergeLinkedRows([],[{...idle,active:true,updatedAt:50}],'owner-a')[0].entry.createdAt,50);
});

test('link matching prefers explicit links then ISBN and then both title and authors',()=>{
  const isbn='9781234567890',snapshot=sharedSnapshot({book:archive.prepare({title:'모임 책',authors:['작가'],isbn,totalPages:200})});
  const titleMatch=linkedRow('arc_title'),isbnMatch=linkedRow('arc_isbn',{title:'개인적으로 쓴 제목',isbn:'978-1234567890'}),explicit=linkedRow('arc_explicit',{linkedBookId:'emotion',title:'다른 제목'});
  const priority=archive.mergeLinkedRows([titleMatch,isbnMatch,explicit],[snapshot],'owner-a');
  assert.equal(priority.length,3);assert.equal(priority[2].book.currentPage,20);assert.equal(priority[0].book.linkedBookId,'');assert.equal(priority[1].book.linkedBookId,'');
  const byIsbn=archive.mergeLinkedRows([titleMatch,isbnMatch],[snapshot],'owner-a');
  assert.equal(byIsbn.length,2);assert.equal(byIsbn[1].book.linkedBookId,'emotion');assert.equal(byIsbn[0].book.linkedBookId,'');
  const byName=archive.mergeLinkedRows([linkedRow('arc_title',{title:'  모임   책 ',authors:[' 작가 ']})],[snapshot],'owner-a');
  assert.equal(byName.length,1);assert.equal(byName[0].entry.id,titleMatch.entry.id);assert.equal(byName[0].book.linkedBookId,'emotion');
  for(const book of [{authors:['다른 작가']},{authors:[]},{isbn:'9789876543210'},{linkedBookId:'thought'}]){
    assert.equal(archive.mergeLinkedRows([linkedRow('arc_distinct',book)],[snapshot],'owner-a').length,2);
  }
});

test('linked updates preserve private content, explicit empty themes, tombstones and stable row identity',()=>{
  const personal=linkedRow('arc_personal',{linkedBookId:'emotion',genres:['내 분류'],themes:[],genreSource:'manual',rating:5,review:'나의 감상',
    startDate:'2026-01-01',endDate:'2026-02-01',deleted:true,notes:[{id:'my_note',text:'나의 문장',html:'<p>나의 문장</p>',createdAt:10}],
    readingSessions:[{id:'old_snapshot',seconds:120,startPage:0,endPage:20,createdAt:2000}],linkedSessionIds:['old_snapshot']});
  const original=structuredClone(personal),rows=archive.mergeLinkedRows([personal],[sharedSnapshot()],'owner-a');
  assert.equal(rows.length,1);assert.deepEqual(rows[0].entry,personal.entry);assert.equal(rows[0].virtual,undefined);
  for(const key of ['genres','themes','genreSource','rating','review','startDate','endDate','deleted','notes'])assert.deepEqual(rows[0].book[key],personal.book[key]);
  assert.equal(rows[0].book.readingSessions.length,1);assert.equal(rows[0].book.readingSessions[0].id,'shared_log');assert.equal(archive.totalReadingSeconds(rows[0].book),120);
  assert.deepEqual(personal,original);
  const reset=archive.mergeLinkedRows(rows,[sharedSnapshot({currentPage:0,readingSessions:[],active:false})],'owner-a')[0];
  assert.equal(reset.book.currentPage,0);assert.equal(reset.book.status,'unread');assert.equal(reset.book.deleted,true);
  assert.deepEqual(reset.book.notes,personal.book.notes);
});

test('a deleted matching ISBN or renamed materialized automatic book is never resurrected or duplicated',()=>{
  const book=archive.prepare({title:'모임 책',authors:['작가'],isbn:'9781234567890',totalPages:200});
  const deleted=linkedRow('arc_deleted',{isbn:book.isbn,deleted:true});
  const rows=archive.mergeLinkedRows([deleted],[sharedSnapshot({book})],'owner-a');
  assert.equal(rows.length,1);assert.equal(rows[0].book.deleted,true);
  const materialized=linkedRow('arc_shared_emotion',{title:'새 제목',authors:['새 저자'],deleted:true});
  const result=archive.mergeLinkedRows([materialized],[sharedSnapshot()],'owner-a');
  assert.equal(result.length,1);assert.equal(result[0].book.title,'새 제목');assert.equal(result[0].book.deleted,true);assert.equal(result[0].book.linkedBookId,'emotion');
});

test('shared merges isolate owners and do not inspect another member private payload',()=>{
  const foreign=linkedRow('arc_foreign',{},'owner-b');Object.defineProperty(foreign,'book',{get(){throw Error('foreign payload was read');}});
  const own=linkedRow('arc_own',{linkedBookId:'emotion'});
  const result=archive.mergeLinkedRows([foreign,own],[{userId:'owner-b',bookId:'emotion',get book(){throw Error('foreign snapshot was read');}}],'owner-a');
  assert.equal(result.length,1);assert.equal(result[0].entry.userId,'owner-a');assert.equal(result[0].book.currentPage,0);
  const snapshot=sharedSnapshot({userId:'owner-a'});assert.equal(archive.mergeLinkedRows([foreign],[snapshot],'owner-a').length,1);
  assert.throws(()=>archive.mergeLinkedRows([],[],''));
  assert.throws(()=>archive.mergeLinkedRows([{entry:{id:'ordinary_note',userId:'owner-a'},book:{title:'개인 메모'}}],[],'owner-a'));
});

test('invalid linked snapshots fail without mutating personal data or silently clearing saved reading history',()=>{
  const row=linkedRow('arc_own',{linkedBookId:'emotion'}),original=structuredClone(row);
  for(const change of [{bookId:'invalid'},{currentPage:201},{currentPage:-1},{totalPages:0},{readingSessions:null},
    {active:'yes'},{startedAt:0},{updatedAt:Infinity},{readingSessions:[{id:'bad',seconds:-1,createdAt:2}]}]){
    assert.throws(()=>archive.mergeLinkedRows([row],[sharedSnapshot(change)],'owner-a'));
    assert.deepEqual(row,original);
  }
  assert.throws(()=>archive.mergeLinkedRows([row],[sharedSnapshot(),sharedSnapshot()],'owner-a'),/중복/);
});

test('independent archive histories are never automatically replaced by ISBN or title matching',()=>{
  const saved={id:'independent',seconds:300,startPage:0,endPage:12,createdAt:100};
  for(const isbn of ['', '9781234567890']){
    const row=linkedRow('arc_independent',{isbn,readingSessions:[saved],notes:[{id:'note',text:'개인 기록',createdAt:100}]});
    const snapshot=sharedSnapshot({book:archive.prepare({...sharedSnapshot().book,isbn})});
    const rows=archive.mergeLinkedRows([row],[snapshot],'owner-a');
    assert.equal(rows.length,2);assert.deepEqual(rows[0],row);assert.equal(rows[1].virtual,true);
    assert.equal(rows[0].book.linkedBookId,'');assert.equal(rows[1].book.linkedBookId,'emotion');
  }
});

test('linked legacy history survives storage and note edits while shared snapshots update without double counting',()=>{
  const independent={id:'independent',seconds:300,startPage:0,endPage:12,createdAt:100};
  const row=linkedRow('arc_legacy',{linkedBookId:'emotion',readingSessions:[independent,sharedSnapshot().readingSessions[0]]});
  let merged=archive.mergeLinkedRows([row],[sharedSnapshot()],'owner-a')[0];
  assert.equal(archive.totalReadingSeconds(merged.book),420);assert.deepEqual(merged.book.linkedSessionIds,['shared_log']);
  merged.book=archive.decode(archive.encode(archive.upsertNote(merged.book,{id:'note',text:'유지된 기록',createdAt:3000})));
  merged=archive.mergeLinkedRows([merged],[sharedSnapshot({readingSessions:[]})],'owner-a')[0];
  assert.deepEqual(merged.book.readingSessions,[independent]);assert.equal(merged.book.notes[0].text,'유지된 기록');
  assert.deepEqual(merged.book.linkedSessionIds,[]);
  assert.deepEqual(archive.prepare({title:'이전 책'}).linkedSessionIds,[]);
  for(const linkedSessionIds of ['id',['bad id'],Array(1),Array.from({length:10001},(_,i)=>'id_'+i)])assert.throws(()=>archive.prepare({title:'책',linkedSessionIds}));
  const conflicting=linkedRow('arc_conflict',{linkedBookId:'emotion',readingSessions:[{...sharedSnapshot().readingSessions[0],seconds:999}]});
  assert.throws(()=>archive.mergeLinkedRows([conflicting],[sharedSnapshot()],'owner-a'),/다른 내용/);
});

test('legacy shared snapshots merge start-page provenance conservatively without changing actual reading history',()=>{
  const shared=sharedSnapshot().readingSessions[0],independent={id:'personal',seconds:300,startPage:10,endPage:20,createdAt:1000};
  for(const [saved,incoming] of [[shared,{...shared,startPageKnown:false}],[{...shared,startPageKnown:false},shared]]){
    const row=linkedRow('arc_legacy_flag',{linkedBookId:'emotion',readingSessions:[independent,saved]}),snapshot=sharedSnapshot({readingSessions:[incoming]});
    const original=JSON.stringify({row,snapshot});
    const merged=archive.mergeLinkedRows([row],[snapshot],'owner-a')[0];
    assert.equal(JSON.stringify({row,snapshot}),original,'neither the saved record nor incoming snapshot is mutated');
    assert.deepEqual(merged.book.readingSessions,[independent,{...shared,startPageKnown:false}]);
    assert.equal(archive.totalReadingSeconds(merged.book),420);assert.equal(merged.book.currentPage,snapshot.currentPage);
    assert.deepEqual(archive.decode(archive.encode(merged.book)).readingSessions,merged.book.readingSessions);
    assert.deepEqual(merged.book.linkedSessionIds,[shared.id]);
  }
});

test('legacy shared snapshot metadata compatibility never accepts conflicting pages, time, or timestamp',()=>{
  const shared=sharedSnapshot().readingSessions[0],row=linkedRow('arc_conflicting_flag',{linkedBookId:'emotion',readingSessions:[shared]});
  const original=JSON.stringify(row);
  for(const difference of [{seconds:shared.seconds+1},{createdAt:shared.createdAt+1},{startPage:1},{endPage:shared.endPage+1}]){
    assert.throws(()=>archive.mergeLinkedRows([row],[sharedSnapshot({readingSessions:[{...shared,...difference,startPageKnown:false}]})],'owner-a'),/다른 내용/);
    assert.equal(JSON.stringify(row),original);
  }
  const distinct={...shared,id:'different_identity',startPageKnown:false};
  const merged=archive.mergeLinkedRows([row],[sharedSnapshot({readingSessions:[distinct]})],'owner-a')[0];
  assert.deepEqual(merged.book.readingSessions,[shared,distinct],'different session identities remain separate records');
  assert.equal(archive.totalReadingSeconds(merged.book),shared.seconds*2);
});
