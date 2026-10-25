'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const PDFDocument = require('pdfkit');
const { createMeetingRecordPdf, editorialContent } = require('../server/meetingRecordPdf.cjs');

function fixture() {
  return {
    record: {
      id: 'c4147d3e-43a4-48ed-9f08-477e9b78550d', bookId: 'emotion', round: 1,
      status: 'published', date: '2026-10-10', topic: '감정을 마주하며 균형을 이루기',
      sections: [{ summary: '감정·생각·몸의 균형', detail: '생각이 비대해질 때 행동을 활성화해 균형을 이룬다.\n내용은 원문 그대로이다. 😊' }],
      concepts: [{ word: '감정에 대한 감정', meaning: '자신의 감정을 어떻게 느끼고 해석하는지 살피는 개념이다.' }],
      nextMeeting: { date: '2026-10-24', time: '13:00', place: '작은 도서관', reading: '2장', sharing: '마음을 살펴보고 한 문장을 나눈다.', habit: '매일 10분 읽는다.' },
      insights: [{ answers: ['MEMBER PRIVATE MUST NOT LEAVE'] }], privateEntries: [{ content: 'SECRET JOURNAL' }]
    },
    bookTitle: '감정을 마주하면 길이 보인다', materials: [{ title: '함께 읽을 글', url: 'https://growell-book.vercel.app/#/book/emotion/materials/post/demo' }],
    insights: [{ authorName: '공개 통찰 작성자', date: '2026-10-10', q1: '모임 소감 원문이다.', q2: '새로운 깨달음 원문이다.', q3: '실천할 배움 원문이다.', email: 'MEMBER PRIVATE MUST NOT LEAVE', photo: 'PRIVATE_PHOTO' }], privateEntries: ['SECRET JOURNAL']
  };
}

test('email PDF projection preserves editorial and explicit public insights while excluding private fields', () => {
  const source = fixture(), before = JSON.stringify(source), projected = editorialContent(source);
  assert.equal(projected.sections[0].detail, source.record.sections[0].detail);
  assert.deepEqual(projected.concepts, source.record.concepts);
  assert.deepEqual(projected.nextMeeting, source.record.nextMeeting);
  assert.deepEqual(projected.materials, source.materials);
  assert.deepEqual(projected.insights, [{ authorName: '공개 통찰 작성자', date: '2026-10-10', q1: '모임 소감 원문이다.', q2: '새로운 깨달음 원문이다.', q3: '실천할 배움 원문이다.' }]);
  assert.doesNotMatch(JSON.stringify(projected), /MEMBER PRIVATE|SECRET JOURNAL|privateEntries|PRIVATE_PHOTO/);
  assert.equal(JSON.stringify(source), before);
});

test('thought-question PDF projection keeps exact text and excludes IDs, answers and arbitrary fields',()=>{
  const source=fixture();source.record.thoughtQuestions=[{id:'question-1',text:'  무엇을 느끼는가?\n그 감정은 무엇을 알려주는가?  ',privateAnswer:'MUST NOT EXPORT'}];
  const before=JSON.stringify(source),projected=editorialContent(source);
  assert.deepEqual(projected.thoughtQuestions,[{text:source.record.thoughtQuestions[0].text}]);
  assert.equal(JSON.stringify(source),before);assert.doesNotMatch(JSON.stringify(projected),/MUST NOT EXPORT|question-1/);
  for(const thoughtQuestions of [null,{},'question',[null],[{text:'가'.repeat(1001)}],Array.from({length:31},()=>({text:'질문'}))]){
    assert.throws(()=>editorialContent({...source,record:{...source.record,thoughtQuestions}}),TypeError);
  }
});

test('optional next-meeting end time keeps old records compatible and renders the complete same-day range', async () => {
  const source = fixture(), drawn = [], originalText = PDFDocument.prototype.text;
  assert.equal(Object.hasOwn(editorialContent(source).nextMeeting, 'endTime'), false);
  source.record.nextMeeting = { date: '2026-11-07', time: '13:30', endTime: '15:00', place: '교회 1층 자작나무카페', reading: '2장 66~122페이지', sharing: '', habit: '매일 10분 읽는다.' };
  const before = JSON.stringify(source);assert.equal(editorialContent(source).nextMeeting.endTime, '15:00');
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push(value);return originalText.call(this, value, ...args); };
  try { await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText; }
  assert.ok(drawn.includes('2026.11.07 · 13:30~15:00'));assert.ok(drawn.includes('교회 1층 자작나무카페'));assert.ok(drawn.includes('2장 66~122페이지'));assert.equal(JSON.stringify(source), before);
  for (const times of [{ time: '13:30', endTime: '25:00' }, { time: '13:30', endTime: '13:30' }, { time: '13:30', endTime: '12:00' }, { time: '13:90', endTime: '' }]) assert.throws(() => editorialContent({ ...source, record: { ...source.record, nextMeeting: { ...source.record.nextMeeting, ...times } } }), /시각/);
  assert.equal(editorialContent({...source,record:{...source.record,nextMeeting:{...source.record.nextMeeting,time:'',endTime:'15:00'}}}).nextMeeting.endTime,'15:00');
});

