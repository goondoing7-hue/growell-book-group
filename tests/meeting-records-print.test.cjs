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

test('preparation print shows an explicit time range without inventing an old record end time',()=>{
  const b=browser(),row=record();
  assert.match(api.buildPrintSheet(b.document,row).textContent,/2026\.10\.18 · 13:00/);
  assert.doesNotMatch(api.buildPrintSheet(b.document,row).textContent,/13:00~/);
  row.nextMeeting.endTime='15:00';const snapshot=JSON.stringify(row);
  assert.match(api.buildPrintSheet(b.document,row).textContent,/2026\.10\.18 · 13:00~15:00/);
  assert.equal(JSON.stringify(row),snapshot);
});

test('a topic question prints as safe small text directly below its title with its exact body intact',()=>{
  const b=browser(),row=record();row.sections=[{id:'one',summary:'책 내용 주제',detail:'생각 질문: <script>질문 원문</script>\n\n  원문 본문\n다음 문장  '}];
  const before=JSON.stringify(row),sheet=api.buildPrintSheet(b.document,row),story=walk(sheet).find(item=>item.className==='mr-print-story');
  assert.equal(story.children[0].textContent,'1. 책 내용 주제');
  assert.equal(story.children[1].className,'mr-print-topic-question');assert.equal(story.children[1].textContent,'생각 질문: <script>질문 원문</script>');
  assert.equal(story.children[2].textContent,'  원문 본문\n다음 문장  ');assert.equal(walk(story).some(item=>item.tagName==='SCRIPT'),false);
  assert.equal(JSON.stringify(row),before);
});

