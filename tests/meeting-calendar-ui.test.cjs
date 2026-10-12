'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../meetingCalendar.js');
test('meeting schedules never guess legacy free-text dates or modify legacy guidance',()=>{
  const old={date:'10월 24일',time:'오후 1시30분',place:'교육관',note:'기존 안내'};const snapshot=JSON.stringify(old);
  assert.deepEqual(C.schedule(old),{valid:true,complete:false});assert.equal(JSON.stringify(old),snapshot);
});
test('structured date/time validates actual dates and requires explicit end time',()=>{
  const valid={calendarDate:'2026-10-24',calendarStart:'13:30',calendarEnd:'15:00'};
  const s=C.schedule(valid);assert.equal(s.complete,true);assert.equal(s.dateLabel,'2026.10.24 (토)');assert.equal(s.timeLabel,'13:30–15:00');
  for(const values of [{...valid,calendarDate:'2026-02-30'},{...valid,calendarStart:'24:00'},{...valid,calendarEnd:''},{...valid,calendarEnd:'13:20'}])assert.equal(C.schedule(values).valid,false);
  assert.equal(C.schedule({...valid,calendarDate:'2028-02-29'}).valid,true);
});
test('OAuth navigation permits only the exact Google page and app callback',()=>{
  const origin='https://growell-book.vercel.app';const valid='https://accounts.google.com/o/oauth2/v2/auth?redirect_uri='+encodeURIComponent(origin+'/api/meeting-calendar');
  assert.equal(C.authorizationUrl(valid,origin),valid);
  for(const bad of [valid.replace('accounts.google.com','evil.example'),valid+'&redirect_uri='+encodeURIComponent(origin+'/api/meeting-calendar'),valid.replace('meeting-calendar','drive-backup'),valid+'#secret'])assert.equal(C.authorizationUrl(bad,origin),'');
});
test('authenticated client strips arbitrary payload and sends only same-origin requests',async()=>{
  const calls=[];const client=C.createClient({isCurrent:()=>true,getAccessToken:async()=> 'fixture-token',fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({configured:true,connected:false})};}});
  await client.request('configure',{enabled:true,owner:'another',token:'forbidden'});
  assert.equal(calls[0].url,'/api/meeting-calendar?action=configure');assert.equal(calls[0].options.mode,'same-origin');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(JSON.parse(calls[0].options.body),{enabled:true});
  await assert.rejects(client.request('delete-event',{}),{code:'invalid_action'});client.dispose();
});
test('a replaced member session cannot send or render a request under the previous identity',async()=>{
  let current=true,resolve;const token=new Promise(r=>resolve=r);let calls=0;
  const client=C.createClient({isCurrent:()=>current,getAccessToken:()=>token,fetch:async()=>{calls++;return {ok:true,json:async()=>({})};}});
  const req=client.request('status');await Promise.resolve();current=false;resolve('old-token');await assert.rejects(req,{code:'session_changed'});assert.equal(calls,0);client.dispose();
});
test('closing the client aborts requests and rejects a late response',async()=>{
  let signal,resolve;const response=new Promise(r=>resolve=r);
  const client=C.createClient({isCurrent:()=>true,getAccessToken:async()=> 'fixture',fetch:async(url,options)=>{signal=options.signal;return response;}});
  const req=client.request('status');await new Promise(r=>setImmediate(r));client.dispose();assert.equal(signal.aborted,true);resolve({ok:true,json:async()=>({configured:true})});await assert.rejects(req,{code:'session_changed'});
});
