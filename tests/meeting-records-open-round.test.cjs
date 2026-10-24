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
    scrollTo(options){this.scrollTop=options.top??this.scrollTop;this.lastScroll=options;}
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
    saveRecord(...args){calls.writes.push(['save',...args]);if(options.save)return options.save(...args);throw new Error('Viewing must not save');},
    deleteRecord(...args){calls.writes.push(['delete',...args]);throw new Error('Viewing must not delete');},
    getInsights:()=>[],getMaterials:()=>[],openPost:(...args)=>calls.navigation.push(['post',...args]),
    openMaterial:(...args)=>calls.navigation.push(['material',...args]),showToast:value=>calls.toasts.push(value)};
  const context={document,GrowellMeetingRecordsDomain:domain,GrowellMeetingRecordsPrint:options.printer,GrowellMeetingRecordShare:options.sharing};context.window=context;
  vm.runInNewContext(source,context,{filename:'meetingRecords.js'});
  const api=context.GrowellMeetingRecords;
  if(options.configure!==false)api.configure(adapter);
  const current=()=>document.body.children.find(node=>node.tagName==='DIALOG'&&node.open)||null;
  function click(action,recordId){
    const dialog=current();assert.ok(dialog,'a dialog must be visible');
    const button=dialog.querySelectorAll('[data-mr-action]').find(node=>node.getAttribute('data-mr-action')===action&&(recordId===undefined||node.getAttribute('data-id')===recordId));
    assert.ok(button,'the rendered '+action+' button must exist');button.click();
  }
  function input(selector,value){
    const node=current()?.querySelector(selector);assert.ok(node,'the rendered input '+selector+' must exist');
    node.value=value;
    const event={target:node};
    for(let parent=node;parent;parent=parent.parentNode)for(const handler of parent.listeners.input||[])handler(event);
  }
  t.after(()=>{
    if(options.save)assert.equal(calls.writes.some(call=>call[0]==='delete'),false,'preparation changes must not delete a record');
    else assert.deepEqual(calls.writes,[],'reading, retrying and navigating must never call write APIs');
    api.reset();
  });
  return {api,adapter,document,session,calls,current,click,input,html:()=>current()?.innerHTML||''};
}

test('published record sharing uses routing fields only and preserves the original record',async t=>{
  const selected=record(2),before=JSON.stringify(selected),sent=[];
  const h=harness(t,{rows:[selected],sharing:{shareRecord:async (root,payload,options)=>{assert.equal(options.isCurrent(),true);sent.push(payload);return {status:'copied'};}}});
  h.api.openRound('emotion',2);await tick();h.click('share-record');await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),[{bookId:'emotion',round:2,status:'published'}]);
  assert.deepEqual(h.calls.toasts,['링크를 복사했어요.']);assert.equal(JSON.stringify(selected),before);
});

test('draft record, editor and preview have no public share action',async t=>{
  const selected=record(2,{userId:'reader',status:'draft'});
  const h=harness(t,{rows:[selected],session:{admin:true}});
  h.api.openList('emotion');await tick();h.click('record',selected.id);
  assert.doesNotMatch(h.html(),/data-mr-action="share-record"/);
  h.click('edit');assert.doesNotMatch(h.html(),/data-mr-action="share-record"/);
  h.click('preview-mode');assert.doesNotMatch(h.html(),/data-mr-action="share-record"/);
  const published=harness(t,{rows:[record(1,{userId:'reader'})],session:{admin:true}});
  published.api.openRound('emotion',1);await tick();published.click('edit');published.click('preview-mode');
  assert.doesNotMatch(published.html(),/data-mr-action="share-record"/);
});

test('pending record share loses its owner/view authorization after logout',async t=>{
  const task=deferred();let allowed;
  const h=harness(t,{rows:[record(2)],sharing:{shareRecord(root,payload,options){allowed=options.isCurrent;return task.promise;}}});
  h.api.openRound('emotion',2);await tick();h.click('share-record');assert.equal(allowed(),true);
  h.session.userId='another-reader';h.session.epoch++;assert.equal(allowed(),false);
  task.resolve({status:'copied'});await tick();assert.deepEqual(h.calls.toasts,[]);
});

