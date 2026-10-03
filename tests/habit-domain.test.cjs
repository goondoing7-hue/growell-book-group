const test=require('node:test');
const assert=require('node:assert/strict');
const habits=require('../habitDomain.js');
const today='2026-09-22';
const sample=extra=>({id:'h1',userId:'u1',startDate:'2026-09-18',endDate:'2026-09-25',checkedDates:['2026-09-18','2026-09-20','2026-09-21'],...extra});

test('legacy habits default to doing; avoiding habits keep the same promise-kept success rule',()=>{
  assert.equal(habits.behaviorType({}),'do');assert.equal(habits.behaviorType({behaviorType:'unknown'}),'do');
  assert.equal(habits.behaviorLabel({behaviorType:'avoid'}),'절제할 습관');
  assert.equal(habits.behaviorLabel({}),'실천할 습관');
  assert.match(habits.behaviorHint({behaviorType:'avoid'}),/절제한 날/);
  assert.deepEqual(habits.stats(sample({behaviorType:'avoid'}),today),habits.stats(sample({behaviorType:'do'}),today));
  assert.equal(habits.status(sample({behaviorType:'avoid'}),'2026-09-21',today),'success');
});

test('habit dates validate leap years, missing end dates and an inverted period',()=>{
  assert.equal(habits.validDate('2024-02-29'),true);
  assert.equal(habits.validDate('2026-02-29'),false);
  assert.equal(habits.validDate('2026-13-01'),false);
  assert.deepEqual(habits.validate({startDate:'',endDate:''},today),{ok:true,startDate:today,endDate:'',weekdays:[0,1,2,3,4,5,6]});
  assert.equal(habits.validate({startDate:'2026-09-23',endDate:today},today).ok,false);
  assert.equal(habits.validate({startDate:'2026-02-30'},today).ok,false);
});
test('today remains pending and future days do not lower success rate',()=>{
  const h=sample(),s=habits.stats(h,today);
  assert.equal(s.success,3);assert.equal(s.fail,1);assert.equal(s.pending,1);assert.equal(s.rate,75);
  assert.equal(s.total,8);assert.equal(s.goalPercent,38);assert.equal(s.periodPercent,63);assert.equal(s.remaining,4);
  assert.equal(habits.status(h,today,today),'pending');assert.equal(habits.status(h,'2026-09-23',today),'future');
  assert.equal(habits.canCheck(h,'2026-09-23',today),false);
});
test('checking today improves the rate and keeps chronological streaks correct',()=>{
  const s=habits.stats(sample({checkedDates:['2026-09-22','2026-09-21','2026-09-20','2026-09-18','2026-09-22']}),today);
  assert.equal(s.success,4);assert.equal(s.pending,0);assert.equal(s.rate,80);assert.equal(s.streak,3);assert.equal(s.bestStreak,3);assert.equal(s.remaining,3);
});
test('a completed period stops counting failures after the goal date',()=>{
  const s=habits.stats(sample({endDate:'2026-09-20'}),today);
  assert.equal(s.success,2);assert.equal(s.fail,1);assert.equal(s.elapsed,3);assert.equal(s.total,3);assert.equal(s.remaining,0);assert.equal(s.archivedSuccess,1);
  assert.equal(habits.status(sample({endDate:'2026-09-20'}),'2026-09-21',today),'saved');
});
test('editing the period keeps historical dates visible without inflating current progress',()=>{
  const h=Object.freeze(sample({startDate:'2026-09-21',checkedDates:Object.freeze(['2026-09-18','2026-09-20','2026-09-21','invalid'])}));
  const s=habits.stats(h,today);
  assert.equal(s.success,1);assert.equal(s.archivedSuccess,2);assert.equal(s.goalPercent,20);
  assert.equal(habits.status(h,'2026-09-18',today),'saved');assert.equal(habits.canCheck(h,'2026-09-18',today),false);
  assert.deepEqual(h.checkedDates,['2026-09-18','2026-09-20','2026-09-21','invalid']);
});
test('legacy habits use their existing creation date without rewriting stored records',()=>{
  const h=Object.freeze({createdAt:new Date(2026,8,20,13).getTime(),checkedDates:Object.freeze(['2026-09-20','2026-09-21'])});
  const s=habits.stats(h,today);assert.equal(s.start,'2026-09-20');assert.equal(s.total,null);assert.equal(s.success,2);assert.equal(s.rate,100);assert.equal(s.streak,2);
  assert.equal('startDate' in h,false);
});
test('a future habit has no failures and an empty denominator',()=>{
  const h=sample({startDate:'2026-10-01',endDate:'2026-10-31',checkedDates:[]});
  const s=habits.stats(h,today);assert.equal(s.fail,0);assert.equal(s.success,0);assert.equal(s.rate,null);assert.equal(s.remaining,31);assert.equal(s.periodPercent,0);
});
test('month summaries clip to both month and goal boundaries',()=>{
  const h=sample({startDate:'2026-08-30',endDate:'2026-09-03',checkedDates:['2026-08-31','2026-09-01','2026-09-03']});
  const august=habits.monthStats(h,today,2026,7),september=habits.monthStats(h,today,2026,8),october=habits.monthStats(h,today,2026,9);
  assert.equal(august.success,1);assert.equal(august.fail,1);assert.equal(september.success,2);assert.equal(september.fail,1);assert.equal(october.rate,null);
});
test('date arithmetic remains inclusive across leap day and year boundaries',()=>{
  assert.equal(habits.days('2024-02-28','2024-03-01'),3);
  assert.equal(habits.shift('2026-01-01',-1),'2025-12-31');
  assert.equal(habits.days('2026-03-07','2026-03-10'),4);
});
test('all-habit overview separates active, future and ended promises and weights weekly attempts',()=>{
  const list=[
    sample({id:'doing',startDate:'2026-09-20',endDate:'2026-10-10',checkedDates:['2026-09-21','2026-09-22']}),
    sample({id:'avoiding',behaviorType:'avoid',startDate:'2026-09-20',endDate:'',checkedDates:['2026-09-21']}),
    sample({id:'ended',startDate:'2026-09-20',endDate:'2026-09-21',checkedDates:['2026-09-20','2026-09-22']}),
    sample({id:'future',startDate:'2026-09-23',endDate:'2026-09-30',checkedDates:['2026-09-24']})
  ];
  assert.deepEqual(habits.overview(list,today,'2026-09-21'),{
    total:4,active:2,upcoming:1,ended:1,todaySuccess:1,todayPending:1,weekSuccess:3,weekFail:1,weekPending:1,weekRate:75
  });
});
test('an empty week or only unchecked first-day habits never display a made-up failure rate',()=>{
  const h=sample({startDate:today,checkedDates:[]});
  const result=habits.overview([h],today,'2026-09-21');
  assert.equal(result.todayPending,1);assert.equal(result.weekPending,1);assert.equal(result.weekRate,null);assert.equal(result.weekFail,0);
  assert.equal(habits.overview([],today,'2026-09-21').weekRate,null);
  assert.equal(habits.overview([sample({endDate:'2026-09-20'})],today,'2026-09-21').active,0);
});

