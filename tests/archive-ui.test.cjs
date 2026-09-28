'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Domain=require('../archiveDomain.js');
const source=fs.readFileSync(path.join(__dirname,'../archive.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const unesc=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));}

// Small, inert DOM fixture: enough to bind the actual archive module's controls.
// It never executes attributes, makes network calls, or stores member data.
class Node {
  constructor(tag='div',attrs={}){this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.events={};this.parentNode=null;this._text='';this._html='';this.disabled='disabled' in attrs;this.checked='checked' in attrs;}
  get dataset(){return Object.fromEntries(Object.entries(this.attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));}
  get className(){return this.attrs.class||'';}set className(value){this.attrs.class=value;}
  get classList(){return {toggle:(name,on)=>{const names=new Set(this.className.split(/\s+/).filter(Boolean));const enabled=on===undefined?!names.has(name):on;if(enabled)names.add(name);else names.delete(name);this.className=[...names].join(' ');},add:name=>{this.className+=' '+name;},remove:name=>{this.className=this.className.split(/\s+/).filter(v=>v!==name).join(' ');}};}
  get isConnected(){return !!this.parentNode||this.tagName==='BODY';}
  get value(){
    if(this._value!==undefined)return this._value;
    if(this.tagName==='TEXTAREA')return this.textContent;
    if(this.tagName==='SELECT'){const options=this.querySelectorAll('option');const selected=options.find(n=>'selected' in n.attrs)||options[0];return selected?selected.attrs.value??selected.textContent:'';}
    return this.attrs.value||'';
  }
  set value(value){this._value=String(value);}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set textContent(value){this._text=String(value);this.children=[];this._html=String(value);}
  get innerHTML(){return this._html;}
  set innerHTML(markup){
    this._html=String(markup);this.children=[];this._text='';const stack=[this];
    for(const token of String(markup).matchAll(/<\/?[^>]+>|[^<]+/g)){
      const value=token[0];if(value.startsWith('</')){if(stack.length>1)stack.pop();continue;}
      if(!value.startsWith('<')){stack.at(-1)._text+=unesc(value);continue;}
      const match=value.match(/^<([a-z0-9-]+)([\s\S]*?)\/?\s*>$/i);if(!match)continue;
      const attrs={};for(const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g))attrs[attr[1]]=unesc(attr[2]??attr[3]??attr[4]??'');
      const child=new Node(match[1],attrs);stack.at(-1).appendChild(child);
      if(!/^(input|img|br|hr|meta|link|source)$/i.test(match[1])&&!value.endsWith('/>'))stack.push(child);
    }
  }
  get elements(){return Object.fromEntries(this.querySelectorAll('[name]').map(node=>[node.attrs.name,node]));}
  appendChild(child){child.parentNode=this;this.children.push(child);return child;}
  insertAdjacentHTML(position,markup){const fragment=new Node();fragment.innerHTML=markup;const items=fragment.children.slice();if(position==='beforebegin'||position==='afterend'){const parent=this.parentNode,index=parent.children.indexOf(this)+(position==='afterend'?1:0);items.forEach(item=>{item.parentNode=parent;});parent.children.splice(index,0,...items);}else{items.forEach(item=>{item.parentNode=this;});if(position==='afterbegin')this.children.unshift(...items);else this.children.push(...items);}}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null;}
  setAttribute(key,value){this.attrs[key]=String(value);}getAttribute(key){return this.attrs[key]??null;}
  addEventListener(name,handler){this.events[name]=handler;}
  focus(){this.focused=true;}setSelectionRange(){}showModal(){this.open=true;}close(){this.open=false;}
  matches(selector){
    const tag=selector.match(/^[a-z][\w-]*/i);if(tag&&this.tagName!==tag[0].toUpperCase())return false;
    const id=selector.match(/#([\w-]+)/);if(id&&this.attrs.id!==id[1])return false;
    for(const item of selector.matchAll(/\.([\w-]+)/g))if(!this.className.split(/\s+/).includes(item[1]))return false;
    for(const item of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g))if(!(item[1] in this.attrs)||item[2]!==undefined&&this.attrs[item[1]]!==item[2])return false;
    if(selector.includes(':checked')&&!this.checked)return false;return true;
  }
  querySelectorAll(selector){
    const result=[];const parts=selector.split(',').map(s=>s.trim());
    function walk(node){for(const child of node.children){if(parts.some(part=>{const hierarchy=part.split(/\s+(?![^\[]*\])/);if(!child.matches(hierarchy.at(-1)))return false;let parent=child.parentNode;for(let i=hierarchy.length-2;i>=0;i--){while(parent&&!parent.matches(hierarchy[i]))parent=parent.parentNode;if(!parent)return false;parent=parent.parentNode;}return true;}))result.push(child);walk(child);}}
    walk(this);return result;
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  async click(){if(this.disabled)return;const event={target:this,preventDefault(){},stopPropagation(){}};return this.onclick?this.onclick(event):this.events.click?.(event);}
}
class FormDataFixture {
  constructor(form){this.form=form;}
  get(name){const fields=this.form.querySelectorAll('[name="'+name+'"]');const field=fields.find(f=>!f.disabled&&(f.attrs.type!=='radio'||f.checked));return field?field.value:null;}
}
function makeRow(id,overrides={},userId='owner'){
  return {entry:{id:Domain.recordId(userId,'arc_'+id),bookId:Domain.STORAGE_BOOK_ID,userId,createdAt:1000,data:'cipher-'+id},
    book:Domain.prepare({title:'책 '+id,authors:['테스트 저자'],status:'reading',currentPage:25,totalPages:200,...overrides})};
}
function harness(initialRows=[]){
  const body=new Node('body'),events={},toasts=[],saved=[],history=[],reads=[],timers=[];
  let session={userId:'owner'},rows=clone(initialRows),failure=null,serial=0,loadStatus='ready',customRead=null,catalog=[],fetcher=async()=>({ok:true,json:async()=>({items:[],hasMore:false})});
  const doc={body,createElement:tag=>new Node(tag),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),getElementById:id=>body.querySelector('#'+id)};
  const c={URL,Date,Promise,Set,AbortController,setTimeout,clearTimeout,FormData:FormDataFixture,document:doc,GrowellArchiveDomain:Domain,
    crypto:{randomUUID:()=> 'fixture-'+(++serial)},confirm:()=>true,fetch:(...args)=>fetcher(...args),
    GrowellPopupHistory:{open:(key,options)=>history.push({key,options}),closed:key=>history.push({closed:key})},
    addEventListener:(name,fn)=>{events[name]=fn;},
    GrowellArchiveTimer:{html:()=>'',bind(){},reset(){},hasDraft:()=>false,open:options=>timers.push(options)}};
  c.window=c;vm.createContext(c);vm.runInContext(source,c);
  const api=c.GrowellArchive;
  const adapter={session:()=>session,status:()=>loadStatus,statusHtml:()=>'<p>loading status</p>',entries:()=>rows.map(r=>r.entry),
    read:async entries=>{reads.push(entries);return customRead?customRead(entries):rows.filter(r=>entries.some(e=>e.id===r.entry.id)).map(clone);},
    render(){},toast:message=>toasts.push(message),reload(){},catalog:()=>catalog,
    save:async(row,book,createId)=>{
      const normalized=Domain.prepare(book);saved.push({row:clone(row),book:normalized,createId});
      if(failure)throw failure;
      const entry=row?{...row.entry,data:row.entry.data+'x',updatedAt:Date.now()}:{id:Domain.recordId(session.userId,createId),bookId:Domain.STORAGE_BOOK_ID,userId:session.userId,createdAt:Date.now(),data:'new'};
      const result={entry,book:normalized};rows=rows.filter(r=>r.entry.id!==entry.id).concat([result]);return clone(result);
    }};
  api.configure(adapter);
  return {api,c,doc,body,events,toasts,saved,history,reads,timers,adapter,rows:()=>rows,
    setFailure:value=>{failure=value;},setSession:value=>{session=value;},setStatus:value=>{loadStatus=value;},setRead:value=>{customRead=value;},
    setRows:value=>{rows=clone(value);},setCatalog:value=>{catalog=value;},setFetch:value=>{fetcher=value;},
    async mount(){api.html();await flush();body.innerHTML=api.html();api.bind();return body;},
    async open(id){await this.mount();const button=body.querySelector('[data-archive-open="'+Domain.recordId('owner','arc_'+id)+'"]');assert.ok(button,'archive card');await button.click();return body.querySelector('dialog');}};
}

