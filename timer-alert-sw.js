'use strict';
// Notifications only: no fetch handler, response cache, background timer or push subscription.
self.addEventListener('install',function(event){event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim());});
self.addEventListener('notificationclick',function(event){
  event.notification.close();
  var data=event.notification.data||{},allowed=['emotion','thought','body','action'];
  var route=allowed.indexOf(data.bookId)>=0?'#/book/'+data.bookId+'/mine':'#/';
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
