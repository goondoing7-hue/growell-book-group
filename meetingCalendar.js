(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellMeetingCalendar=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=null,methods={config:'GET',status:'GET',connect:'POST',configure:'POST',sync:'POST',disconnect:'POST'};
  function fail(code){var error=new Error(code);error.code=code;return error;}
  function schedule(value){
    var a=value||{},date=a.calendarDate||'',start=a.calendarStart||'',end=a.calendarEnd||'';
    if(!date&&!start&&!end)return {valid:true,complete:false};
    var stamp=/^\d{4}-\d{2}-\d{2}$/.test(date)?Date.parse(date+'T12:00:00Z'):NaN;
    if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==date)return {valid:false,error:'모임 날짜를 선택해주세요.'};
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end))return {valid:false,error:'시작 시간과 종료 시간을 선택해주세요.'};
    if(end<=start)return {valid:false,error:'종료 시간은 시작 시간보다 늦게 정해주세요.'};
    return {valid:true,complete:true,date:date,start:start,end:end,
      dateLabel:date.replace(/-/g,'.')+' ('+['일','월','화','수','목','금','토'][new Date(stamp).getUTCDay()]+')',timeLabel:start+'–'+end};
  }
  function authorizationUrl(value,origin){
    try{var url=new URL(value);return url.protocol==='https:'&&url.hostname==='accounts.google.com'&&!url.port&&!url.username&&!url.password&&!url.hash&&url.pathname==='/o/oauth2/v2/auth'&&url.searchParams.getAll('redirect_uri').length===1&&url.searchParams.get('redirect_uri')===origin+'/api/meeting-calendar'?url.href:'';}catch(error){return '';}
  }
  function message(error){
    var code=error&&typeof error.code==='string'?error.code.replace(/-/g,'_'):'';
    if(/auth_required|authentication_required|invalid_session|unauthorized/.test(code))return '로그인을 다시 확인해주세요.';
    if(/not_configured|setup_required/.test(code))return '캘린더 연결을 준비하고 있어요. 설정이 완료되면 사용할 수 있어요.';
    if(/reconnect|invalid_grant|permission/.test(code))return 'Google 계정을 다시 연결하고 캘린더 권한을 허용해주세요.';
    if(/remote_missing/.test(code))return 'Google에서 삭제된 일정이 있어요. 삭제한 일정은 자동으로 다시 만들지 않아요.';
    if(/conflict/.test(code))return 'Google에서 변경된 일정이 있어요. 상태를 다시 확인해주세요.';
    if(/connection_required/.test(code))return 'Google 캘린더를 먼저 연결해주세요.';
    if(/busy|deferred/.test(code))return '모임 일정을 반영하고 있어요. 잠시 후 확인해주세요.';
    if(code==='session_changed')return '계정이 바뀌었어요. 다시 열어주세요.';
    return '캘린더 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
  function createClient(options){
    var disposed=false,writing=false,pending=new Set();
    function guard(){if(disposed||!options.isCurrent())throw fail('session_changed');}
    function request(action,payload){
      if(!Object.prototype.hasOwnProperty.call(methods,action))return Promise.reject(fail('invalid_action'));
      var method=methods[action],body;
      if(action==='configure'){if(!payload||typeof payload.enabled!=='boolean')return Promise.reject(fail('invalid_settings'));body={enabled:payload.enabled};}else if(method==='POST')body={};
      if(method==='POST'&&writing)return Promise.reject(fail('busy'));
      if(method==='POST')writing=true;
      var controller=new AbortController();pending.add(controller);
      var timer=setTimeout(function(){controller.abort();},action==='sync'?55000:25000);
      return Promise.resolve().then(function(){guard();return action==='config'?'':options.getAccessToken();}).then(function(token){
        guard();if(action!=='config'&&(!token||typeof token!=='string'))throw fail('auth_required');
        var headers={Accept:'application/json'};if(token)headers.Authorization='Bearer '+token;if(method==='POST')headers['Content-Type']='application/json';
        return options.fetch('/api/meeting-calendar?action='+action,{method:method,headers:headers,body:body?JSON.stringify(body):undefined,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
      }).then(function(response){return response.json().then(function(value){guard();if(!value||typeof value!=='object'||Array.isArray(value))throw fail('unavailable');if(!response.ok)throw fail(typeof value.error==='string'&&/^[a-z_-]{1,60}$/.test(value.error)?value.error:'unavailable');return value;});}).catch(function(error){
        guard();throw error&&error.code?error:fail(error&&error.name==='AbortError'?'timeout':'unavailable');
      }).finally(function(){clearTimeout(timer);pending.delete(controller);if(method==='POST')writing=false;});
    }
    return {request:request,dispose:function(){disposed=true;pending.forEach(function(c){c.abort();});pending.clear();}};
  }
  function close(restore){
    var view=active;if(!view)return;active=null;clearTimeout(view.timer);root.document.removeEventListener('visibilitychange',view.visibility);view.client.dispose();view.node.close();view.node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('meeting-calendar');
    if(restore!==false&&view.options.restoreFocus)view.options.restoreFocus();
  }
  function refresh(){if(active&&!active.options.isCurrent())close(false);}
  function open(options){
    if(!root.document||!options||!options.isCurrent())return;close(false);
    var node=root.document.createElement('dialog');node.className='meeting-calendar-dialog';node.setAttribute('aria-labelledby','meeting-calendar-title');
    node.innerHTML='<header><h2 id="meeting-calendar-title">모임 일정 · Google 캘린더</h2><button type="button" data-calendar-close aria-label="캘린더 연결 닫기">×</button></header>'+
      '<div class="meeting-calendar-body"><p>내 Google 캘린더에 이번 모임의 날짜·시간·장소·읽을 범위를 자동으로 담아요.</p><p class="meeting-calendar-state" data-calendar-state role="status" aria-live="polite">연결 상태를 확인하고 있어요…</p>'+
      '<section data-calendar-ready hidden><div data-calendar-unconnected><button type="button" class="meeting-calendar-primary" data-calendar-connect>내 Google 캘린더 연결</button></div>'+
      '<div data-calendar-connected hidden><p class="meeting-calendar-account" data-calendar-email></p><label class="meeting-calendar-toggle">모임 일정 자동 반영<input type="checkbox" role="switch" data-calendar-enabled></label><p class="meeting-calendar-last" data-calendar-last></p>'+
      '<button type="button" class="meeting-calendar-primary" data-calendar-sync>지금 반영</button><button type="button" class="meeting-calendar-secondary" data-calendar-reconnect>Google 계정 다시 연결</button><div class="meeting-calendar-actions"><button type="button" data-calendar-refresh>상태 새로고침</button><button type="button" data-calendar-disconnect>연결 해제</button></div>'+
      '<div class="meeting-calendar-confirm" data-calendar-confirm hidden><p>앞으로의 자동 반영을 멈춰요. 이미 등록된 일정과 GROWELL 기록은 그대로 남아요.</p><button type="button" data-calendar-cancel>유지하기</button><button type="button" data-calendar-confirm-yes>연결 해제하기</button></div></div></section>'+
      '<button type="button" data-calendar-retry hidden>다시 확인</button><div class="meeting-calendar-hint"><p>운영자가 날짜와 시작·종료 시간을 저장하면 연결한 회원의 캘린더에 반영돼요. 일정 변경은 같은 항목에 반영하고, 다음 회차는 새 일정으로 추가해요.</p><p>내 기본 캘린더에 등록하며 한국 시간을 사용해요. Google에서 수정한 내용은 GROWELL에 반영되지 않아요.</p></div></div>';
    root.document.body.appendChild(node);
    var view={node:node,options:options,busy:false,status:null,timer:null,polls:0};
    function current(){return active===view&&options.isCurrent();}
    view.client=createClient({isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});active=view;
    var state=node.querySelector('[data-calendar-state]'),enabled=node.querySelector('[data-calendar-enabled]'),retry=node.querySelector('[data-calendar-retry]');
    function busy(value){view.busy=value;node.setAttribute('aria-busy',String(value));node.querySelectorAll('button:not([data-calendar-close]),input').forEach(function(b){b.disabled=value;});}
    function draw(s){
      if(typeof s.configured!=='boolean'||(s.configured&&typeof s.connected!=='boolean'))throw fail('unavailable');
      s=Object.assign({},s,{pending:s.pending===true||(typeof s.pendingCount==='number'&&s.pendingCount>0)});view.status=s;
      node.querySelector('[data-calendar-ready]').hidden=!s.configured;node.querySelector('[data-calendar-unconnected]').hidden=!!s.connected;node.querySelector('[data-calendar-connected]').hidden=!s.connected;retry.hidden=true;
      enabled.checked=s.enabled===true;
      state.textContent=!s.configured?'캘린더 연결 준비 중':!s.connected?'아직 연결하지 않았어요':s.errorCode?message({code:s.errorCode}):!s.enabled?'자동 반영 일시 중지':s.busy?'모임 일정을 반영하고 있어요':s.pending?'모임 일정 반영 대기 중':'모임 일정 자동 반영 켜짐';
      state.classList.toggle('is-error',!!s.errorCode);
      node.querySelector('[data-calendar-email]').textContent=typeof s.accountEmail==='string'?s.accountEmail:'Google 계정 연결됨';
      var stamp=typeof s.lastSyncedAt==='string'?Date.parse(s.lastSyncedAt):NaN;
      node.querySelector('[data-calendar-last]').textContent=Number.isFinite(stamp)?'최근 반영 '+new Date(stamp).toLocaleString('ko-KR',{hour12:false}):'날짜와 시간이 확정되면 첫 일정이 등록돼요.';
      node.querySelector('[data-calendar-reconnect]').hidden=!s.errorCode;
    }
    function failure(error){if(current()){if(view.status)enabled.checked=view.status.enabled===true;state.textContent=message(error);state.classList.add('is-error');retry.hidden=false;}}
    function poll(){clearTimeout(view.timer);if(current()&&view.status&&view.status.enabled&&view.status.pending&&!view.status.errorCode&&view.polls<6)view.timer=setTimeout(function(){if(current()&&!root.document.hidden){view.polls++;load(false);}},5000);}
    function load(initial){if(!current()||view.busy)return;busy(true);var task=initial?view.client.request('config').then(function(s){return s.configured?view.client.request('status'):s;}):view.client.request('status');task.then(function(s){if(current())draw(s);}).catch(failure).finally(function(){if(current()){busy(false);poll();}});}
    function change(action,payload,success){if(!current()||view.busy)return;clearTimeout(view.timer);view.polls=0;busy(true);view.client.request(action,payload).then(function(result){if(!current())return;if(success)return success(result);return view.client.request('status').then(function(s){if(current())draw(s);});}).catch(failure).finally(function(){if(current()){busy(false);poll();}});}
    function connect(){change('connect',{},function(result){var url=authorizationUrl(result.url,root.location.origin);if(!url)throw fail('unavailable');root.location.assign(url);});}
    node.querySelector('[data-calendar-close]').onclick=function(){close();};node.addEventListener('cancel',function(e){e.preventDefault();close();});
    node.addEventListener('click',function(e){if(e.target!==node)return;var r=node.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();});
    node.querySelector('[data-calendar-connect]').onclick=connect;node.querySelector('[data-calendar-reconnect]').onclick=connect;enabled.onchange=function(){change('configure',{enabled:enabled.checked});};
    node.querySelector('[data-calendar-sync]').onclick=function(){change('sync',{});};node.querySelector('[data-calendar-refresh]').onclick=function(){view.polls=0;load(false);};retry.onclick=function(){load(true);};
    node.querySelector('[data-calendar-disconnect]').onclick=function(){node.querySelector('[data-calendar-confirm]').hidden=false;node.querySelector('[data-calendar-cancel]').focus();};
    node.querySelector('[data-calendar-cancel]').onclick=function(){node.querySelector('[data-calendar-confirm]').hidden=true;};
    node.querySelector('[data-calendar-confirm-yes]').onclick=function(){change('disconnect',{},function(){node.querySelector('[data-calendar-confirm]').hidden=true;return view.client.request('status').then(function(s){if(current())draw(s);});});};
    view.visibility=function(){if(current()&&!root.document.hidden&&view.status&&view.status.pending){view.polls=0;load(false);}};root.document.addEventListener('visibilitychange',view.visibility);
    node.showModal();node.querySelector('[data-calendar-close]').focus({preventScroll:true});if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('meeting-calendar',{close:function(){close();}});load(true);
  }
  if(root.addEventListener){root.addEventListener('hashchange',refresh);root.addEventListener('pagehide',function(){close(false);});}
  return {schedule:schedule,authorizationUrl:authorizationUrl,createClient:createClient,open:open,close:close,refresh:refresh,message:message};
});
