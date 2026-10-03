'use strict';

// The mobile guide is the shared content source. Regenerate both editions with
// npm run guides after editing it; build only verifies, never changes sources.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const normalize = text => text.replace(/\r\n/g, '\n');
function replaceRequired(text, before, after) {
  if (!text.includes(before)) throw new Error('가이드 원문을 확인해 주세요: ' + before.slice(0, 90));
  return text.replace(before, () => after);
}
function mobileEdition(source, routing) {
  const clean = normalize(source).replace(/\n?<!-- guide-device-routing:start -->[\s\S]*?<!-- guide-device-routing:end -->\n?/g, '\n');
  const marker = '<!-- guide-device-routing:start -->\n<script>\n' + normalize(routing).trim() + '\nGrowellGuideRouting.redirect(window.location, window.navigator);\n</script>\n<!-- guide-device-routing:end -->';
  return replaceRequired(clean, '<meta name="theme-color"', marker + '\n<meta name="theme-color"');
}

const desktopStyle = `
/* PC edition: persistent chapter navigation and wider reading examples. */
.desktop-guide-layout{width:min(1480px,calc(100% - 64px));margin:0 auto;display:grid;grid-template-columns:214px minmax(0,1fr);gap:48px;align-items:start}
.desktop-guide-layout>.shell{width:100%;min-width:0}
.topbar>.shell{width:min(1480px,calc(100% - 64px))}
.desktop-toc{position:sticky;top:100px;max-height:calc(100vh - 126px);overflow:auto;padding:16px 18px 24px 0;scrollbar-width:thin}
.desktop-toc>p{font-size:10px;letter-spacing:.16em;color:var(--muted);margin:0 0 19px}
.desktop-toc ol{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.desktop-toc a{display:flex;align-items:baseline;gap:12px;padding:9px 10px;border-radius:8px;color:var(--muted);font-size:12px;text-decoration:none;line-height:1.65;transition:background .18s,color .18s}
.desktop-toc a small{font-size:10px;font-variant-numeric:tabular-nums;opacity:.7;flex:none}
.desktop-toc a:hover,.desktop-toc a[aria-current="location"]{background:var(--soft);color:var(--green);font-weight:650}
.desktop-toc .desktop-start{margin-top:22px;border-top:1px solid var(--line);padding-top:17px;font-size:11px}
.hero{padding-top:64px}.hero h1{font-size:clamp(36px,3.5vw,56px)}.hero-lede{font-size:16px;line-height:1.85}
.chapter{scroll-margin-top:100px}.chapter-grid{grid-template-columns:minmax(0,.95fr) minmax(0,1.1fr);gap:32px}
.steps p,.chapter-intro{font-size:14px;line-height:1.9}.steps h3{font-size:16px}
.desktop-use{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;padding:26px 0 36px;border-bottom:1px solid var(--line)}
.desktop-use article{border-left:2px solid var(--line);padding-left:16px}.desktop-use b{font-size:13px;color:var(--green)}.desktop-use p{font-size:12px;line-height:1.8;color:var(--muted);margin:9px 0 0}
.desktop-split-demo{display:grid;grid-template-columns:1fr 1.55fr;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff;margin-top:22px}
.desktop-split-list{padding:14px;background:var(--soft)}.desktop-split-list strong{display:block;font-size:12px;margin-bottom:12px}.desktop-split-list span{display:block;padding:12px 9px;font-size:11px;line-height:1.7;border-radius:8px}.desktop-split-list .selected{background:#fff;color:var(--green);font-weight:650}
.desktop-split-detail{padding:22px}.desktop-split-detail small{font-size:10px;color:var(--muted)}.desktop-split-detail h3{font-size:16px;margin:16px 0 12px}.desktop-split-detail p{font-size:12px;line-height:1.9;margin:0}
.bottom-nav{display:none}
@media(min-width:1100px){.private-guide-part .chapter-grid{gap:32px}.hero-art{min-height:280px}}
@media(max-width:1100px){.desktop-guide-layout{grid-template-columns:176px minmax(0,1fr);gap:26px;width:calc(100% - 44px)}.desktop-toc{padding-right:0}.desktop-toc a{font-size:11px;gap:8px;padding:8px}.chapter-grid{grid-template-columns:1fr}.hero-art{display:none}.hero-row{grid-template-columns:1fr}.hero h1{font-size:42px}}
@media(max-width:800px){.desktop-guide-layout{display:block;width:calc(100% - 38px)}.desktop-toc{display:none}.topbar>.shell{width:calc(100% - 38px)}.desktop-use{grid-template-columns:1fr;gap:20px}.hero{padding-top:38px}.hero h1{font-size:34px}.hero-lede{font-size:14px}.bottom-nav{display:flex}.desktop-split-demo{grid-template-columns:1fr}.desktop-split-list span:not(.selected){display:none}}
@media print{.desktop-guide-layout{display:block;width:100%}.desktop-toc,.desktop-use{display:none}.topbar>.shell{width:100%}.hero-art{display:block}.chapter-grid{grid-template-columns:1fr 1fr}.desktop-split-demo{break-inside:avoid}}
`;

