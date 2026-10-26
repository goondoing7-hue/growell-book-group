'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {payloadFor}=require('../server/webPushService.cjs');
const source=fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8');
const NOW=Date.parse('2026-10-26T23:00:00+09:00'),origin='https://growell-book.vercel.app';
function worker(windows=[]){
  const events={},shown=[],opened=[],focused=[];class Clock extends Date{static now(){return NOW;}}
  const c={URL,Promise,Date:Clock,self:{location:{origin},addEventListener:(n,f)=>events[n]=f,registration:{showNotification:async(title,options)=>shown.push({title,options})},clients:{matchAll:async()=>windows.map(url=>({url,focus:async()=>focused.push(url)})),openWindow:async url=>opened.push(url)}}};
  vm.createContext(c);vm.runInContext(source,c);return{shown,opened,focused,async push(payload){let waiting;events.push({data:{json:()=>payload},waitUntil(p){waiting=p;}});if(waiting)await waiting;},async click(data){let waiting;events.notificationclick({notification:{data,close(){}},waitUntil(p){waiting=p;}});if(waiting)await waiting;}};
}
test('nightly reminder reaches the device with fixed wording and opens home today habits without replacing another draft',async()=>{
  const draft=origin+'/#/book/emotion/mine',payload=payloadFor({kind:'habit',habit_day:'2026-10-26',name:'PRIVATE HABIT',checked_dates:['PRIVATE DATES']},NOW);
  const w=worker([draft]);await w.push(payload);assert.equal(w.shown.length,1);assert.equal(w.shown[0].title,'오늘의 습관 체크');assert.match(w.shown[0].options.body,/아직 체크하지 않은 오늘의 습관/);assert.doesNotMatch(JSON.stringify(w.shown),/PRIVATE HABIT|PRIVATE DATES/);
  await w.click(w.shown[0].options.data);assert.deepEqual(w.opened,[origin+'/#/']);assert.deepEqual(w.focused,[]);
  const home=worker([draft,origin+'/#/']);await home.click(w.shown[0].options.data);assert.deepEqual(home.focused,[origin+'/#/']);assert.deepEqual(home.opened,[]);
});
test('stale, malformed and unrelated-day habit payloads never display a reminder',async()=>{
  for(const day of ['2026-10-25','2026-10-27','2026-02-31','../../escape','',null,3]){const w=worker();await w.push({version:1,type:'habit',day,tag:'valid'});assert.equal(w.shown.length,0);assert.throws(()=>payloadFor({kind:'habit',habit_day:day},NOW),e=>e.code==='push-unavailable');}
  const w=worker();await w.push({version:1,type:'habit',day:'2026-10-26',tag:'../escape'});assert.equal(w.shown.length,0);
});
