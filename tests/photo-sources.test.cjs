'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Sources=require('../photoSources.js'),createHistory=require('../popupHistory.js');
const fixture=fs.readFileSync(path.join(__dirname,'book-photo-ocr.test.cjs'),'utf8'),start=fixture.indexOf('class Node{'),end=fixture.indexOf('\nfunction harness(',start),scope={};
vm.runInNewContext(fixture.slice(start,end)+'\nthis.Node=Node;',scope);const Node=scope.Node;
function harness(){
  const body=new Node('body'),composer=new Node('section'),editor=new Node('div'),original=new Node('p'),photo=new Node('img'),trigger=new Node('button');
  original.textContent='작성 중인 원문 그대로';photo.setAttribute('src','synthetic-original');body.appendChild(composer);composer.appendChild(editor);editor.appendChild(original);composer.appendChild(photo);composer.appendChild(trigger);
  const listeners={},documentEvents={},timers=new Map(),history=[{url:'https://example.test/#/book/emotion/mine',state:{preserve:'root'}}],moves=[];let index=0,serial=0,approved=true;
  const document={body,hidden:false,createElement:tag=>new Node(tag),addEventListener(name,fn){(documentEvents[name]||=[]).push(fn);},removeEventListener(name,fn){documentEvents[name]=(documentEvents[name]||[]).filter(item=>item!==fn);}};
  const browser={document,location:{href:history[0].url},addEventListener(name,fn){(listeners[name]||=[]).push(fn);},removeEventListener(name,fn){listeners[name]=(listeners[name]||[]).filter(item=>item!==fn);},setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    history:{get state(){return history[index].state;},pushState(state,unused,url){history.splice(index+1);history.push({state,url});index++;browser.location.href=url;},replaceState(state,unused,url){history[index]={state,url};browser.location.href=url;},go(delta){moves.push(delta);}}};
  function emit(name,event={}){for(const fn of [...listeners[name]||[]])fn(event);}
  function flushHistory(){while(moves.length){const next=index+moves.shift();if(next<0||next>=history.length)continue;index=next;browser.location.href=history[index].url;emit('popstate',{state:history[index].state});}}
  browser.GrowellPopupHistory=createHistory(browser);let parentCloses=0;browser.GrowellPopupHistory.open('space-composer',{close(){parentCloses++;}});
  const api=Sources.create({browser,document}),route=browser.location.href;
  function open(mode='photo'){const pending=api.open({mode,trigger,isCurrent:()=>approved&&composer.isConnected&&browser.location.href===route});return {pending,node:body.querySelectorAll('dialog').at(-1)};}
  function timersAt(delay){for(const [id,timer]of [...timers])if(timer.delay===delay&&timers.has(id)){timers.delete(id);timer.fn();}}
  return {api,open,body,composer,editor,original,photo,trigger,browser,document,timers,listeners,emit,flushHistory,timersAt,approve(value){approved=value;},back(){browser.history.go(-1);flushHistory();},get parentCloses(){return parentCloses;},visibility(hidden){document.hidden=hidden;for(const fn of [...documentEvents.visibilitychange||[]])fn({});}};
}
const file=name=>({name,type:'image/jpeg',size:1234});
function q(node,key){return node.querySelector('[data-source-'+key+']');}

test('camera and gallery are direct user choices and returning a file closes only the sheet before the caller continues',async()=>{
  for(const source of ['camera','gallery']){const h=harness(),{pending,node}=h.open(),input=q(node,source+'-input'),image=file(source+'.jpg');
    assert.equal(q(node,'camera-input').getAttribute('capture'),'environment');assert.equal(q(node,'gallery-input').getAttribute('capture'),null);
    q(node,source).click();assert.equal(input.clickCount,1);input.files=[image];input.dispatchEvent({type:'change'});assert.equal(await pending,image);
    assert.equal(node.isConnected,false);assert.equal(h.composer.isConnected,true);assert.equal(h.editor.children[0],h.original);assert.equal(h.photo.getAttribute('src'),'synthetic-original');assert.equal(h.parentCloses,0);assert.equal(h.trigger.focused,true);
    h.back();assert.equal(h.parentCloses,1,'the retired sheet creates no ghost Back stop');
  }
});

