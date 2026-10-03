(function(root,factory){
  var api=factory(root);
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.GrowellMaterialTranscript=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=[],readyCache=new Map(),cacheOwner=null,popup=null,serial=0;
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function validId(id){return typeof id==='string' && /^[A-Za-z0-9_-]{11}$/.test(id);}
  function plainTitle(value){return typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,300).join(''):'';}
  function translationData(value){
    if(!value || value.source!=='ai_translation' || value.language!=='ko' || typeof value.text!=='string' || !value.text.trim())return null;
    return {text:value.text,language:'ko',source:'ai_translation',
      generatedAt:typeof value.generatedAt==='string' && Number.isFinite(Date.parse(value.generatedAt))?value.generatedAt:'',
      model:plainTitle(value.model).slice(0,160),generationId:plainTitle(value.generationId).slice(0,200)};
  }
  function html(postId,video){
    if(!video || !validId(video.id))return '';
    return '<div class="mat-transcript" data-material-transcript="'+esc(video.id)+'" data-transcript-post="'+esc(postId)+'" data-transcript-title="'+esc(video.title || '영상 스크립트')+'">'+
      '<button type="button" class="mat-transcript-open" data-transcript-open disabled aria-haspopup="dialog">전체 스크립트</button>'+
      '<span class="mat-transcript-status" data-transcript-status role="status" aria-live="polite">공개 자막을 확인하고 있어요.</span>'+
      '<button type="button" class="mat-transcript-retry" data-transcript-retry hidden>다시 확인</button></div>';
  }
  function readyData(data,videoId){
    if(!data || data.status!=='ready' || data.videoId!==videoId || !data.transcript || data.transcript.source!=='youtube_captions' || typeof data.transcript.text!=='string' || !data.transcript.text.trim())return null;
    var result={status:'ready',videoId:videoId,text:data.transcript.text,language:typeof data.transcript.language==='string'?data.transcript.language.slice(0,80):'',
      fetchedAt:typeof data.fetchedAt==='string' && Number.isFinite(Date.parse(data.fetchedAt))?data.fetchedAt:'',source:'youtube_captions'};
    var title=plainTitle(data.transcript.title);if(title)result.title=title;
    var translation=translationData(data.translation);if(translation)result.translation=translation;
    else if(data.translationStatus==='pending' || data.translationStatus==='unavailable')result.translationStatus=data.translationStatus;
    return result;
  }
  function languageLabel(language){
    var names={ko:'한국어',en:'영어',ja:'일본어',zh:'중국어','zh-Hans':'중국어(간체)','zh-Hant':'중국어(번체)',es:'스페인어',fr:'프랑스어',de:'독일어'};
    return names[language] || names[String(language || '').toLowerCase().split(/[-_]/)[0]] || (language?language:'언어 정보 없음');
  }
  function captionNotice(details,translated){
    if(translated)return 'AI가 공개 자막을 한국어로 번역한 내용입니다. 원문과 의미가 다를 수 있어요.';
    var fallback='',language=details.language;
    if(language && !/^ko(?:[-_]|$)/i.test(language) && !translationData(details.translation)){
      fallback=details.translationStatus==='pending'?'AI 한국어 번역을 준비 중입니다. '+languageLabel(language)+' 원문을 먼저 확인할 수 있어요. ':'한국어 자막·번역을 가져올 수 없어 '+languageLabel(language)+' 원문을 표시합니다. ';
    }
    return fallback+'자동 생성 자막에는 오탈자가 있을 수 있어요.';
  }
  function fetchedLabel(value){return value?'가져온 시각: '+new Date(value).toLocaleString('ko-KR'):'가져온 시각 정보 없음';}
  function selectedContent(details,view){
    if(!details || details.source!=='youtube_captions' || typeof details.text!=='string' || !details.text.trim())return null;
    var translation=translationData(details.translation),translated=!!translation && view!=='original';
    return {text:translated?translation.text:details.text,language:translated?'ko':details.language,translated:translated,
      label:translated?'AI 한국어 번역':'YouTube 공개 자막 원문',notice:captionNotice(details,translated),
      generatedAt:translated?translation.generatedAt:''};
  }
  function statusText(state){
    if(state.status==='ready'){
      if(translationData(state.translation))return 'AI 한국어 번역 · '+languageLabel(state.language)+' 원문';
      return '공개 자막 원문 · '+languageLabel(state.language)+(state.translationStatus==='pending'?' · 한국어 번역 준비 중':'');
    }
    if(state.status==='loading')return '공개 자막을 확인하고 있어요.';
    var messages={
      transcript_unavailable:'공개 자막이 없어 전체 스크립트를 제공할 수 없어요.',
      video_unavailable:'이 영상의 자막을 확인할 수 없어요.',
      not_configured:'전체 스크립트 기능을 준비하고 있어요.',
      rate_limited:'요청이 많아요. 잠시 후 다시 확인해주세요.',
      temporary_error:'자막을 불러오지 못했어요. 잠시 후 다시 확인해주세요.',
      auth_required:'로그인 후 전체 스크립트를 확인해주세요.',
      forbidden:'이 자료의 스크립트를 볼 수 없어요.',
      not_found:'자료가 삭제되었거나 영상 링크가 변경되었어요.',
      processing:'자막을 준비하고 있어요. 잠시 후 다시 확인해주세요.'
    };
    return messages[state.reason] || messages.temporary_error;
  }
  function retryable(state){return state.status==='ready'?state.translationRetryAvailable===true:state.status!=='loading' && ['rate_limited','temporary_error','processing'].indexOf(state.reason)>=0;}

  function createController(options){
    var stopped=false,busy=false,timer=null,controller=null,attempts=0,latestReady=null;
    var setTimer=options.setTimeout || root.setTimeout.bind(root),clearTimer=options.clearTimeout || root.clearTimeout.bind(root);
    var Abort=options.AbortController || root.AbortController;
    function current(){return !stopped && options.isCurrent();}
    function render(state){if(current())options.render(state);}
    function fail(reason){
      if(latestReady && ['auth_required','forbidden','not_found'].indexOf(reason)<0){
        latestReady=Object.assign({},latestReady,{translationStatus:'unavailable',translationRetryAvailable:true});render(latestReady);
      }else{latestReady=null;render({status:'unavailable',reason:reason});}
    }
    function poll(data){
      if(attempts>=4)return;
      var delay=Math.max(2,Math.min(15,Number(data.retryAfter)||3))*1000;
      timer=setTimer(function(){timer=null;request();},delay);
    }
    async function request(){
      if(!current() || busy)return;
      busy=true;attempts++;
      controller=Abort?new Abort():null;
      var requestController=controller;
      var timeout=setTimer(function(){if(requestController)requestController.abort();},55000);
      try{
        var token=await options.getAccessToken();
        if(!current())return;
        if(!token){fail('auth_required');return;}
        var response=await options.fetch('/api/material-video-transcript',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
          body:JSON.stringify({postId:options.postId,videoId:options.videoId}),signal:requestController && requestController.signal});
        if(!current())return;
        if(!response.ok){fail(response.status===401?'auth_required':response.status===403?'forbidden':response.status===404?'not_found':response.status===429?'rate_limited':'temporary_error');return;}
        var data=await response.json();
        if(!current())return;
        var ready=readyData(data,options.videoId);
        if(ready){
          latestReady=ready;
          if(ready.translationStatus==='pending'){
            if(attempts>=4)latestReady=Object.assign({},ready,{translationRetryAvailable:true});
            render(latestReady);poll(data);
          }else{if(options.onReady)options.onReady(ready);render(ready);}
          return;
        }
        if(data && data.status==='pending'){
          if(latestReady){latestReady=Object.assign({},latestReady,{translationStatus:'pending',translationRetryAvailable:attempts>=4});render(latestReady);}
          else if(attempts>=4)fail('processing');
          poll(data);
          return;
        }
        fail(data && data.status==='unavailable'?data.reason:'temporary_error');
      }catch(error){if(current())fail(error && error.message==='auth_required'?'auth_required':'temporary_error');}
      finally{clearTimer(timeout);busy=false;}
    }
    function start(){
      if(!current() || busy)return;
      if(timer!==null){clearTimer(timer);timer=null;}
      attempts=0;
      if(latestReady){latestReady=Object.assign({},latestReady,{translationStatus:'pending',translationRetryAvailable:false});render(latestReady);}
      else render({status:'loading'});
      return request();
    }
    return {start:start,dispose:function(){stopped=true;if(timer!==null)clearTimer(timer);if(controller)controller.abort();}};
  }

  function node(document,tag,className,text){
    var element=document.createElement(tag);
    if(className)element.className=className;
    if(text!==undefined)element.textContent=text;
    return element;
  }
  function sourceUrl(videoId){return 'https://www.youtube.com/watch?v='+videoId;}
  function buildPrintSheet(document,details,view){
    var content=selectedContent(details,view);
    if(!content || !validId(details.videoId))return null;
    var sheet=node(document,'section','mat-transcript-print-sheet');
    sheet.setAttribute('aria-hidden','true');
    sheet.appendChild(node(document,'p','mat-transcript-print-brand','GROWELL · 자료실'));
    sheet.appendChild(node(document,'h1','',details.title || '영상 스크립트'));
    sheet.appendChild(node(document,'p','mat-transcript-print-meta',content.label+' · '+languageLabel(content.language)));
    if(content.translated)sheet.appendChild(node(document,'p','mat-transcript-print-meta','원문 언어: '+languageLabel(details.language)));
    sheet.appendChild(node(document,'p','mat-transcript-print-meta',fetchedLabel(details.fetchedAt)));
    if(content.generatedAt)sheet.appendChild(node(document,'p','mat-transcript-print-meta','번역 시각: '+new Date(content.generatedAt).toLocaleString('ko-KR')));
    sheet.appendChild(node(document,'p','mat-transcript-print-source',(content.translated?'원문 영상 출처: ':'출처: ')+sourceUrl(details.videoId)));
    sheet.appendChild(node(document,'p','mat-transcript-print-notice',content.notice));
    sheet.appendChild(node(document,'div','mat-transcript-print-text',content.text));
    return sheet;
  }
  function printTranscript(browser,details,view){
    var document=browser.document,sheet=buildPrintSheet(document,details,view);
    if(!sheet || typeof browser.print!=='function')return function(){};
    var removed=false;
    function cleanup(){
      if(removed)return;removed=true;
      browser.removeEventListener('afterprint',cleanup);
      document.body.classList.remove('mat-transcript-printing');
      sheet.remove();
    }
    document.body.appendChild(sheet);document.body.classList.add('mat-transcript-printing');
    browser.addEventListener('afterprint',cleanup);
    try{browser.print();}catch(error){cleanup();throw error;}
    return cleanup;
  }
  function openPopup(options,details,trigger){
    if(!options.isCurrent())return null;
    if(popup)popup.close();
    var selected=translationData(details.translation)?'translation':'original',userSelected=false;
    var document=root.document,dialog=node(document,'dialog','mat-transcript-dialog'),id='mat-transcript-title-'+(++serial);
    dialog.setAttribute('aria-labelledby',id);
    var head=node(document,'div','mat-transcript-dialog-head'),heading=node(document,'div','');
    var eyebrow=node(document,'p','mat-transcript-eyebrow');heading.appendChild(eyebrow);
    var title=node(document,'h2','',details.title || '영상 스크립트');title.id=id;heading.appendChild(title);head.appendChild(heading);
    var closeButton=node(document,'button','mat-transcript-close','닫기');closeButton.type='button';head.appendChild(closeButton);dialog.appendChild(head);
    var views=node(document,'div','mat-transcript-views');views.setAttribute('role','group');views.setAttribute('aria-label','스크립트 보기');
    var translatedButton=node(document,'button','','AI 한국어 번역'),originalButton=node(document,'button');
    translatedButton.type='button';originalButton.type='button';translatedButton.setAttribute('data-transcript-view','translation');originalButton.setAttribute('data-transcript-view','original');
    views.appendChild(translatedButton);views.appendChild(originalButton);dialog.appendChild(views);
    var meta=node(document,'div','mat-transcript-meta'),metaLanguage=node(document,'span'),metaFetched=node(document,'span'),metaGenerated=node(document,'span');
    meta.appendChild(metaLanguage);meta.appendChild(metaFetched);meta.appendChild(metaGenerated);dialog.appendChild(meta);
    var notice=node(document,'p','mat-transcript-notice');notice.setAttribute('aria-live','polite');dialog.appendChild(notice);
    var text=node(document,'div','mat-transcript-text');text.tabIndex=0;text.setAttribute('role','region');dialog.appendChild(text);
    var footer=node(document,'div','mat-transcript-dialog-actions'),source=node(document,'a','','YouTube 원본 보기 ↗');
    source.href=sourceUrl(details.videoId);source.target='_blank';source.rel='noopener noreferrer';footer.appendChild(source);
    var printButton=node(document,'button','mat-transcript-print','인쇄 · PDF 저장');printButton.type='button';footer.appendChild(printButton);dialog.appendChild(footer);
    var printHelp=node(document,'p','mat-transcript-print-help','PDF로 보관하려면 인쇄 창에서 “PDF로 저장”을 선택하세요.');dialog.appendChild(printHelp);
    var closed=false,clearPrint=null;
    function renderView(){
      var content=selectedContent(details,selected);if(!content)return;
      views.hidden=!translationData(details.translation);
      originalButton.textContent=languageLabel(details.language)+' 원문';
      translatedButton.setAttribute('aria-pressed',content.translated?'true':'false');originalButton.setAttribute('aria-pressed',content.translated?'false':'true');
      eyebrow.textContent='전체 스크립트 · '+(content.translated?'AI 한국어 번역':'공개 자막 원문');
      title.textContent=details.title || '영상 스크립트';metaLanguage.textContent=languageLabel(content.language)+(content.translated?' · 원문 '+languageLabel(details.language):'');
      metaFetched.textContent=fetchedLabel(details.fetchedAt);metaGenerated.hidden=!content.generatedAt;
      metaGenerated.textContent=content.generatedAt?'번역 시각: '+new Date(content.generatedAt).toLocaleString('ko-KR'):'';
      notice.textContent=content.notice;if(text.textContent!==content.text)text.textContent=content.text;text.setAttribute('aria-label',content.translated?'AI 한국어 번역':'자막 원문');
    }
    function select(view){if(!options.isCurrent()){close();return;}selected=view;userSelected=true;renderView();text.scrollTop=0;}
    translatedButton.addEventListener('click',function(){select('translation');});originalButton.addEventListener('click',function(){select('original');});
    function cleanup(){
      if(closed)return;closed=true;
      if(clearPrint)clearPrint();
      dialog.remove();if(popup && popup.dialog===dialog)popup=null;
      if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('material-transcript');
      if(trigger && trigger.isConnected && options.isCurrent())trigger.focus({preventScroll:true});
    }
    function close(){if(dialog.open)dialog.close();cleanup();}
    closeButton.addEventListener('click',close);
    dialog.addEventListener('close',cleanup);
    dialog.addEventListener('cancel',function(event){event.preventDefault();close();});
    dialog.addEventListener('click',function(event){if(event.target===dialog){var rect=dialog.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)close();}});
    printButton.addEventListener('click',function(){
      if(!options.isCurrent()){close();return;}
      if(clearPrint)clearPrint();
      try{clearPrint=printTranscript(root,details,selected);}catch(error){printHelp.textContent='인쇄 창을 열지 못했어요. 잠시 후 다시 시도해주세요.';}
    });
    renderView();document.body.appendChild(dialog);dialog.showModal();closeButton.focus();
    popup={dialog:dialog,owner:options.owner,binding:options.binding,close:close,update:function(nextDetails){
      details=nextDetails;
      if(!userSelected)selected=translationData(details.translation)?'translation':'original';
      if(selected==='translation' && !translationData(details.translation))selected='original';
      renderView();
    }};
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('material-transcript',{close:close});
    return popup;
  }
  function stopBindings(owner){
    active=active.filter(function(binding){if(owner!==undefined && binding.owner!==owner)return true;binding.dispose();return false;});
    if(popup && (owner===undefined || popup.owner===owner))popup.close();
  }
  function dispose(owner){
    stopBindings(owner);
    if(owner===undefined || owner===cacheOwner){readyCache.clear();cacheOwner=null;}
  }
  function bind(options){
    stopBindings();
    if(cacheOwner!==options.owner){readyCache.clear();cacheOwner=options.owner;}
    if(!options.owner || !options.container)return function(){};
    var bindings=[];
    options.container.querySelectorAll('[data-material-transcript]').forEach(function(element){
      var videoId=element.getAttribute('data-material-transcript'),postId=element.getAttribute('data-transcript-post');
      if(!validId(videoId))return;
      var open=element.querySelector('[data-transcript-open]'),status=element.querySelector('[data-transcript-status]'),retry=element.querySelector('[data-transcript-retry]');
      if(!open || !status || !retry)return;
      var ready=null,key=String(options.owner)+'|'+postId+'|'+videoId,live=true;
      function current(){return live && element.isConnected && options.isCurrent(postId,videoId);}
      function render(state){
        if(!current())return;ready=state.status==='ready'?state:null;
        open.disabled=!ready;status.textContent=statusText(state);status.setAttribute('aria-busy',state.status==='loading' || state.translationStatus==='pending'?'true':'false');retry.hidden=!retryable(state);
        if(popup && popup.binding===binding){if(ready)popup.update(Object.assign({title:element.getAttribute('data-transcript-title')},ready));else popup.close();}
      }
      var controller=createController({postId:postId,videoId:videoId,isCurrent:current,getAccessToken:options.getAccessToken,fetch:options.fetch,render:render,
        onReady:function(data){if(current()){if(readyCache.size>=24)readyCache.delete(readyCache.keys().next().value);readyCache.set(key,data);}}});
      open.onclick=function(){if(current() && ready)openPopup({owner:options.owner,isCurrent:current,binding:binding},Object.assign({title:element.getAttribute('data-transcript-title')},ready),open);};
      retry.onclick=function(){if(current())controller.start();};
      var binding={owner:options.owner,dispose:function(){live=false;controller.dispose();open.onclick=null;retry.onclick=null;}};
      bindings.push(binding);active.push(binding);
      if(readyCache.has(key))render(readyCache.get(key));else controller.start();
    });
    return function(){bindings.forEach(function(binding){binding.dispose();});active=active.filter(function(binding){return bindings.indexOf(binding)<0;});if(popup && bindings.indexOf(popup.binding)>=0)popup.close();};
  }
  return {html:html,bind:bind,dispose:dispose,createController:createController,readyData:readyData,statusText:statusText,buildPrintSheet:buildPrintSheet,printTranscript:printTranscript};
});