function desktopEdition(mobile) {
  const routingBlock = mobile.match(/<!-- guide-device-routing:start -->[\s\S]*?<!-- guide-device-routing:end -->/)[0];
  let html = mobile.replace(/모바일 사용 가이드/g, 'PC 사용 가이드').replace(/모바일 사용 설명서/g, 'PC 사용 설명서').replace(/GROWELL 모바일 가이드/g, 'GROWELL PC 가이드').replace(/MOBILE GUIDE/g, 'PC GUIDE');
  // Only metadata URLs are replaced: the routing module must retain both paths.
  html = html.replace(/https:\/\/growell-book\.vercel\.app\/guide\.html/g, 'https://growell-book.vercel.app/guide-pc.html');
  html = html.replace(/6개 메뉴와 아카이브를 휴대폰으로 익히는 사용 설명서\./g, '넓은 화면과 마우스로 익히는 6개 메뉴와 아카이브 사용 설명서.');
  html = replaceRequired(html, '읽기와 기록, 나눔과 매일의 실천까지.<br>6개의 메뉴와 아카이브를<br>휴대폰 화면을 보며 하나씩 익혀보세요.', 'PC의 넓은 화면에서 읽고, 생각을 정리해보세요.<br>6개의 메뉴와 아카이브를 사용하는 방법을<br>화면 예시와 함께 차근차근 안내합니다.');
  html = replaceRequired(html, '휴대폰에서 글자를 길게 눌러 원하는 부분을 선택한 다음, 크기 아이콘에서 숫자를 골라주세요. 색상도 선택한 글에 적용할 수 있어요.', '마우스로 문장을 드래그해 선택한 다음, 크기 아이콘에서 숫자를 골라주세요. 굵게, 글자색, 형광펜도 선택한 글에 적용할 수 있어요.');
  html = replaceRequired(html, '휴대폰은 손가락으로, PC는 마우스로 잡아 밀거나 화살표로 이동해요.', '마우스로 카드를 잡아 좌우로 끌거나 이전·다음 화살표를 클릭해요. 카드 영역에 포커스가 있을 때는 키보드 ←·→로도 이동할 수 있어요.');
  html = replaceRequired(html, '노트를 <b>좌우로 밀어 한 장씩</b> 넘겨보세요.', '노트 영역에 포커스를 두고 <b>키보드 ←·→</b>로 넘기거나 <b>전체보기</b>에서 기록을 찾아보세요.');
  html = replaceRequired(html, '책은 <b>4권씩, 2줄</b>로 보이고 좌우로 밀어 다음 책들을 볼 수 있어요.', '책은 <b>4권씩, 2줄</b>로 보여요. <b>이전·다음 버튼</b>을 클릭하거나 책 목록에 포커스를 두고 <b>키보드 ←·→</b>로 다음 책들을 볼 수 있어요.');
  html = replaceRequired(html, '휴대폰을 바꾸어도 기록을 볼 수 있나요?', '다른 PC나 휴대폰에서도 기록을 볼 수 있나요?');
  html = replaceRequired(html, '</head>', '<style>\n' + desktopStyle + '\n</style>\n</head>');
  const chapters = [...html.matchAll(/<section class="chapter" id="([^"]+)" data-title="([^"]+)"/g)];
  if (chapters.length !== 13) throw new Error('PC 가이드 목차 13개를 확인해 주세요.');
  const toc = chapters.map(([, id, title], index) => '<li><a href="#' + id + '" data-desktop-chapter="' + id + '"><small>' + String(index + 1).padStart(2, '0') + '</small>' + title + '</a></li>').join('');
  html = replaceRequired(html, '<main id="top" class="shell">', '<div class="desktop-guide-layout"><nav class="desktop-toc" aria-label="PC 가이드 목차"><p>GROWELL · PC GUIDE</p><ol>' + toc + '</ol><a class="desktop-start" href="https://growell-book.vercel.app/">GROWELL로 가기 ↗</a></nav><main id="top" class="shell">');
  html = replaceRequired(html, '</main>', '</main></div>');
  html = replaceRequired(html, '<div class="intro-strip">', '<div class="desktop-use" aria-label="PC에서 편하게 사용하는 방법"><article><b>필요한 내용으로 바로 이동</b><p>왼쪽 목차에서 원하는 항목을 클릭하세요. 화면이 좁을 때는 상단의 목차 버튼을 사용하세요.</p></article><article><b>마우스로 선택하고 기록</b><p>문장을 드래그해 서식을 적용하고, 습관 카드는 좌우로 끌어 넘겨보세요.</p></article><article><b>설명서를 종이로도 보기</b><p>오른쪽 위 인쇄 아이콘을 클릭하면 설명서를 인쇄하거나 PDF로 저장할 수 있어요.</p></article></div><div class="intro-strip">');
  const recordList = '<article class="private-guide-part" id="mine-record-list"';
  if (!html.includes(recordList)) throw new Error('나의 기록 목록 안내가 없습니다.');
  const split = '<aside class="guide-updates"><h2>PC에서는 목록과 본문을 나란히 봐요.</h2><p>나의 공간과 나눔에서 왼쪽 글을 클릭하면 오른쪽에 내용이 열려요. 다른 글도 왼쪽 목록에서 선택하세요. 창을 좁히면 한 화면씩 표시됩니다.</p><div class="desktop-split-demo" aria-label="PC의 기록 목록과 본문 배치 예시"><div class="desktop-split-list"><strong>나의 기록</strong><span class="selected">마음을 알아차리는 연습<br><small>내 생각 · 오늘</small></span><span>책에서 만난 한 문장</span><span>나에게 남은 질문</span></div><div class="desktop-split-detail"><small>내 생각 · 나에게만 보이는 기록</small><h3>마음을 알아차리는 연습</h3><p>책을 읽으며 잠시 멈추어 내 마음을 돌아보았습니다. 오늘의 감정을 한 문장으로 남겨봅니다.</p></div></div></aside>';
  html = replaceRequired(html, recordList, split + '\n' + recordList);
  html = replaceRequired(html, "$('#current-chapter').textContent=active?", "$$('[data-desktop-chapter]').forEach(link=>{if(active&&link.dataset.desktopChapter===active.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});$('#current-chapter').textContent=active?");
  html = html.replace(/<!-- guide-device-routing:start -->[\s\S]*?<!-- guide-device-routing:end -->/, () => routingBlock);
  return '<!-- Generated by scripts/build-guides.cjs. Edit guide.html for shared content. -->\n' + html;
}

