(function(root,factory){
  'use strict';
  var api=factory(root.GrowellMeetingRecordsDomain||(typeof module==='object'&&module.exports?require('./meetingRecordsDomain.js'):null));
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellMeetingRecordsPrint=api;
})(typeof window!=='undefined'?window:globalThis,function(domain){
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
    var rows=[],time=next.time?(next.time+(next.endTime?'~'+next.endTime:'')):(next.endTime?next.endTime+' 종료':''),when=[next.date?dateLabel(next.date):'',time].filter(Boolean).join(' · ');
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
    if(Array.isArray(record.thoughtQuestions)&&record.thoughtQuestions.length){
      var questions=section(document,sheet,'생각 질문'),questionList=node(document,'ol','mr-print-thought-questions');questions.appendChild(questionList);
      record.thoughtQuestions.forEach(function(item){questionList.appendChild(node(document,'li','mr-print-text',item.text));});
    }
    var details=section(document,sheet,'모임 내용');
    record.sections.forEach(function(item,index){
      var story=node(document,'article','mr-print-story');story.appendChild(node(document,'h3','',(index+1)+'. '+item.summary));
      var parts=domain&&typeof domain.detailParts==='function'?domain.detailParts(item.detail):{question:'',body:item.detail};
      var sharing=domain&&typeof domain.sharingParts==='function'?domain.sharingParts(item.summary,item.detail):null;
      if(sharing)sharing.forEach(function(part){
        var card=node(document,'article','mr-print-sharing-card');card.appendChild(node(document,'h4','',part.name));paragraph(document,card,part.body);story.appendChild(card);
      });
      else {
        if(parts.question)paragraph(document,story,'생각 질문: '+parts.question,'mr-print-topic-question');
        paragraph(document,story,parts.body);
      }
      details.appendChild(story);
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
        var item=node(document,'article','mr-print-insight'),author=node(document,'header','mr-print-insight-header');
        author.appendChild(node(document,'h3','mr-print-insight-name',row.name||'모임원'));
        if(row.date)paragraph(document,author,dateLabel(row.date),'mr-print-insight-date');
        item.appendChild(author);
        labels.forEach(function(label,index){
          var answer=node(document,'div','mr-print-answer'),question=node(document,'h4','mr-print-question');
          question.appendChild(node(document,'span','mr-print-question-number',String(index+1).padStart(2,'0')));
          question.appendChild(node(document,'span','',label));answer.appendChild(question);
          paragraph(document,answer,row.answers[index]||'작성한 답변이 없어요.','mr-print-text mr-print-answer-text');
          item.appendChild(answer);
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
  function downloadRecord(browser,record,options){
    options=options||{};
    var controller=browser&&typeof browser.AbortController==='function'?new browser.AbortController():null;
    var cancelled=false,timer=null;
    function active(){
      if(cancelled||typeof options.isCurrent!=='function'||!options.isCurrent())throw new Error('계정이나 화면이 변경되어 PDF 다운로드를 중단했어요.');
    }
    var task=(async function(){
      active();
      if(!browser||typeof browser.fetch!=='function'||!browser.document||!browser.URL||typeof browser.URL.createObjectURL!=='function'||typeof options.getAccessToken!=='function')throw new Error('PDF 다운로드 기능을 불러오지 못했어요. 페이지를 새로 열어주세요.');
      if(!record||!record.id||!record.bookId||!Number.isInteger(record.round)||record.round<1||record.round>9999)throw new Error('내려받을 모임 기록을 확인하지 못했어요.');
      var payload=options.preview?{preview:JSON.parse(JSON.stringify(record))}:{bookId:record.bookId,recordId:record.id};
      var token=await options.getAccessToken();active();
      if(typeof token!=='string'||!token)throw new Error('다시 로그인한 뒤 PDF를 저장해주세요.');
      if(controller&&typeof browser.setTimeout==='function')timer=browser.setTimeout(function(){cancelled=true;controller.abort();},65000);
      var response=await browser.fetch('/api/meeting-record-pdf',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify(payload),credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller?controller.signal:undefined});
      active();
      if(!response.ok){
        var result;try{result=await response.json();}catch(_){result={};}active();
        var messages={'authentication-required':'다시 로그인한 뒤 PDF를 저장해주세요.','membership-required':'이 모임 기록을 내려받을 권한이 없어요.',
          'record-unavailable':'모임 기록을 다시 연 뒤 PDF를 저장해주세요.','record-changed':'모임 기록이 변경됐어요. 다시 연 뒤 PDF를 저장해주세요.',
          'not-configured':'PDF 다운로드 준비가 아직 완료되지 않았어요.','invalid-request':'모임 기록 내용을 확인한 뒤 다시 저장해주세요.',
          'pdf-glyph-unsupported':'PDF 글꼴에서 지원하지 않는 문자가 있어요. 원문은 그대로 보존돼 있어요.',
          'pdf-layout-overflow':'PDF를 만들 수 있는 분량을 초과했어요. 작성 내용은 그대로 보존되어 있어요.','rate-limited':'잠시 후 다시 PDF를 저장해주세요.'};
        throw new Error(messages[result&&result.error]||'PDF를 만들지 못했어요. 잠시 후 다시 저장해주세요.');
      }
      var type=response.headers&&response.headers.get('Content-Type')||'',length=Number(response.headers&&response.headers.get('Content-Length'));
      if(type.split(';')[0].trim().toLowerCase()!=='application/pdf'||length>8*1024*1024)throw new Error('PDF 파일을 확인하지 못했어요. 잠시 후 다시 저장해주세요.');
      var blob=await response.blob();active();
      if(!blob||blob.size<100||blob.size>8*1024*1024||await blob.slice(0,5).text()!=='%PDF-'||!(await blob.slice(-1024).text()).includes('%%EOF'))throw new Error('완전한 PDF 파일을 받지 못했어요. 다시 저장해주세요.');
      active();
      var filename='GROWELL-meeting-'+record.round+'.pdf',url=browser.URL.createObjectURL(blob),anchor=browser.document.createElement('a');
      try{
        anchor.href=url;anchor.download=filename;anchor.setAttribute('hidden','');anchor.setAttribute('rel','noopener');
        browser.document.body.appendChild(anchor);active();anchor.click();
      }finally{
        anchor.remove();
        if(typeof browser.setTimeout==='function')browser.setTimeout(function(){browser.URL.revokeObjectURL(url);},60000);
        else browser.URL.revokeObjectURL(url);
      }
      return {filename:filename,size:blob.size};
    })();
    task.cancel=function(){cancelled=true;if(controller)controller.abort();};
    var completed=task.finally(function(){if(timer!==null&&typeof browser.clearTimeout==='function')browser.clearTimeout(timer);});
    completed.cancel=task.cancel;return completed;
  }
  return {buildPrintSheet:buildPrintSheet,printRecord:printRecord,downloadRecord:downloadRecord};
});
