(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.GrowellTimerAlerts=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var STORE='growell_timer_alerts_v1',LIMIT=64,MAX_AGE=30*86400000;
  var audioContext=null,registrationPromise=null,notificationError=false,memorySeen=[];
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
    if(registration.active&&registration.active.state==='activated')return Promise.resolve(registration);
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
      registrationPromise=bounded(Promise.resolve().then(function(){return root.navigator.serviceWorker.register('/timer-alert-sw.js',{scope:'/'});}).then(waitForActivation),8000,null).then(function(registration){
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
        body:'설정한 시간이 지났어요. 독서 시간은 계속 기록되고 있어요.',icon:'/covers/growell-icon-192.png',badge:'/covers/growell-icon-32.png',
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
  return {prepare:prepare,notify:notify,enableNotifications:enableNotifications,notificationStatus:notificationStatus};
});
