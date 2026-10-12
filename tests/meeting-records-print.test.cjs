'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const api=require('../meetingRecordsPrint.js');

class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this._text='';this.classes=new Set();this.classList={add:value=>this.classes.add(value),remove:value=>this.classes.delete(value),contains:value=>this.classes.has(value)};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){throw new Error('Printed member content must never enter innerHTML');}
  appendChild(child){child.parentNode=this;this.children.push(child);return child;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
}
function browser(){
  const listeners=new Map(),document={createElement:tag=>new Element(tag),body:new Element('body'),title:'GROWELL original title'};
  return {document,listeners,printCalls:0,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);},print(){this.printCalls++;}};
}
function record(){return {id:'record-1',bookId:'emotion',round:1,date:'2026-10-11',topic:'감정과 생각의 균형',status:'published',
  sections:[{id:'section-1',summary:'생각과 행동의 상관관계',detail:'  첫 문장이다.\n\n'+('긴 내용도 순서와 줄바꿈을 보존한다. ').repeat(300)+'끝 문장이다.'}],
  concepts:[{id:'concept-1',word:'감정에 대한 감정',meaning:'<script>원문을 변경하지 않는다.</script>\n설명을 그대로 보존한다.'}],
  nextMeeting:{date:'2026-10-18',time:'13:00',place:'모임 장소',reading:'2장',sharing:'통찰을 작성한다.\n다음 내용을 준비한다.',habit:'매일 읽기'},materialIds:['material-1','missing']};}
function walk(node){return [node,...node.children.flatMap(walk)];}

test('A4 print builds complete safe text without mutating or shortening the record and readable insights',()=>{
  const b=browser(),row=record(),insight={id:'insight-1',bookId:'emotion',round:1,name:'가람',answers:['소감 원문','깨달음 원문','실천 원문']};
  const options={bookTitle:'감정의 책',insights:[insight,{...insight,id:'private',private:true,answers:['비공개 답변']},{...insight,id:'hidden',visible:false,answers:['숨긴 답변']},{...insight,id:'other',bookId:'thought',answers:['다른 책 답변']},{...insight,id:'round-2',round:2,answers:['다른 회차 답변']}],
    materials:[{id:'material-1',bookId:'emotion',title:'자료 제목 <img onerror=bad>'},{id:'missing',bookId:'thought',title:'다른 책 자료'}]};
  const before=JSON.stringify({row,options}),sheet=api.buildPrintSheet(b.document,row,options),nodes=walk(sheet);
  assert.ok(nodes.some(node=>node.textContent===row.sections[0].detail),'even text spanning several pages must remain complete');
  assert.ok(nodes.some(node=>node.textContent===row.concepts[0].meaning));
  assert.ok(nodes.some(node=>node.textContent===row.nextMeeting.sharing));
  assert.match(sheet.textContent,/소감 원문.*깨달음 원문.*실천 원문/s);
  assert.doesNotMatch(sheet.textContent,/비공개 답변|숨긴 답변|다른 책 답변|다른 회차 답변|다른 책 자료/);
  assert.equal(nodes.some(node=>['SCRIPT','IMG','IFRAME'].includes(node.tagName)),false);
  assert.match(sheet.textContent,/삭제되었거나 볼 수 없는 자료/);
  assert.equal(nodes.find(node=>node.tagName==='A').attributes.href,'https://growell-book.vercel.app/#/book/emotion/materials/post/material-1');
  assert.equal(JSON.stringify({row,options}),before);
});

test('printing and canceling restore title and remove only the temporary print sheet',()=>{
  const b=browser(),app=new Element('main');b.document.body.appendChild(app);
  const cleanup=api.printRecord(b,record(),{bookTitle:'감정의 책'});
  assert.equal(b.printCalls,1);assert.equal(b.document.body.classList.contains('mr-record-printing'),true);
  assert.equal(b.document.body.children.length,2);assert.match(b.document.title,/1번째 모임/);
  b.listeners.get('afterprint')();cleanup();
  assert.deepEqual(b.document.body.children,[app]);assert.equal(b.document.body.classList.contains('mr-record-printing'),false);
  assert.equal(b.document.title,'GROWELL original title');assert.equal(b.listeners.size,0);
});

test('each printed insight keeps its author, date, and three complete answers together in reading order',()=>{
  const b=browser(),row=record(),answers=['첫 번째 답변 원문\n다음 문장',('긴 깨달음 원문을 보존한다. ').repeat(400)+'끝 답변', '<b>실천 원문 그대로</b>'];
  const insights=[{id:'one',bookId:row.bookId,round:row.round,name:'첫 작성자',date:'2026-10-13',answers},
    {id:'two',bookId:row.bookId,round:row.round,name:'둘째 작성자',date:'2026-10-12',answers:['둘째 소감','둘째 깨달음','둘째 실천']}];
  const before=JSON.stringify(insights),sheet=api.buildPrintSheet(b.document,row,{insights});
  const cards=walk(sheet).filter(item=>item.className==='mr-print-insight');
  assert.equal(cards.length,2);
  cards.forEach((card,index)=>{
    const header=card.children[0];
    assert.equal(header.tagName,'HEADER');
    assert.equal(header.children[0].textContent,insights[index].name);
    assert.equal(header.children[1].textContent,insights[index].date.replace(/-/g,'.'));
    assert.equal(card.children.length,4);
    card.children.slice(1).forEach((answer,questionIndex)=>{
      assert.equal(answer.children[0].tagName,'H4');
      assert.equal(answer.children[0].children[0].textContent,String(questionIndex+1).padStart(2,'0'));
      assert.equal(answer.children[1].textContent,insights[index].answers[questionIndex]);
    });
  });
  assert.equal(JSON.stringify(insights),before);
});

test('print errors never leave a sheet, hidden app, or changed page title behind',()=>{
  const b=browser();b.print=()=>{throw new Error('printing failed');};
  assert.throws(()=>api.printRecord(b,record()),/printing failed/);
  assert.equal(b.document.body.children.length,0);assert.equal(b.document.body.classList.contains('mr-record-printing'),false);
  assert.equal(b.document.title,'GROWELL original title');assert.equal(b.listeners.size,0);
  assert.equal(api.buildPrintSheet(b.document,{sections:null}),null);
});

test('draft and unsaved preview labels remain explicit on printed copies',()=>{
  const b=browser(),row=record();row.status='draft';
  assert.match(api.buildPrintSheet(b.document,row).textContent,/임시 저장 · 나에게만 공개/);
  assert.match(api.buildPrintSheet(b.document,row,{preview:true}).textContent,/작성 중인 내용의 미리보기/);
});
