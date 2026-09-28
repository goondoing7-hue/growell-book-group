'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const habits=require('../readingHabit.js'),archive=require('../archiveDomain.js');
const prefix='growell-reading-habit-v1:',owner='reader',today='2026-09-29';
const at=(day,hour=12)=>new Date(2026,8,day,hour,0,0).getTime();
const goal=(extra={})=>({bookId:'private_archive_reader_arc_book',linkedBookId:'',targetPages:10,...extra});
const session=(id,startPage,endPage,createdAt=at(29))=>({id,startPage,endPage,createdAt});
const row=(sessions=[],extra={},userId=owner,id=goal().bookId)=>({entry:{id,userId},book:{title:'함께 읽는 책',deleted:false,linkedBookId:'',currentPage:500,readingSessions:sessions,...extra}});
const result=(extra={})=>({pages:0,targetPages:10,achieved:false,available:true,bookTitle:'함께 읽는 책',...extra});

test('versioned reading goals round trip without altering the displayed goal or the input object',()=>{
  const input=goal({ignored:'not stored'}),text='  매일 10쪽 읽기\n함께 읽어요  ',before=JSON.stringify(input);
  const stored=habits.encode(text,input);assert.ok(stored.startsWith(prefix));
  assert.deepEqual(habits.decode(stored),{goal:text,readingGoal:goal()});
  assert.equal(JSON.stringify(input),before);assert.deepEqual(habits.normalizeGoal({bookId:'book',targetPages:1}),{bookId:'book',linkedBookId:'',targetPages:1});
  assert.notEqual(habits.normalizeGoal(input),input);
});

test('legacy goals and malformed or unknown envelopes are preserved exactly instead of disappearing',()=>{
  for(const raw of ['', '  기존 목표\r\n 그대로  ','매일 "10쪽" / 20분',prefix+'{broken',prefix+'null',prefix+'[]',prefix+JSON.stringify({goal:12,readingGoal:goal()}),prefix+JSON.stringify({goal:'목표',readingGoal:goal({targetPages:0})}),'growell-reading-habit-v2:'+JSON.stringify({goal:'다음 버전'})]){
    assert.deepEqual(habits.decode(raw),{goal:raw,readingGoal:null});
    assert.equal(habits.encode(raw,null),raw);assert.equal(habits.encode(raw),raw);
  }
  assert.deepEqual(habits.decode(null),{goal:'',readingGoal:null});
});

test('connection IDs and integer page targets reject malformed or oversized values',()=>{
  for(const value of [null,[],{},goal({bookId:''}),goal({bookId:'book id'}),goal({bookId:'b'.repeat(385)}),goal({linkedBookId:'b'.repeat(161)}),goal({linkedBookId:12}),goal({targetPages:'10'}),goal({targetPages:0}),goal({targetPages:-1}),goal({targetPages:1.5}),goal({targetPages:100001}),goal({targetPages:NaN}),goal({targetPages:Infinity})])assert.equal(habits.normalizeGoal(value),null);
  for(const targetPages of [1,100000])assert.equal(habits.normalizeGoal(goal({targetPages})).targetPages,targetPages);
  assert.equal(habits.normalizeGoal(goal({bookId:'b'.repeat(384),linkedBookId:'l'.repeat(160)})).bookId.length,384);
  assert.throws(()=>habits.encode('목표',goal({targetPages:0})),TypeError);assert.throws(()=>habits.encode(null,goal()),TypeError);
});

test('today sums completed session deltas, counts re-reading, and only reports achievement',()=>{
  const rows=[row([session('morning',10,16),session('evening',16,21),session('reread',10,14),session('yesterday',0,100,at(28))])];
  const before=JSON.stringify(rows),readingGoal=Object.freeze(goal());
  assert.deepEqual(habits.progress(readingGoal,rows,owner,today),result({pages:15,achieved:true}));
  assert.deepEqual(habits.progress(goal({targetPages:16}),rows,owner,today),result({pages:15,targetPages:16}));
  assert.equal(JSON.stringify(rows),before);assert.equal(rows[0].book.checkedDates,undefined);
});

test('local midnight boundaries use the session timestamp rather than UTC slicing or the current page',()=>{
  const rows=[row([session('previous',0,90,at(29)-12*60*60*1000-1),session('midnight',0,3,at(29,0)),session('last',3,7,at(30,0)-1),session('next',0,90,at(30,0))])];
  assert.deepEqual(habits.progress(goal(),rows,owner,today),result({pages:7}));
  assert.deepEqual(habits.progress(goal(),[row([])],owner,today),result());
});

test('invalid, empty, negative, inferred, deleted, and duplicate session ranges cannot inflate pages',()=>{
  const valid=session('saved',20,26),sessions=[valid,{...valid},{...valid,endPage:999},session('zero',8,8),session('backwards',8,2),session('negative',-1,2),session('fraction',1,2.5),session('oversize',0,100001),session('string','2',8),session('bad-time',0,50,'2026-09-29'),session('no-time',0,50,null),session('notfinite',0,50,Infinity),{id:'end-only',endPage:500,createdAt:at(29)},{id:'start-only',startPage:0,createdAt:at(29)},session('',0,50),{...session('deleted',0,50),deleted:true},null];
  assert.deepEqual(habits.progress(goal(),[row(sessions)],owner,today),result({pages:6}));
});