test('book cards expose reading states and honest progress, and state tabs filter the cover shelf',async()=>{
  const h=harness([makeRow('unread',{status:'unread'}),makeRow('reading',{currentPage:50,totalPages:200}),
    makeRow('complete',{status:'completed',totalPages:300}),makeRow('unknown',{totalPages:null,currentPage:12})]);
  await h.mount();
  const reading=h.body.querySelector('[data-archive-open="'+Domain.recordId('owner','arc_reading')+'"]');
  assert.match(reading.textContent,/읽는 중/);assert.match(reading.textContent,/50 \/ 200쪽/);
  assert.equal(reading.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'25');
  const unread=h.body.querySelector('[data-archive-open="'+Domain.recordId('owner','arc_unread')+'"]');
  assert.match(unread.textContent,/읽기 전/);assert.match(unread.textContent,/0 \/ 200쪽/);
  const complete=h.body.querySelector('[data-archive-open="'+Domain.recordId('owner','arc_complete')+'"]');
  assert.match(complete.textContent,/완독/);assert.match(complete.textContent,/300 \/ 300쪽/);
  const unknown=h.body.querySelector('[data-archive-open="'+Domain.recordId('owner','arc_unknown')+'"]');
  assert.match(unknown.textContent,/전체 쪽수 미입력/);assert.equal(unknown.querySelector('[role="progressbar"]'),null);
  await h.body.querySelector('[data-archive-status="reading"]').click();
  assert.equal(h.body.querySelectorAll('[data-archive-open]').length,2);
  await h.body.querySelector('[data-archive-status="completed"]').click();
  assert.equal(h.body.querySelectorAll('[data-archive-open]').length,1);
  assert.match(h.body.querySelector('.archive-grid').textContent,/책 complete/);
});

test('personal-space archive records show only this owner and never publish elapsed reading time',async()=>{
  const session={id:'timer_private',seconds:54321,startPage:10,endPage:50,createdAt:2000};
  const notes=[{id:'note_visible',text:'나만의 문장 <script>비공개</script>',createdAt:3000},{id:'note_deleted',text:'삭제한 문장',createdAt:2500,deleted:true}];
  const h=harness([makeRow('mine',{notes,readingSessions:[session],review:'나의 감상'}),
    makeRow('trashed',{deleted:true,review:'휴지통 감상'}),makeRow('foreign',{review:'다른 회원 비밀'},'other')]);
  await h.mount();const markup=h.api.recordsHtml();
  assert.match(markup,/나만의 문장/);assert.match(markup,/&lt;script&gt;비공개&lt;\/script&gt;/);
  assert.doesNotMatch(markup,/10 → 50쪽 읽음|나의 감상|삭제한 문장|휴지통 감상|다른 회원 비밀|54321|15시간|총 읽은 시간|archive-time|archive-sessions/);
  assert.equal(h.reads.flat().some(entry=>entry.userId==='other'),false);
  h.setSession(null);assert.equal(h.api.recordsHtml(),'');
  h.setSession({userId:'other'});assert.doesNotMatch(h.api.recordsHtml(),/나만의 문장/);
});

test('personal-space records stay private while loading fails or an earlier account read arrives late',async()=>{
  const h=harness([makeRow('secret',{review:'이전 계정의 감상'})]),pending=deferred();h.setRead(()=>pending.promise);
  assert.equal(h.api.recordsHtml(),'');h.setSession({userId:'other'});h.api.bind();
  pending.resolve([makeRow('secret',{review:'이전 계정의 감상'})]);await flush();
  assert.doesNotMatch(h.api.recordsHtml(),/이전 계정의 감상/);
  const fail=harness([makeRow('private',{review:'오류 중 감상'})]);fail.setStatus('error');
  assert.equal(fail.api.recordsHtml(),'');assert.equal(fail.reads.length,0);
});

test('editing book progress and review preserves its notes, sessions and record identity',async()=>{
  const original=makeRow('editing',{notes:[{id:'note_1',text:'보존할 생각',createdAt:1000}],readingSessions:[{id:'read_1',seconds:60,startPage:0,endPage:25,createdAt:2000}],review:'이전 감상'});
  const h=harness([original]),dialog=await h.open('editing');
  await dialog.querySelector('[data-archive-edit]').click();const form=dialog.querySelector('#archive-form');
  assert.equal(new FormDataFixture(form).get('status'),'reading');assert.equal(form.elements.currentPage.value,'25');
  form.elements.currentPage.value='40';form.elements.totalPages.value='200';form.elements.review.value='수정한 감상';
  await form.onsubmit({preventDefault(){},currentTarget:form});await flush();
  assert.equal(h.saved.length,1);const saved=h.saved[0];assert.equal(saved.row.entry.id,original.entry.id);
  assert.equal(saved.book.currentPage,40);assert.equal(saved.book.status,'reading');assert.equal(saved.book.review,'수정한 감상');
  assert.deepEqual(saved.book.notes,original.book.notes);assert.deepEqual(saved.book.readingSessions,original.book.readingSessions);
});

test('new books begin unread and completed selection uses known total pages',async()=>{
  const h=harness();await h.mount();await h.body.querySelector('[data-archive-add]').click();
  const form=h.body.querySelector('#archive-form');assert.equal(new FormDataFixture(form).get('status'),'unread');assert.equal(form.elements.currentPage.disabled,true);
  form.elements.title.value='새 책';form.elements.totalPages.value='240';
  for(const radio of form.querySelectorAll('[name="status"]'))radio.checked=radio.value==='completed';
  form.querySelector('[name="status"][value="completed"]').onchange();assert.equal(form.elements.currentPage.value,'240');
  await form.onsubmit({preventDefault(){},currentTarget:form});await flush();
  assert.equal(h.saved[0].book.status,'completed');assert.equal(h.saved[0].book.currentPage,240);assert.equal(h.saved[0].book.totalPages,240);
});

test('archive note failures preserve text; retry updates only that note and original timestamps',async()=>{
  const original=makeRow('notes',{notes:[{id:'note_keep',text:'원래 생각',createdAt:1000}],readingSessions:[{id:'timer_keep',seconds:75,startPage:0,endPage:25,createdAt:2000}]});
  const h=harness([original]),detail=await h.open('notes');await detail.querySelector('[data-archive-note-edit="note_keep"]').click();
  const note=h.body.querySelector('.archive-note-dialog'),form=note.querySelector('form');form.elements.text.value='수정 중인 생각';note.events.input();
  h.setFailure(new Error('연결 실패'));await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.equal(note.open,true);assert.equal(form.elements.text.value,'수정 중인 생각');assert.match(form.querySelector('.archive-form-status').textContent,/연결 실패/);
  assert.equal(h.rows()[0].book.notes[0].text,'원래 생각');h.setFailure(null);await form.onsubmit({preventDefault(){},currentTarget:form});await flush();
  const changed=h.rows()[0];assert.equal(changed.entry.createdAt,original.entry.createdAt);
  assert.equal(changed.book.notes[0].id,'note_keep');assert.equal(changed.book.notes[0].createdAt,1000);assert.equal(changed.book.notes[0].text,'수정 중인 생각');
  assert.deepEqual(changed.book.readingSessions,original.book.readingSessions);assert.equal(note.open,false);
});

