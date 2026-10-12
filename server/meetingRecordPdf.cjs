'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');

const FONT_REGULAR = path.join(__dirname, 'fonts', 'Pretendard-Regular.otf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'Pretendard-Bold.otf');
const FONT_EMOJI = path.join(__dirname, 'fonts', 'NotoEmoji.ttf');
const COLOR = Object.freeze({ ink: '#263D33', green: '#3A624E', muted: '#67736B', rule: '#DCE3D9' });
const PREPARATION = Object.freeze([['place', '장소'], ['reading', '읽기 범위'], ['sharing', '나눔'], ['habit', '독서 습관']]);
const LIMITS = Object.freeze({ sections: 20, concepts: 30, materials: 30, title: 160, summary: 120, detail: 10000, word: 80, meaning: 4000, url: 2000 });
let fontCoverage;
const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function fonts() {
  if (!fontCoverage) fontCoverage = { normal: fontkit.openSync(FONT_REGULAR), bold: fontkit.openSync(FONT_BOLD), emoji: fontkit.openSync(FONT_EMOJI) };
  return fontCoverage;
}

function fontRuns(value, bold = false) {
  const coverage = fonts(), main = bold ? coverage.bold : coverage.normal;
  const mainName = bold ? 'PretendardBold' : 'Pretendard', result = [];
  for (const item of graphemes.segment(value)) {
    const characters = Array.from(item.segment);
    const supported = font => characters.every(character => /[\r\n\t]/.test(character) || font.hasGlyphForCodePoint(character.codePointAt(0)));
    const font = supported(main) ? mainName : supported(coverage.emoji) ? 'NotoEmoji' : null;
    if (!font) {
      const error = new TypeError('PDF 글꼴에서 지원하지 않는 문자가 있어 원문을 보존한 채 발송을 중단했습니다.');
      error.code = 'PDF_UNSUPPORTED_GLYPH';
      throw error;
    }
    const previous = result[result.length - 1];
    if (previous && previous.font === font) previous.text += item.segment;
    else result.push({ font, text: item.segment });
  }
  return result.length ? result : [{ font: mainName, text: '' }];
}

function text(value, maximum, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value) || Array.from(value).length > maximum) {
    throw new TypeError('모임 기록 PDF의 내용 형식이 올바르지 않습니다.');
  }
  return value;
}

function rows(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('모임 기록 PDF의 항목 형식이 올바르지 않습니다.');
  return value;
}

// Explicit projection is an email privacy boundary. Public, permission-filtered
// round insights are a separate canonical input. Never accept private entries,
// author email/photo, source dumps, or arbitrary unknown object fields.
// Reject oversize/malformed content rather than shortening the saved record.
function editorialContent(input) {
  if (!input || !input.record || typeof input.record !== 'object') throw new TypeError('모임 기록을 확인할 수 없습니다.');
  const record = input.record;
  if (record.status !== undefined && record.status !== 'published') throw new TypeError('게시된 모임 기록만 이메일 PDF로 만들 수 있습니다.');
  if (!Number.isInteger(record.round) || record.round < 1 || record.round > 9999) throw new TypeError('모임 회차가 올바르지 않습니다.');
  const topic = text(record.topic, LIMITS.title);
  if (!topic.trim()) throw new TypeError('모임 주제를 확인할 수 없습니다.');
  const date = text(record.date, 10, true);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('모임 날짜가 올바르지 않습니다.');
  const sections = rows(record.sections, LIMITS.sections).map(item => ({ summary: text(item && item.summary, LIMITS.summary), detail: text(item && item.detail, LIMITS.detail) }));
  const concepts = rows(record.concepts || [], LIMITS.concepts).map(item => ({ word: text(item && item.word, LIMITS.word), meaning: text(item && item.meaning, LIMITS.meaning) }));
  let nextMeeting = null;
  if (record.nextMeeting !== undefined && record.nextMeeting !== null) {
    if (typeof record.nextMeeting !== 'object' || Array.isArray(record.nextMeeting)) throw new TypeError('다음 모임 준비 형식이 올바르지 않습니다.');
    nextMeeting = {};
    for (const [key, max] of [['date', 10], ['time', 5], ['place', 1000], ['reading', 4000], ['sharing', 4000], ['habit', 4000]]) {
      nextMeeting[key] = text(record.nextMeeting[key], max, true);
    }
  }
  const materials = rows(input.materials || [], LIMITS.materials).map(item => {
    const title = text(item && item.title, LIMITS.title), url = text(item && item.url, LIMITS.url, true);
    let safeUrl = '';
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new TypeError('자료 주소가 올바르지 않습니다.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('자료 주소가 올바르지 않습니다.');
      safeUrl = url;
    }
    return { title, url: safeUrl };
  });
  const insights = rows(input.insights || [], 300).map(item => ({
    authorName: text(item && item.authorName, 120), date: text(item && item.date, 64, true),
    q1: text(item && item.q1, 100000, true), q2: text(item && item.q2, 100000, true), q3: text(item && item.q3, 100000, true)
  }));
  const projected = { round: record.round, date, topic, sections, concepts, nextMeeting, bookTitle: text(input.bookTitle, 300, true), materials, insights };
  if (JSON.stringify(projected).length > 1000000) throw new TypeError('PDF에 포함할 전체 내용이 너무 커 원문을 보존한 채 발송을 중단했습니다.');
  return projected;
}

