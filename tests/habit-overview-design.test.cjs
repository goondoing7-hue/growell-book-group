const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const domain=require('../habitDomain.js');

function harness(){
  class Today extends Date{constructor(...args){super(...(args.length?args:[2026,8,22,12]));}}
  const c={Date:Today,GrowellHabits:domain,GrowellHabitSuggestions:require('../habitSuggestions.js'),SESSION:{userId:'owner'},STATE:{habits:{}},memberLoadState:{habits:'ready'},habitSaveIntents:{},
    bookById:()=>({title:'모임 책'}),memberDataStatusHtml:()=>'<p role="status">불러오는 중</p>',
    esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(c);
  for(const [start,end] of [['function pad2(','function closeHabitValueSummary('],['function habitOverviewBodyHtml(','/* 월요일 시작 기준'],['function mondayOf(','function weekDatesOf('],['function habitTodayState(','function habitStreakHtml('],['function habitWithPendingChecks(','function habitSaveStatusHtml(']]){
    vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),c);
  }
  return c;
}
function habit(id,extra={}){return {id,userId:'owner',bookId:'emotion',name:id,startDate:'2026-09-21',checkedDates:[],createdAt:1,...extra};}
function checkbox(html,id){return [...html.matchAll(/<input\b[^>]*>/g)].map(match=>match[0]).find(markup=>markup.includes('data-habit-overview-day="'+id+'|'));}

test('today statistics use active owned habits instead of the weekly success rate while retaining past and future rows',()=>{
  const c=harness();c.STATE.habits={
    complete:habit('complete',{checkedDates:['2026-09-22']}),pending:habit('pending',{checkedDates:['2026-09-21']}),
    future:habit('future',{startDate:'2026-09-23'}),ended:habit('ended',{endDate:'2026-09-21'}),
    foreign:habit('foreign',{userId:'another-member',checkedDates:['2026-09-22']})
  };
  const html=c.habitOverviewBodyHtml();
  assert.match(html,/오늘 완료<\/span><strong>1<small> \/ 2/);
  assert.doesNotMatch(html,/data-habit-summary="remaining"|남은 습관/);
  assert.match(html,/aria-label="전체 습관 4개 목록 보기"/);
  assert.match(html,/오늘 실천율<\/span><strong>50<small>%/);
  assert.match(html,/오늘의 작은 약속/);assert.match(html,/4개의 습관/);assert.doesNotMatch(html,/주간 성공률|foreign/);
  assert.match(checkbox(html,'complete'),/ checked /);assert.doesNotMatch(checkbox(html,'pending'),/ checked /);
  assert.match(checkbox(html,'future'),/ disabled/);assert.match(checkbox(html,'ended'),/ disabled/);
  assert.match(html,/habit-overview-row-state">시작 전/);assert.match(html,/habit-overview-row-state">기간 종료/);
  assert.equal([...html.matchAll(/data-habit-overview-id=/g)].length,4);
});

test('optimistic checks update today metrics without modifying stored history and unavailable data never renders old metrics',()=>{
  const c=harness();c.STATE.habits={one:habit('one'),two:habit('two')};
  c.habitSaveIntents.one={'2026-09-22':{checked:true,status:'saving'}};
  let html=c.habitOverviewBodyHtml();assert.match(html,/오늘 실천율<\/span><strong>50/);assert.match(html,/체크 저장 중/);assert.deepEqual(c.STATE.habits.one.checkedDates,[]);
  c.habitSaveIntents.one['2026-09-22']={checked:false,status:'error'};
  html=c.habitOverviewBodyHtml();assert.match(html,/오늘 실천율<\/span><strong>0/);assert.doesNotMatch(checkbox(html,'one'),/ checked /);assert.match(html,/저장하지 못한 체크/);
  c.memberLoadState.habits='loading';html=c.habitOverviewBodyHtml();assert.match(html,/불러오는 중/);assert.doesNotMatch(html,/오늘 완료|오늘 실천율|data-habit-overview-id/);
  c.memberLoadState.habits='ready';c.SESSION=null;html=c.habitOverviewBodyHtml();assert.match(html,/로그인하면/);assert.doesNotMatch(html,/오늘 완료|오늘 실천율|data-habit-overview-id/);
});

test('checkbox, habit heading and value pill retain separate actions and stale day markup checks the current day',()=>{
  const c=harness(),calls=[];let listener;
  c.toggleHabitDate=(...args)=>calls.push(['check',...args]);c.openHabitProgress=(...args)=>calls.push(['progress',...args]);c.openHabitValueSummary=(...args)=>calls.push(['values',...args]);c.openHabitValueGuide=()=>calls.push(['guide']);
  c.openHabitSummary=(...args)=>calls.push(['summary',...args]);
  const panel={contains:()=>true,addEventListener:(type,handler)=>{assert.equal(type,'click');listener=handler;}};
  c.bindHabitOverviewEvents({querySelectorAll:()=>[panel]});
  function click(attrs,disabled=false){const button={disabled,getAttribute:key=>attrs[key]??null};const event={target:{closest:selector=>Object.hasOwn(attrs,selector.slice(1,-1))?button:null},stopPropagation(){this.stopped=true;}};listener(event);assert.equal(event.stopped,true);return button;}
  click({'data-habit-overview-day':'one|2026-09-21'});assert.deepEqual(calls.pop(),['check','one','2026-09-22']);
  click({'data-habit-overview-day':'future|2026-09-22'},true);assert.equal(calls.length,0);
  click({'data-habit-overview-open':'one'});assert.deepEqual(calls.pop(),['progress','one','overview']);
  const trigger=click({'data-habit-value-overview':'all'});assert.deepEqual(calls.pop(),['values','all',trigger]);
  for(const mode of ['all','remaining']){const counter=click({'data-habit-summary':mode});assert.deepEqual(calls.pop(),['summary',mode,counter]);}
  assert.equal(c.SESSION.userId,'owner');assert.equal(calls.length,0);
});
