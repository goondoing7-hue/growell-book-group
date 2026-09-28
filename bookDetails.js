(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellBookDetails=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  // Edition: ISBN 9791193388266 (2025, 364 pages). Page numbers are the
  // first body pages printed in the publisher-supplied paper-book preview,
  // not inferred chapter-divider pages. Labels summarize each chapter.
  var emotion={
    isbn:'9791193388266',totalPages:364,
    authorIntro:'문요한은 정신건강의학과 의사이자 작가이다. 심리치유와 몸과 마음을 돌보는 방법을 연구하고 있다.',
    overview:'어린 시절 억눌렀던 감정이 지금의 선택과 관계에 어떻게 영향을 주는지 살펴보는 책이다. 불안·울분·공허감·무력감·수치심을 알아차리고, 몸의 감각과 자기돌봄을 통해 감정을 다루는 과정을 상담 사례와 함께 안내한다.',
    chapters:[
      {id:'prologue',label:'프롤로그',title:'마음에 남은 상처를 돌아보며',page:4},
      {id:'before',label:'읽기 안내',title:'책을 읽기 전에',page:15},
      {id:'chapter-1',label:'1장',title:'핵심 감정이 삶에 미치는 영향',page:26,part:1},
      {id:'chapter-2',label:'2장',title:'나를 흔드는 감정 발견하기',page:66,part:1},
      {id:'chapter-3',label:'3장',title:'감정을 피하려는 방어 이해하기',page:124,part:1},
      {id:'chapter-4',label:'4장',title:'성격과 관계에 남은 감정의 흔적',page:166,part:1},
      {id:'chapter-5',label:'5장',title:'회복을 도울 힘 마련하기',page:202,part:2},
      {id:'chapter-6',label:'6장',title:'몸의 감각으로 감정과 만나기',page:244,part:2},
      {id:'chapter-7',label:'7장',title:'감정을 알아차리고 반응 바꾸기',page:288,part:2},
      {id:'chapter-8',label:'8장',title:'회복된 감정으로 삶 이어가기',page:330,part:2},
      {id:'epilogue',label:'에필로그',title:'변화를 돌아보며',page:360}
    ],
    previewUrl:'https://www.aladin.co.kr/shop/book/wletslookviewer.aspx?ItemId=379213370',
    infoUrl:'https://m.yes24.com/goods/detail/167543321'
  };
  var catalog={emotion:emotion},app=null,dialog=null,returnFocus=null,owner=null;
  function escape(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function details(bookId){return Object.prototype.hasOwnProperty.call(catalog,bookId)?catalog[bookId]:null;}
  function currentSection(bookId,page){
    var info=details(bookId);page=Number(page);
    if(!info||!Number.isInteger(page)||page<1||page>info.totalPages)return null;
    for(var i=info.chapters.length-1;i>=0;i--)if(page>=info.chapters[i].page)return info.chapters[i];
    return null;
  }
  function hintHtml(bookId,page){
    var section=currentSection(bookId,page);
    return section?'<span class="book-reading-section"><span aria-hidden="true">·</span> 읽는 부분: '+escape(section.label)+' · '+escape(section.title)+'</span>':'';
  }
  function coverHtml(book,imageClass){
    if(!book)return '';
    var image='<img'+(imageClass?' class="'+escape(imageClass)+'"':'')+' src="'+escape(book.cover)+'" alt="'+escape(book.title)+'" loading="lazy">';
    if(!details(book.id))return image;
    return '<button class="book-cover-trigger" type="button" data-book-details="'+escape(book.id)+'" aria-haspopup="dialog" aria-label="'+escape(book.title)+' 책 소개와 목차 보기">'+image+'</button>';
  }
  function close(restore){
    if(!dialog)return;
    var node=dialog,target=returnFocus;dialog=null;returnFocus=null;
    if(node.open)node.close();node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('book-details');
    if(restore!==false&&target&&target.isConnected)target.focus({preventScroll:true});
  }
  function configure(adapter){
    if(!adapter||typeof adapter.bookById!=='function'||typeof adapter.currentPage!=='function'||typeof adapter.sessionUserId!=='function')throw new Error('Missing book details adapter');
    close(false);app=adapter;owner=app.sessionUserId();
  }
  function bodyHtml(book,page){
    var info=details(book.id),section=currentSection(book.id,page),part=0;
    var toc=info.chapters.map(function(chapter){
      var heading='';
      if(chapter.part&&chapter.part!==part){part=chapter.part;heading='<li class="book-toc-part">'+part+'부 · '+(part===1?'감정 이해하기':'회복으로 나아가기')+'</li>';}
      var selected=section&&section.id===chapter.id;
      return heading+'<li class="book-toc-row'+(selected?' is-current':'')+'"'+(selected?' aria-current="location"':'')+'><div><span class="book-toc-label">'+escape(chapter.label)+'</span><span class="book-toc-title">'+escape(chapter.title)+'</span>'+(selected?'<span class="book-toc-current">읽는 중</span>':'')+'</div><span class="book-toc-page">'+chapter.page+'쪽</span></li>';
    }).join('');
    return '<header class="book-details-header"><h2 id="book-details-title">책 소개와 목차</h2><button class="icon-btn" type="button" data-book-details-close aria-label="책 소개 닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>'+
      '<div class="book-details-body"><div class="book-details-book"><img src="'+escape(book.cover)+'" alt=""><div><h3>'+escape(book.title)+'</h3><p>'+escape(book.author)+' · '+escape(book.publisher)+'<br>'+info.totalPages+'쪽</p></div></div>'+
      '<section class="book-details-overview"><h3>어떤 책인가요?</h3><p>'+escape(info.overview)+'</p><h3>저자 소개</h3><p>'+escape(info.authorIntro)+'</p></section>'+
      '<section class="book-details-contents"><div class="book-toc-heading"><h3>장별 목차 요약</h3>'+(section?'<span>현재 '+Number(page)+'쪽</span>':'')+'</div><p class="book-toc-note">쪽수와 읽는 챕터는 종이책 목차의 첫 본문 쪽수를 기준으로 표시해요.</p><ol class="book-toc">'+toc+'</ol></section>'+
      '<footer class="book-details-sources"><span>종이책 기준 · ISBN '+info.isbn+'</span><a href="'+info.previewUrl+'" target="_blank" rel="noopener noreferrer">원래 목차 보기 ↗</a><a href="'+info.infoUrl+'" target="_blank" rel="noopener noreferrer">도서 정보 출처 ↗</a></footer></div>';
  }
  function open(bookId,trigger){
    if(!app||!details(bookId))return;
    var book=app.bookById(bookId);if(!book)return;
    close(false);returnFocus=trigger||root.document.activeElement;
    var node=root.document.createElement('dialog');dialog=node;
    node.className='book-details-dialog';node.setAttribute('aria-labelledby','book-details-title');
    node.innerHTML=bodyHtml(book,app.currentPage(bookId));root.document.body.appendChild(node);
    node.querySelector('[data-book-details-close]').onclick=function(){close();};
    node.addEventListener('cancel',function(event){event.preventDefault();close();});
    node.addEventListener('click',function(event){if(event.target!==node)return;var rect=node.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();});
    node.showModal();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('book-details',{close:function(){if(dialog===node)close();}});
  }
  function bind(){
    if(!app)return;
    if(owner!==app.sessionUserId()){owner=app.sessionUserId();close(false);}
    root.document.querySelectorAll('[data-book-details]').forEach(function(button){button.onclick=function(event){event.preventDefault();event.stopPropagation();open(button.getAttribute('data-book-details'),button);};});
  }
  function reset(){close(false);owner=null;}
  if(root.addEventListener)root.addEventListener('hashchange',function(){close(false);});
  return {configure:configure,bind:bind,reset:reset,open:open,close:close,coverHtml:coverHtml,hintHtml:hintHtml,currentSection:currentSection,details:details,bodyHtml:bodyHtml};
});
