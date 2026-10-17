(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellWebPush=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var epoch=0,views=new Set(),localSequence=0,actions=['config','status','subscribe','preferences','unsubscribe','test'];
  function fail(code){var error=new Error(code);error.code=code;return error;}
  function bounded(promise,delay){
    return new Promise(function(resolve,reject){var timer=root.setTimeout(function(){reject(fail('timeout'));},delay);
      Promise.resolve(promise).then(function(value){root.clearTimeout(timer);resolve(value);},function(error){root.clearTimeout(timer);reject(error);});});
  }
  function support(){
    var nav=root.navigator||{},ios=/iPad|iPhone|iPod/.test(nav.userAgent||'')||(nav.platform==='MacIntel'&&nav.maxTouchPoints>1);
    var standalone=nav.standalone===true||!!(root.matchMedia&&root.matchMedia('(display-mode: standalone)').matches);
    return {supported:root.isSecureContext===true&&!!(root.Notification&&nav.serviceWorker&&root.PushManager),iosNeedsInstall:ios&&!standalone,
      permission:root.Notification&&root.Notification.permission||'default'};
  }
  function publicKey(value){
    if(typeof value!=='string'||!/^B[A-Za-z0-9_-]{86}$/.test(value))throw fail('not_configured');
    var raw=root.atob(value.replace(/-/g,'+').replace(/_/g,'/')+'=');
    if(raw.length!==65||raw.charCodeAt(0)!==4)throw fail('not_configured');
    var result=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)result[i]=raw.charCodeAt(i);return result;
  }
  function message(error){
    var code=error&&typeof error.code==='string'?error.code.replace(/-/g,'_'):'';
    if(code==='permission_denied')return '이 기기의 브라우저 설정에서 GROWELL 알림을 허용해주세요.';
    if(code==='permission_dismissed')return '알림 허용을 완료하지 않았어요. 받을 준비가 되면 다시 눌러주세요.';
    if(code==='install_required')return '아이폰·아이패드는 Safari에서 홈 화면에 추가한 뒤, 홈 화면의 GROWELL을 열어 알림을 켜주세요.';
    if(code==='unsupported')return '이 브라우저에서는 푸시 알림을 사용할 수 없어요. 지원하는 최신 브라우저에서 열어주세요.';
    if(/^(auth_required|unauthorized|invalid_session|session_changed)$/.test(code))return '로그인 상태를 다시 확인한 뒤 알림을 연결해주세요.';
    if(code==='membership_required')return '가입 승인이 완료된 계정으로 로그인한 뒤 알림을 연결해주세요.';
    if(/^(not_configured|setup_required|push_not_configured)$/.test(code))return '푸시 알림을 준비하고 있어요. 준비가 끝나면 이 기기에서 연결할 수 있어요.';
    if(/^(subscription_required|subscription_missing|subscription_invalid|not_subscribed|connection_required)$/.test(code))return '먼저 이 기기에서 알림 받기를 눌러 연결해주세요.';
    if(code==='busy')return '알림 설정을 처리하고 있어요. 잠시 기다려주세요.';
    if(/^(rate_limited|too_many_requests)$/.test(code))return '잠시 기다린 뒤 다시 시도해주세요.';
    if(code==='timeout')return '응답이 늦어지고 있어요. 연결 상태를 새로고침해주세요.';
    if(code==='device_display_failed')return '기기 알림을 표시하지 못했어요. 브라우저의 사이트 알림과 갤럭시 설정의 해당 브라우저·GROWELL 알림 허용을 확인해주세요.';
    if(code==='worker_unavailable')return '이 기기의 알림 연결을 새로 확인해야 해요. 상태를 새로고침하거나 이 기기 알림을 껐다가 다시 연결해주세요.';
    return '알림 설정을 확인하지 못했어요. 인터넷 연결을 확인하고 다시 시도해주세요.';
  }
  function createClient(options){
    var disposed=false,pending=new Set();
    function current(){return !disposed&&options.isCurrent();}
    function guard(){if(!current())throw fail('session_changed');}
    function request(action,payload){
      if(actions.indexOf(action)<0)return Promise.reject(fail('invalid_action'));
      var controller=new root.AbortController(),timer=root.setTimeout(function(){controller.abort();},20000);pending.add(controller);
      return Promise.resolve().then(function(){guard();return bounded(options.getAccessToken(),20000);}).then(function(token){
        guard();if(typeof token!=='string'||!token)throw fail('auth_required');
        return options.fetch('/api/web-push',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,
          headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(Object.assign({},payload||{},{action:action}))});
      }).then(function(response){guard();return bounded(response.json(),20000).then(function(data){
        guard();if(!data||typeof data!=='object'||Array.isArray(data))throw fail('unavailable');
        if(!response.ok)throw fail(typeof data.error==='string'&&/^[a-z_-]{1,60}$/.test(data.error)?data.error:response.status===401?'auth_required':'unavailable');
        return data;
      });}).catch(function(error){if(!current())throw fail('session_changed');if(error&&error.code)throw error;throw fail(error&&error.name==='AbortError'?'timeout':'unavailable');})
        .finally(function(){root.clearTimeout(timer);pending.delete(controller);});
    }
    return {request:request,dispose:function(){disposed=true;pending.forEach(function(c){c.abort();});pending.clear();}};
  }
  function subscriptionStatus(raw){
    if(!raw||typeof raw.configured!=='boolean')throw fail('unavailable');
    if(raw.subscription!=null&&(!raw.subscription||typeof raw.subscription.active!=='boolean'||!raw.subscription.preferences||typeof raw.subscription.preferences.posts!=='boolean'||typeof raw.subscription.preferences.dailyVerse!=='boolean'))throw fail('unavailable');
    var stamp=raw.subscription&&typeof raw.subscription.lastSentAt==='string'?Date.parse(raw.subscription.lastSentAt):NaN;
    return {configured:raw.configured,subscribed:!!(raw.subscription&&raw.subscription.active),lastSentAt:Number.isFinite(stamp)?new Date(stamp).toISOString():'',preferences:raw.subscription?{posts:raw.subscription.preferences.posts,dailyVerse:raw.subscription.preferences.dailyVerse}:{posts:true,dailyVerse:true}};
  }
  function createController(options){
    options=options||{};var ownEpoch=epoch,disposed=false,key='',subscription=null;
    var state=Object.assign(support(),{configured:null,subscribed:false,preferences:{posts:true,dailyVerse:true},lastSentAt:'',busy:false,loaded:false,errorCode:'',notice:''});
    function current(){return !disposed&&epoch===ownEpoch&&options.isCurrent();}
    function guard(){if(!current())throw fail('session_changed');}
    var client=createClient({getAccessToken:options.getAccessToken,isCurrent:current,fetch:options.fetch||root.fetch.bind(root)});
    function emit(){if(current()&&options.onChange)options.onChange(snapshot());}
    function snapshot(){return Object.assign({},state,{preferences:Object.assign({},state.preferences)});}
    function device(){guard();return bounded(root.navigator.serviceWorker.getRegistration('/'),12000).then(function(reg){guard();return reg&&reg.pushManager?bounded(reg.pushManager.getSubscription(),12000):null;});}
    function apply(raw){var parsed=subscriptionStatus(raw);state.configured=parsed.configured;state.subscribed=parsed.subscribed;state.preferences=parsed.preferences;state.lastSentAt=parsed.lastSentAt;}
    function activated(reg){
      // A still-active timer worker may predate push support. Await its replacement when one is installing/waiting.
      return new Promise(function(resolve,reject){
        var worker=reg.installing||reg.waiting||reg.active,finished=false,timer;
        if(!worker){reject(fail('worker_unavailable'));return;}
        function finish(error){if(finished)return;finished=true;root.clearTimeout(timer);if(worker.removeEventListener)worker.removeEventListener('statechange',ready);if(error)reject(error);else resolve(reg);}
        function ready(){if(!current())finish(fail('session_changed'));else if(worker.state==='activated')finish();else if(worker.state==='redundant')finish(fail('worker_unavailable'));}
        timer=root.setTimeout(function(){finish(fail('timeout'));},15000);if(worker.addEventListener)worker.addEventListener('statechange',ready);ready();
      });
    }
    function run(operation){
      if(!current())return Promise.reject(fail('session_changed'));if(state.busy)return Promise.resolve(false);
      state.busy=true;state.errorCode='';state.notice='';emit();
      return Promise.resolve().then(operation).then(function(){guard();emit();return true;}).catch(function(error){
        if(current()){state.errorCode=error&&error.code||'unavailable';state.permission=support().permission;emit();}return false;
      }).finally(function(){if(current()){state.busy=false;emit();}});
    }
    function refresh(){return run(function(){
      Object.assign(state,support());if(!state.supported||state.iosNeedsInstall){state.loaded=true;state.subscribed=false;return;}
      return client.request('config',{}).then(function(config){guard();if(typeof config.configured!=='boolean')throw fail('unavailable');state.configured=config.configured;
        if(!config.configured){state.subscribed=false;state.loaded=true;return;}
        publicKey(config.publicKey);key=config.publicKey;
        return device().then(function(value){guard();subscription=value;return client.request('status',value?{endpoint:value.endpoint}:{});}).then(function(value){apply(value);state.loaded=true;});
      });
    });}
    function enable(){
      if(!current()||state.busy)return Promise.resolve(false);
      Object.assign(state,support());var permission;
      if(!state.supported)permission=Promise.reject(fail('unsupported'));
      else if(state.iosNeedsInstall)permission=Promise.reject(fail('install_required'));
      else if(!state.loaded||!state.configured||!key)permission=Promise.reject(fail('not_configured'));
      else if(state.permission==='denied')permission=Promise.reject(fail('permission_denied'));
      else{
        // Keep requestPermission in the original button gesture, before any token or network await.
        try{permission=state.permission==='granted'?Promise.resolve('granted'):Promise.resolve(root.Notification.requestPermission());}catch(error){permission=Promise.reject(fail('unavailable'));}
      }
      // Attach the permission rejection immediately; run starts its async operation on a microtask.
      permission.catch(function(){});
      return run(function(){return permission.then(function(answer){
        guard();state.permission=answer;if(answer!=='granted')throw fail(answer==='denied'?'permission_denied':'permission_dismissed');
        return bounded(root.navigator.serviceWorker.register('/timer-alert-sw.js',{scope:'/',updateViaCache:'none'}),15000);
      }).then(function(reg){
        guard();return (typeof reg.update==='function'?bounded(reg.update(),15000):Promise.resolve()).then(function(){guard();return activated(reg);});
      }).then(function(reg){guard();return bounded(reg.pushManager.getSubscription(),12000).then(function(existing){guard();return existing||bounded(reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKey(key)}),15000);});})
        .then(function(value){guard();subscription=value;return client.request('subscribe',{subscription:value.toJSON(),preferences:Object.assign({},state.preferences)});})
        .then(function(){guard();return client.request('status',{endpoint:subscription.endpoint});}).then(function(raw){apply(raw);state.notice='이 기기에서 알림을 받을 수 있어요.';});});
    }
    function preferences(value){return run(function(){
      if(!state.subscribed||!subscription)throw fail('subscription_required');
      if(!value||typeof value.posts!=='boolean'||typeof value.dailyVerse!=='boolean')throw fail('invalid_settings');
      return client.request('preferences',{endpoint:subscription.endpoint,preferences:{posts:value.posts,dailyVerse:value.dailyVerse}})
        .then(function(){return client.request('status',{endpoint:subscription.endpoint});}).then(apply);
    });}
    function testingRegistration(local){
      if(!state.subscribed||!subscription)throw fail('subscription_required');
      if(support().permission!=='granted')throw fail('permission_denied');
      function exact(reg){var base=root.location&&root.location.origin,scope,script;
        try{scope=new URL(reg.scope);script=new URL(reg.active.scriptURL);}catch(error){throw fail('worker_unavailable');}
        if(!base||scope.origin!==base||scope.pathname!=='/'||scope.search||scope.hash||script.origin!==base||script.pathname!=='/timer-alert-sw.js'||script.search||script.hash||reg.active.state!=='activated'||typeof reg.showNotification!=='function')throw fail('worker_unavailable');
      }
      return bounded(root.navigator.serviceWorker.getRegistration('/'),10000).then(function(reg){
        guard();exact(reg);
        // Refresh the public worker script even for devices connected before this release.
        var updated=typeof reg.update==='function'?bounded(reg.update(),8000):Promise.resolve();
        if(local)updated=updated.catch(function(){guard();return null;}); // Local display remains useful offline.
        return updated.then(function(){guard();return activated(reg);}).then(function(){guard();exact(reg);return reg;});
      }).then(function(reg){return bounded(reg.pushManager.getSubscription(),10000).then(function(value){
          guard();if(!value||value.endpoint!==subscription.endpoint)throw fail('worker_unavailable');
          if(support().permission!=='granted')throw fail('permission_denied');
          return reg;
        });});
    }
    function test(){return run(function(){return testingRegistration(false).then(function(){guard();return client.request('test',{endpoint:subscription.endpoint});}).then(function(){state.notice='테스트 알림을 요청했어요. 보통 1분 안에 도착해요.';});});}
    function localTest(){return run(function(){return testingRegistration(true).then(function(reg){
        return bounded(Promise.resolve().then(function(){guard();return reg.showNotification('GROWELL 기기 알림 확인',{body:'이 알림이 보이면 이 기기의 알림 표시가 작동하고 있어요.',tag:'growell-local-test-'+Date.now().toString(36)+'-'+(++localSequence).toString(36),icon:'/covers/growell-icon-192.png',badge:'/covers/growell-icon-192.png',data:{kind:'growell-push',type:'test'}});}),10000)
          .catch(function(error){if(error&&/^(session_changed|permission_denied)$/.test(error.code))throw error;throw fail('device_display_failed');});
      }).then(function(){guard();state.notice='이 기기에 알림 표시를 요청했어요. 화면 상단의 알림창을 내려 확인해주세요. 이 검사는 서버 전송과 별개예요.';});
    });}
    function disable(){return run(function(){if(!subscription)throw fail('subscription_required');var target=subscription;
      return client.request('unsubscribe',{endpoint:target.endpoint}).then(function(){guard();state.subscribed=false;subscription=null;state.notice='이 기기의 GROWELL 푸시 알림을 껐어요.';return bounded(target.unsubscribe(),10000).catch(function(){return false;});});
    });}
    return {refresh:refresh,enable:enable,preferences:preferences,test:test,localTest:localTest,disable:disable,snapshot:snapshot,destroy:function(){disposed=true;client.dispose();}};
  }
  function mount(container,options){
    if(!container||!options||typeof options.isCurrent!=='function'||typeof options.getAccessToken!=='function')return null;
    container.classList.add('web-push-section');container.innerHTML='<h3>푸시 알림</h3><p class="web-push-intro">GROWELL을 열지 않아도 새 나눔과 오늘의 말씀을 받아요. 알림을 받을 기기마다 한 번씩 허용해주세요.</p>'+
      '<p data-push-status class="web-push-status" role="status" aria-live="polite">알림 상태를 확인하고 있어요…</p><p data-push-install class="web-push-note" hidden>아이폰·아이패드는 Safari에서 GROWELL을 홈 화면에 추가한 뒤, 홈 화면 아이콘으로 열어 알림을 허용해주세요. iOS·iPadOS 16.4 이상이 필요해요.</p>'+
      '<button type="button" class="web-push-primary" data-push-enable>이 기기에서 알림 받기</button>'+
      '<div data-push-settings hidden><label class="web-push-toggle"><span>새 나눔 알림<small>내가 쓴 글과 글 수정은 제외해요.</small></span><input type="checkbox" role="switch" data-push-posts aria-label="새 나눔 알림"></label>'+
      '<label class="web-push-toggle"><span>매일 오전 9시 말씀<small>한국 시간 오전 9시에 발송해요.</small></span><input type="checkbox" role="switch" data-push-verse aria-label="매일 오전 9시 말씀"></label>'+
      '<button type="button" class="web-push-secondary" data-push-local>기기 알림 표시 확인</button><button type="button" class="web-push-secondary" data-push-test>테스트 알림 보내기</button><p class="web-push-note" data-push-last>최근 서버 발송: 아직 없어요. 기기 수신 확인과는 달라요.</p><button type="button" class="web-push-text" data-push-disable>이 기기 알림 끄기</button></div>'+
      '<button type="button" class="web-push-text" data-push-refresh>상태 새로고침</button><p class="web-push-note">인터넷 연결·집중 모드·기기 설정에 따라 알림이 늦거나 표시되지 않을 수 있어요.</p>';
    function q(selector){return container.querySelector(selector);}
    var controller=createController({getAccessToken:options.getAccessToken,isCurrent:options.isCurrent,fetch:options.fetch,onChange:function(state){
      var reason=!state.supported?'unsupported':state.iosNeedsInstall?'install_required':state.permission==='denied'?'permission_denied':state.errorCode;
      var text=reason?message({code:reason}):state.notice||(!state.loaded?'알림 상태를 확인하고 있어요…':!state.configured?message({code:'not_configured'}):state.subscribed?'이 기기에 알림이 연결되어 있어요.':'아직 이 기기의 알림을 연결하지 않았어요.');
      q('[data-push-status]').textContent=text;q('[data-push-status]').classList.toggle('is-error',!!state.errorCode);
      q('[data-push-install]').hidden=!state.iosNeedsInstall;q('[data-push-enable]').hidden=state.subscribed||!state.supported||state.iosNeedsInstall;
      q('[data-push-enable]').disabled=state.busy||!state.loaded||!state.configured||state.permission==='denied';
      q('[data-push-settings]').hidden=!state.subscribed;q('[data-push-posts]').checked=state.preferences.posts;q('[data-push-verse]').checked=state.preferences.dailyVerse;
      q('[data-push-last]').textContent='최근 서버 발송: '+(state.lastSentAt?new Date(state.lastSentAt).toLocaleString('ko-KR',{hour12:false}):'아직 없어요')+' · 기기 수신 확인과는 달라요.';
      container.setAttribute('aria-busy',String(state.busy));container.querySelectorAll('[data-push-posts],[data-push-verse],[data-push-test],[data-push-local],[data-push-disable],[data-push-refresh]').forEach(function(control){control.disabled=state.busy;});
    }});
    q('[data-push-enable]').onclick=controller.enable;q('[data-push-test]').onclick=controller.test;q('[data-push-local]').onclick=controller.localTest;q('[data-push-disable]').onclick=controller.disable;q('[data-push-refresh]').onclick=controller.refresh;
    function change(){controller.preferences({posts:q('[data-push-posts]').checked,dailyVerse:q('[data-push-verse]').checked});}
    q('[data-push-posts]').onchange=change;q('[data-push-verse]').onchange=change;
    var view={refresh:controller.refresh,destroy:function(){controller.destroy();views.delete(view);}};views.add(view);controller.refresh();return view;
  }
  function reset(){epoch++;views.forEach(function(view){view.destroy();});views.clear();}
  function detach(options){
    // Local unsubscribe also runs offline: a logged-out shared device must stop receiving the former account's pushes.
    var nav=root.navigator||{};if(!nav.serviceWorker)return Promise.resolve(false);
    var token;try{token=options&&typeof options.getAccessToken==='function'?Promise.resolve(options.getAccessToken()).catch(function(){return '';}):Promise.resolve('');}catch(error){token=Promise.resolve('');}
    function current(){return !options||typeof options.isCurrent!=='function'||options.isCurrent();}
    var registration;try{registration=nav.serviceWorker.getRegistration('/');}catch(error){return Promise.resolve(false);}
    var detached=bounded(registration,1500).then(function(reg){if(!current())return null;return reg&&reg.pushManager?bounded(reg.pushManager.getSubscription(),1500):null;}).then(function(subscription){
      if(!current())return false;
      if(!subscription)return false;
      // After capturing this exact object, finish its unsubscribe even if the former session is cleared.
      var local=bounded(subscription.unsubscribe(),2000).catch(function(){return false;});
      var remote=bounded(token,1500).then(function(value){if(!value)return false;
        return bounded(root.fetch('/api/web-push',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+value},body:JSON.stringify({action:'unsubscribe',endpoint:subscription.endpoint})}),2000).then(function(response){return response.ok;});
      }).catch(function(){return false;});
      return Promise.all([local,remote]).then(function(result){return result[0]||result[1];});
    }).catch(function(){return false;});
    return bounded(detached,3800).catch(function(){return false;});
  }
  return {mount:mount,reset:reset,detach:detach,createClient:createClient,createController:createController,support:support,subscriptionStatus:subscriptionStatus,message:message};
});