test('thought questions appear after concepts and before stories, escape text and leave legacy records unchanged',async t=>{
  const source=record(1,{thoughtQuestions:[{id:'question-1',text:'<script>감정을 어떻게 보는가?</script>\n그 이유는 무엇인가?'},{id:'question-2',text:'나의 생각과 감정은 어떻게 다른가?'}]}),before=JSON.stringify(source);
  const h=harness(t,{rows:[source]});h.api.openRound('emotion',1);await tick();
  assert.ok(h.html().indexOf('함께 살펴본 개념')<h.html().indexOf('생각 질문'));
  assert.ok(h.html().indexOf('생각 질문')<h.html().indexOf('>모임 내용</h2>'));
  assert.match(h.html(),/class="mr-thought-questions"/);assert.match(h.html(),/&lt;script&gt;감정을 어떻게 보는가/);
  assert.doesNotMatch(h.html(),/<script>/);assert.equal(JSON.stringify(source),before);
  const legacy=harness(t,{rows:[record(1)]});legacy.api.openRound('emotion',1);await tick();assert.doesNotMatch(legacy.html(),/생각 질문|data-mr-thought-questions/);
});

test('operator edits, previews, removes and restores questions while retaining the source and saving only a draft',async t=>{
  const source=record(1,{userId:'reader',status:'draft',thoughtQuestions:[{id:'question-1',text:'원래 질문'}]}),before=JSON.stringify(source);
  const h=harness(t,{rows:[source],session:{admin:true},save:async payload=>({...payload,revision:2})});
  h.api.openList('emotion');await tick();h.click('record',source.id);h.click('edit');h.input('[data-mr-question="question-1"]','수정한 생각 질문\n두 번째 문장');
  h.click('remove-question','question-1');assert.match(h.html(),/생각 질문을 삭제했어요/);h.click('undo');
  h.click('preview-mode');assert.match(h.html(),/수정한 생각 질문\n두 번째 문장/);h.click('editor-mode');h.click('save-draft');await tick();
  assert.equal(h.calls.writes.length,1);assert.equal(h.calls.writes[0][1].status,'draft');
  assert.deepEqual(h.calls.writes[0][1].thoughtQuestions,[{id:'question-1',text:'수정한 생각 질문\n두 번째 문장'}]);
  assert.equal(JSON.stringify(source),before);
});

test('adding a first question to a legacy draft creates a stable question ID and preserves its existing body',async t=>{
  const source=record(1,{userId:'reader',status:'draft'}),before=JSON.stringify(source);
  const h=harness(t,{rows:[source],session:{admin:true},save:async payload=>({...payload,revision:2})});
  h.api.openList('emotion');await tick();h.click('record',source.id);h.click('edit');h.click('add-question');
  const questionId=h.current().querySelector('[data-mr-question]').getAttribute('data-mr-question');assert.ok(domain.isUuid(questionId));
  h.input('[data-mr-question="'+questionId+'"]','함께 생각해볼 첫 질문이다.');h.click('preview-mode');assert.match(h.html(),/함께 생각해볼 첫 질문이다/);
  h.click('editor-mode');h.click('save-draft');await tick();
  assert.deepEqual(h.calls.writes[0][1].thoughtQuestions,[{id:questionId,text:'함께 생각해볼 첫 질문이다.'}]);
  assert.deepEqual(h.calls.writes[0][1].sections,source.sections);assert.equal(JSON.stringify(source),before);
});

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

test('core-summary buttons focus and scroll the matching content without navigation or writes',async t=>{
  const row=record(1,{sections:[{id:'first',summary:'첫 주제',detail:'첫 원문'},{id:'second',summary:'다음 주제',detail:'다음 원문'}]});
  const before=JSON.stringify(row),h=harness(t,{rows:[row]});h.api.openRound('emotion',1);await tick();
  const body=h.current().querySelector('.mr-body'),target=h.current().querySelectorAll('[data-mr-story]').find(node=>node.getAttribute('data-mr-story')==='second');
  body.scrollTop=60;body.getBoundingClientRect=()=>({top:40});target.getBoundingClientRect=()=>({top:420});
  assert.match(h.html(),/aria-controls="mr-story-second"/);h.click('jump-section','second');
  assert.equal(target.focusCount,1);assert.equal(body.lastScroll.top,426);assert.equal(body.lastScroll.behavior,'smooth');
  assert.equal(JSON.stringify(row),before);assert.deepEqual(h.calls.navigation,[]);
});