test('print keeps all sharing cards in source order with only leader explanations visually softened and complete safe text',()=>{
  const b=browser(),row=record(),parts=[{name:'가람',body:'  소감 원문\n다음 문장  '},{name:'리더 나눔',body:'<script>설명 원문</script>'},{name:'다온',body:('긴 소감도 자르지 않는다. ').repeat(400)+'끝 문장'},{name:'리더 나눔',body:'두 번째 설명'}];
  row.sections=[{id:'sharing',summary:'책 나눔: 가람 · 다온',detail:parts.map(part=>part.name+'\n'+part.body).join('\n\n')}];
  const before=JSON.stringify(row),sheet=api.buildPrintSheet(b.document,row),cards=walk(sheet).filter(item=>(item.className||'').split(' ').includes('mr-print-sharing-card'));
  assert.equal(cards.length,4);assert.deepEqual(cards.map(card=>({name:card.children[0].textContent,body:card.children[1].textContent})),parts);
  assert.deepEqual(cards.map(card=>card.className),['mr-print-sharing-card','mr-print-sharing-card mr-print-sharing-card-leader','mr-print-sharing-card','mr-print-sharing-card mr-print-sharing-card-leader']);
  assert.equal(walk(sheet).some(item=>item.tagName==='SCRIPT'),false);assert.equal(JSON.stringify(row),before);
  const css=require('node:fs').readFileSync(require('node:path').join(__dirname,'../meetingRecordsPrint.css'),'utf8');
  assert.match(css,/\.mr-print-sharing-card\{[^}]*break-inside:auto;page-break-inside:auto/);assert.match(css,/\.mr-print-sharing-card\+\.mr-print-sharing-card\{margin-top:9pt/);
  assert.match(css,/\.mr-print-sharing-card\{[^}]*border:\.6pt solid #f0dfb5[^}]*background:#fff7df/);
  assert.match(css,/\.mr-print-sharing-card-leader\{background:#f8f9f7;border-color:#eef0eb;color:#626f66\}/);
  assert.match(css,/\.mr-print-sharing-card-leader \.mr-print-text\{font-size:9\.8pt;line-height:1\.5;color:inherit\}/);
});

test('print preserves the whole original sharing body when participant labels do not form a complete structure',()=>{
  const b=browser(),row=record(),detail='가람\n원문\n\n알 수 없는 사람\n<img> 설명';row.sections=[{id:'sharing',summary:'책 나눔: 가람 · 다온',detail}];
  const before=JSON.stringify(row),sheet=api.buildPrintSheet(b.document,row),nodes=walk(sheet);
  assert.equal(nodes.some(item=>item.className==='mr-print-sharing-card'),false);assert.ok(nodes.some(item=>item.className==='mr-print-text'&&item.textContent===detail));
  assert.equal(nodes.some(item=>item.tagName==='IMG'),false);assert.equal(JSON.stringify(row),before);
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

test('printed thought questions keep full text in order between concepts and stories and omit an empty legacy section',()=>{
  const b=browser(),row=record(),before=JSON.stringify(row);
  assert.doesNotMatch(api.buildPrintSheet(b.document,row).textContent,/생각 질문/);
  row.thoughtQuestions=[{id:'question-1',text:'감정을 어떻게 바라보는가?\n다른 생각은 무엇인가?'},{id:'question-2',text:'<b>질문 원문</b>'}];
  const sheet=api.buildPrintSheet(b.document,row),list=walk(sheet).find(item=>item.className==='mr-print-thought-questions');
  assert.deepEqual(list.children.map(item=>item.textContent),row.thoughtQuestions.map(item=>item.text));
  const headings=walk(sheet).filter(item=>item.tagName==='H2').map(item=>item.textContent);
  assert.equal(headings.indexOf('생각 질문'),headings.indexOf('함께 살펴본 개념')+1);assert.equal(headings.indexOf('모임 내용'),headings.indexOf('생각 질문')+1);
  delete row.thoughtQuestions;assert.equal(JSON.stringify(row),before);
});

function downloadBrowser(fetch){
  const clicked=[],created=[],revoked=[],document={body:new Element('body'),createElement:tag=>{
    const element=new Element(tag);element.click=()=>clicked.push({href:element.href,filename:element.download});return element;
  }};
  return {document,fetch,AbortController,URL:{createObjectURL:blob=>{created.push(blob);return 'blob:synthetic-pdf';},revokeObjectURL:url=>revoked.push(url)},
    print(){throw new Error('PDF download must not print');},clicked,created,revoked};
}
function pdfResponse(extra={}){
  const blob=new Blob(['%PDF-1.3\n'+('synthetic binary content ').repeat(15)+'\n%%EOF']);
  return {ok:true,headers:{get:name=>name.toLowerCase()==='content-type'?'application/pdf':String(blob.size)},blob:async()=>blob,...extra};
}

test('PDF download uses a same-origin authorized request and downloads a complete file without printing',async()=>{
  const calls=[],b=downloadBrowser(async(url,options)=>{calls.push({url,options});return pdfResponse();}),row=record(),before=JSON.stringify(row);
  const result=await api.downloadRecord(b,row,{getAccessToken:async()=> 'synthetic-token',isCurrent:()=>true});
  assert.equal(calls[0].url,'/api/meeting-record-pdf');assert.deepEqual(JSON.parse(calls[0].options.body),{bookId:row.bookId,recordId:row.id});
  assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(calls[0].options.cache,'no-store');assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(b.clicked,[{href:'blob:synthetic-pdf',filename:'GROWELL-meeting-1.pdf'}]);
  assert.deepEqual(b.revoked,['blob:synthetic-pdf']);assert.equal(b.document.body.children.length,0);
  assert.equal(result.filename,'GROWELL-meeting-1.pdf');assert.equal(JSON.stringify(row),before);
});

test('preview download sends only its complete editorial copy without public or private client-side notes',async()=>{
  let sent;const b=downloadBrowser(async(_,options)=>{sent=JSON.parse(options.body);return pdfResponse();}),row=record(),before=JSON.stringify(row);
  await api.downloadRecord(b,row,{preview:true,getAccessToken:async()=> 'synthetic-token',isCurrent:()=>true,insights:['private client note'],materials:['injected material']});
  assert.deepEqual(sent,{preview:row});assert.equal(JSON.stringify(row),before);
});

test('changed sessions or a cancelled download never create a PDF download link',async()=>{
  let resolve,current=true,calls=0;const token=new Promise(r=>resolve=r),b=downloadBrowser(async()=>{calls++;return pdfResponse();});
  const task=api.downloadRecord(b,record(),{getAccessToken:()=>token,isCurrent:()=>current});current=false;resolve('old-token');
  await assert.rejects(task,/계정이나 화면/);assert.equal(calls,0);assert.deepEqual(b.clicked,[]);
  let finish;const response=new Promise(r=>finish=r),c=downloadBrowser(()=>response);
  const cancelled=api.downloadRecord(c,record(),{getAccessToken:async()=> 'synthetic-token',isCurrent:()=>true});
  await Promise.resolve();cancelled.cancel();finish(pdfResponse());await assert.rejects(cancelled,/계정이나 화면/);
  assert.deepEqual(c.created,[]);assert.deepEqual(c.clicked,[]);
});

test('failed, partial or non-PDF responses never download or expose server details',async()=>{
  for(const response of [pdfResponse({ok:false,json:async()=>({error:'PRIVATE PROVIDER DETAILS'})}),
    pdfResponse({headers:{get:()=> 'text/html'}}),pdfResponse({blob:async()=>new Blob(['not a pdf file'])}),
    pdfResponse({blob:async()=>new Blob(['%PDF-'+('incomplete ').repeat(30)])}),
    pdfResponse({headers:{get:name=>name.toLowerCase()==='content-type'?'application/pdf':String(9*1024*1024)}})]){
    const b=downloadBrowser(async()=>response);
    await assert.rejects(api.downloadRecord(b,record(),{getAccessToken:async()=> 'synthetic-token',isCurrent:()=>true}),error=>!error.message.includes('PRIVATE PROVIDER'));
    assert.deepEqual(b.clicked,[]);assert.deepEqual(b.created,[]);
  }
});

test('a record exceeding PDF resource limits reports preservation instead of downloading a clipped file',async()=>{
  const b=downloadBrowser(async()=>pdfResponse({ok:false,json:async()=>({error:'pdf-layout-overflow'})})),row=record(),before=JSON.stringify(row);
  await assert.rejects(api.downloadRecord(b,row,{getAccessToken:async()=> 'synthetic-token',isCurrent:()=>true}),/분량을 초과.*그대로 보존/);
  assert.deepEqual(b.clicked,[]);assert.deepEqual(b.created,[]);assert.equal(JSON.stringify(row),before);
});
