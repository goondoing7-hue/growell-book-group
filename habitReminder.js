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
      if(action==='settings'){
        if(!payload||typeof payload.enabled!=='boolean')return Promise.reject(failure('invalid_settings'));
        body={enabled:payload.enabled};
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
    if(code==='invalid_time')return '습관 수정에서 알림 시간을 선택해주세요.';
    if(code==='invalid_settings')return '자동 연동 설정을 다시 확인해주세요.';
    if(code==='reconnect_required'||code==='connection_expired')return 'Microsoft 연결을 다시 확인해주세요.';
    if(code==='connection_required')return 'Microsoft 계정을 먼저 연결해주세요.';
    if(code==='task_create_uncertain'||code==='list_create_uncertain')return '등록 결과를 확인하는 중이에요. 중복 등록을 막기 위해 다시 확인한 뒤 전달해요.';
    if(code==='remote_missing')return '알림 앱에서 연결된 항목이 변경되었어요. GROWELL 목록을 확인해주세요.';
    if(code==='list_not_private')return '개인 습관은 공유되지 않은 나만의 목록에 연결해야 해요. Microsoft To Do의 GROWELL 목록 공유 설정을 확인해주세요.';
    if(code==='busy'||code==='sync_busy')return '앞선 요청을 처리하고 있어요. 잠시 후 다시 시도해주세요.';
    if(code==='timeout')return '응답을 기다리는 중이에요. 연결 상태를 다시 확인해주세요.';
    return '연결 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
  function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,function(character){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character];});}
  function habitRows(status){
    if(!status||!Array.isArray(status.habits))return null;
    var seen=new Set();
    return status.habits.filter(function(row){
      if(!row||typeof row.habitId!=='string'||!/^[A-Za-z0-9_-]{1,384}$/.test(row.habitId)||seen.has(row.habitId))return false;
      seen.add(row.habitId);return true;
    }).map(function(row){return {habitId:row.habitId,name:typeof row.name==='string'?row.name:'이름 없는 습관',time:validTime(row.time)?row.time:'',state:['synced','pending','unlinked','attention'].indexOf(row.state)>=0?row.state:'attention',canConnect:row.canConnect===true};});
  }
  function habitsHtml(status){
    var rows=habitRows(status);
    if(rows===null)return '<p class="habit-sync-empty">습관 목록을 확인하지 못했어요. 연결 상태를 다시 확인해주세요.</p>';
    if(!rows.length)return '<p class="habit-sync-empty">아직 만든 습관이 없어요.</p>';
    var groups=[{key:'unlinked',label:'아직 연동되지 않음'},{key:'waiting',label:'연동 확인 중'},{key:'synced',label:'연동됨'}];
    return groups.map(function(group){
      var entries=rows.filter(function(row){return group.key==='waiting'?row.state==='pending'||row.state==='attention':row.state===group.key;});
      if(!entries.length)return '';
      return '<section class="habit-sync-group"><h3>'+group.label+' <span>'+entries.length+'</span></h3><ul>'+entries.map(function(row){
        var label=row.state==='synced'?'연동됨':row.state==='pending'?'전달 대기':'확인 필요',action;
        if(row.state==='unlinked')action=row.canConnect?'<button type="button" class="habit-sync-link" data-sync-import="'+escapeHtml(row.habitId)+'"'+(!status.connected||!status.enabled?' disabled data-sync-unavailable':'')+' aria-label="'+escapeHtml(row.name)+' 알림 연결">연결</button>':'<span class="habit-sync-row-state">기간 확인</span>';
        else action='<span class="habit-sync-row-state'+(row.state==='synced'?' is-linked':'')+'">'+(row.state==='synced'?'<span aria-hidden="true">✓ </span>':'')+label+'</span>';
        return '<li><div class="habit-sync-row-copy"><strong>'+escapeHtml(row.name)+'</strong><span>'+escapeHtml(row.time||'시간 미설정')+'</span></div>'+action+'</li>';
      }).join('')+'</ul></section>';
    }).join('');
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
    node.innerHTML='<header class="habit-reminder-head"><h2 id="habit-reminder-title">알림 자동 연동</h2><button type="button" data-reminder-close aria-label="알림 자동 연동 닫기">×</button></header>'+
      '<div class="habit-reminder-body"><p class="habit-reminder-intro">각 습관에 정한 시간으로 알림을 받아보세요.</p>'+
      '<div class="habit-sync-state" data-sync-state role="status" aria-live="polite">연결 상태를 확인하고 있어요…</div>'+
      '<section data-sync-setup hidden><h3>서비스 연결 준비 중</h3><p>운영자의 Microsoft 연결 앱 등록이 완료되면 자동 연동을 시작할 수 있어요. 아직 알림 앱에 등록되지는 않았어요.</p></section>'+
      '<div data-sync-settings hidden><div data-sync-unconnected><p class="habit-sync-consent">연결하면 앞으로 만드는 습관의 이름·목표·장소·시간을 Microsoft 계정에 자동 등록해요.</p><button type="button" class="habit-sync-primary" data-sync-connect>Microsoft 계정 연결</button></div>'+
      '<div data-sync-habits></div><p class="habit-sync-hint">시간은 한국 시간 기준이에요. 시간이 없는 습관은 알림 없이 목록에만 등록돼요.</p>'+
      '<div data-sync-connected hidden><div class="habit-sync-tools"><button type="button" data-sync-run>새로고침</button></div><details class="habit-sync-settings-detail"><summary>연동 설정</summary><div class="habit-sync-setting-row"><label class="habit-sync-toggle"><input type="checkbox" data-sync-enabled><span>새 습관 자동 연동</span></label><button type="button" class="habit-sync-save" data-sync-save>적용</button></div><p class="habit-sync-hint">연결한 습관의 이름·목표·장소·시간 변경도 반영돼요.</p><button type="button" class="habit-sync-disconnect" data-sync-disconnect>Microsoft 연결 해제</button><div data-sync-disconnect-confirm hidden><p>자동 연동을 멈추고 연결 정보를 삭제해요. 알림 앱에 이미 등록된 항목은 남아 있어요.</p><button type="button" data-sync-disconnect-yes>연결 해제하기</button><button type="button" data-sync-disconnect-no>유지하기</button></div></details></div></div>'+
      '<button type="button" class="habit-sync-retry" data-sync-retry hidden>연결 상태 다시 확인</button>'+
      '<details class="habit-sync-device"><summary>휴대폰 연결 안내</summary><div class="habit-sync-tabs" role="group" aria-label="기기별 연결 안내"><button type="button" data-sync-device="samsung" aria-pressed="true">삼성 리마인더</button><button type="button" data-sync-device="apple" aria-pressed="false">아이폰 미리 알림</button></div><div data-sync-instructions></div></details>'+
      '<p class="habit-reminder-note">완료 체크는 각 앱에서 따로 관리돼요. 알림 표시와 반복은 기기 앱의 동작 방식에 따라 달라질 수 있어요.</p></div>';
    root.document.body.appendChild(node);
    var view={node:node,options:options,busy:false,status:null};
    function current(){return active===view&&!!options.getHabit();}
    view.client=createClient({isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});active=view;
    var state=node.querySelector('[data-sync-state]'),settings=node.querySelector('[data-sync-settings]'),setup=node.querySelector('[data-sync-setup]'),enabled=node.querySelector('[data-sync-enabled]'),retry=node.querySelector('[data-sync-retry]');
    function busy(value){view.busy=value;node.querySelectorAll('[data-sync-connect],[data-sync-save],[data-sync-import],[data-sync-run],[data-sync-disconnect],[data-sync-disconnect-yes],[data-sync-retry],input').forEach(function(el){el.disabled=value||el.hasAttribute('data-sync-unavailable');});}
    function draw(status){
      view.status=status;setup.hidden=status.configured!==false;settings.hidden=status.configured===false;retry.hidden=true;
      if(status.configured===false){state.textContent='자동 연동 준비 중';return;}
      node.querySelector('[data-sync-unconnected]').hidden=!!status.connected;node.querySelector('[data-sync-connected]').hidden=!status.connected;
      enabled.checked=!!status.enabled;
      node.querySelector('[data-sync-habits]').innerHTML=habitsHtml(status);
      if(!status.connected)state.textContent='Microsoft 계정을 연결해주세요.';
      else if(status.errorCode)state.textContent=/^reconnect[-_]required$/.test(status.errorCode)?'연결을 다시 확인해야 해요. 연결 해제 후 Microsoft 계정을 다시 연결해주세요.':'일부 알림을 전달하지 못했어요. 대기 중인 항목은 다시 시도해요.';
      else state.textContent=status.enabled?'자동 연동 켜짐 · '+(Number(status.pendingCount)>0?'전달 대기 '+Number(status.pendingCount)+'개':'Microsoft 계정 연결됨'):'자동 연동이 일시 중지되어 있어요. 연동 설정에서 켜주세요.';
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
    node.querySelector('[data-sync-connect]').onclick=function(){change('connect',{},function(result){var url=authorizationUrl(result.url,root.location.origin);if(!url)throw failure('unavailable');root.location.assign(url);});};
    node.querySelector('[data-sync-save]').onclick=function(){change('settings',{enabled:enabled.checked});};
    node.querySelector('[data-sync-habits]').addEventListener('click',function(event){
      var button=event.target.closest&&event.target.closest('[data-sync-import]');if(!button||button.disabled||!view.status||!view.status.connected||!view.status.enabled)return;
      var habitId=button.getAttribute('data-sync-import'),row=(habitRows(view.status)||[]).find(function(item){return item.habitId===habitId;});
      if(!row||row.state!=='unlinked'||!row.canConnect)return;
      change('import',{habitId:habitId},function(){return view.client.request('run').then(function(){return view.client.request('status');}).then(function(status){if(current())draw(status);});});
    });
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
  return {open:open,close:close,refresh:refresh,createClient:createClient,validTime:validTime,authorizationUrl:authorizationUrl,message:message,habitRows:habitRows,habitsHtml:habitsHtml};
});
