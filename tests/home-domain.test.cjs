const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const home=require('../homeDomain.js');
const books=[{id:'emotion',title:'감정'},{id:'thought',title:'생각'},{id:'body',title:'신체'}];
const unlocked=['emotion','thought'];
const post=(id,createdAt,extra={})=>({id,userId:'other',bookId:'emotion',html:'<p>나눔</p>',createdAt,...extra});
const habit=(id,extra={})=>({id,userId:'me',bookId:'emotion',createdAt:100,...extra});

test('reading priority is the latest own metadata from a known, unlocked book',()=>{
  const metas=[
    {userId:'me',bookId:'emotion',updatedAt:'2026-09-21T00:00:00Z'},
    {userId:'me',bookId:'thought',updatedAt:Date.parse('2026-09-21T00:01:00Z')},
    {userId:'other',bookId:'emotion',updatedAt:'2026-09-22T00:00:00Z'},
    {userId:'me',bookId:'body',updatedAt:'2026-09-23T00:00:00Z'},
    {userId:'me',bookId:'unknown',updatedAt:'2026-09-24T00:00:00Z'}
  ];
  assert.equal(home.selectReadingBook(books,metas,'me','emotion',[...unlocked,'unknown']),books[1]);
});

test('reading falls back to unlocked announcement, then first unlocked, then null',()=>{
  const bad=[null,{userId:'me',bookId:'emotion',updatedAt:'invalid'}];
  assert.equal(home.selectReadingBook(books,bad,'me','thought',unlocked),books[1]);
  assert.equal(home.selectReadingBook(books,bad,'me','body',unlocked),books[0]);
  assert.equal(home.selectReadingBook(books,[],'me','missing',['thought']),books[1]);
  assert.equal(home.selectReadingBook(books,[],'me','emotion',['unknown']),null);
  assert.equal(home.selectReadingBook(null,null,'me','emotion',null),null);
  assert.equal(home.selectReadingBook(books,[],null,'thought',unlocked),books[1]);
});

test('reading equal timestamps resolve by original book order and do not mutate input',()=>{
  const metas=Object.freeze([
    Object.freeze({userId:'me',bookId:'thought',updatedAt:0}),
    Object.freeze({userId:'me',bookId:'emotion',updatedAt:'0'})
  ]);
  assert.equal(home.selectReadingBook(Object.freeze(books.slice()),metas,'me','thought',new Set(unlocked)),books[0]);
});

test('recent posts exclude self, locked/unknown books, private records and malformed rows',()=>{
  const publicPost=post('shared',50);
  const rows=[publicPost,post('self',100,{userId:'me'}),post('locked',100,{bookId:'body'}),
    post('unknown',100,{bookId:'unknown'}),post('private',500,{iv:'secret-iv',data:'ciphertext'}),
    post('worksheet',500,{activityKey:'a',data:{answer:'private'}}),
    post('',100),post('missing-book',100,{bookId:null}),post('missing-owner',100,{userId:''}),null,{}];
  assert.deepEqual(home.selectRecentPosts(rows,'me',unlocked),[publicPost]);
  assert.deepEqual(home.selectRecentPosts({posts:{shared:publicPost},privateEntries:{private:rows[4]}},'me',unlocked),[],
    'whole-state input is never traversed into private or public collections');
  assert.deepEqual(home.selectRecentPosts(rows,null,unlocked),[]);
});

test('recent public posts sort ISO and numeric epochs together, newest first, with deterministic ties',()=>{
  const rows=[post('b','2026-09-21T09:00:00+09:00'),post('newest','2026-09-21T00:01:00Z'),
    post('a',Date.parse('2026-09-21T00:00:00Z')),post('invalid','2026-02-30T00:00:00Z')];
  const original=JSON.stringify(rows);
  assert.deepEqual(home.selectRecentPosts(rows,'me',new Set(unlocked)).map(x=>x.id),['newest','a','b','invalid']);
  assert.equal(JSON.stringify(rows),original);
  assert.deepEqual(home.selectRecentPosts(rows,'me',unlocked,2).map(x=>x.id),['newest','a']);
  assert.equal(home.selectRecentPosts(rows,'me',unlocked,Infinity).length,4);
  assert.equal(home.selectRecentPosts(rows,'me',unlocked,0).length,0);
  assert.equal(home.selectRecentPosts(rows,'me',unlocked,-1).length,0);
  assert.equal(home.selectRecentPosts(rows,'me',unlocked,NaN).length,0);
});

