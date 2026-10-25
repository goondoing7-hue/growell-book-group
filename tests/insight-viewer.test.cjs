'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const createPopupHistory=require('../popupHistory.js');
const origin='https://growell-book.vercel.app';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decode=value=>String(value).replace(/&(?:amp|lt|gt|quot|#39);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[s]));

// Simulate native dialog/events and actual history traversal, not the viewer's
// internal state. Every assertion below uses its rendered controls or adapter.
function browserFixture(){
  const listeners=new Map(),history=[{url:origin+'/#/book/emotion/share',state:{unrelated:'preserved'}}],pending=[];
  let position=0,document;
  function on(target,type,handler,options){const list=target.get(type)||[];list.push({handler,options});target.set(type,list);}
  function off(target,type,handler){target.set(type,(target.get(type)||[]).filter(item=>item.handler!==handler));}
  const browser={URL,Promise,Date,Math,JSON,Array,Number,Object,Set,Map,WeakMap,Uint8Array,setTimeout,clearTimeout,innerWidth:400,
    location:{href:history[0].url,origin},navigator:{},
    addEventListener:(type,handler,options)=>on(listeners,type,handler,options),
    removeEventListener:(type,handler)=>off(listeners,type,handler),
    matchMedia:()=>({matches:true}),selection:'',getSelection(){return {isCollapsed:!browser.selection,toString:()=>browser.selection};},
    fetch(){assert.fail('a read-only insight viewer must not call a network or member API');},
    localStorage:{getItem(){assert.fail('viewer must not read private browser state');},setItem(){assert.fail('viewer must not persist authored content');}},
    sessionStorage:{getItem(){assert.fail('viewer must not read private browser state');},setItem(){assert.fail('viewer must not persist authored content');}}};
  function emit(type,event={}){for(const item of [...(listeners.get(type)||[])])item.handler(event);}
  browser.history={get state(){return history[position].state;},
    replaceState(state,unused,url){const href=new URL(url,browser.location.href).href;history[position]={state,url:href};browser.location.href=href;},
    pushState(state,unused,url){const href=new URL(url,browser.location.href).href;history.splice(position+1);history.push({state,url:href});position++;browser.location.href=href;},
    go(delta){pending.push(delta);},back(){pending.push(-1);},forward(){pending.push(1);}};
  function navigate(hash){browser.history.pushState(null,'',hash);emit('popstate',{state:null});emit('hashchange',{});}
  Object.defineProperty(browser.location,'hash',{get(){return new URL(browser.location.href).hash;},set(value){navigate(value);}});
  function flush(){let steps=0;while(pending.length){assert.ok(++steps<30,'history traversal must settle');const next=position+pending.shift();if(next<0||next>=history.length)continue;const previous=browser.location.href;position=next;browser.location.href=history[position].url;emit('popstate',{state:history[position].state});if(browser.location.href!==previous)emit('hashchange',{});}}
  function back(){browser.history.go(-1);flush();}
  function forward(){browser.history.go(1);flush();}

  class Node{
    constructor(tag,attributes={}){this.tagName=tag.toUpperCase();this.attributes={...attributes};this.children=[];this.parentNode=null;this.listeners=new Map();this.style={setProperty(name,value){this[name]=value;}};this.open=false;this.disabled=false;this.hidden=false;this.scrollTop=0;this.scrollLeft=0;this.clientWidth=400;this.clientHeight=600;this.focusCount=0;this._text='';
      this.classList={add:(...names)=>this.setClasses([...this.classes(),...names]),remove:(...names)=>this.setClasses(this.classes().filter(name=>!names.includes(name))),contains:name=>this.classes().includes(name),toggle:(name,force)=>{const has=this.classes().includes(name),want=force===undefined?!has:!!force;if(want)this.classList.add(name);else this.classList.remove(name);return want;}};
      this.dataset=new Proxy({}, {get:(_,key)=>this.getAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()))??undefined,set:(_,key,value)=>{this.setAttribute('data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value);return true;}});
    }
    classes(){return (this.attributes.class||'').split(/\s+/).filter(Boolean);}
    setClasses(names){this.attributes.class=[...new Set(names)].join(' ');}
    get className(){return this.attributes.class||'';}set className(value){this.attributes.class=String(value);}
    get id(){return this.attributes.id||'';}set id(value){this.attributes.id=String(value);}
    get isConnected(){return this===document.body||!!this.parentNode&&this.parentNode.isConnected;}
    get ownerDocument(){return document;}
    get parentElement(){return this.parentNode;}
    get firstChild(){return this.children[0]||null;}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this._text=String(value??'');this.children.forEach(child=>{child.parentNode=null;});this.children=[];}
    get innerHTML(){return escape(this._text)+this.children.map(child=>child.tagName==='#TEXT'?escape(child.textContent):'<'+child.tagName.toLowerCase()+Object.entries(child.attributes).map(([key,value])=>' '+key+'="'+escape(value)+'"').join('')+'>'+child.innerHTML+'</'+child.tagName.toLowerCase()+'>').join('');}
    set innerHTML(value){this.textContent='';const stack=[this];const voids=new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR']);for(const match of String(value).matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi)){if(match[3]!==undefined){const text=new Node('#text');text._text=decode(match[3]);stack.at(-1).appendChild(text);continue;}if(match[0][1]==='/'){if(stack.length>1)stack.pop();continue;}const attrs={};for(const item of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[item[1]]=decode(item[2]??item[3]??item[4]??'');const node=new Node(match[1],attrs);node.disabled=Object.hasOwn(attrs,'disabled');node.hidden=Object.hasOwn(attrs,'hidden');stack.at(-1).appendChild(node);if(!voids.has(node.tagName)&&!match[0].endsWith('/>'))stack.push(node);}}
    appendChild(node){if(node.parentNode)node.remove();node.parentNode=this;this.children.push(node);return node;}
    replaceChildren(...nodes){this.textContent='';nodes.forEach(node=>this.appendChild(node));}
    removeChild(node){assert.equal(node.parentNode,this);node.remove();return node;}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='disabled')this.disabled=true;}
    getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}
    hasAttribute(name){return Object.hasOwn(this.attributes,name);}
    removeAttribute(name){delete this.attributes[name];if(name==='disabled')this.disabled=false;}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    matches(selector){selector=selector.trim();if(selector.includes(','))return selector.split(',').some(part=>this.matches(part));if(!selector||this.tagName==='#TEXT')return false;const not=/:not\(([^)]+)\)/.exec(selector);if(not){if(this.matches(not[1]))return false;selector=selector.replace(not[0],'');}for(const attr of selector.matchAll(/\[([^=\]\s]+)(?:="([^"]*)")?\]/g)){if(!this.hasAttribute(attr[1])||attr[2]!==undefined&&this.getAttribute(attr[1])!==attr[2])return false;}selector=selector.replace(/\[[^\]]+\]/g,'');const id=/#([\w-]+)/.exec(selector);if(id&&this.id!==id[1])return false;for(const cls of selector.matchAll(/\.([\w-]+)/g))if(!this.classes().includes(cls[1]))return false;const tag=/^[\w-]+/.exec(selector);return !tag||this.tagName===tag[0].toUpperCase();}
    closest(selector){return this.matches(selector)?this:this.parentNode?this.parentNode.closest(selector):null;}
    descendants(){return this.children.flatMap(child=>[child,...child.descendants()]);}
    querySelectorAll(selector){return this.descendants().filter(node=>selector.split(',').some(part=>node.matches(part)));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    addEventListener(type,handler,options){on(this.listeners,type,handler,options);}
    removeEventListener(type,handler){off(this.listeners,type,handler);}
    dispatchEvent(input){const event={bubbles:true,cancelable:true,defaultPrevented:false,target:this,button:0,clientX:1,clientY:1,...input};event.preventDefault=()=>{event.defaultPrevented=true;};let stopped=false;event.stopPropagation=()=>{stopped=true;};event.stopImmediatePropagation=()=>{stopped=true;event.immediateStopped=true;};for(let node=this;node;node=event.bubbles&&!stopped?node.parentNode:null){event.currentTarget=node;if(typeof node['on'+event.type]==='function')node['on'+event.type](event);for(const item of [...(node.listeners.get(event.type)||[])]){item.handler(event);if(item.options&&item.options.once)off(node.listeners,event.type,item.handler);if(event.immediateStopped)break;}}if(event.bubbles&&!stopped){for(const item of [...(document.listeners.get(event.type)||[])])item.handler(event);emit(event.type,event);}return !event.defaultPrevented;}
    emit(type,extra={}){const event={type,...extra};this.dispatchEvent(event);return event;}
    click(){if(!this.disabled)this.dispatchEvent({type:'click'});}
    showModal(){assert.ok(this.isConnected,'native dialog must be attached');this.open=true;this.setAttribute('open','');}
    close(){if(!this.open)return;this.open=false;this.removeAttribute('open');this.dispatchEvent({type:'close',bubbles:false});}
    focus(){this.focusCount++;document.activeElement=this;}
    getBoundingClientRect(){return {left:0,top:0,right:400,bottom:600,width:400,height:600};}
    scrollTo(options){if(options.top!==undefined)this.scrollTop=options.top;if(options.left!==undefined)this.scrollLeft=options.left;}
    setPointerCapture(){}releasePointerCapture(){}hasPointerCapture(){return false;}
  }
  document={listeners:new Map(),activeElement:null,hidden:false,defaultView:browser,createElement:tag=>new Node(tag),createTextNode:text=>{const node=new Node('#text');node.textContent=text;return node;},
    addEventListener(type,handler,options){on(this.listeners,type,handler,options);},removeEventListener(type,handler){off(this.listeners,type,handler);},getSelection:()=>browser.getSelection()};
  document.body=new Node('body');document.documentElement=new Node('html');
  document.querySelectorAll=selector=>document.body.querySelectorAll(selector);document.querySelector=selector=>document.body.querySelector(selector);document.getElementById=id=>document.querySelector('#'+id);
  browser.document=document;browser.window=browser;browser.GrowellPopupHistory=createPopupHistory(browser);
  return {browser,document,history,pending,back,forward,navigate,flush};
}

function post(index,extra={}){return {id:'public-'+index,bookId:'emotion',noteType:'insight',meetingNo:'2',userId:'member-'+index,userName:'별명 '+index,q1:'  소감 '+index+'\n다음 문장  ',q2:'깨달음 '+index,q3:'배움 '+index,createdAt:index,...extra};}
function harness(t,options={}){
  const f=browserFixture(),posts=options.posts||Array.from({length:5},(_,index)=>post(index+1)),calls={posts:[],render:[],authors:[],toasts:[],parentClosed:0};
  const session={userId:'reader',epoch:1,readable:true},adapter={sessionUserId:()=>session.userId,sessionEpoch:()=>session.epoch,
    canReadBook:bookId=>!!session.userId&&session.readable&&['emotion','thought'].includes(bookId),
    getPosts(bookId,source,mode){calls.posts.push({bookId,source,mode});return options.getPosts?options.getPosts(bookId,source,mode):posts;},
    getAuthor(row){calls.authors.push(row.id);return options.author||{name:row.userName,avatar:''};},
    renderPostHtml(row){calls.render.push(row.id);return options.renderPostHtml?options.renderPostHtml(row):'<div data-public-post="'+escape(row.id)+'"><strong data-host-legacy>'+escape(row.title||'원래 제목')+'</strong><p>'+escape(row.q1)+'</p><p>'+escape(row.q2)+'</p><p>'+escape(row.q3)+'</p></div>';},
    getPostLinks:options.getPostLinks||(()=>[]),dateText:value=>'날짜 '+value,showToast:(...args)=>calls.toasts.push(args)};
  const context=f.browser;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../insightViewer.js'),'utf8'),context,{filename:'insightViewer.js'});
  const api=context.GrowellInsightViewer;assert.ok(api,'browser export must exist');if(options.configure!==false)api.configure(adapter);
  const trigger=f.document.createElement('button');trigger.textContent='원래 통찰 원본 보기';f.document.body.appendChild(trigger);trigger.focus();
  let parent=null;
  function openParent(){parent=f.document.createElement('dialog');parent.className='meeting-records-dialog';parent.scrollTop=432;parent.dataset.slide='2';f.document.body.appendChild(parent);parent.appendChild(trigger);parent.showModal();context.GrowellPopupHistory.open('meeting-records',{close(){calls.parentClosed++;parent.close();context.GrowellPopupHistory.closed('meeting-records');}});return parent;}
  function current(){return f.document.body.children.find(node=>node.tagName==='DIALOG'&&node.open&&node!==parent)||null;}
  function q(selector){const node=current();assert.ok(node,'insight viewer must be visible');const value=node.querySelector(selector);assert.ok(value,'rendered control '+selector+' must exist');return value;}
  function selected(){return current()?.querySelector('[data-public-post]')?.getAttribute('data-public-post')||null;}
  function click(action){q('[data-iv-'+action+']').click();}
  function open(id='public-1',extra={}){return api.open('emotion',id,{source:'share',trigger,...extra});}
  t.after(()=>api.reset());
  return {...f,api,adapter,session,posts,calls,trigger,current,q,selected,click,open,openParent,get parent(){return parent;}};
}

test('a readable insight preserves the host-rendered legacy body, source fields and accessible controls',t=>{
  const source=post(1,{html:'<p>  보존할 예전 본문<br>다음 줄</p>',q1:'별도 답변  ',title:'예전 제목'}),rows=[source],before=JSON.stringify(rows);
  const h=harness(t,{posts:rows,renderPostHtml:row=>'<div data-public-post="'+row.id+'"><p data-host-legacy>  보존할 예전 본문<br>다음 줄</p><a href="https://example.invalid/">원래 자료</a></div>'});
  assert.equal(h.open(),true);assert.equal(h.selected(),'public-1');assert.match(h.q('[data-iv-body]').innerHTML,/data-host-legacy|보존할 예전 본문|원래 자료/);
  assert.match(h.q('[data-iv-position]').textContent,/1\s*\/\s*1/);assert.equal(h.q('[data-iv-prev]').disabled,true);assert.equal(h.q('[data-iv-next]').disabled,true);
  for(const name of ['close','prev','next'])assert.ok(h.q('[data-iv-'+name+']').getAttribute('aria-label')||h.q('[data-iv-'+name+']').textContent.trim());
  const label=h.current().getAttribute('aria-labelledby');assert.ok(label&&h.current().querySelector('#'+label)||h.current().getAttribute('aria-label'));
  h.click('close');assert.equal(h.current(),null);assert.equal(h.document.activeElement,h.trigger);assert.equal(JSON.stringify(rows),before);
});

test('same-book normalized-round insights navigate in visible source order and stop at both boundaries',t=>{
  const rows=[post(1),post(77,{bookId:'thought'}),post(2,{meetingNo:' ２ '}),post(78,{meetingNo:'3'}),post(3),post(79,{noteType:'quote'}),post(4),post(5)],before=JSON.stringify(rows),h=harness(t,{posts:rows});
  assert.equal(h.open(),true);const seen=[h.selected()];
  for(let index=0;index<4;index++){h.click('next');seen.push(h.selected());}
  assert.deepEqual(seen,['public-1','public-2','public-3','public-4','public-5']);assert.match(h.q('[data-iv-position]').textContent,/5\s*\/\s*5/);assert.equal(h.q('[data-iv-next]').disabled,true);
  h.click('next');assert.equal(h.selected(),'public-5');for(let index=0;index<4;index++)h.click('prev');assert.equal(h.selected(),'public-1');assert.equal(h.q('[data-iv-prev]').disabled,true);assert.equal(JSON.stringify(rows),before);
});

test('an explicit meeting scope retains its supplied ordering and never includes another round or absent ID',t=>{
  const h=harness(t,{posts:[post(1),post(2),post(3),post(4,{meetingNo:'3'}),post(5)]});
  assert.equal(h.open('public-1',{source:'meeting',postIds:['public-3','public-1','missing','public-4','public-5']}),true);
  assert.match(h.q('[data-iv-position]').textContent,/2\s*\/\s*3/);h.click('prev');assert.equal(h.selected(),'public-3');h.click('next');h.click('next');assert.equal(h.selected(),'public-5');
  assert.ok(h.calls.posts.every(call=>call.source==='meeting'&&call.bookId==='emotion'));
});

test('many previous-next moves add one child history entry and native Back preserves its meeting parent exactly',t=>{
  const h=harness(t),parent=h.openParent(),before=h.history.length;
  assert.equal(h.open('public-1',{source:'meeting',parent}),true);assert.equal(h.history.length,before+1);
  for(let index=0;index<4;index++)h.click('next');for(let index=0;index<3;index++)h.click('prev');assert.equal(h.history.length,before+1);
  h.back();assert.equal(h.current(),null);assert.equal(parent.open,true);assert.equal(parent.scrollTop,432);assert.equal(parent.dataset.slide,'2');assert.equal(h.calls.parentClosed,0);
  h.back();assert.equal(parent.open,false);assert.equal(h.calls.parentClosed,1);
  assert.doesNotMatch(JSON.stringify(h.history),/member-1|별명|소감|깨달음|keyB64|reader/);
});

test('explicit child close performs no asynchronous traversal and the next Back closes its parent once',t=>{
  const h=harness(t),parent=h.openParent();h.open('public-2',{source:'meeting',parent});h.click('close');
  assert.equal(parent.open,true);assert.equal(h.pending.length,0);h.back();assert.equal(h.calls.parentClosed,1);assert.equal(parent.open,false);assert.equal(h.current(),null);
});

test('reopening the same child refreshes its content without creating duplicate Back screens',t=>{
  const h=harness(t),parent=h.openParent();h.open('public-1',{source:'meeting',parent});const length=h.history.length;
  assert.equal(h.open('public-3',{source:'meeting',parent}),true);assert.equal(h.selected(),'public-3');assert.equal(h.history.length,length);
  h.back();assert.equal(h.current(),null);assert.equal(parent.open,true);h.forward();assert.equal(h.current(),null,'Forward cannot resurrect a retired popup');
});

test('profile labels are literal text and unsafe avatar schemes cannot create executable markup',t=>{
  const name='<img src=x onerror=bad>별명 & "원문"',h=harness(t,{author:{name,avatar:'javascript:alert(1)'}});h.open();
  assert.equal(h.q('[data-iv-name]').textContent,name);assert.equal(h.q('[data-iv-name]').querySelector('img'),null);
  assert.doesNotMatch(h.current().innerHTML,/src="javascript:|<script/);assert.equal(h.current().querySelectorAll('[onerror]').length,0);
});

test('keyboard movement ignores editing, modifier keys and selected text',t=>{
  const h=harness(t);h.open('public-2');const body=h.q('[data-iv-body]');body.emit('keydown',{key:'ArrowRight'});assert.equal(h.selected(),'public-3');
  h.q('[data-iv-body]').emit('keydown',{key:'ArrowLeft'});assert.equal(h.selected(),'public-2');
  const input=h.document.createElement('input');h.q('[data-iv-body]').appendChild(input);input.emit('keydown',{key:'ArrowRight'});assert.equal(h.selected(),'public-2');
  h.q('[data-iv-body]').emit('keydown',{key:'ArrowRight',ctrlKey:true});assert.equal(h.selected(),'public-2');
  h.browser.selection='선택한 문장';h.q('[data-iv-body]').emit('keydown',{key:'ArrowRight'});assert.equal(h.selected(),'public-2');
});

test('horizontal swipes navigate while vertical reading, small gestures, links and selected text remain untouched',t=>{
  const h=harness(t);h.open('public-2');
  function swipe(target,from,to){target.emit('touchstart',{touches:[{clientX:from[0],clientY:from[1]}]});target.emit('touchend',{changedTouches:[{clientX:to[0],clientY:to[1]}]});}
  swipe(h.q('[data-iv-body]'),[300,100],[40,105]);assert.equal(h.selected(),'public-3');
  swipe(h.q('[data-iv-body]'),[150,50],[150,400]);assert.equal(h.selected(),'public-3');
  swipe(h.q('[data-iv-body]'),[100,100],[90,100]);assert.equal(h.selected(),'public-3');
  swipe(h.q('[data-iv-body]'),[5,100],[260,100]);assert.equal(h.selected(),'public-3','the native left-edge Back gesture remains available');
  swipe(h.q('[data-iv-body]'),[395,100],[100,100]);assert.equal(h.selected(),'public-3','the native right-edge gesture remains available');
  const cancelled=h.q('[data-iv-body]');cancelled.emit('touchstart',{touches:[{clientX:300,clientY:100}]});cancelled.emit('touchcancel');cancelled.emit('touchend',{changedTouches:[{clientX:40,clientY:100}]});assert.equal(h.selected(),'public-3');
  const link=h.document.createElement('a');h.q('[data-iv-body]').appendChild(link);swipe(link,[300,100],[40,100]);assert.equal(h.selected(),'public-3');
  h.browser.selection='선택한 원문';swipe(h.q('[data-iv-body]'),[300,100],[40,100]);assert.equal(h.selected(),'public-3');
});

test('owner, epoch and book permission changes close the old popup without restoring its stale focus',async t=>{
  for(const change of ['owner','epoch','permission'])await t.test(change,t=>{const h=harness(t);h.open();const focused=h.trigger.focusCount;
    if(change==='owner')h.session.userId='another-member';else if(change==='epoch')h.session.epoch++;else h.session.readable=false;
    h.api.reconcile();assert.equal(h.current(),null);assert.equal(h.trigger.focusCount,focused);h.back();assert.equal(h.current(),null);
  });
});

test('a closed or detached parent invalidates only its child and never reopens the parent',async t=>{
  for(const change of ['closed','detached'])await t.test(change,t=>{const h=harness(t),parent=h.openParent();h.open('public-2',{source:'meeting',parent});if(change==='closed'){parent.close();assert.equal(h.current(),null,'native parent close must dismiss the child immediately');}else parent.remove();h.api.reconcile();assert.equal(h.current(),null);assert.equal(parent.open,change==='detached');});
});

test('explicit private, withdrawn and deleted visibility flags cannot enter or remain in a readable scope',async t=>{
  for(const flag of [{private:true},{isPrivate:true},{is_private:true},{visible:false},{isDeleted:true},{is_deleted:true},{deletedAt:'2026-10-24'},{deleted_at:'2026-10-24'},{visibility:'private'}])await t.test(Object.keys(flag)[0],t=>{
    const h=harness(t);h.open('public-2');Object.assign(h.posts[1],flag);const before=JSON.stringify(h.posts);h.api.reconcile();assert.equal(h.current(),null);
    assert.equal(h.open('public-2'),false);assert.equal(h.current(),null);h.open('public-1');assert.match(h.q('[data-iv-position]').textContent,/1\s*\/\s*4/);h.click('next');assert.equal(h.selected(),'public-3');assert.equal(JSON.stringify(h.posts),before);
  });
});

test('withdrawn or moved selected posts close rather than switching to a different author silently',async t=>{
  for(const change of ['withdrawn','round','book','kind'])await t.test(change,t=>{const h=harness(t);h.open('public-2');
    if(change==='withdrawn')h.posts.splice(1,1);else if(change==='round')h.posts[1].meetingNo='3';else if(change==='book')h.posts[1].bookId='thought';else h.posts[1].noteType='quote';
    const before=JSON.stringify(h.posts);h.api.reconcile();assert.equal(h.current(),null);assert.equal(JSON.stringify(h.posts),before);assert.ok(h.calls.toasts.length>0);
  });
});

test('fresh availability filters the captured scope without adding newly arrived unrelated navigation entries',t=>{
  const h=harness(t);h.open('public-3');h.posts.splice(4,1);h.posts.push(post(6));h.api.reconcile();
  assert.match(h.q('[data-iv-position]').textContent,/3\s*\/\s*4/);h.click('next');assert.equal(h.selected(),'public-4');assert.equal(h.q('[data-iv-next]').disabled,true);
});

test('invalid or unconfigured opens are no-ops without history or authored-data changes',t=>{
  const h=harness(t),before=JSON.stringify(h.posts),length=h.history.length;
  for(const [book,id,options] of [['unknown','public-1',{}],['emotion','missing',{}],['emotion',null,{}],['emotion','public-1',{source:'mine'}],['emotion','public-1',{postIds:['public-2']}],['emotion','public-1',{postIds:['public-1','public-1']}],['emotion','public-1',{postIds:'public-1'}],['emotion','public-1',{parent:h.document.createElement('dialog')}]]){
    assert.equal(h.api.open(book,id,{source:'share',...options}),false);assert.equal(h.current(),null);assert.equal(h.history.length,length);
  }
  assert.equal(JSON.stringify(h.posts),before);
  const unconfigured=harness(t,{configure:false});assert.equal(unconfigured.open(),false);assert.equal(unconfigured.current(),null);
});

test('unavailable or asynchronous source lists fail closed without exposing raw failures',async t=>{
  for(const failure of ['throw','promise'])await t.test(failure,t=>{let failing=false;const h=harness(t,{getPosts:()=>{if(!failing)return [post(1)];if(failure==='throw')throw Error('PRIVATE_SOURCE_ERROR');return Promise.resolve([post(1)]);}});h.open();failing=true;h.api.reconcile();assert.equal(h.current(),null);assert.doesNotMatch(JSON.stringify(h.calls.toasts),/PRIVATE_SOURCE_ERROR/);});
});

test('route changes and reset close the viewer without undoing the new destination or reusing retired content',t=>{
  const h=harness(t);h.open('public-2');h.navigate('#/book/thought/share');h.api.reconcile();assert.equal(h.current(),null);assert.equal(h.browser.location.hash,'#/book/thought/share');assert.equal(h.pending.length,0);
  h.navigate('#/book/emotion/share');h.open();h.api.reset();assert.equal(h.current(),null);h.back();h.forward();assert.equal(h.current(),null);
});

test('ordinary shared posts use the same read-only viewer across three types without mixing insight rounds or altering originals',t=>{
  const rows=[post(1,{noteType:'quote',meetingNo:'1',html:'<p>원래 문장</p>',photo:{dataUrl:'https://example.invalid/original.jpg'}}),post(2,{noteType:'thought',meetingNo:'3'}),post(3,{noteType:'question',meetingNo:''}),post(4),post(5,{noteType:'summary'}),post(6,{noteType:'quote',bookId:'thought'})],before=JSON.stringify(rows);
  const h=harness(t,{posts:rows,renderPostHtml:row=>'<div data-public-post="'+row.id+'"><h3>'+escape(row.title||'원래 제목')+'</h3>'+row.html+'<img src="'+escape(row.photo?.dataUrl||'https://example.invalid/other.jpg')+'"></div>'});
  assert.equal(h.open('public-1',{mode:'post'}),true);assert.match(h.q('[data-iv-title]').textContent,/님의 나눔/);assert.match(h.q('[data-iv-body]').innerHTML,/원래 문장|original.jpg/);
  h.click('next');assert.equal(h.selected(),'public-2');h.click('next');assert.equal(h.selected(),'public-3');assert.equal(h.q('[data-iv-next]').disabled,true);assert.match(h.q('[data-iv-position]').textContent,/3\s*\/\s*3/);
  assert.ok(h.calls.posts.every(call=>call.source==='share'&&call.mode==='post'));assert.equal(JSON.stringify(rows),before);
  assert.equal(h.open('public-4',{mode:'post'}),false);assert.equal(h.open('public-1'),false);
});

test('ordinary posts retain the captured visible order and type filter, close when selection is withdrawn and exclude new arrivals',t=>{
  const rows=[post(1,{noteType:'quote'}),post(2,{noteType:'thought'}),post(3,{noteType:'quote'}),post(4,{noteType:'question'})],h=harness(t,{posts:rows});
  assert.equal(h.open('public-3',{mode:'post',postIds:['public-3','public-1'],noteTypes:['quote']}),true);h.click('next');assert.equal(h.selected(),'public-1');assert.equal(h.q('[data-iv-next]').disabled,true);
  rows.push(post(5,{noteType:'quote'}));h.api.reconcile();assert.match(h.q('[data-iv-position]').textContent,/2\s*\/\s*2/);
  rows[0].noteType='thought';h.api.reconcile();assert.equal(h.current(),null);
  assert.equal(h.open('public-3',{mode:'post',postIds:['public-3']}),true);rows[2].visibility='private';h.api.reconcile();assert.equal(h.current(),null);
});

test('ordinary post mode rejects meeting, private, unsupported mode/type scopes and duplicate captured identifiers',t=>{
  const h=harness(t,{posts:[post(1,{noteType:'quote'}),post(2,{noteType:'thought',isPrivate:true})]});
  for(const extra of [{mode:'post',source:'meeting'},{mode:'private'},{mode:'post',noteTypes:['insight']},{mode:'post',noteTypes:['summary']},{mode:'post',noteTypes:[]},{mode:'post',noteTypes:['quote','quote']},{mode:'post',postIds:['public-1','public-1']},{mode:'insight',noteTypes:['quote']}])assert.equal(h.open('public-1',extra),false);
  assert.equal(h.open('public-2',{mode:'post'}),false);assert.equal(h.current(),null);
});

test('ordinary posts provide literal real detail links for comments or management and never duplicate inactive write controls',t=>{
  const target='#/book/emotion/share/post/public-1',h=harness(t,{posts:[post(1,{noteType:'thought'})],getPostLinks:()=>[{label:'댓글 2개 보기',href:target},{label:'글 관리',href:target},{label:'잘못된 외부 대상',href:'javascript:alert(1)'},{label:'다른 글',href:'#/book/emotion/share/post/other'}]});
  assert.equal(h.open('public-1',{mode:'post'}),true);const links=h.q('[data-iv-links]').querySelectorAll('a');assert.equal(links.length,2);assert.ok(links.every(link=>link.getAttribute('href')===target));assert.deepEqual(links.map(link=>link.textContent),['댓글 2개 보기','글 관리']);
  assert.equal(h.current().querySelectorAll('[data-comment-submit],[data-edit-post],[data-del-post]').length,0);h.navigate(target);assert.equal(h.current(),null);assert.equal(h.browser.location.hash,target);
});
test('plain detail links reveal an already selected detail without a hash event and preserve modifier or middle-click behavior',t=>{
  const target='#/book/emotion/share/post/public-1',h=harness(t,{posts:[post(1,{noteType:'thought'})],getPostLinks:()=>[{label:'댓글 보기',href:target},{label:'글 관리',href:target}]});h.navigate(target);
  assert.equal(h.open('public-1',{mode:'post'}),true);const before=h.history.length;
  for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}]){
    const native=h.q('[data-iv-links]').querySelector('a').dispatchEvent({type:'click',...extra});assert.equal(native,true);assert.ok(h.current());assert.equal(h.browser.location.hash,target);
  }
  const native=h.q('[data-iv-links]').querySelectorAll('a')[1].dispatchEvent({type:'click'});assert.equal(native,false);assert.equal(h.current(),null);assert.equal(h.browser.location.hash,target);assert.equal(h.pending.length,0);assert.equal(h.history.length,before);assert.equal(h.document.activeElement,h.trigger);
});
test('different detail links retain native routing while stale permission blocks navigation and closes the popup',t=>{
  const target='#/book/emotion/share/post/public-1',h=harness(t,{posts:[post(1,{noteType:'question'})],getPostLinks:()=>[{label:'댓글 보기',href:target}]});
  h.open('public-1',{mode:'post'});const native=h.q('[data-iv-links]').querySelector('a').dispatchEvent({type:'click'});assert.equal(native,true);assert.ok(h.current(),'a distinct href keeps its native default navigation');h.navigate(target);assert.equal(h.current(),null);assert.equal(h.browser.location.hash,target);assert.equal(h.pending.length,0);
  h.navigate('#/book/emotion/share');h.open('public-1',{mode:'post'});h.session.readable=false;const staleNative=h.q('[data-iv-links]').querySelector('a').dispatchEvent({type:'click'});assert.equal(staleNative,false);assert.equal(h.current(),null);assert.equal(h.browser.location.hash,'#/book/emotion/share');
});

test('ordinary post navigation adds one popup history entry and native Back restores the originating list focus',t=>{
  const h=harness(t,{posts:[post(1,{noteType:'quote'}),post(2,{noteType:'thought'}),post(3,{noteType:'question'})]}),before=h.history.length,hash=h.browser.location.hash;
  h.open('public-1',{mode:'post'});h.click('next');h.click('next');h.click('prev');assert.equal(h.history.length,before+1);assert.equal(h.browser.location.hash,hash);h.back();assert.equal(h.current(),null);assert.equal(h.document.activeElement,h.trigger);
});

const appSource=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function appSection(start,end){const a=appSource.indexOf(start),b=appSource.indexOf(end,a);assert.ok(a>=0&&b>a);return appSource.slice(a,b);}
function desktopPostFixture(){
  const f=browserFixture(),calls=[];let wide=true,mobile=false,opened=true,route={view:'book',bookId:'emotion',tab:'share'};
  Object.assign(f.browser,{shareFeedFilter:{emotion:'all'},esc:escape,navigator:{userAgent:'Windows'},matchMedia:()=>({matches:wide}),GrowellGuideRouting:{isMobileDevice:()=>mobile},currentRoute:()=>route,
    GrowellInsightViewer:{open:(...args)=>{calls.push(args);return opened;}}});
  vm.runInNewContext(appSection('function sharePostPopupAttrs(','function spaceWorkspaceHtml('),f.browser);
  const grid=f.document.createElement('div');grid.id='share-grid-emotion';f.document.body.appendChild(grid);
  function add(id,hidden=false,book='emotion'){
    const row=f.document.createElement('article');row.className='feed-tile';row.style.display=hidden?'none':'';grid.appendChild(row);
    function link(){const a=f.document.createElement('a');a.setAttribute('href','#/book/'+book+'/share/post/'+id);a.setAttribute('data-share-post-open',id);a.setAttribute('data-share-post-book',book);row.appendChild(a);return a;}
    const anchor=link();link();return {row,anchor};
  }
  function click(target,extra={}){const event={target,button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};f.browser.openSharedPostPopup(event);return event;}
  return {...f,calls,grid,add,click,wide:value=>wide=value,mobile:value=>mobile=value,opened:value=>opened=value,route:value=>route=value};
}

test('desktop share-list clicks capture only displayed ordinary post identifiers in current DOM order and filter',()=>{
  const h=desktopPostFixture(),one=h.add('one'),hidden=h.add('hidden',true),two=h.add('two'),foreign=h.add('foreign',false,'thought');
  assert.equal(h.click(two.anchor).defaultPrevented,true);assert.equal(h.calls.length,1);const [book,id,scope]=h.calls[0];assert.equal(book,'emotion');assert.equal(id,'two');assert.equal(scope.mode,'post');assert.equal(scope.source,'share');assert.deepEqual(Array.from(scope.postIds),['one','two']);assert.deepEqual(Array.from(scope.noteTypes),['quote','thought','question']);
  h.browser.shareFeedFilter.emotion='thought';h.click(one.anchor);assert.deepEqual(Array.from(h.calls[1][2].noteTypes),['thought']);assert.equal(hidden.row.style.display,'none');assert.equal(foreign.row.parentNode,h.grid);
});

test('mobile and narrow layouts, modified clicks, hidden targets, other routes and failed opens preserve native links',()=>{
  const h=desktopPostFixture(),one=h.add('one'),hidden=h.add('hidden',true);
  h.wide(false);assert.equal(h.click(one.anchor).defaultPrevented,false);h.wide(true);h.mobile(true);assert.equal(h.click(one.anchor).defaultPrevented,false);h.mobile(false);
  for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}])h.click(one.anchor,extra);assert.equal(h.calls.length,0);
  assert.equal(h.click(hidden.anchor).defaultPrevented,false);h.route({view:'book',bookId:'emotion',tab:'mine'});assert.equal(h.click(one.anchor).defaultPrevented,false);h.route({view:'book',bookId:'emotion',tab:'share'});h.opened(false);assert.equal(h.click(one.anchor).defaultPrevented,false);assert.equal(one.anchor.getAttribute('href'),'#/book/emotion/share/post/one');
});

