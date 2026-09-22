(function(root, factory){
  var api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellHabits=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var DAY=86400000;
  function behaviorType(habit){return habit&&habit.behaviorType==='avoid'?'avoid':'do';}
  function behaviorLabel(habit){return behaviorType(habit)==='avoid'?'하지 않는 습관':'하는 습관';}
  function behaviorHint(habit){return behaviorType(habit)==='avoid'?'하지 않고 지킨 날을 성공으로 체크해요.':'실천한 날을 성공으로 체크해요.';}
  function validDate(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var p=value.split('-').map(Number), leap=p[0]%4===0&&(p[0]%100!==0||p[0]%400===0);
    return p[0]>=1000 && p[1]>=1 && p[1]<=12 && p[2]>=1 && p[2]<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][p[1]-1];
  }
  function serial(value){return Date.parse(value+'T00:00:00Z')/DAY;}
  function shift(value,days){return new Date((serial(value)+days)*DAY).toISOString().slice(0,10);}
  function days(a,b){return validDate(a)&&validDate(b)&&a<=b?serial(b)-serial(a)+1:0;}
  function todayDate(now){var d=now instanceof Date?now:new Date(now===undefined?Date.now():now);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function checked(h){return Array.from(new Set((Array.isArray(h.checkedDates)?h.checkedDates:[]).filter(validDate))).sort();}
  function start(h,today){
    if(validDate(h.startDate)) return h.startDate;
    var raw=h.createdAt, date=new Date(typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):raw);
    if(raw!==null && raw!==undefined && Number.isFinite(date.getTime())) return todayDate(date);
    return checked(h)[0]||today;
  }
  function bounds(h,today){return {start:start(h,today),end:validDate(h.endDate)?h.endDate:null};}
  function inPeriod(h,date,today){var b=bounds(h,today);return validDate(date)&&date>=b.start&&(!b.end||date<=b.end);}
  function canCheck(h,date,today){return validDate(today)&&date<=today&&inPeriod(h,date,today);}
  function status(h,date,today){
    var done=checked(h).indexOf(date)>=0;
    if(!inPeriod(h,date,today)) return done&&date<=today?'saved':'outside';
    if(date>today) return 'future';
    if(done) return 'success';
    return date===today?'pending':'fail';
  }
  function rangeStats(h,today,from,to){
    var b=bounds(h,today), begin=from&&from>b.start?from:b.start, end=b.end&&b.end<today?b.end:today;
    if(to&&to<end) end=to;
    var eligible=days(begin,end), dates=checked(h).filter(function(date){return date>=begin&&date<=end;}), success=dates.length;
    var pending=eligible>0&&end===today&&dates.indexOf(today)<0?1:0, settled=Math.max(0,eligible-pending);
    return {success:success,fail:Math.max(0,settled-success),pending:pending,elapsed:eligible,settled:settled,rate:settled?Math.round(success/settled*100):null};
  }
  function stats(h,today){
    var b=bounds(h,today), summary=rangeStats(h,today), dates=checked(h).filter(function(date){return date>=b.start&&date<=today&&(!b.end||date<=b.end);});
    var best=0, chain=0, previous=null;
    dates.forEach(function(date){chain=previous&&days(previous,date)===2?chain+1:1;best=Math.max(best,chain);previous=date;});
    var cursor=b.end&&b.end<today?b.end:today;
    if(dates.indexOf(cursor)<0&&cursor===today) cursor=shift(cursor,-1);
    var streak=0,set=new Set(dates);
    while(set.has(cursor)){streak++;cursor=shift(cursor,-1);}
    var total=b.end?days(b.start,b.end):null, elapsed=total===null?summary.elapsed:Math.min(total,days(b.start,today));
    var remaining=total===null?null:Math.max(0,total-elapsed+(summary.pending?1:0));
    return Object.assign(summary,{start:b.start,end:b.end,total:total,goalPercent:total?Math.round(summary.success/total*100):0,elapsedDays:elapsed,periodPercent:total?Math.round(elapsed/total*100):0,remaining:remaining,streak:streak,bestStreak:best,archivedSuccess:checked(h).filter(function(date){return date<=today&&!inPeriod(h,date,today);}).length});
  }
  function monthStats(h,today,year,month){var first=year+'-'+String(month+1).padStart(2,'0')+'-01',last=new Date(Date.UTC(year,month+1,0)).toISOString().slice(0,10);return rangeStats(h,today,first,last);}
  function validate(payload,today){
    var startDate=String(payload.startDate||'').trim()||today,endDate=String(payload.endDate||'').trim();
    if(!validDate(startDate)||endDate&&!validDate(endDate)) return {ok:false,msg:'시작일과 목표일을 올바른 날짜로 선택해주세요.'};
    if(endDate&&endDate<startDate) return {ok:false,msg:'목표일은 시작일보다 앞설 수 없어요.'};
    return {ok:true,startDate:startDate,endDate:endDate};
  }
  function motivation(summary){
    if(summary.total && summary.success===summary.total) return '목표한 모든 날을 채웠어요. 나와의 약속을 지킨 시간을 기억해 주세요.';
    if(summary.remaining===0 && summary.end) return summary.success+'번의 실천이 쌓였어요. 다음 목표도 나의 속도로 이어가세요.';
    if(summary.streak>=3) return summary.streak+'일 연속 실천 중! 오늘의 작은 반복이 단단한 습관이 되고 있어요.';
    if(summary.success>0){var next=[3,7,14,21,30,50,100].find(function(n){return n>summary.success;})||Math.ceil((summary.success+1)/100)*100;if(summary.total) next=Math.min(next,summary.total);return '벌써 '+summary.success+'번 실천했어요. '+next+'번의 실천까지 '+(next-summary.success)+'번 남았어요.';}
    return '완벽한 시작보다 오늘 한 번의 실천이면 충분해요.';
  }
  return {behaviorType:behaviorType,behaviorLabel:behaviorLabel,behaviorHint:behaviorHint,validDate:validDate,todayDate:todayDate,shift:shift,days:days,checked:checked,start:start,bounds:bounds,inPeriod:inPeriod,canCheck:canCheck,status:status,stats:stats,monthStats:monthStats,validate:validate,motivation:motivation};
});