test('weekday schedules normalize without mutating input and legacy records remain daily',()=>{
  const selected=Object.freeze([5,1,3,1]),h=Object.freeze({weekdays:selected});
  assert.deepEqual(habits.weekdays(h),[1,3,5]);
  assert.deepEqual(selected,[5,1,3,1]);
  assert.deepEqual(habits.weekdays({}),[0,1,2,3,4,5,6]);
  assert.deepEqual(habits.weekdays({weekdays:null}),[0,1,2,3,4,5,6]);
  assert.equal(habits.scheduleLabel({weekdays:[0,5,1]}),'월·금·일');
  assert.equal(habits.scheduleLabel({}),'매일');
  assert.equal(habits.scheduled(h,'2026-10-02'),true);
  assert.equal(habits.scheduled(h,'2026-10-03'),false);
  assert.equal(habits.scheduled(h,'2026-02-30'),false);
});

test('save validation rejects empty, malformed and impossible weekday periods',()=>{
  for(const weekdays of [[],[7],[-1],['1'],[1.5],[1,null],'1,3,5',{}]){
    assert.equal(habits.validate({weekdays},today).ok,false,JSON.stringify(weekdays));
    assert.deepEqual(habits.weekdays({weekdays}),[]);
  }
  assert.deepEqual(habits.validate({weekdays:[5,1,3,1]},today).weekdays,[1,3,5]);
  assert.equal(habits.validate({startDate:'2026-10-03',endDate:'2026-10-04',weekdays:[1]},today).ok,false);
  assert.equal(habits.validate({startDate:'2026-10-03',endDate:'2026-10-05',weekdays:[1]},today).ok,true);
  assert.equal(habits.validate({startDate:'2026-10-03',endDate:'',weekdays:[1]},today).ok,true);
});

