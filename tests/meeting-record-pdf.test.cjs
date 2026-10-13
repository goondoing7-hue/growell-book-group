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

test('unfit content fails with a safe group error and leaves every original field intact', async () => {
  for (const group of ['overview', 'details', 'insights', 'preparation']) {
    const source = fixture(), documents = new Set();
    if (group === 'overview') source.record.concepts = [{ word: '매우 긴 개념', meaning: '개념의 원문을 그대로 보존한다. '.repeat(180) }];
    if (group === 'details') source.record.sections[0].detail = '감정과 생각과 몸의 관계를 원문 그대로 보존한다. '.repeat(170);
    if (group === 'insights') source.insights[0].q2 = '각자의 경험과 감정을 판단하지 않고 구체적으로 살펴보는 과정이다. '.repeat(350);
    if (group === 'preparation') source.record.nextMeeting.sharing = '다음 모임을 위한 나눔 내용을 원문 그대로 보존한다. '.repeat(120);
    const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
    PDFDocument.prototype.text = function(value, ...args) {
      documents.add(this);
      return originalText.call(this, value, ...args);
    };
    try { await assert.rejects(createMeetingRecordPdf(source), error => error.code === 'PDF_LAYOUT_OVERFLOW' && error.group === group); }
    finally { PDFDocument.prototype.text = originalText; }
    assert.equal(JSON.stringify(source), before);
    assert.ok(documents.size >= 3 && documents.size <= 6, 'fit attempts are bounded');
    assert.ok([...documents].every(document => document.destroyed), 'every rejected private stream is closed');
  }
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
