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
function popupHarness(kind){
  const h=harness(),opened=[],closed=[],nodes=[];
  function control(){return {value:'',disabled:false,events:{},isConnected:true,focus(){this.focused=true;},
    addEventListener(name,handler){this.events[name]=handler;},getAttribute(name){return this.attributes&&this.attributes[name];}};}
  const trigger=control();trigger.attributes=kind==='author'?{'data-community-author':'author'}:{'data-question-edit':'emotion'};
  h.c.STATE={users:{author:{name:'작성자'}},posts:Object.fromEntries(Array.from({length:13},(_,i)=>['post-'+i,{id:'post-'+i,userId:'author',bookId:'emotion',createdAt:i+1,title:'글 '+i}]))};
  h.c.GrowellPopupHistory={open(key,options){opened.push({key,options});},closed(key){closed.push(key);}};
  h.c.document={activeElement:trigger,querySelector:()=>null,
    querySelectorAll(selector){return selector===(kind==='author'?'[data-community-author]':'[data-question-edit]')?[trigger]:[];},
    body:{appendChild(node){node.isConnected=true;nodes.push(node);}},
    createElement(){
      const close=control(),cancel=control(),save=control(),input=control(),message=control(),count=control(),more=control(),link=control(),form=control();
      const status={set outerHTML(markup){const match=markup.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);if(match)input.value=match[1];}};
      form.querySelector=()=>save;
      const node=Object.assign(control(),{controls:{close,cancel,save,input,message,more,link,form},open:false,innerHTML:'',
        setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},contains(){return false;},
        querySelector(selector){return {'[data-community-close]':close,'[role="status"]':status,form,textarea:input,'[data-question-count]':count,
          '[data-question-cancel]':cancel,'.community-question-message':message,'[data-author-more]':more}[selector]||null;},
        querySelectorAll(selector){return selector==='.community-author-post'?[link]:selector==='[data-community-close],[data-question-cancel]'?[close,cancel]:[];}
      });
      return node;
    }};
  return Object.assign(h,{opened,closed,nodes,trigger,click(){trigger.onclick({preventDefault(){},stopPropagation(){}});}});
}
async function flush(){await new Promise(resolve=>setImmediate(resolve));}
test('author popup Back restores its trigger; pagination creates no additional popup entry',async()=>{
  const h=popupHarness('author');await h.api.load();h.api.bind();h.click();
  assert.equal(h.opened.length,1);assert.equal(h.opened[0].key,'community-author');
  const node=h.nodes[0];node.controls.more.onclick();assert.equal(h.opened.length,1);
  h.opened[0].options.close();
  assert.equal(node.open,false);assert.equal(node.isConnected,false);assert.equal(h.trigger.focused,true);
  assert.deepEqual(h.closed,['community-author']);
  h.click();h.nodes[1].controls.link.events.click();
  assert.deepEqual(h.closed,['community-author','community-author'],'following a post link also releases the popup entry');
});
test('question popup Back preserves its draft and remains guarded while a save is pending',async()=>{
  const h=popupHarness('question');await h.api.load();h.api.bind();h.click();await flush();
  const first=h.nodes[0];first.controls.input.value='뒤로 가도 남아야 하는 질문';first.controls.input.events.input();
  h.opened[0].options.close();h.click();await flush();
  const node=h.nodes[1],entry=h.opened[1];
  assert.equal(node.controls.input.value,'뒤로 가도 남아야 하는 질문');
  assert.equal(entry.options.canClose(),true);
  const save=deferred();h.queue.push(save.promise);node.controls.form.events.submit({preventDefault(){}});await flush();
  assert.equal(entry.options.canClose(),false);assert.equal(node.open,true);
  save.resolve({data:{book_id:'emotion',question:'뒤로 가도 남아야 하는 질문',revision:1}});await flush();
  assert.equal(node.open,false);assert.deepEqual(h.closed,['community-question','community-question']);
});
test('account reset releases an open popup and does not restore it after a slow question load',async()=>{
  const h=popupHarness('question');await h.api.load();h.api.bind();
  const pending=deferred();h.queue.push(pending.promise);h.click();await flush();
  const node=h.nodes[0];h.api.reset();
  assert.equal(node.open,false);assert.deepEqual(h.closed,['community-question']);
  pending.resolve({data:[{book_id:'emotion',question:'stale question',revision:1}]});await flush();
  assert.equal(h.opened.length,1);assert.equal(node.controls.input.value,'');
});
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