test('weekday-only calendars leave skipped days outside and preserve historical checks as saved',()=>{
  const h=sample({startDate:'2026-09-28',endDate:'2026-10-09',weekdays:[1,3,5],checkedDates:['2026-09-28','2026-09-29','2026-09-30','2026-10-02']});
  assert.equal(habits.status(h,'2026-10-03','2026-10-04'),'outside');
  assert.equal(habits.status(h,'2026-09-29','2026-10-04'),'saved');
  assert.equal(habits.status(h,'2026-10-05','2026-10-04'),'future');
  assert.equal(habits.status(h,'2026-10-06','2026-10-04'),'outside');
  assert.equal(habits.canCheck(h,'2026-10-03','2026-10-04'),false);
  assert.equal(habits.canCheck(h,'2026-10-02','2026-10-04'),true);
  const s=habits.stats(h,'2026-10-04');
  assert.equal(s.success,3);assert.equal(s.archivedSuccess,1);assert.equal(s.fail,0);assert.equal(s.pending,0);
  assert.equal(s.elapsed,3);assert.equal(s.total,6);assert.equal(s.remaining,3);assert.equal(s.rate,100);assert.equal(s.goalPercent,50);
  assert.equal(s.streak,3);assert.equal(s.bestStreak,3);
});

test('streaks bridge weekends and only break on a missed selected day',()=>{
  const h=sample({startDate:'2026-09-28',endDate:'',weekdays:[1,3,5],checkedDates:['2026-09-28','2026-09-30','2026-10-02']});
  assert.equal(habits.stats(h,'2026-10-05').streak,3,'today may still be pending');
  assert.equal(habits.stats(h,'2026-10-05').pending,1);
  assert.equal(habits.stats(h,'2026-10-06').streak,0,'Monday is now a missed scheduled day');
  const restarted={...h,checkedDates:[...h.checkedDates,'2026-10-07','2026-10-09']};
  assert.equal(habits.stats(restarted,'2026-10-11').streak,2);
  assert.equal(habits.stats(restarted,'2026-10-11').bestStreak,3);
  assert.equal(habits.stats({...h,endDate:'2026-10-04'},'2026-10-11').streak,3,'closed period clips to Friday');
});

test('selected day denominators clip to month, year, future and goal boundaries',()=>{
  const h=sample({startDate:'2026-09-28',endDate:'2026-10-09',weekdays:[1,3,5],checkedDates:['2026-09-28','2026-09-30','2026-10-02']});
  const september=habits.monthStats(h,'2026-10-04',2026,8),october=habits.monthStats(h,'2026-10-04',2026,9);
  assert.equal(september.elapsed,2);assert.equal(september.success,2);assert.equal(september.rate,100);
  assert.equal(october.elapsed,1);assert.equal(october.success,1);assert.equal(october.pending,0);
  const future=habits.stats({...h,startDate:'2026-10-05',checkedDates:[]},'2026-10-04');
  assert.equal(future.elapsed,0);assert.equal(future.total,3);assert.equal(future.remaining,3);assert.equal(future.rate,null);
  assert.equal(habits.scheduledDays({weekdays:[1,3,5]},'2026-12-28','2027-01-03'),3);
  assert.equal(habits.scheduledDays({weekdays:[4]},'2024-02-28','2024-03-01'),1);
  assert.equal(habits.scheduledDays({},'1000-01-01','9999-12-31'),habits.days('1000-01-01','9999-12-31'));
  const longRange=habits.scheduledDays({weekdays:[1]},'1000-01-01','9999-12-31');
  assert.ok(longRange>=Math.floor(habits.days('1000-01-01','9999-12-31')/7));
  assert.ok(longRange<=Math.ceil(habits.days('1000-01-01','9999-12-31')/7));
});