test('note edits refuse a newer remote note while preserving the local draft',async()=>{
  const original=makeRow('notes',{notes:[{id:'note_one',text:'원본',createdAt:1000}]});
  const h=harness([original]),detail=await h.open('notes');await detail.querySelector('[data-archive-note-edit="note_one"]').click();
  const note=h.body.querySelector('.archive-note-dialog'),form=note.querySelector('form');form.elements.text.value='내 수정';
  h.setRows([{...original,book:Domain.upsertNote(original.book,{id:'note_one',text:'다른 기기 수정',createdAt:1000,updatedAt:3000})}]);
  await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(h.saved.length,0);
  assert.match(form.querySelector('.archive-form-status').textContent,/다른 곳/);assert.equal(form.elements.text.value,'내 수정');
});

test('timer callback saves elapsed time solely into its archive book and preserves notes',async()=>{
  const original=makeRow('timer',{notes:[{id:'note_1',text:'타이머 전 생각',createdAt:1000}]});
  const h=harness([original]),detail=await h.open('timer');await detail.querySelector('[data-archive-timer]').click();
  assert.equal(h.timers.length,1);const timer=h.timers[0];assert.equal(timer.book.id,original.entry.id);assert.equal(timer.ownerId,'owner');
  await timer.adapter.saveSession(original.entry.id,{id:'timer_new',seconds:240,startPage:25,endPage:50,createdAt:2000},{});
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].row.entry.id,original.entry.id);assert.equal(Domain.totalReadingSeconds(h.saved[0].book),240);
  assert.equal(h.saved[0].book.currentPage,50);assert.equal(h.saved[0].book.notes[0].text,'타이머 전 생각');
  assert.doesNotMatch(h.api.recordsHtml(),/4분|240|총 읽은 시간/);
});

const yes24Book=(overrides={})=>({source:'yes24',id:'123456',title:'새 한국 책',authors:['한국 저자'],publisher:'국내 출판사',publishedDate:'2026-09-27',isbn:'9788936434120',pageCount:224,description:'책 소개',thumbnail:'https://image.yes24.com/goods/123456/XL',sourceUrl:'https://www.yes24.com/Product/Goods/123456',...overrides});
const searchResponse=(items,extra={},ok=true)=>({ok,json:async()=>({items,page:1,hasMore:false,...extra})});
async function openAdd(h){await h.mount();await h.body.querySelector('[data-archive-add]').click();return h.body.querySelector('dialog');}
async function submitSearch(dialog,query){const form=dialog.querySelector('#archive-search-form');form.elements.query.value=query;return form.onsubmit({preventDefault(){}});}

test('book search defaults to domestic books and pages recent results without duplicating books',async()=>{
  const h=harness(),calls=[];h.setCatalog([{title:'새 한국 책',authors:['한국 저자'],isbn:'9788936434120',source:'catalog'}]);
  h.setFetch(async(url)=>{const params=new URL(url,'https://fixture.invalid').searchParams;calls.push(params);return searchResponse(params.get('page')==='1'?[yes24Book()]:[yes24Book(),yes24Book({id:'2',title:'두 번째 한국 책',isbn:'9788936433598'})],{hasMore:params.get('page')==='1'});});
  const dialog=await openAdd(h),search=dialog.querySelector('#archive-search-form');
  search.elements.sort.value='recent';await submitSearch(dialog,'한국');
  assert.equal(calls[0].get('mode'),'search');assert.equal(calls[0].get('scope'),'domestic');assert.equal(calls[0].get('sort'),'recent');assert.equal(calls[0].get('page'),'1');
  assert.equal(dialog.querySelectorAll('[data-search-result]').length,1);assert.match(dialog.querySelector('.archive-search-results').textContent,/도서 정보: YES24/);assert.doesNotMatch(dialog.querySelector('.archive-search-results').textContent,/모임 도서/);
  await dialog.querySelector('.archive-search-more').click();assert.equal(calls[1].get('page'),'2');assert.equal(dialog.querySelectorAll('[data-search-result]').length,2);assert.equal(dialog.querySelector('.archive-search-more').hidden,true);
});

test('new books and YES24 link mode share one form while preserving personal draft fields',async()=>{
  const h=harness(),calls=[];h.setFetch(async(url)=>{calls.push(new URL(url,'https://fixture.invalid').searchParams);return searchResponse([yes24Book()]);});
  const dialog=await openAdd(h),form=dialog.querySelector('#archive-form');form.elements.review.value='작성하던 감상';form.elements.startDate.value='2026-09-01';form.querySelector('[name="rating"][value="4"]').checked=true;
  await dialog.querySelector('[data-book-search-mode="new"]').click();assert.equal(calls[0].get('mode'),'new');assert.equal(calls[0].get('scope'),'domestic');assert.equal(calls[0].get('sort'),'recent');assert.equal(dialog.querySelector('.archive-search-query').hidden,true);
  await dialog.querySelector('[data-book-search-mode="link"]').click();assert.equal(dialog.querySelector('.archive-search-query').hidden,false);assert.equal(dialog.querySelector('.archive-search-options').hidden,true);
  await submitSearch(dialog,'https://www.yes24.com/Product/Goods/123456');assert.equal(calls[1].get('mode'),'link');assert.equal(calls[1].get('q'),'https://www.yes24.com/Product/Goods/123456');
  await dialog.querySelector('[data-search-result="0"]').click();assert.equal(form.elements.title.value,'새 한국 책');assert.equal(form.elements.authors.value,'한국 저자');assert.equal(form.elements.totalPages.value,'224');assert.equal(form.elements.review.value,'작성하던 감상');assert.equal(form.elements.startDate.value,'2026-09-01');assert.equal(form.querySelector('[name="rating"][value="4"]').checked,true);
  assert.match(dialog.querySelector('.archive-selected-source').textContent,/도서 정보: YES24/);assert.equal(dialog.querySelector('#archive-cover-preview img').getAttribute('src'),'https://image.yes24.com/goods/123456/XL');
  await form.onsubmit({preventDefault(){}});assert.equal(h.saved[0].book.source,'yes24');assert.equal(h.saved[0].book.providerId,'123456');assert.equal(h.saved[0].book.sourceUrl,'https://www.yes24.com/Product/Goods/123456');assert.equal(h.saved[0].book.totalPages,224);
});

test('search mode and account changes discard stale results and cannot overwrite a draft',async()=>{
  const h=harness(),old=deferred(),signals=[];h.setFetch((url,options)=>{signals.push(options.signal);return signals.length===1?old.promise:Promise.resolve(searchResponse([yes24Book({title:'오늘 나온 책'})]));});
  const dialog=await openAdd(h),form=dialog.querySelector('#archive-form');form.elements.title.value='직접 쓰던 제목';const pending=submitSearch(dialog,'이전 검색');await dialog.querySelector('[data-book-search-mode="new"]').click();
  assert.equal(signals[0].aborted,true);old.resolve(searchResponse([yes24Book({title:'늦게 온 책'})]));await pending;assert.match(dialog.querySelector('.archive-search-results').textContent,/오늘 나온 책/);assert.doesNotMatch(dialog.querySelector('.archive-search-results').textContent,/늦게 온 책/);assert.equal(form.elements.title.value,'직접 쓰던 제목');
  await dialog.querySelector('[data-book-search-mode="search"]').click();const later=deferred();h.setFetch(()=>later.promise);const future=submitSearch(dialog,'계정 변경 전');h.setSession({userId:'other'});later.resolve(searchResponse([yes24Book({title:'이전 계정 응답'})]));await future;assert.doesNotMatch(dialog.querySelector('.archive-search-results').textContent,/이전 계정 응답/);assert.equal(form.elements.title.value,'직접 쓰던 제목');
});

