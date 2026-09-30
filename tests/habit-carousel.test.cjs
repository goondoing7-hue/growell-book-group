const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../habitCarousel.js'),'utf8');

function harness(){
  let now=1000,reduced=false;const timers=[];
  const win={setTimeout:fn=>timers.push(fn),matchMedia:()=>({matches:reduced})};
  const document={activeElement:null,defaultView:win};
  function matches(node,selector){
    if(selector[0]==='['){const [,name,value]=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return node.getAttribute(name)!==null&&(value===undefined||node.getAttribute(name)===value);}
    return node.tagName===selector.toUpperCase();
  }
  class Node{
    constructor(tag='div',attrs={}){this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.parentNode=null;this.ownerDocument=document;this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.scrollLeft=0;this.clientWidth=320;this.captures=new Set();this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x)};}
    append(node){node.parentNode=this;this.children.push(node);return node;}
    getAttribute(name){return Object.hasOwn(this.attrs,name)?this.attrs[name]:null;}
    setAttribute(name,value){this.attrs[name]=String(value);}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
    querySelectorAll(selector){return this.all().filter(node=>matches(node,selector));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    closest(selector){for(let node=this;node;node=node.parentNode)if(selector.split(',').some(part=>matches(node,part)))return node;return null;}
    addEventListener(type,fn,options){(this.listeners[type]||(this.listeners[type]=[])).push({fn,capture:options===true||!!options?.capture});}
    removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(item=>item.fn!==fn);}
    emit(type,extra={}){
      const event={target:this,detail:1,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};
      const ancestors=[];for(let node=this;node;node=node.parentNode)ancestors.push(node);
      for(const [nodes,capture] of [[ancestors.slice().reverse(),true],[ancestors,false]]){
        for(const node of nodes){for(const listener of node.listeners[type]||[]){if(listener.capture===capture){listener.fn(event);if(event.stopped)return event;}}}
      }
      return event;
    }
    focus(options){assert.equal(options.preventScroll,true);document.activeElement=this;}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    setPointerCapture(id){this.captures.add(id);}
    hasPointerCapture(id){return this.captures.has(id);}
    releasePointerCapture(id){this.captures.delete(id);}
    getBoundingClientRect(){return {left:100,width:this.clientWidth};}
    scrollTo(options){this.lastScroll=options;this.scrollLeft=options.left;this.emit('scroll');}
    click(extra={}){return this.disabled?null:this.emit('click',extra);}
  }
  function panel(scope='emotion',data=[['one','기도 하나님'],['two','독서 박곰희 투자'],['three','걷기 공원']]){
    const node=new Node('section',{'data-habit-browser':'','data-habit-scope':scope});
    const search=node.append(new Node('input',{'data-habit-search-input':''}));
    const navigation=node.append(new Node('div',{'data-habit-navigation':''}));
    const previous=navigation.append(new Node('button',{'data-habit-prev':''})),position=navigation.append(new Node('span',{'data-habit-position':''})),next=navigation.append(new Node('button',{'data-habit-next':''}));
    const count=node.append(new Node('p',{'data-habit-result':''})),empty=node.append(new Node('p',{'data-habit-empty':''}));
    const track=node.append(new Node('div',{'data-habit-carousel':''}));
    const cards=data.map(([id,text])=>{
      const card=track.append(new Node('article',{'data-habit-card':id,'data-habit-search':text,'data-habit-name':text.split(' ')[0]}));
      card.getBoundingClientRect=()=>({left:100+track.children.filter(item=>!item.hidden).indexOf(card)*336-track.scrollLeft,width:320});
      card.success=card.append(new Node('button',{'data-habit-day':id}));card.edit=card.append(new Node('button',{'data-edit-habit':id}));
      return card;
    });
    return {node,search,track,cards,previous,next,position,count,empty,navigation};
  }
  const context={Date:{now:()=>now}};vm.createContext(context);vm.runInContext(source,context);const api=context.GrowellHabitCarousel;
  function bind(p,owner='owner',route='#/book/'+p.node.getAttribute('data-habit-scope')+'/habit'){const root=new Node();root.append(p.node);api.bindAll(root,owner,route);return root;}
  return {api,panel,bind,document,advance:ms=>{now+=ms;},flush:()=>{while(timers.length)timers.shift()();},reduced:value=>{reduced=value;}};
}

