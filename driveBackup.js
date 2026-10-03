(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellDriveBackup=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var active=null;
  var actions={config:'GET',status:'GET',connect:'POST',sync:'POST',configure:'POST',disconnect:'POST'};
  function failure(code){var error=new Error(code);error.code=code;return error;}
  function authorizationUrl(value,origin){
    try{
      var url=new URL(value);
      return url.protocol==='https:'&&url.hostname==='accounts.google.com'&&!url.port&&!url.username&&!url.password&&!url.hash&&url.pathname==='/o/oauth2/v2/auth'&&url.searchParams.getAll('redirect_uri').length===1&&url.searchParams.get('redirect_uri')===origin+'/api/drive-backup'?url.href:'';
    }catch(error){return '';}
  }
  function folderUrl(value){
    try{
      var url=new URL(value);
      return url.protocol==='https:'&&url.hostname==='drive.google.com'&&!url.port&&!url.username&&!url.password&&!url.hash&&!url.search&&/^\/drive\/folders\/[A-Za-z0-9_-]+$/.test(url.pathname)?url.href:'';
    }catch(error){return '';}
  }
  function createClient(options){
    var disposed=false,writing=false,pending=new Set();
    function current(){return !disposed&&options.isCurrent();}
    function guard(){if(!current())throw failure('session_changed');}
    function request(action,payload){
      if(!Object.prototype.hasOwnProperty.call(actions,action))return Promise.reject(failure('invalid_action'));
      var method=actions[action],body;
      if(action==='configure'){
        if(!payload||typeof payload.enabled!=='boolean')return Promise.reject(failure('invalid_settings'));
        body={enabled:payload.enabled};
      }else if(method==='POST')body={};
      if(method==='POST'&&writing)return Promise.reject(failure('busy'));
      if(method==='POST')writing=true;
      var controller=new AbortController();pending.add(controller);
      var timer=setTimeout(function(){controller.abort();},action==='sync'?55000:25000);
      return Promise.resolve().then(function(){guard();return action==='config'?'':options.getAccessToken();}).then(function(token){
        guard();if(action!=='config'&&(!token||typeof token!=='string'))throw failure('auth_required');
        var headers={Accept:'application/json'};if(token)headers.Authorization='Bearer '+token;if(method==='POST')headers['Content-Type']='application/json';
        return options.fetch('/api/drive-backup?action='+action,{method:method,headers:headers,body:body?JSON.stringify(body):undefined,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
      }).then(function(response){
        guard();return response.json().then(function(data){
          guard();if(!data||typeof data!=='object'||Array.isArray(data))throw failure('unavailable');
          if(!response.ok)throw failure(typeof data.error==='string'&&/^[a-z_-]{1,60}$/.test(data.error)?data.error:response.status===401?'auth_required':'unavailable');
          return data;
        });
      }).catch(function(error){
        if(!current())throw failure('session_changed');
        if(error&&error.code)throw error;
        throw failure(error&&error.name==='AbortError'?'timeout':'unavailable');
      }).finally(function(){clearTimeout(timer);pending.delete(controller);if(method==='POST')writing=false;});
    }
    return {request:request,dispose:function(){disposed=true;pending.forEach(function(controller){controller.abort();});pending.clear();}};
  }
  function message(error){
    var code=error&&typeof error.code==='string'?error.code.replace(/-/g,'_'):'';
    if(['auth_required','authentication_required','unauthorized','invalid_session'].indexOf(code)>=0)return '로그인을 다시 확인한 뒤 연결해주세요.';
    if(['setup_required','not_configured'].indexOf(code)>=0)return 'Google Drive 백업을 준비하고 있어요. 서비스 연결 설정이 완료되면 사용할 수 있어요.';
    if(['reconnect_required','connection_expired','invalid_grant'].indexOf(code)>=0)return 'Google 연결을 다시 확인해야 해요. 계정을 다시 연결해주세요.';
    if(code==='connection_required')return 'Google 계정을 먼저 연결해주세요.';
    if(['drive_quota_exceeded','storage_full','quota_exceeded','backup_storage_full'].indexOf(code)>=0)return 'Google Drive의 저장 공간을 확인한 뒤 다시 백업해주세요.';
    if(['folder_not_private','shared_folder','backup_folder_unsafe','backup_file_unsafe'].indexOf(code)>=0)return '백업 파일과 폴더는 나만 볼 수 있어야 해요. 공유를 해제하고 GROWELL 백업 폴더를 내 드라이브의 최상위로 옮겨주세요.';
    if(['remote_missing','folder_missing','backup_remote_missing'].indexOf(code)>=0)return '백업 파일이나 폴더를 찾지 못했어요. Drive 휴지통에서 복원하고 GROWELL 백업 폴더를 내 드라이브의 최상위에 놓아주세요.';
    if(code==='backup_permission_denied')return 'Google Drive의 백업 권한을 확인하지 못했어요. 계정을 다시 연결하고 백업에 필요한 권한을 허용해주세요.';
    if(code==='backup_too_large')return '백업할 기록이 현재 한 번에 저장할 수 있는 크기를 넘었어요. 기존 백업은 유지돼요. 운영자에게 문의해주세요.';
    if(code==='backup_deferred')return '백업을 대기 중이에요. 잠시 후 다시 확인해주세요.';
    if(['busy','sync_busy','backup_busy'].indexOf(code)>=0)return '이전 백업을 처리하고 있어요. 잠시 후 다시 확인해주세요.';
    if(code==='timeout')return '응답이 늦어지고 있어요. 잠시 후 상태를 다시 확인해주세요.';
    if(code==='invalid_settings')return '자동 백업 설정을 다시 확인해주세요.';
    return '백업 상태를 확인하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
  function statusView(value){
    if(!value||typeof value.configured!=='boolean')throw failure('unavailable');
    if(value.configured&&typeof value.connected!=='boolean')throw failure('unavailable');
    var stamp=typeof value.lastBackedUpAt==='string'?Date.parse(value.lastBackedUpAt):NaN;
    return {configured:value.configured,connected:value.connected===true,enabled:value.enabled===true,
      accountEmail:typeof value.accountEmail==='string'?value.accountEmail.slice(0,320):'',folderUrl:folderUrl(value.folderUrl),
      lastBackedUpAt:Number.isFinite(stamp)?new Date(stamp).toISOString():'',
      pending:value.pending===true||(typeof value.pending==='number'&&value.pending>0),busy:value.busy===true,
      errorCode:typeof value.errorCode==='string'&&/^[a-z_-]{1,60}$/.test(value.errorCode)?value.errorCode:''};
  }
  function stateText(status){
    if(!status.configured)return '백업 준비 중';
    if(!status.connected)return '아직 연결하지 않았어요';
    if(status.errorCode)return message({code:status.errorCode});
    if(status.busy)return 'Google Drive에 백업하고 있어요';
    if(status.pending)return status.enabled?'변경 내용을 백업할 예정이에요':'백업할 변경 내용이 있어요 · 자동 백업 일시 중지';
    if(!status.enabled)return '자동 백업 일시 중지';
    return status.lastBackedUpAt?'자동 백업 켜짐 · 최근 백업 완료':'자동 백업 켜짐 · 첫 백업 대기';
  }
  function close(restore){
    var view=active;if(!view)return;active=null;clearTimeout(view.pollTimer);view.client.dispose();view.node.close();view.node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('drive-backup');
    if(restore!==false&&view.options.restoreFocus)view.options.restoreFocus();
  }
  function refresh(){if(active&&!active.options.isCurrent())close(false);}
  function open(options){
    if(!root.document||!options||typeof options.isCurrent!=='function'||typeof options.getAccessToken!=='function'||!options.isCurrent())return;
    close(false);
    var node=root.document.createElement('dialog');node.className='drive-backup-dialog';node.setAttribute('aria-labelledby','drive-backup-title');
    node.innerHTML='<header class="drive-backup-head"><div><span class="drive-backup-eyebrow">내 기록을 안전하게</span><h2 id="drive-backup-title">Google Drive 백업</h2></div><button type="button" data-drive-close aria-label="Google Drive 백업 닫기">×</button></header>'+
      '<div class="drive-backup-body"><p class="drive-backup-intro">나의 Google Drive에 기록을 차곡차곡 보관해요.</p>'+
      '<div class="drive-backup-status" data-drive-status role="status" aria-live="polite">연결 상태를 확인하고 있어요…</div>'+
      '<section class="drive-backup-setup" data-drive-setup hidden><h3>서비스 연결 준비 중</h3><p>Google 연결 설정이 완료되면 여기에서 내 계정을 연결할 수 있어요. 아직 Google Drive에 저장되지는 않았어요.</p></section>'+
      '<div data-drive-ready hidden><section data-drive-unconnected><p class="drive-backup-consent">연결하면 <strong>GROWELL 백업</strong> 폴더를 만들고, 내 기록의 변경 내용을 자동으로 저장해요.</p><button class="drive-backup-primary" type="button" data-drive-connect>Google 계정 연결</button></section>'+
      '<section data-drive-connected hidden><div class="drive-backup-account"><span>연결된 계정</span><strong data-drive-email></strong></div>'+
      '<a class="drive-backup-folder" data-drive-folder target="_blank" rel="noopener noreferrer" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3Z"/></svg><span>GROWELL 백업</span><span aria-hidden="true">↗</span></a>'+
      '<p class="drive-backup-folder-pending" data-drive-folder-pending>첫 백업이 완료되면 폴더를 열 수 있어요.</p>'+
      '<dl class="drive-backup-last"><dt>마지막 백업</dt><dd data-drive-last>아직 백업 전</dd></dl>'+
      '<div class="drive-backup-toggle-row"><div><label for="drive-backup-enabled">자동 백업</label><p>GROWELL에서 저장한 변경 내용을 반영해요.</p></div><input id="drive-backup-enabled" type="checkbox" role="switch" data-drive-enabled aria-label="자동 백업"></div>'+
      '<button class="drive-backup-primary" type="button" data-drive-sync>지금 백업</button><button class="drive-backup-secondary" type="button" data-drive-reconnect hidden>Google 계정 다시 연결</button>'+
      '<div class="drive-backup-bottom"><button type="button" data-drive-refresh>상태 새로고침</button><button type="button" data-drive-disconnect>연결 해제</button></div>'+
      '<div class="drive-backup-confirm" data-drive-confirm hidden><p>앞으로의 백업을 멈추고 Google 연결 정보를 삭제해요. Drive에 저장된 백업 파일은 그대로 남아요.</p><div><button type="button" data-drive-cancel>유지하기</button><button type="button" data-drive-confirm-yes>연결 해제하기</button></div></div></section></div>'+
      '<button class="drive-backup-retry" type="button" data-drive-retry hidden>다시 확인</button>'+
      '<details class="drive-backup-scope"><summary>어떤 내용이 저장되나요?</summary><ul><li><strong>나의 기록</strong><span>본문·사진이 담긴 암호화된 기록</span></li><li><strong>습관</strong><span>목표·일정·전체 체크 기록</span></li><li><strong>나의 자료</strong><span>내가 작성한 글·자료와 저장된 링크</span></li><li><strong>독서 아카이브</strong><span>나의 책·독서 진도·읽은 시간</span></li></ul><p>첨부파일 원본을 별도로 복사하지 않으며, 연결된 링크를 보관해요. Drive에서 고친 내용은 GROWELL에 반영되지 않아요.</p><p>개인 기록을 다시 열려면 복구 파일이 필요해요. 기록의 열쇠는 Drive 백업에 포함하지 않으니 <a href="#/profile/edit" data-drive-recovery>프로필 수정에서 복구 파일을 따로 보관해주세요.</a></p></details></div>';
    root.document.body.appendChild(node);
    var view={node:node,options:options,busy:false,status:null,pollTimer:null,pollCount:0};
    function current(){return active===view&&options.isCurrent();}
    view.client=createClient({isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});active=view;
    var state=node.querySelector('[data-drive-status]'),enabled=node.querySelector('[data-drive-enabled]'),retry=node.querySelector('[data-drive-retry]');
    function busy(value){
      view.busy=value;node.setAttribute('aria-busy',String(value));
      node.querySelectorAll('[data-drive-connect],[data-drive-reconnect],[data-drive-sync],[data-drive-refresh],[data-drive-disconnect],[data-drive-confirm-yes],[data-drive-retry],[data-drive-enabled]').forEach(function(button){button.disabled=value;});
      if(view.status&&view.status.busy)node.querySelector('[data-drive-sync]').disabled=true;
    }
    function draw(raw){
      var status=statusView(raw);view.status=status;
      node.querySelector('[data-drive-setup]').hidden=status.configured;node.querySelector('[data-drive-ready]').hidden=!status.configured;
      node.querySelector('[data-drive-unconnected]').hidden=status.connected;node.querySelector('[data-drive-connected]').hidden=!status.connected;
      enabled.checked=status.enabled;retry.hidden=true;state.textContent=stateText(status);state.classList.toggle('is-error',!!status.errorCode);
      node.querySelector('[data-drive-email]').textContent=status.accountEmail||'Google 계정 연결됨';
      var folder=node.querySelector('[data-drive-folder]');folder.hidden=!status.folderUrl;if(status.folderUrl)folder.href=status.folderUrl;else folder.removeAttribute('href');
      node.querySelector('[data-drive-folder-pending]').hidden=!!status.folderUrl;
      node.querySelector('[data-drive-last]').textContent=status.lastBackedUpAt?new Date(status.lastBackedUpAt).toLocaleString('ko-KR',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'아직 백업 전';
      node.querySelector('[data-drive-reconnect]').hidden=!/^(reconnect[-_]required|connection[-_]expired|invalid[-_]grant|backup[-_]permission[-_]denied)$/.test(status.errorCode);
      node.querySelector('[data-drive-sync]').textContent=status.busy?'백업 중…':'지금 백업';
    }
    function failed(error){
      if(!current())return;
      if(view.status)enabled.checked=view.status.enabled;
      state.textContent=message(error);state.classList.add('is-error');retry.hidden=false;
    }
    function schedulePoll(){
      clearTimeout(view.pollTimer);view.pollTimer=null;
      if(!current()||!view.status||!view.status.connected||!(view.status.busy||(view.status.pending&&view.status.enabled))||view.status.errorCode||view.pollCount>=12)return;
      view.pollTimer=setTimeout(function(){
        if(!current()||root.document.hidden)return;
        view.pollCount++;load(false);
      },5000);
    }
    function load(initial){
      if(!current()||view.busy)return;clearTimeout(view.pollTimer);busy(true);retry.hidden=true;
      var promise=initial?view.client.request('config').then(function(config){if(config.configured===false)return config;return view.client.request('status');}):view.client.request('status');
      promise.then(function(status){if(current())draw(status);}).catch(failed).finally(function(){if(current()){busy(false);schedulePoll();}});
    }
    function change(action,payload,success){
      if(!current()||view.busy)return;clearTimeout(view.pollTimer);view.pollCount=0;busy(true);retry.hidden=true;
      view.client.request(action,payload).then(function(result){
        if(!current())return;if(success)return success(result);
        return view.client.request('status').then(function(status){if(current())draw(status);});
      }).catch(failed).finally(function(){if(current()){busy(false);schedulePoll();}});
    }
    function connect(){change('connect',{},function(result){var url=authorizationUrl(result.url,root.location.origin);if(!url)throw failure('unavailable');root.location.assign(url);});}
    node.querySelector('[data-drive-close]').onclick=function(){close();};node.addEventListener('cancel',function(event){event.preventDefault();close();});
    node.addEventListener('click',function(event){if(event.target!==node)return;var rect=node.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();});
    node.querySelector('[data-drive-connect]').onclick=connect;node.querySelector('[data-drive-reconnect]').onclick=connect;
    enabled.onchange=function(){change('configure',{enabled:enabled.checked});};
    node.querySelector('[data-drive-sync]').onclick=function(){change('sync',{});};
    node.querySelector('[data-drive-refresh]').onclick=function(){view.pollCount=0;load(false);};
    node.querySelector('[data-drive-disconnect]').onclick=function(){node.querySelector('[data-drive-confirm]').hidden=false;node.querySelector('[data-drive-cancel]').focus({preventScroll:true});};
    node.querySelector('[data-drive-cancel]').onclick=function(){node.querySelector('[data-drive-confirm]').hidden=true;node.querySelector('[data-drive-disconnect]').focus({preventScroll:true});};
    node.querySelector('[data-drive-confirm-yes]').onclick=function(){change('disconnect',{},function(){node.querySelector('[data-drive-confirm]').hidden=true;return view.client.request('status').then(function(status){if(current())draw(status);});});};
    node.querySelector('[data-drive-recovery]').onclick=function(){close(false);};retry.onclick=function(){view.pollCount=0;load(true);};
    node.showModal();node.querySelector('[data-drive-close]').focus({preventScroll:true});
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('drive-backup',{close:function(){close();}});load(true);
  }
  if(root.addEventListener){root.addEventListener('hashchange',refresh);root.addEventListener('pagehide',function(){close(false);});}
  return {open:open,close:close,refresh:refresh,createClient:createClient,authorizationUrl:authorizationUrl,folderUrl:folderUrl,statusView:statusView,stateText:stateText,message:message};
});
