'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const clock=require('../habitDayClock.js'),habits=require('../habitDomain.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function target(){const events={};return {hidden:false,events,addEventListener(name,fn){(events[name]||=new Set()).add(fn);},removeEventListener(name,fn){events[name]?.delete(fn);},emit(name){for(const fn of events[name]||[])fn();}};}
function clockHarness(start){
 let now=start,serial=0;const pending=new Map(),calls=[],window=target(),document=target();
 const api=clock.create({now:()=>now,window,document,setTimeout(fn,delay){pending.set(++serial,{fn,delay});return serial;},clearTimeout(id){pending.delete(id);},onChange(...args){calls.push(args);}});
 return {api,pending,calls,window,document,setNow(value){now=value;},tick(){const timer=pending.values().next().value;assert.ok(timer);pending.clear();timer.fn();}};
}
function mockDate(value){let now=value;class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}return {Date:FakeDate,setNow(value){now=value;}};}
function date(day,hour=12){return new Date(2026,8,day,hour).getTime();}
function runFunctions(context,begin,end){vm.runInContext(source.slice(source.indexOf(begin),source.indexOf(end,source.indexOf(begin))),context);}

test('local midnight updates once and immediately schedules the next bounded check',()=>{
 const midnight=new Date(2026,8,30).getTime(),h=clockHarness(midnight-100);h.api.start();h.api.start();
 assert.equal(h.pending.size,1);assert.equal(h.pending.values().next().value.delay,125);assert.equal(h.window.events.focus.size,1);
 h.setNow(midnight+25);h.tick();assert.deepEqual(h.calls,[['2026-09-30','2026-09-29']]);assert.equal(h.pending.size,1);assert.equal(h.pending.values().next().value.delay,60000);
 h.window.emit('focus');h.window.emit('pageshow');h.document.emit('visibilitychange');assert.equal(h.calls.length,1);assert.equal(h.pending.size,1);
});

test('sleep, background return, restored page and clock changes catch up without clearing intermediate dates',()=>{
 const h=clockHarness(date(28));h.api.start();h.document.hidden=true;h.setNow(date(30));h.document.emit('visibilitychange');assert.equal(h.calls.length,0);
 h.document.hidden=false;h.document.emit('visibilitychange');assert.deepEqual(h.calls,[['2026-09-30','2026-09-28']]);
 h.setNow(new Date(2026,9,2).getTime());h.window.emit('pageshow');assert.deepEqual(h.calls.at(-1),['2026-10-02','2026-09-30']);
 h.setNow(new Date(2026,9,1).getTime());h.window.emit('focus');assert.deepEqual(h.calls.at(-1),['2026-10-01','2026-10-02']);
 h.api.stop();assert.equal(h.pending.size,0);assert.equal(h.window.events.focus.size,0);assert.equal(h.window.events.pageshow.size,0);assert.equal(h.document.events.visibilitychange.size,0);
});

test('local day agrees with existing habit dates across year, month, and leap-day boundaries',()=>{
 for(const value of [new Date(2026,0,1,0,1),new Date(2025,11,31,23,59),new Date(2024,1,29,0),new Date(2026,8,30,23,59)])assert.equal(clock.day(value.getTime()),habits.todayDate(value));
});

test('today card and overview clicks use the actual day while explicit calendar dates stay unchanged',()=>{
 const time=mockDate(date(30)),calls=[],c={Date:time.Date,ymd:d=>clock.day(d.getTime()),toggleHabitDate:(...args)=>calls.push(args),openHabitProgress(){}};vm.createContext(c);
 runFunctions(c,'function bindHabitDayEvents(','function openHabitProgress(');runFunctions(c,'function bindHabitOverviewEvents(','function habitStatusLabel(');
 const button=(attrs)=>({attrs,events:{},getAttribute(key){return attrs[key];},addEventListener(type,fn){this.events[type]=fn;}});
 const todayButton=button({'data-habit-day':'h1|2026-09-29','data-habit-today':''}),calendarButton=button({'data-habit-day':'h1|2026-09-29'}),root={querySelectorAll:()=>[todayButton,calendarButton]};
 c.bindHabitDayEvents(root);c.bindHabitDayEvents(root);todayButton.events.click({stopPropagation(){}});calendarButton.events.click({stopPropagation(){}});
 const overviewButton=button({'data-habit-overview-day':'h2|2026-09-29'}),panel={addEventListener(type,fn){this.click=fn;},contains:()=>true};c.bindHabitOverviewEvents({querySelectorAll:()=>[panel]});panel.click({target:{closest:selector=>selector==='[data-habit-overview-day]'?overviewButton:null},stopPropagation(){}});
 assert.deepEqual(calls,[['h1','2026-09-30'],['h1','2026-09-29'],['h2','2026-09-30']]);
});

test('a stale checked home checkbox toggles the new day rather than undoing yesterday',()=>{
 const time=mockDate(date(29)),calls=[],attrs={'data-home-habit':'h1'},input={checked:true,events:{},getAttribute:key=>attrs[key],addEventListener(type,fn){this.events[type]=fn;}};
 const saved={id:'h1',checkedDates:['2026-09-29']},c={Date:time.Date,ymd:d=>clock.day(d.getTime()),SESSION:{userId:'reader'},homeHabits:()=>[saved],document:{querySelectorAll:()=>[input]},queueHabitCheck:(...args)=>calls.push(args),refreshHomeHabits(){}};vm.createContext(c);runFunctions(c,'function bindHomeHabitEvents(','function bindHomeEvents(');c.bindHomeHabitEvents();
 time.setNow(date(30));input.checked=false;input.events.change();assert.deepEqual(calls,[['h1','2026-09-30',true]]);assert.deepEqual(saved.checkedDates,['2026-09-29']);
 input.checked=false;input.events.change();assert.deepEqual(calls.at(-1),['h1','2026-09-30',false]);
});