test('recent posts without a limit retain the complete feed for later pagination',()=>{
  const rows=Array.from({length:47},(_,i)=>post('p'+i,i));
  const all=home.selectRecentPosts(Object.fromEntries(rows.map(row=>[row.id,row])),'me',unlocked);
  assert.equal(all.length,47);assert.equal(all[0].id,'p46');assert.equal(all[46].id,'p0');
});

test('active habits use the current owner, unlocked books, and inclusive start/end dates',()=>{
  const rows=[habit('both',{startDate:'2026-09-21',endDate:'2026-09-21'}),
    habit('future',{startDate:'2026-09-22'}),habit('ended',{endDate:'2026-09-20'}),
    habit('other',{userId:'other'}),habit('locked',{bookId:'body'}),habit('unknown',{bookId:'unknown'})];
  assert.deepEqual(home.activeHabits(rows,'me',unlocked,'2026-09-21').map(x=>x.id),['both']);
});

test('habits may have only a start, only an end, or no period; specified invalid periods are excluded',()=>{
  const rows=[habit('no-period'),habit('empty',{startDate:'',endDate:null}),
    habit('start-only',{startDate:'2026-09-21'}),habit('end-only',{endDate:'2026-09-21'}),
    habit('invalid-start',{startDate:'2026-09'}),habit('invalid-day',{endDate:'2026-02-30'}),
    habit('inverted',{startDate:'2026-09-22',endDate:'2026-09-20'}),habit('',{}),null];
  assert.deepEqual(home.activeHabits(rows,'me',unlocked,'2026-09-21').map(x=>x.id),['empty','end-only','no-period','start-only']);
  assert.deepEqual(home.activeHabits(rows,'me',unlocked,'2026-02-30'),[]);
  assert.deepEqual(home.activeHabits(rows,null,unlocked,'2026-09-21'),[]);
  assert.deepEqual(home.activeHabits(null,'me',unlocked,'2026-09-21'),[]);
});

test('active habits sort oldest createdAt first and equal times by ID without rewriting source',()=>{
  const rows=Object.freeze([
    Object.freeze(habit('last',{createdAt:'invalid'})),Object.freeze(habit('new',{createdAt:'2026-09-21T00:00:00Z'})),
    Object.freeze(habit('b',{createdAt:0})),Object.freeze(habit('a',{createdAt:'0'}))
  ]);
  assert.deepEqual(home.activeHabits(rows,'me',new Set(unlocked),'2026-09-21').map(x=>x.id),['a','b','new','last']);
});

test('timestamps accept finite epoch milliseconds and real ISO dates without locale-dependent guessing',()=>{
  const timestamp=Date.parse('2026-09-21T00:00:00Z');
  for(const value of [timestamp,String(timestamp),'2026-09-21T00:00:00Z','2026-09-21T09:00:00+09:00','2026-09-21T00:00:00','2026-09-21']){
    assert.equal(home.parseTimestamp(value),timestamp,String(value));
  }
  assert.notEqual(home.parseTimestamp('2024-02-29T00:00:00Z'),null);
  for(const value of [null,undefined,'',true,{},Infinity,NaN,1e30,'9/21/2026','2026-02-29','2026-02-30','2026-13-01','2026-09-21T25:00:00Z']){
    assert.equal(home.parseTimestamp(value),null,String(value));
  }
});

test('the same module exposes GrowellHome to a browser without CommonJS',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','homeDomain.js'),'utf8'),context);
  assert.equal(typeof context.GrowellHome.selectReadingBook,'function');
  assert.equal(typeof context.GrowellHome.selectRecentPosts,'function');
  assert.equal(typeof context.GrowellHome.activeHabits,'function');
  assert.equal(context.GrowellHome.parseTimestamp('0'),0);
});