test('editing a search query aborts its pending request and leaves its existing form values intact',async()=>{
  const h=harness(),pending=deferred();let signal;h.setFetch((url,options)=>{signal=options.signal;return pending.promise;});const dialog=await openAdd(h),form=dialog.querySelector('#archive-form');form.elements.review.value='보존할 감상';
  const wait=submitSearch(dialog,'처음 검색');const query=dialog.querySelector('#archive-search-form').elements.query;query.value='다른 검색';query.oninput();pending.resolve(searchResponse([yes24Book()]));await wait;
  assert.equal(signal.aborted,true);assert.equal(dialog.querySelectorAll('[data-search-result]').length,0);assert.equal(form.elements.review.value,'보존할 감상');assert.equal(dialog.querySelector('#archive-search-form [type="submit"]').disabled,false);
});

test('missing YES24 connection stays explicit; local catalog is separately labelled and foreign search stays opt-in',async()=>{
  const h=harness(),calls=[];h.setCatalog([{title:'한국 모임 책',authors:['모임 저자'],pageCount:100,source:'catalog'}]);h.setFetch(async(url)=>{calls.push(new URL(url,'https://fixture.invalid').searchParams);return searchResponse([],{error:'YES24 도서 검색 연결을 준비 중이에요.',code:'YES24_NOT_CONFIGURED'},false);});
  const dialog=await openAdd(h);await submitSearch(dialog,'한국');assert.match(dialog.querySelector('.archive-search-note').textContent,/YES24 도서 검색 연결을 준비 중/);assert.match(dialog.querySelector('.archive-search-results').textContent,/모임 도서/);assert.doesNotMatch(dialog.querySelector('.archive-search-results').textContent,/도서 정보: YES24/);
  const search=dialog.querySelector('#archive-search-form');search.elements.scope.value='foreign';await search.elements.scope.onchange();assert.equal(calls.at(-1).get('scope'),'foreign');assert.equal(dialog.querySelectorAll('[data-search-result]').length,0);
  await dialog.querySelector('[data-book-search-mode="link"]').click();await submitSearch(dialog,'9788936434120');assert.equal(calls.at(-1).get('mode'),'link');assert.equal(calls.at(-1).get('q'),'9788936434120');
});

test('YES24 saved cards, records, detail and timer retain safe source attribution without nested links',async()=>{
  const book=yes24Book({sourceUrl:'https://m.yes24.com/Goods/123456?tracking=ignored'}),row=makeRow('yes24',{...book,providerId:book.id,coverUrl:book.thumbnail,review:'감상',notes:[{id:'n1',text:'내 노트',createdAt:1000}],tableOfContents:'1부 시작\n2부 <끝>'});const h=harness([row]);await h.mount();
  const card=h.body.querySelector('[data-archive-open]');assert.equal(card.querySelector('a'),null);assert.equal(card.parentNode.querySelector('.archive-source a').getAttribute('href'),'https://www.yes24.com/Product/Goods/123456');
  const records=new Node();records.innerHTML=h.api.recordsHtml();assert.equal(records.querySelector('button a'),null);assert.match(records.querySelector('.archive-source').textContent,/YES24/);
  await card.click();const detail=h.body.querySelector('dialog');assert.match(detail.querySelector('.archive-source').textContent,/도서 정보: YES24/);await detail.querySelector('[data-archive-timer]').click();assert.equal(h.timers[0].book.source,'yes24');assert.equal(h.timers[0].book.sourceUrl,'https://www.yes24.com/Product/Goods/123456');
  await detail.querySelector('[data-archive-edit]').click();assert.match(detail.querySelector('.archive-selected-source').textContent,/YES24/);
  const unsafe=harness([makeRow('unsafe',{...book,sourceUrl:'https://yes24.com.attacker.invalid/Product/Goods/123456'})]);await unsafe.mount();assert.equal(unsafe.body.querySelector('.archive-source a'),null);
});

test('choosing another catalog book clears metadata belonging to the previous YES24 result',async()=>{
  const h=harness();h.setFetch(async()=>searchResponse([yes24Book({tableOfContents:'다른 책 목차'})]));const dialog=await openAdd(h);await submitSearch(dialog,'처음');await dialog.querySelector('[data-search-result="0"]').click();
  h.setCatalog([{title:'새 모임 책',authors:['모임 저자'],source:'growell',sourceUrl:'https://www.example.com/book',pageCount:120}]);h.setFetch(async()=>searchResponse([]));await submitSearch(dialog,'모임');await dialog.querySelector('[data-search-result="0"]').click();const form=dialog.querySelector('#archive-form');await form.onsubmit({preventDefault(){}});
  assert.equal(h.saved[0].book.title,'새 모임 책');assert.equal(h.saved[0].book.source,'growell');assert.equal(h.saved[0].book.providerId,'');assert.equal(h.saved[0].book.publishedDate,'');assert.equal(h.saved[0].book.isbn,'');assert.equal(h.saved[0].book.description,'');assert.equal(h.saved[0].book.coverUrl,'');assert.notEqual(h.saved[0].book.tableOfContents,'다른 책 목차');
});

test('book genres expose only registered categories and personal theme selections are saved together',async()=>{
  const h=harness([makeRow('essay',{genres:['에세이'],themes:['emotion','thought']}),makeRow('science',{genres:['과학'],themes:['body']}),makeRow('gone',{genres:['없는 장르'],deleted:true})]);await h.mount();
  const tabs=h.body.querySelector('.archive-genre-tabs');assert.match(tabs.textContent,/에세이/);assert.match(tabs.textContent,/과학/);assert.doesNotMatch(tabs.textContent,/없는 장르|분류 없음/);
  await tabs.querySelector('[data-archive-genre="과학"]').click();assert.equal(h.body.querySelectorAll('[data-archive-open]').length,1);assert.match(h.body.querySelector('.archive-grid').textContent,/책 science/);
  const h2=harness([makeRow('edit',{genres:['인문'],themes:['emotion']})]),dialog=await h2.open('edit');await dialog.querySelector('[data-archive-edit]').click();const form=dialog.querySelector('#archive-form');form.elements.genres.value='인문, 심리';form.elements.genres.oninput();form.querySelector('[name="theme"][value="thought"]').checked=true;await form.onsubmit({preventDefault(){}});
  assert.deepEqual(h2.saved[0].book.genres,['인문','심리']);assert.deepEqual(h2.saved[0].book.themes,['emotion','thought']);assert.equal(h2.saved[0].book.genreSource,'manual');
});

test('automatic genre lookup enriches the selected book without guessing missing classifications',async()=>{
  const h=harness(),calls=[];h.setFetch(async(url)=>{calls.push(url);return url.includes('mode=genres')?searchResponse([],{genres:['인문'],genreSource:'yes24'}):searchResponse([yes24Book()]);});const dialog=await openAdd(h);await submitSearch(dialog,'한국');await dialog.querySelector('[data-search-result="0"]').click();await flush();
  const form=dialog.querySelector('#archive-form');assert.equal(form.elements.genres.value,'인문');assert.ok(calls.some(url=>url.includes('mode=genres')));await form.onsubmit({preventDefault(){}});assert.equal(h.saved[0].book.genreSource,'yes24');assert.deepEqual(h.saved[0].book.genres,['인문']);
  const empty=harness();empty.setFetch(async(url)=>url.includes('mode=genres')?searchResponse([],{genres:[]}):searchResponse([yes24Book()]));const e=await openAdd(empty);await submitSearch(e,'한국');await e.querySelector('[data-search-result="0"]').click();await flush();assert.equal(e.querySelector('#archive-form').elements.genres.value,'');assert.match(e.querySelector('[data-genre-status]').textContent,/제공된 장르가 없어요/);
});

