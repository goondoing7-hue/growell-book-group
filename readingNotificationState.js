(function(root,factory){
  var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GrowellReadingNotificationState=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var books=['emotion','thought','body','action'];
  var titles=['감정을 마주하면 길이 보인다','생각이 너무 많은 어른들을 위한 심리학','몸이 나를 위로한다','습관이 영성이다'];
  function book(id){var index=books.indexOf(id);return index<0?null:{title:titles[index],cover:'/covers/'+id+'.jpg',notificationIcon:'/covers/notification-'+id+'.png'};}
  function integer(n){return Number.isSafeInteger(n)&&n>=0;}
  function hash(text){var a=2166136261,b=3339675911;for(var i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),2246822519);}return 't1-'+(a>>>0).toString(16)+'-'+(b>>>0).toString(16);}
  function opaque(value){return typeof value==='string'&&/^t1-[a-f0-9]+-[a-f0-9]+$/.test(value);}
  function identity(value){return !!(value&&opaque(value.ownerKey)&&/^[A-Za-z0-9_-]{1,200}$/.test(value.timerId||'')&&books.indexOf(value.bookId)>=0&&/^rn-[a-f0-9]{32}$/.test(value.generation||''));}
  function clock(value){return !!(value&&integer(value.elapsedMs)&&typeof value.running==='boolean'&&(value.running?integer(value.startedAt):value.startedAt===null)&&['timer','save'].indexOf(value.phase)>=0&&!(value.phase==='save'&&value.running));}
  function copyClock(value){return {elapsedMs:value.elapsedMs,startedAt:value.startedAt,running:value.running,phase:value.phase};}
  function same(a,b){return !!(a&&b&&a.ownerKey===b.ownerKey&&a.timerId===b.timerId&&a.bookId===b.bookId&&a.generation===b.generation);}
  function head(value){return value?{ownerKey:value.ownerKey,timerId:value.timerId,bookId:value.bookId,generation:value.generation,seq:value.seq,revision:value.revision}:null;}
  function matches(value,expected){return same(value,expected)&&value.seq===expected.seq&&value.revision===expected.revision;}
  function revision(value){return hash(JSON.stringify([value.ownerKey,value.timerId,value.bookId,value.generation,value.seq,value.clock,value.blocked,value.revoked,value.held,value.heldAt||0]));}
  function valid(value){return !!(identity(value)&&value.version===2&&integer(value.seq)&&integer(value.ackSeq)&&value.ackSeq<=value.seq&&opaque(value.baseRevision)&&clock(value.clock)&&clock(value.baseClock)&&['','note','archive','save'].indexOf(value.blocked)>=0&&typeof value.revoked==='boolean'&&(value.held===null||/^rh-[a-f0-9]{32}$/.test(value.held||'')&&integer(value.heldAt))&&Array.isArray(value.journal)&&value.journal.length===value.seq-value.ackSeq&&value.journal.every(function(item,i){return item&&integer(item.seq)&&item.seq===value.ackSeq+i+1&&['pause','resume','finish','note'].indexOf(item.action)>=0&&integer(item.at)&&clock(item.clock);})&&(!value.journal.length||JSON.stringify(value.clock)===JSON.stringify(value.journal[value.journal.length-1].clock))&&value.revision===revision(value));}
  function result(record,ok,code){return {record:record,result:{ok:ok,code:code||'',state:record,head:head(record)}};}
  function transition(raw,request,now){
    if(raw!==null&&raw!==undefined&&!valid(raw))return {record:raw,result:{ok:false,code:'unreadable',state:raw,head:null}};
    var record=valid(raw)?JSON.parse(JSON.stringify(raw)):null;
    if(!request||!integer(now))return result(record,false,'invalid');
    if(request.type==='read')return result(record,true,'');
    if(request.type==='arm'){
      var s=request.snapshot;if(!identity(s)||!clock(s.clock)||!opaque(s.baseRevision)||['','note','archive','save'].indexOf(s.blocked)<0)return result(record,false,'invalid');
      if(record&&!matches(record,request.expected))return result(record,false,'conflict');
      if(record&&record.journal.length)return result(record,false,'pending');
      if(record&&record.revoked&&same(record,s))return result(record,false,'revoked');
      if(record&&record.held&&record.held!==request.lease&&now-record.heldAt<15000)return result(record,false,'held');
      var seq=record&&same(record,s)?record.seq:0;
      var intent=record&&same(record,s)?record.openIntent:null;
      record={version:2,ownerKey:s.ownerKey,timerId:s.timerId,bookId:s.bookId,generation:s.generation,seq:seq,ackSeq:seq,baseRevision:s.baseRevision,baseClock:copyClock(s.clock),clock:copyClock(s.clock),blocked:s.blocked,revoked:false,held:null,journal:[]};
      if(intent)record.openIntent=intent;
    }else{
      if(!record||!same(record,request.identity))return result(record,false,'missing');
      if(request.type==='ack'){
        if(!integer(request.throughSeq)||request.throughSeq>record.seq||!opaque(request.committedRevision))return result(record,false,'invalid');
        if(request.throughSeq<=record.ackSeq)return result(record,true,'acknowledged');
        var committed=record.journal.find(function(event){return event.seq===request.throughSeq;});if(!committed)return result(record,false,'invalid');
        record.baseClock=copyClock(committed.clock);record.ackSeq=request.throughSeq;record.baseRevision=request.committedRevision;record.journal=record.journal.filter(function(event){return event.seq>request.throughSeq;});
      }else if(request.type==='revoke'){
        if(request.expected&&!matches(record,request.expected))return result(record,false,'conflict');
        var at=integer(request.pauseAt)&&request.pauseAt<=now?request.pauseAt:now;
        if(request.pause===true&&!record.revoked&&(record.clock.running||record.journal.some(function(event){return event.at>at;}))){
          var paused=copyClock(record.baseClock);record.journal.forEach(function(event){if(event.at<=at)paused=copyClock(event.clock);});
          paused.elapsedMs=Math.min(Number.MAX_SAFE_INTEGER,paused.elapsedMs+(paused.running?Math.max(0,at-paused.startedAt):0));paused.running=false;paused.startedAt=null;
          record.clock=paused;record.seq++;record.journal.push({seq:record.seq,action:'pause',at:at,clock:copyClock(paused)});
        }
        record.revoked=true;record.held=null;
      }else if(request.type==='open-intent'){
        if(!matches(record,request.identity)||record.revoked||['open','save'].indexOf(request.action)<0||request.action==='save'&&record.clock.phase!=='save')return result(record,false,'stale');
        record.openIntent={at:now,action:request.action};
      }else if(request.type==='open-ack'){
        if(record.openIntent&&record.openIntent.at===request.at)delete record.openIntent;
      }else if(request.type==='hold'){
        if(!matches(record,request.expected))return result(record,false,'conflict');
        if(record.journal.length)return result(record,false,'pending');
        if(!/^rh-[a-f0-9]{32}$/.test(request.lease||''))return result(record,false,'invalid');
        if(record.held&&record.held!==request.lease&&now-record.heldAt<15000)return result(record,false,'held');
        record.held=request.lease;record.heldAt=now;
      }else if(request.type==='action'){
        if(!matches(record,request.identity))return result(record,false,'stale');
        if(record.revoked||record.held||record.blocked||record.clock.phase!=='timer')return result(record,false,'blocked');
        if(['pause','resume','finish'].indexOf(request.action)<0||request.action==='pause'&&!record.clock.running||request.action==='resume'&&record.clock.running)return result(record,false,'invalid');
        if(record.journal.length>=4096||record.seq>=Number.MAX_SAFE_INTEGER)return result(record,false,'full');
        var next=copyClock(record.clock);
        if(request.action==='resume'){next.running=true;next.startedAt=now;}
        else{next.elapsedMs=Math.min(Number.MAX_SAFE_INTEGER,next.elapsedMs+(next.running?Math.max(0,now-next.startedAt):0));next.running=false;next.startedAt=null;if(request.action==='finish')next.phase='save';}
        record.clock=next;record.seq++;var event={seq:record.seq,action:request.action,at:now,clock:copyClock(next)};
        record.journal.push(event);
      }else return result(record,false,'invalid');
    }
    record.revision=revision(record);return result(record,true,'');
  }
  return {book:book,hash:hash,opaque:opaque,identity:identity,clock:clock,head:head,same:same,matches:matches,valid:valid,transition:transition};
});
