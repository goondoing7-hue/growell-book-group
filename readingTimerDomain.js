(function(root,factory){
  var api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellReadingTimer=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function number(value){return typeof value==='number' && Number.isSafeInteger(value) && value>=0;}
  function identity(value){return typeof value==='string' && value.length>0 && value.length<=200 && value.trim()===value;}
  function object(value){return value && typeof value==='object' && !Array.isArray(value);}
  function normalized(raw,now){
    if(!object(raw) || !number(now) || !identity(raw.id) || !identity(raw.userId) || !identity(raw.bookId)) return null;
    if(!number(raw.elapsedMs) || typeof raw.running!=='boolean') return null;
    if(raw.startedAt!==null && raw.startedAt!==undefined && !number(raw.startedAt)) return null;
    if(raw.running && !number(raw.startedAt)) return null;
    var startPage=raw.startPage===undefined?0:raw.startPage;
    var createdAt=raw.createdAt===undefined?(number(raw.startedAt)?raw.startedAt:now):raw.createdAt;
    var targetMs=raw.targetMs===undefined?null:raw.targetMs;
    var goalReached=raw.goalReached===undefined?false:raw.goalReached;
    var phase=raw.phase===undefined?'timer':raw.phase;
    if(!number(startPage) || !number(createdAt) || (targetMs!==null && !number(targetMs))) return null;
    if(typeof goalReached!=='boolean' || (phase!=='timer' && phase!=='save')) return null;
    if(targetMs!==null && targetMs<raw.elapsedMs) return null;
    if(goalReached && (targetMs===null || raw.running || raw.elapsedMs!==targetMs)) return null;
    if(phase==='save' && raw.running) return null;
    return {id:raw.id,userId:raw.userId,bookId:raw.bookId,startPage:startPage,createdAt:createdAt,
      startedAt:raw.running?raw.startedAt:null,elapsedMs:raw.elapsedMs,running:raw.running,
      targetMs:targetMs,goalReached:goalReached,phase:phase};
  }
  function currentElapsed(timer,now){
    var increment=timer.running?Math.max(0,now-timer.startedAt):0;
    var total=Math.min(Number.MAX_SAFE_INTEGER,timer.elapsedMs+increment);
    return timer.targetMs===null?total:Math.min(total,timer.targetMs);
  }
  // All functions use the supplied millisecond clock and leave inputs untouched.
  // Invalid timer mutations return null; elapsed returns 0 for an invalid timer.
  function create(input,now){
    if(!object(input) || !number(now)) return null;
    var timer=normalized({id:input.id,userId:input.userId,bookId:input.bookId,
      startPage:input.startPage===undefined?0:input.startPage,
      createdAt:input.createdAt===undefined?now:input.createdAt,
      startedAt:input.running===false?null:now,
      elapsedMs:input.elapsedMs===undefined?0:input.elapsedMs,
      running:input.running===undefined?true:input.running,
      targetMs:input.targetMs===undefined?null:input.targetMs,
      goalReached:input.goalReached===undefined?false:input.goalReached,
      phase:input.phase===undefined?'timer':input.phase},now);
    return timer?settle(timer,now):null;
  }
  function elapsed(timer,now){
    var valid=normalized(timer,now);
    return valid?currentElapsed(valid,now):0;
  }
  function settle(timer,now){
    var next=normalized(timer,now);
    if(!next) return null;
    if(next.targetMs!==null && currentElapsed(next,now)>=next.targetMs){
      next.elapsedMs=next.targetMs;next.startedAt=null;next.running=false;next.goalReached=true;
    }
    return next;
  }
  function pause(timer,now){
    var next=settle(timer,now);
    if(!next) return null;
    next.elapsedMs=currentElapsed(next,now);next.startedAt=null;next.running=false;
    return next;
  }
  function resume(timer,now){
    var next=settle(timer,now);
    if(!next) return null;
    next.elapsedMs=currentElapsed(next,now);
    if(next.goalReached){next.targetMs=null;next.goalReached=false;}
    next.phase='timer';next.running=true;next.startedAt=now;
    return next;
  }
  function setCountdown(timer,durationMs,now){
    if(!number(durationMs) || durationMs===0) return null;
    var next=settle(timer,now);
    if(!next) return null;
    var accumulated=currentElapsed(next,now);
    if(!Number.isSafeInteger(accumulated+durationMs)) return null;
    next.elapsedMs=accumulated;next.startedAt=next.running?now:null;
    next.targetMs=accumulated+durationMs;next.goalReached=false;
    return next;
  }
  function clearCountdown(timer,now){
    var next=settle(timer,now);
    if(!next) return null;
    next.elapsedMs=currentElapsed(next,now);next.startedAt=next.running?now:null;
    next.targetMs=null;next.goalReached=false;
    return next;
  }
  function remaining(timer,now){
    var valid=normalized(timer,now);
    return !valid || valid.targetMs===null?null:Math.max(0,valid.targetMs-currentElapsed(valid,now));
  }
  function restore(raw,userId,bookIds,now){
    if(!identity(userId) || !number(now)) return null;
    if(typeof raw==='string'){
      if(raw.length>20000) return null;
      try{raw=JSON.parse(raw);}catch(error){return null;}
    }
    if(!object(raw) || raw.userId!==userId) return null;
    var allowed=Object.prototype.toString.call(bookIds)==='[object Set]'?Array.from(bookIds):bookIds;
    if(!Array.isArray(allowed) || allowed.indexOf(raw.bookId)<0) return null;
    var next=normalized(raw,now);
    if(!next) return null;
    // A backward-adjusted device clock must not make elapsed time negative or
    // leave the reader waiting until the former wall clock catches up.
    if(next.running && next.startedAt>now) next.startedAt=now;
    return settle(next,now);
  }
  function pageNumber(value){
    if(typeof value==='string'){
      var text=value.trim();
      if(!/^\d+$/.test(text)) return null;
      value=Number(text);
    }
    return number(value)?value:null;
  }
  function validatePages(start,end,total){
    var first=pageNumber(start),last=pageNumber(end);
    if(first===null) return {ok:false,error:'시작 쪽수는 0 이상의 정수로 입력해주세요.'};
    if(last===null) return {ok:false,error:'마지막 쪽수는 0 이상의 정수로 입력해주세요.'};
    var maximum=total===null || total===undefined?null:pageNumber(total);
    if(total!==null && total!==undefined && maximum===null) return {ok:false,error:'책의 전체 쪽수를 확인해주세요.'};
    if(maximum!==null && (first>maximum || last>maximum)) return {ok:false,error:'쪽수는 책의 전체 '+maximum+'쪽을 넘을 수 없어요.'};
    if(last<first) return {ok:false,error:'마지막 쪽수는 시작 쪽수보다 앞설 수 없어요.'};
    return {ok:true,page:last};
  }
  function pageProgress(start,end,total){
    var result=validatePages(start,end,total), maximum=pageNumber(total);
    if(!result.ok) return result;
    if(maximum===null) return {ok:false,error:'책의 전체 쪽수를 확인해주세요.'};
    return {ok:true,page:result.page,pagesRead:result.page-pageNumber(start),percent:maximum>0?Math.round(result.page/maximum*1000)/10:0};
  }
  function countdownDuration(hours,minutes){
    var h=pageNumber(hours),m=pageNumber(minutes);
    return h===null || m===null || h>23 || m>59 || h*60+m<1?null:(h*60+m)*60000;
  }
  function restoreNoteHandoff(raw,timer){
    if(!object(raw) || !timer || raw.timerId!==timer.id || raw.userId!==timer.userId || raw.bookId!==timer.bookId ||
      (raw.type!=='share' && raw.type!=='mine') || typeof raw.wasRunning!=='boolean' || timer.running || timer.phase!=='timer' || timer.goalReached) return null;
    return {timerId:raw.timerId,userId:raw.userId,bookId:raw.bookId,type:raw.type,wasRunning:raw.wasRunning};
  }
  function beginNote(timer,type,now){
    if(type!=='share' && type!=='mine') return null;
    var next=pause(timer,now);
    if(!next || next.goalReached || next.phase!=='timer') return null;
    return {timer:next,handoff:{timerId:next.id,userId:next.userId,bookId:next.bookId,type:type,wasRunning:timer.running}};
  }
  function finishNote(timer,handoff,now){
    var next=settle(timer,now),valid=restoreNoteHandoff(handoff,next);
    return valid?(valid.wasRunning?resume(next,now):next):null;
  }
  return {create:create,elapsed:elapsed,pause:pause,resume:resume,setCountdown:setCountdown,
    clearCountdown:clearCountdown,settle:settle,remaining:remaining,restore:restore,validatePages:validatePages,
    pageProgress:pageProgress,countdownDuration:countdownDuration,beginNote:beginNote,finishNote:finishNote,restoreNoteHandoff:restoreNoteHandoff};
});