test('an explicit topic question displays below its matching title in read and preview without changing saved detail',async t=>{
  const detail='생각 질문: <script>질문 원문</script>\n\n  원문 본문\n다음 문장  ';
  const selected=record(1,{userId:'reader',sections:[{id:'one',summary:'연결된 주제',detail}]}),snapshot=JSON.stringify(selected);
  const h=harness(t,{session:{admin:true},rows:[selected]});h.api.openRound('emotion',1);await tick();
  const question='<p class="mr-topic-question">생각 질문: &lt;script&gt;질문 원문&lt;/script&gt;</p>';
  assert.ok(h.html().indexOf(question)>h.html().indexOf('id="mr-story-heading-one"'));
  assert.ok(h.html().indexOf(question)<h.html().indexOf('<p class="mr-summary">  원문 본문'));
  assert.doesNotMatch(h.html(),/<script>/);h.click('edit');assert.match(h.html(),/생각 질문: &lt;script&gt;질문 원문/);
  h.click('preview-mode');assert.ok(h.html().includes(question));assert.equal(JSON.stringify(selected),snapshot);
});

test('book sharing keeps participant cards primary and gives only intervening leader cards a softer modifier in read and preview',async t=>{
  const names=['가람','다온','라온','마루','바다'],parts=[];
  names.forEach((name,index)=>{parts.push({name,body:'  '+name+' 소감 <img src=x onerror=bad>  '});if(index<4)parts.push({name:'리더 나눔',body:'설명 '+(index+1)+' <script>글자 그대로</script>'});});
  const summary='책 나눔: '+names.join(' · '),detail=parts.map(part=>part.name+'\n'+part.body).join('\n\n');
  const selected=record(1,{userId:'reader',sections:[{id:'sharing',summary,detail}]}),snapshot=JSON.stringify(selected);
  const h=harness(t,{session:{admin:true},rows:[selected]});h.api.openRound('emotion',1);await tick();
  function verify(){
    const html=h.html(),core=html.slice(html.indexOf('mr-core-list'),html.indexOf('함께 살펴본 개념'));
    assert.match(core,/책 나눔: 가람 · 다온 · 라온 · 마루 · 바다/);assert.doesNotMatch(core,/소감|설명|리더 나눔/);
    assert.equal((html.match(/class="mr-sharing-card(?: mr-sharing-card-leader)?"/g)||[]).length,9);
    assert.equal((html.match(/class="mr-sharing-card mr-sharing-card-leader"><h4>리더 나눔<\/h4>/g)||[]).length,4);
    assert.equal((html.match(/class="mr-sharing-card"><h4>/g)||[]).length,5,'participant cards retain the original main style');
    let last=-1;for(const part of parts){const needle='<h4>'+part.name+'</h4><p class="mr-summary">'+part.body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</p>';const at=html.indexOf(needle);assert.ok(at>last);last=at;}
    assert.doesNotMatch(html,/<script>|<img src=x/);
  }
  verify();h.click('edit');assert.doesNotMatch(h.html(),/class="mr-sharing-card"/);assert.match(h.html(),/가람\n  가람 소감/);
  h.click('preview-mode');verify();assert.equal(JSON.stringify(selected),snapshot);assert.deepEqual(h.calls.writes,[]);
  const css=fs.readFileSync(path.join(__dirname,'../meetingRecords.css'),'utf8');
  assert.match(css,/\.mr-sharing-cards\{display:grid;gap:14px\}/);
  assert.match(css,/\.mr-sharing-card\{[^}]*border:1px solid #f2e8ce[^}]*background:#fffbef/);
  assert.match(css,/\.mr-sharing-card:not\(\.mr-sharing-card-leader\) h4\{color:#7c633d\}/);
  assert.match(css,/\.mr-sharing-card-leader\{background:#f8f9f7;border-color:#eef0eb;color:#626f66\}/);
  assert.match(css,/\.mr-sharing-card-leader h4\{font-size:13px/);assert.match(css,/\.mr-sharing-card-leader \.mr-summary\{font-size:14px/);
  assert.match(css,/:root\[data-theme="dark"\] \.meeting-records-dialog \.mr-sharing-card-leader\{[^}]*color:var\(--ink-soft/,'dark-mode leader text must keep a readable contrast');
  assert.match(css,/:root\[data-theme="dark"\] \.meeting-records-dialog \.mr-sharing-card:not\(\.mr-sharing-card-leader\)\{background:#3c3527;border-color:#66583b\}/);
  assert.match(css,/:root\[data-theme="dark"\] \.meeting-records-dialog \.mr-sharing-card:not\(\.mr-sharing-card-leader\) h4\{color:#e5cba1\}/);
});

test('incomplete sharing structure falls back to the entire escaped original text rather than hiding or inventing cards',async t=>{
  const detail='가람\n원문 첫 소감\n\n알 수 없는 이름\n<script>원문 설명</script>';
  const selected=record(1,{sections:[{id:'sharing',summary:'책 나눔: 가람 · 다온',detail}]}),snapshot=JSON.stringify(selected);
  const h=harness(t,{rows:[selected]});h.api.openRound('emotion',1);await tick();
  assert.doesNotMatch(h.html(),/class="mr-sharing-card"|<script>/);
  assert.ok(h.html().includes('<p class="mr-summary">가람\n원문 첫 소감\n\n알 수 없는 이름\n&lt;script&gt;원문 설명&lt;/script&gt;</p>'));
  assert.equal(JSON.stringify(selected),snapshot);assert.deepEqual(h.calls.writes,[]);
});

test('record PDF action downloads directly without copying client-side insights or writing source records',async t=>{
  const row=record(1),before=JSON.stringify(row);let downloaded;
  const printer={downloadRecord(browser,value,options){downloaded={value,options};return Promise.resolve({filename:'GROWELL-meeting-1.pdf'});},printRecord(){throw new Error('PDF save must not open a print dialog');}};
  const h=harness(t,{rows:[row],printer});h.adapter.getInsights=()=>[{id:'allowed',bookId:'emotion',round:1,answers:['원문']},{id:'private',bookId:'emotion',round:1,private:true,answers:['비공개']}];
  h.adapter.getAccessToken=async()=> 'synthetic-token';
  h.api.openRound('emotion',1);await tick();h.click('download-record');await tick();
  assert.equal(downloaded.value.id,row.id);assert.equal(downloaded.options.getAccessToken,h.adapter.getAccessToken);
  assert.equal(downloaded.options.isCurrent(),true);assert.equal(downloaded.options.preview,false);
  assert.equal(downloaded.options.insights,undefined);assert.equal(downloaded.options.materials,undefined);
  assert.match(h.html(),/PDF 파일을 바로 내려받습니다/);assert.doesNotMatch(h.html(),/인쇄 창|PDF로 저장/);
  assert.equal(JSON.stringify(row),before);assert.deepEqual(h.calls.toasts,['PDF 파일을 내려받았어요.']);
});

test('a PDF download blocks repeat clicks and cancels when the owner session resets',async t=>{
  const deferredDownload=deferred();let calls=0,cancelled=0,downloadOptions;
  deferredDownload.promise.cancel=()=>{cancelled++;};
  const h=harness(t,{rows:[record(1)],printer:{downloadRecord(browser,value,options){calls++;downloadOptions=options;return deferredDownload.promise;}}});
  h.adapter.getAccessToken=async()=> 'synthetic-token';h.api.openRound('emotion',1);await tick();
  h.click('download-record');h.click('download-record');assert.equal(calls,1);
  h.session.epoch++;h.api.reset();assert.equal(cancelled,1);assert.equal(downloadOptions.isCurrent(),false);
  deferredDownload.resolve({filename:'GROWELL-meeting-1.pdf'});await tick();assert.deepEqual(h.calls.toasts,[]);
});

test('operator preview PDF includes unsaved changes without saving or changing the source',async t=>{
  const row=record(1,{userId:'reader'}),before=JSON.stringify(row);let downloaded;
  const h=harness(t,{rows:[row],session:{admin:true},printer:{downloadRecord(browser,value,options){downloaded={value,options};return Promise.resolve();}}});
  h.adapter.getAccessToken=async()=> 'synthetic-token';h.api.openRound('emotion',1);await tick();h.click('edit');
  h.input('[data-mr-field="topic"]','작성 중인 확인용 제목');h.input('[data-mr-field="round"]','2');h.click('preview-mode');h.click('download-record');await tick();
  assert.equal(downloaded.value.topic,'작성 중인 확인용 제목');assert.equal(downloaded.options.preview,true);
  assert.equal(downloaded.value.round,2);assert.equal(downloaded.value.status,'draft');
  assert.equal(JSON.stringify(row),before);assert.deepEqual(h.calls.writes,[]);
});

test('insight cards resolve current profile photos in read, edit and preview without changing content',async t=>{
  const h=harness(t,{rows:[record(1,{userId:'reader'})],session:{admin:true}});
  const rows=[{id:'insight-1',bookId:'emotion',userId:'member-1',round:1,name:'가람',answers:['소감','깨달음','실천']}];
  const before=JSON.stringify(rows),users={'member-1':{avatar:'https://example.com/old.jpg'}};
  const page=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  // Exercise the same safe renderer used by the sharing feed, not a test-only photo formatter.
  const avatarSource=page.slice(page.indexOf('function avatarHtml('),page.indexOf('function publicAuthorHtml('));
  const context={STATE:{users},GrowellProfile:require('../profile.js'),
    esc:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    initials:name=>(name||'?').trim().slice(0,1)};
  vm.runInNewContext(avatarSource,context);h.adapter.avatarHtml=context.avatarHtml;
  h.adapter.getInsights=()=>rows;
  h.api.openRound('emotion',1);await tick();
  assert.match(h.html(),/src="https:\/\/example.com\/old.jpg"/);
  users['member-1'].avatar='https://example.com/new.jpg?a=1&b=2';h.click('edit');
  assert.match(h.html(),/src="https:\/\/example.com\/new.jpg\?a=1&amp;b=2"/);
  h.click('preview-mode');assert.match(h.html(),/new.jpg/);assert.doesNotMatch(h.html(),/old.jpg/);
  for(const avatar of ['', 'javascript:alert(1)']){
    users['member-1'].avatar=avatar;h.click('editor-mode');
    assert.doesNotMatch(h.html(),/<img|javascript:/);assert.match(h.html(),/>가<\/div>/);
    h.click('preview-mode');assert.doesNotMatch(h.html(),/<img/);
  }
  delete users['member-1'];h.click('editor-mode');assert.match(h.html(),/>가<\/div>/);
  delete h.adapter.avatarHtml;h.click('preview-mode');assert.match(h.html(),/class="mr-avatar" aria-hidden="true">가<\/div>/);
  assert.equal(JSON.stringify(rows),before);assert.match(h.html(),/소감/);assert.match(h.html(),/깨달음/);assert.match(h.html(),/실천/);
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

test('next meeting preparation appears immediately before member insights with only sharing highlighted',async t=>{
  const nextMeeting={date:'2026-10-24',time:'13:30',place:'추후 안내',reading:'1부 1장, 64쪽까지',sharing:'나눔 글 1편\n  <생각> & 질문을 남긴다.  ',habit:'자신의 속도로 읽기'};
  const selected=record(1,{nextMeeting}),snapshot=JSON.stringify(selected),h=harness(t,{rows:[selected]});
  h.api.openRound('emotion',1);await tick();
  const html=h.html(),prep=html.indexOf('data-mr-preparation'),insights=html.indexOf('data-mr-carousel');
  assert.ok(prep>html.indexOf('원본 본문 1')&&prep<insights);
  assert.match(html.slice(prep,insights),/다음 모임 준비/);
  assert.match(html,/<dt>일시<\/dt><dd>2026\.10\.24 · 13:30<\/dd>/);
  assert.match(html,/<dt>읽기 범위<\/dt><dd>1부 1장, 64쪽까지<\/dd>/);
  assert.match(html,/<div class="mr-preparation-row mr-preparation-highlight"><dt>나눔<\/dt><dd><mark>나눔 글 1편\n  &lt;생각&gt; &amp; 질문을 남긴다\.  <\/mark><\/dd><\/div>/);
  assert.equal((html.match(/<mark>/g)||[]).length,1,'only the sharing instruction receives emphasis');
  assert.doesNotMatch(html,/<생각>/,'stored text is escaped rather than rendered as HTML');
  assert.equal(JSON.stringify(selected),snapshot,'reading preparation cannot change the source record');
});

test('legacy and blank preparation stay hidden in reading view but the owner can add it',async t=>{
  for(const extra of [{},{nextMeeting:null},{nextMeeting:{date:'',time:'',place:' ',reading:'',sharing:'',habit:''}}]){
    const h=harness(t,{session:{admin:true},rows:[record(1,{userId:'reader',...extra})]});
    h.api.openRound('emotion',1);await tick();
    assert.doesNotMatch(h.html(),/data-mr-preparation|다음 모임 준비/);
    h.click('edit');
    assert.match(h.html(),/data-mr-preparation/);
    assert.equal(h.current().querySelectorAll('[data-mr-next]').length,7);
    h.click('preview-mode');
    assert.doesNotMatch(h.html(),/data-mr-preparation|다음 모임 준비/,'opening the editor alone does not create empty published content');
  }
});

test('preparation input survives preview, return to editor and saving without changing existing meeting text',async t=>{
  const selected=record(1,{userId:'reader'}),snapshot=JSON.stringify(selected);
  const h=harness(t,{session:{admin:true},rows:[selected],save:payload=>({...payload,revision:payload.revision+1,updatedAt:'2026-10-12T00:00:00Z'})});
  const nextMeeting={date:'2026-10-24',time:'13:30',place:'추후 안내',reading:'1부 1장, 64쪽까지',sharing:'  나눔 글 1편\n\n문장과 생각을 남긴다.  ',habit:'시간과 장소 정하기'};
  h.api.openRound('emotion',1);await tick();h.click('edit');
  for(const [key,value] of Object.entries(nextMeeting))h.input('[data-mr-next="'+key+'"]',value);
  h.click('preview-mode');assert.match(h.html(),/<mark>  나눔 글 1편\n\n문장과 생각을 남긴다\.  <\/mark>/);
  h.click('editor-mode');assert.match(h.html(),/>  나눔 글 1편\n\n문장과 생각을 남긴다\.  <\/textarea>/);
  h.click('publish');await tick();
  assert.equal(h.calls.writes.length,1);
  const payload=h.calls.writes[0][1];
  assert.equal(JSON.stringify(payload.nextMeeting),JSON.stringify(nextMeeting));
  assert.equal(JSON.stringify(payload.sections),JSON.stringify(selected.sections));
  assert.equal(payload.id,selected.id);assert.equal(payload.revision,1);
  assert.match(h.html(),/<h2>다음 모임 준비<\/h2>/);assert.match(h.html(),/<mark>  나눔 글 1편/);
  assert.doesNotMatch(h.html(),/data-mr-next=/,'committed result returns to reading view');
  assert.equal(JSON.stringify(selected),snapshot,'the original loaded record was never edited in place');
});

test('an optional preparation end time is editable, previewed and saved without mutating a legacy source',async t=>{
  const nextMeeting={date:'2026-11-07',time:'13:30',place:'모임 장소',reading:'2장',sharing:'',habit:''};
  const selected=record(1,{userId:'reader',nextMeeting}),snapshot=JSON.stringify(selected);
  const h=harness(t,{session:{admin:true},rows:[selected],save:payload=>({...payload,revision:payload.revision+1})});
  h.api.openRound('emotion',1);await tick();h.click('edit');
  assert.match(h.html(),/종료 시간/);assert.match(h.html(),/data-mr-next="endTime" value=""/);
  h.input('[data-mr-next="endTime"]','15:00');h.click('preview-mode');assert.match(h.html(),/2026\.11\.07 · 13:30~15:00/);
  h.click('editor-mode');h.click('publish');await tick();
  assert.equal(h.calls.writes.length,1);assert.deepEqual(h.calls.writes[0][1].nextMeeting,{...nextMeeting,endTime:'15:00'});
  assert.equal(JSON.stringify(selected),snapshot);
});

test('failed preparation save retains the draft, supports retry and leaves the original intact',async t=>{
  const selected=record(1,{userId:'reader'}),snapshot=JSON.stringify(selected);let attempts=0;
  const h=harness(t,{session:{admin:true},rows:[selected],save:payload=>{
    if(++attempts===1)throw new Error('임시 연결 오류');
    return {...payload,revision:payload.revision+1,updatedAt:'2026-10-12T00:00:00Z'};
  }});
  h.api.openRound('emotion',1);await tick();h.click('edit');
  h.input('[data-mr-next="sharing"]','나눔 글 1편을 남긴다.');
  h.click('publish');await tick();
  assert.match(h.html(),/data-mr-next="sharing"/,'failure does not discard the editor');
  h.click('preview-mode');assert.match(h.html(),/<mark>나눔 글 1편을 남긴다\.<\/mark>/);
  h.click('publish');await tick();
  assert.equal(h.calls.writes.length,2);
  assert.equal(JSON.stringify(h.calls.writes[0][1]),JSON.stringify(h.calls.writes[1][1]),'retry preserves the exact draft and expected version');
  assert.match(h.html(),/<mark>나눔 글 1편을 남긴다\.<\/mark>/);
  assert.doesNotMatch(h.html(),/data-mr-next=/);
  assert.equal(JSON.stringify(selected),snapshot);
});
