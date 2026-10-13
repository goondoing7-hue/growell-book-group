'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');

const FONT_REGULAR = path.join(__dirname, 'fonts', 'Pretendard-Regular.otf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'Pretendard-Bold.otf');
const FONT_EMOJI = path.join(__dirname, 'fonts', 'NotoEmoji.ttf');
const COLOR = Object.freeze({ ink: '#263D33', green: '#3A624E', muted: '#67736B', rule: '#DCE3D9', pale: '#EDF2E9', accent: '#9EB5A0' });
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
function editorialContent(input, options = {}) {
  if (!input || !input.record || typeof input.record !== 'object') throw new TypeError('모임 기록을 확인할 수 없습니다.');
  const record = input.record;
  // Only an already-authorized server preview route can opt into drafts.
  // Request payload fields are never treated as this option; the default
  // email/worker path remains published-only and uses its canonical snapshot.
  const preview = options.preview === true;
  if (record.status !== undefined && record.status !== 'published' && !(preview && record.status === 'draft')) throw new TypeError('게시된 모임 기록만 이메일 PDF로 만들 수 있습니다.');
  if (!Number.isInteger(record.round) || record.round < 1 || record.round > 9999) throw new TypeError('모임 회차가 올바르지 않습니다.');
  const topic = text(record.topic, LIMITS.title);
  if (!topic.trim() && !preview) throw new TypeError('모임 주제를 확인할 수 없습니다.');
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
async function createMeetingRecordPdf(input, options = {}) {
  const content = editorialContent(input, options);
  // Try only readable, bounded layouts. The common overview/detail body stays
  // 10.5 pt with wider leading; only insights may reach a 10 pt floor. Every
  // attempt is buffered in memory, so no partial or extra-page PDF is exposed.
  const layouts = [
    { side: 48, bottom: 58, lineGap: 3, insightGap: 1.7, insightSize: 10.5, topicBefore: 12, sectionBefore: 14, scale: 1 },
    { side: 44, bottom: 50, lineGap: 3, insightGap: 1.7, insightSize: 10.5, topicBefore: 10, sectionBefore: 12, scale: 0.75 },
    { side: 44, bottom: 48, lineGap: 2.8, insightGap: 1.5, insightSize: 10, topicBefore: 10, sectionBefore: 12, scale: 0.65 }
  ];
  let failure;
  for (const layout of layouts) {
    try { return await renderMeetingRecordPdf(content, layout); }
    catch (error) {
      if (error.code !== 'PDF_LAYOUT_OVERFLOW') throw error;
      failure = error;
      if (error.group === 'insights') {
        // Fallback glyph widths may differ from the author-height estimate.
        // Certify a continuous two-page flow before reducing readability.
        try { return await renderMeetingRecordPdf(content, { ...layout, flowOnly: true }); }
        catch (flowError) {
          if (flowError.code !== 'PDF_LAYOUT_OVERFLOW') throw flowError;
          failure = flowError;
        }
      }
    }
  }
  throw failure;
}

function layoutOverflow(group) {
  const error = new Error('원문을 모두 포함하는 5페이지 PDF에 분량이 맞지 않습니다. 저장된 내용은 변경하지 않았습니다.');
  error.code = 'PDF_LAYOUT_OVERFLOW';
  error.group = group;
  return error;
}

async function renderMeetingRecordPdf(content, layout) {
  const title = content.topic.trim() ? content.topic : '모임 기록';
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
    margins: { top: 62, right: layout.side, bottom: layout.bottom, left: layout.side },
    info: { Title: `GROWELL ${content.round}번째 모임 - ${title}`, Author: 'GROWELL', Creator: 'GROWELL 모임 기록', Subject: '운영자가 정리한 모임 기록' }
  });
  const chunks = [];
  let streamCompleted = false;
  const done = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => { streamCompleted = true; resolve(Buffer.concat(chunks)); });
    doc.on('close', () => { if (!streamCompleted) reject(new Error('PDF rendering stream closed before completion.')); });
  });
  // An early layout rejection destroys its private stream before completion.
  // Observe stream errors even when that candidate is never returned.
  done.catch(() => {});
  doc.registerFont('Pretendard', FONT_REGULAR);
  doc.registerFont('PretendardBold', FONT_BOLD);
  doc.registerFont('NotoEmoji', FONT_EMOJI);
  let currentFont = 'Pretendard', currentSize = 10.5, currentColor = COLOR.ink;
  const left = layout.side, width = 595.28 - left * 2;
  let pageNumber = -1, insightContext = null;
  let currentGroup = 'overview', allowedLastPage = 0;
  const continuationContexts = new Map();
  function style(font = 'Pretendard', size = 10.5, color = COLOR.ink) {
    currentFont = font; currentSize = size; currentColor = color;
    doc.font(font).fontSize(size).fillColor(color);
  }
  doc.on('pageAdded', () => {
    pageNumber += 1;
    if (pageNumber > allowedLastPage) throw layoutOverflow(currentGroup);
    if (insightContext) continuationContexts.set(pageNumber, { ...insightContext });
    doc.moveTo(left, 47).lineTo(left + width, 47).lineWidth(0.6).strokeColor(COLOR.rule).stroke();
    doc.font(currentFont).fontSize(currentSize).fillColor(currentColor);
    doc.x = left; doc.y = 62;
  });
  try {
  doc.addPage();
  function remaining() { return doc.page.height - doc.page.margins.bottom - doc.y; }
  function reserve(height) { if (remaining() < height && doc.y > doc.page.margins.top) doc.addPage(); }
  function write(value, options = {}) {
    const runs = fontRuns(value, currentFont === 'PretendardBold');
    const originalFont = currentFont;
    const { x = left, width: lineWidth = width, ...textOptions } = options;
    runs.forEach((run, index) => {
      style(run.font, currentSize, currentColor);
      if (index === 0) doc.text(run.text, x, doc.y, { width: lineWidth, ...textOptions, continued: runs.length > 1 });
      else doc.text(run.text, { width: lineWidth, ...textOptions, continued: index < runs.length - 1 });
    });
    style(originalFont, currentSize, currentColor);
  }
  function paragraph(value, options = {}) {
    const bodySize = currentGroup === 'insights' ? layout.insightSize : 10.5;
    style(options.bold ? 'PretendardBold' : 'Pretendard', options.size || bodySize, options.color || COLOR.ink);
    write(value, { lineGap: currentGroup === 'insights' ? layout.insightGap : layout.lineGap, paragraphGap: 1.5 * layout.scale, align: 'left', ...options.text });
    doc.y += (options.gap === undefined ? 4 : options.gap) * layout.scale;
  }
  function textHeight(value, font, size, lineWidth = width) {
    const saved = [currentFont, currentSize, currentColor];
    style(font, size);
    const height = doc.heightOfString(value, { width: lineWidth, lineGap: currentGroup === 'insights' ? layout.insightGap : layout.lineGap, paragraphGap: 1.5 * layout.scale });
    style(...saved);
    return height;
  }
  function bodyLinesHeight(count) {
    const saved = [currentFont, currentSize, currentColor];
    style('Pretendard', currentGroup === 'insights' ? layout.insightSize : 10.5);
    const height = count * (doc.currentLineHeight(true) + (currentGroup === 'insights' ? layout.insightGap : layout.lineGap));
    style(...saved);
    return height;
  }
  function heading(value, level = 2, following) {
    const fontSize = level === 2 ? 14 : 11.5;
    style('PretendardBold', fontSize, COLOR.green);
    const before = doc.y > doc.page.margins.top ? (level === 2 ? layout.sectionBefore : layout.topicBefore) : 0;
    const height = doc.heightOfString(value, { width, lineGap: layout.lineGap });
    // Reserve the actual short answer, or two lines of a longer body. A last
    // one-line topic should not fail merely because a second line is absent.
    const minimumBody = following === undefined ? bodyLinesHeight(2) : Math.min(textHeight(following, 'Pretendard', currentGroup === 'insights' ? layout.insightSize : 10.5), bodyLinesHeight(2));
    reserve(before + height + 5 * layout.scale + minimumBody + (level === 2 ? 4 * layout.scale : 0));
    doc.y += before;
    write(value, { lineGap: layout.lineGap });
    if (level === 2) {
      doc.y += 4 * layout.scale;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.6).strokeColor(COLOR.rule).stroke();
    }
    doc.y += 5 * layout.scale;
  }
  paragraph(`${content.round}번째 모임 · ${dateLabel(content.date)}`, { size: 10, color: COLOR.muted, gap: 4 });
  paragraph(title, { bold: true, size: 23, gap: 6 });
  if (content.bookTitle) paragraph(content.bookTitle, { size: 10.5, color: COLOR.muted, gap: 8 });

  heading('핵심 요약');
  content.sections.forEach((item, index) => paragraph(`${index + 1}. ${item.summary}`, { gap: 2 }));
  if (!content.sections.length) paragraph('등록된 핵심 요약이 없습니다.', { color: COLOR.muted });
  heading('함께 살펴본 개념');
  content.concepts.forEach(item => { heading(item.word, 3, item.meaning); paragraph(item.meaning); });
  if (!content.concepts.length) paragraph('등록된 개념이 없습니다.', { color: COLOR.muted });

  function nextReadingPage(group, index, last = index) {
    if (pageNumber !== index - 1) throw layoutOverflow(currentGroup);
    insightContext = null;
    currentGroup = group; allowedLastPage = last;
    doc.addPage();
  }
  nextReadingPage('details', 1);
  heading('모임 내용');
  if (content.sections.length) {
    content.sections.forEach((item, index) => { heading(`${index + 1}. ${item.summary}`, 3, item.detail); paragraph(item.detail); });
  } else {
    paragraph('등록된 모임 내용이 없습니다.', { color: COLOR.muted });
  }

  nextReadingPage('insights', 2, 3);
  heading('함께 나눈 통찰');
  const insightStart = doc.y;
  const labels = [['q1', '모임 소감'], ['q2', '새로운 깨달음'], ['q3', '실천할 배움']];
  const insightLayouts = content.insights.map((item, index) => {
      let date = '';
      if (item.date) {
        const parsed = new Date(item.date);
        date = Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) : item.date;
      }
      const name = `${index + 1}. ${item.authorName}`;
      const nameWidth = width - 120;
      const headerHeight = Math.max(textHeight(name, 'PretendardBold', 11.5, nameWidth), date ? textHeight(date, 'Pretendard', 9, 100) : 0) + 16 * layout.scale;
      const rowWidth = width - 15;
      const height = headerHeight + layout.topicBefore * 2 + labels.reduce((total, [key, label], questionIndex) => total
        + textHeight(`${String(questionIndex + 1).padStart(2, '0')}  ${label}`, 'PretendardBold', 9.5, rowWidth) + 4 * layout.scale
        + textHeight(item[key] || '작성한 답변이 없습니다.', 'Pretendard', layout.insightSize, rowWidth) + 6 * layout.scale + (questionIndex ? layout.topicBefore : 0), 0);
      return { item, index, date, name, nameWidth, headerHeight, height };
  });
  // The first insight page has a heading; the second starts directly with a
  // note. Balance their different capacities at a complete author boundary.
  // If no such boundary fits, a complete answer can flow between pages 3–4.
  let split = null;
  if (insightLayouts.length > 1 && !layout.flowOnly) {
    const total = insightLayouts.reduce((sum, item) => sum + item.height, 0);
    const firstCapacity = doc.page.height - layout.bottom - insightStart;
    const secondCapacity = doc.page.height - layout.bottom - doc.page.margins.top;
    let prefix = 0, closest = Infinity;
    for (let index = 0; index < insightLayouts.length - 1; index += 1) {
      prefix += insightLayouts[index].height;
      const load = Math.max(prefix / firstCapacity, (total - prefix) / secondCapacity);
      if (load <= 1 && load < closest) { closest = load; split = index + 1; }
    }
  }
  const insightPages = split === null ? [insightLayouts] : [insightLayouts.slice(0, split), insightLayouts.slice(split)];
  insightPages.forEach((items, part) => {
    if (part) {
      if (pageNumber !== 2) throw layoutOverflow('insights');
      insightContext = null; doc.addPage();
    }
    if (!items.length) paragraph('등록된 공개 통찰이 없습니다.', { color: COLOR.muted });
    items.forEach(({ item, index, date, name, nameWidth, headerHeight }, localIndex) => {
      // A compact author bar distinguishes each complete note. Reserve only
      // its identity, first question and two answer lines; do not force an
      // entire long note onto the next page or place text in a fixed box.
      // A new note moved intact to the next page is a fresh start, not a
      // continuation of the previous author or an answer not yet written.
      insightContext = null;
      const authorBefore = localIndex ? layout.topicBefore : 0;
      reserve(authorBefore + headerHeight + layout.topicBefore + textHeight(`01  ${labels[0][1]}`, 'PretendardBold', 9.5) + 4 * layout.scale + bodyLinesHeight(2));
      doc.y += authorBefore;
      const headerTop = doc.y;
      doc.rect(left, headerTop, width, headerHeight).fill(COLOR.pale);
      doc.y = headerTop + 8 * layout.scale;
      paragraph(name, { bold: true, size: 11.5, gap: 0, text: { x: left + 10, width: nameWidth } });
      if (date) {
        doc.y = headerTop + 9 * layout.scale;
        paragraph(date, { size: 9, color: COLOR.muted, gap: 0, text: { x: left + width - 110, width: 100, align: 'right' } });
      }
      doc.y = headerTop + headerHeight + layout.topicBefore;
      insightContext = { authorName: item.authorName, label: labels[0][1] };
      labels.forEach(([key, label], questionIndex) => {
        const value = item[key] || '작성한 답변이 없습니다.';
        insightContext = { authorName: item.authorName, label };
        const rowWidth = width - 15;
        const labelHeight = textHeight(`${String(questionIndex + 1).padStart(2, '0')}  ${label}`, 'PretendardBold', 9.5, rowWidth);
        reserve(labelHeight + 4 * layout.scale + Math.min(textHeight(value, 'Pretendard', layout.insightSize, rowWidth), bodyLinesHeight(2)) + (questionIndex ? layout.topicBefore : 0));
        if (questionIndex) {
          doc.moveTo(left + 15, doc.y).lineTo(left + width, doc.y).lineWidth(0.4).strokeColor(COLOR.rule).stroke();
          doc.y += layout.topicBefore;
        }
        const rowStartPage = pageNumber, rowTop = doc.y;
        paragraph(`${String(questionIndex + 1).padStart(2, '0')}  ${label}`, { bold: true, size: 9.5, color: COLOR.green, gap: 4, text: { x: left + 15, width: rowWidth } });
        paragraph(value, { gap: 6, text: { x: left + 15, width: rowWidth } });
        const rowEndPage = pageNumber, rowBottom = doc.y;
        // Draw the accent in the margin of every flowing fragment. It never
        // covers, clips, or replaces authored text on continuation pages.
        for (let page = rowStartPage; page <= rowEndPage; page += 1) {
          doc.switchToPage(page);
          const top = page === rowStartPage ? rowTop : doc.page.margins.top;
          const bottom = page === rowEndPage ? rowBottom - 6 * layout.scale : doc.page.height - doc.page.margins.bottom;
          doc.moveTo(left + 5, top).lineTo(left + 5, Math.max(top, bottom)).lineWidth(1.3).strokeColor(COLOR.accent).stroke();
        }
        doc.switchToPage(rowEndPage);
        doc.x = left; doc.y = rowBottom;
      });
    });
    insightContext = null;
  });
  if (pageNumber === 2) {
    insightContext = null; doc.addPage();
    paragraph(content.insights.length ? '모든 공개 통찰을 앞 페이지에서 확인할 수 있습니다.' : '등록된 공개 통찰이 없습니다.', { color: COLOR.muted });
  }
  nextReadingPage('preparation', 4);
  heading('다음 모임 준비');
  const preparation = [];
  if (content.nextMeeting) {
    const next = content.nextMeeting;
    const when = [next.date ? dateLabel(next.date) : '', next.time].filter(Boolean).join(' · ');
    if (when) preparation.push(['일시', when]);
    PREPARATION.forEach(([key, label]) => { if (next[key].trim()) preparation.push([label, next[key]]); });
  }
  preparation.forEach(([label, value]) => { heading(label, 3, value); paragraph(value, { bold: label === '나눔' }); });
  if (!preparation.length) paragraph('등록된 다음 모임 준비가 없습니다.', { color: COLOR.muted });
  heading('함께 읽고 볼 자료');
  if (content.materials.length) {
    content.materials.forEach((item, index) => {
      style('PretendardBold', 10.5);
      let resourceHeight = doc.heightOfString(`${index + 1}. ${item.title}`, { width, lineGap: layout.lineGap, paragraphGap: 1.5 * layout.scale }) + 6 * layout.scale;
      if (item.url) {
        style('Pretendard', 9);
        resourceHeight += doc.heightOfString(item.url, { width, lineGap: layout.lineGap, paragraphGap: 1.5 * layout.scale }) + 8 * layout.scale;
      }
      reserve(layout.topicBefore + resourceHeight);
      doc.y += layout.topicBefore;
      paragraph(`${index + 1}. ${item.title}`, { bold: true, gap: item.url ? 2 : 4 });
      if (item.url) paragraph(item.url, { size: 9, color: COLOR.green, text: { link: item.url }, gap: 5 });
    });
  } else {
    paragraph('연결된 자료가 없습니다.', { color: COLOR.muted });
  }
  const pages = doc.bufferedPageRange();
  if (pages.count !== 5) throw layoutOverflow(currentGroup);
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(pages.start + index);
    const previousBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    // Draw page furniture after body flow has finished. Writing a header from
    // pageAdded can inherit PDFKit's active paragraph wrapper on page breaks.
    doc.font('PretendardBold').fontSize(8.5).fillColor(COLOR.green);
    doc.text('GROWELL  |  모임별 기록', left, 29, { width, lineBreak: false });
    const continuation = continuationContexts.get(index);
    if (continuation) {
      doc.font('Pretendard').fontSize(8).fillColor(COLOR.muted);
      const contextWidth = width - 160;
      const complete = `${continuation.authorName} · ${continuation.label} · 이어서`;
      // A repeated navigation label may omit a very long author name, while
      // the full authored name remains unaltered in its original note bar.
      const label = doc.widthOfString(complete) <= contextWidth ? complete : `통찰 정리 · ${continuation.label} · 이어서`;
      doc.text(label, left + 160, 29, { width: contextWidth, align: 'right', lineBreak: false });
    }
    doc.font('Pretendard').fontSize(8).fillColor(COLOR.muted);
    doc.text(`${index + 1} / ${pages.count}`, left, doc.page.height - 34, { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = previousBottom;
  }
  if (doc.bufferedPageRange().count !== 5) throw layoutOverflow(currentGroup);
  doc.end();
  return await done;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

module.exports = { createMeetingRecordPdf, editorialContent };
