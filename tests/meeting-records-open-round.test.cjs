'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const domain=require('../meetingRecordsDomain.js');
const source=fs.readFileSync(path.join(__dirname,'../meetingRecords.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const id=n=>'c4000000-0000-4000-8000-'+String(n).padStart(12,'0');

function record(n,extra={}){
  const row={id:id(n),bookId:'emotion',userId:'operator',round:n,date:'2026-10-11',
    topic:'공개 모임 '+n,sections:[{id:'section-'+n,summary:'핵심 요약 '+n,detail:'원본 본문 '+n}],
    concepts:[],materialIds:[],status:'published',revision:1,
    createdAt:'2026-10-11T00:00:00Z',updatedAt:'2026-10-11T00:00:00Z',...extra};
  assert.equal(domain.validateRecord(row).ok,true,'fixture must pass the production domain validator');
  return row;
}
function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

// Only the DOM surface used by the public module is simulated. Keep complete
// rendered HTML and real listeners so tests follow the rendered buttons rather
// than reading or changing the module's private state.
function fakeDocument(){
  class Node{
    constructor(tag,attributes={}){
      this.tagName=tag.toUpperCase();this.attributes={...attributes};this.children=[];
      this.parentNode=null;this.listeners={};this.dataset={};this.disabled=false;
      this.open=false;this.scrollTop=0;this.focusCount=0;this._html='';this._parsed=null;
    }
    set innerHTML(value){this._html=String(value);this._parsed=null;}
    get innerHTML(){return this._html;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
    get isConnected(){return this===document.body||!!this.parentNode&&this.parentNode.isConnected;}
    appendChild(node){node.parentNode=this;this.children.push(node);return node;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    focus(){this.focusCount++;document.activeElement=this;}
    getBoundingClientRect(){return {left:0,top:0,right:1000,bottom:1000};}
    addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
    removeEventListener(type,handler){this.listeners[type]=(this.listeners[type]||[]).filter(value=>value!==handler);}
    matches(selector){
      if(selector[0]==='.')return (this.attributes.class||this.className||'').split(/\s+/).includes(selector.slice(1));
      if(selector[0]==='['){const match=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);return !!match&&this.getAttribute(match[1])!==null&&(match[2]===undefined||this.getAttribute(match[1])===match[2]);}
      return this.tagName===selector.toUpperCase();
    }
    closest(selector){return this.matches(selector)?this:this.parentNode?this.parentNode.closest(selector):null;}
    descendants(){
      if(!this._parsed)this._parsed=[...this._html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(match=>{
        const attributes={};
        for(const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g))attributes[attr[1]]=attr[2]===undefined?'':attr[2];
        const node=new Node(match[1],attributes);node.parentNode=this;node.disabled=Object.hasOwn(attributes,'disabled');return node;
      });
      return this._parsed.concat(this.children.flatMap(node=>[node,...node.descendants()]));
    }
    querySelectorAll(selector){const selectors=selector.split(',');return this.descendants().filter(node=>selectors.some(value=>node.matches(value)));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    click(){
      const event={target:this,clientX:1,clientY:1,preventDefault(){},stopImmediatePropagation(){}};
      for(let node=this;node;node=node.parentNode)for(const handler of node.listeners.click||[])handler(event);
    }
  }
  const document={activeElement:null,createElement:tag=>new Node(tag)};
  document.body=new Node('body');
  document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
  return document;
}
function harness(t,options={}){
  const document=fakeDocument(),calls={loads:[],writes:[],navigation:[],toasts:[]};
  const session={userId:'reader',epoch:1,admin:false,readable:true,...options.session};
  const books={emotion:{id:'emotion',title:'감정의 책'},thought:{id:'thought',title:'생각의 책'}};
  const adapter={sessionUserId:()=>session.userId,sessionEpoch:()=>session.epoch,isAdmin:()=>session.admin,
    canReadBook:()=>session.readable,bookById:bookId=>books[bookId],
    loadRecords(bookId){calls.loads.push(bookId);return options.load?options.load(bookId,calls.loads.length):options.rows||[];},
    saveRecord(...args){calls.writes.push(['save',...args]);throw new Error('Viewing must not save');},
    deleteRecord(...args){calls.writes.push(['delete',...args]);throw new Error('Viewing must not delete');},
    getInsights:()=>[],getMaterials:()=>[],openPost:(...args)=>calls.navigation.push(['post',...args]),
    openMaterial:(...args)=>calls.navigation.push(['material',...args]),showToast:value=>calls.toasts.push(value)};
  const context={document,GrowellMeetingRecordsDomain:domain};context.window=context;
  vm.runInNewContext(source,context,{filename:'meetingRecords.js'});
  const api=context.GrowellMeetingRecords;
  if(options.configure!==false)api.configure(adapter);
  const current=()=>document.body.children.find(node=>node.tagName==='DIALOG'&&node.open)||null;
  function click(action,recordId){
    const dialog=current();assert.ok(dialog,'a dialog must be visible');
    const button=dialog.querySelectorAll('[data-mr-action]').find(node=>node.getAttribute('data-mr-action')===action&&(recordId===undefined||node.getAttribute('data-id')===recordId));
    assert.ok(button,'the rendered '+action+' button must exist');button.click();
  }
  t.after(()=>{assert.deepEqual(calls.writes,[],'reading, retrying and navigating must never call write APIs');api.reset();});
  return {api,adapter,document,session,calls,current,click,html:()=>current()?.innerHTML||''};
}

test('openRound reads only the published record for the same book and normalized numeric round',async t=>{
  for(const round of [1,'1','01','０１',' ０１ ',9999,'９９９９']){
    const number=Number(String(round).normalize('NFKC').trim());
    const selected=record(1,{round:number,topic:'선택한 공개 주제'});
    const otherRound=record(2,{round:number===1?2:1,topic:'다른 회차 주제'});
    const otherBook=record(3,{bookId:'thought',round:number,topic:'다른 책의 같은 회차'});
    const h=harness(t,{rows:[otherBook,otherRound,selected]});
    h.api.openRound('emotion',round);
    assert.match(h.html(),/불러오는 중/);
    await tick();
    assert.match(h.html(),/class="mr-topic">선택한 공개 주제/);
    assert.match(h.html(),/원본 본문 1/);
    assert.doesNotMatch(h.html(),/다른 회차 주제|다른 책의 같은 회차|함께 쌓은 이야기|data-mr-action="record"/);
    assert.deepEqual(h.calls.loads,['emotion']);
  }
});

test('invalid or missing rounds do not open a dialog or request records',async t=>{
  const h=harness(t,{rows:[record(1)]});
  for(const round of [undefined,null,'',' ',0,'０',-1,10000,'10000',1.5,NaN,Infinity,'1.0','1e0','0x1','+1','one',{},[]])h.api.openRound('emotion',round);
  await tick();assert.equal(h.current(),null);assert.deepEqual(h.calls.loads,[]);
});

test('binding a round link opens its record once and existing launch buttons still open the list',async t=>{
  const h=harness(t,{rows:[record(1),record(2)]}),container=h.document.createElement('section');
  container.innerHTML='<button data-meeting-records="emotion" data-meeting-round="０１">회차 기록</button>'+h.api.launchHtml('emotion')+'<button data-meeting-records="emotion" data-meeting-round="">잘못된 회차</button>';
  h.document.body.appendChild(container);
  const [roundButton,listButton,invalidButton]=container.querySelectorAll('[data-meeting-records]');
  h.api.bind(container);h.api.bind(container);roundButton.click();await tick();
  assert.match(h.html(),/class="mr-topic">공개 모임 1/);assert.deepEqual(h.calls.loads,['emotion']);
  h.api.close();assert.equal(roundButton.focusCount,1,'closing returns focus to the original round link');
  listButton.click();await tick();
  assert.match(h.html(),/함께 쌓은 이야기/);assert.match(h.html(),/공개 모임 1/);assert.match(h.html(),/공개 모임 2/);
  assert.doesNotMatch(h.html(),/class="mr-topic"/);assert.deepEqual(h.calls.loads,['emotion','emotion']);
  h.api.close();invalidButton.click();await tick();
  assert.equal(h.current(),null);assert.equal(h.calls.loads.length,2,'an invalid round attribute cannot fall back to the list');
});

test('a missing published round shows the empty state, while the owner draft remains on the existing list path',async t=>{
  const draft=record(1,{userId:'reader',status:'draft',topic:'나만 볼 초안'});
  const h=harness(t,{session:{admin:true},rows:[draft,record(2,{topic:'다른 회차 공개 기록'}),record(3,{bookId:'thought',round:1,topic:'다른 책 기록'})]});
  h.api.openRound('emotion','01');await tick();
  assert.match(h.html(),/아직 공개된 모임 기록이 없어요\./);
  assert.match(h.html(),/data-mr-action="list"/);
  assert.doesNotMatch(h.html(),/나만 볼 초안|다른 회차 공개 기록|다른 책 기록|data-mr-action="record"|class="mr-topic"/);
  h.click('list');await tick();
  assert.match(h.html(),/함께 쌓은 이야기/);assert.match(h.html(),/나만 볼 초안/);assert.match(h.html(),/다른 회차 공개 기록/);
  assert.doesNotMatch(h.html(),/다른 책 기록|아직 공개된 모임 기록이 없어요/);
  h.click('record',draft.id);assert.match(h.html(),/class="mr-topic">나만 볼 초안/);
  assert.match(h.html(),/임시 저장 · 나에게만 공개/);
});

test('even an owner administrator opens the published match rather than a same-round private draft',async t=>{
  const h=harness(t,{session:{admin:true},rows:[record(1,{userId:'reader',status:'draft',topic:'비공개 초안'}),record(2,{round:1,topic:'회차의 공개 기록'})]});
  h.api.openRound('emotion',1);await tick();
  assert.match(h.html(),/class="mr-topic">회차의 공개 기록/);assert.doesNotMatch(h.html(),/비공개 초안|임시 저장 · 나에게만 공개/);
});

test('ordinary members cannot expose drafts from direct links or the list fallback',async t=>{
  const h=harness(t,{rows:[record(1,{userId:'reader',status:'draft',topic:'본인 관리자용 초안'}),record(2,{round:1,status:'draft',topic:'다른 회원 초안'})]});
  h.api.openRound('emotion',1);await tick();assert.match(h.html(),/아직 공개된 모임 기록이 없어요\./);
  h.click('list');await tick();assert.match(h.html(),/아직 모임 기록이 없어요\./);
  assert.doesNotMatch(h.html(),/본인 관리자용 초안|다른 회원 초안|data-mr-action="record"/);
});

test('loading and a failed-request retry retain the requested round',async t=>{
  const first=deferred(),second=deferred();
  const h=harness(t,{load:(_,count)=>count===1?first.promise:second.promise});
  h.api.openRound('emotion','０２');await tick();
  assert.match(h.html(),/2번째 모임 기록/);assert.match(h.html(),/불러오는 중/);
  first.reject(new Error('Temporary read failure'));await tick();
  assert.match(h.html(),/불러오지 못했어요/);assert.match(h.html(),/2번째 모임 기록/);
  h.click('retry');await tick();assert.match(h.html(),/2번째 모임 기록/);assert.match(h.html(),/불러오는 중/);
  second.resolve([record(1),record(2)]);await tick();
  assert.match(h.html(),/class="mr-topic">공개 모임 2/);assert.doesNotMatch(h.html(),/공개 모임 1|불러오지 못했어요|함께 쌓은 이야기/);
  assert.deepEqual(h.calls.loads,['emotion','emotion']);
});

test('choosing all records while a direct request is pending clears the round intent and ignores the old response',async t=>{
  const direct=deferred(),list=deferred();
  const h=harness(t,{load:(_,count)=>count===1?direct.promise:list.promise});
  h.api.openRound('emotion',1);await tick();h.click('list');await tick();
  direct.resolve([record(1,{topic:'오래된 직접 열기 응답'})]);await tick();
  assert.match(h.html(),/불러오는 중/);assert.doesNotMatch(h.html(),/오래된 직접 열기 응답|class="mr-topic"/);
  list.resolve([record(1),record(2)]);await tick();
  assert.match(h.html(),/함께 쌓은 이야기/);assert.match(h.html(),/공개 모임 1/);assert.match(h.html(),/공개 모임 2/);
  assert.doesNotMatch(h.html(),/class="mr-topic"/);
});

test('an unconfigured app, signed-out session, unreadable book or unknown book cannot open a round',async t=>{
  const cases=[{configure:false},{session:{userId:null}},{session:{readable:false}},{bookId:'unknown'}];
  for(const options of cases){
    const h=harness(t,options);h.api.openRound(options.bookId||'emotion',1);await tick();
    assert.equal(h.current(),null);assert.deepEqual(h.calls.loads,[]);
  }
});

test('closing or resetting a pending round prevents its late result from reopening or changing the dialog',async t=>{
  for(const action of ['close','reset']){
    const pending=deferred(),h=harness(t,{load:()=>pending.promise});
    h.api.openRound('emotion',1);await tick();const old=h.current(),before=old.innerHTML;
    h.api[action]();assert.equal(h.current(),null);
    pending.resolve([record(1,{topic:'닫은 뒤 도착한 기록'})]);await tick();
    assert.equal(h.current(),null);assert.equal(old.innerHTML,before);assert.equal(old.isConnected,false);
  }
});

test('logout, account changes, session changes and revoked access invalidate an in-flight round response',async t=>{
  for(const change of [session=>{session.userId=null;},session=>{session.userId='another-reader';},session=>{session.epoch++;},session=>{session.readable=false;}]){
    const pending=deferred(),h=harness(t,{load:()=>pending.promise});
    h.api.openRound('emotion',1);await tick();const old=h.current(),before=old.innerHTML;
    change(h.session);pending.resolve([record(1,{topic:'이전 권한의 기록'})]);await tick();
    assert.equal(old.innerHTML,before);assert.doesNotMatch(h.html(),/이전 권한의 기록|class="mr-topic"/);
    h.api.reset();assert.equal(h.current(),null);
  }
});

test('a later round request stays visible when an earlier request completes last',async t=>{
  for(const bookId of ['emotion','thought']){
    const first=deferred(),second=deferred();
    const h=harness(t,{load:(_,count)=>count===1?first.promise:second.promise});
    h.api.openRound('emotion',1);await tick();const old=h.current(),before=old.innerHTML;
    h.api.openRound(bookId,2);await tick();
    second.resolve([record(2,{bookId,topic:'지금 선택한 회차'})]);await tick();
    const current=h.current(),content=h.html();assert.match(content,/class="mr-topic">지금 선택한 회차/);
    first.resolve([record(1,{topic:'뒤늦게 도착한 이전 회차'})]);await tick();
    assert.equal(h.current(),current);assert.equal(h.html(),content);assert.equal(old.innerHTML,before);
    assert.doesNotMatch(h.html(),/뒤늦게 도착한 이전 회차/);
  }
});

test('openList remains a list even when a published record exists and reading its row is explicit',async t=>{
  const h=harness(t,{rows:[record(1),record(2)]});
  h.api.openList('emotion');await tick();
  assert.match(h.html(),/함께 쌓은 이야기/);assert.doesNotMatch(h.html(),/class="mr-topic"/);
  h.click('record',id(1));assert.match(h.html(),/class="mr-topic">공개 모임 1/);
  h.click('list');await tick();assert.match(h.html(),/함께 쌓은 이야기/);assert.match(h.html(),/공개 모임 2/);
});
