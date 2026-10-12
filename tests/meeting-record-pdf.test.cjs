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

test('long Korean sections flow to multiple complete A4 pages without fixed clipping', async () => {
  const source = fixture();
  source.record.sections = Array.from({ length: 4 }, (_, index) => ({
    summary: `${index + 1}번째 생각 살피기`,
    detail: `${('감정과 생각은 서로 영향을 주며 몸의 움직임과 관계를 맺는다. ').repeat(95)} END_${index + 1}`
  }));
  source.materials[0].url = 'https://example.com/' + 'long-unbroken-resource-path'.repeat(20);
  const pdf = await createMeetingRecordPdf(source), encoded = pdf.toString('latin1');
  const pages = encoded.match(/\/Type \/Page\b/g) || [];
  assert.ok(pages.length >= 4, `expected multi-page PDF, found ${pages.length}`);
  assert.equal((encoded.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, pages.length);
  assert.match(pdf.subarray(-80).toString('latin1'), /%%EOF/);
});

test('compact A4 spacing fits complete editorial and public insight text into a bounded page count', async () => {
  const source = fixture(), drawn = [];
  source.record.sections = [
    { summary: '감정·생각·몸의 균형 살피기', detail: ('감정과 생각과 몸은 서로 영향을 주는 관계이다. 한 영역이 지나치게 높아지거나 낮아지면 다른 영역의 움직임을 조정해 균형을 이룰 수 있다. 사고가 비대해질 때 행동을 활성화하면 머릿속에 머물던 생각을 낮추고 현실에 집중할 수 있다. 균형은 모든 영역을 같은 수준에 맞추는 일이 아니라 지금 필요한 방향으로 조절하는 과정이다.\n\n').repeat(13) + 'END_ONE' },
    { summary: '자신의 감정에 이름 붙이기', detail: ('감정에 이름을 붙이는 것은 지금의 마음을 구체적으로 알아차리는 일이다. 막연한 불편함을 긴장, 서운함, 걱정과 같이 구분하면 원하는 도움이나 필요한 행동을 살필 수 있다. 같은 상황에서도 사람마다 경험과 기대가 다르기 때문에 느끼는 감정은 서로 다를 수 있다. 이름을 붙인 감정은 옳고 그름을 판단할 대상이 아니라 이해할 출발점이다. ').repeat(15) + 'END_TWO' },
    { summary: '감정에 대한 감정 살펴보기', detail: ('감정에 대한 감정은 자신의 마음을 어떻게 바라보고 느끼는지 살피는 개념이다. 슬픔을 느끼면서 자신을 부끄럽게 여기는 마음처럼 한 감정 위에 다른 감정이 더해질 수 있다. 원래의 감정과 그 감정에 대한 해석을 구분하면 자신을 비난하는 습관을 알아차릴 수 있다. 감정을 빠르게 없애기보다 그 감정이 있다는 사실을 인정하고 필요한 반응을 고르는 과정이다. ').repeat(15) + 'END_THREE' }
  ];
  source.insights.push({ authorName: '두 번째 공개 작성자', date: '2026-10-10', q1: '서로의 이야기를 천천히 읽을 수 있어 의미가 있었다.', q2: ('불편한 감정을 빨리 없애려고 했지만 그 안에 내가 바라는 것이 숨어 있음을 살펴보았다. 감정에 이름을 붙이는 일부터 시작해도 좋겠다는 생각이 들었다. ').repeat(15) + 'PUBLIC_END', q3: '나의 마음을 알아차리고 필요한 행동을 작게 선택해 볼 것이다.' });
  source.materials.push({ title: '긴 자료 주소', url: 'https://example.com/' + 'long-unbroken-resource-path'.repeat(23) + '?end=END_RESOURCE' });
  const before = JSON.stringify(source), originalText = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function(value, ...args) {
    if (typeof value === 'string') drawn.push(value);
    return originalText.call(this, value, ...args);
  };
  let pdf;
  try { pdf = await createMeetingRecordPdf(source); }
  finally { PDFDocument.prototype.text = originalText; }
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  // This synthetic long record occupied seven pages before compact spacing.
  // The budget protects paper length without shortening the authored input.
  assert.ok(pageCount >= 4 && pageCount <= 5, `expected four to five complete A4 pages, found ${pageCount}`);
  const rendered = drawn.join('');
  source.record.sections.forEach(item => assert.ok(rendered.includes(item.detail), 'every authored detail must reach the PDF writer'));
  source.insights.forEach(item => ['q1', 'q2', 'q3'].forEach(key => assert.ok(rendered.includes(item[key]), 'every public answer must reach the PDF writer')));
  assert.ok(rendered.includes(source.materials[1].url));
  assert.equal(drawn.filter(value => value === 'GROWELL  |  모임별 기록').length, pageCount, 'every continuation page has a header');
  assert.equal(JSON.stringify(source), before);
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
