'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  await assert.rejects(createMeetingRecordPdf(unknownGlyph), /지원하지 않는 문자/);
});