test('refreshing a successful card clears only its today appearance and date while preserving saved successes',()=>{
 const time=mockDate(date(30)),saved={id:'h1',name:'매일 독서',userId:'reader',startDate:'2026-09-01',endDate:'2026-10-31',checkedDates:['2026-09-28','2026-09-29']};
 const attrs={'data-habit-day':'h1|2026-09-29','data-habit-today':''},classes=new Set(['is-checked']),label={textContent:'성공'},button={getAttribute:key=>attrs[key],setAttribute(key,value){attrs[key]=value;},hasAttribute:key=>key in attrs,querySelector:()=>label,classList:{toggle(name,enabled){enabled?classes.add(name):classes.delete(name);}}};
 let valueRefreshes=0;const card={getAttribute:()=> 'h1',querySelector:()=>null},c={Date:time.Date,GrowellHabits:habits,SESSION:{userId:'reader'},STATE:{habits:{h1:saved}},ymd:d=>clock.day(d.getTime()),habitWithPendingChecks:value=>value,habitWeekProgress:()=>({}),weekDatesOf:()=>[],mondayOf:value=>value,refreshHomeHabits(){},refreshHabitValueSummary(){valueRefreshes++;},
  document:{querySelectorAll(selector){return selector==='[data-habit-card], [data-habit-stats-panel]'||selector==='[data-habit-card]'?[card]:selector==='[data-habit-day]'?[button]:[];}}};
 vm.createContext(c);runFunctions(c,'function habitTodayState(','function habitStreakHtml(');runFunctions(c,'function refreshHabitSaveUI(','function queueHabitCheck(');c.refreshHabitSaveUI('h1');
 assert.equal(attrs['data-habit-day'],'h1|2026-09-30');assert.equal(attrs['aria-pressed'],'false');assert.equal(classes.has('is-checked'),false);assert.equal(button.disabled,false);assert.equal(label.textContent,'성공');
 assert.deepEqual(saved.checkedDates,['2026-09-28','2026-09-29']);assert.equal(habits.stats(saved,'2026-09-30').success,2);assert.equal(valueRefreshes,1);
});

test('day refresh updates only habit surfaces while keeping an open form, popup, viewed month and scroll',()=>{
 const calls=[],time=mockDate(new Date(2026,9,1).getTime()),existing={id:'h1',userId:'reader',checkedDates:['2026-09-29','2026-09-30']};
 const form={open:true,values:{name:'입력 중',time:'오후 8시'},scrollTop:41},body={innerHTML:'old',contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]},modal={open:true,scrollTop:280,querySelector:()=>body};
 const c={Date:time.Date,SESSION:{userId:'reader'},memberLoadState:{habits:'ready'},STATE:{habits:{h1:existing}},habitHistoryOpenFor:'h1',habitHistoryView:'month',habitHistoryMonth:null,
  window:{scrollX:0,scrollY:390,scrollTo(pos){calls.push(['scroll',pos]);}},document:{activeElement:form,querySelector:()=>modal,querySelectorAll:()=>[]},
  refreshHabitSaveUI:id=>calls.push(['refresh',id]),habitWithPendingChecks:value=>value,habitMonthPopupHtml:()=>'<calendar>updated</calendar>',bindHabitDayEvents:()=>{},refreshHomeHabits:rebuild=>calls.push(['home',rebuild]),render(){throw new Error('must not rerender the application');},saveState(){throw new Error('must not write or clear the database');}};
 vm.createContext(c);runFunctions(c,'function refreshHabitDay(','function bindHabitDayClock(');c.refreshHabitDay('2026-10-01','2026-09-30');
 assert.deepEqual(existing.checkedDates,['2026-09-29','2026-09-30']);assert.equal(form.open,true);assert.equal(form.values.name,'입력 중');assert.equal(form.scrollTop,41);assert.equal(modal.open,true);assert.equal(modal.scrollTop,280);assert.equal(body.innerHTML,'<calendar>updated</calendar>');
 assert.equal(c.habitHistoryMonth.y,2026);assert.equal(c.habitHistoryMonth.m,8);assert.deepEqual(calls.map(call=>call[0]),['refresh','home','scroll']);assert.equal(calls.at(-1)[1].top,390);
 c.habitHistoryMonth={y:2025,m:3};c.refreshHabitDay('2026-10-02','2026-10-01');assert.equal(c.habitHistoryMonth.y,2025);assert.equal(c.habitHistoryMonth.m,3);
});

test('home day refresh replaces the active habit list without rebuilding other home editors',()=>{
 const time=mockDate(date(30)),content={innerHTML:'yesterday',querySelectorAll:()=>[]},count={textContent:''},saved=[{id:'new-day',checkedDates:[]}],c={Date:time.Date,SESSION:{userId:'reader'},memberLoadState:{habits:'ready'},ymd:d=>clock.day(d.getTime()),homeHabits:()=>saved,homeHabitRowsHtml:items=>items.map(x=>'<li>'+x.id+'</li>').join(''),bindHomeHabitEvents(){},document:{activeElement:null,querySelector:selector=>selector==='[data-home-habit-content]'?content:count,querySelectorAll:()=>[]}};
 vm.createContext(c);runFunctions(c,'function refreshHomeHabits(','function memberHomeHtml(');c.refreshHomeHabits(true);
 assert.match(content.innerHTML,/new-day/);assert.doesNotMatch(content.innerHTML,/yesterday/);assert.equal(count.textContent,'0 / 1 완료');
});
