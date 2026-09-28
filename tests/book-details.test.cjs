'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Book=require('../bookDetails.js');
const source=fs.readFileSync(path.join(__dirname,'../bookDetails.js'),'utf8');
const book={id:'emotion',title:'감정을 마주하면 길이 보인다',author:'문요한',publisher:'서스테인',cover:'covers/emotion.jpg'};

test('reading position uses the verified first-body page boundaries without inventing divider pages',()=>{
  const rows=Book.details('emotion').chapters;
  assert.deepEqual(rows.map(x=>x.page),[4,15,26,66,124,166,202,244,288,330,360]);
  for(let i=0;i<rows.length;i++){
    assert.equal(Book.currentSection('emotion',rows[i].page).id,rows[i].id);
    if(i>0)assert.equal(Book.currentSection('emotion',rows[i].page-1).id,rows[i-1].id);
  }
  assert.equal(Book.currentSection('emotion',90).id,'chapter-2');
  assert.equal(Book.currentSection('emotion',364).id,'epilogue');
  for(const page of [null,undefined,0,-1,3,365,NaN,Infinity,26.5])assert.equal(Book.currentSection('emotion',page),null);
  assert.equal(Book.currentSection('thought',90),null);
  assert.equal(Book.details('__proto__'),null);
});

test('a popup highlights only the current chapter and labels summarized contents and page-number basis',()=>{
  const html=Book.bodyHtml(book,90);
  assert.equal((html.match(/aria-current="location"/g)||[]).length,1);
  assert.match(html,/is-current[^]*2장[^]*66쪽/);
  assert.match(html,/장별 목차 요약/);
  assert.match(html,/첫 본문 쪽수/);
  assert.match(html,/ISBN 9791193388266/);
  assert.match(html,/원래 목차 보기/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.doesNotMatch(Book.bodyHtml(book,null),/aria-current="location"|현재 0쪽/);
  assert.equal(Book.hintHtml('emotion',null),'');
  assert.match(Book.hintHtml('emotion',90),/읽는 부분: 2장/);
});

test('book markup escapes provided labels and limits details buttons to supported editions',()=>{
  const html=Book.coverHtml({...book,title:'<img onerror="bad">',cover:'" onerror="bad'},'cover" onclick="bad');
  assert.match(html,/aria-haspopup="dialog"/);
  assert.doesNotMatch(html,/<img onerror|src="" onerror|class="cover" onclick/);
  assert.match(html,/&lt;img/);
  assert.doesNotMatch(Book.coverHtml({...book,id:'thought'}),/<button/);
});

function harness(){
  const events={},nodes=[],opened=[],closed=[];
  let member='member-a';
  const trigger={isConnected:true,focused:false,focus(options){this.focused=options;},getAttribute(){return 'emotion';}};
  const c={Number,Object,String,Array,console,addEventListener(name,fn){events[name]=fn;},
    GrowellPopupHistory:{open(key,options){opened.push({key,options});},closed(key){closed.push(key);}},
    document:{activeElement:trigger,body:{appendChild(node){nodes.push(node);}},querySelectorAll(){return [trigger];},createElement(){
      const closeButton={};return {open:false,isConnected:true,events:{},innerHTML:'',setAttribute(){},querySelector(){return closeButton;},
        showModal(){this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},addEventListener(name,fn){this.events[name]=fn;},
        getBoundingClientRect(){return {left:0,right:200,top:0,bottom:300};},closeButton};
    }}};
  c.window=c;vm.createContext(c);vm.runInContext(source,c);
  const api=c.GrowellBookDetails;api.configure({bookById:()=>book,currentPage:()=>90,sessionUserId:()=>member});api.bind();
  return {api,events,nodes,opened,closed,trigger,setMember(value){member=value;},click(){trigger.onclick({preventDefault(){},stopPropagation(){}});}};
}

test('Back, close, and Escape return to the opening cover without navigating away',()=>{
  const h=harness();h.click();
  assert.equal(h.opened[0].key,'book-details');assert.equal(h.nodes[0].open,true);
  h.opened[0].options.close();assert.equal(h.nodes[0].open,false);assert.equal(h.trigger.focused.preventScroll,true);
  h.click();h.nodes[1].closeButton.onclick();assert.equal(h.nodes[1].isConnected,false);
  h.click();let prevented=false;h.nodes[2].events.cancel({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.nodes[2].open,false);assert.equal(h.closed.length,3);
});

test('route and account changes close private reading-position context; stale callbacks do not close a replacement',()=>{
  const h=harness();h.click();const first=h.opened[0];h.click();
  first.options.close();assert.equal(h.nodes[1].open,true);
  h.events.hashchange();assert.equal(h.nodes[1].open,false);
  h.click();h.setMember('member-b');h.api.bind();assert.equal(h.nodes[2].open,false);
  h.click();h.api.reset();assert.equal(h.nodes[3].open,false);
});
