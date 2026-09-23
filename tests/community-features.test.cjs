'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Domain=require('../communityDomain.js');
const featureSource=fs.readFileSync(path.join(__dirname,'../communityFeatures.js'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const adapterSource=appSource.slice(appSource.indexOf('/* ---------------- community dependency adapter ---------------- */'),appSource.indexOf('/* ---------------- boot ----------------'));
const esc=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function harness(){
  const requests=[],queue=[],events={};
  const c={Promise,Array,Object,Number,Date,Set,document:{querySelectorAll:()=>[]},GrowellCommunity:Domain,
    SESSION:{userId:'member-a'},saveSessionEpoch:1,isAdmin:()=>true,svgIcon:()=>'',I_COMMENT:'',I_EDIT:'',esc,
    avatarHtml:()=>'',fmtPostDate:()=>'',homePostExcerpt:()=>'',homeUnlockedIds:()=>['emotion'],safePhotoUrl:()=>null,showToast:()=>{},
    bookById:id=>({id}),addEventListener:(name,handler)=>{events[name]=handler;},
    sb:{rpc(name,args){requests.push({name,args});return queue.shift()||Promise.resolve({data:[],error:null});}}};
  c.window=c;vm.createContext(c);vm.runInContext(featureSource,c);
  c.GrowellCommunityFeatures.configure(c);
  return {c,api:c.GrowellCommunityFeatures,requests,queue,events};
}
test('author posts include only exact author shared posts in currently accessible books, in chronological order',()=>{
  const posts={a:{id:'a',userId:'author',bookId:'emotion',createdAt:'2026-09-21T12:00:00Z'},
    b:{id:'b',userId:'author',bookId:'thought',createdAt:Date.parse('2026-09-23T12:00:00Z')},
    hidden:{id:'hidden',userId:'author',bookId:'body',createdAt:Date.now()},
    other:{id:'other',userId:'somebody',bookId:'emotion',createdAt:Date.now()},
    malformed:{userId:'author',bookId:'emotion',createdAt:Date.now()},empty:null};
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion','thought'],true).map(p=>p.id),['b','a']);
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion'],true).map(p=>p.id),['a']);
  assert.deepEqual(Domain.authorPosts(posts,'author',['emotion'],false),[]);
  assert.deepEqual(Domain.authorPosts(posts,'', ['emotion'],true),[]);
  assert.equal(Object.keys(posts).length,6,'source collection is unchanged');
});
test('question defaults remain per-book and server rows require valid known books and revisions',()=>{
  const rows=Domain.questionRows([{book_id:'thought',question:'  새로운 질문?  ',revision:'2'}]);
  assert.equal(Domain.questionFor({id:'thought'},rows),'새로운 질문?');
  assert.equal(Domain.questionFor({id:'emotion'},rows),Domain.defaults.emotion);
  for(const row of [{book_id:'missing',question:'?',revision:1},{book_id:'emotion',question:' ',revision:1},
    {book_id:'emotion',question:'가'.repeat(241),revision:1},{book_id:'emotion',question:'?',revision:0}])assert.throws(()=>Domain.questionRows([row]));
  assert.equal(Domain.validQuestion('🌱'.repeat(240)),true);
  assert.equal(Domain.validQuestion('🌱'.repeat(241)),false);
});
test('guest question loading sends no RPC and member result renders escaped shared text',async()=>{
  const h=harness();h.c.SESSION=null;assert.equal(await h.api.load(),false);assert.equal(h.requests.length,0);
  h.c.SESSION={userId:'member-a'};
  h.queue.push(Promise.resolve({data:[{book_id:'emotion',question:'<img src=x onerror=bad()>',revision:1}]}));
  assert.equal(await h.api.load(),true);
  const markup=h.api.promptHtml({id:'emotion'});
  assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<img'));assert.ok(markup.includes('data-question-edit'));
  h.c.isAdmin=()=>false;assert.ok(!h.api.promptHtml({id:'emotion'}).includes('data-question-edit'));
});
test('slow question loads are ignored after logout, account change, or same-account epoch change',async()=>{
  for(const change of [h=>{h.c.SESSION=null;},h=>{h.c.SESSION={userId:'member-b'};},h=>{h.c.saveSessionEpoch++;}]){
    const h=harness(),pending=deferred();h.queue.push(pending.promise);
    const load=h.api.load();await Promise.resolve();change(h);
    pending.resolve({data:[{book_id:'emotion',question:'OLD SESSION QUESTION',revision:1}]});
    assert.equal(await load,false);
    assert.ok(!h.api.promptHtml({id:'emotion'}).includes('OLD SESSION QUESTION'));
  }
});
test('question refresh failure or malformed response preserves last confirmed shared question',async()=>{
  const h=harness();h.queue.push(Promise.resolve({data:[{book_id:'emotion',question:'마지막으로 저장한 질문',revision:3}]}));await h.api.load();
  for(const response of [{error:{code:'offline'}},{data:[{book_id:'emotion',question:'bad',revision:-1}]}]){
    h.queue.push(Promise.resolve(response));assert.equal(await h.api.load(true),false);
    assert.ok(h.api.promptHtml({id:'emotion'}).includes('마지막으로 저장한 질문'));
  }
});
test('reset invalidates an outstanding question request even before the Auth session changes',async()=>{
  const h=harness(),pending=deferred();h.queue.push(pending.promise);const load=h.api.load();await Promise.resolve();
  h.api.reset();pending.resolve({data:[{book_id:'emotion',question:'stale question',revision:1}]});
  assert.equal(await load,false);assert.ok(!h.api.promptHtml({id:'emotion'}).includes('stale question'));
});
test('the real adapter runs with application helpers and mutable session entirely inside an IIFE, not window',async()=>{
  const calls=[];
  const c={Promise,Array,Object,Number,Date,Set,document:{querySelectorAll:()=>[],querySelector:()=>null},GrowellCommunity:Domain,
    addEventListener(){},fixture:{esc,rpc:async name=>{calls.push(name);return {data:[{book_id:'emotion',question:'서버의 공유 질문',revision:1}]};}}};
  c.window=c;vm.createContext(c);vm.runInContext(featureSource,c);
  c.localApp=vm.runInContext(`(function(){
    let SESSION={userId:'inside-iife'},STATE={posts:{},users:{}},saveSessionEpoch=1;
    const sb={rpc:fixture.rpc},svgIcon=icon=>'<svg>'+icon+'</svg>',esc=fixture.esc,bookById=id=>({id,title:'테스트 책'}),isAdmin=()=>true;
    const I_CLOSE='close',I_COMMENT='comment',I_EDIT='edit';
    const avatarHtml=()=>'<span>avatar</span>',fmtPostDate=()=> '오늘',homePostExcerpt=()=> '내용',homeUnlockedIds=()=>['emotion'],safePhotoUrl=()=>null,showToast=()=>{};
    ${adapterSource}
    return {switchUser(){SESSION={userId:'new-iife-member'};saveSessionEpoch++;},prompt(){return GrowellCommunityFeatures.promptHtml(bookById('emotion'));}};
  })()`,c);
  for(const name of ['SESSION','STATE','saveSessionEpoch','sb','svgIcon','esc','bookById','isAdmin','avatarHtml','fmtPostDate','homePostExcerpt','homeUnlockedIds','safePhotoUrl','showToast'])assert.equal(c[name],undefined,name+' must remain closure-local');
  assert.ok(c.localApp.prompt().includes('<svg>comment</svg>'));
  assert.equal(await c.GrowellCommunityFeatures.load(),true);
  assert.ok(c.localApp.prompt().includes('서버의 공유 질문'));
  c.GrowellCommunityFeatures.bind();
  c.localApp.switchUser();assert.ok(!c.localApp.prompt().includes('서버의 공유 질문'));
  assert.equal(await c.GrowellCommunityFeatures.load(),true);
  assert.deepEqual(calls,['growell_get_book_questions','growell_get_book_questions']);
});
