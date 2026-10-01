(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellHabitReminder=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=null;
  var actions={config:'GET',status:'GET',connect:'POST',settings:'POST',import:'POST',disconnect:'POST',run:'POST'};
  function failure(code){var error=new Error(code);error.code=code;return error;}
  function validTime(value){return typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);}
  function authorizationUrl(value,origin){
    try{var url=new URL(value);return url.protocol==='https:'&&url.hostname==='login.microsoftonline.com'&&!url.port&&!url.username&&!url.password&&!url.hash&&url.pathname==='/common/oauth2/v2.0/authorize'&&url.searchParams.getAll('redirect_uri').length===1&&url.searchParams.get('redirect_uri')===origin+'/api/habit-sync'?url.href:'';}catch(error){return '';}
  }
  function createClient(options){
    var disposed=false,pending=new Set(),writing=false;
    function current(){return !disposed&&options.isCurrent();}
    function guard(){if(!current())throw failure('session_changed');}
    function request(action,payload){
      if(!Object.prototype.hasOwnProperty.call(actions,action))return Promise.reject(failure('invalid_action'));
      var method=actions[action],body;
      if(action==='connect'||action==='settings'){
        if(!payload||!validTime(payload.defaultTime)||action==='settings'&&typeof payload.enabled!=='boolean')return Promise.reject(failure('invalid_time'));
        body={defaultTime:payload.defaultTime};if(action==='settings')body.enabled=payload.enabled;
      }else if(action==='import'){
        body={};if(payload&&payload.habitId!=null){if(typeof payload.habitId!=='string'||!/^[A-Za-z0-9_-]{1,384}$/.test(payload.habitId))return Promise.reject(failure('invalid_habit'));body.habitId=payload.habitId;}
      }else if(method==='POST')body={};
      if(method==='POST'&&writing)return Promise.reject(failure('busy'));
      if(method==='POST')writing=true;
      var controller=new AbortController();pending.add(controller);
      var timer=setTimeout(function(){controller.abort();},25000);
      return Promise.resolve().then(function(){guard();return action==='config'?'':options.getAccessToken();}).then(function(token){
        guard();if(action!=='config'&&(!token||typeof token!=='string'))throw failure('auth_required');
        var headers={Accept:'application/json'};if(token)headers.Authorization='Bearer '+token;if(method==='POST')headers['Content-Type']='application/json';
        return options.fetch('/api/habit-sync?action='+action,{method:method,headers:headers,body:body?JSON.stringify(body):undefined,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
      }).then(function(response){
        guard();return response.json().then(function(data){
          guard();if(!data||typeof data!=='object'||Array.isArray(data))throw failure('unavailable');
          if(!response.ok){var code=typeof data.error==='string'&&/^[a-z_-]{1,60}$/.test(data.error)?data.error:response.status===401?'auth_required':'unavailable';throw failure(code);}
          return data;
        });
      }).catch(function(error){if(!current())throw failure('session_changed');if(error&&error.code)throw error;throw failure(error&&error.name==='AbortError'?'timeout':'unavailable');})
        .finally(function(){clearTimeout(timer);pending.delete(controller);if(method==='POST')writing=false;});
    }
    return {request:request,dispose:function(){disposed=true;pending.forEach(function(controller){controller.abort();});pending.clear();}};
  }
  function message(error){
    var code=error&&typeof error.code==='string'?error.code.replace(/-/g,'_'):'';
    if(code==='auth_required'||code==='authentication_required'||code==='unauthorized'||code==='invalid_session')return '로그인을 다시 확인한 뒤 연결해주세요.';
    if(code==='setup_required'||code==='not_configured')return '자동 연동을 위한 서비스 연결 설정이 아직 완료되지 않았어요.';
    if(code==='invalid_time')return '기본 알림 시간을 선택해주세요.';
    if(code==='reconnect_required'||code==='connection_expired')return 'Microsoft 연결을 다시 확인해주세요.';
    if(code==='connection_required')return 'Microsoft 계정을 먼저 연결해주세요.';
    if(code==='task_create_uncertain'||code==='list_create_uncertain')return '등록 결과를 확인하는 중이에요. 중복 등록을 막기 위해 다시 확인한 뒤 전달해요.';
    if(code==='remote_missing')return '알림 앱에서 연결된 항목이 변경되었어요. GROWELL 목록을 확인해주세요.';
    if(code==='list_not_private')return '개인 습관은 공유되지 않은 나만의 목록에 연결해야 해요. Microsoft To Do의 GROWELL 목록 공유 설정을 확인해주세요.';
    if(code==='busy'||code==='sync_busy')return '앞선 요청을 처리하고 있어요. 잠시 후 다시 시도해주세요.';
    if(code==='timeout')return '응답을 기다리는 중이에요. 연결 상태를 다시 확인해주세요.';
    return '연결 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
  function close(restore){
    var view=active;if(!view)return;active=null;view.client.dispose();view.node.close();view.node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('habit-reminder');
    if(restore!==false&&view.options.restoreFocus)view.options.restoreFocus();
  }
  function refresh(){if(active&&!active.options.getHabit())close(false);}
  function open(options){
    if(!root.document||!options||typeof options.getHabit!=='function'||typeof options.getAccessToken!=='function'||!options.getHabit())return;
    close(false);
    var node=root.document.createElement('dialog');node.className='habit-reminder-dialog';node.setAttribute('aria-labelledby','habit-reminder-title');
    node.innerHTML='<header class="habit-reminder-head"><div><p>나의 습관을 일상의 알림으로</p><h2 id="habit-reminder-title">알림 자동 연동</h2></div><button type="button" data-reminder-close aria-label="알림 자동 연동 닫기">×</button></header>'+
      '<div class="habit-reminder-body"><p class="habit-reminder-intro">계정을 한 번 연결하면 새로 만드는 습관이 알림 앱으로 이어져요.</p>'+
      '<div class="habit-sync-state" data-sync-state role="status" aria-live="polite">연결 상태를 확인하고 있어요…</div>'+
      '<section data-sync-setup hidden><h3>서비스 연결 준비 중</h3><p>운영자의 Microsoft 연결 앱 등록이 완료되면 자동 연동을 시작할 수 있어요. 아직 알림 앱에 등록되지는 않았어요.</p></section>'+
      '<div data-sync-settings hidden><label class="habit-sync-time">기본 알림 시간 <input type="time" data-sync-time value="21:00" required></label><p class="habit-sync-hint">습관에 정확한 시각이 있으면 그 시간을 사용해요. “잠들기 전”처럼 시각이 정해지지 않은 습관에는 기본 시간을 적용해요. 한국 시간 기준이에요.</p>'+
      '<div data-sync-unconnected><p class="habit-sync-consent">연결하면 앞으로 만드는 습관의 이름·목표·장소·시간을 Microsoft 계정에 자동 등록해요.</p><button type="button" class="habit-sync-primary" data-sync-connect>연결하고 자동 연동 시작</button></div>'+
      '<div data-sync-connected hidden><label class="habit-sync-toggle"><input type="checkbox" data-sync-enabled><span>새 습관 자동 연동</span></label><button type="button" class="habit-sync-primary" data-sync-save>설정 저장</button><div class="habit-sync-tools"><button type="button" data-sync-import></button><button type="button" data-sync-run>연동 상태 새로고침</button></div><p class="habit-sync-hint">연결한 습관의 이름·목표·시간 변경과 삭제도 반영돼요. 이미 만든 습관은 위 버튼으로 연결할 수 있어요.</p><button type="button" class="habit-sync-disconnect" data-sync-disconnect>연결 해제</button><div data-sync-disconnect-confirm hidden><p>자동 연동을 멈추고 연결 정보를 삭제해요. 알림 앱에 이미 등록된 항목은 남아 있어요.</p><button type="button" data-sync-disconnect-yes>연결 해제하기</button><button type="button" data-sync-disconnect-no>유지하기</button></div></div></div>'+
      '<button type="button" class="habit-sync-retry" data-sync-retry hidden>연결 상태 다시 확인</button>'+
      '<section class="habit-sync-device"><h3>휴대폰에서도 한 번 연결해주세요</h3><div class="habit-sync-tabs" role="group" aria-label="기기별 연결 안내"><button type="button" data-sync-device="samsung" aria-pressed="true">삼성 리마인더</button><button type="button" data-sync-device="apple" aria-pressed="false">아이폰 미리 알림</button></div><div data-sync-instructions></div></section>'+
      '<p class="habit-reminder-note">완료 체크는 각 앱에서 따로 관리돼요. 알림 표시와 반복은 기기 앱의 동작 방식에 따라 달라질 수 있어요.</p></div>';
    root.document.body.appendChild(node);
    var view={node:node,options:options,busy:false,status:null};
    function current(){return active===view&&!!options.getHabit();}
    view.client=createClient({isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});active=view;
    var state=node.querySelector('[data-sync-state]'),settings=node.querySelector('[data-sync-settings]'),setup=node.querySelector('[data-sync-setup]'),time=node.querySelector('[data-sync-time]'),enabled=node.querySelector('[data-sync-enabled]'),retry=node.querySelector('[data-sync-retry]');
    function busy(value){view.busy=value;node.querySelectorAll('[data-sync-connect],[data-sync-save],[data-sync-import],[data-sync-run],[data-sync-disconnect],[data-sync-disconnect-yes],[data-sync-retry],input').forEach(function(el){el.disabled=value;});}
    function draw(status){
      view.status=status;setup.hidden=status.configured!==false;settings.hidden=status.configured===false;retry.hidden=true;
      if(status.configured===false){state.textContent='자동 연동 준비 중';return;}
      node.querySelector('[data-sync-unconnected]').hidden=!!status.connected;node.querySelector('[data-sync-connected]').hidden=!status.connected;
      time.value=validTime(status.defaultTime)?status.defaultTime:'21:00';enabled.checked=!!status.enabled;
      if(!status.connected)state.textContent='Microsoft 계정을 연결해주세요.';
      else if(status.errorCode)state.textContent=/^reconnect[-_]required$/.test(status.errorCode)?'연결을 다시 확인해야 해요. 연결 해제 후 Microsoft 계정을 다시 연결해주세요.':'일부 알림을 전달하지 못했어요. 대기 중인 항목은 다시 시도해요.';
      else state.textContent=status.enabled?'자동 연동 켜짐 · '+(Number(status.pendingCount)>0?'전달 대기 '+Number(status.pendingCount)+'개':'GROWELL 목록에 연결됨'):'자동 연동이 일시 중지되어 있어요.';
      node.querySelector('[data-sync-import]').textContent=options.habitId?'이 습관 연결하기':'기존 습관도 연결하기';
    }
    function failed(error){if(!current())return;state.textContent=message(error);retry.hidden=false;}
    function load(){
      if(!current()||view.busy)return;busy(true);retry.hidden=true;
      view.client.request('config').then(function(config){if(config.configured===false)return config;return view.client.request('status');}).then(function(status){if(current())draw(status);}).catch(failed).finally(function(){if(current())busy(false);});
    }
    function change(action,payload,success){
      if(!current()||view.busy)return;busy(true);retry.hidden=true;
      view.client.request(action,payload).then(function(result){if(!current())return;if(success)return success(result);return view.client.request('status').then(function(status){if(current())draw(status);});}).catch(failed).finally(function(){if(current())busy(false);});
    }
    node.querySelector('[data-reminder-close]').onclick=function(){close();};node.addEventListener('cancel',function(event){event.preventDefault();close();});
    node.addEventListener('click',function(event){if(event.target!==node)return;var r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();});
    node.querySelector('[data-sync-connect]').onclick=function(){change('connect',{defaultTime:time.value},function(result){var url=authorizationUrl(result.url,root.location.origin);if(!url)throw failure('unavailable');root.location.assign(url);});};
    node.querySelector('[data-sync-save]').onclick=function(){change('settings',{enabled:enabled.checked,defaultTime:time.value});};
    node.querySelector('[data-sync-import]').onclick=function(){change('import',options.habitId?{habitId:options.habitId}:{},function(){return view.client.request('run').then(function(){return view.client.request('status');}).then(function(status){if(current())draw(status);});});};
    node.querySelector('[data-sync-run]').onclick=function(){change('run',{});};
    node.querySelector('[data-sync-disconnect]').onclick=function(){node.querySelector('[data-sync-disconnect-confirm]').hidden=false;};
    node.querySelector('[data-sync-disconnect-no]').onclick=function(){node.querySelector('[data-sync-disconnect-confirm]').hidden=true;};
    node.querySelector('[data-sync-disconnect-yes]').onclick=function(){change('disconnect',{},function(){node.querySelector('[data-sync-disconnect-confirm]').hidden=true;return view.client.request('status').then(function(status){if(current())draw(status);});});};
    retry.onclick=load;
    function device(kind){
      node.querySelectorAll('[data-sync-device]').forEach(function(button){button.setAttribute('aria-pressed',String(button.getAttribute('data-sync-device')===kind));});
      node.querySelector('[data-sync-instructions]').innerHTML=kind==='apple'?'<ol><li>아이폰 설정 → 앱 → 미리 알림 → 미리 알림 계정으로 이동해요.</li><li>Outlook.com 또는 Exchange에서 같은 Microsoft 계정을 추가하고 미리 알림을 켜주세요.</li><li>미리 알림 앱에서 Microsoft 계정의 GROWELL 목록을 확인해요.</li></ol><p>iCloud가 아닌 Microsoft 계정의 목록에 등록돼요.</p>':'<ol><li>리마인더 설정에서 Microsoft To Do와 동기화를 켜주세요.</li><li>GROWELL에 연결한 것과 같은 Microsoft 계정으로 로그인해요.</li><li>To Do 탭 → 더보기 → 동기화할 목록에서 GROWELL을 선택해요.</li></ol><p>삼성 리마인더는 To Do 목록 하나와 연결할 수 있어요.</p>';
    }
    node.querySelectorAll('[data-sync-device]').forEach(function(button){button.onclick=function(){device(button.getAttribute('data-sync-device'));};});device('samsung');
    node.showModal();node.querySelector('[data-reminder-close]').focus({preventScroll:true});
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('habit-reminder',{close:function(){close();}});load();
  }
  if(root.addEventListener){root.addEventListener('hashchange',refresh);root.addEventListener('pagehide',function(){close(false);});}
  return {open:open,close:close,refresh:refresh,createClient:createClient,validTime:validTime,authorizationUrl:authorizationUrl,message:message};
});