test('OCR uses the same sheet and hands its selected file to the caller without touching the existing draft',async()=>{
  const h=harness(),{pending,node}=h.open('ocr');assert.match(node.textContent,/카메라로 텍스트 추출/);assert.match(node.textContent,/사진첩에서 텍스트 추출/);
  q(node,'gallery').click();const image=file('book.jpg');q(node,'gallery-input').files=[image];q(node,'gallery-input').dispatchEvent({type:'change'});assert.equal(await pending,image);assert.equal(h.editor.textContent,'작성 중인 원문 그대로');
});

test('close, Escape, native camera cancellation and Back all return null without closing or modifying the composer',async()=>{
  for(const kind of ['close','escape','native','back']){const h=harness(),{pending,node}=h.open();
    if(kind==='close')q(node,'close').click();if(kind==='escape')node.dispatchEvent({type:'cancel',preventDefault(){}});if(kind==='native'){q(node,'camera').click();q(node,'camera-input').dispatchEvent({type:'cancel'});}if(kind==='back')h.back();
    assert.equal(await pending,null);assert.equal(node.isConnected,false);assert.equal(h.parentCloses,0);assert.equal(h.composer.isConnected,true);assert.equal(h.editor.children[0],h.original);assert.equal(h.photo.getAttribute('src'),'synthetic-original');
    h.back();assert.equal(h.parentCloses,1);
  }
});

test('an older phone returning from its native camera without a cancel event retires the sheet after a guarded focus check',async()=>{
  const h=harness(),{pending,node}=h.open();q(node,'camera').click();h.emit('blur');h.emit('focus');h.timersAt(500);
  assert.equal(await pending,null);assert.equal(node.isConnected,false);assert.equal(h.composer.isConnected,true);assert.equal(h.parentCloses,0);assert.equal(h.editor.textContent,'작성 중인 원문 그대로');
});

test('a file chosen while focus returns wins over the delayed cancellation fallback',async()=>{
  const h=harness(),{pending,node}=h.open();q(node,'gallery').click();h.visibility(true);h.visibility(false);const image=file('late-change.jpg'),input=q(node,'gallery-input');input.files=[image];h.timersAt(500);assert.equal(node.isConnected,true);
  input.dispatchEvent({type:'change'});assert.equal(await pending,image);assert.equal(h.composer.isConnected,true);
});

test('a replaced picker ignores late input results and a disconnected or changed session cannot deliver a former file',async()=>{
  const h=harness(),first=h.open();q(first.node,'camera').click();const second=h.open('ocr');assert.equal(await first.pending,null);q(first.node,'camera-input').files=[file('old.jpg')];q(first.node,'camera-input').dispatchEvent({type:'change'});assert.equal(second.node.isConnected,true);
  h.approve(false);h.timersAt(500);assert.equal(await second.pending,null);assert.equal(second.node.isConnected,false);assert.equal(h.parentCloses,0);assert.equal(h.editor.children[0],h.original);
  const detached=harness(),third=detached.open();detached.composer.remove();q(third.node,'camera-input').files=[file('detached.jpg')];q(third.node,'camera-input').dispatchEvent({type:'change'});detached.timersAt(500);assert.equal(await third.pending,null);
});

test('route changes retire only the source sheet and cancellation cannot reopen it through a late native change',async()=>{
  const h=harness(),{pending,node}=h.open();q(node,'gallery').click();h.browser.location.href='https://example.test/#/book/emotion/share';h.emit('hashchange');assert.equal(await pending,null);
  q(node,'gallery-input').files=[file('too-late.jpg')];q(node,'gallery-input').dispatchEvent({type:'change'});assert.equal(h.body.querySelectorAll('dialog').length,0);assert.equal(h.parentCloses,1,'the explicit route change retains normal parent-popup navigation');assert.equal(h.photo.getAttribute('src'),'synthetic-original');
});

test('only the most recently opened native input can resolve the active sheet',async()=>{
  const h=harness(),{pending,node}=h.open();q(node,'camera').click();q(node,'gallery').click();const stale=file('stale-camera.jpg');q(node,'camera-input').files=[stale];q(node,'camera-input').dispatchEvent({type:'change'});
  assert.equal(node.isConnected,true,'a late camera result must not replace the later gallery request');const current=file('current-gallery.jpg');q(node,'gallery-input').files=[current];q(node,'gallery-input').dispatchEvent({type:'change'});assert.equal(await pending,current);
});
