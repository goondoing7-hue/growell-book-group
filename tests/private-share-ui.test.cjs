'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Share=require('../privateShare.js');
const fixture=fs.readFileSync(path.join(__dirname,'book-photo-ocr.test.cjs'),'utf8'),start=fixture.indexOf('class Node{'),end=fixture.indexOf('\nfunction harness(',start),scope={};
vm.runInNewContext(fixture.slice(start,end)+'\nthis.Node=Node;',scope);const Node=scope.Node;
Node.prototype.querySelectorAll=function(selector){const result=[];function match(node){if(selector[0]==='['){const pair=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);return pair&&Object.hasOwn(node.attrs,pair[1])&&(pair[2]===undefined||node.attrs[pair[1]]===pair[2]);}if(selector[0]==='.')return node.className.split(/\s+/).includes(selector.slice(1));return node.tagName===selector.toUpperCase();}function walk(node){for(const child of node.children){if(match(child))result.push(child);walk(child);}}walk(this);return result;};
Node.prototype.closest=function(selector){for(let node=this;node;node=node.parentNode){if(selector==='[data-private-share]'&&node.getAttribute('data-private-share')!==null)return node;}return null;};
const inner=Object.getOwnPropertyDescriptor(Node.prototype,'innerHTML');Object.defineProperty(Node.prototype,'innerHTML',{set:inner.set,get(){return this._text+this.children.map(child=>'<'+child.tagName.toLowerCase()+Object.entries(child.attrs).map(([k,v])=>' '+k+'="'+v+'"').join('')+'>'+child.innerHTML+'</'+child.tagName.toLowerCase()+'>').join('');}});
const clone=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
function harness(options={}){
  const body=new Node('body'),trigger=new Node('button'),source={owner:'test-owner',entry:'private-secret-id',key:'private-secret-key',cipher:'private-secret-cipher'};body.appendChild(trigger);
  const fields={title:'원문 제목',html:'<p>원래 <b>서식</b></p>',text:'원래 서식',noteType:'quote',page:18,photo:{dataUrl:'data:image/png;base64,eA==',name:'원본 사진.png'},bgColor:'#fff4db',fontSize:'large',extra:{preserve:'원래 속성'}};
  const original=clone(fields),events={},documentEvents={},timers=new Map(),history=[],calls=[],publications=new Map();let timerSerial=0,permission=true,draft=options.draft?clone(options.draft):null,done=0,cleaned=0,operations=0;
  const document={body,activeElement:trigger,createElement:tag=>new Node(tag),addEventListener(name,fn){(documentEvents[name]||=[]).push(fn);},removeEventListener(name,fn){documentEvents[name]=(documentEvents[name]||[]).filter(item=>item!==fn);}};
  const browser={document,location:{href:'https://example.test/#/book/emotion/mine'},addEventListener(name,fn){(events[name]||=[]).push(fn);},removeEventListener(name,fn){events[name]=(events[name]||[]).filter(item=>item!==fn);},GrowellPopupHistory:{open:(key,value)=>history.push({key,value}),closed:key=>history.push({closed:key})}};
  const api=Share.create({browser,document,setTimeout(fn){const id=++timerSerial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}});
  api.configure({
    load:async id=>{calls.push({type:'load',id});return options.load?options.load(id):{source,fields:clone(fields),notice:options.notice};},current:value=>permission&&value===source,draftCurrent:options.allowRouteDraft?value=>permission&&value===source:undefined,
    newOperation:()=>({postId:'public-'+(++operations),createdAt:1700000000000+operations}),
    readDraft:async()=>{calls.push({type:'read'});return options.readDraft?options.readDraft():clone(draft);},
    writeDraft:async(s,value)=>{assert.equal(s,source);calls.push({type:'write',value:clone(value)});if(options.writeDraft)await options.writeDraft(value,calls.filter(c=>c.type==='write').length);draft=clone(value);},
    publish:async(s,value,operation)=>{assert.equal(s,source);calls.push({type:'publish',fields:clone(value),operation:clone(operation)});if(options.publish)return options.publish(value,operation,publications);if(!publications.has(operation.postId))publications.set(operation.postId,clone(value));return {postId:operation.postId};},
    clearDraft:async(s,value)=>{assert.equal(s,source);calls.push({type:'clear',value:clone(value)});if(options.clearDraft)await options.clearDraft(value);draft=null;},
    toolbarHtml:()=>'<div class="rt-controls"><button type="button" data-test-format>굵게</button></div>',bindEditor:()=>()=>{cleaned++;},
    sanitizeHtml:html=>String(html).replace(/<script>[\s\S]*?<\/script>/g,''),plainText:html=>String(html).replace(/<[^>]*>/g,''),validateFields:options.validateFields,
    previewHtml:value=>options.previewHtml?options.previewHtml(value):(value.title?'<h3>'+value.title+'</h3>':'')+(value.photo?'<img src="data:image/png;base64,eA==">':'')+(value.html||''),
    toast:(message,error)=>calls.push({type:'toast',message,error}),done:()=>{done++;}
  });
  const q=key=>body.querySelector('[data-ps-'+key+']');
  return {api,source,fields,original,body,trigger,browser,document,history,calls,publications,q,timers,async open(){assert.equal(await api.open('test-entry',trigger),true);return body.querySelector('dialog');},current(value){permission=value;},get draft(){return clone(draft);},get done(){return done;},get cleaned(){return cleaned;},get operations(){return operations;},emit(name){for(const fn of [...events[name]||[]])fn({});},clickTarget(target){for(const fn of [...documentEvents.click||[]])fn({target,preventDefault(){},stopPropagation(){}});}};
}