test('search keeps Korean composition and input selection intact, defers rerender, and recovers after no results',()=>{
  const h=harness(),p=h.panel();h.bind(p);p.search.focus({preventScroll:true});
  p.search.emit('compositionstart');p.search.value='박곰';p.search.setSelectionRange(2,2);p.search.emit('input',{isComposing:true});
  assert.equal(p.count.textContent,'내 습관 3개');assert.equal(h.document.activeElement,p.search);
  let renders=0;assert.equal(h.api.beforeRender('owner','#/book/emotion/habit',()=>renders++),true);
  p.search.value='박곰희';p.search.emit('compositionend');
  assert.equal(p.count.textContent,'검색 결과 1개');assert.equal(p.cards[1].hidden,false);assert.equal(p.search.value,'박곰희');assert.equal(p.search.selectionStart,2);
  assert.equal(renders,0);h.flush();assert.equal(renders,1);
  p.search.value='없는 책';p.search.emit('input',{isComposing:false});assert.equal(p.track.hidden,true);assert.equal(p.empty.hidden,false);assert.equal(p.position.textContent,'0 / 0');
  p.search.value='';p.search.emit('input',{isComposing:false});assert.equal(p.track.hidden,false);assert.equal(p.empty.hidden,true);assert.equal(p.count.textContent,'내 습관 3개');assert.equal(h.document.activeElement,p.search);
  assert.equal(h.api.matches('박곰희 투자','박곰희'.normalize('NFD')+' 투자'),true);assert.equal(h.api.matches('책 제목 작가','작가 다른'),false);
});

test('query, selection and active card survive replacement and sorting, with isolated book scope and logout cleanup',()=>{
  const h=harness(),p=h.panel();h.bind(p);p.search.value='';p.search.focus({preventScroll:true});p.search.setSelectionRange(0,0);p.next.click();
  assert.equal(p.position.textContent,'2 / 3');assert.equal(h.api.beforeRender('owner','#/book/emotion/habit',()=>{}),false);
  const replacement=h.panel('emotion',[['three','걷기 공원'],['two','독서 박곰희 투자'],['one','기도 하나님']]);h.bind(replacement);
  assert.equal(replacement.position.textContent,'2 / 3');assert.equal(replacement.track.scrollLeft,336);assert.equal(h.document.activeElement,replacement.search);assert.equal(replacement.search.selectionStart,0);
  replacement.search.value='독서';replacement.search.setSelectionRange(1,2);replacement.search.emit('input',{isComposing:false});
  h.api.beforeRender('owner','#/book/emotion/habit',()=>{});const filtered=h.panel();h.bind(filtered);
  assert.equal(filtered.search.value,'독서');assert.equal(filtered.count.textContent,'검색 결과 1개');assert.equal(filtered.search.selectionStart,1);assert.equal(filtered.search.selectionEnd,2);
  const thought=h.panel('thought');h.api.beforeRender('owner','#/book/thought/habit',()=>{});h.bind(thought);assert.equal(thought.search.value,'');
  const again=h.panel();h.api.beforeRender('owner','#/book/emotion/habit',()=>{});h.bind(again);assert.equal(again.search.value,'독서');
  h.api.beforeRender('another-owner','#/book/emotion/habit',()=>{});const foreign=h.panel();h.bind(foreign,'another-owner');assert.equal(foreign.search.value,'');assert.equal(foreign.position.textContent,'1 / 3');
  foreign.search.value='걷기';foreign.search.emit('input',{});h.bind(h.panel(),'');const relogin=h.panel();h.bind(relogin,'another-owner');assert.equal(relogin.search.value,'');
});