function validate(html, filename) {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script, { filename });
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(ids).size !== ids.length) throw new Error(filename + ': 중복 ID가 있습니다.');
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) if (!ids.includes(id)) throw new Error(filename + ': 연결되지 않은 목차 ' + id);
}
function editions(root = ROOT) {
  const mobile = mobileEdition(fs.readFileSync(path.join(root, 'guide.html'), 'utf8'), fs.readFileSync(path.join(root, 'guideRouting.js'), 'utf8'));
  const desktop = desktopEdition(mobile);
  validate(mobile, 'guide.html'); validate(desktop, 'guide-pc.html');
  return { 'guide.html': mobile, 'guide-pc.html': desktop };
}
function verifyGuidesFresh(root = ROOT) {
  for (const [file, expected] of Object.entries(editions(root))) {
    if (!fs.existsSync(path.join(root, file)) || normalize(fs.readFileSync(path.join(root, file), 'utf8')) !== expected) throw new Error(file + ' 갱신이 필요합니다. npm run guides를 실행해 주세요.');
  }
}
if (require.main === module) {
  for (const [file, html] of Object.entries(editions())) fs.writeFileSync(path.join(ROOT, file), html);
  console.log('PC·모바일 가이드 생성 완료');
}
module.exports = { mobileEdition, desktopEdition, verifyGuidesFresh };
