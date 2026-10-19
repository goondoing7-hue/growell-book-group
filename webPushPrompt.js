(function(root,factory){
  var api=factory(root,typeof module==='object'&&module.exports?require('./webPush.js'):root.GrowellWebPush);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellWebPushPrompt=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root,Push){
  'use strict';
  var SNOOZE=7*86400000,PREFIX='growell_push_prompt_v1:';
  function memberHash(value){
    if(typeof value!=='string'||!value||value.length>320)return '';
    var a=2166136261,b=3339675911;for(var i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),2246822519);}
    return (a>>>0).toString(16)+'-'+(b>>>0).toString(16);
  }
  function create(config){
    config=config||{};var generation=0,disposed=false,shown=false,pending=null,active=null,memory=Object.create(null),skipped=new Set(),retryAt=Object.create(null);
    function now(){return typeof config.now==='function'?config.now():Date.now();}
    function storage(){return config.storage||root.localStorage;}
    function snoozed(key){
      var current=now(),until=memory[key]||0;
      try{var raw=storage().getItem(PREFIX+key);if(raw&&raw.length<100){var value=JSON.parse(raw);if(value&&Object.keys(value).length===1&&Number.isFinite(value.until))until=Math.max(until,value.until);}}catch(error){}
      return until>current&&until<=current+SNOOZE+60000;
    }
    function snooze(key){var until=now()+SNOOZE;memory[key]=until;try{storage().setItem(PREFIX+key,JSON.stringify({until:until}));}catch(error){}}
    function valid(job){return !disposed&&job.generation===generation&&job.options.isCurrent();}
    function canPresent(job){
      try{return valid(job)&&job.options.canPresent()&&!root.document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]');}catch(error){return false;}
    }
    function close(later,restore){
      var view=active;if(!view)return;active=null;
      if(later)snooze(view.job.key);view.controller.destroy();
      if(view.node.open)view.node.close();view.node.remove();
      if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('web-push-prompt');
      if(restore!==false&&valid(view.job)&&view.previous&&view.previous.isConnected!==false&&typeof view.previous.focus==='function')try{view.previous.focus({preventScroll:true});}catch(error){}
    }
    function cancel(job){if(!job)return;if(job.cancelDelay)job.cancelDelay();job.controller.destroy();}
    function afterArrival(job){return new Promise(function(resolve){
      var timer=root.setTimeout(function(){job.cancelDelay=null;resolve(valid(job));},800);
      job.cancelDelay=function(){root.clearTimeout(timer);job.cancelDelay=null;resolve(false);};
    });}
    function show(job,controller,state){
      if(!canPresent(job))return false;
      var install=state.iosNeedsInstall,node=root.document.createElement('dialog');node.className='web-push-prompt';node.setAttribute('aria-labelledby','web-push-prompt-title');
      node.innerHTML='<header class="web-push-prompt-head"><h2 id="web-push-prompt-title">'+(install?'홈 화면에서 알림을 받아요':'GROWELL 알림을 받아볼까요?')+'</h2><button type="button" data-push-prompt-close aria-label="알림 안내 닫기">×</button></header>'+
        '<div class="web-push-prompt-body">'+(install?'<p>아이폰·아이패드는 Safari에서 GROWELL을 <strong>홈 화면에 추가</strong>한 뒤 알림을 켤 수 있어요.</p><ol><li>Safari의 공유 메뉴에서 홈 화면에 추가를 선택해요.</li><li>홈 화면의 GROWELL 아이콘을 열어요.</li><li>프로필 → 연동 → 푸시 알림에서 알림을 허용해요.</li></ol><p class="web-push-note">iOS·iPadOS 16.4 이상이 필요해요. 지금은 알림 권한을 요청하지 않아요.</p>':
          '<p>이 기기에서 새 나눔·자료와 오늘의 말씀을 놓치지 않고 확인해요.</p><ul><li><strong>새로운 나눔·자료</strong><span>나눔과 자료실의 새 글을 받아요. 내가 쓴 글과 글 수정은 제외해요.</span></li><li><strong>매일 오전 9시 말씀</strong><span>한국 시간 기준으로 보내요.</span></li></ul><p class="web-push-note">다음 화면에서 브라우저 알림을 허용해주세요. 알림 종류는 프로필 → 연동에서 각각 바꿀 수 있어요.</p>')+
          '<p class="web-push-prompt-status" data-push-prompt-status role="status" aria-live="polite"></p><div class="web-push-prompt-actions">'+(install?'':'<button type="button" class="web-push-primary" data-push-prompt-enable>알림 받기</button>')+'<button type="button" class="web-push-prompt-later" data-push-prompt-later>나중에</button></div><p class="web-push-note">나중에를 누르면 7일 동안 이 안내를 쉬어요.</p></div>';
      var view={job:job,node:node,controller:controller,previous:root.document.activeElement,install:install};active=view;
      function current(){return active===view&&valid(job);}
      function q(selector){return node.querySelector(selector);}
      function draw(value){
        if(!current())return;
        var status=q('[data-push-prompt-status]');status.textContent=value.errorCode?Push.message({code:value.errorCode}):value.busy?'알림을 연결하고 있어요…':value.notice||'';
        status.classList.toggle('is-error',!!value.errorCode);node.setAttribute('aria-busy',String(value.busy));
        if(!install)q('[data-push-prompt-enable]').disabled=value.busy||value.permission==='denied'||!value.configured;
      }
      job.draw=draw;q('[data-push-prompt-close]').onclick=function(){close(true);};q('[data-push-prompt-later]').onclick=function(){close(true);};
      node.addEventListener('cancel',function(event){event.preventDefault();close(true);});
      node.addEventListener('click',function(event){if(event.target!==node)return;var rect=node.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close(true);});
      if(!install)q('[data-push-prompt-enable]').onclick=function(){
        if(!current())return;
        // Call directly in this click: browser permission must retain the user's gesture.
        var result=controller.enable();
        Promise.resolve(result).then(function(ok){if(current()&&ok&&controller.snapshot().subscribed)close(false);}).catch(function(){});
      };
      root.document.body.appendChild(node);
      try{node.showModal();}catch(error){active=null;node.remove();return false;}
      shown=true;draw(state);q(install?'[data-push-prompt-later]':'[data-push-prompt-enable]').focus({preventScroll:true});
      if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('web-push-prompt',{close:function(){close(true);}});
      return true;
    }
    function maybeShow(options){
      if(disposed||shown||!root.document||!Push||!options||typeof options.isCurrent!=='function'||typeof options.getAccessToken!=='function'||typeof options.canPresent!=='function')return Promise.resolve(false);
      var key=memberHash(options.memberKey);if(!key||skipped.has(key)||retryAt[key]>now())return Promise.resolve(false);
      if(pending){if(pending.key===key&&valid(pending))return pending.promise;generation++;cancel(pending);pending=null;}
      var job={key:key,generation:generation,options:options,draw:null};
      if(snoozed(key)||!canPresent(job))return Promise.resolve(false);
      var controller=Push.createController({isCurrent:function(){return valid(job);},getAccessToken:options.getAccessToken,onChange:function(state){if(job.draw)job.draw(state);}});job.controller=controller;pending=job;
      job.promise=controller.refresh().then(function(ok){
        if(!valid(job))return false;var state=controller.snapshot();
        if(!ok||state.errorCode||!state.loaded){retryAt[key]=now()+45000;return false;}
        if(state.permission==='denied'||state.subscribed||!state.iosNeedsInstall&&!state.supported){skipped.add(key);return false;}
        if(!state.iosNeedsInstall&&!state.configured){retryAt[key]=now()+45000;return false;}
        return afterArrival(job).then(function(ready){return ready&&show(job,controller,state);});
      }).catch(function(){if(valid(job))retryAt[key]=now()+45000;return false;}).finally(function(){if(pending===job)pending=null;if(!active||active.job!==job)controller.destroy();});
      return job.promise;
    }
    function reset(){generation++;shown=false;skipped.clear();retryAt=Object.create(null);if(pending){cancel(pending);pending=null;}close(false,false);}
    function check(){if(active&&!valid(active.job))close(false,false);if(pending&&!valid(pending)){cancel(pending);pending=null;}}
    if(root.addEventListener){root.addEventListener('hashchange',check);root.addEventListener('pagehide',reset);}
    return {maybeShow:maybeShow,reset:reset,destroy:function(){reset();disposed=true;if(root.removeEventListener){root.removeEventListener('hashchange',check);root.removeEventListener('pagehide',reset);}}};
  }
  return {create:create};
});