test('a retained end time without a start remains downloadable and is labelled as an end time', async () => {
  const source = fixture(), drawn = [], originalText = PDFDocument.prototype.text;
  source.record.nextMeeting = { ...source.record.nextMeeting, time: '', endTime: '15:00' };
  const before = JSON.stringify(source);
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push(value);return originalText.call(this, value, ...args); };
  let pdf;
  try { pdf = await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText; }
  assert.equal(Buffer.isBuffer(pdf), true);assert.match(pdf.subarray(-80).toString('latin1'), /%%EOF/);
  assert.ok(drawn.includes('2026.10.24 · 15:00 종료'));
  assert.equal(drawn.some(value => value.includes('~15:00')), false, 'no missing start is invented');
  assert.equal(JSON.stringify(source), before);
});

test('a second meeting overview with seven summaries, three concepts and five questions stays on page one of five',async()=>{
  const source=fixture(),drawn=[];
  source.record.round=2;source.record.topic='감정을 알아차리고 나의 경험 이해하기';
  source.record.sections=Array.from({length:7},(_,i)=>({summary:(i+1)+'번째 핵심 요약은 감정과 경험의 관계를 이해하는 것이다.',detail:'감정은 자신의 상태와 필요한 것을 알려주는 신호이다. 감정을 밀어내기보다 몸과 생각의 반응을 함께 살핀다. 서로 다른 경험은 같은 상황에서도 다른 감정을 만든다. 자신의 경험을 이해하고 필요한 행동을 선택한다.'}));
  source.record.concepts=[{word:'심리도식',meaning:'반복된 경험을 통해 형성된 자신과 타인에 대한 생각과 감정의 틀이다.'},{word:'발달트라우마',meaning:'성장 과정에서 반복된 위협이나 관계의 어려움이 마음과 몸에 남긴 영향이다.'},{word:'감정 알아차리기',meaning:'지금 느끼는 감정과 몸의 반응을 판단하지 않고 구체적으로 살피는 것이다.'}];
  source.record.thoughtQuestions=Array.from({length:5},(_,i)=>({id:'question-'+i,text:(i+1)+'번째 질문: 나의 감정은 어떤 경험과 연결되며 무엇을 필요로 하는가?'}));
  const before=JSON.stringify(source),originalText=PDFDocument.prototype.text;
  PDFDocument.prototype.text=function(value,...args){if(typeof value==='string')drawn.push({value,page:this.page,document:this});return originalText.call(this,value,...args);};
  let pdf;try{pdf=await createMeetingRecordPdf(source);}finally{PDFDocument.prototype.text=originalText;}
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,5);
  const successful=drawn.findLast(item=>item.value==='GROWELL  |  모임별 기록').document,items=drawn.filter(item=>item.document===successful);
  const overview=items.find(item=>item.value===source.record.topic).page,details=items.find(item=>item.value==='모임 내용').page;
  assert.equal(items.find(item=>item.value==='생각 질문').page,overview);
  source.record.thoughtQuestions.forEach((item,i)=>assert.equal(items.find(value=>value.value===(i+1)+'. '+item.text).page,overview));
  source.record.sections.forEach(item=>assert.equal(items.find(value=>value.value===item.detail).page,details));
  source.record.sections.forEach((item,index)=>assert.equal(items.filter(value=>value.value===(index+1)+'. '+item.summary).length,2,'legacy outline and body retain the same original numbering'));assert.equal(items.some(value=>value.value==='책 나눔'),false);
  assert.equal(JSON.stringify(source),before);
});

test('actual PDF is a binary A4 attachment with embedded Korean/emoji fonts', async () => {
  const source = fixture(), before = JSON.stringify(source);
  const pdf = await createMeetingRecordPdf(source);
  assert.equal(Buffer.isBuffer(pdf), true);
  assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.3');
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(pdf.toString('latin1'), /\/FontFile3/);
  assert.match(pdf.toString('latin1'), /\/FontFile2/);
  assert.match(pdf.toString('latin1'), /\/ToUnicode/);
  assert.match(pdf.subarray(-80).toString('latin1'), /%%EOF/);
  assert.equal(JSON.stringify(source), before);
});

test('an explicitly labelled topic question is small below its heading without changing stored prose', async()=>{
  const source=fixture(),drawn=[],originalText=PDFDocument.prototype.text;
  source.record.sections=[{summary:'내가 느낀 경험 살피기',detail:'생각 질문: 나는 무엇을 느꼈는가?\n\n느낀 감정을 판단하지 않고 살피는 내용이다.'}];
  const before=JSON.stringify(source);
  PDFDocument.prototype.text=function(value,...args){if(typeof value==='string')drawn.push({value,page:this.page,document:this,size:this._fontSize,y:this.y});return originalText.call(this,value,...args);};
  try{await createMeetingRecordPdf(source);}finally{PDFDocument.prototype.text=originalText;}
  const successful=drawn.findLast(x=>x.value==='GROWELL  |  모임별 기록').document,items=drawn.filter(x=>x.document===successful);
  const heading=items.findLast(x=>x.value==='1. '+source.record.sections[0].summary),question=items.find(x=>x.value==='생각 질문: 나는 무엇을 느꼈는가?'),body=items.find(x=>x.value==='느낀 감정을 판단하지 않고 살피는 내용이다.');
  assert.equal(question.page,heading.page);assert.equal(body.page,heading.page);assert.ok(question.y>heading.y);assert.ok(body.y>question.y);assert.equal(question.size,9.5);assert.equal(body.size,10.5);assert.equal(JSON.stringify(source),before);
});

