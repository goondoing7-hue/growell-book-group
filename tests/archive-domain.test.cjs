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