test('one selected private note opens as a safe confirmation without changing or writing its original',async()=>{
  const h=harness({notice:'현재 분류를 책 속 문장으로 나눠요.'}),node=await h.open();
  assert.match(node.textContent,/나눔에 올리면 모임원이 볼 수 있어요/);assert.match(node.textContent,/수정하고 나누기/);assert.match(node.textContent,/그대로 나누기/);
  assert.match(node.textContent,/나누기 전에 글을 수정할까요\?/);
  assert.match(node.textContent,/현재 분류/);assert.doesNotMatch(node.innerHTML,/private-secret/);assert.deepEqual(h.fields,h.original);assert.equal(h.calls.filter(c=>c.type==='write'||c.type==='publish').length,0);
  h.q('cancel').click();assert.equal(node.isConnected,false);assert.equal(h.trigger.focused,true);assert.deepEqual(h.fields,h.original);
});

test('unchanged sharing first durably freezes the exact operation and blocks duplicate clicks',async()=>{
  const durable=deferred(),remote=deferred(),h=harness({writeDraft:()=>durable.promise,publish:()=>remote.promise});await h.open();h.q('publish').click();h.q('publish').click();await flush();
  assert.equal(h.calls.filter(c=>c.type==='publish').length,0);const saved=h.calls.find(c=>c.type==='write').value;
  assert.equal(h.q('close').disabled,true);assert.equal(h.q('cancel').disabled,true);assert.equal(h.history.find(c=>c.key==='private-share').value.canClose(),false);h.q('cancel').click();assert.ok(h.body.querySelector('dialog'),'an in-flight publication cannot be mistaken for a cancellable remote write');
  assert.deepEqual(Object.keys(saved).sort(),['attempted','fields','operation','v']);assert.equal(saved.attempted,true);assert.deepEqual(saved.fields,h.original);
  durable.resolve();await flush();assert.equal(h.calls.filter(c=>c.type==='publish').length,1);remote.resolve({postId:saved.operation.postId});await flush();
  assert.equal(h.body.querySelector('dialog'),null);assert.equal(h.done,1);assert.equal(h.draft,null);assert.deepEqual(h.fields,h.original);
});

test('editing changes only the separate copy and preserves attachments, formatting, style and extra fields',async()=>{
  const h=harness();await h.open();h.q('edit').click();h.q('title').value='나눔 제목';h.q('title').dispatchEvent({type:'input'});h.q('page').value='21';h.q('page').dispatchEvent({type:'input'});h.q('category').value='question';h.q('category').dispatchEvent({type:'change'});h.q('editor').innerHTML='<p>수정한 <b>문장</b></p><script>bad()</script>';h.q('editor').dispatchEvent({type:'input'});await flush();
  const saved=h.draft.fields;assert.equal(saved.title,'나눔 제목');assert.equal(saved.page,'21');assert.equal(saved.noteType,'question');assert.equal(saved.html,'<p>수정한 <b>문장</b></p>');assert.deepEqual(saved.photo,h.original.photo);assert.equal(saved.bgColor,h.original.bgColor);assert.equal(saved.fontSize,h.original.fontSize);assert.deepEqual(saved.extra,h.original.extra);assert.deepEqual(h.fields,h.original);
  h.q('publish').click();await flush();assert.equal(h.done,1);assert.deepEqual(h.calls.find(c=>c.type==='publish').fields,saved);assert.equal(h.cleaned,1);
});