test('eight glossary definitions retain readable text on overview and seven topics stay on page two of five', async () => {
  const source=fixture(),drawn=[],originalText=PDFDocument.prototype.text;
  source.record.sections=Array.from({length:7},(_,i)=>({summary:(i+1)+'번째 경험에서 나의 감정과 관계를 이해한다.',detail:'어떤 상황에서 느낀 감정인지 생각하며 자신의 반응을 살펴본다. 다양한 경험을 하나의 원인으로 단정하지 않고 필요한 도움을 알아차린다.'}));
  source.record.concepts=Array.from({length:8},(_,i)=>({word:'살펴볼 개념 '+(i+1),meaning:'과거의 여러 경험을 통해 감정과 생각, 몸과 행동이 연결되어 반복되는 반응 체계이다.'}));
  source.record.thoughtQuestions=Array.from({length:5},(_,i)=>({text:(i+1)+'번째 질문: 나는 어떤 경험에서 무엇을 느꼈는가?'}));
  const before=JSON.stringify(source);
  PDFDocument.prototype.text=function(value,...args){if(typeof value==='string')drawn.push({value,page:this.page,document:this,size:this._fontSize,x:args[0]});return originalText.call(this,value,...args);};
  let pdf;try{pdf=await createMeetingRecordPdf(source);}finally{PDFDocument.prototype.text=originalText;}
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,5);
  const successful=drawn.findLast(item=>item.value==='GROWELL  |  모임별 기록').document,items=drawn.filter(item=>item.document===successful);
  const overview=items.find(item=>item.value===source.record.topic).page,details=items.find(item=>item.value==='모임 내용').page;
  source.record.concepts.forEach(item=>{const definition=items.find(value=>value.value===item.meaning);assert.equal(definition.page,overview);assert.equal(definition.size,10.5);assert.equal(items.find(value=>value.value===item.word).page,overview);});
  source.record.thoughtQuestions.forEach(item=>assert.equal(items.find(value=>value.value.endsWith(item.text)).page,overview));
  source.record.sections.forEach(item=>assert.equal(items.find(value=>value.value===item.detail).page,details));
  assert.equal(JSON.stringify(source),before);
});

