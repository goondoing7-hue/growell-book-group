(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitReminder=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=null;
  function clean(value,limit){return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit):'';}
  function buildShareData(habit){
    if(!habit)return null;
    var name=clean(habit.name,200);if(!name)return null;
    var lines=[name,habit.behaviorType==='avoid'?'절제할 습관':'실천할 습관'];
    [['goal','목표'],['time','시간'],['place','장소'],['bookTitle','읽을 책']].forEach(function(field){
      var value=clean(habit[field[0]],500);if(value)lines.push(field[1]+': '+value);
    });
    var start=clean(habit.startDate,10),end=clean(habit.endDate,10),date=/^\d{4}-\d{2}-\d{2}$/;
    if(date.test(start))lines.push('시작일: '+start);
    if(date.test(end))lines.push('목표일: '+end);
    var data={title:name,text:lines.join('\n')};
    // Only the public habit screen may be attached; never forward query tokens or private IDs.
    try{
      var url=new URL(habit.url);
      if((url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].indexOf(url.hostname)>=0)&&!url.username&&!url.password&&!url.search&&url.pathname==='/'&&/^#\/book\/(emotion|thought|body|action)\/habit$/.test(url.hash))data.url=url.href;
    }catch(error){}
    return data;
  }
  function copyText(data){return data.text+(data.url?'\n\n'+data.url:'');}

  // Both sharing and copying read a fresh, owner-checked snapshot at the user's click.
  function createActions(options){
    var disposed=false,busy=false;
    function snapshot(){
      if(disposed)return null;
      var data=null;
      try{data=buildShareData(options.getHabit());}catch(error){}
      if(!data){disposed=true;if(options.onInvalid)options.onInvalid();}
      return data;
    }
    function emit(state,target,data){if(!disposed&&options.onResult)options.onResult(state,target,data);}
    function setBusy(value){busy=value;if(!disposed&&options.onBusy)options.onBusy(value);}
    function finish(promise,target,data,success){
      return Promise.resolve(promise).then(function(){if(snapshot())emit(success,target,data);},function(error){
        if(!snapshot())return;
        emit(error&&error.name==='AbortError'?'cancelled':success==='copied'?'copy-manually':'unavailable',target,data);
      }).finally(function(){setBusy(false);});
    }
    function share(target){
      if(busy||['samsung','apple'].indexOf(target)<0)return Promise.resolve();
      var data=snapshot();if(!data)return Promise.resolve();
      if(options.onPreview)options.onPreview(data);
      var nav=options.navigator||{};
      try{
        if(options.secure===false||typeof nav.share!=='function'||typeof nav.canShare==='function'&&!nav.canShare(data)){emit('unavailable',target,data);return Promise.resolve();}
        setBusy(true);
        // No awaited work precedes the native call: preserve the click's transient activation.
        return finish(nav.share(data),target,data,'handed-off');
      }catch(error){setBusy(false);if(snapshot())emit(error&&error.name==='AbortError'?'cancelled':'unavailable',target,data);return Promise.resolve();}
    }
    function copy(){
      if(busy)return Promise.resolve();
      var data=snapshot();if(!data)return Promise.resolve();
      if(options.onPreview)options.onPreview(data);
      var clipboard=(options.navigator||{}).clipboard;
      if(!clipboard||typeof clipboard.writeText!=='function'){emit('copy-manually','',data);return Promise.resolve();}
      try{setBusy(true);return finish(clipboard.writeText(copyText(data)),'',data,'copied');}
      catch(error){setBusy(false);if(snapshot())emit('copy-manually','',data);return Promise.resolve();}
    }
    return {share:share,copy:copy,snapshot:snapshot,dispose:function(){disposed=true;}};
  }

  function close(restore){
    var view=active;if(!view)return;
    active=null;view.actions.dispose();view.node.close();view.node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('habit-reminder');
    if(restore!==false&&typeof view.restoreFocus==='function')view.restoreFocus();
  }
  function refresh(){
    var view=active;if(!view)return;
    var data=view.actions.snapshot();if(data&&active===view)view.preview(data);
  }
  function open(options){
    options=options||{};if(!root.document||typeof options.getHabit!=='function')return;
    close(false);
    var first;try{first=buildShareData(options.getHabit());}catch(error){}
    if(!first)return;
    var node=root.document.createElement('dialog');
    node.className='habit-reminder-dialog';node.setAttribute('aria-labelledby','habit-reminder-title');
    node.innerHTML='<header class="habit-reminder-head"><div><p>나의 습관, 잊지 않도록</p><h2 id="habit-reminder-title">알림에 추가</h2></div><button type="button" data-reminder-close aria-label="알림에 추가 닫기">×</button></header>'+
      '<div class="habit-reminder-body"><p class="habit-reminder-intro">사용할 앱을 골라주세요. 공유 화면에서 해당 앱을 선택한 뒤 날짜·시간·반복을 설정해 저장하면 돼요.</p>'+
      '<section class="habit-reminder-preview" aria-label="추가할 습관"><h3 data-reminder-name></h3><p data-reminder-details></p></section>'+
      '<div class="habit-reminder-apps"><button type="button" data-reminder-target="samsung"><span class="habit-reminder-symbol" aria-hidden="true">✓</span><span><strong>삼성 리마인더에 추가</strong><small>공유 화면에서 ‘리마인더’ 선택</small></span><span aria-hidden="true">↗</span></button>'+
      '<button type="button" data-reminder-target="apple"><span class="habit-reminder-symbol" aria-hidden="true">☷</span><span><strong>애플 미리 알림에 추가</strong><small>공유 화면에서 ‘미리 알림’ 선택</small></span><span aria-hidden="true">↗</span></button></div>'+
      '<p class="habit-reminder-status" data-reminder-status role="status" aria-live="polite"></p>'+
      '<div class="habit-reminder-copy"><button type="button" data-reminder-copy>내용 복사</button><span>앱이 보이지 않으면 복사해서 붙여넣으세요.</span></div>'+
      '<div data-reminder-manual hidden><label for="habit-reminder-text">직접 복사할 내용</label><textarea id="habit-reminder-text" readonly rows="6"></textarea><p>내용을 선택해 복사한 뒤 알림 앱에서 새 항목에 붙여넣어주세요.</p></div>'+
      '<p class="habit-reminder-note">습관 체크와 알림 앱의 완료 표시는 각각 관리돼요.</p></div>';
    root.document.body.appendChild(node);
    var status=node.querySelector('[data-reminder-status]'),manual=node.querySelector('[data-reminder-manual]'),field=node.querySelector('#habit-reminder-text');
    function preview(data){
      node.querySelector('[data-reminder-name]').textContent=data.title;
      node.querySelector('[data-reminder-details]').textContent=data.text.split('\n').slice(1).join('\n');
      field.value=copyText(data);
    }
    var view={node:node,preview:preview,restoreFocus:options.restoreFocus};
    view.actions=createActions({getHabit:options.getHabit,navigator:root.navigator,secure:root.isSecureContext,onPreview:preview,onInvalid:function(){if(active===view)close(false);},
      onBusy:function(busy){node.querySelectorAll('[data-reminder-target],[data-reminder-copy]').forEach(function(button){button.disabled=busy;});},
      onResult:function(state,target){
        var app=target==='samsung'?'삼성 리마인더':'애플 미리 알림';
        if(state==='handed-off')status.textContent='알림 앱에서 날짜·시간·반복을 확인하고 저장해주세요.';
        else if(state==='copied')status.textContent='복사했어요. 알림 앱에서 새 항목을 만들어 붙여넣고 시간과 반복을 설정해주세요.';
        else if(state==='unavailable'){status.textContent='이 환경에서는 공유 화면을 열 수 없어요. 내용을 복사해 '+app+'에 붙여넣어주세요.';manual.hidden=false;}
        else if(state==='copy-manually'){status.textContent='아래 내용을 길게 누르거나 선택해서 직접 복사해주세요.';manual.hidden=false;field.focus();field.select();}
        else if(state==='cancelled')status.textContent='';
      }});
    active=view;preview(first);
    node.querySelector('[data-reminder-close]').onclick=function(){close();};
    node.addEventListener('cancel',function(event){event.preventDefault();close();});
    node.addEventListener('click',function(event){if(event.target===node){var rect=node.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
    node.querySelectorAll('[data-reminder-target]').forEach(function(button){button.onclick=function(){view.actions.share(button.getAttribute('data-reminder-target'));};});
    node.querySelector('[data-reminder-copy]').onclick=function(){view.actions.copy();};
    node.showModal();node.querySelector('[data-reminder-close]').focus({preventScroll:true});
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('habit-reminder',{close:function(){close();}});
  }
  if(root.addEventListener){root.addEventListener('hashchange',refresh);root.addEventListener('pagehide',function(){close(false);});}
  return {open:open,close:close,refresh:refresh,buildShareData:buildShareData,copyText:copyText,createActions:createActions};
});
