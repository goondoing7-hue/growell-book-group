(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(root,require('./driveBackup.js'),require('./meetingCalendar.js'));
  else root.GrowellGoogleConnection=factory(root,root.GrowellDriveBackup,root.GrowellMeetingCalendar);
})(typeof globalThis!=='undefined'?globalThis:this,function(root,Drive,Calendar){
  'use strict';
  var active=null,services=['drive','calendar','mail'],googleServices=['drive','calendar'];
  function fail(code){var error=new Error(code);error.code=code;return error;}
  function statusView(service,value){
    if(service==='drive')return Drive.statusView(value);
    if(service==='mail'){
      if(!value||typeof value.configured!=='boolean'||(value.configured&&typeof value.connected!=='boolean'))throw fail('unavailable');
      var mailed=typeof value.lastSentAt==='string'?Date.parse(value.lastSentAt):NaN;
      return {configured:value.configured,connected:value.configured&&value.connected===true,enabled:value.configured&&value.connected===true&&value.enabled===true,
        accountEmail:typeof value.accountEmail==='string'?value.accountEmail.slice(0,320):'',lastSentAt:Number.isFinite(mailed)?new Date(mailed).toISOString():'',
        latestStatus:typeof value.latestStatus==='string'&&/^(none|pending|sending|sent|uncertain|failed|paused|cancelled)$/.test(value.latestStatus)?value.latestStatus:'',
        pending:typeof value.pendingCount==='number'&&Number.isFinite(value.pendingCount)&&value.pendingCount>0,busy:value.busy===true,
        errorCode:typeof value.errorCode==='string'&&/^[a-z_-]{1,60}$/.test(value.errorCode)?value.errorCode:''};
    }
    if(service!=='calendar'||!value||typeof value.configured!=='boolean'||(value.configured&&typeof value.connected!=='boolean'))throw fail('unavailable');
    var stamp=typeof value.lastSyncedAt==='string'?Date.parse(value.lastSyncedAt):NaN;
    return {configured:value.configured,connected:value.connected===true,enabled:value.enabled===true,
      accountEmail:typeof value.accountEmail==='string'?value.accountEmail.slice(0,320):'',
      lastSyncedAt:Number.isFinite(stamp)?new Date(stamp).toISOString():'',
      pending:value.pending===true||(typeof value.pendingCount==='number'&&value.pendingCount>0),busy:value.busy===true,
      errorCode:typeof value.errorCode==='string'&&/^[a-z_-]{1,60}$/.test(value.errorCode)?value.errorCode:''};
  }
  function reconnectRequired(status){return !!(status&&/reconnect|invalid_grant|connection_expired|permission/.test(status.errorCode));}
  function summaryView(entries){
    var d=entries&&entries.drive,c=entries&&entries.calendar,ds=d&&!d.error&&d.status,cs=c&&!c.error&&c.status;
    var configured=!!(entries&&entries.configured===true||ds&&cs&&ds.configured&&cs.configured),connected=!!(ds&&cs&&ds.connected&&cs.connected);
    var sameAccount=connected&&entries.sameAccount===true,mismatch=connected&&entries.sameAccount===false;
    var anyConnected=!!(d&&d.status&&d.status.connected||c&&c.status&&c.status.connected);
    var mail=entries&&entries.mail,ms=mail&&!mail.error&&mail.status;
    var kind='unconnected',text='Google 계정을 한 번 연결하면 기록 백업·모임 일정·모임 기록 PDF 이메일을 함께 켜요.';
    if(!d||!c){kind='loading';text='Google 연결 상태를 확인하고 있어요…';}
    else if(d.error||c.error){kind='error';text='일부 연결 상태를 확인하지 못했어요. 각 항목의 안내를 확인하고 새로고침해주세요.';}
    else if(!configured){kind='setup';text='Google 연동을 준비하고 있어요. 두 서비스의 준비 상태를 확인해주세요.';}
    else if(mismatch){kind='mismatch';text='두 서비스에 연결된 Google 계정이 달라요. 사용할 계정을 선택해 다시 연결해주세요. 기존 백업과 일정은 자동으로 합치지 않아요.';}
    else if(connected&&!sameAccount){kind='unknown';text='두 서비스의 연결 계정을 확인해야 해요. Google 계정을 다시 연결해주세요.';}
    else if(sameAccount){kind='connected';text='같은 Google 계정에 기록 백업과 모임 일정이 연결되어 있어요.';
      if(ms&&ms.configured&&ms.connected)text=ms.enabled?'같은 Google 계정에 백업·모임 일정이 연결되어 있어요. 새 모임 기록 PDF도 이 계정의 이메일로 보내요.':'같은 Google 계정에 백업·모임 일정이 연결되어 있어요. 모임 기록 PDF 이메일은 일시 중지되어 있어요.';
      else if(mail&&mail.error)text+=' PDF 이메일 상태는 확인하지 못했어요.';
    }
    else if(anyConnected){kind='partial';text='Google 연결을 한 번 더 완료하면 기록 백업과 모임 일정을 함께 사용할 수 있어요.';}
    var needsReconnect=anyConnected||reconnectRequired(ds)||reconnectRequired(cs);
    return {kind:kind,text:text,sameAccount:sameAccount,mismatch:mismatch,email:sameAccount?(ds.accountEmail||cs.accountEmail):'',
      canConnect:configured,showConnect:!sameAccount||reconnectRequired(ds)||reconnectRequired(cs),needsReconnect:needsReconnect};
  }
  function message(service,error){
    if(error&&error.code==='session_changed')return '로그인 계정이 바뀌었어요. 다시 열어주세요.';
    if(error&&error.code==='draft_not_saved')return '작성 중인 내용을 먼저 저장하거나 편집을 마친 뒤 연결해주세요.';
    if(service==='mail'){
      if(error&&error.code==='auth_required')return '로그인 후 PDF 이메일 상태를 확인해주세요.';
      if(error&&error.code==='mail_not_configured')return 'PDF 이메일 발송을 준비하고 있어요.';
      if(error&&/^(send_uncertain|delivery-uncertain)$/.test(error.code))return '발송 결과를 확인하지 못했어요. 중복 발송을 막기 위해 자동으로 다시 보내지 않아요.';
      return 'PDF 이메일 상태를 확인하지 못했어요. 잠시 뒤 새로고침해주세요.';
    }
    return service==='drive'?Drive.message(error):Calendar.message(error);
  }
  function stateText(service,status){
    if(service==='drive')return Drive.stateText(status);
    if(service==='mail'){
      if(!status.configured)return 'PDF 이메일 발송 준비 중';
      if(!status.connected)return 'Google 계정을 연결하면 함께 켜져요';
      if(status.latestStatus==='uncertain'||/^(send_uncertain|delivery-uncertain)$/.test(status.errorCode))return '발송 결과 미확인 · 중복 방지를 위해 다시 보내지 않아요';
      if(status.latestStatus==='failed')return 'PDF 이메일 준비 실패 · 상태를 확인해주세요';
      if(status.errorCode)return 'PDF 이메일 발송을 완료하지 못했어요';
      if(!status.enabled)return 'PDF 이메일 자동 발송 일시 중지';
      if(status.latestStatus==='sending'||status.busy)return 'PDF 이메일 발송 중';
      if(status.pending||status.latestStatus==='pending')return 'PDF 이메일 발송 대기 중';
      if(status.latestStatus==='sent')return '최근 모임 기록 PDF 발송 완료';
      return '새 모임 기록 PDF 자동 발송 켜짐';
    }
    if(!status.configured)return '캘린더 연결 준비 중';
    if(!status.connected)return '아직 연결하지 않았어요';
    if(status.errorCode)return message(service,{code:status.errorCode});
    if(status.busy)return '모임 일정을 반영하고 있어요';
    if(!status.enabled)return '모임 일정 자동 반영 일시 중지';
    if(status.pending)return '모임 일정 반영 대기 중';
    return '모임 일정 자동 반영 켜짐';
  }
  function createClient(options){
    var disposed=false;
    function current(){return !disposed&&options.isCurrent();}
    function guard(){if(!current())throw fail('session_changed');}
    var common={isCurrent:current,getAccessToken:options.getAccessToken,fetch:options.fetch};
    var clients={drive:Drive.createClient(common),calendar:Calendar.createClient(common)};
    function loadService(service){
      return Promise.resolve().then(function(){guard();return clients[service].request('status');}).then(function(value){guard();return {status:statusView(service,value),error:null};});
    }
    function jointStatus(){
      return clients.drive.request('google-status').then(function(value){
        guard();if(typeof value.configured!=='boolean'||(value.sameAccount!==null&&typeof value.sameAccount!=='boolean'))throw fail('unavailable');
        var entries={configured:value.configured,sameAccount:value.sameAccount};services.forEach(function(service){
          var child=value[service];try{
            if(!child||child.unavailable===true)throw fail(child&&typeof child.errorCode==='string'&&/^[a-z_-]{1,60}$/.test(child.errorCode)?child.errorCode:'unavailable');
            entries[service]={status:statusView(service,child),error:null};
          }catch(error){entries[service]={status:null,error:error};}
        });return entries;
      });
    }
    function load(initial){
      if(!initial)return Promise.resolve().then(function(){guard();return jointStatus();});
      return Promise.allSettled(googleServices.map(function(service){return clients[service].request('config').then(function(value){guard();if(typeof value.configured!=='boolean')throw fail('unavailable');return value;});})).then(function(results){
        guard();if(results.every(function(result){return result.status==='fulfilled'&&result.value.configured;}))return jointStatus();
        return Promise.allSettled(results.map(function(result,index){
          if(result.status==='rejected')return Promise.reject(result.reason);
          return result.value.configured?loadService(googleServices[index]):Promise.resolve({status:statusView(googleServices[index],result.value),error:null});
        })).then(function(loaded){
          guard();var entries={configured:false,sameAccount:null,mail:{status:{configured:false,connected:false,enabled:false},error:null}};loaded.forEach(function(result,index){entries[googleServices[index]]=result.status==='fulfilled'?result.value:{status:null,error:result.reason};});return entries;
        });
      });
    }
    function request(service,action,payload){
      if(services.indexOf(service)<0||['configure','sync','disconnect'].indexOf(action)<0)return Promise.reject(fail('invalid_action'));
      if(service==='mail'&&action!=='configure')return Promise.reject(fail('invalid_action'));
      if(service==='mail')return Promise.resolve().then(function(){guard();return clients.drive.request('mail-configure',{enabled:payload&&payload.enabled});}).then(function(value){guard();return value;});
      return Promise.resolve().then(function(){guard();return clients[service].request(action,payload);}).then(function(value){guard();return value;});
    }
    function connect(){return Promise.resolve().then(function(){guard();return clients.drive.request('connect');}).then(function(value){guard();return value;});}
    return {load:load,request:request,connect:connect,dispose:function(){disposed=true;googleServices.forEach(function(service){clients[service].dispose();});}};
  }
  function cardHtml(service,title,intro,label,admin){
    return '<section class="google-connection-card'+(service==='mail'?' google-connection-card-mail':'')+'" aria-labelledby="google-'+service+'-title"><div class="google-connection-card-head"><h3 id="google-'+service+'-title">'+title+'</h3><button type="button" data-google-'+service+'-details hidden>자세히 보기</button></div>'+
      '<p class="google-connection-card-intro">'+intro+'</p><p class="google-connection-state" data-google-'+service+'-status role="status" aria-live="polite">상태를 확인하고 있어요…</p>'+
      '<p class="google-connection-card-account" data-google-'+service+'-email hidden></p><div data-google-'+service+'-connected hidden>'+
      (service==='drive'?'<a class="google-connection-folder" data-google-drive-folder target="_blank" rel="noopener noreferrer" hidden>GROWELL 백업 <span aria-hidden="true">↗</span></a>':'')+
      '<dl class="google-connection-last"'+(!admin&&service!=='drive'?' hidden':'')+'><dt>'+(service==='drive'?'마지막 백업':service==='mail'?'최근 발송':'최근 반영')+'</dt><dd data-google-'+service+'-last></dd></dl>'+
      '<label class="google-connection-toggle"><span>'+label+'</span><input type="checkbox" role="switch" data-google-'+service+'-enabled></label>'+
      (service==='mail'?'<p class="google-connection-mail-note"'+(!admin?' hidden':'')+'>최초 연결 시 최신 기록을 한 번 보내며, 이후 새로 공개된 기록마다 한 번씩 보내요. 이미 보낸 기록을 수정해도 다시 보내지 않아요.</p>':'<button type="button" class="google-connection-sync" data-google-'+service+'-sync>'+(service==='drive'?'지금 백업':'지금 반영')+'</button><button type="button" class="google-connection-disconnect" data-google-'+service+'-disconnect>연결 해제</button><div class="google-connection-confirm" data-google-'+service+'-confirm hidden><p>이 연결을 해제할까요? 저장한 기록과 이미 만들어진 '+(service==='drive'?'백업 파일':'일정')+'은 삭제되지 않아요.</p><div><button type="button" data-google-'+service+'-cancel>취소</button><button type="button" data-google-'+service+'-confirm-yes>연결 해제</button></div></div>')+'</div></section>';
  }
  function close(restore){
    var view=active;if(!view)return;active=null;clearTimeout(view.timer);root.document.removeEventListener('visibilitychange',view.visibility);view.client.dispose();
    if(view.push)view.push.destroy();
    if(view.node.open)view.node.close();view.node.remove();
    if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed('google-connection');
    if(restore!==false&&view.options.restoreFocus)view.options.restoreFocus();
  }
  function refresh(){if(active&&!active.options.isCurrent())close(false);}
  function open(options){
    if(!root.document||!Drive||!Calendar||!options||typeof options.isCurrent!=='function'||typeof options.getAccessToken!=='function'||!options.isCurrent())return;
    close(false);
    var admin=options.isAdmin===true,node=root.document.createElement('dialog');node.className='google-connection-dialog';node.setAttribute('aria-labelledby','google-connection-title');
    node.innerHTML='<header class="google-connection-head"><div><span>내 알림과 계정 연결을 관리해요</span><h2 id="google-connection-title">설정</h2></div><button type="button" data-google-close aria-label="설정 닫기">×</button></header>'+
      '<div class="google-connection-tabs" role="tablist" aria-label="설정 항목"><button type="button" id="settings-notifications-tab" role="tab" aria-controls="settings-notifications-panel" data-settings-notifications-tab>알림</button><button type="button" id="settings-connections-tab" role="tab" aria-controls="settings-connections-panel" data-settings-connections-tab>연동</button></div>'+
      '<div class="google-connection-body" data-settings-scroll><section id="settings-notifications-panel" role="tabpanel" aria-labelledby="settings-notifications-tab" data-settings-notifications-panel><section data-google-push></section>'+
      '<section class="google-connection-alert-help" aria-labelledby="settings-alert-help-title"><h3 id="settings-alert-help-title">알림 소리와 표시 방식</h3><p>알림의 소리와 화면 표시는 휴대폰에서 설정해요.</p><details><summary>갤럭시 · 삼성 리마인더</summary><p>삼성 리마인더에서 GROWELL 습관을 열고, 스피커 모양의 알림 유형을 눌러 <strong>강하게</strong>를 선택한 뒤 저장해주세요. 화면 전체 알림과 긴 알림 소리를 사용하는 설정이에요.</p><p>이 설정은 휴대폰에서 직접 선택해야 해요. GROWELL 웹 푸시 알림의 소리를 바꾸는 설정과는 달라요.</p></details><details><summary>아이폰 · 애플 미리 알림</summary><p>iOS 26.2 이상의 <strong>긴급</strong> 알람은 iCloud 미리 알림에서 사용할 수 있어요. 현재 GROWELL의 Microsoft 계정 목록에는 자동 적용할 수 없어요.</p><p>일반 알림 소리와 표시는 아이폰 <strong>설정 → 알림 → 미리 알림</strong>에서 확인해주세요.</p></details></section></section>'+
      '<section id="settings-connections-panel" role="tabpanel" aria-labelledby="settings-connections-tab" data-settings-connections-panel hidden><p class="google-connection-intro">Google 계정을 연결하면 기록 백업·모임 일정·PDF 이메일을 함께 사용할 수 있어요.</p>'+
      '<p class="google-connection-summary" data-google-summary role="status" aria-live="polite">Google 연결 상태를 확인하고 있어요…</p><p class="google-connection-return" data-google-return hidden></p>'+
      '<p class="google-connection-account" data-google-account hidden></p><button type="button" class="google-connection-primary" data-google-connect hidden>Google 계정 연결</button>'+
      '<p class="google-connection-consent" data-google-consent hidden>Google에서 백업과 캘린더 권한을 함께 허용해주세요. 기존에 한 가지만 연결했다면 한 번 다시 연결하면 돼요.</p>'+
      '<div class="google-connection-cards">'+cardHtml('drive','Google Drive 백업','저장한 내 기록을 GROWELL 백업 폴더에 보관해요.','자동 백업',admin)+cardHtml('calendar','모임 일정 · Google 캘린더','모임 날짜·시간·장소·읽을 범위를 내 기본 캘린더에 담아요.','모임 일정 자동 반영',admin)+cardHtml('mail','모임 기록 PDF 이메일','공개된 모임 기록과 해당 회차의 회원 공개 통찰을 Google 이메일로 받아요.','PDF 이메일 자동 발송',admin)+'</div>'+
      '<section class="google-connection-reminder" data-google-reminder hidden><h3>삼성 리마인더 · 애플 미리 알림</h3><p>이 화면에서 이어서 연결할 수 있어요. 습관 알림은 Microsoft 계정을 한 번 더 연결하고 휴대폰에서 같은 계정의 GROWELL 목록을 설정해주세요.</p><button type="button" data-google-reminder-open>습관 알림 연결·관리</button></section>'+
      '<button type="button" class="google-connection-refresh" data-google-refresh'+(!admin?' hidden':'')+'>Google 연결 상태 새로고침</button><p class="google-connection-pause">자동 백업·모임 일정·PDF 이메일은 각각 잠시 끌 수 있어요.</p>'+
      '<details class="google-connection-scope" data-google-scope'+(!admin?' hidden':'')+'><summary>백업·일정·PDF 상세 안내</summary><p>백업에는 서버에 저장한 내 기록·습관·자료·독서 아카이브가 담겨요. 작성 중인 초안과 외부 첨부파일 원본은 포함하지 않아요.</p><p>모임 일정에는 운영자가 저장한 날짜·시간·장소·읽을 범위와 안내가 담겨요. Google에서 고친 내용은 GROWELL에 반영되지 않아요.</p><p>이메일 PDF에는 운영자가 공개한 모임 기록과 같은 책·해당 회차에 회원이 공개한 통찰이 함께 담겨요. 나의 공간의 개인 기록과 공개하지 않은 글은 포함하지 않아요. 이메일을 연결해도 내 메일함을 읽거나 내 계정으로 메일을 보내는 권한은 요청하지 않아요.</p></details><p class="google-connection-recovery">개인 기록의 복구 파일은 <a href="#/profile/edit" data-google-recovery>프로필 수정에서 따로 보관해주세요.</a></p></section></div>';
    root.document.body.appendChild(node);
    var view={node:node,options:options,entries:null,busy:false,timer:null,polls:0};
    function current(){return active===view&&options.isCurrent();}
    view.client=createClient({isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});active=view;
    if(root.GrowellWebPush&&typeof root.GrowellWebPush.mount==='function')view.push=root.GrowellWebPush.mount(node.querySelector('[data-google-push]'),{memberKey:options.memberKey,isAdmin:admin,isCurrent:current,getAccessToken:options.getAccessToken,fetch:root.fetch.bind(root)});
    function q(selector){return node.querySelector(selector);}
    function selectTab(tab,focus){
      if(!current())return;var next=tab==='connections'?'connections':'notifications',changed=view.tab!==next;view.tab=next;
      ['notifications','connections'].forEach(function(name){var selected=view.tab===name,button=q('[data-settings-'+name+'-tab]');button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;q('[data-settings-'+name+'-panel]').hidden=!selected;if(selected&&focus)button.focus({preventScroll:true});});
      if(changed)q('[data-settings-scroll]').scrollTop=0;
    }
    function controls(){
      var summary=summaryView(view.entries);node.setAttribute('aria-busy',String(view.busy));
      q('[data-google-connect]').disabled=view.busy||!summary.canConnect;q('[data-google-refresh]').disabled=view.busy;
      services.forEach(function(service){var entry=view.entries&&view.entries[service],status=entry&&entry.status;
        q('[data-google-'+service+'-enabled]').disabled=view.busy||!status||!status.connected||!!entry.error;
        if(service!=='mail'){
          q('[data-google-'+service+'-sync]').disabled=view.busy||!status||!status.connected||status.busy||!!entry.error;
          q('[data-google-'+service+'-disconnect]').disabled=view.busy||!status||!status.connected||!!entry.error;
          q('[data-google-'+service+'-confirm-yes]').disabled=view.busy;
          q('[data-google-'+service+'-cancel]').disabled=view.busy;
        }
        q('[data-google-'+service+'-details]').disabled=view.busy;
      });q('[data-google-reminder-open]').disabled=view.busy;
    }
    function busy(value){view.busy=value;controls();}
    function draw(){
      if(!current())return;var summary=summaryView(view.entries),summaryNode=q('[data-google-summary]');
      summaryNode.textContent=summary.text;summaryNode.classList.toggle('is-error',['error','mismatch','unknown'].indexOf(summary.kind)>=0);
      q('[data-google-account]').hidden=!summary.email;q('[data-google-account]').textContent=summary.email;
      q('[data-google-connect]').hidden=!summary.showConnect||summary.kind==='loading'||summary.kind==='setup';q('[data-google-connect]').textContent=summary.needsReconnect?'Google 계정 다시 연결':'Google 계정 연결';
      q('[data-google-consent]').hidden=q('[data-google-connect]').hidden;
      services.forEach(function(service){
        var entry=view.entries&&view.entries[service],status=entry&&entry.status,state=q('[data-google-'+service+'-status]'),email=q('[data-google-'+service+'-email]'),enabled=q('[data-google-'+service+'-enabled]');
        state.textContent=entry&&entry.error?message(service,entry.error):status?stateText(service,status):'상태를 확인하고 있어요…';state.classList.toggle('is-error',!!(entry&&entry.error||status&&status.errorCode));
        email.hidden=(service!=='mail'&&summary.sameAccount)||!status||!status.connected||!status.accountEmail;email.textContent=status&&status.accountEmail||'';
        q('[data-google-'+service+'-connected]').hidden=!status||!status.connected;enabled.checked=!!(status&&status.enabled);
        if(service!=='mail'&&(!status||!status.connected))q('[data-google-'+service+'-confirm]').hidden=true;
        var stamp=status&&(service==='drive'?status.lastBackedUpAt:service==='mail'?status.lastSentAt:status.lastSyncedAt);q('[data-google-'+service+'-last]').textContent=stamp?new Date(stamp).toLocaleString('ko-KR',{hour12:false}):service==='drive'?'아직 백업 전':service==='mail'?'아직 발송 전':'날짜와 시간이 확정되면 등록돼요';
        if(service==='drive'){var folder=q('[data-google-drive-folder]'),url=status&&status.connected?Drive.folderUrl(status.folderUrl):'';folder.hidden=!url;if(url)folder.href=url;else folder.removeAttribute('href');}
      });controls();
    }
    function poll(){
      clearTimeout(view.timer);var pending=services.some(function(service){var entry=view.entries&&view.entries[service],s=entry&&!entry.error&&entry.status;return s&&s.enabled&&(s.pending||s.busy)&&!s.errorCode;});
      if(current()&&pending&&view.polls<6)view.timer=setTimeout(function(){if(current()&&!root.document.hidden){view.polls++;load(false);}},5000);
    }
    function load(initial){
      if(!current()||view.busy)return;busy(true);view.client.load(initial).then(function(entries){if(current()){view.entries=entries;draw();}}).catch(function(error){
        if(current()){view.entries={drive:{status:null,error:error},calendar:{status:null,error:error},mail:{status:null,error:error}};draw();}
      }).finally(function(){if(current()){busy(false);poll();}});
    }
    function change(service,action,payload){
      if(!current()||view.busy)return;clearTimeout(view.timer);view.polls=0;busy(true);
      view.client.request(service,action,payload).then(function(){return view.client.load(false);}).then(function(entries){if(current()){view.entries=entries;draw();}}).catch(function(error){
        if(current()){var entry=view.entries[service];view.entries[service]={status:entry.status,error:error};draw();}
      }).finally(function(){if(current()){busy(false);poll();}});
    }
    function connect(){
      if(!current()||view.busy||!summaryView(view.entries).canConnect)return;clearTimeout(view.timer);busy(true);
      Promise.resolve().then(function(){return options.beforeConnect?options.beforeConnect():undefined;}).then(function(){if(!current())throw fail('session_changed');return view.client.connect();}).then(function(result){
        if(!current())return;var url=Drive.authorizationUrl(result.url,root.location.origin);if(!url)throw fail('unavailable');root.location.assign(url);
      }).catch(function(error){if(current()){q('[data-google-summary]').textContent=message('drive',error);q('[data-google-summary]').classList.add('is-error');}}).finally(function(){if(current()){busy(false);poll();}});
    }
    q('[data-google-close]').onclick=function(){close();};node.addEventListener('cancel',function(event){event.preventDefault();close();});
    node.addEventListener('click',function(event){if(event.target!==node)return;var r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();});
    ['notifications','connections'].forEach(function(name){var button=q('[data-settings-'+name+'-tab]');button.onclick=function(){selectTab(name);};button.addEventListener('keydown',function(event){if(['ArrowLeft','ArrowRight','Home','End'].indexOf(event.key)<0)return;event.preventDefault();selectTab(event.key==='Home'?'notifications':event.key==='End'?'connections':name==='notifications'?'connections':'notifications',true);});});
    q('[data-google-connect]').onclick=connect;q('[data-google-refresh]').onclick=function(){if(admin){view.polls=0;load(true);}};q('[data-google-recovery]').onclick=function(){close(false);};
    services.forEach(function(service){
      q('[data-google-'+service+'-enabled]').onchange=function(){change(service,'configure',{enabled:this.checked});};
      if(service!=='mail'){
        q('[data-google-'+service+'-sync]').onclick=function(){change(service,'sync',{});};
        q('[data-google-'+service+'-disconnect]').onclick=function(){if(current()&&!view.busy){q('[data-google-'+service+'-confirm]').hidden=false;q('[data-google-'+service+'-cancel]').focus({preventScroll:true});}};
        q('[data-google-'+service+'-cancel]').onclick=function(){if(current()&&!view.busy){q('[data-google-'+service+'-confirm]').hidden=true;q('[data-google-'+service+'-disconnect]').focus({preventScroll:true});}};
        q('[data-google-'+service+'-confirm-yes]').onclick=function(){change(service,'disconnect',{});};
      }
      var callback=service==='mail'?null:options[service==='drive'?'onDriveDetails':'onCalendarDetails'],button=q('[data-google-'+service+'-details]');button.hidden=!admin||typeof callback!=='function';
      button.onclick=function(){if(admin&&current()&&!view.busy&&typeof callback==='function'){close(false);callback();}};
    });
    q('[data-google-reminder]').hidden=typeof options.onReminderSettings!=='function';
    q('[data-google-reminder-open]').onclick=function(){if(current()&&!view.busy&&typeof options.onReminderSettings==='function'){close(false);options.onReminderSettings();}};
    if(options.connectionResult==='partial'){q('[data-google-return]').hidden=false;q('[data-google-return]').textContent='일부 Google 연결을 완료하지 못했어요. 아래 상태를 확인하고 Google 계정을 다시 연결해주세요.';}
    view.visibility=function(){if(!options.isCurrent()){close(false);return;}if(current()&&!root.document.hidden){view.polls=0;load(false);}};root.document.addEventListener('visibilitychange',view.visibility);
    selectTab(options.connectionResult||options.tab==='connections'?'connections':'notifications');node.showModal();q('[data-google-close]').focus({preventScroll:true});if(root.GrowellPopupHistory)root.GrowellPopupHistory.open('google-connection',{close:function(){close();}});draw();load(true);
  }
  if(root.addEventListener){root.addEventListener('hashchange',refresh);root.addEventListener('pagehide',function(){close(false);});}
  return {open:open,close:close,refresh:refresh,createClient:createClient,statusView:statusView,summaryView:summaryView,message:message,stateText:stateText};
});
