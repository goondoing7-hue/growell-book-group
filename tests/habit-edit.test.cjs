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

function cardHarness(){
  class Today extends Date{constructor(...args){super(...(args.length?args:[2026,8,22,12]));}}
  const c={Date:Today,GrowellHabits:require('../habitDomain.js'),habitSaveIntents:{},habitCalendarMode:'week',habitCalendarMonth:null,
    I_CAL:'',I_BACK:'',I_EDIT:'',I_CHECK:'',I_TRASH:'',svgIcon:()=>'<svg></svg>',
    esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function pad2('),source.indexOf('function habitFormHtml(')),c);
  return c;
}
test('habit card shows successes against the whole target period rather than elapsed days',()=>{
  const c=cardHarness(),h={id:'h1',name:'책 읽기',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-20','2026-09-21'],behaviorType:'do'};
  const html=c.habitCardHtml(h);
  assert.match(html,/성공 <strong>2일<\/strong> \/ 10일/);assert.match(html,/aria-valuenow="20"/);
  assert.match(html,/data-habit-today data-habit-day="h1\|2026-09-22" aria-pressed="false"/);
  assert.match(html,/<details class="habit-card-calendar"><summary>이번 주 기록 보기/);
  assert.deepEqual(h.checkedDates,['2026-09-20','2026-09-21']);
});
test('ongoing habits do not invent a goal percentage and ended or future habits cannot check today',()=>{
  const c=cardHarness(),ongoing={id:'h1',name:'계속 읽기',startDate:'2026-09-20',checkedDates:['2026-09-21']};
  assert.doesNotMatch(c.habitCardHtml(ongoing),/role="progressbar"/);
  assert.match(c.habitCardHtml(ongoing),/지금까지 <strong>1일 성공/);
  assert.equal(c.habitTodayState({...ongoing,startDate:'2026-10-01'},'2026-09-22').canCheck,false);
  assert.equal(c.habitTodayState({...ongoing,startDate:'2026-10-01'},'2026-09-22').label,'시작 전');
  assert.equal(c.habitTodayState({...ongoing,endDate:'2026-09-21'},'2026-09-22').canCheck,false);
  assert.match(c.habitCardHtml({...ongoing,endDate:'2026-09-21'}),/기간 종료" disabled/);
});
test('today success remains reversible for avoiding habits and month view opens the preserved calendar',()=>{
  const c=cardHarness(),h={id:'h1',name:'<화면 쉬기>',behaviorType:'avoid',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-21','2026-09-22']};
  const html=c.habitCardHtml(h);
  assert.match(html,/절제할 습관/);assert.match(html,/&lt;화면 쉬기&gt;/);assert.match(html,/aria-pressed="true"[^>]+다시 누르면 취소/);
  assert.match(html,/<strong>2일<\/strong> 연속 절제/);assert.equal(c.habitTodayState(h,'2026-09-22').canCheck,true);
  c.habitCalendarMode='month';c.habitHistoryCalendarHtml=()=>'<div>달력</div>';
  assert.match(c.habitCardHtml(h),/<details class="habit-card-calendar" open>/);
});
test('overview includes only the current owner across books and immediately reflects unsaved check intentions',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'ready'};
  c.STATE={habits:{
    mine:{id:'mine',userId:'owner',bookId:'emotion',name:'내 습관',startDate:'2026-09-22',checkedDates:[]},
    otherBook:{id:'otherBook',userId:'owner',bookId:'action',name:'다른 책 습관',startDate:'2026-09-22',checkedDates:[]},
    stranger:{id:'stranger',userId:'someone-else',bookId:'emotion',name:'타인 습관',startDate:'2026-09-22',checkedDates:['2026-09-22']}
  }};
  c.bookById=id=>({title:id==='action'?'행동 책':'감정 책'});
  c.habitSaveIntents={mine:{'2026-09-22':{checked:true,status:'saving'}}};
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function habitSaveStatusHtml(')),c);
  const html=c.habitOverviewBodyHtml();
  assert.match(html,/오늘 성공<\/span><strong>1<small> \/ 2개/);assert.match(html,/오늘 남음<\/span><strong>1<small>개/);
  assert.match(html,/다른 책 습관/);assert.match(html,/#\/book\/action\/habit/);assert.doesNotMatch(html,/타인 습관/);assert.match(html,/체크 저장 중/);
  assert.deepEqual(c.STATE.habits.mine.checkedDates,[]);
  c.habitSaveIntents.mine['2026-09-22'].status='error';assert.match(c.habitOverviewBodyHtml(),/저장하지 못한 체크/);
});
test('overview loading failures never turn stale habits into a current-state summary',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'error'};c.memberDataStatusHtml=()=>'<p>연결을 확인해주세요.</p>';
  c.STATE={habits:{stale:{userId:'owner',name:'오래된 습관'}}};
  const html=c.habitOverviewBodyHtml();assert.match(html,/전체 습관 한눈에/);assert.match(html,/연결을 확인/);assert.doesNotMatch(html,/오늘 성공|오래된 습관|오늘 남음/);
  c.memberLoadState.habits='loading';assert.equal(c.myHabitOverviewItems().length,0);
});
test('the weekly record area expands itself without opening statistics and leaves its controls alone',()=>{
  let cardClick,calendarClick,opens=0;
  const calendar={open:false,addEventListener(type,fn){calendarClick=fn;}};
  const card={addEventListener(type,fn){cardClick=fn;},getAttribute(){return 'mine';}};
  const c={app:{querySelectorAll:selector=>selector==='[data-habit-card]'?[card]:[calendar]},openHabitProgress(){opens++;}};
  vm.createContext(c);
  const begin=source.indexOf("  app.querySelectorAll('[data-habit-card]').forEach(function(card){card.addEventListener('click'");
  vm.runInContext(source.slice(begin,source.indexOf('  var openHabitBtn',begin)),c);
  const event=(kind)=>({target:{closest:selector=>kind==='calendar'?selector.includes('.habit-card-calendar'):kind==='control'?selector.includes('button'):kind==='summary'?selector.includes('summary'):false},stopPropagation(){}});
  calendarClick(event('calendar'));assert.equal(calendar.open,true);assert.equal(opens,0);
  cardClick(event('calendar'));assert.equal(opens,0);
  calendarClick(event('control'));assert.equal(calendar.open,true);assert.equal(opens,0);
  calendarClick(event('summary'));assert.equal(calendar.open,true);
  calendarClick(event('calendar'));assert.equal(calendar.open,false);
  cardClick(event('body'));assert.equal(opens,1);
});
