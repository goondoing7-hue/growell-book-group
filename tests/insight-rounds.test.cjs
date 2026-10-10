'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const api=require('../insightRounds.js');
const source=fs.readFileSync(path.join(__dirname,'../insightRounds.js'),'utf8');

function post(id,meetingNo,extra={}){return {id,bookId:'book',noteType:'insight',meetingNo,userName:'작성자 '+id,q1:'소감 '+id,q2:'깨달음 '+id,q3:'실천 '+id,...extra};}
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

test('grouping keeps first-occurrence order, book boundaries, duplicate posts and every original field',()=>{
  const duplicate=post('same','03',{createdAt:100,photo:'keep',attachment:{id:'keep'},q2:'original\nanswer'});
  const posts=frozen([post('a',' ００３ '),{id:'normal',noteType:'thought',html:'normal'},post('other','3',{bookId:'other-book'}),duplicate,post('later','4'),duplicate]);
  const snapshot=JSON.stringify(posts),groups=api.group(posts);
  assert.deepEqual(groups.map(item=>[item.kind,item.round||item.post?.id]),[['round','3'],['post','normal'],['round','3'],['round','4']]);
  assert.deepEqual(groups[0].posts,[posts[0],duplicate,duplicate]);
  assert.equal(groups[0].posts[1],duplicate);assert.equal(groups[0].posts[2],duplicate);
  assert.notEqual(groups[0].key,groups[2].key);assert.equal(JSON.stringify(posts),snapshot);
});

test('unknown or invalid rounds remain visible in one unknown group per book without guessing',()=>{
  const invalid=['',null,'0','-2','2.5','2번째','Infinity','1e2','9007199254740992'];
  const groups=api.group(invalid.map((round,i)=>post(String(i),round)).concat(post('other',null,{bookId:'other'}),post('valid',2)));
  assert.equal(groups.length,3);assert.equal(groups[0].round,'');assert.equal(groups[0].posts.length,invalid.length);
  assert.equal(groups[1].round,'');assert.notEqual(groups[0].key,groups[1].key);assert.equal(groups[2].round,'2');
  assert.deepEqual(api.group(null),[]);
});

test('render uses two rows per page, original links, author controls, dates, counts and complete escaped search text',()=>{
  const posts=Array.from({length:7},(_,i)=>post('p'+i,'3'));
  posts[0]=post('p/"<&>','3',{userName:'이름 <script>',title:'제목 "끝"',q1:'Q1 <script> 원문',q2:'Q2 & "원문"\n다음 줄',q3:'Q3 마지막 검색어',createdAt:123});
  const calls=[];const html=api.renderGroup({id:'book/"<>'},api.group(posts)[0],{
    authorHtml:p=>'<button data-author="'+posts.indexOf(p)+'">안전한 작성자</button>',
    dateText:value=>{calls.push(value);return '<날짜>';},comments:id=>id===posts[0].id?2:0,selectedId:'p5'
  });
  assert.equal((html.match(/data-insight-page=/g)||[]).length,4);assert.equal((html.match(/data-insight-row=/g)||[]).length,7);
  const renderedPages=html.match(/class="insight-round-page"[^>]*>([\s\S]*?)(?=<div class="insight-round-page"|<\/div><div class="insight-round-navigation")/g)||[];
  assert.deepEqual(renderedPages.map(page=>(page.match(/data-insight-row=/g)||[]).length),[2,2,2,1]);
  assert.ok(html.includes('href="#/book/book%2F%22%3C%3E/share/post/p%2F%22%3C%26%3E"'));
  assert.ok(html.includes('Q1 &lt;script&gt; 원문'));assert.ok(html.includes('Q2 &amp; &quot;원문&quot;\n다음 줄'));assert.ok(html.includes('Q3 마지막 검색어'));
  assert.ok(html.includes('제목 &quot;끝&quot;'));assert.ok(html.includes('이름 &lt;script&gt;'));assert.ok(html.includes('&lt;날짜&gt;'));
  assert.ok(html.includes('댓글 2'));assert.ok(html.includes('1–2 / 7'));assert.ok(html.includes('data-insight-selected="true"'));
  assert.ok(html.includes('이전 기록 2개'));assert.ok(html.includes('다음 기록 2개'));assert.ok(html.includes('한 번에 2개씩'));
  assert.doesNotMatch(html,/이전 기록 3개|다음 기록 3개|data-insight-visible-rows="3"/);
  assert.ok(html.includes('class="insight-round-number" aria-hidden="true">03</span>'));assert.ok(html.includes('최근 기록 &lt;날짜&gt;'));
  assert.ok(html.includes('<button data-author="0">'));assert.equal(calls[0],123);
  assert.doesNotMatch(html,/<script>|class="[^"]*feed-tile/);
});

