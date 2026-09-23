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
  const c={Date:Today,GrowellHabits:require('../habitDomain.js'),habitSaveIntents:{},habitHistoryView:'progress',habitHistoryMonth:null,
    I_CAL:'',I_BACK:'',I_EDIT:'',I_CHECK:'',I_TRASH:'',I_CLOSE:'',svgIcon:()=>'<svg></svg>',
    esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function pad2('),source.indexOf('function habitFormHtml(')),c);
  return c;
}
test('habit card shows successes against the whole target period rather than elapsed days',()=>{
  const c=cardHarness(),h={id:'h1',name:'책 읽기',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-20','2026-09-21'],behaviorType:'do'};
  const html=c.habitCardHtml(h);
  assert.match(html,/성공 <strong>2일<\/strong> \/ 10일/);assert.match(html,/aria-valuenow="20"/);
  assert.match(html,/data-habit-today data-habit-day="h1\|2026-09-22" aria-pressed="false"/);
  assert.match(html,/<span data-habit-today-label>성공<\/span>/);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="week" aria-haspopup="dialog"/);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="month" aria-haspopup="dialog"/);
  assert.match(html,/habit-detail-arrow" data-habit-history="h1"/);
  assert.doesNotMatch(html,/<details|data-habit-view=|habit-week-grid|habit-hist-grid/);
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
test('today success remains reversible for avoiding habits alongside their own record buttons',()=>{
  const c=cardHarness(),h={id:'h1',name:'<화면 쉬기>',behaviorType:'avoid',startDate:'2026-09-20',endDate:'2026-09-29',checkedDates:['2026-09-21','2026-09-22']};
  const html=c.habitCardHtml(h);
  assert.match(html,/절제할 습관/);assert.match(html,/&lt;화면 쉬기&gt;/);assert.match(html,/aria-pressed="true"[^>]+다시 누르면 취소/);
  assert.match(html,/<strong>2일<\/strong> 연속 절제/);assert.equal(c.habitTodayState(h,'2026-09-22').canCheck,true);
  assert.match(html,/data-habit-record="h1" data-habit-record-view="month"/);
  assert.match(c.habitCardHtml({...h,id:'h2'}),/data-habit-record="h2" data-habit-record-view="week"/);
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
  assert.match(html,/다른 책 습관/);assert.match(html,/data-habit-overview-open="otherBook"/);assert.doesNotMatch(html,/타인 습관/);assert.match(html,/체크 저장 중/);
  assert.match(html,/data-habit-overview-day="mine\|2026-09-22" aria-pressed="true"[^>]*다시 누르면 취소/);
  assert.match(html,/<\/button><button type="button" class="habit-overview-toggle/);
  assert.match(html,/class="habit-overview-toggle[^>]*>[\s\S]*?<span>성공<\/span><\/button>/);
  assert.doesNotMatch(html,/<a class="habit-overview-item"/);
  assert.deepEqual(c.STATE.habits.mine.checkedDates,[]);
  c.habitSaveIntents.mine['2026-09-22'].status='error';assert.match(c.habitOverviewBodyHtml(),/저장하지 못한 체크/);
});
test('overview loading failures never turn stale habits into a current-state summary',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'error'};c.memberDataStatusHtml=()=>'<p>연결을 확인해주세요.</p>';
  c.STATE={habits:{stale:{userId:'owner',name:'오래된 습관'}}};
  const html=c.habitOverviewBodyHtml();assert.match(html,/전체 습관 한눈에/);assert.match(html,/연결을 확인/);assert.doesNotMatch(html,/오늘 성공|오래된 습관|오늘 남음/);
  c.memberLoadState.habits='loading';assert.equal(c.myHabitOverviewItems().length,0);
});
test('overview keeps habit order and its save-status slot through rapid undo, recheck and asynchronous saves',async()=>{
  const c=cardHarness(),today='2026-09-22',saves=[];
  const habit=(id,createdAt,extra={})=>({id,createdAt,userId:'owner',bookId:'emotion',name:id,startDate:'2026-09-01',checkedDates:[],...extra});
  Object.assign(c,{SESSION:{userId:'owner'},memberLoadState:{habits:'ready'},habitSaveVersion:0,saveSessionEpoch:0,
    bookById:()=>({title:'테스트 책'}),STATE:{habits:{
      upcoming:habit('upcoming',1,{startDate:'2026-10-01'}),
      second:habit('second',20),
      ended:habit('ended',0,{endDate:'2026-09-20'}),
      first:habit('first',10,{checkedDates:[today]}),
      stranger:habit('stranger',2,{userId:'someone-else'})
    }},
    saveState(mutate,options){return new Promise(resolve=>saves.push({mutate,options,resolve}));}
  });
  const begin=source.indexOf('function habitWithPendingChecks(');
  vm.runInContext(source.slice(begin,source.indexOf('/* ---------------- 나의 공간: 독서 진행률',begin)),c);
  const panel={innerHTML:c.habitOverviewBodyHtml()};
  c.document={activeElement:null,querySelectorAll:selector=>selector==='[data-habit-overview]'?[panel]:[]};
  function verify(firstChecked,secondChecked,status){
    const html=panel.innerHTML;
    assert.deepEqual(Array.from(html.matchAll(/data-habit-overview-id="([^"]+)"/g),match=>match[1]),['first','second','upcoming','ended']);
    assert.match(html,new RegExp('data-habit-overview-day="first\\|'+today+'" aria-pressed="'+firstChecked+'"'));
    assert.match(html,new RegExp('data-habit-overview-day="second\\|'+today+'" aria-pressed="'+secondChecked+'"'));
    const saveSlot=html.match(/<p class="habit-overview-save"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(saveSlot,'idle, pending and completed views retain the same save-status slot');
    if(status==='saving')assert.match(saveSlot[1],/체크 저장 중/);
    else if(status==='error')assert.match(saveSlot[1],/저장하지 못한 체크/);
    else assert.doesNotMatch(saveSlot[1],/체크 저장 중|저장하지 못한 체크/);
  }
  function finish(index,ok=true){
    const saved=saves[index];
    if(ok){saved.mutate(c.STATE);saved.options.onSuccess();}else saved.options.onFailure();
    saved.resolve(ok);
  }
  verify(true,false,'idle');
  const undo=c.queueHabitCheck('first',today,false);verify(false,false,'saving');
  const recheck=c.queueHabitCheck('first',today,true);verify(true,false,'saving');
  finish(0);await undo;verify(true,false,'saving');
  finish(1);await recheck;verify(true,false,'idle');
  const checkSecond=c.queueHabitCheck('second',today,true);verify(true,true,'saving');
  finish(2);await checkSecond;verify(true,true,'idle');
  const undoSecond=c.queueHabitCheck('second',today,false);verify(true,false,'saving');
  finish(3,false);await undoSecond;verify(true,false,'error');
  const retry=c.retryHabitChecks('second');verify(true,false,'saving');
  finish(4);await retry;verify(true,false,'idle');
  assert.deepEqual(Array.from(c.STATE.habits.first.checkedDates),[today]);
  assert.deepEqual(Array.from(c.STATE.habits.second.checkedDates),[]);
});

test('each record button opens its own habit and selected popup without bubbling into progress details',()=>{
  const opened=[],buttons=['h1','h2'].flatMap(id=>['week','month'].map(view=>({
    getAttribute:attr=>attr==='data-habit-record'?id:view,addEventListener(type,fn){this.click=fn;}
  })));
  const card={addEventListener(type,fn){this.click=fn;},getAttribute:()=> 'h2'};
  const c={app:{querySelectorAll:selector=>selector==='[data-habit-record]'?buttons:[card]},openHabitProgress:(...args)=>opened.push(args)};
  vm.createContext(c);
  const begin=source.indexOf("  app.querySelectorAll('[data-habit-record]').forEach");
  vm.runInContext(source.slice(begin,source.indexOf('  var openHabitBtn',begin)),c);
  for(const button of buttons){
    const event={stopped:false,stopPropagation(){this.stopped=true;},target:{closest:()=>button}};
    button.click(event);if(!event.stopped)card.click(event);assert.equal(event.stopped,true);
  }
  card.click({target:{closest:()=>null}});
  card.click({target:{closest:()=>buttons[0]}});
  assert.deepEqual(opened,[['h1','card','week'],['h1','card','month'],['h2','card','week'],['h2','card','month'],['h2']]);
});

test('checking and undoing a replaced popup day icon stops propagation and binds only once',()=>{
  let dayClick,checks=0,bindings=0;
  const button={getAttribute:()=> 'h2|2026-09-22',addEventListener(type,fn){dayClick=fn;bindings++;}};
  const c={app:{querySelectorAll:()=>[button]},toggleHabitDate(id,date){assert.equal(id,'h2');assert.equal(date,'2026-09-22');checks++;}};
  vm.createContext(c);
  const begin=source.indexOf('function bindHabitDayEvents(');
  vm.runInContext(source.slice(begin,source.indexOf('function openHabitProgress(',begin)),c);
  c.bindHabitDayEvents(c.app);c.bindHabitDayEvents(c.app);
  for(let attempt=0;attempt<2;attempt++){
    const event={stopped:false,target:{closest:()=>null},stopPropagation(){this.stopped=true;}};
    dayClick(event);assert.equal(event.stopped,true);
  }
  assert.equal(checks,2);assert.equal(bindings,1);
});

test('overview delegation keeps success reversible after rows refresh and routes other clicks to details',()=>{
  const c=cardHarness(),events=[],bindings=[];
  const panel={_habitOverviewBound:false,contains:()=>true,addEventListener(type,fn){bindings.push(fn);}};
  c.toggleHabitDate=(id,date)=>events.push(['toggle',id,date]);c.openHabitProgress=(...args)=>events.push(['detail',...args]);
  const root={querySelectorAll:()=>[panel]};c.bindHabitOverviewEvents(root);c.bindHabitOverviewEvents(root);
  assert.equal(bindings.length,1);
  const eventFor=(kind,disabled=false)=>({stopped:false,stopPropagation(){this.stopped=true;},target:{closest(selector){
    if(selector==='[data-habit-overview-day]'&&kind==='day')return {disabled,getAttribute:()=> 'h1|2026-09-22'};
    if(selector==='[data-habit-overview-open]'&&kind==='detail')return {getAttribute:()=> 'other-book'};
    if(selector==='[data-habit-overview-id]'&&kind==='space')return {getAttribute:()=> 'other-book'};
    return null;
  }}});
  bindings[0](eventFor('day'));bindings[0](eventFor('day'));bindings[0](eventFor('day',true));
  bindings[0](eventFor('detail'));bindings[0](eventFor('space'));
  assert.deepEqual(events,[['toggle','h1','2026-09-22'],['toggle','h1','2026-09-22'],['detail','other-book','overview'],['detail','other-book','overview']]);
});

test('overview detail opens another book habit without exposing another member records',()=>{
  const c=cardHarness();c.SESSION={userId:'owner'};c.memberLoadState={habits:'ready'};c.habitEditingId=null;c.habitFormOpenFor=null;c.habitHistoryOpenFor='other-book';
  c.myHabits=()=>[];c.myHabitOverviewItems=()=>[{id:'other-book',userId:'owner',bookId:'action',name:'다른 책 습관'}];
  c.habitOverviewHtml=()=>'';c.habitHistoryModalHtml=habit=>'<dialog>'+habit.name+'</dialog>';
  const begin=source.indexOf('function habitsSectionHtml(');
  vm.runInContext(source.slice(begin,source.indexOf('function habitTabHtml(',begin)),c);
  assert.match(c.habitsSectionHtml({id:'emotion'}),/<dialog>다른 책 습관<\/dialog>/);
  c.habitHistoryOpenFor='stranger';assert.doesNotMatch(c.habitsSectionHtml({id:'emotion'}),/<dialog>/);assert.equal(c.habitHistoryOpenFor,null);
});

function popupHarness(){
  const c=cardHarness();
  Object.assign(c,{SESSION:{userId:'owner'},habitHistoryOpenFor:null,habitProgressReturnTarget:null,habitProgressReturnPosition:null,
    STATE:{habits:{
      h1:{id:'h1',userId:'owner',name:'책 읽기',startDate:'2026-09-01',checkedDates:['2026-09-21']},
      h2:{id:'h2',userId:'owner',name:'화면 쉬기',behaviorType:'avoid',startDate:'2026-09-01',checkedDates:[]},
      stranger:{id:'stranger',userId:'someone-else',name:'다른 회원 기록',startDate:'2026-09-01',checkedDates:[]}
    }}});
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function queueHabitCheck(')),c);
  vm.runInContext(source.slice(source.indexOf('function parseYmd('),source.indexOf('/* ---------------- 습관 완료 카드 이미지 생성')),c);
  const listeners={},entries=[{url:'https://example.test/#/book/emotion/mine',state:null}],pending=[];
  let index=0;
  const emit=(type,event)=>(listeners[type]||[]).slice().forEach(fn=>fn(event));
  const browser={location:{href:entries[0].url},scrollX:0,scrollY:0,
    addEventListener(type,fn){(listeners[type]||=[]).push(fn);},
    scrollTo(position){this.scrollX=position.left;this.scrollY=position.top;},
    history:{
      get state(){return entries[index].state;},
      replaceState(state,unused,url){entries[index]={state,url};browser.location.href=url;},
      pushState(state,unused,url){entries.splice(index+1);entries.push({state,url});index++;browser.location.href=url;},
      go(delta){pending.push(delta);}
    }
  };
  c.window=browser;c.location=browser.location;c.document={activeElement:null};
  c.GrowellPopupHistory=require('../popupHistory.js')(browser);
  function navigate(hash){
    browser.history.pushState(null,'','https://example.test/'+hash);
    emit('popstate',{state:null});emit('hashchange',{});
  }
  function back(){
    browser.history.go(-1);let traversals=0;
    while(pending.length){
      assert.ok(++traversals<20,'history traversal must settle');
      const next=index+pending.shift();if(next<0||next>=entries.length)continue;
      const previous=browser.location.href;index=next;browser.location.href=entries[index].url;
      emit('popstate',{state:entries[index].state});if(previous!==browser.location.href)emit('hashchange',{});
    }
  }
  const buttons=['h1','h2'].flatMap(id=>['week','month'].map(view=>({
    getAttribute:attr=>attr==='data-habit-record'?id:attr==='data-habit-record-view'?view:null,
    hasAttribute:attr=>attr==='data-habit-record',
    focus(options){assert.equal(options.preventScroll,true);c.document.activeElement=this;}
  })));
  const modal={focus(options){assert.equal(options.preventScroll,true);c.document.activeElement=this;}};
  let html='',renders=0;
  c.app={querySelector:selector=>selector==='.habit-hist-modal'&&c.habitHistoryOpenFor?modal:null,
    querySelectorAll:selector=>selector==='[data-habit-record]'?buttons:[]};
  const bindingStart=source.indexOf("  if(typeof GrowellPopupHistory!=='undefined'){",source.indexOf('  var histNext ='));
  const binding=source.slice(bindingStart,source.indexOf('  /* 나의 공간 독서 진행률',bindingStart));
  c.render=()=>{
    renders++;html=c.habitHistoryOpenFor?c.habitHistoryModalHtml(c.habitWithPendingChecks(c.STATE.habits[c.habitHistoryOpenFor])):'';
    vm.runInContext(binding,c);
  };
  navigate('#/book/emotion/habit');
  return {c,browser,buttons,modal,entries,back,navigate,get html(){return html;},get renders(){return renders;}};
}

test('week and month popups show only the selected habit and keep the progress detail available',()=>{
  const h=popupHarness(),c=h.c;
  c.habitSaveIntents.h2={'2026-09-22':{checked:true,status:'saving'}};
  c.openHabitProgress('h2','card','week');
  assert.equal(c.habitHistoryOpenFor,'h2');assert.equal(c.habitHistoryView,'week');
  assert.match(h.html,/habit-dialog-title">화면 쉬기/);assert.match(h.html,/data-habit-week-progress="h2">1\/7일 절제/);
  assert.match(h.html,/data-habit-day="h2\|2026-09-22"/);assert.match(h.html,/체크 저장 중/);
  assert.doesNotMatch(h.html,/data-habit-day="h1\||data-habit-history-calendar|data-habit-stats-panel/);
  c.closeHabitProgress();c.openHabitProgress('h1','card','month');
  assert.equal(c.habitHistoryView,'month');assert.match(h.html,/habit-dialog-title">책 읽기/);
  assert.match(h.html,/data-habit-history-calendar/);assert.match(h.html,/data-habit-day="h1\|2026-09-21"/);
  assert.doesNotMatch(h.html,/data-habit-day="h2\||habit-week-grid|data-habit-stats-panel/);
  c.closeHabitProgress();c.openHabitProgress('h1');
  assert.equal(c.habitHistoryView,'progress');assert.match(h.html,/data-habit-stats-panel="h1"/);
  assert.match(h.html,/data-habit-history-calendar/);
});

test('record popup opening rejects missing habits, other owners and signed-out access',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('stranger','card','month');c.openHabitProgress('missing','card','week');
  c.SESSION=null;c.openHabitProgress('h1','card','week');
  assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.html,'');assert.equal(h.renders,0);
  assert.equal(h.entries.length,2);
});

test('browser Back closes each record popup on the same habit screen and restores its exact button and scroll',()=>{
  for(const view of ['week','month']){
    const h=popupHarness(),c=h.c,trigger=h.buttons.find(button=>button.getAttribute('data-habit-record')==='h2'&&button.getAttribute('data-habit-record-view')===view);
    h.browser.scrollX=8;h.browser.scrollY=1125;c.document.activeElement=trigger;
    c.openHabitProgress('h2','card',view);assert.equal(c.document.activeElement,h.modal);
    const historySize=h.entries.length;c.render();assert.equal(h.entries.length,historySize,'rerender must not add another Back step');
    h.browser.scrollX=0;h.browser.scrollY=100;h.back();
    assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.html,'');
    assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
    assert.equal(c.document.activeElement,trigger);assert.equal(h.browser.scrollX,8);assert.equal(h.browser.scrollY,1125);
    h.back();assert.match(h.browser.location.href,/#\/book\/emotion\/mine$/);
  }
});

test('explicit close then opening another habit keeps Back targeted at the latest popup',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('h1','card','week');c.closeHabitProgress();
  const historySize=h.entries.length;h.browser.scrollY=640;
  c.openHabitProgress('h2','card','month');assert.equal(h.entries.length,historySize);
  h.back();assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.browser.scrollY,640);
  assert.equal(c.document.activeElement,h.buttons.find(button=>button.getAttribute('data-habit-record')==='h2'&&button.getAttribute('data-habit-record-view')==='month'));
  assert.match(h.browser.location.href,/#\/book\/emotion\/habit$/);
});

test('leaving the habit route closes its popup without restoring the old page scroll',()=>{
  const h=popupHarness(),c=h.c;h.browser.scrollY=850;c.openHabitProgress('h1','card','week');
  h.browser.scrollY=30;h.navigate('#/');
  assert.equal(c.habitHistoryOpenFor,null);assert.equal(h.browser.scrollY,30);assert.match(h.browser.location.href,/#\/$/);
});

test('weekly popup progress and success marks refresh for check and undo without replacing the popup',()=>{
  const h=popupHarness(),c=h.c;
  c.openHabitProgress('h2','card','week');const renders=h.renders;
  function node(attrs,classes=[]){
    const set=new Set(classes);
    return {attrs,textContent:'',innerHTML:'',getAttribute:key=>attrs[key],hasAttribute:key=>Object.hasOwn(attrs,key),
      setAttribute(key,value){attrs[key]=value;},querySelector:()=>null,
      classList:{contains:value=>set.has(value),toggle(value,enabled){if(enabled)set.add(value);else set.delete(value);}}};
  }
  const day=node({'data-habit-day':'h2|2026-09-22'});day.parentElement=node({});
  const progress=node({'data-habit-week-progress':'h2'}),otherProgress=node({'data-habit-week-progress':'h1'});
  otherProgress.textContent='leave alone';const card=node({'data-habit-card':'h2'},['card','habit-card']);
  card.classList.toggle=()=>assert.fail('checking a day must not change the parent card appearance');
  const popupStatus=node({'data-habit-popup-status':'h2'});
  const nodes={'[data-habit-card], [data-habit-stats-panel]':[card],'[data-habit-card]':[card],'[data-habit-day]':[day],
    '[data-habit-week-progress]':[progress,otherProgress],'[data-habit-popup-status]':[popupStatus]};
  c.document.querySelectorAll=selector=>nodes[selector]||[];
  for(const checked of [true,false]){
    c.habitSaveIntents.h2={'2026-09-22':{checked,status:'saving'}};c.refreshHabitSaveUI('h2');
    assert.equal(progress.textContent,(checked?'1':'0')+'/7일 절제');assert.equal(day.attrs['aria-pressed'],String(checked));
    assert.equal(day.parentElement.classList.contains('is-checked'),checked);
    assert.equal(card.classList.contains('is-today-success'),false);assert.match(popupStatus.innerHTML,/체크 저장 중/);
    assert.equal(c.habitHistoryOpenFor,'h2');assert.equal(h.renders,renders);
  }
  assert.equal(otherProgress.textContent,'leave alone');assert.deepEqual(c.STATE.habits.h2.checkedDates,[]);
  c.habitSaveIntents.h2['2026-09-22'].status='error';c.refreshHabitSaveUI('h2');
  assert.match(popupStatus.innerHTML,/data-retry-habit-save="h2"/);
});

test('changing popup months preserves dialog scroll and focused navigation while new dates remain reversible',()=>{
  const c=cardHarness(),events=[];
  c.STATE={habits:{h1:{id:'h1',userId:'owner',startDate:'2026-08-01',checkedDates:[]}}};
  c.SESSION={userId:'owner'};c.habitHistoryOpenFor='h1';c.habitHistoryMonth={y:2026,m:8};
  c.habitSaveIntents={h1:{'2026-08-15':{checked:true,status:'saving'}}};
  vm.runInContext(source.slice(source.indexOf('function habitWithPendingChecks('),source.indexOf('function habitSaveStatusHtml(')),c);
  const button={getAttribute:()=> 'h1|2026-08-15',addEventListener(type,fn){this.click=fn;}};
  const calendar={innerHTML:'old dates',querySelectorAll:()=>[button]},label={},summary={};
  const modal={scrollTop:425,querySelector:selector=>({'[data-habit-history-calendar]':calendar,'.habit-hist-month-label':label,'[data-habit-popup-summary]':summary}[selector])};
  c.app={querySelector:()=>modal};c.render=()=>assert.fail('month navigation must not replace the dialog');
  c.focusHabitDialog=()=>assert.fail('month navigation must retain focus on its existing button');
  c.habitHistoryCalendarHtml=(habit,y,m,stable)=>{assert.equal(stable,true);assert.deepEqual(Array.from(habit.checkedDates),['2026-08-15']);return `${y}-${m+1}`;};
  c.habitMonthSummaryHtml=(habit,y,m)=>`summary ${y}-${m+1}`;
  c.toggleHabitDate=(...args)=>events.push(args);
  const begin=source.indexOf('function shiftHabitHistoryMonth(');
  vm.runInContext(source.slice(begin,source.indexOf('function openHabitProgress(',begin)),c);
  c.shiftHabitHistoryMonth(-1);
  assert.equal(modal.scrollTop,425);assert.equal(label.textContent,'2026년 8월');assert.equal(calendar.innerHTML,'2026-8');assert.equal(summary.textContent,'summary 2026-8');
  const event={stopped:false,stopPropagation(){this.stopped=true;}};
  button.click(event);button.click(event);assert.equal(event.stopped,true);assert.deepEqual(events,[['h1','2026-08-15'],['h1','2026-08-15']]);
  c.shiftHabitHistoryMonth(1);assert.equal(modal.scrollTop,425);assert.equal(label.textContent,'2026년 9월');
  c.habitHistoryMonth={y:2026,m:0};c.shiftHabitHistoryMonth(-1);assert.equal(label.textContent,'2025년 12월');
  c.SESSION.userId='someone-else';c.shiftHabitHistoryMonth(1);assert.equal(label.textContent,'2025년 12월');
});

test('popup calendars keep six week rows across short and long months without adding dates',()=>{
  const c=cardHarness(),habit={id:'h1',startDate:'2026-01-01',checkedDates:[]};
  const begin=source.indexOf('function habitHistoryCalendarHtml(');
  vm.runInContext(source.slice(begin,source.indexOf('function habitGoalProgress(',begin)),c);
  for(const [year,month,days] of [[2027,1,28],[2026,7,31],[2026,8,30]]){
    const html=c.habitHistoryCalendarHtml(habit,year,month,true);
    assert.equal((html.match(/class="habit-hist-cell /g)||[]).length,42);
    assert.equal((html.match(/<span>\d+<\/span>/g)||[]).length,days);
    assert.match(html,/class="habit-hist-grid is-stable-weeks"/);
  }
  const inline=c.habitHistoryCalendarHtml(habit,2027,1);
  assert.equal((inline.match(/class="habit-hist-cell /g)||[]).length,28);
});
