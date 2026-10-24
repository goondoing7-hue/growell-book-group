'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {payloadFor}=require('../server/webPushService.cjs');
const ID='12345678-1234-4234-8234-123456789abc',origin='https://growell-book.vercel.app';
const workerSource=fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function worker(windows=[]){
  const events={},shown=[],opened=[],focused=[];
  const c={URL,Promise,self:{location:{origin},addEventListener:(name,fn)=>events[name]=fn,registration:{showNotification:async(title,options)=>shown.push({title,options})},clients:{matchAll:async()=>windows.map(url=>({url,focus:async()=>focused.push(url)})),openWindow:async url=>opened.push(url)}}};
  vm.createContext(c);vm.runInContext(workerSource,c);
  return {shown,opened,focused,async push(payload){let task;events.push({data:{json:()=>payload},waitUntil(value){task=value;}});if(task)await task;},async click(data){let task;events.notificationclick({notification:{data,close(){}},waitUntil(value){task=value;}});if(task)await task;}};
}
function app(){
  const opened=[],c={Number,SESSION:{userId:'reader'},saveSessionEpoch:1,BOOTING:false,BOOT_FAILED:false,authRestoreState:'idle',oauthBusy:false,saving:false,location:{hash:'#/book/emotion/share/meeting/2'},meetingMemberCanRead:book=>book==='emotion',GrowellMeetingRecords:{openRound:(...args)=>opened.push(args)},anyComposerOpen:()=>false,document:{querySelector:()=>null}};
  const start=html.indexOf('function currentRoute(){'),end=html.indexOf("window.addEventListener('hashchange'",start);assert.ok(start>=0&&end>start);vm.createContext(c);vm.runInContext(html.slice(start,end),c);return {c,opened};
}
test('meeting notification includes its exact round and opens that meeting without exposing source content',async()=>{
  for(const book of ['emotion','thought','body','action']){
    const payload=payloadFor({kind:'meeting',book_id:book,meeting_id:ID,meeting_round:2,topic:'NEVER EXPOSE TOPIC',sections:'NEVER EXPOSE BODY'},Date.now());
    assert.equal(payload.type,'meeting');assert.equal(payload.round,2);assert.equal(payload.meetingId,ID);assert.match(payload.body,/2번째 모임 기록/);assert.doesNotMatch(JSON.stringify(payload),/NEVER EXPOSE/);
    const draft=origin+'/#/book/'+book+'/mine',w=worker([draft]);await w.push(payload);assert.equal(w.shown[0].title,'2번째 모임 기록이 올라왔어요');assert.match(w.shown[0].options.body,/함께 나눈 내용/);
    const route=origin+'/#/book/'+book+'/share/meeting/2';await w.click(w.shown[0].options.data);assert.deepEqual(w.opened,[route]);assert.deepEqual(w.focused,[]);
    const exact=worker([draft,route]);await exact.click(w.shown[0].options.data);assert.deepEqual(exact.focused,[route]);assert.deepEqual(exact.opened,[]);
  }
});
test('invalid meeting payloads never display an alert or open an arbitrary route',async()=>{
  const base={version:1,type:'meeting',bookId:'emotion',meetingId:ID,round:2,tag:'meeting-valid'};
  for(const patch of [{meetingId:'../escape'},{meetingId:''},{bookId:'unknown'},{round:0},{round:10000},{round:'2'},{round:1.5},{round:NaN}]){
    const w=worker();await w.push({...base,...patch});assert.equal(w.shown.length,0);assert.throws(()=>payloadFor({kind:'meeting',book_id:({...base,...patch}).bookId,meeting_id:({...base,...patch}).meetingId,meeting_round:({...base,...patch}).round},Date.now()),e=>e.code==='push-unavailable');
  }
  const w=worker();await w.click({kind:'growell-push',...base,meetingId:'../escape'});assert.deepEqual(w.opened,[origin+'/#/']);
});
test('the app parses only bounded share meeting routes and opens the authorized round once per visit',()=>{
  const {c,opened}=app();assert.equal(c.currentRoute().meetingRound,2);assert.equal(c.openMeetingRecordRoute(c.currentRoute()),true);assert.deepEqual(opened,[['emotion',2,null]]);assert.equal(c.openMeetingRecordRoute(c.currentRoute()),false);
  c.location.hash='#/';c.openMeetingRecordRoute(c.currentRoute());c.location.hash='#/book/emotion/share/meeting/2';assert.equal(c.openMeetingRecordRoute(c.currentRoute()),true);assert.equal(opened.length,2);
  for(const hash of ['#/book/emotion/share/meeting/0','#/book/emotion/share/meeting/10000','#/book/emotion/share/meeting/02','#/book/emotion/share/meeting/2/extra','#/book/emotion/mine/meeting/2','#/book/emotion/share/meeting/2?x=1']){c.location.hash=hash;assert.equal(c.currentRoute().meetingRound,undefined,hash);}
});
test('meeting links wait for authentication, permissions and unfinished editors without opening another dialog',()=>{
  const changes=[c=>c.SESSION=null,c=>c.meetingMemberCanRead=()=>false,c=>c.BOOTING=true,c=>c.BOOT_FAILED=true,c=>c.authRestoreState='checking',c=>c.oauthBusy=true,c=>c.saving=true,c=>c.anyComposerOpen=()=>true,c=>c.document.querySelector=()=>({open:true})];
  for(const change of changes){const {c,opened}=app();change(c);assert.equal(c.openMeetingRecordRoute(c.currentRoute()),false);assert.deepEqual(opened,[]);}
  const {c,opened}=app();c.anyComposerOpen=()=>true;assert.equal(c.openMeetingRecordRoute(c.currentRoute()),false);c.anyComposerOpen=()=>false;assert.equal(c.openMeetingRecordRoute(c.currentRoute()),true);assert.equal(opened.length,1);
});