test('preview favors the original q2 and falls back to q1, q3 or an honest empty state without mutating answers',()=>{
  for(const [answers,label,preview] of [
    [{q1:'소감',q2:'  깨달음 원문  ',q3:'실천'},'새로운 깨달음','  깨달음 원문  '],
    [{q1:'소감 원문',q2:'  ',q3:'실천'},'모임 소감','소감 원문'],
    [{q1:'',q2:null,q3:'실천 원문'},'실천할 배움','실천 원문'],
    [{q1:'',q2:'',q3:''},'통찰 정리','아직 작성된 답변이 없어요.']
  ]){
    const p=frozen(post('id','',answers)),html=api.renderGroup({id:'book'},api.group([p])[0]);
    assert.ok(html.includes('insight-round-answer-label">'+label));assert.ok(html.includes('insight-round-answer-text">'+preview+'</p>'));
    assert.ok(html.includes('회차 미지정 모임'));
  }
});

test('the header opens operator records for the same book and normalized valid round with escaped attributes',()=>{
  const bookId='book/" onfocus="attack()\'><svg>',entry=api.group([post('one',' ００３ ',{bookId})])[0];
  const html=api.renderGroup({id:bookId},entry),header=html.match(/<header class="insight-round-header">([\s\S]*?)<\/header>/)[1];
  assert.equal((header.match(/data-meeting-records=/g)||[]).length,1);
  assert.ok(header.includes('data-meeting-records="book/&quot; onfocus=&quot;attack()&#39;&gt;&lt;svg&gt;"'));
  assert.ok(header.includes('data-meeting-round="3"'));assert.ok(header.includes('aria-haspopup="dialog"'));
  assert.ok(header.includes('aria-label="3번째 모임 기록 보기"'));assert.ok(header.includes('>모임 기록 보기 <span aria-hidden="true">↗</span></button>'));
  assert.ok(header.indexOf('insight-round-records')>header.indexOf('insight-round-header-copy'));
  assert.doesNotMatch(header,/<svg>|\sonfocus="/);
  const boundary=api.renderGroup({id:'book'},api.group([post('one','9999')])[0]);assert.ok(boundary.includes('data-meeting-round="9999"'));
});

test('unknown, invalid and unsupported rounds keep their insight rows without a misleading meeting records button',()=>{
  for(const round of ['',null,'0','-1','3.2','3번째','1e2','10000','<img onerror="attack()">']){
    const html=api.renderGroup({id:'book'},api.group([post('one',round)])[0]);
    assert.doesNotMatch(html,/data-meeting-records=|data-meeting-round=|class="insight-round-records"/);
    assert.ok(html.includes('data-insight-row="one"'));assert.ok(html.includes('href="#/book/book/share/post/one"'));
  }
});

function harness(){
  let now=1000,reduced=false,width=320,asyncSmooth=false;const observers=[];
  const win={matchMedia:()=>({matches:reduced}),ResizeObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnected=true;}}};
  const document={activeElement:null,defaultView:win,createElement:tag=>new Node(tag)};
  function match(node,selector){
    return selector.split(',').some(part=>{
      part=part.trim();
      if(part[0]==='['){const [,name,value]=part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return node.hasAttribute(name)&&(value===undefined||node.getAttribute(name)===value);}
      return node.tagName===part.toUpperCase();
    });
  }
  class Node{
    constructor(tag='div',attrs={}){this.tagName=tag.toUpperCase();this.attrs={...attrs};this.children=[];this.parentNode=null;this.ownerDocument=document;this.listeners={};this.hidden=false;this.disabled=false;this.textContent='';this.scrollLeft=0;this.isConnected=true;this.classes=new Set();this.captures=new Set();this.classList={add:value=>this.classes.add(value),remove:value=>this.classes.delete(value)};}
    get clientWidth(){return width;}
    appendChild(node){if(node.parentNode)node.parentNode.children=node.parentNode.children.filter(child=>child!==node);node.parentNode=this;this.children.push(node);return node;}
    replaceChildren(...nodes){this.children.forEach(node=>{node.parentNode=null;});this.children=[];nodes.forEach(node=>this.appendChild(node));}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
    contains(node){return node===this||this.all().includes(node);}
    hasAttribute(name){return Object.hasOwn(this.attrs,name);}
    getAttribute(name){return this.hasAttribute(name)?this.attrs[name]:null;}
    setAttribute(name,value){this.attrs[name]=String(value);}
    removeAttribute(name){delete this.attrs[name];}
    matches(selector){return match(this,selector);}
    querySelectorAll(selector){return this.all().filter(node=>match(node,selector));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    closest(selector){for(let node=this;node;node=node.parentNode)if(match(node,selector))return node;return null;}
    addEventListener(type,fn,options){(this.listeners[type]||(this.listeners[type]=[])).push({fn,capture:options===true||!!options?.capture});}
    removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(item=>item.fn!==fn);}
    emit(type,extra={}){
      const event={target:this,detail:1,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};
      const ancestors=[];for(let node=this;node;node=node.parentNode)ancestors.push(node);
      for(const [nodes,capture] of [[ancestors.slice().reverse(),true],[ancestors,false]])for(const node of nodes)for(const listener of node.listeners[type]||[]){if(listener.capture===capture){listener.fn(event);if(event.stopped)return event;}}
      return event;
    }
    click(extra={}){return this.disabled?null:this.emit('click',extra);}
    focus(options){assert.equal(options.preventScroll,true);document.activeElement=this;}
    setPointerCapture(id){this.captures.add(id);}
    hasPointerCapture(id){return this.captures.has(id);}
    releasePointerCapture(id){this.captures.delete(id);}
    getBoundingClientRect(){return {left:this.hasAttribute('data-insight-page')?100+this.parentNode.children.indexOf(this)*width-this.parentNode.scrollLeft:100,width};}
    scrollTo(options){this.lastScroll=options;if(asyncSmooth&&options.behavior==='smooth')return;this.scrollLeft=options.left;this.emit('scroll');}
  }
  function panel(length=7,selected=-1){
    const node=new Node('section',{'data-insight-round':'book,3'}),track=node.appendChild(new Node('div',{'data-insight-track':''}));
    const previous=node.appendChild(new Node('button',{'data-insight-prev':''})),next=node.appendChild(new Node('button',{'data-insight-next':''}));
    const position=node.appendChild(new Node('span',{'data-insight-position':''})),count=node.appendChild(new Node('span',{'data-insight-count':''}));
    const rows=[];
    for(let i=0;i<length;i++){
      if(i%2===0)track.appendChild(new Node('div',{'data-insight-page':String(i/2)}));
      const row=track.children.at(-1).appendChild(new Node('article',{'data-insight-row':'p'+i,'data-insight-search':'작성자'+i+' '+(i%2?'독서 함께':'기도 함께')+' Q1끝'+i+' Q2끝'+i+' Q3끝'+i,'data-insight-selected':i===selected?'true':'false'}));
      row.link=row.appendChild(new Node('a',{href:'#/book/book/share/post/p'+i}));row.author=row.appendChild(new Node('button',{'data-community-author':'u'+i}));rows.push(row);
    }
    return {node,track,rows,previous,next,position,count};
  }
  const context={Date:{now:()=>now}};vm.createContext(context);vm.runInContext(source,context);
  const localApi=context.GrowellInsightRounds,root=new Node('main');
  function bind(p){root.appendChild(p.node);localApi.bind(root);return root;}
  return {api:localApi,panel,bind,root,document,observers,reduced:value=>{reduced=value;},smooth:value=>{asyncSmooth=value;},advance:ms=>{now+=ms;},resize:value=>{width=value;observers.filter(observer=>!observer.disconnected).forEach(observer=>observer.fn());}};
}