test('a traced deployment without any implicit standard-font module still renders Korean PDF', () => {
  const code = `
    const Module = require('node:module');
    const original = Module._resolveFilename;
    let blocked = 0;
    Module._resolveFilename = function(request, ...args) {
      if (typeof request === 'string' && request.startsWith('#standard-fonts/')) {
        blocked += 1;
        const error = new Error('Synthetic omitted standard-font module');
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return original.call(this, request, ...args);
    };
    require('./server/meetingRecordPdf.cjs').createMeetingRecordPdf({
      record: { status: 'published', round: 1, date: '2026-10-10', topic: '한국어 모임 기록', sections: [{ summary: '균형', detail: '원문을 보존한 PDF이다. 😊' }], concepts: [] }
    }).then(buffer => {
      if (buffer.subarray(0, 5).toString() !== '%PDF-' || !buffer.subarray(-80).toString().includes('%%EOF')) throw new Error('invalid_binary');
      console.log(JSON.stringify({ rendered: true, bytes: buffer.length, blocked }));
    }).catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, 'PDF must render even when deployment contains no dynamic standard-font modules');
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.rendered, true); assert.ok(result.bytes > 100); assert.equal(result.blocked, 0);
});

test('long valid groups gain natural A4 pages with complete readable text and unchanged source fields', async () => {
  for (const group of ['overview', 'details', 'insights', 'preparation']) {
    const source = fixture(), documents = new Set(), drawn = [];
    if (group === 'overview') source.record.concepts = [{ word: '매우 긴 개념', meaning: '개념의 원문을 그대로 보존한다. '.repeat(180) }];
    if (group === 'details') source.record.sections[0].detail = '감정과 생각과 몸의 관계를 원문 그대로 보존한다. '.repeat(170);
    if (group === 'insights') source.insights[0].q2 = '각자의 경험과 감정을 판단하지 않고 구체적으로 살펴보는 과정이다. '.repeat(350);
    if (group === 'preparation') source.record.nextMeeting.sharing = '다음 모임을 위한 나눔 내용을 원문 그대로 보존한다. '.repeat(120);
    const expected = { overview: source.record.concepts[0].meaning, details: source.record.sections[0].detail, insights: source.insights[0].q2, preparation: source.record.nextMeeting.sharing }[group];
    const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function(value, ...args) {
      documents.add(this);
      if (typeof value === 'string') drawn.push({ value, document: this, size: this._fontSize, options: args.at(-1) });
      return originalText.call(this, value, ...args);
    };
    let pdf;
    try { pdf = await createMeetingRecordPdf(source); }
    finally { PDFDocument.prototype.text = originalText; }
    assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 5, `${group} gains its required pages without forcing an extra empty insight page`);
    const successful = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document;
    const body = drawn.find(item => item.document === successful && item.value === expected);
    assert.ok(body, `${group} source reaches the writer in full`);
    assert.equal(body.size, 10.5);assert.equal(body.options.height, undefined, 'flowing body text has no clipping box');
    assert.equal(JSON.stringify(source), before);
    assert.ok(documents.size >= 2 && documents.size <= 4, 'fixed fit attempts and one natural fallback are bounded');
    assert.ok([...documents].filter(document => document !== successful).every(document => document.destroyed), 'every rejected private stream is closed');
  }
});

test('sixteen full topics, eight definitions and questions keep all text in ordered natural reading groups', async () => {
  const source = fixture(), drawn = [], originalText = PDFDocument.prototype.text;
  source.record.round = 2;
  source.record.sections = Array.from({ length: 16 }, (_, index) => ({
    summary: `${index + 1}번째 주제에서 감정과 관계의 여러 반응을 이해한다.`,
    detail: `${index + 1}번째 내용이다. ` + '자신의 감정과 생각이 어떤 경험에서 비롯되었는지 구체적으로 살핀다. 관계에서 반복되는 반응을 하나의 원인으로 단정하지 않고 현재의 맥락을 함께 이해한다. 불편한 감정에도 나의 바람과 필요를 알려주는 의미가 있으며 안전한 관계와 작은 행동으로 돌봄을 이어 간다.'
  }));
  source.record.concepts = Array.from({ length: 8 }, (_, index) => ({ word: `${index + 1}번째 개념`, meaning: `${index + 1}번째 뜻이다. ` + '반복된 경험에서 형성된 감정과 생각의 틀을 살피며 현재의 반응을 이해하는 개념이다. 개인의 경험은 다양하므로 특정 반응만으로 진단하거나 다른 사람에게 같은 결과를 일반화하지 않는다.' }));
  source.record.thoughtQuestions = Array.from({ length: 5 }, (_, index) => ({ text: `${index + 1}. 나의 경험에서 반복되는 감정과 관계의 반응은 무엇이며, 지금 어떤 바람과 도움이 필요한가?` }));
  source.insights = [];
  const before = JSON.stringify(source);
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push({ value, document: this, page: this.page, size: this._fontSize, options: args.at(-1) }); return originalText.call(this, value, ...args); };
  let pdf;try { pdf = await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText; }
  const count = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(count > 5 && count <= 12);
  const successful = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document, items = drawn.filter(item => item.document === successful);
  const byOrder = items.filter(item => /^\d+ \/ \d+$/.test(item.value)).map(item => item.page), indexOf = page => byOrder.indexOf(page);
  const overview = items.find(item => item.value === source.record.topic), details = items.find(item => item.value === '모임 내용'), insights = items.find(item => item.value === '함께 나눈 통찰'), prep = items.find(item => item.value === '다음 모임 준비');
  assert.ok(indexOf(overview.page) < indexOf(details.page));assert.ok(indexOf(details.page) < indexOf(insights.page));assert.ok(indexOf(insights.page) < indexOf(prep.page));
  source.record.sections.forEach((item, index) => { assert.ok(items.some(value => value.value === `${index + 1}. ${item.summary}`)); const body = items.find(value => value.value === item.detail); assert.ok(body);assert.equal(body.size, 10.5);assert.equal(body.options.height, undefined);assert.ok(indexOf(body.page) >= indexOf(details.page) && indexOf(body.page) < indexOf(insights.page)); });
  source.record.concepts.forEach(item => { assert.ok(items.some(value => value.value === item.word));const body = items.find(value => value.value === item.meaning);assert.ok(body);assert.equal(body.size, 10.5);assert.ok(indexOf(body.page) < indexOf(details.page)); });
  source.record.thoughtQuestions.forEach((item, index) => assert.ok(items.some(value => value.value === `${index + 1}. ${item.text}`)));
  assert.equal(items.filter(item => item.value === '등록된 공개 통찰이 없습니다.').length, 1, 'natural fallback adds no empty second insight page');
  for (let index = 0; index < count; index += 1) assert.ok(items.some(item => item.value === `${index + 1} / ${count}`));
  assert.equal(JSON.stringify(source), before);assert.doesNotMatch(JSON.stringify(editorialContent(source)), /MEMBER PRIVATE|SECRET JOURNAL|PRIVATE_PHOTO/);
});

test('absurd but individually valid content stops at a bounded rendering limit without shortening any source', async () => {
  const source = fixture();source.insights = [{ authorName: '긴 원문 작성자', q1: '', q2: '긴 원문을 모두 보존하며 생성 한도를 확인한다. '.repeat(3700), q3: '' }];
  assert.ok(source.insights[0].q2.length <= 100000);
  const before = JSON.stringify(source), documents = new Set(), originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) { documents.add(this);return originalText.call(this, value, ...args); };
  try { await assert.rejects(createMeetingRecordPdf(source), error => error.code === 'PDF_LAYOUT_OVERFLOW' && error.group === 'resource' && ['page_limit', 'time_limit', 'byte_limit'].includes(error.reason) && !error.message.includes(source.insights[0].q2)); }
  finally { PDFDocument.prototype.text = originalText; }
  assert.equal(JSON.stringify(source), before);assert.ok(documents.size <= 4);assert.ok([...documents].every(document => document.destroyed));
});

test('drafts, malformed fields, unsupported glyphs, and unsafe URLs fail before delivery', async () => {
  const draft = fixture(); draft.record.status = 'draft';
  await assert.rejects(createMeetingRecordPdf(draft), /게시된 모임 기록/);
  const oversize = fixture(); oversize.record.sections[0].detail = '가'.repeat(10001);
  await assert.rejects(createMeetingRecordPdf(oversize), /내용 형식/);
  const invalid = fixture(); invalid.record.concepts[0].meaning = 'a\u0000b';
  await assert.rejects(createMeetingRecordPdf(invalid), /내용 형식/);
  const unsafe = fixture(); unsafe.materials[0].url = 'javascript:alert(1)';
  await assert.rejects(createMeetingRecordPdf(unsafe), /자료 주소/);
  const credentials = fixture(); credentials.materials[0].url = 'https://secret:password@example.com/';
  await assert.rejects(createMeetingRecordPdf(credentials), /자료 주소/);
  const unknownGlyph = fixture(); unknownGlyph.record.sections[0].detail = '지원하지 않는 문자 \u{10FFFF}';
  await assert.rejects(createMeetingRecordPdf(unknownGlyph), error => error.code === 'PDF_UNSUPPORTED_GLYPH' && /지원하지 않는 문자/.test(error.message));
});

test('a public insight flowing across pages three and four preserves all answers with visible author and question context', async () => {
  const source = fixture(), drawn = [];
  source.record.sections = [{ summary: '감정 알아차리기', detail: '내용을 그대로 보존한다.' }];
  source.record.concepts = [];
  source.record.nextMeeting = null;
  source.materials = [];
  source.insights = [{
    authorName: '긴 통찰 작성자', date: '2026-10-10',
    q1: '마음을 살피는 출발점이다. FIRST_ANSWER',
    q2: ('불편한 감정을 판단하기 전에 그 감정이 전하는 마음을 살핀다. 각자의 생각과 경험을 이해할 때 다른 관점을 알아차릴 수 있다.\n\n').repeat(19) + 'LAST_LONG_ANSWER',
    q3: '기록을 읽고 일상에서 작은 행동을 선택한다. LAST_ANSWER'
  }];
  const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) {
    if (typeof value === 'string') drawn.push({ value, size: this._fontSize, options: args.at(-1), document: this });
    return originalText.call(this, value, ...args);
  };
  let pdf;
  try { pdf = await createMeetingRecordPdf(source); }
  finally { PDFDocument.prototype.text = originalText; }
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.equal(pageCount, 5);
  const successfulDocument = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document;
  const finalDrawn = drawn.filter(item => item.document === successfulDocument);
  assert.ok(finalDrawn.some(item => item.value === '1. 긴 통찰 작성자'));
  ['01  모임 소감', '02  새로운 깨달음', '03  실천할 배움'].forEach(label => assert.ok(finalDrawn.some(item => item.value === label)));
  ['q1', 'q2', 'q3'].forEach(key => {
    const answer = finalDrawn.find(item => item.value === source.insights[0][key]);
    assert.ok(answer, 'complete authored answers reach the writer');
    assert.equal(answer.size, 10.5, 'answer font remains readable');
    assert.equal(answer.options.height, undefined, 'answers are never placed inside a clipping box');
  });
  assert.ok(finalDrawn.some(item => item.value === '긴 통찰 작성자 · 새로운 깨달음 · 이어서'), 'continuation identifies the author and active question');
  assert.equal(JSON.stringify(source), before);
});

test('six ordinary public insights produce the five-page reading plan with complete, ordered content', async () => {
  const source = fixture(), drawn = [];
  source.record.sections = [
    { summary: '감정·생각·몸의 균형', detail: '감정과 생각과 몸은 서로 영향을 주는 관계이다. 필요한 영역을 조절해 균형을 이룬다.' },
    { summary: '감정에 대한 감정', detail: '감정을 바라보는 자신의 마음을 살핀다. 원래의 감정과 그에 대한 해석을 구분한다.' },
    { summary: '작은 행동 선택하기', detail: '현재의 마음을 알아차리고 필요한 행동을 작게 선택한다. 일상에서 실천을 이어 간다.' }
  ];
  source.insights = Array.from({ length: 6 }, (_, index) => ({
    authorName: `확인용 회원 ${index + 1}`, date: '2026-10-10',
    q1: `서로의 경험을 천천히 읽을 수 있어 의미가 있었다. 소감 원문 ${index + 1}이다.`,
    q2: `같은 상황에서도 서로 다른 감정을 느낄 수 있음을 알았다. 깨달음 원문 ${index + 1}이다.`,
    q3: `한 주 동안 감정 하나를 기록하고 필요한 행동을 고를 것이다. 실천 원문 ${index + 1}이다.`
  }));
  const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) {
    if (typeof value === 'string') drawn.push({ value, page: this.page, size: this._fontSize, options: args.at(-1), document: this });
    return originalText.call(this, value, ...args);
  };
  let pdf;
  try { pdf = await createMeetingRecordPdf(source); }
  finally { PDFDocument.prototype.text = originalText; }
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 5);
  const successfulDocument = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document;
  const finalDrawn = drawn.filter(item => item.document === successfulDocument);
  const readingPages = [
    finalDrawn.find(item => item.value === source.record.topic).page,
    finalDrawn.find(item => item.value === '모임 내용').page,
    finalDrawn.find(item => item.value === '함께 나눈 통찰').page,
    finalDrawn.find(item => item.value === `4. ${source.insights[3].authorName}`).page,
    finalDrawn.find(item => item.value === '다음 모임 준비').page
  ];
  assert.equal(new Set(readingPages).size, 5, 'each reading group begins on its own page');
  const pageText = readingPages.map(page => finalDrawn.filter(item => item.page === page).map(item => item.value).join(''));
  assert.ok(pageText[0].includes(source.bookTitle));
  source.record.sections.forEach(item => {
    assert.ok(pageText[0].includes(item.summary));
    assert.ok(pageText[1].includes(item.detail));
    assert.equal(pageText[0].includes(item.detail), false, 'details stay off the overview page');
  });
  source.record.concepts.forEach(item => assert.ok(pageText[0].includes(item.word) && pageText[0].includes(item.meaning)));
  source.insights.forEach((item, index) => {
    const page = index < 3 ? 2 : 3;
    assert.ok(pageText[page].includes(`${index + 1}. ${item.authorName}`));
    ['q1', 'q2', 'q3'].forEach(key => {
      assert.ok(pageText[page].includes(item[key]), 'each complete answer stays on its planned insight page');
      assert.equal(finalDrawn.find(value => value.value === item[key]).size, 10.5);
    });
  });
  for (const [key, value] of Object.entries(source.record.nextMeeting)) assert.ok(pageText[4].includes(key === 'date' ? value.replaceAll('-', '.') : value));
  source.materials.forEach(item => assert.ok(pageText[4].includes(item.title) && pageText[4].includes(item.url)));
  assert.equal(pageText[3].includes('함께 나눈 통찰'), false, 'page four has no repeated heading');
  for (const value of [source.record.concepts[0].meaning, source.record.sections[0].detail]) {
    const body = finalDrawn.find(item => item.value === value);
    assert.equal(body.size, 10.5);
    assert.ok(body.options.lineGap >= 2.8, 'overview and details share wider line spacing');
  }
  assert.equal(pageText[1].includes('다음 모임 준비'), false);
  assert.equal(pageText[2].includes('다음 모임 준비'), false);
  assert.equal(JSON.stringify(source), before);
});

test('empty meeting groups retain useful headings and messages across five planned pages', async () => {
  const source = fixture(), drawn = [];
  source.record.sections = [];
  source.record.concepts = [];
  source.record.nextMeeting = null;
  source.insights = [];
  source.materials = [];
  const originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) {
    if (typeof value === 'string') drawn.push({ value, page: this.page });
    return originalText.call(this, value, ...args);
  };
  let pdf;
  try { pdf = await createMeetingRecordPdf(source); }
  finally { PDFDocument.prototype.text = originalText; }
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 5);
  const bodyPages = new Set(drawn.filter(item => item.value.startsWith('등록된') || item.value === '연결된 자료가 없습니다.').map(item => item.page));
  assert.equal(bodyPages.size, 5, 'no planned page is left blank or silently omitted');
});

test('a compact final one-line concept still fits without reserving a nonexistent second body line', async () => {
  const source = fixture();
  source.record.topic = '경계 확인';
  source.record.sections = [];
  source.record.concepts = Array.from({ length: 12 }, (_, index) => ({ word: `${index + 1}번째 개념`, meaning: '짧은 한 줄의 뜻이다.' }));
  source.bookTitle = '';
  const before = JSON.stringify(source), pdf = await createMeetingRecordPdf(source);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 5);
  assert.equal(JSON.stringify(source), before);
});

test('only the explicit trusted preview option permits a draft and leaves the email default unchanged', async () => {
  const source = fixture();
  source.record.status = 'draft';
  source.record.topic = '';
  source.record.date = '';
  source.preview = true;
  source.record.preview = true;
  const before = JSON.stringify(source);
  await assert.rejects(createMeetingRecordPdf(source), /게시된 모임 기록/);
  const projected = editorialContent(source, { preview: true });
  assert.equal(projected.topic, '');
  assert.equal(projected.date, '');
  assert.doesNotMatch(JSON.stringify(projected), /MEMBER PRIVATE|SECRET JOURNAL|PRIVATE_PHOTO/);
  const pdf = await createMeetingRecordPdf(source, { preview: true });
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 5);
  assert.equal(JSON.stringify(source), before);
  await assert.rejects(createMeetingRecordPdf(source), /게시된 모임 기록/);
  source.record.status = 'unknown';
  await assert.rejects(createMeetingRecordPdf(source, { preview: true }), /게시된 모임 기록/);
});

test('a new public author moved to the next page starts a fresh note without a false continuation label', async () => {
  const source = fixture(), drawn = [];
  source.record.topic = '새 통찰 페이지 경계';
  source.record.sections = [];
  source.record.concepts = [];
  source.record.nextMeeting = null;
  source.bookTitle = '';
  source.materials = [];
  source.insights = [
    { authorName: '첫 작성자', q1: '첫 답변이다.', q2: ('서로의 마음을 천천히 읽고 다른 생각을 살펴본다. 불편한 감정 속에 숨은 바람을 이해하는 출발점이다.\n\n').repeat(11), q3: '마지막 답변이다.' },
    { authorName: '다음 작성자 이름을 그대로 보존하는 긴 이름'.repeat(4), q1: '다음 첫 답변이다.', q2: '다음 두 번째 답변이다.', q3: '다음 마지막 답변이다.' }
  ];
  const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) {
    if (typeof value === 'string') drawn.push({ value, page: this.page });
    return originalText.call(this, value, ...args);
  };
  try { await createMeetingRecordPdf(source); }
  finally { PDFDocument.prototype.text = originalText; }
  const firstAuthor = drawn.find(item => item.value === '1. 첫 작성자');
  const nextAuthor = drawn.find(item => item.value === `2. ${source.insights[1].authorName}`);
  assert.ok(firstAuthor && nextAuthor);
  assert.notEqual(firstAuthor.page, nextAuthor.page, 'the second author starts on a new page');
  assert.equal(drawn.some(item => item.page === nextAuthor.page && item.value.endsWith(' · 이어서')), false, 'a fresh note is never labelled as a continued answer');
  assert.equal(JSON.stringify(source), before);
});

test('an emoji author keeps the complete font-fallback name while continuation navigation uses supported glyphs', async () => {
  const source = fixture(), drawn = [], originalText = PDFDocument.prototype.text;
  source.insights = [{ authorName: '마음 😊 작성자', q1: '첫 답변이다.', q2: '서로의 마음을 천천히 살피며 생각과 감정의 차이를 이해하는 내용이다. '.repeat(90), q3: '마지막 답변이다.' }];
  const before = JSON.stringify(source);
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push({ value, document: this, size: this._fontSize }); return originalText.call(this, value, ...args); };
  try { await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText; }
  const successful = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document, items = drawn.filter(item => item.document === successful);
  assert.ok(items.some(item => item.value === '😊' && item.size === 11.5), 'the original author bar preserves the emoji name');
  const continued = items.filter(item => item.value.endsWith(' · 이어서'));assert.ok(continued.length > 0);assert.ok(continued.every(item => !item.value.includes('😊')));assert.ok(continued.some(item => item.value === '통찰 정리 · 새로운 깨달음 · 이어서'));
  assert.equal(JSON.stringify(source), before);
});

test('authored book sharing keeps five participant and four interleaved leader bodies in distinct readable gray cards', async () => {
  const source = fixture(), names = ['별명 하나', '별명 둘', '별명 셋', '별명 넷', '별명 다섯'], drawn = [], boxes = [];
  const order = [names[0], names[1], '리더 나눔', names[2], '리더 나눔', '리더 나눔', names[3], names[4], '리더 나눔'];
  const blocks = order.map((name, index) => ({ name, body: `${index + 1}번째 나눔의 원문이다. ` + '감정과 생각이 어떤 경험에서 비롯되었는지 살피며 마음의 필요를 구체적으로 이해한다. 관계에서 반복되는 반응을 하나의 원인으로 단정하지 않고 현재 상황을 함께 살펴 작은 행동을 선택한다.' }));
  source.record.sections = [{ summary: '책 나눔: ' + names.join(' · '), detail: blocks.map(block => block.name + '\n' + block.body).join('\n\n') }, ...Array.from({ length: 7 }, (_, index) => ({ summary: `다음 내용 ${index + 1}`, detail: `${index + 1}번째 다음 주제의 원문도 그대로 이어진다.` }))];source.insights = [];
  const before = JSON.stringify(source), originalText = PDFDocument.prototype.text, originalBox = PDFDocument.prototype.roundedRect, originalFill = PDFDocument.prototype.fill, originalFillColor = PDFDocument.prototype.fillColor;
  const pendingBox = new WeakMap(), textColors = new WeakMap();
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push({ value, document: this, page: this.page, size: this._fontSize, color: textColors.get(this), y: this.y, options: args.at(-1) });return originalText.call(this, value, ...args); };
  PDFDocument.prototype.fillColor = function(color, ...args) { textColors.set(this, color);return originalFillColor.call(this, color, ...args); };
  PDFDocument.prototype.roundedRect = function(x, y, width, height, ...args) { const box = { document: this, page: this.page, x, y, width, height, bottom: this.page.height - this.page.margins.bottom };boxes.push(box);pendingBox.set(this, box);return originalBox.call(this, x, y, width, height, ...args); };
  PDFDocument.prototype.fill = function(color, ...args) { const box = pendingBox.get(this);if (box) { box.background = color;pendingBox.delete(this); }return originalFill.call(this, color, ...args); };
  let pdf;try { pdf = await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText;PDFDocument.prototype.roundedRect = originalBox;PDFDocument.prototype.fill = originalFill;PDFDocument.prototype.fillColor = originalFillColor; }
  const successful = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document, items = drawn.filter(item => item.document === successful), cards = boxes.filter(item => item.document === successful);
  assert.equal(cards.length, 9);assert.equal(items.filter(item => item.value === '리더 나눔').length, 4);
  const sharingHeading = items.findIndex(item => item.value === '책 나눔'), contentHeading = items.findIndex(item => item.value === '책 내용 및 생각 질문');
  assert.ok(sharingHeading >= 0 && contentHeading > sharingHeading);assert.equal(items.some(item => item.value === '모임 내용'), false);
  const participantLine=items.findIndex(item=>item.value===names.join(' · '));assert.ok(participantLine>sharingHeading&&participantLine<items.findIndex(item=>item.value===blocks[0].body));assert.equal(items.filter(item=>item.value===names.join(' · ')).length,1);
  assert.equal(items.filter(item => item.value === `1. ${source.record.sections[0].summary}`).length, 1, 'the nickname list belongs only in the unchanged core outline');
  source.record.sections.slice(1).forEach((item, index) => {
    const outlineTitle = `${index + 2}. ${item.summary}`, bodyTitle = `${index + 1}. ${item.summary}`;
    const outlinePositions = items.map((entry, position) => entry.value === outlineTitle ? position : -1).filter(position => position >= 0),bodyPositions=items.map((entry,position)=>entry.value===bodyTitle?position:-1).filter(position=>position>=0);
    assert.equal(outlinePositions.length,1,'core numbering remains unchanged');assert.ok(outlinePositions[0]<sharingHeading);assert.equal(bodyPositions.length,1,'body topic numbers restart from one');assert.ok(bodyPositions[0]>contentHeading);
    assert.ok(items.some(entry => entry.value === item.detail));
  });
  let last = -1;
  blocks.forEach((block, index) => { const leader = block.name === '리더 나눔', position = items.findIndex(item => item.value === block.body);assert.ok(position > last);last = position;const body = items[position];assert.equal(body.size, leader ? 10 : 10.5);assert.equal(body.color, leader ? '#6B6B6B' : '#263D33');assert.equal(cards[index].background, leader ? '#F7F7F7' : '#FFFBEF');assert.equal(body.options.height, undefined);assert.equal(body.page, cards[index].page);assert.ok(cards[index].height > 24);assert.ok(cards[index].y + cards[index].height <= cards[index].bottom + 0.1);const label = items.slice(0, position).findLast(item => item.value === block.name);assert.equal(label.size, leader ? 11 : 11.5);assert.equal(label.color, leader ? '#6B6B6B' : '#7C633D'); });
  cards.forEach((card, index) => { if (index && card.page === cards[index - 1].page) assert.ok(card.y - cards[index - 1].y - cards[index - 1].height >= 9.9); });
  assert.ok(items.findIndex(item => item.value === blocks.at(-1).body) < contentHeading, 'every sharing card precedes the second flow');assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);assert.equal(JSON.stringify(source), before);
});

test('an unusually long sharing block flows in full without a fixed card or forced blank page', async () => {
  const source = fixture(), drawn = [], boxes = [], originalText = PDFDocument.prototype.text, originalBox = PDFDocument.prototype.roundedRect;
  const body = '긴 나눔에서도 모든 문장과 의미를 그대로 보존하며 자연스럽게 다음 페이지로 이어진다. '.repeat(150) + '원문의 마지막 문장이다.';
  source.record.sections = [{ summary: '책 나눔: 별명', detail: '별명\n' + body }];source.insights = [];
  const before = JSON.stringify(source);
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push({ value, document: this, size: this._fontSize, options: args.at(-1) });return originalText.call(this, value, ...args); };
  PDFDocument.prototype.roundedRect = function(...args) { boxes.push(this);return originalBox.apply(this, args); };
  let pdf;try { pdf = await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText;PDFDocument.prototype.roundedRect = originalBox; }
  const successful = drawn.findLast(item => item.value === 'GROWELL  |  모임별 기록').document, items = drawn.filter(item => item.document === successful);
  assert.equal(items.filter(item => item.value === '책 나눔').length, 1);assert.equal(items.some(item => item.value === '책 내용 및 생각 질문'), false, 'one sharing section does not manufacture an empty second flow');
  assert.equal(boxes.filter(document => document === successful).length, 0);const full = items.find(item => item.value === body);assert.ok(full);assert.equal(full.size, 10.5);assert.equal(full.options.height, undefined);assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 5);assert.equal(JSON.stringify(source), before);
});

test('ordinary or incompletely labelled details keep their entire original paragraph instead of accidental sharing cards', async () => {
  const source = fixture(), drawn = [], originalText = PDFDocument.prototype.text, originalBox = PDFDocument.prototype.roundedRect;let boxes = 0;
  const body = '별명 하나\n이 내용은 일반 문단으로 보존한다.\n\n리더 나눔\n명단에 있는 다른 별명의 글이 없으므로 임의로 재구성하지 않는다.';
  source.record.sections = [{ summary: '책 나눔: 별명 하나 · 별명 둘', detail: body }];
  const before = JSON.stringify(source);
  PDFDocument.prototype.text = function(value, ...args) { if (typeof value === 'string') drawn.push(value);return originalText.call(this, value, ...args); };
  PDFDocument.prototype.roundedRect = function(...args) { boxes++;return originalBox.apply(this, args); };
  try { await createMeetingRecordPdf(source); } finally { PDFDocument.prototype.text = originalText;PDFDocument.prototype.roundedRect = originalBox; }
  assert.ok(drawn.includes(body));assert.ok(drawn.includes('모임 내용'));assert.ok(drawn.includes('1. '+source.record.sections[0].summary));assert.equal(drawn.includes('책 나눔'), false);assert.equal(drawn.includes('책 내용 및 생각 질문'), false);assert.equal(boxes, 0);assert.equal(JSON.stringify(source), before);
});
