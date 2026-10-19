'use strict';
// Notifications only: no fetch handler or response cache; existing timer notifications share this worker.
self.addEventListener('install',function(event){event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim());});
function growellPush(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||['post','material','verse','test'].indexOf(value.type)<0)return null;
  var tag=typeof value.tag==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value.tag)?value.tag:'';
  if(!tag)return null;
  var data={kind:'growell-push',type:value.type},title='GROWELL',body='';
  if(value.type==='post'){
    if(['emotion','thought','body','action'].indexOf(value.bookId)<0||typeof value.postId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value.postId))return null;
    data.bookId=value.bookId;data.postId=value.postId;title='새로운 나눔';body='새로운 나눔이 올라왔어요. GROWELL에서 확인해보세요.';
  }else if(value.type==='material'){
    var books={emotion:'감정을 마주하면 길이 보인다',thought:'생각이 너무 많은 어른들을 위한 심리학',body:'몸이 나를 위로한다',action:'습관이 영성이다'};
    if(['emotion','thought','body','action'].indexOf(value.bookId)<0||typeof value.materialId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value.materialId))return null;
    data.bookId=value.bookId;data.materialId=value.materialId;title='GROWELL 새 자료';body='『'+books[value.bookId]+'』 자료실에 새 자료가 올라왔어요.';
  }else if(value.type==='verse'){
    if(typeof value.body!=='string'||!value.body.trim()||value.body.length>800)return null;
    title='오늘의 말씀';body=value.body.trim();
  }else{title='GROWELL 알림 연결';body='이 기기에서 GROWELL 알림을 받을 수 있어요.';}
  return {title:title,options:{body:body,tag:'growell-'+tag,icon:'/covers/growell-icon-192.png',badge:'/covers/growell-notification-badge-96.png',renotify:false,data:data}};
}
self.addEventListener('push',function(event){
  var payload;try{payload=growellPush(event.data&&event.data.json());}catch(error){return;}
  if(!payload)return;
  event.waitUntil(Promise.resolve().then(function(){return self.registration.showNotification(payload.title,payload.options);}).catch(function(){return null;}));
});
// Timer clocks and unacknowledged actions live only on this device. No saved member records, text or credentials are stored here.
try{if(typeof importScripts==='function')importScripts('/readingNotificationState.js');}catch(error){}
function readingState(){return typeof GrowellReadingNotificationState!=='undefined'?GrowellReadingNotificationState:null;}
function readingWindow(client){try{var url=new URL(client.url);return url.origin===self.location.origin&&url.pathname==='/';}catch(error){return false;}}
function readingKey(identity){return 'session:'+identity.ownerKey+':'+identity.timerId;}
function readingDb(){
  if(!self.indexedDB)return Promise.resolve(null);
  return new Promise(function(resolve){var done=false,request,timer=setTimeout(function(){finish(null);},3000);
    function finish(value){if(done){if(value)value.close();return;}done=true;clearTimeout(timer);resolve(value);}
    try{request=self.indexedDB.open('growell-reading-notification-v1',1);request.onupgradeneeded=function(){if(!request.result.objectStoreNames.contains('pending'))request.result.createObjectStore('pending');};request.onsuccess=function(){finish(request.result);};request.onerror=request.onblocked=function(){finish(null);};}catch(error){finish(null);}
  });
}
function readingOperation(request,clickAt){
  var api=readingState(),id=request&&(request.snapshot||request.identity);if(!api||!id||!api.opaque(id.ownerKey)||! /^[A-Za-z0-9_-]{1,200}$/.test(id.timerId||''))return Promise.resolve({ok:false,code:'invalid'});
  return readingDb().then(function(db){if(!db)return {ok:false,code:'storage'};return new Promise(function(resolve){var tx,answer={ok:false,code:'storage'};
    try{tx=db.transaction('pending','readwrite');var store=tx.objectStore('pending'),active,activeRead=store.get('active');
      activeRead.onsuccess=function(){active=activeRead.result||null;var read=store.get(readingKey(id));read.onsuccess=function(){
        var raw=read.result||null;
        if(request.type!=='read'&&request.type!=='ack'&&request.type!=='revoke'){
          if(request.type==='arm'){
            if(active&&(!request.expectedActive||!api.matches(active,request.expectedActive))){answer={ok:false,code:'active-conflict',active:active,state:raw};return;}
          }else if(!active||!api.matches(active,api.head(raw))){answer={ok:false,code:'inactive',active:active,state:raw};return;}
        }
        var changed=api.transition(raw,request,clickAt===undefined?Date.now():clickAt);answer=changed.result;answer.active=active;
        if(answer.ok&&request.type!=='read'){
          store.put(changed.record,readingKey(id));
          if(request.type==='arm'||active&&api.same(active,changed.record)){
            active=api.head(changed.record);store.put(active,'active');answer.active=active;
          }
        }
      };};
      tx.oncomplete=function(){db.close();resolve(answer);};tx.onerror=tx.onabort=function(){db.close();resolve({ok:false,code:'storage'});};
    }catch(error){db.close();resolve({ok:false,code:'storage'});}
  });}).catch(function(){return {ok:false,code:'storage'};});
}
function readingDisplay(record){
  var api=readingState();if(!api||!api.valid(record)||record.revoked)return Promise.resolve(false);
  var seconds=Math.floor((record.clock.elapsedMs+(record.clock.running?Math.max(0,Date.now()-record.clock.startedAt):0))/1000),elapsed=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(function(n){return String(n).padStart(2,'0');}).join(':'),actions;
  if(record.clock.phase==='save')actions=[{action:'save',title:'기록 저장'}];
  else if(record.blocked||record.held)actions=[{action:'open',title:record.blocked==='archive'?'앱에서 계속 읽기':'타이머 보기'}];
  else actions=[{action:record.clock.running?'pause':'resume',title:record.clock.running?'일시정지':'시작'},{action:'finish',title:'끝내기'}];
  var maximum=typeof Notification!=='undefined'?Notification.maxActions:undefined;if(maximum>=3&&!record.blocked&&!record.held&&record.clock.phase==='timer')actions.push({action:'note',title:'기록하기'});if(typeof maximum==='number'&&Number.isFinite(maximum))actions=actions.slice(0,Math.max(0,maximum));
  var data=api.head(record);data.kind='growell-reading-session';data.version=2;data.defaultAction=record.clock.phase==='save'?'save':record.blocked||record.held?'open':'note';
  var label=record.clock.phase==='save'?'독서 종료 · 기록 저장 대기':record.blocked==='note'?'노트 작성 중 · 잠시 멈춤':record.blocked==='archive'?'다른 책 읽는 중 · 잠시 멈춤':record.clock.running?'읽는 중':'잠시 멈춤';
  return Promise.resolve(self.registration.showNotification('독서 타이머',{body:api.book(record.bookId).title+'\n'+label+' · 누적 '+elapsed+(!record.blocked&&!record.held&&record.clock.phase==='timer'?'\n노트 쓰기는 알림 본문을 눌러주세요.':''),tag:'growell-reading-session',icon:api.book(record.bookId).notificationIcon,badge:'/covers/growell-notification-badge-96.png',requireInteraction:true,renotify:false,silent:true,timestamp:record.clock.startedAt===null?Date.now():record.clock.startedAt,actions:actions,data:data})).then(function(){return true;}).catch(function(){return false;});
}
self.addEventListener('message',function(event){
  var message=event.data,port=event.ports&&event.ports[0];if(!message||message.type!=='growell-reading-state'||!port||!event.source||!readingWindow(event.source)||!message.request||['read','arm','hold','ack','revoke','open-ack'].indexOf(message.request.type)<0)return;
  event.waitUntil(readingOperation(message.request).then(function(result){
    var show=message.request.type==='arm'&&result.ok?readingDisplay(result.state):Promise.resolve(false);
    return show.then(function(displayed){result.displayed=displayed;try{port.postMessage({type:'growell-reading-state-result',result:result});}catch(error){}});
  }));
});
function readingOpen(data){
  var destination=new URL('/#/book/'+data.bookId+'/mine',self.location.origin).href;
  return self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(windows){var existing=windows.find(readingWindow);if(existing){try{existing.postMessage({type:'growell-reading-open',identity:data});}catch(error){}if(typeof existing.focus==='function')return existing.focus();}return self.clients.openWindow(destination);});
}
function readingClick(event,data){
  var clickedAt=Date.now(),api=readingState(),action=event.action||data.defaultAction||'open';if(!api||!api.identity(data)||data.version!==2||['pause','resume','finish','note','open','save'].indexOf(action)<0)return Promise.resolve(null);
  if(action==='open'||action==='save')return readingOperation({type:'open-intent',identity:data,action:action},clickedAt).then(function(result){if(!result.ok||!api.valid(result.state)||!result.active||!api.matches(result.active,data)||result.state.revoked)return null;return readingOpen(data);});
  return readingOperation({type:'action',identity:data,action:action},clickedAt).then(function(result){
    if(!result.ok)return null;
    event.notification.close();return readingDisplay(result.state).then(function(){if(action==='note')return readingOpen(api.head(result.state));}).then(function(){return self.clients.matchAll({type:'window',includeUncontrolled:true});}).then(function(windows){windows.filter(readingWindow).forEach(function(client){try{client.postMessage({type:'growell-reading-changed',identity:api.head(result.state)});}catch(error){}});});
  }).catch(function(){return null;});
}
self.addEventListener('notificationclick',function(event){
  var data=event.notification.data||{},allowed=['emotion','thought','body','action'];
  if(data.kind==='growell-reading-session'){event.waitUntil(readingClick(event,data));return;}
  event.notification.close();
  var route=allowed.indexOf(data.bookId)>=0?'#/book/'+data.bookId+'/mine':'#/';
  if(data.kind==='growell-push'){
    route='#/';
    if(data.type==='post'&&allowed.indexOf(data.bookId)>=0&&typeof data.postId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(data.postId))route='#/book/'+data.bookId+'/share/post/'+data.postId;
    else if(data.type==='material'&&allowed.indexOf(data.bookId)>=0&&typeof data.materialId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(data.materialId))route='#/book/'+data.bookId+'/materials/post/'+data.materialId;
  }
  var destination=new URL('/'+route,self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(windows){
    var existing=windows.find(function(client){
      try{var url=new URL(client.url);return url.origin===self.location.origin&&url.pathname==='/'&&url.hash===route;}catch(e){return false;}
    });
    // Keep a different page's draft intact; focus an exact match or open the reading page.
    if(existing&&typeof existing.focus==='function')return existing.focus();
    return self.clients.openWindow(destination);
  }).catch(function(){return null;}));
});