test('two-row pages navigate to both edges with keyboard and buttons, resize correctly and bind once',()=>{
  const h=harness(),p=h.panel();h.bind(p);h.api.bind(h.root);
  assert.equal(p.position.textContent,'1–2 / 7');assert.equal(p.previous.disabled,true);assert.equal(p.next.listeners.click.length,1);
  p.next.click();assert.equal(p.position.textContent,'3–4 / 7');assert.equal(p.track.scrollLeft,320);assert.equal(p.track.lastScroll.behavior,'smooth');
  h.resize(215);assert.equal(p.track.scrollLeft,215);assert.equal(p.position.textContent,'3–4 / 7');
  h.reduced(true);p.next.click();assert.equal(p.position.textContent,'5–6 / 7');assert.equal(p.next.disabled,false);assert.equal(p.track.lastScroll.behavior,'instant');
  p.next.click();assert.equal(p.position.textContent,'7–7 / 7');assert.equal(p.next.disabled,true);assert.equal(p.track.scrollLeft,645);
  assert.equal(p.track.emit('keydown',{key:'Home'}).defaultPrevented,true);assert.equal(p.position.textContent,'1–2 / 7');
  p.track.emit('keydown',{key:'ArrowLeft'});assert.equal(p.position.textContent,'1–2 / 7');
  p.track.emit('keydown',{key:'End',ctrlKey:true});assert.equal(p.position.textContent,'1–2 / 7');
  p.rows[0].author.emit('keydown',{key:'End'});assert.equal(p.position.textContent,'1–2 / 7');
  p.track.emit('keydown',{key:'End'});assert.equal(p.position.textContent,'7–7 / 7');
});

