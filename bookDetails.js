(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellBookDetails=api;
})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  // Edition: ISBN 9791193388266 (2025, 364 pages). Page numbers are the
  // first body pages printed in the publisher-supplied paper-book preview,
  // not inferred chapter-divider pages. Titles follow the supplied contents.
  function sections(chapterId,rows){
    return rows.map(function(row,index){return {id:chapterId+'-section-'+(index+1),title:row[0],page:row[1]};});
  }
  var emotion={
    isbn:'9791193388266',totalPages:364,
    authorIntro:'문요한은 정신건강의학과 의사이자 작가이다. 심리치유와 몸과 마음을 돌보는 방법을 연구하고 있다.',
    overview:'어린 시절 억눌렀던 감정이 지금의 선택과 관계에 어떻게 영향을 주는지 살펴보는 책이다. 불안·울분·공허감·무력감·수치심을 알아차리고, 몸의 감각과 자기돌봄을 통해 감정을 다루는 과정을 상담 사례와 함께 안내한다.',
    chapters:[
      {id:'prologue',label:'프롤로그',title:'마음의 가시를 빼면 삶은 훨씬 살 만해진다',page:4},
      {id:'before',label:'',title:'책을 읽기 전에',page:15},
      {id:'chapter-1',label:'1장',title:'내 삶을 지배하는 핵심 감정',page:26,part:1,sections:sections('chapter-1',[
        ['왜 그렇게 상대의 비위를 맞춰?',26],
        ['시간이 지나도 풍화되지 않는 감정',30],
        ['견딜 수 없는 홀로 있음',36],
        ['끊임없이 자신을 취약하게 만드는 감정',39],
        ['핵심 감정은 자동적인 시스템을 구축한다',46],
        ['내면의 감옥에 갇혀 사는 사람들',54],
        ['무엇이 핵심 감정을 만드는가?',58]
      ])},
      {id:'chapter-2',label:'2장',title:'핵심 감정은 잘 감추어진다',page:66,part:1,sections:sections('chapter-2',[
        ['나의 핵심 감정은?',74],
        ['그는 왜 전화벨만 울려도 놀랄까?_근본적 불안',80],
        ['이유 없는 분노는 없다_울분',86],
        ['그가 늘 냉장고를 가득 채워놓는 이유_만성적 공허감',91],
        ['나는 아무런 힘이 없어_무력감',97],
        ['나만 없어지면 돼_원초적 수치심',103],
        ['자신의 핵심 감정을 찾는 방법',110],
        ['스스로 핵심 감정에 이름을 붙여보자',115]
      ])},
      {id:'chapter-3',label:'3장',title:'핵심 감정에 대한 방어',page:124,part:1,sections:sections('chapter-3',[
        ['상처를 감추느라 자기를 잃어버린 사람들',124],
        ['당신은 핵심 감정을 어떻게 방어했을까?',128],
        ['순응 모드: 핵심 감정에 끌려다니기',138],
        ['회피 모드: 핵심 감정으로부터 도망치기',143],
        ['과잉보상 모드: 핵심 감정과 반대로 살아가기',148],
        ['투사 모드: 핵심 감정을 떠넘기기',152],
        ['이상화 모드: 경험과 상대를 이상화하기',157]
      ])},
      {id:'chapter-4',label:'4장',title:'당신은 원래 그런 사람이 아니다',page:166,part:1,sections:sections('chapter-4',[
        ['나 또한 감정적으로 미숙한 부모가 아닐까?',170],
        ['나는 왜 자꾸 슬픈 노래가 끌릴까?',175],
        ['당신은 계기판이 없는 자동차를 운전하고 있다',180],
        ['당신의 예측은 당신의 감정을 넘어서지 못한다',185],
        ['왜 그녀는 자기보다 못한 조건의 사람과 연애를 할까?',191]
      ])},
      {id:'chapter-5',label:'5장',title:'회복의 자원을 확보하기',page:202,part:2,sections:sections('chapter-5',[
        ['상처는 나의 책임이 아니지만 회복은 나의 몫이다',202],
        ['그때의 내가 대견해',206],
        ['감정은 감정으로 치유된다',211],
        ['그 아이가 원하는 사람이 되어보라',216],
        ['이제 나를 안정시킬 수 있다',222],
        ['우리는 평생 위로의 대상이 필요하다',228],
        ['큰 결심은 큰 좌절을 빚는다',233]
      ])},
      {id:'chapter-6',label:'6장',title:'핵심 감정 마주하기',page:244,part:2,sections:sections('chapter-6',[
        ['몸, 고통과 번영의 진원지',244],
        ['신체감각은 감정의 통로가 된다',248],
        ['몸으로 감정을 경험하라',254],
        ['이제는 너를 홀로 두지 않으리',259],
        ['그 많던 분노는 어디로 갔을까?',265],
        ['그 감정 속의 충동을 느껴보세요',271],
        ['핵심 감정을 글로 표현해 보자',275]
      ])},
      {id:'chapter-7',label:'7장',title:'알아차림 그리고 다르게 반응하기',page:288,part:2,sections:sections('chapter-7',[
        ['메타인지에 기반한 핵심 감정 알아차림',288],
        ['두뇌 회로 환승하기',291],
        ['감정인식을 위한 자기대화',294],
        ['알아차림은 점점 빨라지고 깊어진다',299],
        ['나의 마음을 부분으로 이해하기',304],
        ['핵심 감정의 알아차림',309],
        ['핵심 감정 관찰일지 쓰기',313],
        ['건강한 감정표현 연습하기',320]
      ])},
      {id:'chapter-8',label:'8장',title:'새로운 감정, 새로운 삶으로',page:330,part:2,sections:sections('chapter-8',[
        ['핵심 감정을 방어하느라 내 인생을 살지 못했다',330],
        ['수많은 되새김이 지나가면',334],
        ['이제 불쾌한 감정을 기꺼이 경험할 수 있다',339],
        ['감정의 회복, 컬러풀한 내 감정',344],
        ['자신의 본질과 깊이 연결된 상태',349],
        ['삶을 새롭게 빚어내기',353]
      ])},
      {id:'epilogue',label:'에필로그',title:'그림자가 빛으로 바뀌다',page:360}
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
    for(var i=info.chapters.length-1;i>=0;i--){
      var chapter=info.chapters[i];
      if(page<chapter.page)continue;
      var children=chapter.sections||[];
      for(var j=children.length-1;j>=0;j--)if(page>=children[j].page)return Object.assign({},children[j],{label:chapter.label,chapterId:chapter.id});
      return chapter;
    }
    return null;
  }
  function hintHtml(bookId,page){
    var section=currentSection(bookId,page);
    return section?'<span class="book-reading-section"><span aria-hidden="true">·</span> 읽는 부분: '+(section.label?escape(section.label)+' · ':'')+escape(section.title)+'</span>':'';
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
    function rowHtml(row,tag,className){
      var selected=section&&section.id===row.id;
      return '<'+tag+' class="book-toc-row'+(className?' '+className:'')+(selected?' is-current':'')+'"'+(selected?' aria-current="location"':'')+'><div>'+(row.label?'<span class="book-toc-label">'+escape(row.label)+'</span>':'')+'<span class="book-toc-title">'+escape(row.title)+'</span>'+(selected?'<span class="book-toc-current">읽는 중</span>':'')+'</div><span class="book-toc-page">'+row.page+'쪽</span></'+tag+'>';
    }
    var toc=info.chapters.map(function(chapter){
      var heading='';
      if(chapter.part&&chapter.part!==part){part=chapter.part;heading='<li class="book-toc-part">'+part+'부 '+(part===1?'핵심 감정이란 무엇인가?':'핵심 감정의 이해와 치료')+'</li>';}
      var children=chapter.sections?'<ol class="book-toc-sections">'+chapter.sections.map(function(child){return rowHtml(child,'li','');}).join('')+'</ol>':'';
      return heading+'<li class="book-toc-chapter">'+rowHtml(chapter,'div','book-toc-chapter-heading')+children+'</li>';
    }).join('');
    return '<header class="book-details-header"><h2 id="book-details-title">책 소개와 목차</h2><button class="icon-btn" type="button" data-book-details-close aria-label="책 소개 닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>'+
      '<div class="book-details-body"><div class="book-details-book"><img src="'+escape(book.cover)+'" alt=""><div><h3>'+escape(book.title)+'</h3><p>'+escape(book.author)+' · '+escape(book.publisher)+'<br>'+info.totalPages+'쪽</p></div></div>'+
      '<section class="book-details-overview"><h3>어떤 책인가요?</h3><p>'+escape(info.overview)+'</p><h3>저자 소개</h3><p>'+escape(info.authorIntro)+'</p></section>'+
      '<section class="book-details-contents"><div class="book-toc-heading"><h3>목차</h3>'+(section?'<span>현재 '+Number(page)+'쪽</span>':'')+'</div><p class="book-toc-note">읽고 있는 부분은 종이책 목차의 첫 본문 쪽수를 기준으로 표시해요.</p><ol class="book-toc">'+toc+'</ol></section>'+
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
