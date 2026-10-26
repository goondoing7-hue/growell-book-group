'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../readingFormatDomain.js'),Book=require('../bookDetails.js');

test('integer percent labels preserve stored precision and reserve 100 for actual completion',()=>{
  for(const [value,expected] of [[0,0],[12.4,12],[12.5,13],[37.5,38],[99.9,99],[100,100]])assert.equal(F.displayPercent(value),expected);
  for(const value of [null,undefined,'25',NaN,Infinity,-1,101])assert.equal(F.displayPercent(value),null);
  const source={format:'ebook',ebook:{progressPercent:37.5}},before=JSON.stringify(source);
  assert.equal(F.displayPercent(source.ebook.progressPercent),38);assert.equal(JSON.stringify(source),before);
  assert.equal(F.normalizeSettings(source).ebook.progressPercent,37.5);
});

test('changing reading format keeps ebook position separate from existing paper pages and leaves source intact',()=>{
  const book={currentPage:81,totalPages:200,notes:[{id:'note-1',text:'남겨 둔 문장'}],readingSettings:{format:'paper',ebook:{sectionId:'s2',sectionTitle:'둘째 제목',progressPercent:37.5,estimateBasis:'equal-sections',updatedAt:100}}};
  const before=JSON.stringify(book),ebook=F.changeFormat(F.settingsFromBook(book),'ebook'),paper=F.changeFormat(ebook,'paper');
  assert.equal(ebook.ebook.progressPercent,37.5);assert.equal(paper.ebook.sectionId,'s2');assert.equal(paper.format,'paper');
  assert.equal(JSON.stringify(book),before);assert.equal(book.currentPage,81);assert.equal(F.settingsFromBook({}).format,'paper');
  for(const progressPercent of [NaN,Infinity,-1,101,'25',null])assert.equal(F.normalizeSettings({format:'ebook',ebook:{progressPercent}}).ebook.progressPercent,null);
});

test('complete paper boundaries weight a subsection midpoint without changing paper records',()=>{
  const rows=[{id:'c1',label:'1장',title:'시작',page:1,sections:[{id:'s1',title:'첫 세부 목차',page:1},{id:'s2',title:'두 번째 세부 목차',page:21}]},{id:'c2',label:'2장',title:'다음',page:61}];
  const source=JSON.stringify(rows),entries=F.tocEntries(rows,100);
  assert.deepEqual(entries.map(row=>row.id),['s1','s2','c2']);
  assert.deepEqual(entries.map(row=>[row.startPercent,row.endPercent]),[[0,20],[20,60],[60,100]]);
  const selected=F.selectSection({format:'paper'},entries,'s2',99);
  assert.deepEqual(selected,{format:'ebook',ebook:{sectionId:'s2',sectionTitle:'1장 · 두 번째 세부 목차',progressPercent:40,progressKind:'estimated',estimateBasis:'paper-toc',updatedAt:99}});
  assert.equal(JSON.stringify(rows),source);assert.equal(F.selectSection(selected,entries,'unknown',99),null);
});

test('a distinct chapter introduction is selectable while duplicate same-page chapter headings do not count twice',()=>{
  const entries=F.tocEntries([{id:'c',label:'1장',title:'큰 제목',page:1,sections:[{id:'s',title:'세부 제목',page:11}]}],100);
  assert.deepEqual(entries.map(row=>row.id),['c','s']);
  assert.equal(F.estimateSelection(entries,'c').progressPercent,5);assert.equal(F.estimateSelection(entries,'s').progressPercent,55);
});

test('unpaged and non-increasing contents use explicit equal-section estimates rather than invented pages',()=>{
  for(const pages of [[1,null,80],[1,1,80],[90,30,80]]){
    const entries=F.tocEntries(pages.map((page,i)=>({id:'s'+i,title:'실제 제목 '+i,page})),100);
    assert.deepEqual(entries.map(row=>row.estimateBasis),['equal-sections','equal-sections','equal-sections']);
    assert.deepEqual(entries.map(row=>F.estimateSelection(entries,row.id).progressPercent),[16.7,50,83.3]);
  }
  assert.deepEqual(F.tocEntries(null,100),[]);assert.equal(F.estimateSelection([],''),null);
  const last=F.tocEntries([{id:'s1',title:'처음',page:1},{id:'s2',title:'마지막',page:100000}],100000);
  assert.equal(F.estimateSelection(last,'s2').progressPercent,99.9,'a rounded midpoint is never mistaken for completing the book');
});

test('official ebook contents only mark the saved position while the finish picker remains selectable',()=>{
  const book={id:'emotion',title:'책',author:'저자',publisher:'출판사',cover:'covers/emotion.jpg'},entries=Book.readingEntries('emotion');
  assert.ok(entries.length>55);assert.equal(new Set(entries.map(row=>row.id)).size,entries.length);
  assert.equal(entries.find(row=>row.id==='chapter-1-section-1').title,'왜 그렇게 상대의 비위를 맞춰?');
  assert.equal(entries.filter(row=>row.id==='chapter-1').length,0);assert.ok(entries.find(row=>row.id==='chapter-2'));
  const selected=Book.readingChoice(book,'chapter-2-section-1',{format:'paper'},100),html=Book.bodyHtml(book,81,selected);
  assert.match(html,/<span>\d+%<\/span>/);assert.match(html,/기록 저장 화면에서 진도를 설정/);assert.match(html,/<details class="book-ebook-chapter" open>/);
  assert.equal((html.match(/aria-current="location"/g)||[]).length,1);
  assert.doesNotMatch(html,/\d+쪽|class="book-toc-page"|종이책 기준|data-book-ebook-section|약 |\d+\.\d+%/);
  const picker=Book.readingPickerHtml(book,selected);assert.match(picker,/data-book-ebook-section="chapter-2-section-1" aria-pressed="true"/);assert.doesNotMatch(picker,/약 |\d+\.\d+%/);
});

test('archive ebook contents retain supplied hierarchy, escape titles and estimate unpaged sections',()=>{
  const archive={id:'arc_sample',title:'책',totalPages:200,currentPage:50,tableOfContents:'1장 첫 이야기\n사진 <script>문장</script>\n또 하나의 제목\n2장 다음 이야기\n마지막 제목'};
  const entries=Book.readingEntries(archive),settings=Book.readingChoice(archive,entries[0].id,{format:'ebook'},10),html=Book.archiveBodyHtml(archive,50,settings);
  assert.deepEqual(entries.map(row=>row.title),['사진 <script>문장</script>','또 하나의 제목','마지막 제목']);
  assert.equal(settings.ebook.progressPercent,16.7);assert.equal(settings.ebook.estimateBasis,'equal-sections');
  assert.match(html,/&lt;script&gt;문장&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>|50쪽|200쪽/);
  assert.match(Book.readingPickerHtml({tableOfContents:''},{format:'ebook'}),/등록된 목차가 없어요/);
  const selector=Book.formatSelectorHtml('ebook','data-custom-format');assert.match(selector,/data-custom-format="ebook" aria-pressed="true"/);
  assert.doesNotMatch(Book.formatSelectorHtml('paper','onclick="bad'),/onclick/);
});