test('late automatic classification cannot replace manual genres and registration waits at most four seconds',async()=>{
  const h=harness(),pending=deferred();h.setFetch(async(url)=>url.includes('mode=genres')?pending.promise:searchResponse([yes24Book()]));const dialog=await openAdd(h);await submitSearch(dialog,'한국');await dialog.querySelector('[data-search-result="0"]').click();const form=dialog.querySelector('#archive-form');form.elements.genres.value='나의 분류';form.elements.genres.oninput();pending.resolve(searchResponse([],{genres:['인문'],genreSource:'yes24'}));await flush();assert.equal(form.elements.genres.value,'나의 분류');await form.onsubmit({preventDefault(){}});assert.deepEqual(h.saved[0].book.genres,['나의 분류']);assert.equal(h.saved[0].book.genreSource,'manual');
  const fast=harness(),slow=deferred();let timeout;fast.c.setTimeout=(callback,milliseconds)=>{assert.equal(milliseconds,4000);timeout=callback;return 1;};fast.c.clearTimeout=()=>{};fast.setFetch(async(url)=>url.includes('mode=genres')?slow.promise:searchResponse([yes24Book()]));const d=await openAdd(fast);await submitSearch(d,'한국');await d.querySelector('[data-search-result="0"]').click();const saving=d.querySelector('#archive-form').onsubmit({preventDefault(){}});await flush();assert.equal(fast.saved.length,0);assert.match(d.querySelector('#archive-form .archive-form-status').textContent,/도서 분류를 확인/);timeout();await saving;assert.equal(fast.saved.length,1);assert.deepEqual(fast.saved[0].book.genres,[]);slow.resolve(searchResponse([],{genres:['뒤늦은 분류']}));await flush();assert.deepEqual(fast.rows()[0].book.genres,[]);
});

test('immediate registration waits for automatic genres and ignores a second save while checking',async()=>{
  const h=harness(),pending=deferred();h.setFetch(async(url)=>url.includes('mode=genres')?pending.promise:searchResponse([yes24Book()]));const dialog=await openAdd(h);await submitSearch(dialog,'한국');await dialog.querySelector('[data-search-result="0"]').click();const form=dialog.querySelector('#archive-form');const saving=form.onsubmit({preventDefault(){}});await flush();assert.equal(h.saved.length,0);assert.equal(form.querySelector('[type="submit"]').disabled,true);assert.match(form.querySelector('.archive-form-status').textContent,/도서 분류를 확인하고 있어요/);await form.onsubmit({preventDefault(){}});pending.resolve(searchResponse([],{genres:['인문'],genreSource:'yes24'}));await saving;assert.equal(h.saved.length,1);assert.deepEqual(h.saved[0].book.genres,['인문']);assert.equal(h.saved[0].book.genreSource,'yes24');
});

test('account changes while classification is being checked cancel book registration',async()=>{
  const h=harness(),pending=deferred();h.setFetch(async(url)=>url.includes('mode=genres')?pending.promise:searchResponse([yes24Book()]));const dialog=await openAdd(h);await submitSearch(dialog,'한국');await dialog.querySelector('[data-search-result="0"]').click();const saving=dialog.querySelector('#archive-form').onsubmit({preventDefault(){}});await flush();h.setSession({userId:'other'});pending.resolve(searchResponse([],{genres:['인문'],genreSource:'yes24'}));await saving;assert.equal(h.saved.length,0);assert.equal(dialog.querySelector('#archive-form').elements.genres.value,'');
});

test('notes below the shelf use genre-only carousel filters while reflections contain only matching notes',async()=>{
  const h=harness([makeRow('emotion',{genres:['인문'],themes:['emotion','thought'],review:'별점 감상',notes:[{id:'emotion_note',text:'감정과 생각 노트',createdAt:2000}]}),makeRow('body',{genres:['건강'],themes:['body'],notes:[{id:'body_note',text:'몸을 위한 노트',createdAt:3000}]}),makeRow('other',{genres:['다른회원'],themes:['action'],notes:[{id:'other_note',text:'다른 회원 노트',createdAt:4000}]},'foreign')]);await h.mount();
  assert.ok(h.body.innerHTML.indexOf('archive-note-shelf')>h.body.innerHTML.indexOf('archive-bookshelf'));assert.equal(h.body.querySelectorAll('[data-archive-read-note]').length,2);assert.doesNotMatch(h.body.querySelector('.archive-note-shelf').textContent,/다른회원|다른 회원 노트/);assert.equal(h.body.querySelector('[data-note-book-filter]'),null);assert.doesNotMatch(h.body.querySelector('.archive-note-filter-tabs').textContent,/감정|생각|신체|행동/);assert.ok(h.body.querySelector('[data-note-carousel]'));
  await h.body.querySelector('[data-note-filter="건강"]').click();assert.equal(h.body.querySelectorAll('[data-archive-read-note]').length,1);assert.match(h.body.querySelector('.archive-note-list').textContent,/몸을 위한 노트/);
  await h.body.querySelector('[data-note-filter="인문"]').click();assert.equal(h.body.querySelectorAll('[data-archive-read-note]').length,1);assert.match(h.body.querySelector('.archive-note-list').textContent,/감정과 생각 노트/);
  const emotion=h.api.reflectionHtml('emotion');assert.match(emotion,/감정에 대한 고찰/);assert.match(emotion,/감정과 생각 노트/);assert.doesNotMatch(emotion,/몸을 위한 노트|별점 감상|읽은 기록 보기/);assert.match(h.api.reflectionHtml('thought'),/감정과 생각 노트/);assert.doesNotMatch(h.api.reflectionHtml('action'),/감정과 생각 노트|몸을 위한 노트/);assert.equal(h.api.reflectionHtml('invalid'),'');
});

test('note list opens a reading popup; Back preserves the shelf and owner can edit or delete that note',async()=>{
  const row=makeRow('reader',{themes:['emotion'],notes:[{id:'read_note',title:'마음에 남은 말',text:'읽기 전용으로 먼저 보여요',createdAt:1000}]}),h=harness([row]);await h.mount();const trigger=h.body.querySelector('[data-archive-read-note]');await trigger.click();let note=h.body.querySelector('.archive-note-dialog');assert.equal(note.querySelector('form'),null);assert.match(note.querySelector('.archive-note-rich').textContent,/읽기 전용/);const entry=h.history.filter(item=>item.key==='archive-note').at(-1);entry.options.close();assert.equal(h.body.querySelector('.archive-note-dialog'),null);assert.ok(h.body.querySelector('.archive-note-shelf'));assert.equal(trigger.focused,true);
  await trigger.click();note=h.body.querySelector('.archive-note-dialog');await note.querySelector('[data-note-edit]').click();const form=note.querySelector('form');form.elements.text.value='수정한 노트';await form.onsubmit({preventDefault(){}});await flush();assert.equal(h.rows()[0].book.notes[0].text,'수정한 노트');assert.equal(h.rows()[0].book.notes[0].createdAt,1000);
  await h.mount();await h.body.querySelector('[data-archive-read-note]').click();await h.body.querySelector('[data-note-delete]').click();await flush();assert.equal(h.rows()[0].book.notes[0].deleted,true);assert.doesNotMatch(h.api.reflectionHtml('emotion'),/수정한 노트/);
});