test('mouse dragging from a card or action suppresses the following click before detail, success or edit handlers run',()=>{
  for(const targetName of ['card','success','edit']){
    const h=harness(),p=h.panel();h.bind(p);const card=p.cards[0],target=targetName==='card'?card:card[targetName],calls=[];
    card.addEventListener('click',()=>calls.push('detail'));card.success.addEventListener('click',()=>calls.push('success'));card.edit.addEventListener('click',()=>calls.push('edit'));
    target.emit('pointerdown',{pointerType:'mouse',pointerId:1,button:0,clientX:250,clientY:50});
    const move=p.track.emit('pointermove',{pointerType:'mouse',pointerId:1,clientX:160,clientY:51});assert.equal(move.defaultPrevented,true);assert.ok(p.track.captures.has(1));
    p.track.emit('pointerup',{pointerType:'mouse',pointerId:1});assert.equal(p.position.textContent,'2 / 3');assert.equal(p.track.classes.has('is-dragging'),false);assert.equal(p.track.captures.size,0);
    const click=target.click();assert.equal(click.defaultPrevented,true);assert.equal(click.stopped,true);assert.deepEqual(calls,[]);
    target.click({detail:0});assert.ok(calls.length,'keyboard activation is not discarded after a pointer drag');
    calls.length=0;h.advance(451);target.click();assert.ok(calls.length,'later intentional clicks work normally');
  }
});

test('small pointer movements, vertical gestures and native touch scrolling do not become mouse drags',()=>{
  const h=harness(),p=h.panel();h.bind(p);let clicks=0;p.cards[0].success.addEventListener('click',()=>clicks++);
  p.cards[0].success.emit('pointerdown',{pointerType:'mouse',pointerId:1,button:0,clientX:100,clientY:100});
  p.track.emit('pointermove',{pointerType:'mouse',pointerId:1,clientX:105,clientY:101});p.track.emit('pointerup',{pointerType:'mouse',pointerId:1});p.cards[0].success.click();assert.equal(clicks,1);
  p.cards[0].emit('pointerdown',{pointerType:'mouse',pointerId:2,button:0,clientX:100,clientY:100});
  assert.equal(p.track.emit('pointermove',{pointerType:'mouse',pointerId:2,clientX:102,clientY:120}).defaultPrevented,false);assert.equal(p.track.captures.size,0);
  p.cards[0].emit('pointerdown',{pointerType:'touch',pointerId:3,button:0,clientX:100,clientY:100});
  assert.equal(p.track.emit('pointermove',{pointerType:'touch',pointerId:3,clientX:20,clientY:100}).defaultPrevented,false);assert.equal(p.track.captures.size,0);
  p.track.scrollLeft=672;p.track.emit('scroll');assert.equal(p.position.textContent,'3 / 3');assert.equal(p.next.disabled,true);assert.equal(p.previous.disabled,false);
});

test('arrow controls and track keyboard navigation respect edges and reduced motion without stealing input or action keys',()=>{
  const h=harness(),p=h.panel();h.bind(p);assert.equal(p.previous.disabled,true);
  assert.equal(p.search.emit('keydown',{key:'ArrowRight'}).defaultPrevented,false);
  assert.equal(p.cards[0].edit.emit('keydown',{key:'ArrowRight'}).defaultPrevented,false);assert.equal(p.position.textContent,'1 / 3');
  const end=p.track.emit('keydown',{key:'End'});assert.equal(end.defaultPrevented,true);assert.equal(p.position.textContent,'3 / 3');assert.equal(p.track.lastScroll.behavior,'smooth');
  h.reduced(true);p.previous.click();assert.equal(p.position.textContent,'2 / 3');assert.equal(p.track.lastScroll.behavior,'instant');
  p.track.emit('keydown',{key:'Home'});assert.equal(p.position.textContent,'1 / 3');p.track.emit('keydown',{key:'ArrowLeft'});assert.equal(p.position.textContent,'1 / 3');
  assert.equal(p.track.emit('keydown',{key:'End',ctrlKey:true}).defaultPrevented,false);assert.equal(p.position.textContent,'1 / 3');
});

test('disposing a replaced carousel removes old handlers and does not defer a new account or route for an old composition',()=>{
  const h=harness(),p=h.panel();h.bind(p);p.search.emit('compositionstart');
  assert.equal(h.api.beforeRender('owner','#/book/thought/habit',()=>{}),false);
  const next=h.panel('thought');h.bind(next);p.search.value='old input';p.search.emit('compositionend');p.next.click();
  assert.equal(next.search.value,'');assert.equal(next.position.textContent,'1 / 3');assert.equal((p.search.listeners.input||[]).length,0);assert.equal((p.track.listeners.click||[]).length,0);
  next.search.emit('compositionstart');assert.equal(h.api.beforeRender('other','#/book/thought/habit',()=>{}),false);
  const other=h.panel('thought');h.bind(other,'other');assert.equal(other.search.value,'');
});
