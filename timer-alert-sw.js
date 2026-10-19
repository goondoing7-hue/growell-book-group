'use strict';
// Notifications only: no fetch handler or response cache; existing timer notifications share this worker.
self.addEventListener('install',function(event){event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim());});
function growellPush(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||['post','verse','test'].indexOf(value.type)<0)return null;
  var tag=typeof value.tag==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value.tag)?value.tag:'';
  if(!tag)return null;
  var data={kind:'growell-push',type:value.type},title='GROWELL',body='';
  if(value.type==='post'){
    if(['emotion','thought','body','action'].indexOf(value.bookId)<0||typeof value.postId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value.postId))return null;
    data.bookId=value.bookId;data.postId=value.postId;title='새로운 나눔';body='새로운 나눔이 올라왔어요. GROWELL에서 확인해보세요.';
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
// Only notification-click metadata is queued. No member text, account ID, token or saved reading record is stored here.
function readingIdentity(data){
  return !!(data&&data.kind==='growell-reading-session'&&data.version===1&&/^t1-[a-f0-9]+-[a-f0-9]+$/.test(data.ownerKey||'')&&/^t1-[a-f0-9]+-[a-f0-9]+$/.test(data.revision||'')&&/^[A-Za-z0-9_-]{1,200}$/.test(data.timerId||'')&&['emotion','thought','body','action'].indexOf(data.bookId)>=0&&typeof data.running==='boolean'&&typeof data.note==='boolean'&&data.phase==='timer');
}
function readingDb(){
  if(!self.indexedDB)return Promise.resolve(null);
  return new Promise(function(resolve){
    var done=false,timer=setTimeout(function(){finish(null);},3000),request;
    function finish(value){if(done){if(value)value.close();return;}done=true;clearTimeout(timer);resolve(value);}
    try{request=self.indexedDB.open('growell-reading-notification-v1',1);request.onupgradeneeded=function(){if(!request.result.objectStoreNames.contains('pending'))request.result.createObjectStore('pending');};request.onsuccess=function(){finish(request.result);};request.onerror=function(){finish(null);};request.onblocked=function(){finish(null);};}catch(error){finish(null);}
  });
}
function readingQueue(operation,identity){
  return readingDb().then(function(db){if(!db)return null;return new Promise(function(resolve){
    var output=null,tx;
    try{tx=db.transaction('pending','readwrite');var store=tx.objectStore('pending');
      if(operation==='put'){store.put(identity,'command');output=true;}
      else{var request=store.get('command');request.onsuccess=function(){
        var command=request.result,now=Date.now();
        if(!command)return;
        if(!readingIdentity(command)||['pause','resume','finish','open'].indexOf(command.action)<0||!Number.isSafeInteger(command.createdAt)||!Number.isSafeInteger(command.expiresAt)||command.createdAt>now+60000||command.expiresAt<=now||command.expiresAt-command.createdAt!==300000){store.delete('command');return;}
        if(operation==='clear'){if(command.ownerKey===identity.ownerKey){store.delete('command');output=true;}return;}
        if(command.ownerKey===identity.ownerKey&&command.timerId===identity.timerId&&command.bookId===identity.bookId){
          // A sleeping tab can still claim its old revision. Do not let it consume a newer tab's command.
          if(command.revision===identity.revision){store.delete('command');output=command;}
        }
      };}
      tx.oncomplete=function(){db.close();resolve(output);};tx.onerror=tx.onabort=function(){db.close();resolve(null);};
    }catch(error){db.close();resolve(null);}
  });}).catch(function(){return null;});
}
function readingWindow(client){try{var url=new URL(client.url);return url.origin===self.location.origin&&url.pathname==='/';}catch(error){return false;}}
self.addEventListener('message',function(event){
  var message=event.data,port=event.ports&&event.ports[0];
  if(!message||!event.source||!readingWindow(event.source))return;
  if(message.type==='growell-reading-clear'&&/^t1-[a-f0-9]+-[a-f0-9]+$/.test(message.ownerKey||'')){event.waitUntil(readingQueue('clear',{ownerKey:message.ownerKey}));return;}
  if(message.type!=='growell-reading-claim'||!port||!readingIdentity(message.identity))return;
  event.waitUntil(readingQueue('claim',message.identity).then(function(command){try{port.postMessage({type:'growell-reading-command',command:command});}catch(error){}}));
});
function relayReading(client){
  if(typeof MessageChannel!=='function'||typeof client.postMessage!=='function')return Promise.resolve(null);
  return new Promise(function(resolve){var channel=new MessageChannel(),done=false,timer=setTimeout(function(){finish(false);},2500);
    function finish(ok){if(done)return;done=true;clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(ok?client:null);}
    channel.port1.onmessage=function(event){finish(event.data&&event.data.accepted===true);};
    try{client.postMessage({type:'growell-reading-pending'},[channel.port2]);}catch(error){finish(false);}
  });
}
function readingClick(event,data){
  var action=event.action||'open';
  if(!readingIdentity(data)||['pause','resume','finish','open'].indexOf(action)<0)return Promise.resolve(null);
  if(action==='pause'&&!data.running||action==='resume'&&data.running)return Promise.resolve(null);
  var created=Date.now(),command={kind:data.kind,version:1,ownerKey:data.ownerKey,timerId:data.timerId,bookId:data.bookId,revision:data.revision,running:data.running,note:data.note,phase:'timer',action:action,createdAt:created,expiresAt:created+300000};
  var destination=new URL('/#/book/'+data.bookId+'/mine',self.location.origin).href;
  return readingQueue('put',command).then(function(){return self.clients.matchAll({type:'window',includeUncontrolled:true});}).then(function(windows){
    return Promise.all(windows.filter(readingWindow).slice(0,5).map(relayReading));
  }).then(function(results){var handled=results.find(function(client){return !!client;});if(handled&&typeof handled.focus==='function')return handled.focus();return self.clients.openWindow(destination);}).catch(function(){return null;});
}
self.addEventListener('notificationclick',function(event){
  event.notification.close();
  var data=event.notification.data||{},allowed=['emotion','thought','body','action'];
  if(data.kind==='growell-reading-session'){event.waitUntil(readingClick(event,data));return;}
  var route=allowed.indexOf(data.bookId)>=0?'#/book/'+data.bookId+'/mine':'#/';
  if(data.kind==='growell-push')route=data.type==='post'&&allowed.indexOf(data.bookId)>=0&&typeof data.postId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(data.postId)?'#/book/'+data.bookId+'/share/post/'+data.postId:'#/';
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
