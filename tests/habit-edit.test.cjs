const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function harness(){
  const original={id:'h1',userId:'owner',bookId:'emotion',name:'이전 이름',place:'집',time:'밤',goal:'10분',startDate:'2026-09-01',endDate:'2026-09-30',checkedDates:['2026-09-01'],createdAt:123,compatibilityField:'preserved'};
  let mutation,saves=0;const toasts=[];
  const c={Date,GrowellHabits:require('../habitDomain.js'),SESSION:{userId:'owner'},STATE:{habits:{h1:original}},memberLoadState:{habits:'ready'},ymd:()=> '2026-09-22',showToast:(...args)=>toasts.push(args),saveState:fn=>{mutation=fn;saves++;},uid:()=> 'new-id',render(){}};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function validateHabitPeriod('),source.indexOf('function deleteHabit(')),c);
  return {c,original,toasts,apply:state=>mutation(state),saves:()=>saves};
}
const payload={name:'새 습관',place:'독서 의자',time:'21:00',goal:'매일 15분',startDate:'2026-09-10',endDate:'2026-10-09'};
test('editing uses latest queued checks and preserves ID, creation timestamp and existing fields',()=>{
  const h=harness();h.c.editHabit('h1',payload,null);
  const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
  assert.equal(latest.habits.h1.id,'h1');assert.equal(latest.habits.h1.createdAt,123);assert.equal(latest.habits.h1.compatibilityField,'preserved');
  assert.equal(latest.habits.h1.name,'새 습관');assert.equal(latest.habits.h1.place,'독서 의자');assert.equal(latest.habits.h1.endDate,'2026-10-09');assert.equal(h.original.name,'이전 이름');
});
test('failed or pending loading prevents edits and creation from overwriting saved records',()=>{
  const h=harness();h.c.memberLoadState.habits='error';h.c.editHabit('h1',payload,null);h.c.submitHabit('emotion',payload,null);
  assert.equal(h.saves(),0);assert.equal(h.toasts.length,2);assert.equal(h.original.name,'이전 이름');
});
test('editing a different owner and invalid dates never enqueue a save',()=>{
  const h=harness();h.c.SESSION.userId='someone-else';h.c.editHabit('h1',payload,null);assert.equal(h.saves(),0);
  h.c.SESSION.userId='owner';h.c.editHabit('h1',{...payload,endDate:'2026-02-30'},null);assert.equal(h.saves(),0);
});
test('new habit writes only the existing compatible habit fields',()=>{
  const h=harness();h.c.submitHabit('emotion',payload,null);const next={habits:{}};h.apply(next);
  assert.equal(next.habits['new-id'].userId,'owner');assert.equal(next.habits['new-id'].startDate,payload.startDate);assert.equal(next.habits['new-id'].time,'21:00');assert.equal(next.habits['new-id'].checkedDates.length,0);
  assert.equal(next.habits['new-id'].behaviorType,'do');
});

test('avoiding kind is created and edited without changing existing check records',()=>{
  const h=harness();h.c.submitHabit('emotion',{...payload,behaviorType:'avoid'},null);const next={habits:{}};h.apply(next);
  assert.equal(next.habits['new-id'].behaviorType,'avoid');
  h.c.editHabit('h1',{...payload,behaviorType:'avoid'},null);const latest=structuredClone(h.c.STATE);latest.habits.h1.checkedDates.push('2026-09-22');h.apply(latest);
  assert.equal(latest.habits.h1.behaviorType,'avoid');assert.deepEqual(Array.from(latest.habits.h1.checkedDates),['2026-09-01','2026-09-22']);
});
test('a legacy edit without kind does not reset a newer queued kind change',()=>{
  const h=harness();h.c.editHabit('h1',payload,null);const latest=structuredClone(h.c.STATE);latest.habits.h1.behaviorType='avoid';h.apply(latest);
  assert.equal(latest.habits.h1.behaviorType,'avoid');
});
test('habit server round trip retains kind and reads older rows as doing',()=>{
  const c={};vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function mapHabitRow('),source.indexOf('\nvar STATE =')),c);
  vm.runInContext(source.slice(source.indexOf('var GENERIC_COLLECTIONS ='),source.indexOf('function diffDict(')),c);
  const old={id:'h1',book_id:'emotion',user_id:'owner',checked_dates:['2026-09-22']};
  assert.equal(c.mapHabitRow(old).behaviorType,'do');
  const mapped=c.mapHabitRow({...old,behavior_type:'avoid'}),row=c.GENERIC_COLLECTIONS.habits.toRow(mapped);
  assert.equal(row.behavior_type,'avoid');assert.equal(row.id,'h1');assert.deepEqual(Array.from(row.checked_dates),['2026-09-22']);
});