test('rapid inputs are serialized durably and closing retains the final editable draft',async()=>{
  const first=deferred(),h=harness({writeDraft:(value,index)=>index===1?first.promise:Promise.resolve()});const node=await h.open();h.q('edit').click();
  h.q('title').value='첫 입력';h.q('title').dispatchEvent({type:'input'});h.q('title').value='마지막 입력';h.q('title').dispatchEvent({type:'input'});await flush();assert.equal(h.calls.filter(c=>c.type==='write').length,1);
  h.q('close').click();assert.equal(node.isConnected,false);first.resolve();await flush();assert.equal(h.draft.fields.title,'마지막 입력');assert.equal(h.draft.attempted,false);
  await h.open();assert.match(h.q('status').textContent,/이전에 준비하던 나눔글/);h.q('edit').click();assert.equal(h.q('title').value,'마지막 입력');h.api.reset();assert.deepEqual(h.fields,h.original);
});

test('queued inputs finish after route departure for the same identity while account changes fence remaining writes',async()=>{
  for(const changedOwner of [false,true]){const first=deferred(),h=harness({allowRouteDraft:true,writeDraft:(value,index)=>index===1?first.promise:Promise.resolve()}),node=await h.open();h.q('edit').click();h.q('title').value='첫 입력';h.q('title').dispatchEvent({type:'input'});h.q('title').value='화면을 떠나기 전 마지막 입력';h.q('title').dispatchEvent({type:'input'});await flush();assert.equal(h.calls.filter(c=>c.type==='write').length,1);
    h.browser.location.href='https://example.test/#/home';h.emit('hashchange');assert.equal(node.isConnected,false);if(changedOwner)h.current(false);first.resolve();await flush();
    assert.equal(h.calls.filter(c=>c.type==='write').length,changedOwner?1:2);if(!changedOwner)assert.equal(h.draft.fields.title,'화면을 떠나기 전 마지막 입력');assert.equal(h.calls.filter(c=>c.type==='publish').length,0);
  }
});

test('a restored editable draft receives the actual publication time only at its first attempt',async()=>{
  const old={v:1,fields:{title:'오래 전에 준비한 제목',html:'<p>보관한 글</p>',noteType:'quote',page:18},operation:{postId:'old-preparation',createdAt:100},attempted:false},h=harness({draft:old});await h.open();h.q('edit').click();h.q('publish').click();await flush();const call=h.calls.find(c=>c.type==='publish');assert.notEqual(call.operation.postId,old.operation.postId);assert.ok(call.operation.createdAt>old.operation.createdAt);assert.equal(call.fields.page,18,'an unchanged page keeps its existing type');assert.equal(call.fields.title,old.fields.title);assert.equal(h.done,1);
});

test('validation precedes freezing so an empty intermediate draft stays editable and can be corrected',async()=>{
  const h=harness({validateFields:fields=>{if(!String(fields.html||'').replace(/<[^>]*>/g,'').trim()&&!fields.photo)throw new Error('empty');return {...fields,page:fields.page===''?null:fields.page};}});await h.open();h.q('edit').click();h.q('editor').innerHTML='';h.q('editor').dispatchEvent({type:'input'});h.q('remove-photo').click();await flush();assert.equal(h.draft.fields.html,'');assert.equal(h.draft.fields.photo,null);assert.equal(h.draft.attempted,false);
  h.q('publish').click();await flush();assert.equal(h.draft.attempted,false);assert.equal(h.calls.filter(c=>c.type==='publish').length,0);assert.ok(h.q('editor'));assert.equal(h.q('editor').getAttribute('contenteditable'),'true');assert.equal(h.q('title').disabled,false);assert.equal(h.q('close').disabled,false);assert.match(h.q('status').textContent,/글이나 사진/);
  h.q('editor').innerHTML='<p>다시 쓴 나눔</p>';h.q('editor').dispatchEvent({type:'input'});h.q('page').value='';h.q('publish').click();await flush();assert.equal(h.done,1);assert.equal(h.calls.find(c=>c.type==='publish').fields.page,null);assert.deepEqual(h.fields,h.original);
});