test('only an exact owned book supplies progress and deleted or ambiguous identities stay unavailable',()=>{
  const unavailable=result({available:false,bookTitle:''}),sameTitle=row([session('other-book',0,50)],{},owner,'other-book');
  assert.deepEqual(habits.progress(goal(),[row([session('foreign',0,50)],{},'other'),sameTitle],owner,today),unavailable);
  assert.deepEqual(habits.progress(goal(),[row([session('deleted',0,50)],{deleted:true})],owner,today),unavailable);
  assert.deepEqual(habits.progress(goal(),[row(),row()],owner,today),unavailable);
  for(const [rows,user,date] of [[[],owner,today],[null,owner,today],[[],null,today],[[],owner,'2026-02-30'],[[],owner,'invalid']])assert.deepEqual(habits.progress(goal(),rows,user,date),unavailable);
  assert.deepEqual(habits.progress(null,[row()],owner,today),{pages:0,targetPages:0,achieved:false,available:false,bookTitle:''});
});

test('only a former virtual shared-book identity can fall back to one owned linked book',()=>{
  const shared=goal({bookId:'private_archive_reader_arc_shared_emotion',linkedBookId:'emotion'}),linked=row([session('linked',0,12)],{linkedBookId:'emotion'});
  assert.deepEqual(habits.progress(shared,[linked],owner,today),result({pages:12,achieved:true}));
  const unavailable=result({available:false,bookTitle:''});
  assert.deepEqual(habits.progress(goal({bookId:'missing',linkedBookId:'emotion'}),[linked],owner,today),unavailable);
  assert.deepEqual(habits.progress({...shared,bookId:'private_archive_other_arc_shared_emotion'},[linked],owner,today),unavailable);
  assert.deepEqual(habits.progress(shared,[{...linked,entry:{...linked.entry,userId:'other'}}],owner,today),unavailable);
  assert.deepEqual(habits.progress(shared,[linked,row([],{linkedBookId:'emotion'},owner,'second')],owner,today),unavailable);
  assert.deepEqual(habits.progress(shared,[linked,row([],{deleted:true,linkedBookId:'emotion'},owner,shared.bookId)],owner,today),unavailable);
  assert.deepEqual(habits.progress(shared,[row([],{linkedBookId:'thought'},owner,shared.bookId),linked],owner,today),result());
});

test('archive merged virtual and materialized rows retain their reading goal connection',()=>{
  const snapshot={bookId:'emotion',userId:owner,book:{title:'모임 책',authors:['저자'],linkedBookId:'emotion'},currentPage:15,readingSessions:[{...session('shared-today',0,15),seconds:60}]};
  const virtual=archive.mergeLinkedRows([], [snapshot],owner),savedGoal=goal({bookId:virtual[0].entry.id,linkedBookId:'emotion'});
  assert.equal(virtual[0].virtual,true);
  assert.deepEqual(habits.progress(savedGoal,virtual,owner,today),result({pages:15,achieved:true,bookTitle:'모임 책'}));
  const materialized=archive.mergeLinkedRows([{entry:{id:'private_archive_reader_arc_owned',userId:owner,bookId:'emotion'},book:{title:'모임 책',authors:['저자'],linkedBookId:'emotion',readingSessions:[]}}],[snapshot],owner);
  assert.deepEqual(habits.progress(savedGoal,materialized,owner,today),result({pages:15,achieved:true,bookTitle:'모임 책'}));
});

test('legacy missing-start flags survive archive normalization and only known ranges count toward habits',()=>{
  const known={...session('known',10,16),seconds:30};
  const missing={id:'missing',endPage:80,createdAt:at(29),seconds:60};
  const inferred={...session('inferred',0,90),seconds:90,startPageKnown:false};
  const snapshot={bookId:'emotion',userId:owner,book:{title:'모임 책'},currentPage:90,readingSessions:[known,missing,inferred]};
  const rows=archive.mergeLinkedRows([], [snapshot],owner),readingGoal=goal({bookId:rows[0].entry.id,linkedBookId:'emotion'});
  assert.equal(rows[0].book.readingSessions.length,3);
  assert.equal(archive.totalReadingSeconds(rows[0].book),180);
  assert.equal(rows[0].book.readingSessions[1].startPage,0);
  assert.equal(rows[0].book.readingSessions[1].startPageKnown,false);
  const restored=[{...rows[0],book:archive.decode(archive.encode(rows[0].book))}];
  assert.deepEqual(habits.progress(readingGoal,restored,owner,today),result({pages:6,bookTitle:'모임 책'}));
});

test('browser UMD exposes the same small pure API without requiring other modules',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../readingHabit.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.GrowellReadingHabits).sort(),['decode','encode','normalizeGoal','progress']);
  assert.equal(context.GrowellReadingHabits.decode('기존 목표').goal,'기존 목표');
});