test('one or two records fit one page while three records keep the third original on a second page',()=>{
  for(const length of [1,2,3]){
    const originals=frozen(Array.from({length},(_,i)=>post('original-'+i,'2',{createdAt:100+i,attachment:{id:'attachment-'+i}})));
    const snapshot=JSON.stringify(originals),html=api.renderGroup({id:'book'},api.group(originals)[0]);
    assert.equal((html.match(/data-insight-page=/g)||[]).length,length===3?2:1);
    assert.ok(html.includes('data-insight-visible-rows="'+Math.min(2,length)+'"'));
    for(const original of originals){assert.ok(html.includes('/share/post/'+original.id));assert.ok(html.includes(original.q1));assert.ok(html.includes(original.q2));assert.ok(html.includes(original.q3));}
    assert.equal(JSON.stringify(originals),snapshot);
    const h=harness(),p=h.panel(length);h.bind(p);
    assert.equal(p.position.textContent,'1–'+Math.min(2,length)+' / '+length);assert.equal(p.next.disabled,length<=2);
    if(length===3){
      const last=p.rows[2];p.next.click();assert.equal(p.position.textContent,'3–3 / 3');assert.equal(p.next.disabled,true);
      assert.equal(p.track.children[1].children[0],last);assert.equal(p.node.getAttribute('data-insight-visible-rows'),'2');
      p.previous.click();assert.equal(p.position.textContent,'1–2 / 3');assert.deepEqual(p.track.querySelectorAll('[data-insight-row]'),p.rows);
    }
  }
});

