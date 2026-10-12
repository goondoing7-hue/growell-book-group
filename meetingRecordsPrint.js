(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellMeetingRecordsPrint=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function node(document,tag,classes,text){
    var item=document.createElement(tag);if(classes)item.className=classes;
    if(text!==undefined)item.textContent=String(text==null?'':text);return item;
  }
  function paragraph(document,parent,text,classes){
    parent.appendChild(node(document,'p',classes||'mr-print-text',text));
  }
  function section(document,parent,title){
    var item=node(document,'section','mr-print-section');
    item.appendChild(node(document,'h2','',title));parent.appendChild(item);return item;
  }
  function dateLabel(value){return value?String(value).replace(/-/g,'.'):'날짜 미정';}
  function preparationRows(next){
    if(!next||typeof next!=='object')return [];
    var rows=[],when=[next.date?dateLabel(next.date):'',next.time||''].filter(Boolean).join(' · ');
    if(when)rows.push(['일시',when]);
    [['place','장소'],['reading','읽기 범위'],['sharing','나눔'],['habit','독서 습관']].forEach(function(entry){
      if(typeof next[entry[0]]==='string'&&next[entry[0]].trim())rows.push([entry[1],next[entry[0]]]);
    });return rows;
  }
  function buildPrintSheet(document,record,options){
    options=options||{};
    if(!document||!record||!Array.isArray(record.sections)||!Array.isArray(record.concepts)||!Array.isArray(record.materialIds))return null;
    var sheet=node(document,'article','mr-print-sheet');sheet.setAttribute('aria-hidden','true');
    var header=node(document,'header','mr-print-header');sheet.appendChild(header);
    paragraph(document,header,'GROWELL · 모임별 기록','mr-print-brand');
    paragraph(document,header,record.round+'번째 모임 · '+dateLabel(record.date),'mr-print-meta');
    header.appendChild(node(document,'h1','',record.topic||'모임 기록'));
    paragraph(document,header,options.bookTitle||'','mr-print-book');
    if(options.preview)paragraph(document,header,'작성 중인 내용의 미리보기','mr-print-status');
    else if(record.status==='draft')paragraph(document,header,'임시 저장 · 나에게만 공개','mr-print-status');
    var core=section(document,sheet,'핵심 요약'),list=node(document,'ol','mr-print-outline');core.appendChild(list);
    record.sections.forEach(function(item){list.appendChild(node(document,'li','mr-print-text',item.summary));});
    if(record.concepts.length){
      var concepts=section(document,sheet,'함께 살펴본 개념');
      record.concepts.forEach(function(item){
        var block=node(document,'article','mr-print-concept');
        block.appendChild(node(document,'h3','',item.word));paragraph(document,block,item.meaning);concepts.appendChild(block);
      });
    }
    var details=section(document,sheet,'모임 내용');
    record.sections.forEach(function(item,index){
      var story=node(document,'article','mr-print-story');story.appendChild(node(document,'h3','',(index+1)+'. '+item.summary));
      paragraph(document,story,item.detail);details.appendChild(story);
    });
    var preparation=preparationRows(record.nextMeeting);
    if(preparation.length){
      var next=section(document,sheet,'다음 모임 준비');
      preparation.forEach(function(row){
        var item=node(document,'div','mr-print-preparation'+(row[0]==='나눔'?' mr-print-sharing':''));
        item.appendChild(node(document,'h3','',row[0]));paragraph(document,item,row[1]);next.appendChild(item);
      });
    }
    // Only the permission-filtered, currently readable public snapshot may enter
    // print. Never fetch other members' content or copy private/draft records.
    var insights=(Array.isArray(options.insights)?options.insights:[]).filter(function(row){
      return row&&row.id&&row.bookId===record.bookId&&Number(row.round)===Number(record.round)&&row.visible!==false&&row.private!==true&&Array.isArray(row.answers);
    });
    if(insights.length){
      var shared=section(document,sheet,'함께 나눈 통찰'),labels=['모임 소감','새로운 깨달음','실천할 배움'];
      paragraph(document,shared,'열람할 수 있는 통찰 '+insights.length+'개의 현재 내용입니다.','mr-print-note');
      insights.forEach(function(row){
        var item=node(document,'article','mr-print-insight');
        item.appendChild(node(document,'h3','',row.name||'모임원'));
        if(row.date)paragraph(document,item,dateLabel(row.date),'mr-print-note');
        labels.forEach(function(label,index){
          item.appendChild(node(document,'h4','',label));paragraph(document,item,row.answers[index]||'작성한 답변이 없어요.');
        });shared.appendChild(item);
      });
    }
    if(record.materialIds.length){
      var resources=section(document,sheet,'함께 읽고 볼 자료'),materials=Array.isArray(options.materials)?options.materials:[];
      record.materialIds.forEach(function(id){
        var row=materials.find(function(item){return item&&item.id===id&&item.bookId===record.bookId;});
        if(!row){paragraph(document,resources,'삭제되었거나 볼 수 없는 자료','mr-print-note');return;}
        var item=node(document,'p','mr-print-resource'),link=node(document,'a','',row.title||'자료실 글');
        link.setAttribute('href','https://growell-book.vercel.app/#/book/'+encodeURIComponent(record.bookId)+'/materials/post/'+encodeURIComponent(row.id));
        item.appendChild(link);resources.appendChild(item);
      });
    }
    return sheet;
  }
  function printRecord(browser,record,options){
    if(!browser||typeof browser.print!=='function')throw new Error('인쇄 기능을 사용할 수 없어요. 브라우저에서 다시 열어주세요.');
    var document=browser.document,sheet=buildPrintSheet(document,record,options);
    if(!sheet)throw new Error('저장할 모임 기록을 확인하지 못했어요.');
    var removed=false,originalTitle=document.title;
    function cleanup(){
      if(removed)return;removed=true;
      browser.removeEventListener('afterprint',cleanup);browser.removeEventListener('pagehide',cleanup);
      document.body.classList.remove('mr-record-printing');sheet.remove();document.title=originalTitle;
    }
    document.body.appendChild(sheet);document.body.classList.add('mr-record-printing');
    document.title='GROWELL '+record.round+'번째 모임 - '+(record.topic||'모임 기록');
    browser.addEventListener('afterprint',cleanup);browser.addEventListener('pagehide',cleanup);
    try{browser.print();}catch(error){cleanup();throw error;}
    return cleanup;
  }
  return {buildPrintSheet:buildPrintSheet,printRecord:printRecord};
});