test('only quote, thought and question get popup markers; host adapter reads approved public posts and preserves comment-management permission rules',()=>{
  const f=desktopPostFixture();for(const kind of ['quote','thought','question'])assert.match(f.browser.sharePostPopupAttrs({id:'emotion'},{id:'p',noteType:kind}),/data-share-post-open/);for(const kind of ['insight','summary','private',''])assert.equal(f.browser.sharePostPopupAttrs({id:'emotion'},{id:'p',noteType:kind}),'');
  let adapter,admin=false;const c={GrowellInsightViewer:{configure:value=>adapter=value},SESSION:{userId:'self'},saveSessionEpoch:1,STATE:{users:{self:{name:'본인',approvalStatus:'approved'},other:{name:'다른회원',approvalStatus:'approved'},pending:{approvalStatus:'pending'},deleted:{approvalStatus:'approved',isDeleted:true}},posts:{},privateEntries:{secret:{id:'private-secret',bookId:'emotion',noteType:'quote'}},materialNotes:{secret:{id:'material-secret',bookId:'emotion',noteType:'quote'}}},meetingMemberCanRead:()=>true,meetingRecordsBridge:{getInsightPosts:()=>[post(9)]},safePhotoUrl:value=>value,noteBodyHtml:()=>({mediaHtml:'원문',bodyHtml:''}),fmtDate:()=>'',showToast(){},isAdmin:()=>admin,commentsForPost:()=>[{}]};
  for(const row of [post(1,{noteType:'quote',userId:'self'}),post(2,{noteType:'thought',userId:'other'}),post(3,{noteType:'question',userId:'other'}),post(4,{userId:'other'}),post(5,{noteType:'summary',userId:'other'}),post(6,{noteType:'quote',userId:'pending'}),post(7,{noteType:'quote',userId:'deleted'})])c.STATE.posts[row.id]=row;
  vm.runInNewContext(appSection("if(typeof GrowellInsightViewer!=='undefined')GrowellInsightViewer.configure({",'GrowellMeetingRecords.configure({'),c);
  assert.deepEqual(Array.from(adapter.getPosts('emotion','share','post'),row=>row.id),['public-1','public-2','public-3']);assert.deepEqual(Array.from(adapter.getPosts('emotion','share'),row=>row.id),['public-4']);assert.equal(adapter.getPosts('emotion','meeting','post').length,0);
  assert.equal(adapter.getPostLinks(c.STATE.posts['public-1']).length,2);assert.equal(adapter.getPostLinks(c.STATE.posts['public-2']).length,1);admin=true;assert.equal(adapter.getPostLinks(c.STATE.posts['public-2']).length,2);assert.match(adapter.getPostLinks(c.STATE.posts['public-2'])[0].label,/댓글 1개 보기/);
});
