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
  let session={userId:'owner'},rows=clone(initialRows),failure=null,serial=0,loadStatus='ready',customRead=null;
  const doc={body,createElement:tag=>new Node(tag),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),getElementById:id=>body.querySelector('#'+id)};
  const c={URL,Date,Promise,Set,AbortController,FormData:FormDataFixture,document:doc,GrowellArchiveDomain:Domain,
    crypto:{randomUUID:()=> 'fixture-'+(++serial)},confirm:()=>true,
    GrowellPopupHistory:{open:(key,options)=>history.push({key,options}),closed:key=>history.push({closed:key})},
    addEventListener:(name,fn)=>{events[name]=fn;},
    GrowellArchiveTimer:{html:()=>'',bind(){},reset(){},hasDraft:()=>false,open:options=>timers.push(options)}};
  c.window=c;vm.createContext(c);vm.runInContext(source,c);
  const api=c.GrowellArchive;
  const adapter={session:()=>session,status:()=>loadStatus,statusHtml:()=>'<p>loading status</p>',entries:()=>rows.map(r=>r.entry),
    read:async entries=>{reads.push(entries);return customRead?customRead(entries):rows.filter(r=>entries.some(e=>e.id===r.entry.id)).map(clone);},
    render(){},toast:message=>toasts.push(message),reload(){},catalog:()=>[],
    save:async(row,book,createId)=>{
      const normalized=Domain.prepare(book);saved.push({row:clone(row),book:normalized,createId});
      if(failure)throw failure;
      const entry=row?{...row.entry,data:row.entry.data+'x',updatedAt:Date.now()}:{id:Domain.recordId(session.userId,createId),bookId:Domain.STORAGE_BOOK_ID,userId:session.userId,createdAt:Date.now(),data:'new'};
      const result={entry,book:normalized};rows=rows.filter(r=>r.entry.id!==entry.id).concat([result]);return clone(result);
    }};
  api.configure(adapter);
  return {api,c,doc,body,events,toasts,saved,history,reads,timers,rows:()=>rows,
    setFailure:value=>{failure=value;},setSession:value=>{session=value;},setStatus:value=>{loadStatus=value;},setRead:value=>{customRead=value;},
    setRows:value=>{rows=clone(value);},
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
  assert.match(markup,/10 → 50쪽 읽음/);assert.match(markup,/나의 감상/);
  assert.doesNotMatch(markup,/삭제한 문장|휴지통 감상|다른 회원 비밀|54321|15시간|총 읽은 시간|archive-time|archive-sessions/);
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
