'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Book=require('../bookDetails.js');
const source=fs.readFileSync(path.join(__dirname,'../bookDetails.js'),'utf8');
const book={id:'emotion',title:'감정을 마주하면 길이 보인다',author:'문요한',publisher:'서스테인',cover:'covers/emotion.jpg'};

test('reading position follows verified subsection boundaries and retains chapter context',()=>{
  const rows=Book.details('emotion').chapters;
  assert.deepEqual(rows.map(x=>x.page),[4,15,26,66,124,166,202,244,288,330,360]);
  const cases=[
    [4,'프롤로그','마음의 가시를 빼면 삶은 훨씬 살 만해진다'],
    [15,'','책을 읽기 전에'],
    [26,'1장','왜 그렇게 상대의 비위를 맞춰?'],
    [29,'1장','왜 그렇게 상대의 비위를 맞춰?'],
    [30,'1장','시간이 지나도 풍화되지 않는 감정'],
    [65,'1장','무엇이 핵심 감정을 만드는가?'],
    [66,'2장','핵심 감정은 잘 감추어진다'],
    [73,'2장','핵심 감정은 잘 감추어진다'],
    [74,'2장','나의 핵심 감정은?'],
    [90,'2장','이유 없는 분노는 없다_울분'],
    [91,'2장','그가 늘 냉장고를 가득 채워놓는 이유_만성적 공허감'],
    [124,'3장','상처를 감추느라 자기를 잃어버린 사람들'],
    [165,'3장','이상화 모드: 경험과 상대를 이상화하기'],
    [166,'4장','당신은 원래 그런 사람이 아니다'],
    [169,'4장','당신은 원래 그런 사람이 아니다'],
    [170,'4장','나 또한 감정적으로 미숙한 부모가 아닐까?'],
    [201,'4장','왜 그녀는 자기보다 못한 조건의 사람과 연애를 할까?'],
    [202,'5장','상처는 나의 책임이 아니지만 회복은 나의 몫이다'],
    [243,'5장','큰 결심은 큰 좌절을 빚는다'],
    [244,'6장','몸, 고통과 번영의 진원지'],
    [287,'6장','핵심 감정을 글로 표현해 보자'],
    [288,'7장','메타인지에 기반한 핵심 감정 알아차림'],
    [329,'7장','건강한 감정표현 연습하기'],
    [330,'8장','핵심 감정을 방어하느라 내 인생을 살지 못했다'],
    [359,'8장','삶을 새롭게 빚어내기'],
    [360,'에필로그','그림자가 빛으로 바뀌다']
  ];
  for(const [page,label,title] of cases){
    const section=Book.currentSection('emotion',page);
    assert.equal(section.label,label,`label at ${page}`);
    assert.equal(section.title,title,`title at ${page}`);
  }
  assert.equal(Book.currentSection('emotion',90).chapterId,'chapter-2');
  assert.equal(Book.currentSection('emotion',364).id,'epilogue');
  for(const page of [null,undefined,0,-1,3,365,NaN,Infinity,26.5])assert.equal(Book.currentSection('emotion',page),null);
  assert.equal(Book.currentSection('thought',90),null);
  assert.equal(Book.details('__proto__'),null);
});

test('the full nested contents highlight only the reading subsection and preserve user-provided wording',()=>{
  const html=Book.bodyHtml(book,90);
  assert.equal((html.match(/aria-current="location"/g)||[]).length,1);
  assert.match(html,/is-current[^]*이유 없는 분노는 없다_울분[^]*86쪽/);
  assert.match(html,/<h3>목차<\/h3>/);
  assert.doesNotMatch(html,/장별 목차 요약|감정 이해하기|회복으로 나아가기/);
  assert.match(html,/1부[^]*핵심 감정이란 무엇인가\?/);
  assert.match(html,/2부[^]*핵심 감정의 이해와 치료/);
  assert.equal((html.match(/class="book-toc-sections"/g)||[]).length,8);
  assert.equal(Book.details('emotion').chapters.reduce((total,chapter)=>total+(chapter.sections||[]).length,0),55);
  assert.match(html,/삶을 새롭게 빚어내기/);
  assert.match(html,/첫 본문 쪽수/);
  assert.match(html,/ISBN 9791193388266/);
  assert.match(html,/원래 목차 보기/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.doesNotMatch(Book.bodyHtml(book,null),/aria-current="location"|현재 0쪽/);
  assert.equal(Book.hintHtml('emotion',null),'');
  assert.match(Book.hintHtml('emotion',90),/읽는 부분: 2장/);
  assert.match(Book.hintHtml('emotion',90),/이유 없는 분노는 없다_울분/);
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
