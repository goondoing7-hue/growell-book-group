(function(root,factory){
  var common=typeof module==='object'&&module.exports;
  var api=factory(root,common?require('./readingTimerDomain.js'):root.GrowellReadingTimer,common?require('./readingNotificationState.js'):root.GrowellReadingNotificationState);
  if(common)module.exports=api;else root.GrowellArchiveReadingNotification=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root,Timer,Protocol){
  'use strict';
  var books=['emotion','thought','body','action'],registered=[];
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function entryId(owner,book){return 'private_archive_'+owner+'_arc_shared_'+book;}
  function key(owner,book){return 'growell_archive_timer_v1:'+encodeURIComponent(owner)+':'+encodeURIComponent(book);}
  function validCheckpoint(value){return !!(value&&/^rn-[a-f0-9]{32}$/.test(value.generation||'')&&Number.isSafeInteger(value.throughSeq)&&value.throughSeq>=0&&Protocol.opaque(value.sourceRevision));}
  function closeOwn(identity){
    try{var nav=root.navigator;if(!nav||!nav.serviceWorker||typeof nav.serviceWorker.getRegistration!=='function')return Promise.resolve(false);
      return Promise.resolve(nav.serviceWorker.getRegistration('/')).then(function(reg){if(!reg||typeof reg.getNotifications!=='function')return false;return reg.getNotifications({tag:'growell-reading-session'}).then(function(notifications){notifications.forEach(function(item){if(item.data&&Protocol.same(item.data,identity))item.close();});return true;});}).catch(function(){return false;});
    }catch(e){return Promise.resolve(false);}
  }
  function create(adapter){
    var alerts=adapter.alerts||root.GrowellTimerAlerts,owner=adapter.ownerId,book=adapter.bookId,task=null,lease=null,last='',generation=null,opened='';
    if(typeof owner!=='string'||!owner||books.indexOf(book)<0||typeof adapter.snapshot!=='function'||typeof adapter.commit!=='function'||typeof adapter.current!=='function')return null;
    function current(){try{return adapter.current()===true;}catch(e){return false;}}
    function state(){var value=adapter.snapshot();return value&&value.timer&&value.timer.userId===owner?value:null;}
    function view(raw){
      raw=raw||state();if(!raw||!alerts||typeof alerts.sessionSnapshot!=='function')return null;
      var checkpoint=validCheckpoint(raw.notification)?raw.notification:null;
      var gen=checkpoint?checkpoint.generation:generation||(generation=alerts.newGeneration());if(!gen)return null;
      var proxy=Object.assign({},raw.timer,{bookId:book}),snapshot=alerts.sessionSnapshot({timer:proxy,userId:owner,generation:gen,blocked:raw.blocked?'archive':''});
      return snapshot?{raw:raw,snapshot:snapshot,checkpoint:checkpoint}:null;
    }
    function available(){if(!alerts||typeof alerts.sessionState!=='function'||typeof alerts.notificationStatus!=='function')return false;var status=alerts.notificationStatus(),raw=state();return !!(status.supported&&(status.permission==='granted'||raw&&validCheckpoint(raw.notification)));}
    function request(value){return Promise.resolve(alerts.sessionState(value));}
    async function commit(raw,timer,checkpoint,blocked,force){
      if(!force&&!current())return false;
      return await adapter.commit(raw,{timer:timer,notification:checkpoint,blocked:blocked===undefined?!!raw.blocked:blocked},{allowInactive:force===true})===true;
    }
    async function apply(record,local){
      var cp=local.checkpoint,raw=local.raw;
      if(!Protocol.valid(record)||record.ownerKey!==local.snapshot.ownerKey||record.timerId!==raw.timer.id||record.bookId!==book||raw.busy||raw.attempt)return false;
      var own=cp&&cp.generation===record.generation&&cp.sourceRevision===local.snapshot.baseRevision;
      if(record.baseRevision!==local.snapshot.baseRevision&&!own)return false;
      var through=own?cp.throughSeq:record.ackSeq;if(through>record.seq)return false;
      var timer=raw.timer;
      if(record.seq>through){
        if(raw.blocked&&!(cp&&Number.isSafeInteger(cp.logoutAt)))return false;
        timer=Object.assign({},timer,record.clock);
        if(timer.targetMs!==null&&timer.elapsedMs<timer.targetMs){timer.goalReached=false;timer.countdownNotified=false;timer.countdownAcknowledged=false;}
        timer=Timer.settle(timer,Date.now());if(!timer)return false;
      }
      var next=view(Object.assign({},raw,{timer:timer,notification:{generation:record.generation,throughSeq:record.seq,sourceRevision:local.snapshot.baseRevision}}));if(!next)return false;
      var checkpoint={generation:record.generation,throughSeq:record.seq,sourceRevision:next.snapshot.baseRevision};
      if(cp&&Number.isSafeInteger(cp.logoutAt))checkpoint.logoutAt=cp.logoutAt;
      if(record.seq===through&&cp&&cp.generation===record.generation&&cp.sourceRevision===next.snapshot.baseRevision&&cp.throughSeq===record.seq)return true;
      return commit(raw,timer,checkpoint);
    }
    async function reconcile(hold){
      if(!available())return {ok:true,unavailable:true};
      for(var tries=0;tries<5;tries++){
        var local=view();if(!current()||!local)return {ok:false};
        var result=await request({type:'read',identity:local.snapshot});if(!current())return {ok:false};
        if(!result.ok)return !local.checkpoint&&['unavailable','storage','timeout'].indexOf(result.code)>=0?{ok:true,unavailable:true}:{ok:false};
        var record=result.state,logout=local.checkpoint&&local.checkpoint.logoutAt;
        if(Number.isSafeInteger(logout)&&record&&!record.revoked){result=await request({type:'revoke',identity:record,pause:true,pauseAt:logout});if(!current()||!result.ok)return {ok:false};record=result.state;}
        if(!record)return {ok:true,result:result};
        if(!Protocol.valid(record))return {ok:false};
        if(record.journal.length){
          if(!await apply(record,local))return {ok:false};
          var refreshed=view();if(!refreshed)return {ok:false};
          var ack=await request({type:'ack',identity:record,throughSeq:refreshed.checkpoint.throughSeq,committedRevision:refreshed.checkpoint.sourceRevision});if(!current()||!ack.ok)return {ok:false};continue;
        }
        if(record.baseRevision!==local.snapshot.baseRevision&&local.checkpoint&&local.checkpoint.generation===record.generation&&local.checkpoint.sourceRevision!==local.snapshot.baseRevision)return {ok:false};
        if(hold&&result.active&&Protocol.matches(record,result.active)&&!record.revoked){
          lease=lease||alerts.newLease();if(!lease)return {ok:false};
          var held=await request({type:'hold',identity:record,expected:Protocol.head(record),lease:lease});if(!current())return {ok:false};
          if(!held.ok){if(held.code==='pending'||held.code==='conflict')continue;return {ok:false};}return {ok:true,result:held};
        }
        return {ok:true,result:result};
      }
      return {ok:false};
    }
    async function revokeRecord(record,pauseAt){
      if(!record)return true;var requestValue={type:'revoke',identity:record};if(Protocol.valid(record))requestValue.expected=Protocol.head(record);if(Number.isSafeInteger(pauseAt)){requestValue.pause=true;requestValue.pauseAt=pauseAt;}
      var result=await request(requestValue);if(result.ok)await closeOwn(record);return result.ok;
    }
    async function publish(previous){
      var local=view(),old=previous&&previous.state;
      if(!local||local.raw.blocked){
        last='';if(local&&local.checkpoint){var blockedCheckpoint=Object.assign({},local.checkpoint,{sourceRevision:local.snapshot.baseRevision});if(!await commit(local.raw,local.raw.timer,blockedCheckpoint,true))return false;}
        if(!await revokeRecord(old,local&&local.checkpoint&&local.checkpoint.logoutAt))return false;
        if(local&&local.checkpoint&&Number.isSafeInteger(local.checkpoint.logoutAt)){var finalPause=await reconcile(false);if(!finalPause.ok)return false;}
        var confirmed=view();if(confirmed&&confirmed.raw.blocked&&confirmed.checkpoint){var revokedCheckpoint=Object.assign({},confirmed.checkpoint,{revoked:true});if(!await commit(confirmed.raw,confirmed.raw.timer,revokedCheckpoint,true))return false;}
        return true;
      }
      if(!current())return false;
      if(alerts.notificationStatus().permission!=='granted')return revokeRecord(old);
      var result=await request({type:'read',identity:local.snapshot});if(!current()||!result.ok||result.state&&result.state.journal.length)return false;
      var record=result.state,gen=record&&!record.revoked?record.generation:record&&record.revoked?alerts.newGeneration():local.snapshot.generation;
      var checkpoint={generation:gen,throughSeq:record&&record.generation===gen?record.seq:0,sourceRevision:local.snapshot.baseRevision};
      if(!await commit(local.raw,local.raw.timer,checkpoint,false))return false;
      local=view();if(!local)return false;
      var armed=await request({type:'arm',snapshot:local.snapshot,expected:result.head||null,expectedActive:result.active||previous&&previous.active||null,lease:lease});
      if(!current()){if(armed.ok)await revokeRecord(armed.state,Date.now());return false;}
      if(armed.ok){generation=gen;last=local.snapshot.baseRevision+':'+armed.state.seq;lease=null;
        if(old&&!Protocol.same(old,armed.state))await revokeRecord(old);
        var intent=armed.state.openIntent;
        if(intent&&Number.isSafeInteger(intent.at)&&Date.now()-intent.at>=0&&Date.now()-intent.at<300000){var mark=gen+':'+intent.at;if(opened!==mark){opened=mark;if(adapter.open)adapter.open();}await request({type:'open-ack',identity:armed.state,at:intent.at});}
      }
      return !!armed.ok;
    }
    function run(work,requirePublish){
      if(task)return task.then(function(){return current()?run(work,requirePublish):false;});
      task=Promise.resolve().then(async function(){
        if(!current())return false;var before=await reconcile(true);if(!before.ok){if(adapter.error)adapter.error('알림의 읽은 시간을 확인하지 못했어요. 다시 눌러주세요.');return false;}
        if(!current())return false;var output=work?await work():true;
        var published=before.unavailable||await publish(before.result);if(!published){last='';if(adapter.error)adapter.error('읽은 시간은 보관했어요. 알림 연결을 다시 확인해주세요.');}
        if(adapter.changed)adapter.changed();return requirePublish&&!published?false:output;
      }).catch(function(){if(adapter.error)adapter.error('알림의 읽은 시간을 확인하지 못했어요. 다시 눌러주세요.');return false;}).finally(function(){task=null;});
      return task;
    }
    var api={mutate:run,handoff:function(work){return run(work,true);},sync:function(){if(task)return task;var local=view();if(!local||local.raw.busy||!current()||!available())return Promise.resolve(false);if(local.raw.blocked&&local.checkpoint&&local.checkpoint.revoked===true)return Promise.resolve(true);var signature=local.snapshot.baseRevision+':'+(local.checkpoint?local.checkpoint.throughSeq:0);if(signature===last&&!local.raw.blocked)return Promise.resolve(true);return run(null);},
      shutdown:function(at){var local=view();if(!local)return Promise.resolve(true);if(!Number.isSafeInteger(at)||at<0)at=Date.now();var timer=Timer.pause(local.raw.timer,at),cp=local.checkpoint||{generation:local.snapshot.generation,throughSeq:0,sourceRevision:local.snapshot.baseRevision};cp=Object.assign({},cp,{logoutAt:at});var paused=view(Object.assign({},local.raw,{timer:timer,notification:cp,blocked:true}));if(paused)cp.sourceRevision=paused.snapshot.baseRevision;last='';return commit(local.raw,timer,cp,true,true).then(function(){return revokeRecord(local.snapshot,at);}).catch(function(){return false;});},
      owns:function(identity){try{var local=view();return !!(local&&identity&&identity.ownerKey===local.snapshot.ownerKey&&identity.timerId===local.snapshot.timerId&&identity.bookId===book);}catch(e){return false;}},
      forget:function(){last='';},isCurrent:current,ownerId:owner,bookId:book};if(!adapter.transient){registered=registered.filter(function(item){return item.ownerId!==owner||item.bookId!==book;});registered.push(api);}return api;
  }
  function stored(owner,storage){
    var records=[];try{storage=storage||root.localStorage;if(!storage||typeof owner!=='string'||!owner)return records;
      books.forEach(function(book){var id=entryId(owner,book),storageKey=key(owner,id),raw=storage.getItem(storageKey);if(raw===null)return;if(typeof raw!=='string'||raw.length>25000)throw new Error('invalid-timer');var value=JSON.parse(raw),timer=value&&Timer.restore(value.timer,owner,[id],Date.now());if(value.v===1&&timer&&value.reading&&value.reading.format==='ebook')records.push({book:book,id:id,key:storageKey});});
      return records;
    }catch(e){return null;}
  }
  function hasStored(owner,storage,exceptEntryId){var records=stored(owner,storage);return records===null||records.some(function(record){if(record.id===exceptEntryId)return false;try{var raw=JSON.parse((storage||root.localStorage).getItem(record.key));if(raw.notification!==undefined&&raw.notification!==null&&!validCheckpoint(raw.notification))return true;return raw.notificationBlocked?validCheckpoint(raw.notification)&&raw.notification.revoked!==true:raw.timer.running||validCheckpoint(raw.notification);}catch(e){return true;}});}
  function storedCoordinator(record,owner,storage,options){
    return create({ownerId:owner,bookId:record.book,alerts:options.alerts,transient:true,current:options.current||function(){return true;},
      open:options.open?function(){options.open(record.book);}:null,changed:options.changed,
      snapshot:function(){var raw=storage.getItem(record.key),value=JSON.parse(raw||'null');return value&&value.timer?{timer:value.timer,attempt:value.attempt,busy:false,notification:value.notification||null,blocked:!!value.notificationBlocked,revision:raw}:null;},
      commit:function(expected,next){if(storage.getItem(record.key)!==expected.revision)return false;var value=JSON.parse(expected.revision);value.timer=next.timer;value.notification=next.notification;value.notificationBlocked=next.blocked;var serialized=JSON.stringify(value);storage.setItem(record.key,serialized);return storage.getItem(record.key)===serialized;}});
  }
  async function pauseStored(owner,storage,options){
    options=options||{};storage=storage||root.localStorage;var records=stored(owner,storage);if(records===null)return false;
    for(var i=0;i<records.length;i++){
      if(records[i].id===options.exceptEntryId)continue;
      var record=records[i],coordinator=storedCoordinator(record,owner,storage,options);
      if(!coordinator)return false;
      var result=await coordinator.handoff(function(){var snapshot=coordinator&&coordinator.ownerId===owner?JSON.parse(storage.getItem(record.key)):null;if(!snapshot||snapshot.attempt)return false;var raw=storage.getItem(record.key),cutoff=options.now?options.now():Date.now(),paused=Timer.pause(snapshot.timer,cutoff);if(!paused)return false;snapshot.timer=paused;snapshot.notificationBlocked=true;if(snapshot.notification)snapshot.notification=Object.assign({},snapshot.notification,{logoutAt:cutoff});if(storage.getItem(record.key)!==raw)return false;var serialized=JSON.stringify(snapshot);storage.setItem(record.key,serialized);return storage.getItem(record.key)===serialized;});
      if(!result)return false;
    }
    return true;
  }
  async function syncStored(owner,storage,options){
    options=options||{};storage=storage||root.localStorage;var records=stored(owner,storage);if(records===null)return false;var ok=true;
    for(var i=0;i<records.length;i++){
      var record=records[i],raw=JSON.parse(storage.getItem(record.key));if(options.identity&&(raw.timer.id!==options.identity.timerId||record.book!==options.identity.bookId||options.identity.ownerKey!==Protocol.hash('member:'+owner)))continue;
      var live=registered.find(function(item){return item.isCurrent()&&item.ownerId===owner&&item.bookId===record.book&&item.owns({ownerKey:Protocol.hash('member:'+owner),timerId:raw.timer.id,bookId:record.book});}),coordinator=live||storedCoordinator(record,owner,storage,options);
      if(!coordinator){ok=false;continue;}coordinator.forget();if(!await coordinator.sync())ok=false;if(live&&options.changed)options.changed();
    }
    return ok;
  }
  function active(owner,storage){
    var records=stored(owner,storage);if(!records)return null;var values=[];
    records.forEach(function(record){try{var value=JSON.parse((storage||root.localStorage).getItem(record.key));if(value.notificationBlocked)return;values.push({bookId:record.book,entryId:record.id,timer:copy(value.timer),reading:copy(value.reading)});}catch(e){}});
    values.sort(function(a,b){return Number(b.timer.running)-Number(a.timer.running)||b.timer.createdAt-a.timer.createdAt;});return values[0]||null;
  }
  return {create:create,pauseStored:pauseStored,syncStored:syncStored,hasStored:hasStored,active:active,owns:function(identity,owner,storage){
    if(registered.some(function(item){return item.owns(identity);}))return true;
    if(!identity||typeof owner!=='string'||identity.ownerKey!==Protocol.hash('member:'+owner))return false;
    var records=stored(owner,storage);return !!(records&&records.some(function(record){try{var value=JSON.parse((storage||root.localStorage).getItem(record.key));return value.timer.id===identity.timerId&&record.book===identity.bookId;}catch(e){return false;}}));
  },closeOwn:closeOwn};
});