test('offscreen pages are inert and untabbable, active links restore their original tabindex and selected rows are revealed',()=>{
  const h=harness(),p=h.panel(7,3);p.rows[0].link.setAttribute('tabindex','2');h.bind(p);
  assert.equal(p.position.textContent,'3–4 / 7');assert.equal(p.track.children[0].inert,true);assert.equal(p.track.children[1].inert,false);
  assert.equal(p.rows[0].link.getAttribute('tabindex'),'-1');assert.equal(p.rows[3].link.hasAttribute('tabindex'),false);
  h.document.activeElement=p.rows[3].link;p.previous.click();assert.equal(h.document.activeElement,p.track);
  assert.equal(p.rows[0].link.getAttribute('tabindex'),'2');assert.equal(p.rows[3].link.getAttribute('tabindex'),'-1');
  assert.equal(p.track.children[0].getAttribute('aria-hidden'),'false');assert.equal(p.track.children[1].getAttribute('aria-hidden'),'true');
});

test('rapid navigation uses the latest requested page while earlier animation frames and scrollend events arrive',()=>{
  const h=harness(),p=h.panel(10);h.bind(p);h.smooth(true);
  p.next.click();assert.equal(p.track.lastScroll.left,320);assert.equal(p.position.textContent,'3–4 / 10');
  p.track.scrollLeft=45;p.track.emit('scroll');assert.equal(p.position.textContent,'3–4 / 10');
  p.next.click();assert.equal(p.track.lastScroll.left,640);assert.equal(p.position.textContent,'5–6 / 10');
  p.track.scrollLeft=320;p.track.emit('scroll');p.track.emit('scrollend');assert.equal(p.position.textContent,'5–6 / 10');
  p.next.click();assert.equal(p.track.lastScroll.left,960);assert.equal(p.position.textContent,'7–8 / 10');assert.equal(p.next.disabled,false);
  p.next.click();assert.equal(p.track.lastScroll.left,1280);assert.equal(p.position.textContent,'9–10 / 10');assert.equal(p.next.disabled,true);
  p.previous.click();assert.equal(p.track.lastScroll.left,960);assert.equal(p.position.textContent,'7–8 / 10');
  p.track.scrollLeft=960;p.track.emit('scroll');p.track.emit('scrollend');assert.equal(p.position.textContent,'7–8 / 10');
  p.previous.click();assert.equal(p.track.lastScroll.left,640);p.track.scrollLeft=460;p.track.emit('scroll');
  p.track.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:200,clientY:20});assert.equal(p.track.lastScroll.behavior,'instant');assert.equal(p.track.lastScroll.left,460);
  p.track.scrollLeft=0;p.track.emit('scroll');assert.equal(p.position.textContent,'1–2 / 10');
});