test('overview keeps all created habits but today count and weekly attempts only include selected days',()=>{
  const records=[
    sample({id:'mwf',startDate:'2026-09-28',endDate:'2026-10-09',weekdays:[1,3,5],checkedDates:['2026-09-28','2026-09-30','2026-10-02']}),
    sample({id:'saturday',startDate:'2026-09-28',endDate:'2026-10-09',weekdays:[6],checkedDates:[]}),
    sample({id:'future',startDate:'2026-10-05',weekdays:[1],endDate:'',checkedDates:[]})
  ];
  const summary=habits.overview(records,'2026-10-03','2026-09-28');
  assert.equal(summary.total,3);assert.equal(summary.active,1);assert.equal(summary.todayPending,1);assert.equal(summary.todaySuccess,0);
  assert.equal(summary.upcoming,1);assert.equal(summary.weekSuccess,3);assert.equal(summary.weekFail,0);assert.equal(summary.weekPending,1);assert.equal(summary.weekRate,100);
  assert.equal(habits.overview(records,'2026-10-04','2026-09-28').active,0);
});

test('recent seven-day rate weights scheduled attempts and includes unfinished today',()=>{
  const day='2026-10-03',daily=sample({startDate:'2026-09-01',endDate:'',checkedDates:['2026-09-28','2026-10-01']});
  const weekly=sample({startDate:'2026-09-01',endDate:'',weekdays:[5],checkedDates:['2026-10-02']});
  assert.deepEqual(habits.recentOverview([daily,weekly],day),{
    from:'2026-09-27',to:day,success:3,scheduled:8,rate:38
  });
  assert.equal(habits.recentOverview([{...daily,checkedDates:[...daily.checkedDates,day]},weekly],day).rate,50);
  const firstDay=sample({startDate:day,endDate:'',checkedDates:[]});
  assert.equal(habits.recentOverview([firstDay],day).rate,0,'today is an eligible attempt, even before it is checked');
  assert.equal(habits.overview([firstDay],day,'2026-09-28').weekRate,null,'existing settled-day statistics keep their original meaning');
});

test('recent seven-day rate clips goal boundaries and excludes saved, future and duplicate checks',()=>{
  const records=Object.freeze([
    Object.freeze(sample({id:'ended',startDate:'2026-09-28',endDate:'2026-09-30',checkedDates:Object.freeze(['2026-09-27','2026-09-28','2026-09-28','2026-09-30','2026-10-01','2026-10-04'])})),
    Object.freeze(sample({id:'selected-days',startDate:'2026-09-29',endDate:'2026-10-05',weekdays:Object.freeze([1,3,5]),checkedDates:Object.freeze(['2026-09-28','2026-09-29','2026-09-30','2026-10-02','2026-10-05','invalid'])})),
    Object.freeze(sample({id:'upcoming',startDate:'2026-10-04',endDate:'2026-10-10',checkedDates:Object.freeze(['2026-10-04'])})),
    Object.freeze(sample({id:'old',startDate:'2026-09-01',endDate:'2026-09-26',checkedDates:Object.freeze(['2026-09-26'])})),
    null
  ]);
  const before=JSON.stringify(records);
  assert.deepEqual(habits.recentOverview(records,'2026-10-03'),{
    from:'2026-09-27',to:'2026-10-03',success:4,scheduled:5,rate:80
  });
  assert.equal(JSON.stringify(records),before,'statistics do not rewrite preserved check history');
});

test('recent seven-day rate stays unavailable without scheduled attempts and handles an invalid date',()=>{
  const day='2026-10-03',empty={from:'2026-09-27',to:day,success:0,scheduled:0,rate:null};
  assert.deepEqual(habits.recentOverview(undefined,day),empty);
  assert.deepEqual(habits.recentOverview([null,sample({startDate:day,endDate:'',weekdays:[1],checkedDates:[day]})],day),empty);
  assert.deepEqual(habits.recentOverview([sample()],'invalid'),{from:null,to:null,success:0,scheduled:0,rate:null});
});
