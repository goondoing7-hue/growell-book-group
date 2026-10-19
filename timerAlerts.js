(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.GrowellTimerAlerts=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var STORE='growell_timer_alerts_v1',LIMIT=64,MAX_AGE=30*86400000;
  var audioContext=null,registrationPromise=null,notificationError=false,memorySeen=[];
  var sessionSerial=0,sessionSignature='',sessionPending=null,sessionRegistration=null,sessionIdentity=null,SESSION_TAG='growell-reading-session';
  var allowedBooks=['emotion','thought','body','action'];
  function bounded(promise,milliseconds,fallback){
    return new Promise(function(resolve){
      var done=false,timer=root.setTimeout(function(){finish(fallback);},milliseconds);
      function finish(value){if(done)return;done=true;root.clearTimeout(timer);resolve(value);}
      Promise.resolve(promise).then(finish,function(){finish(fallback);});
    });
  }
  function notificationStatus(){
    var nav=root.navigator,api=root.Notification;
    var supported=root.isSecureContext!==false&&!!(api&&typeof api.requestPermission==='function'&&nav&&nav.serviceWorker&&typeof nav.serviceWorker.register==='function');
    var permission=supported?api.permission:'unsupported';
    var label=!supported?'이 브라우저에서는 기기 알림을 지원하지 않아요.':permission==='denied'?'알림이 차단되어 있어요. 브라우저 설정에서 허용해주세요.':notificationError?'알림을 연결하지 못했어요. 다시 시도해주세요.':permission==='granted'?'기기 알림이 켜져 있어요.':'기기 알림을 켜면 카운트다운 종료를 알려드려요.';
    return {supported:supported,permission:permission,enabled:supported&&permission==='granted'&&!notificationError,label:label};
  }
  function waitForActivation(registration){
    if(!registration.installing&&!registration.waiting&&registration.active&&registration.active.state==='activated')return Promise.resolve(registration);
    return new Promise(function(resolve){
      var worker=registration.installing||registration.waiting||registration.active;
      if(!worker){resolve(null);return;}
      var done=false,timer=root.setTimeout(function(){finish(null);},8000);
      function finish(result){if(done)return;done=true;root.clearTimeout(timer);worker.removeEventListener('statechange',check);resolve(result);}
      function check(){if(worker.state==='activated')finish(registration);else if(worker.state==='redundant')finish(null);}
      worker.addEventListener('statechange',check);check();
    });
  }
  function ensureRegistration(){
    if(!notificationStatus().supported)return Promise.resolve(null);
    if(!registrationPromise){
      registrationPromise=bounded(Promise.resolve().then(function(){return root.navigator.serviceWorker.register('/timer-alert-sw.js',{scope:'/',updateViaCache:'none'});}).then(waitForActivation),8000,null).then(function(registration){
        if(!registration||typeof registration.showNotification!=='function')throw new Error('notification-unavailable');
        notificationError=false;return registration;
      }).catch(function(){registrationPromise=null;notificationError=true;return null;});
    }
    return registrationPromise;
  }
  function prepare(){
    try{
      var Audio=root.AudioContext||root.webkitAudioContext;
      if(Audio&&(!audioContext||audioContext.state==='closed'))audioContext=new Audio();
      if(audioContext){
        // Called only from an explicit timer gesture; the silent frame unlocks
        // Web Audio without making a sound or asking for notification access.
        var resumed=audioContext.state==='suspended'?audioContext.resume():Promise.resolve();
        bounded(resumed,1000,false);
        var source=audioContext.createBufferSource();source.buffer=audioContext.createBuffer(1,1,22050);source.connect(audioContext.destination);source.start(0);
        source.onended=function(){try{source.disconnect();}catch(e){}};
      }
    }catch(e){/* Audio can be unavailable or restricted by the device. */}
    if(notificationStatus().permission==='granted')ensureRegistration();
    return Promise.resolve({audioReady:!!audioContext&&audioContext.state==='running',notifications:notificationStatus()});
  }
  function enableNotifications(){
    var status=notificationStatus();
    if(!status.supported||status.permission==='denied')return Promise.resolve(status);
    notificationError=false;
    var permission;
    // Do not put an asynchronous operation before this permission call:
    // mobile browsers require the original click's user activation.
    try{permission=status.permission==='granted'?Promise.resolve('granted'):root.Notification.requestPermission();}
    catch(e){notificationError=true;return Promise.resolve(notificationStatus());}
    return Promise.resolve(permission).then(function(value){
      return value==='granted'?ensureRegistration().then(notificationStatus):notificationStatus();
    }).catch(function(){notificationError=true;return notificationStatus();});
  }
  function opaqueId(value){
    if(typeof value!=='string'||!value.trim()||value.length>512)return null;
    var a=2166136261,b=3339675911;
    for(var i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),2246822519);}
    return 't1-'+(a>>>0).toString(16)+'-'+(b>>>0).toString(16);
  }
  function readClaims(){
    try{
      var raw=root.localStorage.getItem(STORE);if(!raw||raw.length>18000)return [];
      var records=JSON.parse(raw),now=Date.now();
      return Array.isArray(records)?records.filter(function(record){return record&&/^t1-[0-9a-f]+-[0-9a-f]+$/.test(record.id)&&Number.isFinite(record.at)&&record.at>=now-MAX_AGE;}).slice(-LIMIT):[];
    }catch(e){return [];}
  }
  function claim(id){
    var records=readClaims();
    if(memorySeen.indexOf(id)>=0||records.some(function(record){return record.id===id;}))return false;
    memorySeen.push(id);memorySeen=memorySeen.slice(-LIMIT);
    records.push({id:id,at:Date.now()});
    try{root.localStorage.setItem(STORE,JSON.stringify(records.slice(-LIMIT)));}catch(e){/* In-memory deduplication remains available. */}
    return true;
  }
  function claimOnce(id){
    try{
      if(root.navigator&&root.navigator.locks&&typeof root.navigator.locks.request==='function')return root.navigator.locks.request('growell-timer-alert-claim',function(){return claim(id);}).catch(function(){return claim(id);});
    }catch(e){}
    return Promise.resolve(claim(id));
  }
  function sound(){
    if(!audioContext||audioContext.state==='closed')return Promise.resolve(false);
    function play(){
      if(audioContext.state!=='running')return false;
      try{
        [660,880].forEach(function(frequency,index){
          var oscillator=audioContext.createOscillator(),gain=audioContext.createGain(),start=audioContext.currentTime+index*.24;
          oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,start);
          gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.09,start+.025);gain.gain.exponentialRampToValueAtTime(.001,start+.19);
          oscillator.connect(gain);gain.connect(audioContext.destination);oscillator.start(start);oscillator.stop(start+.21);
          oscillator.onended=function(){try{oscillator.disconnect();gain.disconnect();}catch(e){}};
        });
        return true;
      }catch(e){return false;}
    }
    try{return audioContext.state==='running'?Promise.resolve(play()):bounded(audioContext.resume(),700,false).then(play);}
    catch(e){return Promise.resolve(false);}
  }
  function vibrate(){try{return !!(root.navigator&&typeof root.navigator.vibrate==='function'&&root.navigator.vibrate([140,80,140]));}catch(e){return false;}}
  function systemNotification(bookId,id){
    if(notificationStatus().permission!=='granted')return Promise.resolve(false);
    return ensureRegistration().then(function(registration){
      if(!registration)return false;
      return registration.showNotification('카운트다운 종료!',{
        body:'설정한 시간이 지났어요. 독서 시간은 계속 기록되고 있어요.',icon:'/covers/growell-icon-192.png',badge:'/covers/growell-notification-badge-96.png',
        tag:'growell-reading-'+id,renotify:false,vibrate:[140,80,140],data:{bookId:allowedBooks.indexOf(bookId)>=0?bookId:null}
      }).then(function(){return true;},function(){notificationError=true;return false;});
    }).catch(function(){notificationError=true;return false;});
  }
  function notify(options){
    options=options||{};var id=opaqueId(options.countdownId);
    if(!id)return Promise.resolve({notified:false,duplicate:false,audio:false,vibration:false,notification:false});
    return claimOnce(id).then(function(fresh){
      if(!fresh)return {notified:false,duplicate:true,audio:false,vibration:false,notification:false};
      var vibration=vibrate();
      return Promise.all([sound(),systemNotification(options.bookId,id)]).then(function(results){return {notified:!!(results[0]||vibration||results[1]),duplicate:false,audio:results[0],vibration:vibration,notification:results[1]};});
    });
  }
  function sessionView(options){
    var timer=options&&options.timer,owner=options&&options.userId;
    if(!timer||typeof owner!=='string'||timer.userId!==owner||! /^[A-Za-z0-9_-]{1,200}$/.test(timer.id||'')||allowedBooks.indexOf(timer.bookId)<0||typeof timer.running!=='boolean'||['timer','save'].indexOf(timer.phase)<0||!Number.isSafeInteger(timer.elapsedMs)||timer.elapsedMs<0||timer.running&&(!Number.isSafeInteger(timer.startedAt)||timer.startedAt<0))return null;
    var ownerKey=opaqueId('member:'+owner),revision=opaqueId(JSON.stringify([timer.id,owner,timer.bookId,timer.running,timer.startedAt,timer.elapsedMs,timer.phase,!!options.note]));
    if(!ownerKey||!revision)return null;
    var seconds=Math.floor((timer.elapsedMs+(timer.running?Math.max(0,Date.now()-timer.startedAt):0))/1000),h=Math.floor(seconds/3600),m=Math.floor(seconds/60)%60,s=seconds%60;
    var elapsed=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return {data:{kind:'growell-reading-session',version:1,ownerKey:ownerKey,timerId:timer.id,bookId:timer.bookId,revision:revision,running:timer.running,note:!!options.note,phase:timer.phase},
      title:'독서 타이머',body:({'emotion':'감정을 마주하면 길이 보인다','thought':'생각이 너무 많은 어른들을 위한 심리학','body':'몸이 나를 위로한다','action':'습관이 영성이다'}[timer.bookId])+'\n'+(options.note?'노트 작성 중 · 잠시 멈춤':timer.running?'읽는 중':'잠시 멈춤')+' · 누적 '+elapsed,timestamp:timer.running?timer.startedAt:timer.createdAt};
  }
  function randomIdentity(prefix){
    try{var bytes=new Uint8Array(16);root.crypto.getRandomValues(bytes);return prefix+Array.from(bytes).map(function(n){return n.toString(16).padStart(2,'0');}).join('');}catch(error){return null;}
  }
  function sessionSnapshot(options){
    var view=sessionView(options),generation=options&&options.generation;if(!view||!/^rn-[a-f0-9]{32}$/.test(generation||''))return null;
    var timer=options.timer;return {ownerKey:view.data.ownerKey,timerId:timer.id,bookId:timer.bookId,generation:generation,
      baseRevision:opaqueId(JSON.stringify([timer.id,timer.userId,timer.bookId,timer.elapsedMs,timer.startedAt,timer.running,timer.phase,!!options.note,options.blocked||''])),
      clock:{elapsedMs:timer.elapsedMs,startedAt:timer.running?timer.startedAt:null,running:timer.running,phase:timer.phase},blocked:options.note?'note':timer.phase==='save'?'save':options.blocked||''};
  }
  function sessionState(request){
    if(request&&request.type==='arm')++sessionSerial;
    if(typeof root.MessageChannel!=='function'||!notificationStatus().supported)return Promise.resolve({ok:false,code:'unavailable'});
    return ensureRegistration().then(function(reg){
      if(!reg||!reg.active||typeof reg.active.postMessage!=='function')return {ok:false,code:'unavailable'};sessionRegistration=reg;
      return new Promise(function(resolve){var channel=new root.MessageChannel(),done=false,timer=root.setTimeout(function(){finish({ok:false,code:'timeout'});},5000);
        function finish(value){if(done)return;done=true;root.clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(value);}
        channel.port1.onmessage=function(event){var data=event.data;finish(data&&data.type==='growell-reading-state-result'&&data.result||{ok:false,code:'invalid'});};
        try{reg.active.postMessage({type:'growell-reading-state',request:request},[channel.port2]);}catch(error){finish({ok:false,code:'unavailable'});}
      });
    }).catch(function(){return {ok:false,code:'unavailable'};});
  }
  function closeSession(view,skipRevoke){
    var serial=++sessionSerial;sessionSignature='';sessionPending=null;
    var identity=view&&view.data||sessionIdentity,registration=sessionRegistration;sessionRegistration=null;sessionIdentity=null;
    var lookup;try{lookup=registration?Promise.resolve(registration):root.navigator&&root.navigator.serviceWorker&&typeof root.navigator.serviceWorker.getRegistration==='function'?root.navigator.serviceWorker.getRegistration('/'):Promise.resolve(null);}catch(error){lookup=Promise.resolve(null);}
    return bounded(Promise.resolve(lookup).then(function(reg){
      if(serial!==sessionSerial)return false;
      if(!skipRevoke&&identity&&/^rn-[a-f0-9]{32}$/.test(identity.generation||''))sessionState({type:'revoke',identity:identity});
      if(!reg||typeof reg.getNotifications!=='function')return false;return reg.getNotifications({tag:SESSION_TAG}).then(function(list){if(serial!==sessionSerial)return false;list.forEach(function(item){item.close();});return true;});
    }).catch(function(){return false;}),3000,false);
  }
  function showSession(view,isCurrent,force){
    if(!view||!view.data||typeof isCurrent!=='function'||!isCurrent()||notificationStatus().permission!=='granted')return Promise.resolve(false);
    if(view.data.phase==='save')return closeSession(view);
    var signature=JSON.stringify(view.data);if(!force&&signature===sessionSignature)return sessionPending||Promise.resolve(true);
    var serial=++sessionSerial;sessionSignature=signature;sessionIdentity=view.data;
    function current(){return serial===sessionSerial&&isCurrent();}
    sessionPending=ensureRegistration().then(function(reg){
      if(!reg||!current())return false;sessionRegistration=reg;
      var actions=view.data.note?[{action:'open',title:'타이머 보기'}]:[{action:view.data.running?'pause':'resume',title:view.data.running?'일시정지':'시작'},{action:'finish',title:'끝내기'}];
      var maximum=root.Notification&&root.Notification.maxActions;if(typeof maximum==='number'&&Number.isFinite(maximum))actions=actions.slice(0,Math.max(0,maximum));
      return reg.showNotification(view.title,{body:view.body,tag:SESSION_TAG,icon:'/covers/notification-'+view.data.bookId+'.png',badge:'/covers/growell-notification-badge-96.png',requireInteraction:true,renotify:false,silent:true,timestamp:Number.isSafeInteger(view.timestamp)?view.timestamp:Date.now(),actions:actions,data:view.data}).then(function(){
        if(current())return true;
        if(typeof reg.getNotifications==='function')return reg.getNotifications({tag:SESSION_TAG}).then(function(list){list.forEach(function(item){if(item.data&&item.data.ownerKey===view.data.ownerKey&&item.data.revision===view.data.revision)item.close();});return false;});
        return false;
      });
    }).catch(function(){if(serial===sessionSerial){sessionSignature='';notificationError=true;}return false;}).then(function(result){if(serial===sessionSerial&&!result)sessionSignature='';return result;});
    return sessionPending;
  }
  function claimSessionAction(view){
    if(!view||!view.data||typeof root.MessageChannel!=='function')return Promise.resolve(null);
    return ensureRegistration().then(function(reg){
      if(!reg||!reg.active||typeof reg.active.postMessage!=='function')return null;
      return new Promise(function(resolve){
        var channel=new root.MessageChannel(),done=false,timer=root.setTimeout(function(){finish(null);},4000);
        function finish(value){if(done)return;done=true;root.clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(value);}
        channel.port1.onmessage=function(event){var value=event.data;finish(value&&value.type==='growell-reading-command'?value.command:null);};
        try{reg.active.postMessage({type:'growell-reading-claim',identity:view.data},[channel.port2]);}catch(error){finish(null);}
      });
    }).catch(function(){return null;});
  }
  return {prepare:prepare,notify:notify,enableNotifications:enableNotifications,notificationStatus:notificationStatus,
    sessionView:sessionView,sessionSnapshot:sessionSnapshot,sessionState:sessionState,newGeneration:function(){return randomIdentity('rn-');},newLease:function(){return randomIdentity('rh-');},
    showSession:showSession,closeSession:closeSession,claimSessionAction:claimSessionAction};
});
