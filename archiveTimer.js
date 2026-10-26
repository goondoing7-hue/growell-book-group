(function(root,factory){
  var domain=typeof module==='object'&&module.exports?require('./readingTimerDomain.js'):root.GrowellReadingTimer;
  var format=typeof module==='object'&&module.exports?require('./readingFormatDomain.js'):root.GrowellReadingFormatDomain;
  var notifications=typeof module==='object'&&module.exports?require('./archiveReadingNotification.js'):root.GrowellArchiveReadingNotification;
  var api=factory(root,domain,format,notifications);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellArchiveTimer=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root,D,F,N){
  'use strict';
  var active=null,dialog=null,notice=null,ticker=null,countdownOpen=false,renderedState='';
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function readingMetadata(raw){
    if(raw===undefined||raw===null)return null;
    if(!F||!raw||typeof raw!=='object'||Array.isArray(raw)||raw.format!=='ebook'||!raw.ebook||typeof raw.ebook!=='object')throw new Error('invalid-reading-format');
    if(raw.startPercent!==null&&(typeof raw.startPercent!=='number'||!Number.isFinite(raw.startPercent)||raw.startPercent<0||raw.startPercent>100))throw new Error('invalid-reading-percent');
    var normalized=F.normalizeSettings({format:'ebook',ebook:raw.ebook});
    if(JSON.stringify(normalized.ebook)!==JSON.stringify(raw.ebook))throw new Error('invalid-reading-position');
    var result={format:'ebook',startPercent:raw.startPercent,ebook:normalized.ebook};
    if(raw.beforeComplete!==undefined){var previous=F.normalizeSettings({format:'ebook',ebook:raw.beforeComplete}).ebook;if(JSON.stringify(previous)!==JSON.stringify(raw.beforeComplete))throw new Error('invalid-reading-position');result.beforeComplete=previous;}
    return result;
  }
  function capturedReading(book){var settings=F&&F.normalizeSettings(book.readingSettings);return settings&&settings.format==='ebook'?{format:'ebook',startPercent:settings.ebook.progressPercent,ebook:copy(settings.ebook)}:null;}
  function readingSession(timer,reading,seconds,at){return {id:timer.id,unit:'percent',startPercent:reading.startPercent,endPercent:reading.ebook.progressPercent,sectionId:reading.ebook.sectionId,sectionTitle:reading.ebook.sectionTitle,progressKind:reading.ebook.progressKind,estimateBasis:reading.ebook.estimateBasis,seconds:seconds,createdAt:at};}
  function key(owner,book){return 'growell_archive_timer_v1:'+encodeURIComponent(owner)+':'+encodeURIComponent(book);}
  function cancelledKey(owner,book,timerId,at){return 'growell_archive_timer_cancelled_v1:'+encodeURIComponent(owner)+':'+encodeURIComponent(book)+':'+encodeURIComponent(timerId)+':'+at;}
  function pendingBookTimer(ownerId,entryId,storage){try{storage=storage||root.localStorage;var raw=storage.getItem(key(ownerId,entryId));if(typeof raw!=='string'||raw.length>25000)return false;var envelope=JSON.parse(raw);return envelope.v===1&&!!readingMetadata(envelope.reading)&&!!D.restore(envelope.timer,ownerId,[entryId],Date.now());}catch(e){return false;}}
  function id(){return 'art_'+(root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));}
  function pauseOthers(ownerId,exceptBookId,options){
    options=options||{};var storage=options.storage,now=options.now?options.now():Date.now();
    try{if(!storage)storage=root.localStorage;}catch(e){return false;}
    if(typeof ownerId!=='string'||!ownerId||!storage)return false;
    var prefix='growell_archive_timer_v1:'+encodeURIComponent(ownerId)+':',pending=[];
    try{
      if(!Number.isSafeInteger(storage.length)||storage.length<0)return false;
      // Inspect only this member's archive namespace. Other users' data stays opaque.
      for(var i=0;i<storage.length;i++){
        var storageKey=storage.key(i);if(typeof storageKey!=='string'||storageKey.slice(0,prefix.length)!==prefix)continue;
        var bookId=decodeURIComponent(storageKey.slice(prefix.length));
        if(storageKey!==key(ownerId,bookId))return false;
        if(bookId===exceptBookId)continue;
        var raw=storage.getItem(storageKey);if(raw===null)continue;if(raw.length>25000)return false;
        var envelope=JSON.parse(raw);if(!envelope||envelope.v!==1)return false;
        if(envelope.timer===null)continue;
        var timer=D.restore(envelope.timer,ownerId,[bookId],now);if(!timer)return false;
        if(!timer.running)continue;
        // An unconfirmed save is always paused. Never repair an inconsistent record.
        if(envelope.attempt)return false;
        pending.push({key:storageKey,before:raw,after:JSON.stringify(Object.assign({},envelope,{timer:D.pause(timer,now)}))});
      }
      for(var j=0;j<pending.length;j++){
        var item=pending[j];if(storage.getItem(item.key)!==item.before)return false;
        storage.setItem(item.key,item.after);if(storage.getItem(item.key)!==item.after)return false;
      }
      return true;
    }catch(e){return false;}
  }
  // Explicit developer recovery only. Callbacks must verify the exact signed-in
  // session, fully loaded records, and absence of this ID in saved reading logs.
  async function restoreCancelled(options,backupKey){
    options=options||{};var owner=options.ownerId,book=options.book,adapter=options.adapter||{},storage=options.storage,now=options.now||Date.now;
    function fail(code){return {ok:false,code:code};}
    function current(){try{return options.isCurrent()===true&&adapter.getOwnerId()===owner;}catch(e){return false;}}
    if(typeof owner!=='string'||!owner||!book||typeof book.id!=='string'||!book.id||typeof options.isCurrent!=='function'||typeof adapter.getOwnerId!=='function'||typeof adapter.canRestoreSession!=='function')return fail('validation-required');
    if(!current())return fail('session-changed');
    if(active&&active.state().timer)return fail('active-session');
    try{if(!storage)storage=root.localStorage;}catch(e){return fail('storage');}
    if(!storage||typeof backupKey!=='string'||backupKey.length>2000)return fail('invalid-backup');
    var raw,backup,recovery,restored,sourceKey,before,related;
    function emptyTimers(){
      var prefix='growell_archive_timer_v1:'+encodeURIComponent(owner)+':',found=[];
      if(!Number.isSafeInteger(storage.length)||storage.length<0)throw new Error('storage');
      for(var i=0;i<storage.length;i++){var item=storage.key(i);if(typeof item!=='string'||item.slice(0,prefix.length)!==prefix)continue;var value=storage.getItem(item);if(value===null)continue;if(value.length>25000)throw new Error('invalid-local-timer');var envelope=JSON.parse(value);if(!envelope||envelope.v!==1||envelope.timer!==null||envelope.attempt)throw new Error('active-session');found.push([item,value]);}
      return JSON.stringify(found.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0;}));
    }
    try{
      raw=storage.getItem(backupKey);if(typeof raw!=='string'||raw.length>150000)return fail('invalid-backup');backup=JSON.parse(raw);sourceKey=key(owner,book.id);
      if(!backup||backup.v!==1||backup.kind!=='archive-reading-cancelled'||backup.ownerId!==owner||backup.bookId!==book.id||backup.sourceKey!==sourceKey||!Number.isSafeInteger(backup.cancelledAt)||backup.cancelledAt<0||backupKey!==cancelledKey(owner,book.id,backup.timerId,backup.cancelledAt)||typeof backup.recoveryRaw!=='string'||backup.recoveryRaw.length>25000)return fail('invalid-backup');
      recovery=JSON.parse(backup.recoveryRaw);restored=D.restore(recovery.timer,owner,[book.id],now());
      var recoveredReading=readingMetadata(recovery.reading);
      if(recovery.v!==1||!restored||restored.id!==backup.timerId||restored.running||restored.startedAt!==null||recovery.attempt||!D.validatePages(restored.startPage,recovery.endPage,recoveredReading?100000:book.pageCount||100000).ok||typeof recovery.complete!=='boolean')return fail('invalid-backup');
      if(backup.sourceRaw!==null){if(typeof backup.sourceRaw!=='string'||backup.sourceRaw.length>25000)return fail('invalid-backup');var source=JSON.parse(backup.sourceRaw),old=D.restore(source.timer,owner,[book.id],backup.cancelledAt);if(source.v!==1||!old||old.id!==restored.id||source.attempt||JSON.stringify(D.pause(old,backup.cancelledAt))!==JSON.stringify(restored)||JSON.stringify(readingMetadata(source.reading))!==JSON.stringify(recoveredReading))return fail('invalid-backup');}
      before=storage.getItem(sourceKey);related=emptyTimers();
    }catch(e){return fail(e.message==='active-session'?'active-session':'invalid-backup');}
    try{if(await adapter.canRestoreSession(book.id,restored.id)!==true)return fail('saved-or-unverified');}catch(e){return fail('saved-or-unverified');}
    if(!current())return fail('session-changed');
    if(active&&active.state().timer)return fail('active-session');
    try{
      if(storage.getItem(sourceKey)!==before||storage.getItem(backupKey)!==raw||emptyTimers()!==related)return fail('local-state-changed');
      storage.setItem(sourceKey,backup.recoveryRaw);
      if(storage.getItem(sourceKey)!==backup.recoveryRaw)return fail('storage-unconfirmed');
      return {ok:true,code:'',timerId:restored.id,sourceKey:sourceKey};
    }catch(e){return fail('storage-unconfirmed');}
  }
  function createController(options){
    var book=options.book,owner=options.ownerId,adapter=options.adapter||{},storage=options.storage,now=options.now||Date.now;
    try{if(!storage)storage=root.localStorage;}catch(e){storage=null;}
    var storeKey=key(owner,book.id),snapshot=null,writable=true,busy=false,error='',timer=null,attempt=null,endPage=book.currentPage||0,complete=false,reading=null,notification=null,notificationBlocked=false,notificationCoordinator=null,notificationApplying=false,notificationDetached=false;
    function owned(){return !adapter.getOwnerId||adapter.getOwnerId()===owner;}
    function beforeStart(){
      function checked(ready){if(ready===false||!owned()||!pauseOthers(owner,book.id,{storage:storage,now:now})){error='먼저 읽던 타이머의 일시정지를 확인하지 못했어요. 다시 눌러주세요.';return false;}return true;}
      function begin(){var ready=adapter.beforeStart?adapter.beforeStart(owner,book.id):true;return ready&&typeof ready.then==='function'?Promise.resolve(ready).then(checked,function(){return checked(false);}):checked(ready);}
      try{if(!owned())return false;if(N&&N.hasStored(owner,storage,book.id))return N.pauseStored(owner,storage,{exceptEntryId:book.id,current:owned,alerts:options.notificationAlerts,now:now}).then(function(ok){return ok?begin():checked(false);});return begin();}
      catch(e){return checked(false);}
    }
    function decode(raw){
      if(raw===null){timer=null;attempt=null;return true;}
      try{
        if(raw.length>25000)return false;
        var envelope=JSON.parse(raw);if(envelope.v!==1)return false;
        if(envelope.timer===null){timer=null;attempt=null;return true;}
        var restored=D.restore(envelope.timer,owner,[book.id],now());if(!restored)return false;
        var restoredReading=readingMetadata(envelope.reading),last=envelope.endPage,check=D.validatePages(restored.startPage,last,restoredReading?100000:book.pageCount||100000);
        if(!check.ok)return false;
        var saved=envelope.attempt;
        if(saved){
          if(restored.phase!=='save'||saved.id!==restored.id||(restoredReading?JSON.stringify(Object.assign({},readingSession(restored,restoredReading,saved.seconds,saved.createdAt),{complete:saved.complete}))!==JSON.stringify(saved):saved.startPage!==restored.startPage||saved.endPage!==check.page)||
            !Number.isSafeInteger(saved.seconds)||saved.seconds<1||saved.seconds>31536000||saved.seconds!==Math.floor(D.elapsed(restored,now())/1000)||
            !Number.isSafeInteger(saved.createdAt)||saved.createdAt<0||typeof saved.complete!=='boolean')return false;
        }
        if(envelope.notification!==undefined&&envelope.notification!==null&&(!/^rn-[a-f0-9]{32}$/.test(envelope.notification.generation||'')||!Number.isSafeInteger(envelope.notification.throughSeq)||envelope.notification.throughSeq<0||typeof envelope.notification.sourceRevision!=='string'))return false;
        if(envelope.notificationBlocked!==undefined&&typeof envelope.notificationBlocked!=='boolean')return false;
        timer=restored;attempt=saved||null;endPage=check.page;complete=!!envelope.complete;reading=restoredReading;notification=envelope.notification||null;notificationBlocked=envelope.notificationBlocked===true;return true;
      }catch(e){return false;}
    }
    function read(){try{snapshot=storage.getItem(storeKey);writable=decode(snapshot);if(!writable)error='보관된 타이머를 확인하지 못했어요. 기존 기록은 덮어쓰지 않았어요.';}catch(e){writable=false;error='이 기기에 타이머를 보관할 수 없어요. 브라우저 저장 공간을 확인해주세요.';}}
    function fresh(){
      if(!owned()){error='로그인한 계정을 다시 확인해주세요.';return false;}
      try{
        var latest=storage.getItem(storeKey);
        if(latest!==snapshot){snapshot=latest;writable=decode(latest);error='다른 화면의 최신 타이머를 불러왔어요. 다시 눌러주세요.';return false;}
      }catch(e){error='타이머를 보관하지 못했어요. 다시 시도해주세요.';return false;}
      return writable;
    }
    function persist(confirm){
      if(!writable)return false;
      try{
        var current=storage.getItem(storeKey);if(current!==snapshot){error='다른 화면에서 타이머가 바뀌었어요. 다시 열어주세요.';return false;}
        if(notification&&!notificationApplying&&timer){var alertApi=options.notificationAlerts||root.GrowellTimerAlerts,proxy=Object.assign({},timer,{bookId:book.linkedBookId});var revised=alertApi&&alertApi.sessionSnapshot&&alertApi.sessionSnapshot({timer:proxy,userId:owner,generation:notification.generation,blocked:notificationBlocked?'archive':''});if(revised)notification=Object.assign({},notification,{sourceRevision:revised.baseRevision});}
        var envelope={v:1,timer:timer,attempt:attempt,endPage:endPage,complete:complete};if(reading)envelope.reading=reading;if(notification)envelope.notification=notification;if(notificationBlocked)envelope.notificationBlocked=true;
        var next=JSON.stringify(envelope);
        storage.setItem(storeKey,next);if(confirm===true&&storage.getItem(storeKey)!==next){error='취소 상태를 확인하지 못했어요. 복구본은 보관되어 있으니 타이머를 다시 확인해주세요.';return false;}snapshot=next;return true;
      }catch(e){error=confirm===true?'취소 상태를 확인하지 못했어요. 복구본은 보관되어 있으니 타이머를 다시 확인해주세요.':'타이머를 이 기기에 보관하지 못했어요. 화면을 닫기 전에 다시 시도해주세요.';return false;}
    }
    function change(work){if(busy||!fresh()||!timer)return false;var before=copy({timer:timer,attempt:attempt,endPage:endPage,complete:complete,reading:reading,notification:notification,notificationBlocked:notificationBlocked});error='';if(work()===false)return false;if(!persist()){timer=before.timer;attempt=before.attempt;endPage=before.endPage;complete=before.complete;reading=before.reading;notification=before.notification;notificationBlocked=before.notificationBlocked;return false;}return true;}
    function resumeReady(ready){
      function apply(allowed){busy=false;if(!allowed||!owned()||!fresh()||!timer||attempt)return false;return change(function(){notificationBlocked=false;if(notification)delete notification.logoutAt;timer=D.resume(timer,now());});}
      if(ready&&typeof ready.then==='function'){busy=true;return Promise.resolve(ready).then(apply,function(){return apply(false);}).finally(function(){if(active&&active.ownerId===owner&&active.book.id===book.id)render();});}
      return apply(ready);
    }
    read();
    if(writable&&!timer&&owned()){
      var ready=beforeStart(),asynchronous=ready&&typeof ready.then==='function';
      timer=D.create({id:id(),userId:owner,bookId:book.id,startPage:Number.isSafeInteger(book.currentPage)?book.currentPage:0,running:asynchronous?false:ready},now());
      reading=capturedReading(book);
      endPage=timer?timer.startPage:0;persist();if(asynchronous)resumeReady(ready);
    }else if(writable&&timer&&timer.running){
      var restoredReady=beforeStart();
      if(restoredReady&&typeof restoredReady.then==='function'){timer=D.pause(timer,now());persist();resumeReady(restoredReady);}
      else if(!restoredReady){timer=D.pause(timer,now());persist();}
    }
    var controller={
      book:book,ownerId:owner,adapter:adapter,
      state:function(){return {timer:timer?copy(timer):null,attempt:attempt?copy(attempt):null,endPage:endPage,complete:complete,reading:reading?copy(reading):null,notification:notification?copy(notification):null,notificationBlocked:notificationBlocked,busy:busy,error:error,writable:writable};},
      elapsed:function(){return timer?D.elapsed(timer,now()):0;},
      toggle:function(){if(busy||!fresh()||!timer||attempt)return false;if(!timer.running)return resumeReady(beforeStart());return change(function(){timer=D.pause(timer,now());});},
      pause:function(){return change(function(){timer=D.pause(timer,now());});},
      pauseForReset:function(){if(busy||!timer||!writable)return false;try{if(storage.getItem(storeKey)!==snapshot)return false;}catch(e){return false;}var at=now();if(notificationCoordinator)notificationCoordinator.shutdown(at);notificationDetached=true;timer=D.pause(timer,at);if(notificationCoordinator){notificationBlocked=true;if(notification)notification.logoutAt=at;}return persist();},
      resume:function(){if(busy||!fresh()||!timer||attempt)return false;return resumeReady(beforeStart());},
      done:function(){return change(function(){timer=D.pause(timer,now());timer.phase='save';});},
      setPage:function(value){if(!timer||attempt||reading)return false;var valid=D.validatePages(timer.startPage,value,book.pageCount||100000);if(!valid.ok){error=valid.error;return false;}return change(function(){endPage=valid.page;});},
      setSection:function(sectionId){if(!timer||timer.phase!=='save'||attempt||!reading||!F)return false;var details=root.GrowellBookDetails,entries=options.readingEntries||(details&&details.readingEntries?details.readingEntries(book):[]),next=F.selectSection({format:'ebook',ebook:reading.ebook},entries,sectionId,now());if(!next){error='읽고 있는 목차를 다시 선택해주세요.';return false;}return change(function(){reading.ebook=next.ebook;delete reading.beforeComplete;complete=false;});},
      setComplete:function(value){if(reading&&(!timer||timer.phase!=='save'))return false;return change(function(){if(attempt)return;var wasComplete=complete;complete=!!value;if(reading){if(complete){if(!wasComplete)reading.beforeComplete=copy(reading.ebook);reading.ebook.progressPercent=100;reading.ebook.progressKind='estimated';reading.ebook.estimateBasis=reading.ebook.estimateBasis||'equal-sections';reading.ebook.updatedAt=now();}else if(reading.beforeComplete){reading.ebook=reading.beforeComplete;delete reading.beforeComplete;}}else if(complete&&book.pageCount)endPage=book.pageCount;});},
      setCountdown:function(duration){return change(function(){if(attempt||timer.phase!=='timer')return;var next=D.setCountdown(timer,duration,now());if(next)timer=next;});},
      clearCountdown:function(){return change(function(){timer=D.clearCountdown(timer,now());});},
      markNotified:function(){return change(function(){timer=D.markCountdownNotified(timer,now())||timer;});},
      acknowledge:function(){return change(function(){timer=D.acknowledgeCountdown(timer,now())||timer;});},
      poll:function(){if(!owned())return false;if(!busy&&!fresh())return false;if(timer){var next=D.settle(timer,now());if(next&&next.goalReached!==timer.goalReached){timer=next;persist();}}if(notificationCoordinator&&!busy)notificationCoordinator.sync();return true;},
      discard:function(){
        if(busy){error='저장 중에는 취소할 수 없어요. 저장 결과를 확인해주세요.';return false;}
        if(attempt){error='저장 결과를 먼저 확인해야 해요. 같은 기록으로 다시 저장해주세요.';return false;}
        if(!fresh()||!timer)return false;
        var previous=timer,at=now(),backupKey=cancelledKey(owner,book.id,timer.id,at),backup;
        try{
          if(!Number.isSafeInteger(at)||at<0)throw new Error('invalid-time');
          var envelope=snapshot===null?{}:JSON.parse(snapshot),frozen=D.pause(timer,at);
          backup=JSON.stringify({v:1,kind:'archive-reading-cancelled',ownerId:owner,bookId:book.id,timerId:timer.id,cancelledAt:at,
            sourceKey:storeKey,sourceRaw:snapshot,recoveryRaw:JSON.stringify(Object.assign({},envelope,{v:1,timer:frozen,attempt:null,endPage:endPage,complete:complete}))});
          var existing=storage.getItem(backupKey);
          if(existing!==null&&existing!==backup)throw new Error('backup-conflict');
          if(existing===null)storage.setItem(backupKey,backup);
          if(storage.getItem(backupKey)!==backup)throw new Error('backup-unconfirmed');
        }catch(e){error='이번 기록의 복구본을 보관하지 못해 취소하지 않았어요. 다시 시도해주세요.';return false;}
        timer=null;if(persist(true))return true;timer=previous;return false;
      },
      save:async function(){
        if(busy||!fresh()||!timer||timer.phase!=='save')return false;
        var valid=reading?{ok:true}:D.validatePages(timer.startPage,endPage,book.pageCount||100000),seconds=Math.floor(D.elapsed(timer,now())/1000);
        if(!valid.ok||seconds<1){error=valid.error||'1초 이상 읽은 뒤 기록을 저장해주세요.';return false;}
        if(seconds>31536000){error='읽은 시간이 너무 길어요. 이 타이머를 취소한 뒤 새로 시작해주세요.';return false;}
        if(!attempt){attempt=reading?Object.assign(readingSession(timer,reading,seconds,now()),{complete:complete}):{id:timer.id,startPage:timer.startPage,endPage:valid.page,seconds:seconds,createdAt:now(),complete:complete};if(!persist()){attempt=null;return false;}}
        if(typeof adapter.saveSession!=='function'){error='기록 저장을 연결하지 못했어요. 잠시 후 다시 시도해주세요.';return false;}
        var pending=copy(attempt);busy=true;error='';
        try{
          var session=reading?Object.assign({},pending):{id:pending.id,startPage:pending.startPage,endPage:pending.endPage,seconds:pending.seconds,createdAt:pending.createdAt};if(reading)delete session.complete;
          var result=await adapter.saveSession(book.id,session,{complete:pending.complete});
          if(result===false)throw new Error('unconfirmed');
          if(!owned()){error='계정이 바뀌었어요. 같은 계정으로 돌아와 저장 상태를 확인해주세요.';return false;}
          // A confirmed retry has the same ID. Never clear a newer cross-tab timer.
          if(storage.getItem(storeKey)!==snapshot){error='다른 화면에 새 타이머가 있어요. 저장한 기록을 확인해주세요.';return false;}
          timer=null;attempt=null;persist();return {session:pending};
        }catch(e){error='저장을 확인하지 못했어요. 읽은 시간은 보관되어 있으니 같은 기록으로 다시 저장해주세요.';return false;}
        finally{busy=false;}
      }
    };
    var alerts=options.notificationAlerts||root.GrowellTimerAlerts;
    if(N&&alerts&&reading&&['emotion','thought','body','action'].indexOf(book.linkedBookId)>=0&&book.id==='private_archive_'+owner+'_arc_shared_'+book.linkedBookId){
      notificationCoordinator=N.create({ownerId:owner,bookId:book.linkedBookId,alerts:alerts,current:function(){return !notificationDetached&&owned()&&writable;},
        snapshot:function(){if(!timer)return null;return {timer:copy(timer),attempt:attempt?copy(attempt):null,busy:busy,notification:notification?copy(notification):null,blocked:notificationBlocked,revision:snapshot};},
        commit:function(expected,next,options){if(!(options&&options.allowInactive)&&!owned()||!writable||storage.getItem(storeKey)!==expected.revision)return false;var before=copy({timer:timer,notification:notification,blocked:notificationBlocked});timer=copy(next.timer);notification=next.notification?copy(next.notification):null;notificationBlocked=next.blocked===true;notificationApplying=true;var ok;try{ok=persist();}finally{notificationApplying=false;}if(!ok){timer=before.timer;notification=before.notification;notificationBlocked=before.blocked;}return ok;},
        changed:function(){if(active===controller)render();if(adapter.onTimerChanged)adapter.onTimerChanged();},open:function(){if(active!==controller)return;if(!dialog&&adapter.openTimer)adapter.openTimer();else if(!dialog)open({book:book,ownerId:owner,adapter:adapter,storage:storage,now:now,notificationAlerts:alerts});else render();},error:function(message){error=message;}});
      if(notificationCoordinator){
        ['toggle','pause','resume','done','discard','save'].forEach(function(name){var native=controller[name];controller[name]=function(){var args=arguments;return notificationCoordinator.mutate(function(){return native.apply(controller,args);});};});
        controller.notificationSync=function(){notificationCoordinator.forget();return notificationCoordinator.sync();};
        controller.notificationOwns=notificationCoordinator.owns;
      }
    }
    return controller;
  }
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function sourceAttribution(book){
    if(!book||typeof book.source!=='string'||book.source.toLowerCase()!=='yes24'||typeof book.sourceUrl!=='string')return '';
    var parsed;try{parsed=new URL(book.sourceUrl);}catch(e){return '';}
    if(parsed.protocol!=='https:'||parsed.hostname!=='www.yes24.com'||parsed.port||parsed.username||parsed.password)return '';
    var match=/^\/product\/goods\/([1-9]\d*)\/?$/i.exec(parsed.pathname);if(!match)return '';
    return '<small class="archive-source">도서 정보: <a href="https://www.yes24.com/product/goods/'+match[1]+'" target="_blank" rel="noopener noreferrer">YES24</a></small>';
  }
  function clock(ms){var s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(function(n){return String(n).padStart(2,'0');}).join(':');}
  function icon(name){var p={close:'m6 6 12 12M18 6 6 18',back:'m14 5-7 7 7 7',pause:'M8 5h2v14H8zM14 5h2v14h-2z',play:'m8 5 11 7-11 7z',check:'m5 12 4 4 10-10',timer:'M9 2h6M12 6v7l3 2M19 5l2 2M21 14a9 9 0 1 1-18 0 9 9 0 0 1 18 0',note:'m16 3 5 5-12 12-6 1 1-6z'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+p[name]+'"/></svg>';}
  function prepare(){if(root.GrowellTimerAlerts)root.GrowellTimerAlerts.prepare();}
  function historyOpen(name,close,canClose){if(root.GrowellPopupHistory)root.GrowellPopupHistory.open(name,{close:close,canClose:canClose});}
  function historyClose(name){if(root.GrowellPopupHistory)root.GrowellPopupHistory.closed(name);}
  function closeNotice(){if(notice){var n=notice;notice=null;if(n.open)n.close();n.remove();historyClose('archive-countdown-ended');}}
  function close(notify){
    closeNotice();if(dialog){var node=dialog;dialog=null;if(node.open)node.close();node.remove();historyClose('archive-reading-timer');}
    if(notify!==false&&active&&active.adapter.onClose)active.adapter.onClose();
  }
  function reset(){if(active){active.pauseForReset();pauseOthers(active.ownerId);}close(false);active=null;if(ticker)root.clearInterval(ticker);ticker=null;}
  function heading(){return '<div class="reading-home-dialog-heading"><h2 id="archive-reading-title">'+(active.state().timer&&active.state().timer.phase==='save'?'읽은 기록 저장':'독서 타이머')+'</h2><button type="button" class="icon-btn" data-at-close aria-label="타이머 닫고 책으로 돌아가기">'+icon('close')+'</button></div>';}
  function bookCard(){var reading=active.state().reading,book=active.book,cover=root.GrowellArchiveDomain?root.GrowellArchiveDomain.safeCoverUrl(book.coverUrl):'';return '<div class="reading-timer-book"><div class="reading-cover">'+(cover?'<img src="'+esc(cover)+'" alt="'+esc(book.title)+' 표지" referrerpolicy="no-referrer">':'')+'</div><div><strong>'+esc(book.title)+'</strong><span>'+esc((book.authors||[]).join(' · '))+'</span><span>'+esc(reading?(reading.ebook.sectionTitle||'전자책')+(reading.startPercent===null?'':' · '+F.displayPercent(reading.startPercent)+'%부터'):active.state().timer.startPage+(book.pageCount?' / '+book.pageCount:'')+'쪽부터 읽는 중')+'</span>'+sourceAttribution(book)+(active.adapter.openNote?'<button type="button" class="btn btn-secondary reading-note-open" data-at-note>'+icon('note')+' 노트 작성</button>':'')+'</div></div>';}
  function countdownHtml(){
    var left=D.remaining(active.state().timer,Date.now()),minutes=left===null?20:Math.max(1,Math.min(1439,Math.ceil(left/60000))),hours=Math.floor(minutes/60),mins=minutes%60;
    return '<div class="reading-countdown-settings"><h4>지금부터 얼마 동안 읽을까요?</h4><div class="reading-countdown-presets">'+[10,20,30].map(function(n){return '<button type="button" class="btn btn-sm" data-at-minutes="'+n+'">'+n+'분</button>';}).join('')+'</div><output class="reading-countdown-selection" data-at-selection for="archive-countdown-hours archive-countdown-minutes" aria-live="polite">'+hours+'시간 '+mins+'분</output><div class="reading-countdown-sliders"><label for="archive-countdown-hours">시간 <span>0–23시간</span></label><input id="archive-countdown-hours" type="range" min="0" max="23" step="1" value="'+hours+'" aria-valuetext="'+hours+'시간" data-at-hours><label for="archive-countdown-minutes">분 <span>0–59분</span></label><input id="archive-countdown-minutes" type="range" min="0" max="59" step="1" value="'+mins+'" aria-valuetext="'+mins+'분" data-at-mins></div><p>시간이 끝나면 알려드려요. 독서 시간은 계속 기록돼요.</p><div class="reading-countdown-actions"><button type="button" class="btn btn-sm" data-at-clear>시간 제한 없이</button><button type="button" class="btn btn-primary btn-sm" data-at-countdown-save>설정하기</button></div>'+notificationSettings()+'</div>';
  }
  function notificationSettings(){return '';}
  function timerHtml(state){var timer=state.timer,ratio=D.countdownRatio(timer,Date.now());return '<section class="reading-card reading-timer-card"><div class="reading-timer-head"><button type="button" class="btn btn-secondary" data-at-close>'+icon('back')+' 책</button><span class="reading-timer-status" data-at-status>'+(timer.running?'읽고 있는 중…':'잠시 멈춤')+'</span><button type="button" class="btn reading-complete-btn" data-at-done>'+icon('check')+' 완료</button></div><div class="reading-timer-label">이번에 읽은 시간</div><div class="reading-timer-display" data-at-elapsed>'+clock(active.elapsed())+'</div><button type="button" class="reading-timer-main-control" data-at-toggle aria-label="'+(timer.running?'잠시 멈춤':'계속 읽기')+'">'+(ratio===null?'':'<svg class="reading-countdown-ring" viewBox="0 0 120 120" aria-hidden="true"><circle class="reading-countdown-track" cx="60" cy="60" r="55"/><circle class="reading-countdown-progress" data-at-ring cx="60" cy="60" r="55" pathLength="100" stroke-dasharray="100" stroke-dashoffset="'+((1-ratio)*100)+'"/></svg>')+'<span class="reading-timer-control-icon">'+icon(timer.running?'pause':'play')+'</span></button><p class="reading-control-label">'+(timer.running?'잠시 멈춤':'계속 읽기')+'</p>'+(timer.targetMs!==null?'<p class="reading-countdown-left">카운트다운 <strong data-at-remaining>'+clock(D.remaining(timer,Date.now()))+'</strong>'+(timer.goalReached?'<span>종료 · 독서 시간은 계속 기록돼요</span>':'')+'</p>':'')+'<button type="button" class="btn btn-secondary reading-countdown-open" data-at-countdown>'+icon('timer')+' 카운트다운 설정</button>'+(countdownOpen?countdownHtml():'')+bookCard()+'<p class="reading-continuity">화면을 이동해도 타이머는 이어져요. 일시정지한 시간은 제외해요.</p><button type="button" class="reading-discard" data-at-discard>이번 독서 취소</button></section>';}
  function saveHtml(state){if(state.reading)return ebookSaveHtml(state);var book=active.book,total=book.pageCount,disabled=state.busy||!!state.attempt;return '<section class="reading-card reading-save-card"><p class="reading-save-book">'+esc(book.title)+'</p>'+sourceAttribution(book)+'<div class="reading-save-duration"><span>이번에 읽은 시간</span><strong>'+clock(active.elapsed())+'</strong></div><div class="reading-finish-options"><button type="button" class="btn btn-sm" data-at-finish="false" aria-pressed="'+(!state.complete)+'"'+(disabled?' disabled':'')+'>오늘은 여기까지</button><button type="button" class="btn btn-sm" data-at-finish="true" aria-pressed="'+state.complete+'"'+(disabled?' disabled':'')+'>이 책 다 읽었어요</button></div><p><label for="archive-reading-page">어디까지 읽었나요?</label></p><div class="reading-page-entry"><div class="reading-page-number"><input id="archive-reading-page" type="number" inputmode="numeric" min="'+state.timer.startPage+'"'+(total?' max="'+total+'"':'')+' value="'+state.endPage+'"'+(disabled?' disabled':'')+'>'+(total?'<span>/ '+total+'쪽</span>':'<span>쪽</span>')+'</div>'+(total?'<strong class="reading-page-percentage" data-at-percent>'+Math.round(state.endPage/total*100)+'%</strong>':'')+'</div>'+(total?'<div class="reading-page-slider-row"><button class="btn btn-sm" type="button" data-at-step="-1"'+(disabled?' disabled':'')+'>−</button><input type="range" aria-label="읽은 쪽수" min="'+state.timer.startPage+'" max="'+total+'" value="'+state.endPage+'" data-at-page-range'+(disabled?' disabled':'')+'><button class="btn btn-sm" type="button" data-at-step="1"'+(disabled?' disabled':'')+'>+</button></div>':'')+'<p class="reading-page-delta" data-at-delta>'+state.timer.startPage+' → '+state.endPage+'쪽 · 이번에 '+Math.max(0,state.endPage-state.timer.startPage)+'쪽 읽음</p><div class="composer-foot reading-save-actions">'+(!state.attempt?'<button type="button" class="btn btn-secondary" data-at-resume'+(state.busy?' disabled':'')+'>계속 읽기</button>':'')+'<button type="button" class="btn btn-secondary" data-at-save-cancel'+(state.busy?' disabled':'')+'>취소</button><button type="button" class="btn reading-complete-btn" data-at-save'+(state.busy?' disabled':'')+'>'+(state.busy?'저장 중…':'읽은 기록 저장')+'</button></div><p class="reading-continuity">이 책의 읽은 시간과 진도에 반영돼요.</p></section>';}
  function ebookSaveHtml(state){
    var book=active.book,settings={format:'ebook',ebook:state.reading.ebook},disabled=state.busy||!!state.attempt,details=root.GrowellBookDetails;
    var picker=details&&details.readingPickerHtml?details.readingPickerHtml(book,settings):'<p>읽은 목차를 선택해주세요.</p>';
    if(disabled)picker=picker.replace(/<button /g,'<button disabled ');
    return '<section class="reading-card reading-save-card reading-save-ebook"><p class="reading-save-book">'+esc(book.title)+'</p>'+sourceAttribution(book)+'<div class="reading-save-duration"><span>이번에 읽은 시간</span><strong>'+clock(active.elapsed())+'</strong></div><div class="reading-finish-options"><button type="button" class="btn btn-sm" data-at-finish="false" aria-pressed="'+(!state.complete)+'"'+(disabled?' disabled':'')+'>오늘은 여기까지</button><button type="button" class="btn btn-sm" data-at-finish="true" aria-pressed="'+state.complete+'"'+(disabled?' disabled':'')+'>이 책 다 읽었어요</button></div><h3 class="reading-ebook-title">어디까지 읽었나요?</h3><p class="reading-ebook-position">'+esc(settings.ebook.sectionTitle||'읽고 있는 목차를 선택해주세요.')+'<strong>'+(settings.ebook.progressPercent===null?'':F.displayPercent(settings.ebook.progressPercent)+'% · 추정')+'</strong></p>'+picker+'<div class="composer-foot reading-save-actions">'+(!state.attempt?'<button type="button" class="btn btn-secondary" data-at-resume'+(state.busy?' disabled':'')+'>계속 읽기</button>':'')+'<button type="button" class="btn btn-secondary" data-at-save-cancel'+(state.busy?' disabled':'')+'>취소</button><button type="button" class="btn reading-complete-btn" data-at-save'+(state.busy?' disabled':'')+'>'+(state.busy?'저장 중…':'읽은 기록 저장')+'</button></div><p class="reading-continuity">목차 구간의 중간값으로 진도를 추정해요. 읽은 시간과 함께 저장돼요.</p></section>';
  }
  function render(){
    if(!dialog||!active)return;var state=active.state();
    renderedState=stateKey(state);
    dialog.innerHTML=heading()+(state.timer?(state.timer.phase==='save'?saveHtml(state):timerHtml(state)):'<p class="empty">타이머를 열지 못했어요.</p>')+'<p role="status" data-at-error style="margin:0 18px 12px;color:var(--ink-soft);font-size:13px">'+esc(state.error)+'</p>';
    bind();tick();
  }
  function event(selector,fn){dialog.querySelectorAll(selector).forEach(function(node){node.addEventListener('click',fn);});}
  function afterMutation(value,callback){return value&&typeof value.then==='function'?value.then(callback):callback(value);}
  function bind(){
    event('[data-at-close]',function(){if(!active.state().busy)close(true);});
    event('[data-at-toggle]',function(){prepare();Promise.resolve(active.toggle()).then(render);render();});
    event('[data-at-save-cancel]',function(){var controller=active;return afterMutation(controller.discard(),function(ok){if(active!==controller)return;if(ok)close(true);else render();});});
    event('[data-at-done]',function(){var controller=active;return afterMutation(controller.done(),function(){if(active!==controller)return;countdownOpen=false;closeNotice();render();});});
    event('[data-at-resume]',function(){prepare();Promise.resolve(active.resume()).then(render);render();});
    event('[data-at-countdown]',function(){countdownOpen=!countdownOpen;render();});
    function updateCountdownSelection(){
      var hours=dialog.querySelector('[data-at-hours]'),mins=dialog.querySelector('[data-at-mins]');if(!hours||!mins)return;
      var h=Number(hours.value),m=Number(mins.value);dialog.querySelector('[data-at-selection]').textContent=h+'시간 '+m+'분';hours.setAttribute('aria-valuetext',h+'시간');mins.setAttribute('aria-valuetext',m+'분');
      dialog.querySelector('[data-at-countdown-save]').disabled=D.countdownDuration(hours.value,mins.value)===null;
    }
    dialog.querySelectorAll('[data-at-hours],[data-at-mins]').forEach(function(node){node.addEventListener('input',updateCountdownSelection);});
    event('[data-at-minutes]',function(e){dialog.querySelector('[data-at-hours]').value='0';dialog.querySelector('[data-at-mins]').value=e.currentTarget.dataset.atMinutes;updateCountdownSelection();});
    event('[data-at-countdown-save]',function(){var duration=D.countdownDuration(dialog.querySelector('[data-at-hours]').value,dialog.querySelector('[data-at-mins]').value);if(!duration){dialog.querySelector('[data-at-error]').textContent='1분에서 23시간 59분 사이로 설정해주세요.';return;}prepare();active.setCountdown(duration);countdownOpen=false;render();});
    event('[data-at-clear]',function(){active.clearCountdown();countdownOpen=false;closeNotice();render();});

    event('[data-at-discard]',function(){var controller=active;if(root.confirm('이번 독서를 취소할까요? 저장한 이전 기록은 유지돼요.'))return afterMutation(controller.discard(),function(ok){if(active!==controller)return;if(ok)close(true);else render();});});
    event('[data-book-ebook-section]',function(e){active.setSection(e.currentTarget.dataset.bookEbookSection);render();});
    event('[data-at-finish]',function(e){active.setComplete(e.currentTarget.dataset.atFinish==='true');render();});
    event('[data-at-step]',function(e){active.setPage(active.state().endPage+Number(e.currentTarget.dataset.atStep));render();});
    var page=dialog.querySelector('#archive-reading-page'),range=dialog.querySelector('[data-at-page-range]');
    if(page)page.oninput=function(){active.setPage(page.value);if(range)range.value=active.state().endPage;tick();};
    if(range)range.oninput=function(){active.setPage(range.value);if(page)page.value=active.state().endPage;tick();};
    event('[data-at-save]',async function(){var controller=active;if(page&&!controller.state().attempt&&!controller.setPage(page.value)){tick();return;}var promise=controller.save();render();var result=await promise;if(active!==controller)return;if(result){close(false);if(controller.adapter.onSaved)controller.adapter.onSaved(controller.book.id,result.session);}else render();});
    event('[data-at-note]',function(){
      var controller=active,wasRunning=controller.state().timer.running;return afterMutation(controller.pause(),function(paused){if(active!==controller)return;if(!paused){render();return;}render();var finished=false;
        function done(){if(finished)return;finished=true;if(active!==controller)return;afterMutation(wasRunning?controller.resume():true,render);}
        try{controller.adapter.openNote(controller.book,{onClose:done});}catch(e){done();}
      });
    });
    dialog.querySelectorAll('.reading-cover img').forEach(function(image){image.onerror=function(){image.remove();};});
  }
  function showNotice(){
    if(notice||!dialog||!dialog.open)return;
    var controller=active,element=root.document.createElement('dialog');notice=element;element.className='reading-countdown-ended';element.setAttribute('aria-labelledby','archive-countdown-ended-title');
    element.innerHTML='<div class="reading-countdown-ended-icon" aria-hidden="true">✓</div><h3 id="archive-countdown-ended-title">카운트다운이 끝났어요</h3><p>'+esc(controller.book.title)+'</p><strong>'+clock(controller.state().timer.countdownDurationMs)+'</strong><p>'+(controller.state().timer.running?'독서 시간은 계속 기록되고 있어요.':'독서 시간은 잠시 멈춰 있어요.')+'<br>읽기를 마치면 완료를 눌러주세요.</p><button type="button" class="btn btn-primary">확인</button>';
    function done(){if(active===controller)controller.acknowledge();closeNotice();}
    element.querySelector('button').onclick=done;element.oncancel=function(e){e.preventDefault();done();};root.document.body.appendChild(element);element.showModal();historyOpen('archive-countdown-ended',done);
  }
  function stateKey(state){var timer=state.timer;return timer?[timer.id,timer.phase,timer.running,timer.targetMs,timer.goalReached,!!state.attempt,state.busy].join(':'):'none';}
  function tick(){
    if(!active)return;
    if(active.adapter.getOwnerId&&active.adapter.getOwnerId()!==active.ownerId){close(false);return;}
    active.poll();var state=active.state(),timer=state.timer;if(dialog&&renderedState!==stateKey(state)){render();return;}if(!timer)return;
    if(timer.goalReached&&timer.phase==='timer'){
      if(!timer.countdownNotified&&active.markNotified()&&root.GrowellTimerAlerts)root.GrowellTimerAlerts.notify({bookId:null,countdownId:timer.countdownId,bookTitle:active.book.title}).catch(function(){});
      if(!timer.countdownAcknowledged)showNotice();
    }
    if(!dialog)return;
    var elapsed=dialog.querySelector('[data-at-elapsed]'),remaining=dialog.querySelector('[data-at-remaining]'),ring=dialog.querySelector('[data-at-ring]'),status=dialog.querySelector('[data-at-status]');
    if(elapsed)elapsed.textContent=clock(active.elapsed());if(remaining)remaining.textContent=clock(D.remaining(timer,Date.now()));
    if(ring)ring.setAttribute('stroke-dashoffset',((1-(D.countdownRatio(timer,Date.now())||0))*100).toFixed(3));
    if(status)status.textContent=timer.running?(timer.goalReached?'목표 달성 · 계속 읽는 중':'읽고 있는 중…'):'잠시 멈춤';
    var delta=dialog.querySelector('[data-at-delta]'),percent=dialog.querySelector('[data-at-percent]');
    if(delta)delta.textContent=timer.startPage+' → '+state.endPage+'쪽 · 이번에 '+Math.max(0,state.endPage-timer.startPage)+'쪽 읽음';
    if(percent&&active.book.pageCount)percent.textContent=Math.round(state.endPage/active.book.pageCount*100)+'%';
    var error=dialog.querySelector('[data-at-error]');if(error)error.textContent=state.error;
  }
  function open(options){
    if(!D||!options||!options.book||!options.book.id||!options.ownerId||!options.adapter)return false;
    if(active&&active.state().busy)return false;
    close(false);active=createController(options);countdownOpen=false;prepare();
    dialog=root.document.createElement('dialog');dialog.id='archive-reading-timer';dialog.className='reading-home-dialog archive-reading-timer';dialog.setAttribute('aria-labelledby','archive-reading-title');
    dialog.oncancel=function(e){e.preventDefault();if(!active.state().busy)close(true);};
    root.document.body.appendChild(dialog);render();dialog.showModal();historyOpen('archive-reading-timer',function(){close(true);},function(){return !active||!active.state().busy;});
    if(ticker)root.clearInterval(ticker);ticker=root.setInterval(tick,500);tick();return true;
  }
  return {open:open,close:function(){close(true);},reset:reset,pauseOthers:pauseOthers,pendingBookTimer:pendingBookTimer,createController:createController,storageKey:key,cancelledStorageKey:cancelledKey,restoreCancelled:restoreCancelled};
});
