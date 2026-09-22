const test=require('node:test');
const assert=require('node:assert/strict');
const habits=require('../habitDomain.js');
const today='2026-09-22';
const sample=extra=>({id:'h1',userId:'u1',startDate:'2026-09-18',endDate:'2026-09-25',checkedDates:['2026-09-18','2026-09-20','2026-09-21'],...extra});

test('legacy habits default to doing; avoiding habits keep the same promise-kept success rule',()=>{
  assert.equal(habits.behaviorType({}),'do');assert.equal(habits.behaviorType({behaviorType:'unknown'}),'do');
  assert.equal(habits.behaviorLabel({behaviorType:'avoid'}),'하지 않는 습관');
  assert.match(habits.behaviorHint({behaviorType:'avoid'}),/하지 않고 지킨 날/);
  assert.deepEqual(habits.stats(sample({behaviorType:'avoid'}),today),habits.stats(sample({behaviorType:'do'}),today));
  assert.equal(habits.status(sample({behaviorType:'avoid'}),'2026-09-21',today),'success');
});

test('habit dates validate leap years, missing end dates and an inverted period',()=>{
  assert.equal(habits.validDate('2024-02-29'),true);
  assert.equal(habits.validDate('2026-02-29'),false);
  assert.equal(habits.validDate('2026-13-01'),false);
  assert.deepEqual(habits.validate({startDate:'',endDate:''},today),{ok:true,startDate:today,endDate:''});
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