test('search repaginates matching original rows, searches all answers, hides empty groups and restores every original node',()=>{
  const h=harness(),p=h.panel(),other=h.panel(2);h.bind(p);h.bind(other);const original=p.rows.slice();
  assert.equal(p.node.getAttribute('data-insight-visible-rows'),'2');assert.equal(other.node.getAttribute('data-insight-visible-rows'),'2');
  assert.equal(h.api.filter(h.root,'기도 함께'),5);assert.equal(p.position.textContent,'1–2 / 4');
  assert.deepEqual(p.track.querySelectorAll('[data-insight-row]'),[original[0],original[2],original[4],original[6]]);
  assert.deepEqual(p.track.children.map(page=>page.children.length),[2,2]);p.next.click();assert.equal(p.position.textContent,'3–4 / 4');
  for(const key of ['Q1끝6','Q2끝6','Q3끝6']){assert.equal(h.api.filter(h.root,key),1);assert.equal(p.track.querySelectorAll('[data-insight-row]')[0],original[6]);assert.equal(other.node.hidden,true);assert.equal(p.node.getAttribute('data-insight-visible-rows'),'1');}
  assert.equal(h.api.filter(h.root,'없는 검색어'),0);assert.equal(p.node.hidden,true);assert.equal(p.position.textContent,'0 / 0');
  assert.equal(h.api.filter(h.root,''),9);assert.equal(p.node.hidden,false);assert.equal(other.node.hidden,false);
  assert.deepEqual(p.track.querySelectorAll('[data-insight-row]'),original);assert.deepEqual(p.track.children.map(page=>page.children.length),[2,2,2,1]);
  assert.equal(p.node.getAttribute('data-insight-visible-rows'),'2');p.track.emit('keydown',{key:'End'});assert.equal(p.node.getAttribute('data-insight-visible-rows'),'2');assert.equal(p.position.textContent,'7–7 / 7');
  assert.equal(api.matches('한글 질문 답변','한글'.normalize('NFD')+' 답변'),true);assert.equal(api.matches('질문 답변','질문 없음'),false);
});

test('mouse drag starting on a link or author suppresses the next pointer click but preserves keyboard and later clicks',()=>{
  for(const name of ['link','author']){
    const h=harness(),p=h.panel();h.bind(p);const target=p.rows[0][name];let calls=0;target.addEventListener('click',()=>calls++);
    target.emit('pointerdown',{pointerType:'mouse',pointerId:1,button:0,clientX:250,clientY:50});
    assert.equal(p.track.emit('pointermove',{pointerId:1,clientX:160,clientY:51}).defaultPrevented,true);
    p.track.emit('pointerup',{pointerId:1});assert.equal(p.position.textContent,'3–4 / 7');assert.equal(p.track.captures.size,0);
    const click=target.click();assert.equal(click.defaultPrevented,true);assert.equal(calls,0);
    target.click({detail:0});assert.equal(calls,1);h.advance(451);target.click();assert.equal(calls,2);
  }
});

test('clicks and vertical gestures remain usable, native touch scroll updates pages, cancelled drags restore snap and disposal removes handlers',()=>{
  const h=harness(),p=h.panel();h.bind(p);let calls=0;p.rows[0].link.addEventListener('click',()=>calls++);
  p.rows[0].link.emit('pointerdown',{pointerType:'mouse',pointerId:1,button:0,clientX:100,clientY:100});
  p.track.emit('pointermove',{pointerId:1,clientX:104,clientY:101});p.track.emit('pointerup',{pointerId:1});p.rows[0].link.click();assert.equal(calls,1);
  p.track.emit('pointerdown',{pointerType:'mouse',pointerId:2,button:0,clientX:100,clientY:100});
  assert.equal(p.track.emit('pointermove',{pointerId:2,clientX:102,clientY:130}).defaultPrevented,false);assert.equal(p.track.captures.size,0);
  p.track.emit('pointerdown',{pointerType:'touch',pointerId:3,button:0,clientX:100,clientY:100});
  assert.equal(p.track.emit('pointermove',{pointerId:3,clientX:10,clientY:100}).defaultPrevented,false);
  p.track.scrollLeft=960;p.track.emit('scroll');assert.equal(p.position.textContent,'7–7 / 7');
  p.track.emit('pointerdown',{pointerType:'mouse',pointerId:4,button:0,clientX:100,clientY:100});
  p.track.emit('pointermove',{pointerId:4,clientX:190,clientY:100});p.track.emit('pointercancel',{pointerId:4});assert.equal(p.track.classes.has('is-dragging'),false);
  p.node.isConnected=false;h.root.replaceChildren();h.api.bind(h.root);assert.equal(p.track.listeners.click.length,0);assert.equal(h.observers[0].disconnected,true);
});