test('a lost publication response retries identical fields and operation after reopening without a second insertion',async()=>{
  let attempts=0;const h=harness({publish:async(fields,operation,posts)=>{if(!posts.has(operation.postId))posts.set(operation.postId,clone(fields));if(++attempts===1)throw new Error('response-lost');return {postId:operation.postId};}});
  await h.open();h.q('publish').click();await flush();assert.equal(h.publications.size,1);assert.equal(h.q('edit'),null);assert.match(h.q('publish').textContent,/다시 확인하고 나누기/);const attempted=h.draft;
  h.q('close').click();await h.open();assert.equal(h.q('edit'),null);h.q('publish').click();await flush();const calls=h.calls.filter(c=>c.type==='publish');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(h.publications.size,1);assert.equal(h.operations,2);assert.equal(h.done,1);assert.equal(attempted.attempted,true);
});

test('failed durable preparation cannot publish and successful cleanup failure cannot re-publish',async()=>{
  let writes=0;const h=harness({writeDraft:async()=>{if(++writes===1)throw new Error('quota');},clearDraft:async()=>{throw new Error('cleanup');}});await h.open();h.q('publish').click();await flush();assert.equal(h.calls.filter(c=>c.type==='publish').length,0);assert.match(h.q('status').textContent,/임시 저장하지 못/);h.q('publish').click();await flush();assert.equal(h.calls.filter(c=>c.type==='publish').length,1);assert.equal(h.done,1);assert.equal(h.body.querySelector('dialog'),null);assert.equal(h.draft.attempted,true);
});

test('photo deletion affects only the sharing copy and retains the original attachment',async()=>{
  const h=harness();await h.open();h.q('edit').click();assert.ok(h.q('remove-photo'));h.q('remove-photo').click();await flush();assert.equal(h.draft.fields.photo,null);assert.deepEqual(h.fields.photo,h.original.photo);h.q('publish').click();await flush();assert.equal(h.calls.find(c=>c.type==='publish').fields.photo,null);
});

test('phone Back and Escape close this popup and restore focus while retaining its draft',async()=>{
  for(const mode of ['back','escape']){const h=harness(),node=await h.open();h.q('edit').click();h.q('title').value='보관할 나눔 초안';h.q('title').dispatchEvent({type:'input'});if(mode==='back')h.history.find(c=>c.key==='private-share').value.close();else node.dispatchEvent({type:'cancel',preventDefault(){}});await flush();assert.equal(node.isConnected,false);assert.equal(h.trigger.focused,true);assert.equal(h.draft.fields.title,'보관할 나눔 초안');assert.equal(h.calls.filter(c=>c.type==='publish').length,0);assert.ok(h.history.some(c=>c.closed==='private-share'));}
});

test('late loads, draft loads and publication results cannot cross owner, route or reset boundaries',async()=>{
  const load=deferred(),h=harness({load:()=>load.promise}),opening=h.api.open('test-entry',h.trigger);await flush();h.browser.location.href='https://example.test/#/home';load.resolve({source:h.source,fields:h.fields});assert.equal(await opening,false);assert.equal(h.body.querySelector('dialog'),null);
  const draft=deferred(),second=harness({readDraft:()=>draft.promise}),secondOpen=second.api.open('test-entry',second.trigger);await flush();second.api.reset();draft.resolve(null);assert.equal(await secondOpen,false);assert.equal(second.body.querySelector('dialog'),null);
  const remote=deferred(),third=harness({publish:()=>remote.promise});await third.open();third.q('publish').click();await flush();third.current(false);remote.resolve({postId:third.draft.operation.postId});await flush();assert.equal(third.done,0);assert.equal(third.calls.filter(c=>c.type==='clear').length,0);third.api.reset();assert.equal(third.body.querySelector('dialog'),null);
});

test('only one delegated share handler opens the chosen note and reset retires its UI',async()=>{
  const h=harness();h.trigger.setAttribute('data-private-share','selected-note');h.api.bind();h.api.bind();h.clickTarget(h.trigger);await flush();assert.equal(h.calls.filter(c=>c.type==='load').length,1);assert.equal(h.calls.find(c=>c.type==='load').id,'selected-note');assert.ok(h.body.querySelector('dialog'));h.api.reset();assert.equal(h.body.querySelector('dialog'),null);
});

test('invalid drafts or renderer failures leave no connected dialog or public write',async()=>{
  for(const options of [{draft:{v:2,fields:{},operation:{postId:'wrong',createdAt:1},attempted:false}},{previewHtml:()=>{throw new Error('render failed');}}]){const h=harness(options);assert.equal(await h.api.open('test-entry',h.trigger),false);assert.equal(h.body.querySelector('dialog'),null);assert.equal(h.calls.filter(c=>c.type==='publish'||c.type==='write').length,0);assert.deepEqual(h.fields,h.original);}
});