function dateLabel(value) { return value ? value.replace(/-/g, '.') : '날짜 미정'; }

/**
 * Render the published editorial record and allowed public round insights to
 * a buffered A4 PDF. Private records and arbitrary account metadata stay out.
 * No browser, network request, database write, AI call, or source mutation.
 * The caller must obtain an authorized canonical editorial snapshot first.
 */
async function createMeetingRecordPdf(input) {
  const content = editorialContent(input);
  // Validate every outgoing character before starting the stream. Unsupported
  // glyphs must never silently become missing squares or alter the source.
  const strings = [content.topic, content.bookTitle];
  content.sections.forEach(item => strings.push(item.summary, item.detail));
  content.concepts.forEach(item => strings.push(item.word, item.meaning));
  if (content.nextMeeting) strings.push(...Object.values(content.nextMeeting));
  content.materials.forEach(item => strings.push(item.title, item.url));
  content.insights.forEach(item => strings.push(item.authorName, item.q1, item.q2, item.q3));
  strings.forEach(value => { fontRuns(value); fontRuns(value, true); });
  const doc = new PDFDocument({
    size: 'A4', bufferPages: true, autoFirstPage: false, compress: true,
    // PDFKit's implicit Helvetica uses a dynamic package-import loader, which
    // deployment tracing can omit. Initialize from our bundled font instead;
    // every drawn font below is explicitly bundled and embedded as a subset.
    font: FONT_REGULAR,
    margins: { top: 62, right: 48, bottom: 58, left: 48 },
    info: { Title: `GROWELL ${content.round}번째 모임 - ${content.topic}`, Author: 'GROWELL', Creator: 'GROWELL 모임 기록', Subject: '운영자가 정리한 모임 기록' }
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.registerFont('Pretendard', FONT_REGULAR);
  doc.registerFont('PretendardBold', FONT_BOLD);
  doc.registerFont('NotoEmoji', FONT_EMOJI);
  let currentFont = 'Pretendard', currentSize = 10.5, currentColor = COLOR.ink;
  const left = 48, width = 595.28 - 96;
  function style(font = 'Pretendard', size = 10.5, color = COLOR.ink) {
    currentFont = font; currentSize = size; currentColor = color;
    doc.font(font).fontSize(size).fillColor(color);
  }
  doc.on('pageAdded', () => {
    doc.moveTo(left, 47).lineTo(left + width, 47).lineWidth(0.6).strokeColor(COLOR.rule).stroke();
    doc.font(currentFont).fontSize(currentSize).fillColor(currentColor);
    doc.x = left; doc.y = 62;
  });
  doc.addPage();
  function remaining() { return doc.page.height - doc.page.margins.bottom - doc.y; }
  function reserve(height) { if (remaining() < height && doc.y > doc.page.margins.top) doc.addPage(); }
  function write(value, options) {
    const runs = fontRuns(value, currentFont === 'PretendardBold');
    const originalFont = currentFont;
    runs.forEach((run, index) => {
      style(run.font, currentSize, currentColor);
      if (index === 0) doc.text(run.text, left, doc.y, { width, ...options, continued: runs.length > 1 });
      else doc.text(run.text, { width, ...options, continued: index < runs.length - 1 });
    });
    style(originalFont, currentSize, currentColor);
  }
  function paragraph(value, options = {}) {
    style(options.bold ? 'PretendardBold' : 'Pretendard', options.size || 10.5, options.color || COLOR.ink);
    // No fixed height / ellipsis: PDFKit flows every line over page boundaries.
    write(value, { lineGap: 1.7, paragraphGap: 1.5, align: 'left', ...options.text });
    doc.y += options.gap === undefined ? 4 : options.gap;
  }
  function textHeight(value, font, size) {
    const saved = [currentFont, currentSize, currentColor];
    style(font, size);
    const height = doc.heightOfString(value, { width, lineGap: 1.7, paragraphGap: 1.5 });
    style(...saved);
    return height;
  }
  function bodyLinesHeight(count) {
    const saved = [currentFont, currentSize, currentColor];
    style('Pretendard', 10.5);
    const height = count * (doc.currentLineHeight(true) + 1.7);
    style(...saved);
    return height;
  }
  function heading(value, level = 2) {
    const fontSize = level === 2 ? 14 : 11.5;
    style('PretendardBold', fontSize, COLOR.green);
    const height = doc.heightOfString(value, { width, lineGap: 1.7 });
    // Keep the complete short heading and at least two body lines together.
    reserve(height + 5 + bodyLinesHeight(2) + (level === 2 ? 6 : 0));
    if (level === 2) doc.y += 6;
    write(value, { lineGap: 1.7 });
    doc.y += 5;
  }
  paragraph(`${content.round}번째 모임 · ${dateLabel(content.date)}`, { size: 10, color: COLOR.muted, gap: 4 });
  paragraph(content.topic, { bold: true, size: 23, gap: 6 });
  if (content.bookTitle) paragraph(content.bookTitle, { size: 10.5, color: COLOR.muted, gap: 8 });

  heading('핵심 요약');
  content.sections.forEach((item, index) => paragraph(`${index + 1}. ${item.summary}`, { gap: 2 }));
  if (content.concepts.length) {
    heading('함께 살펴본 개념');
    content.concepts.forEach(item => { heading(item.word, 3); paragraph(item.meaning); });
  }
  if (content.sections.length) {
    heading('모임 내용');
    content.sections.forEach((item, index) => { heading(`${index + 1}. ${item.summary}`, 3); paragraph(item.detail); });
  }
  if (content.nextMeeting) {
    const next = content.nextMeeting;
    const preparation = [];
    const when = [next.date ? dateLabel(next.date) : '', next.time].filter(Boolean).join(' · ');
    if (when) preparation.push(['일시', when]);
    PREPARATION.forEach(([key, label]) => { if (next[key].trim()) preparation.push([label, next[key]]); });
    if (preparation.length) {
      heading('다음 모임 준비');
      preparation.forEach(([label, value]) => { heading(label, 3); paragraph(value, { bold: label === '나눔' }); });
    }
  }
  if (content.insights.length) {
    heading('함께 나눈 통찰');
    const labels = [['q1', '모임 소감'], ['q2', '새로운 깨달음'], ['q3', '실천할 배움']];
    content.insights.forEach((item, index) => {
      let date = '';
      if (item.date) {
        const parsed = new Date(item.date);
        date = Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) : item.date;
      }
      // Keep an author/date together with the first answer heading and lines,
      // rather than stranding a member's identity at the bottom of a page.
      // Measure this minimum instead of reserving a fixed 125 pt for each
      // member, which previously left large empty bottoms on shorter pages.
      reserve(textHeight(`${index + 1}. ${item.authorName}`, 'PretendardBold', 11.5) + 5
        + (date ? textHeight(date, 'Pretendard', 9) + 3 : 0)
        + textHeight(labels[0][1], 'PretendardBold', 11.5) + 5 + bodyLinesHeight(2));
      heading(`${index + 1}. ${item.authorName}`, 3);
      if (date) paragraph(date, { size: 9, color: COLOR.muted, gap: 3 });
      labels.forEach(([key, label]) => { heading(label, 3); paragraph(item[key] || '작성한 답변이 없습니다.'); });
    });
  }
  if (content.materials.length) {
    heading('함께 읽고 볼 자료');
    content.materials.forEach((item, index) => {
      style('PretendardBold', 10.5);
      let resourceHeight = doc.heightOfString(`${index + 1}. ${item.title}`, { width, lineGap: 1.7, paragraphGap: 1.5 }) + 6;
      if (item.url) {
        style('Pretendard', 9);
        resourceHeight += doc.heightOfString(item.url, { width, lineGap: 1.7, paragraphGap: 1.5 }) + 8;
      }
      reserve(Math.min(resourceHeight, doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 10));
      paragraph(`${index + 1}. ${item.title}`, { bold: true, gap: item.url ? 2 : 4 });
      if (item.url) paragraph(item.url, { size: 9, color: COLOR.green, text: { link: item.url }, gap: 5 });
    });
  }
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(pages.start + index);
    const previousBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    // Draw page furniture after body flow has finished. Writing a header from
    // pageAdded can inherit PDFKit's active paragraph wrapper on page breaks.
    doc.font('PretendardBold').fontSize(8.5).fillColor(COLOR.green);
    doc.text('GROWELL  |  모임별 기록', left, 29, { width, lineBreak: false });
    doc.font('Pretendard').fontSize(8).fillColor(COLOR.muted);
    doc.text(`${index + 1} / ${pages.count}`, left, doc.page.height - 34, { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = previousBottom;
  }
  doc.end();
  return done;
}

module.exports = { createMeetingRecordPdf, editorialContent };
