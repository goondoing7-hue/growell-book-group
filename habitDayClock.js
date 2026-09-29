(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GrowellHabitDayClock=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  function day(value){var date=new Date(value);return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');}
  function create(options){
    options=options||{};
    var clock=options.now||Date.now,schedule=options.setTimeout||root.setTimeout.bind(root),cancel=options.clearTimeout||root.clearTimeout.bind(root);
    var browser=options.window||root,document=options.document||root.document,last=day(clock()),timer=null,running=false;
    function arm(){
      if(timer!==null)cancel(timer);timer=null;if(!running)return;
      var now=clock(),date=new Date(now),midnight=new Date(date.getFullYear(),date.getMonth(),date.getDate()+1).getTime();
      // A short upper bound also recovers from time-zone or device-clock changes.
      timer=schedule(check,Math.max(25,Math.min(60000,midnight-now+25)));
    }
    function check(){
      var next=day(clock()),previous=last,changed=next!==previous;
      if(changed){last=next;if(typeof options.onChange==='function')options.onChange(next,previous);}
      arm();return changed;
    }
    function visible(){if(!document||!document.hidden)check();}
    function listen(target,method,type,handler){if(target&&typeof target[method]==='function')target[method](type,handler);}
    function start(){
      if(running)return;running=true;
      listen(browser,'addEventListener','focus',check);listen(browser,'addEventListener','pageshow',check);listen(document,'addEventListener','visibilitychange',visible);check();
    }
    function stop(){
      running=false;if(timer!==null)cancel(timer);timer=null;
      listen(browser,'removeEventListener','focus',check);listen(browser,'removeEventListener','pageshow',check);listen(document,'removeEventListener','visibilitychange',visible);
    }
    return {start:start,stop:stop,check:check};
  }
  return {create:create,day:day};
});
