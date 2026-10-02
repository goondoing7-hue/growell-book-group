(function(root, factory){
  var api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellHabits=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var DAY=86400000;
  var ALL_WEEKDAYS=[0,1,2,3,4,5,6],WEEKDAY_LABELS=['일','월','화','수','목','금','토'];
  function weekdays(habit){
    var value=habit&&habit.weekdays;
    if(value===undefined||value===null) return ALL_WEEKDAYS.slice();
    if(!Array.isArray(value)||value.some(function(day){return !Number.isInteger(day)||day<0||day>6;})) return [];
    return Array.from(new Set(value)).sort(function(a,b){return a-b;});
  }
  function scheduleLabel(habit){
    var selected=weekdays(habit);
    return selected.length===7?'매일':[1,2,3,4,5,6,0].filter(function(day){return selected.indexOf(day)>=0;}).map(function(day){return WEEKDAY_LABELS[day];}).join('·');
  }
  function behaviorType(habit){return habit&&habit.behaviorType==='avoid'?'avoid':'do';}
  function behaviorLabel(habit){return behaviorType(habit)==='avoid'?'절제할 습관':'실천할 습관';}
  function behaviorHint(habit){return behaviorType(habit)==='avoid'?'절제한 날을 성공으로 체크해요.':'실천한 날을 성공으로 체크해요.';}
  function validDate(value){
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var p=value.split('-').map(Number), leap=p[0]%4===0&&(p[0]%100!==0||p[0]%400===0);
    return p[0]>=1000 && p[1]>=1 && p[1]<=12 && p[2]>=1 && p[2]<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][p[1]-1];
  }
  function serial(value){return Date.parse(value+'T00:00:00Z')/DAY;}
  function weekday(value){return ((serial(value)+4)%7+7)%7;}
  function scheduled(habit,date){return validDate(date)&&weekdays(habit).indexOf(weekday(date))>=0;}
  function shift(value,days){return new Date((serial(value)+days)*DAY).toISOString().slice(0,10);}
  function days(a,b){return validDate(a)&&validDate(b)&&a<=b?serial(b)-serial(a)+1:0;}
  // Count full weeks arithmetically so an open-ended or long goal never walks every day.
  function scheduledDays(habit,from,to){
    var length=days(from,to),selected=weekdays(habit);
    if(!length||!selected.length) return 0;
    var count=Math.floor(length/7)*selected.length,remainder=length%7,first=weekday(from);
    for(var i=0;i<remainder;i++) if(selected.indexOf((first+i)%7)>=0) count++;
    return count;
  }
  function scheduledOnOrBefore(habit,date){
    var selected=weekdays(habit);
    if(!validDate(date)||!selected.length) return null;
    var last=weekday(date);
    for(var i=0;i<7;i++) if(selected.indexOf((last-i+7)%7)>=0) return shift(date,-i);
    return null;
  }
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
  function canCheck(h,date,today){return validDate(today)&&date<=today&&inPeriod(h,date,today)&&scheduled(h,date);}
  function status(h,date,today){
    var done=checked(h).indexOf(date)>=0;
    if(!inPeriod(h,date,today)||!scheduled(h,date)) return done&&date<=today?'saved':'outside';
    if(date>today) return 'future';
    if(done) return 'success';
    return date===today?'pending':'fail';
  }
  function rangeStats(h,today,from,to){
    var b=bounds(h,today), begin=from&&from>b.start?from:b.start, end=b.end&&b.end<today?b.end:today;
    if(to&&to<end) end=to;
    var eligible=scheduledDays(h,begin,end), dates=checked(h).filter(function(date){return date>=begin&&date<=end&&scheduled(h,date);}), success=dates.length;
    var pending=eligible>0&&end===today&&scheduled(h,today)&&dates.indexOf(today)<0?1:0, settled=Math.max(0,eligible-pending);
    return {success:success,fail:Math.max(0,settled-success),pending:pending,elapsed:eligible,settled:settled,rate:settled?Math.round(success/settled*100):null};
  }
  function stats(h,today){
    var b=bounds(h,today), summary=rangeStats(h,today), dates=checked(h).filter(function(date){return date>=b.start&&date<=today&&(!b.end||date<=b.end)&&scheduled(h,date);});
    var best=0, chain=0, previous=null;
    dates.forEach(function(date){chain=previous&&scheduledDays(h,previous,date)===2?chain+1:1;best=Math.max(best,chain);previous=date;});
    var cursor=scheduledOnOrBefore(h,b.end&&b.end<today?b.end:today);
    if(cursor===today&&dates.indexOf(cursor)<0) cursor=scheduledOnOrBefore(h,shift(cursor,-1));
    var streak=0,set=new Set(dates);
    while(cursor&&set.has(cursor)){streak++;cursor=scheduledOnOrBefore(h,shift(cursor,-1));}
    var total=b.end?scheduledDays(h,b.start,b.end):null, elapsed=summary.elapsed;
    var remaining=total===null?null:Math.max(0,total-elapsed+(summary.pending?1:0));
    return Object.assign(summary,{start:b.start,end:b.end,total:total,goalPercent:total?Math.round(summary.success/total*100):0,elapsedDays:elapsed,periodPercent:total?Math.round(elapsed/total*100):0,remaining:remaining,streak:streak,bestStreak:best,archivedSuccess:checked(h).filter(function(date){return date<=today&&(!inPeriod(h,date,today)||!scheduled(h,date));}).length});
  }
  function monthStats(h,today,year,month){var first=year+'-'+String(month+1).padStart(2,'0')+'-01',last=new Date(Date.UTC(year,month+1,0)).toISOString().slice(0,10);return rangeStats(h,today,first,last);}
  function overview(habits,today,weekStart){
    var result={total:0,active:0,upcoming:0,ended:0,todaySuccess:0,todayPending:0,weekSuccess:0,weekFail:0,weekPending:0,weekRate:null};
    (Array.isArray(habits)?habits:[]).forEach(function(habit){
      if(!habit) return;
      result.total++;
      var period=bounds(habit,today);
      if(today<period.start) result.upcoming++;
      else if(period.end&&today>period.end) result.ended++;
      else if(scheduled(habit,today)){
        result.active++;
        if(status(habit,today,today)==='success') result.todaySuccess++;
        else result.todayPending++;
      }
      var week=rangeStats(habit,today,weekStart,today);
      result.weekSuccess+=week.success;result.weekFail+=week.fail;result.weekPending+=week.pending;
    });
    var settled=result.weekSuccess+result.weekFail;
    result.weekRate=settled?Math.round(result.weekSuccess/settled*100):null;
    return result;
  }
  function validate(payload,today){
    var startDate=String(payload.startDate||'').trim()||today,endDate=String(payload.endDate||'').trim();
    if(!validDate(startDate)||endDate&&!validDate(endDate)) return {ok:false,msg:'시작일과 목표일을 올바른 날짜로 선택해주세요.'};
    if(endDate&&endDate<startDate) return {ok:false,msg:'목표일은 시작일보다 앞설 수 없어요.'};
    var selected=weekdays(payload);
    if(!selected.length) return {ok:false,msg:'실천할 요일을 하나 이상 선택해주세요.'};
    if(endDate&&!scheduledDays({weekdays:selected},startDate,endDate)) return {ok:false,msg:'선택한 요일이 목표 기간 안에 포함되도록 날짜나 요일을 바꿔주세요.'};
    return {ok:true,startDate:startDate,endDate:endDate,weekdays:selected};
  }
  function motivation(summary){
    if(summary.total && summary.success===summary.total) return '목표한 모든 날을 채웠어요. 나와의 약속을 지킨 시간을 기억해 주세요.';
    if(summary.remaining===0 && summary.end) return summary.success+'번의 실천이 쌓였어요. 다음 목표도 나의 속도로 이어가세요.';
    if(summary.streak>=3) return summary.streak+'일 연속 실천 중! 오늘의 작은 반복이 단단한 습관이 되고 있어요.';
    if(summary.success>0){var next=[3,7,14,21,30,50,100].find(function(n){return n>summary.success;})||Math.ceil((summary.success+1)/100)*100;if(summary.total) next=Math.min(next,summary.total);return '벌써 '+summary.success+'번 실천했어요. '+next+'번의 실천까지 '+(next-summary.success)+'번 남았어요.';}
    return '완벽한 시작보다 오늘 한 번의 실천이면 충분해요.';
  }
  return {behaviorType:behaviorType,behaviorLabel:behaviorLabel,behaviorHint:behaviorHint,weekdays:weekdays,scheduleLabel:scheduleLabel,scheduled:scheduled,scheduledDays:scheduledDays,validDate:validDate,todayDate:todayDate,shift:shift,days:days,checked:checked,start:start,bounds:bounds,inPeriod:inPeriod,canCheck:canCheck,status:status,stats:stats,monthStats:monthStats,overview:overview,validate:validate,motivation:motivation};
});
