'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const OCR=require('../bookPhotoOcr.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
class Node{
  constructor(tag='div',attributes={}){this.tagName=tag.toUpperCase();this.attrs={...attributes};this.children=[];this.parentNode=null;this.events={};this.disabled=false;this.hidden=false;this.open=false;this.value='';this._text='';this.clickCount=0;}
  get isConnected(){return this.tagName==='BODY'||!!this.parentNode&&this.parentNode.isConnected;}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='hidden')this.hidden=true;if(key==='disabled')this.disabled=true;}
  getAttribute(key){return this.attrs[key]??null;}
  get className(){return this.attrs.class||'';}set className(value){this.attrs.class=value;}
  get classList(){return {toggle:(name,enabled)=>{const names=new Set(this.className.split(/\s+/).filter(Boolean));if(enabled)names.add(name);else names.delete(name);this.className=[...names].join(' ');}};}
  appendChild(node){if(node.tagName==='#FRAGMENT'){for(const child of [...node.children])this.appendChild(child);return node;}if(node.parentNode)node.remove();this.children.push(node);node.parentNode=this;return node;}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}}
  set textContent(value){for(const child of this.children)child.parentNode=null;this.children=[];this._text=String(value);}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){this.textContent='';const stack=[this];for(const token of String(value).matchAll(/<\/?[^>]+>|[^<]+/g)){const text=token[0];if(text.startsWith('</')){stack.pop();continue;}if(text.startsWith('<')){const tag=/^<([\w-]+)/.exec(text);if(!tag)continue;const node=new Node(tag[1]);for(const match of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){if(match.index<=tag[1].length)continue;node.setAttribute(match[1],match[2]??'');}stack[stack.length-1].appendChild(node);if(!['INPUT','BR','IMG','HR'].includes(node.tagName)&&!text.endsWith('/>'))stack.push(node);}else stack[stack.length-1]._text+=text;}}
  get innerHTML(){return this._text+this.children.map(child=>'<'+child.tagName.toLowerCase()+'>'+child.innerHTML+'</'+child.tagName.toLowerCase()+'>').join('');}
  addEventListener(type,callback){(this.events[type]||(this.events[type]=[])).push(callback);}
  removeEventListener(type,callback){this.events[type]=(this.events[type]||[]).filter(item=>item!==callback);}
  dispatchEvent(event){for(const callback of [...this.events[event.type]||[]])callback(event);return true;}
  click(){this.clickCount++;if(!this.disabled)this.dispatchEvent({type:'click'});}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatchEvent({type:'close'});}
  querySelectorAll(selector){const nodes=[];function match(node){if(selector.startsWith('['))return Object.hasOwn(node.attrs,selector.slice(1,-1));if(selector.startsWith('#'))return node.attrs.id===selector.slice(1);return node.tagName===selector.toUpperCase();}function walk(node){for(const child of node.children){if(match(child))nodes.push(child);walk(child);}}walk(this);return nodes;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function harness(options={}){
  const body=new Node('body'),composer=new Node('div'),editor=new Node('div'),button=new Node('button');body.appendChild(composer);composer.appendChild(editor);composer.appendChild(button);
  const original=new Node('p');original.textContent='보존할 기존 문장';original.setAttribute('data-original','yes');editor.appendChild(original);
  const document={body,head:new Node('head'),createElement:tag=>new Node(tag),createDocumentFragment:()=>new Node('#fragment')};body.appendChild(document.head);
  const history=[],calls=[],timers=new Map();let serial=0,released=0,terminated=0,appended=0,current=true;
  const browser={document,Event:class{constructor(type,options){this.type=type;this.bubbles=options&&options.bubbles;}},GrowellPhotoSources:options.photoSources,GrowellPopupHistory:{open:(key,value)=>history.push({key,value}),closed:key=>history.push({closed:key})},addEventListener(){},removeEventListener(){}};
  const worker=options.worker||{recognize:async image=>{calls.push({image});return {data:{text:'인식한 첫 문장\n둘째 문장'}};},terminate:async()=>{terminated++;}};
  const engine={createWorker:async(...args)=>{calls.push({create:args});return options.createWorker?options.createWorker(...args):worker;}};
  const api=OCR.create({browser,document,setTimeout:(callback,delay)=>{const id=++serial;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    editPhoto:options.editPhoto,prepareImage:options.prepareImage||(async file=>({image:{synthetic:true,size:file.size},release(){released++;}})),loadEngine:options.loadEngine||(async()=>engine)});
  const context={owner:'synthetic-owner',draft:'synthetic-draft'},config={button,editor,composer,getContext:()=>context,isCurrent:value=>value===context&&current,onAppend:()=>{appended++;}};
  const state=api.open(config);
  return {api,state,config,body,editor,original,button,calls,history,timers,worker,setCurrent:value=>{current=value;},get released(){return released;},get terminated(){return terminated;},get appended(){return appended;}};
}
const file=(changes={})=>({type:'image/jpeg',size:2048,...changes});
async function choose(h,input='gallery',image=file()){h.state[input].files=[image];h.state[input].dispatchEvent({type:'change'});await flush();}

test('image bounds reject unsupported or oversized files and resize the long edge without enlarging photos',()=>{
  assert.equal(OCR.validateFile(file()).size,2048);for(const image of [file({type:'text/html'}),file({size:0}),file({size:OCR.MAX_BYTES+1}),null])assert.throws(()=>OCR.validateFile(image));
  assert.deepEqual(OCR.imageSize(4400,3300),{width:2200,height:1650});assert.deepEqual(OCR.imageSize(800,1200),{width:800,height:1200});assert.throws(()=>OCR.imageSize(100000,100000));
});
test('camera and gallery are separate user inputs; all OCR assets and worker options remain same-origin',async()=>{
  const h=harness();assert.equal(h.state.camera.getAttribute('capture'),'environment');assert.equal(h.state.gallery.getAttribute('capture'),null);
  h.state.cameraButton.click();h.state.galleryButton.click();assert.equal(h.state.camera.clickCount,1);assert.equal(h.state.gallery.clickCount,1);
  await choose(h);const request=h.calls.find(call=>call.create).create;assert.deepEqual(request[0],['kor','eng']);assert.equal(request[1],1);
  for(const key of ['workerPath','corePath','langPath'])assert.match(request[2][key],/^\/vendor\/tesseract\//);assert.equal(request[2].workerBlobURL,false);assert.equal(request[2].legacyCore,false);
  assert.equal(h.editor.textContent,'보존할 기존 문장');assert.equal(h.state.review.hidden,false);assert.equal(h.released,1);assert.equal(h.terminated,1);h.api.close();
});
test('recognition is only a preview; edited text appends safely without replacing original nodes or executing HTML',async()=>{
  const h=harness();let inputEvents=0;h.editor.addEventListener('input',()=>inputEvents++);await choose(h);
  assert.equal(h.editor.children[0],h.original);assert.equal(h.appended,0);
  h.state.text.value='직접 고친 문장\n<img src=x onerror=alert(1)>\n<script>private()</script>';h.state.text.dispatchEvent({type:'input'});h.state.append.click();
  assert.equal(h.editor.children[0],h.original);assert.equal(h.original.getAttribute('data-original'),'yes');assert.equal(h.editor.children.length,4);
  assert.equal(h.editor.querySelectorAll('img').length,0);assert.equal(h.editor.querySelectorAll('script').length,0);assert.match(h.editor.textContent,/<img src=x onerror=alert\(1\)>/);
  assert.equal(h.appended,1);assert.equal(inputEvents,1);assert.equal(h.state.node.isConnected,false);assert.ok(h.history.some(item=>item.key==='book-photo-ocr'));assert.ok(h.history.some(item=>item.closed==='book-photo-ocr'));
});
test('oversized file, empty recognition and engine failures leave original text unchanged and allow retry',async()=>{
  let attempts=0;const h=harness({loadEngine:async()=>{if(++attempts===1)throw Object.assign(new Error('PRIVATE ENGINE ERROR'),{code:'engine-unavailable'});return {createWorker:async()=>({recognize:async()=>({data:{text:''}}),terminate:async()=>{}})};}});
  await choose(h,'gallery',file({size:OCR.MAX_BYTES+1}));assert.match(h.state.status.textContent,/20MB/);assert.equal(attempts,0);
  await choose(h);assert.match(h.state.status.textContent,/준비하지 못/);assert.equal(h.state.status.textContent.includes('PRIVATE'),false);
  await choose(h);assert.match(h.state.status.textContent,/글자를 찾지 못/);assert.equal(h.editor.children[0],h.original);assert.equal(h.state.append.disabled,true);h.api.close();
});
test('cancellation terminates recognition, clears resources and ignores the late text result',async()=>{
  const recognized=deferred();let terminated=0;const h=harness({worker:{recognize:()=>recognized.promise,terminate:async()=>{terminated++;}}});await choose(h);
  h.state.cancel.click();assert.equal(terminated,1);assert.equal(h.released,1);assert.equal(h.state.cameraButton.disabled,false);
  recognized.resolve({data:{text:'늦게 도착한 문장'}});await flush();assert.equal(h.state.text.value,'');assert.equal(h.state.review.hidden,true);assert.equal(h.editor.textContent,'보존할 기존 문장');h.api.close();
});
test('closing during initialization terminates a worker even when its handle arrives after the dialog closes',async()=>{
  const initialization=deferred();let terminated=0;const h=harness({createWorker:()=>initialization.promise});await choose(h);h.api.close();
  initialization.resolve({recognize:async()=>({data:{text:'다른 글에 들어가면 안 되는 문장'}}),terminate:async()=>{terminated++;}});await flush();assert.equal(terminated,1);assert.equal(h.released,1);assert.equal(h.appended,0);assert.equal(h.editor.children[0],h.original);
});
test('timeout stops a running worker and an identity change closes the nested popup without changing the draft',async()=>{
  const recognized=deferred();let terminated=0;const h=harness({worker:{recognize:()=>recognized.promise,terminate:async()=>{terminated++;}}});await choose(h);
  const timeout=[...h.timers.values()].find(timer=>timer.delay===180000);assert.ok(timeout);timeout.callback();assert.equal(terminated,1);assert.equal(h.released,1);assert.match(h.state.status.textContent,/오래 걸려 중지/);
  h.setCurrent(false);const identity=[...h.timers.values()].find(timer=>timer.delay===500);assert.ok(identity);identity.callback();assert.equal(h.state.node.isConnected,false);assert.equal(h.editor.children[0],h.original);
  recognized.resolve({data:{text:'도착하면 안 되는 결과'}});await flush();assert.equal(h.appended,0);
});
test('account, draft, route or detached-editor guards prevent both late results and reviewed text from being appended',async()=>{
  for(const detach of [false,true]){
    const recognized=deferred(),h=harness({worker:{recognize:()=>recognized.promise,terminate:async()=>{}}});await choose(h);
    if(detach)h.editor.remove();else h.setCurrent(false);recognized.resolve({data:{text:'보호해야 하는 이전 계정 문장'}});await flush();h.state.text.value='이전 결과';h.state.append.disabled=false;h.state.append.click();assert.equal(h.editor.children[0],h.original);assert.equal(h.appended,0);h.api.close();
  }
  const h=harness();await choose(h);h.setCurrent(false);h.state.append.click();assert.equal(h.appended,0);assert.equal(h.editor.textContent,'보존할 기존 문장');h.api.close();
});
test('popup Back callback and a replacement binding close only OCR and preserve the parent composer',async()=>{
  const h=harness();await choose(h);const popup=h.history.find(item=>item.key==='book-photo-ocr');popup.value.close();assert.equal(h.composer,undefined);assert.equal(h.config.composer.isConnected,true);assert.equal(h.editor.textContent,'보존할 기존 문장');
  const second=h.api.open(h.config);assert.ok(second);h.api.bind({});assert.equal(second.node.isConnected,false);assert.equal(h.config.composer.isConnected,true);
});
test('all three common body composers include OCR while insight-only fields do not gain an OCR or photo input',()=>{
  assert.match(html,/<script src="bookPhotoOcr\.js"><\/script>/);assert.match(html,/<link rel="stylesheet" href="bookPhotoOcr\.css">/);
  const start=html.indexOf('function noteComposerHtml('),end=html.indexOf('\nfunction ',start+20),composer=html.slice(start,end);
  assert.match(composer,/if\(opts\.insightMode\)[\s\S]*?insightFieldsHtml[\s\S]*?\} else \{[\s\S]*?btn-book-photo-ocr/);
  for(const id of ['share-composer','mine-composer','materials-composer'])assert.match(html,new RegExp("noteComposerHtml\\(book, \\{containerId:'"+id+"'"));
  assert.match(html,/SESSION===context\.session/);assert.match(html,/saveSessionEpoch===context\.epoch/);assert.match(html,/getAttribute\('data-draft-key'\)===context\.draftKey/);assert.match(html,/onAppend:function\(\)\{captureComposerDraft\(\);\}/);
});
test('the actual composer adapter binds OCR to the exact session, epoch, route, draft and original DOM nodes',()=>{
  const start=html.indexOf("  if(typeof GrowellBookPhotoOcr!=='undefined'){"),end=html.indexOf('  /* 나눔공간/나의공간 글 배경색 선택',start);assert.ok(start>=0&&end>start);
  function fixture(){
    let bound,captures=0;const attributes={'data-draft-key':'synthetic-draft','data-draft-user':'synthetic-owner'},composer={isConnected:true,getAttribute:name=>attributes[name]},editor={isConnected:true,closest:()=>composer};
    const state={SESSION:{userId:'synthetic-owner'},saveSessionEpoch:9,location:{hash:'#/book/emotion/mine'},noteEditor:editor,document:{getElementById:()=>({})},GrowellBookPhotoOcr:{bind(config){bound=config;}},captureComposerDraft(){captures++;}};
    vm.createContext(state);vm.runInContext(html.slice(start,end),state);return {state,attributes,composer,editor,get bound(){return bound;},get captures(){return captures;}};
  }
  for(const change of [h=>{h.state.SESSION={userId:'synthetic-owner'};},h=>{h.state.SESSION=null;},h=>{h.state.saveSessionEpoch++;},h=>{h.state.location.hash='#/book/emotion/share';},h=>{h.composer.isConnected=false;},h=>{h.editor.isConnected=false;},h=>{h.editor.closest=()=>({isConnected:true,getAttribute:h.composer.getAttribute});},h=>{h.attributes['data-draft-key']='different-draft';},h=>{h.attributes['data-draft-user']='different-owner';}]){
    const h=fixture(),context=h.bound.getContext();assert.equal(h.bound.isCurrent(context),true);assert.equal(h.captures,0);change(h);assert.equal(h.bound.isCurrent(context),false);assert.equal(h.captures,0);
  }
  const h=fixture();h.bound.onAppend();assert.equal(h.captures,1,'the accepted append checkpoints the original composer draft');
});
test('cancelling photo editing never starts OCR or changes the existing editor',async()=>{
  let editCalls=0;const h=harness({editPhoto:async()=>{editCalls++;return null;}});await choose(h);
  assert.equal(editCalls,1);assert.equal(h.calls.length,0);assert.equal(h.released,0);assert.equal(h.state.text.value,'');assert.equal(h.state.review.hidden,true);assert.equal(h.state.node.isConnected,false,'cancelling crop returns directly to the original composer');assert.equal(h.config.composer.isConnected,true);assert.equal(h.editor.children[0],h.original);assert.equal(h.appended,0);h.api.close();
});
test('only the explicitly accepted edited Blob reaches image preparation and the local recognition worker',async()=>{
  const original=file(),edited=new Blob(['edited-pixels'],{type:'image/jpeg'}),prepared=[],recognized=[];
  const h=harness({editPhoto:async (image,settings)=>{assert.equal(image,original);assert.equal(settings.cropOnly,true);assert.equal(settings.confirmLabel,'자르고 글자 인식');return edited;},prepareImage:async image=>{prepared.push(image);return {image,release(){}};},worker:{recognize:async image=>{recognized.push(image);return {data:{text:'편집 사진의 문장'}};},terminate:async()=>{}}});
  await choose(h,'gallery',original);assert.deepEqual(prepared,[edited]);assert.deepEqual(recognized,[edited]);assert.equal(h.state.text.value,'편집 사진의 문장');assert.equal(h.editor.textContent,'보존할 기존 문장');h.api.close();
});
test('photo editing time does not consume the 180-second OCR limit and a late edited result cannot cross an account guard',async()=>{
  const editing=deferred(),recognition=deferred();const h=harness({editPhoto:()=>editing.promise,worker:{recognize:()=>recognition.promise,terminate:async()=>{}}});await choose(h);
  assert.equal([...h.timers.values()].some(timer=>timer.delay===180000),false);assert.equal(h.calls.length,0);
  editing.resolve(new Blob(['accepted-edit'],{type:'image/jpeg'}));await flush();assert.equal([...h.timers.values()].some(timer=>timer.delay===180000),true);
  h.api.close();recognition.resolve({data:{text:'late'}});await flush();assert.equal(h.appended,0);
  const late=deferred(),changed=harness({editPhoto:()=>late.promise});await choose(changed);changed.setCurrent(false);late.resolve(new Blob(['old-account-edit'],{type:'image/jpeg'}));await flush();assert.equal(changed.calls.length,0);assert.equal(changed.editor.children[0],changed.original);changed.api.close();
});

test('OCR starts with the source sheet and skips the intermediate OCR picker until crop is accepted',async()=>{
  const selected=deferred(),cropped=deferred(),requests=[];let settings;
  const sources={open:request=>{requests.push(request);return selected.promise;},close(){}};
  const h=harness({photoSources:sources,editPhoto:(file,options)=>{settings=options;return cropped.promise;}});
  assert.equal(requests[0].mode,'ocr');assert.equal(h.body.querySelector('dialog'),null);assert.equal(h.calls.length,0);
  selected.resolve(file());const state=await h.state;assert.ok(state);assert.equal(state.node.open,false);assert.equal(h.history.some(item=>item.key==='book-photo-ocr'),false);assert.equal(settings.cropOnly,true);assert.equal(settings.trigger,h.button);
  cropped.resolve(new Blob(['cropped-pixels'],{type:'image/jpeg'}));await flush();assert.equal(state.node.open,true);assert.equal(state.review.hidden,false);assert.equal(h.history.some(item=>item.key==='book-photo-ocr'),true);assert.equal(h.editor.children[0],h.original);assert.equal(h.appended,0);h.api.close();
});

test('Back from OCR crop closes the complete photo operation and a late crop cannot start recognition',async()=>{
  const selected=deferred(),cropped=deferred();let settings;
  const h=harness({photoSources:{open:()=>selected.promise,close(){}},editPhoto:(file,options)=>{settings=options;return cropped.promise;}});
  selected.resolve(file());const state=await h.state;settings.onCancel();
  assert.equal(state.node.isConnected,false);assert.equal(h.config.composer.isConnected,true);assert.equal(h.button.focused,true);assert.equal(h.editor.children[0],h.original);
  cropped.resolve(new Blob(['late-cancelled-crop'],{type:'image/jpeg'}));await flush();assert.equal(h.calls.length,0);assert.equal(h.appended,0);assert.equal(h.history.some(item=>item.key==='book-photo-ocr'),false);
});

test('source selection cancellation and stale identity never create OCR state or touch the draft',async()=>{
  for(const mode of ['cancel','owner','rebind']){
    const selected=deferred(),requests=[];const h=harness({photoSources:{open:request=>{requests.push(request);return selected.promise;},close(){}}});
    if(mode==='owner')h.setCurrent(false);if(mode==='rebind')h.api.bind({});
    selected.resolve(mode==='cancel'?null:file());assert.equal(await h.state,null);assert.equal(h.body.querySelector('dialog'),null);assert.equal(h.config.composer.isConnected,true);assert.equal(h.editor.children[0],h.original);assert.equal(h.calls.length,0);assert.equal(h.appended,0);
  }
});