test('rich note editor sanitizes stored markup and read view; account changes abort draft save',async()=>{
  const h=harness([makeRow('rich',{notes:[{id:'rich_note',title:'제목',text:'안전한 글',html:'<p><b>안전한 글</b></p><script>secret()</script>',createdAt:1000}]})]);let cleaned=0;
  h.adapter.sanitizeHtml=html=>{cleaned++;return String(html).replace(/<script>[\s\S]*?<\/script>/g,'').replace(/ onerror="[^"]*"/g,'');};h.adapter.plainText=html=>html.replace(/<[^>]*>/g,'');h.adapter.editorHtml=html=>'<div class="rt-toolbar"><button type="button">굵게</button></div><div contenteditable="true">'+html+'</div>';let cleanup=0;h.adapter.bindEditor=()=>()=>{cleanup++;};
  await h.mount();await h.body.querySelector('[data-archive-read-note]').click();let note=h.body.querySelector('.archive-note-dialog');assert.doesNotMatch(note.querySelector('.archive-note-rich').innerHTML,/script|secret/);await note.querySelector('[data-note-edit]').click();let form=note.querySelector('form');assert.ok(form.querySelector('.rt-toolbar'));form.querySelector('[contenteditable="true"]').innerHTML='<p><b>바꾼 기록</b></p><script>bad()</script>';await form.onsubmit({preventDefault(){}});await flush();assert.equal(h.rows()[0].book.notes[0].html,'<p><b>바꾼 기록</b></p>');assert.equal(h.rows()[0].book.notes[0].text,'바꾼 기록');assert.ok(cleaned>=3);assert.equal(cleanup,1);
  await h.mount();await h.body.querySelector('[data-archive-read-note]').click();note=h.body.querySelector('.archive-note-dialog');await note.querySelector('[data-note-edit]').click();form=note.querySelector('form');form.querySelector('[contenteditable="true"]').innerHTML='<p>다른 계정에서 저장하면 안 됨</p>';h.setSession({userId:'other'});await form.onsubmit({preventDefault(){}});assert.equal(h.saved.length,1);
});

test('linked shared-book timer delegates to existing reading storage and reloads virtual progress by ID',async()=>{
  const h=harness();let snapshot={bookId:'emotion',book:{title:'모임 책',authors:['저자'],totalPages:200},currentPage:50,totalPages:200,readingSessions:[],active:true},signature='one';const shared=[];h.setRead(entries=>Domain.mergeLinkedRows([], [snapshot], 'owner'));h.adapter.linkedSignature=()=>signature;h.adapter.saveLinkedSession=async(bookId,session)=>{shared.push({bookId,session});snapshot={...snapshot,currentPage:session.endPage,readingSessions:[session]};signature='two';};
  await h.mount();const button=h.body.querySelector('[data-archive-open]');assert.ok(button);await button.click();await h.body.querySelector('[data-archive-timer]').click();const timer=h.timers[0];await timer.adapter.saveSession(timer.book.id,{id:'shared_timer',seconds:90,startPage:50,endPage:60,createdAt:2000},{});assert.equal(shared.length,1);assert.equal(shared[0].bookId,'emotion');assert.equal(h.saved.length,0);await h.mount();assert.match(h.body.querySelector('.archive-grid').textContent,/60 \/ 200쪽/);
});

test('existing shared-book private notes join all-book notes and open through their original popup hook',async()=>{
  const h=harness([makeRow('personal',{genres:['에세이'],themes:['thought'],notes:[{id:'archive_note',text:'아카이브 노트',createdAt:3000}]})]),opened=[];
  h.adapter.sharedNotes=()=>[{id:'private_emotion_note',userId:'owner',bookId:'emotion',bookTitle:'감정 모임 책',title:'내 원래 기록',text:'기존 나의 공간에서 작성한 내용',html:'<p>기존 내용</p>',createdAt:2000,genres:['인문'],themes:['emotion']},{id:'foreign_private',userId:'other',bookId:'emotion',bookTitle:'다른 계정 책',text:'노출하면 안 되는 글',createdAt:4000,genres:['비밀 분류']}];
  h.adapter.openSharedNote=(id,bookId)=>opened.push({id,bookId});await h.mount();const shelf=h.body.querySelector('.archive-note-shelf');assert.match(shelf.textContent,/기존 나의 공간에서 작성한 내용/);assert.match(shelf.textContent,/아카이브 노트/);assert.doesNotMatch(shelf.textContent,/노출하면 안 되는 글|비밀 분류/);assert.equal(shelf.querySelectorAll('[data-shared-read-note]').length,1);
  await shelf.querySelector('[data-shared-read-note]').click();assert.deepEqual(opened,[{id:'private_emotion_note',bookId:'emotion'}]);assert.equal(h.saved.length,0);
  await h.body.querySelector('[data-archive-notes-all]').click();const collection=h.body.querySelector('.archive-collection-dialog');await collection.querySelector('[data-collection-book="shared-note-book:emotion"]').click();assert.match(collection.querySelector('.archive-collection-list').textContent,/기존 나의 공간/);assert.doesNotMatch(collection.querySelector('.archive-collection-list').textContent,/아카이브 노트/);assert.doesNotMatch(h.api.reflectionHtml('emotion'),/기존 나의 공간/);assert.doesNotMatch(h.api.reflectionHtml('thought'),/기존 나의 공간/);
  h.setSession({userId:'other'});await shelf.querySelector('[data-shared-read-note]').click();assert.equal(opened.length,1);
});

test('shared private notes use the linked archive book classification and do not duplicate book filters',async()=>{
  const h=harness([makeRow('linked',{linkedBookId:'emotion',title:'연결된 모임 책',genres:['심리'],themes:['thought'],notes:[{id:'own_note',text:'연결 책의 아카이브 노트',createdAt:1000}]})]);h.adapter.sharedNotes=()=>[{id:'old_note',userId:'owner',bookId:'emotion',bookTitle:'기존 모임 제목',text:'기존 기록도 새 주제로 분류',createdAt:2000,genres:['옛 분류'],themes:['emotion']}];await h.mount();const shelf=h.body.querySelector('.archive-note-shelf');assert.doesNotMatch(shelf.textContent,/옛 분류|기존 모임 제목/);assert.match(shelf.textContent,/심리/);await shelf.querySelector('[data-archive-notes-all]').click();assert.equal(h.body.querySelectorAll('[data-collection-book]').length,1);assert.match(h.api.reflectionHtml('thought'),/기존 기록도 새 주제로 분류/);assert.doesNotMatch(h.api.reflectionHtml('emotion'),/기존 기록도 새 주제로 분류/);
  h.setRows([makeRow('linked',{linkedBookId:'emotion',title:'연결된 모임 책',themes:[],genres:[],notes:[]})]);await h.mount();assert.doesNotMatch(h.api.reflectionHtml('emotion'),/기존 기록도 새 주제로 분류/);assert.match(h.body.querySelector('.archive-note-shelf').textContent,/기존 기록도 새 주제로 분류/);
});

test('linked book edits keep shared reading status and pages read-only while saving personal metadata',async()=>{
  const h=harness([makeRow('shared-edit',{linkedBookId:'emotion',currentPage:60,totalPages:200,themes:['emotion']})]);const dialog=await h.open('shared-edit');await dialog.querySelector('[data-archive-edit]').click();const form=dialog.querySelector('#archive-form');assert.equal(form.elements.currentPage.readOnly,true);assert.equal(form.elements.totalPages.readOnly,true);assert.ok(form.querySelectorAll('[name="status"]').every(input=>input.disabled));assert.match(form.querySelector('.archive-linked-hint').textContent,/독서 타이머 기록/);
  form.elements.review.value='함께 읽은 책의 감상';await form.onsubmit({preventDefault(){}});assert.equal(h.saved[0].book.status,'reading');assert.equal(h.saved[0].book.currentPage,60);assert.equal(h.saved[0].book.totalPages,200);assert.equal(h.saved[0].book.review,'함께 읽은 책의 감상');
});

test('selecting a meeting catalog book fills default themes and activates linked progress controls',async()=>{
  const h=harness();h.setCatalog([{title:'새 모임 책',authors:['저자'],linkedBookId:'emotion',themes:['emotion'],status:'unread',source:'growell',pageCount:240}]);const dialog=await openAdd(h);await submitSearch(dialog,'모임');await dialog.querySelector('[data-search-result="0"]').click();const form=dialog.querySelector('#archive-form');assert.equal(form.querySelector('[name="theme"][value="emotion"]').checked,true);assert.ok(form.querySelectorAll('[name="status"]').every(input=>input.disabled));assert.equal(form.elements.currentPage.readOnly,true);assert.equal(form.elements.totalPages.readOnly,true);assert.equal(form.querySelector('.archive-linked-hint').hidden,false);await form.onsubmit({preventDefault(){}});assert.deepEqual(h.saved[0].book.themes,['emotion']);assert.equal(h.saved[0].book.linkedBookId,'emotion');assert.equal(h.saved[0].book.status,'unread');
});

test('changing from a meeting catalog book clears its link and preserves user-edited theme choices',async()=>{
  const h=harness();h.setCatalog([{title:'모임 선택',authors:['저자'],linkedBookId:'emotion',themes:['emotion'],status:'unread',source:'growell',pageCount:240}]);h.setFetch(async(url)=>url.includes('q=%EB%AA%A8%EC%9E%84')?searchResponse([]):searchResponse([yes24Book({genres:['소설'],genreSource:'yes24'})]));const dialog=await openAdd(h);await submitSearch(dialog,'모임');await dialog.querySelector('[data-search-result="0"]').click();let form=dialog.querySelector('#archive-form');const thought=form.querySelector('[name="theme"][value="thought"]');thought.checked=true;thought.onchange();await submitSearch(dialog,'한국');await dialog.querySelector('[data-search-result="0"]').click();assert.equal(form.querySelector('[name="theme"][value="emotion"]').checked,true);assert.equal(thought.checked,true);assert.ok(form.querySelectorAll('[name="status"]').every(input=>!input.disabled));assert.equal(form.elements.currentPage.readOnly,false);assert.equal(form.elements.totalPages.readOnly,false);assert.equal(form.querySelector('.archive-linked-hint').hidden,true);await form.onsubmit({preventDefault(){}});assert.equal(h.saved[0].book.linkedBookId,'');assert.deepEqual(h.saved[0].book.themes,['emotion','thought']);assert.equal(h.saved[0].book.status,'unread');
});

test('selecting an already registered meeting book opens its existing record instead of creating a duplicate',async()=>{
  const h=harness([makeRow('already',{title:'이미 읽는 모임 책',linkedBookId:'emotion',currentPage:70,totalPages:240})]);h.setCatalog([{title:'이미 읽는 모임 책',authors:['저자'],linkedBookId:'emotion',themes:['emotion'],status:'unread',source:'growell',pageCount:240}]);const dialog=await openAdd(h);await submitSearch(dialog,'모임');await dialog.querySelector('[data-search-result="0"]').click();assert.equal(dialog.querySelector('#archive-form'),null);assert.match(dialog.querySelector('.archive-reading-summary').textContent,/70 \/ 240쪽/);assert.equal(h.saved.length,0);assert.match(h.toasts.at(-1),/이미 책장/);await dialog.querySelector('[data-archive-edit]').click();const form=dialog.querySelector('#archive-form');form.elements.review.value='이전 기록에 감상 추가';await form.onsubmit({preventDefault(){}});assert.equal(h.saved[0].row.entry.id,Domain.recordId('owner','arc_already'));assert.equal(h.rows().length,1);
});

test('opening an existing meeting book does not discard a personal registration draft after cancellation',async()=>{
  const h=harness([makeRow('already',{title:'이미 읽는 모임 책',linkedBookId:'emotion'})]);h.setCatalog([{title:'이미 읽는 모임 책',authors:['저자'],linkedBookId:'emotion',themes:['emotion'],source:'growell'}]);const dialog=await openAdd(h),form=dialog.querySelector('#archive-form');form.elements.review.value='아직 저장하지 않은 생각';form.events.input();let confirmations=0;h.c.confirm=()=>{confirmations++;return false;};await submitSearch(dialog,'모임');await dialog.querySelector('[data-search-result="0"]').click();assert.equal(confirmations,1);assert.equal(dialog.querySelector('#archive-form'),form);assert.equal(form.elements.review.value,'아직 저장하지 않은 생각');assert.equal(h.saved.length,0);
});

test('note carousel advances exactly one card with arrows and keyboard without changing the page',async()=>{
  const h=harness([makeRow('carousel',{notes:[{id:'one',text:'첫 노트',createdAt:1000},{id:'two',text:'두 번째 노트',createdAt:2000},{id:'three',text:'세 번째 노트',createdAt:3000}]})]);await h.mount();const carousel=h.body.querySelector('[data-note-carousel]'),track=carousel.querySelector('[data-carousel-track]');track.clientWidth=360;track.scrollLeft=0;track.scrollTo=options=>{track.scrollLeft=options.left;track.events.scroll();};const prev=carousel.querySelector('[data-carousel-prev]'),next=carousel.querySelector('[data-carousel-next]');assert.equal(prev.disabled,true);await next.click();assert.equal(track.scrollLeft,360);assert.equal(carousel.querySelector('[data-carousel-count]').textContent,'2 / 3');track.events.keydown({target:track,key:'ArrowRight',preventDefault(){}});assert.equal(track.scrollLeft,720);assert.equal(next.disabled,true);await prev.click();assert.equal(track.scrollLeft,360);assert.equal(h.history.length,0);assert.equal(h.saved.length,0);
});

test('all notes collection offers cover-title book search and genre filtering, then Back returns to the shelf',async()=>{
  const h=harness([makeRow('one',{title:'첫 번째 책',genres:['인문'],notes:[{id:'one',text:'첫 책의 기록',createdAt:1000}]}),makeRow('two',{title:'두 번째 책',genres:['소설'],notes:[{id:'two',text:'두 번째 기록',createdAt:2000}]})]);await h.mount();const trigger=h.body.querySelector('[data-archive-notes-all]');await trigger.click();let collection=h.body.querySelector('.archive-collection-dialog');assert.equal(collection.querySelectorAll('[data-collection-book]').length,2);assert.equal(collection.querySelectorAll('select').length,0);assert.equal(collection.querySelectorAll('.archive-note-book-grid .archive-cover').length,2);assert.equal(collection.querySelectorAll('[data-archive-read-note]').length,2);
  let input=collection.querySelector('[data-collection-search]');input.value='첫 번째';input.oninput();assert.equal(collection.querySelectorAll('[data-collection-book]').length,1);assert.match(collection.querySelector('.archive-collection-list').textContent,/첫 책의 기록/);assert.doesNotMatch(collection.querySelector('.archive-collection-list').textContent,/두 번째 기록/);await collection.querySelector('[data-collection-reset]').click();await collection.querySelector('[data-collection-genre="소설"]').click();assert.equal(collection.querySelectorAll('[data-collection-book]').length,1);assert.match(collection.querySelector('.archive-collection-list').textContent,/두 번째 기록/);
  await collection.querySelector('[data-archive-read-note]').click();assert.ok(h.body.querySelector('.archive-note-dialog'));h.history.filter(item=>item.key==='archive-note').at(-1).options.close();assert.ok(h.body.querySelector('.archive-collection-dialog'));h.history.filter(item=>item.key==='archive-notes').at(-1).options.close();assert.equal(h.body.querySelector('.archive-collection-dialog'),null);assert.ok(h.body.querySelector('.archive-note-shelf'));assert.equal(trigger.focused,true);assert.equal(h.saved.length,0);
});

test('emotion reflection hides the original meeting book only, preserving the archive and other emotion notes',async()=>{
  const h=harness([makeRow('original',{title:'감정을 마주하면 길이 보인다',linkedBookId:'emotion',genres:['인문'],themes:['emotion'],notes:[{id:'original',text:'원래 책에 쓴 기록',createdAt:1000}]}),makeRow('other',{title:'다른 감정 책',genres:['인문'],themes:['emotion'],notes:[{id:'other',text:'다른 책에서 찾은 생각',createdAt:2000}]})]);await h.mount();const reflection=h.api.reflectionHtml('emotion');assert.doesNotMatch(reflection,/감정을 마주하면 길이 보인다|원래 책에 쓴 기록/);assert.match(reflection,/다른 책에서 찾은 생각/);assert.match(reflection,/data-note-carousel/);assert.match(h.body.querySelector('.archive-note-shelf').textContent,/원래 책에 쓴 기록/);assert.equal(h.body.querySelectorAll('[data-archive-open]').length,2);assert.equal(h.saved.length,0);
});

test('reading history is an icon popup whose Back leaves the existing book details open',async()=>{
  const original=makeRow('history',{readingSessions:[{id:'read',seconds:80,startPage:20,endPage:30,createdAt:1000}]});const h=harness([original]),detail=await h.open('history');assert.equal(detail.querySelector('details.archive-sessions'),null);assert.ok(detail.querySelector('[data-archive-timer]'));assert.ok(detail.querySelector('[data-archive-edit-icon]'));const trigger=detail.querySelector('[data-archive-history]');await trigger.click();const popup=h.body.querySelector('.archive-sessions-dialog');assert.match(popup.textContent,/읽은 기록|p. 20–30|10쪽 읽음|1분/);h.history.filter(item=>item.key==='archive-sessions').at(-1).options.close();assert.equal(h.body.querySelector('.archive-sessions-dialog'),null);assert.equal(detail.open,true);assert.equal(trigger.focused,true);assert.deepEqual(h.rows()[0].book.readingSessions,original.book.readingSessions);
});

test('archive composer saves page and background with the existing photo while preserving note identity',async()=>{
  const photo='https://example.com/note.jpg',original=makeRow('compose',{notes:[{id:'keep',title:'원래 제목',text:'본문',page:19,bgColor:'#E4EEE6',photo,createdAt:1000}]});const h=harness([original]);await h.mount();await h.body.querySelector('[data-archive-read-note]').click();let popup=h.body.querySelector('.archive-note-dialog');assert.equal(popup.querySelector('.archive-note-photo img').getAttribute('src'),photo);assert.match(popup.textContent,/p. 19/);await popup.querySelector('[data-note-edit]').click();const form=popup.querySelector('form');assert.equal(form.elements.notePage.value,'19');assert.ok(form.elements.notePhoto);assert.equal(form.querySelectorAll('[data-note-background]').length,7);form.elements.notePage.value='25';await form.querySelectorAll('[data-note-background]').find(button=>button.dataset.noteBackground==='#F3E1E6').click();form.elements.text.value='바꾼 본문';await form.onsubmit({preventDefault(){}});const note=h.rows()[0].book.notes[0];assert.equal(note.page,25);assert.equal(note.bgColor,'#F3E1E6');assert.equal(note.photo,photo);assert.equal(note.id,'keep');assert.equal(note.createdAt,1000);
});

test('closing and saving a note preserve collection scrolling, filters and stable note focus',async()=>{
  const h=harness([makeRow('scroll',{genres:['인문'],notes:[{id:'scroll_note',text:'아래쪽 노트',createdAt:1000}]})]);await h.mount();await h.body.querySelector('[data-archive-notes-all]').click();const collection=h.body.querySelector('.archive-collection-dialog');await collection.querySelector('[data-collection-genre="인문"]').click();await collection.querySelector('[data-collection-book]').click();
  function scrollPosition(){collection.scrollTop=620;collection.querySelector('.archive-dialog-body').scrollTop=340;collection.querySelector('.archive-note-book-grid').scrollTop=75;}
  function assertPosition(){assert.equal(collection.scrollTop,620);assert.equal(collection.querySelector('.archive-dialog-body').scrollTop,340);assert.equal(collection.querySelector('.archive-note-book-grid').scrollTop,75);assert.equal(collection.querySelector('[data-collection-genre="인문"]').getAttribute('aria-pressed'),'true');assert.equal(collection.querySelector('[data-collection-book]').getAttribute('aria-pressed'),'true');assert.equal(collection.querySelector('[data-archive-read-note]').focused,true);}
  scrollPosition();await collection.querySelector('[data-archive-read-note]').click();h.history.filter(item=>item.key==='archive-note').at(-1).options.close();assertPosition();
  scrollPosition();await collection.querySelector('[data-archive-read-note]').click();const note=h.body.querySelector('.archive-note-dialog');await note.querySelector('[data-note-edit]').click();const form=note.querySelector('form');form.elements.text.value='스크롤 아래에서 수정한 노트';await form.onsubmit({preventDefault(){}});assertPosition();assert.match(collection.querySelector('.archive-collection-list').textContent,/스크롤 아래에서 수정한 노트/);
});

test('note popup return preserves the current carousel card after close and save, with filter and owner resets',async()=>{
  const h=harness([makeRow('slides',{genres:['인문'],notes:[{id:'oldest',text:'오래된 노트',createdAt:1000},{id:'middle',text:'두 번째 노트',createdAt:2000},{id:'latest',text:'새 노트',createdAt:3000}]})]);await h.mount();
  function repaint(){h.body.innerHTML=h.api.html();h.body.querySelectorAll('[data-carousel-track]').forEach(track=>{track.clientWidth=360;});h.api.bind();}
  h.adapter.render=repaint;repaint();let carousel=h.body.querySelector('[data-note-carousel="shelf"]'),track=carousel.querySelector('[data-carousel-track]');track.scrollLeft=360;track.events.scroll();await carousel.querySelector('[data-archive-read-note="middle"]').click();h.history.filter(item=>item.key==='archive-note').at(-1).options.close();carousel=h.body.querySelector('[data-note-carousel="shelf"]');assert.equal(carousel.querySelector('[data-carousel-count]').textContent,'2 / 3');assert.equal(carousel.querySelector('[data-carousel-track]').scrollLeft,360);
  await carousel.querySelector('[data-archive-read-note="middle"]').click();let note=h.body.querySelector('.archive-note-dialog');await note.querySelector('[data-note-edit]').click();let form=note.querySelector('form');form.elements.text.value='두 번째 노트를 수정';await form.onsubmit({preventDefault(){}});await flush();carousel=h.body.querySelector('[data-note-carousel="shelf"]');assert.equal(carousel.querySelector('[data-carousel-count]').textContent,'2 / 3');assert.equal(carousel.querySelector('[data-carousel-track]').scrollLeft,360);assert.match(carousel.textContent,/두 번째 노트를 수정/);
  await h.body.querySelector('[data-note-filter="인문"]').click();assert.equal(h.body.querySelector('[data-carousel-count]').textContent,'1 / 3');
  h.setSession({userId:'other'});h.setRows([makeRow('other',{notes:[{id:'first',text:'다른 계정 첫째',createdAt:1000},{id:'second',text:'다른 계정 둘째',createdAt:2000}]},'other')]);await h.mount();assert.equal(h.body.querySelector('[data-carousel-count]').textContent,'1 / 2');
});
