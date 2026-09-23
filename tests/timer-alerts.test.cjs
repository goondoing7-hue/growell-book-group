const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../timerAlerts.js'),'utf8');
const workerSource=fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8');

function harness(options={}){
  const storage=options.storage||new Map(),calls={prompts:0,registrations:[],notifications:[],vibrations:[],resume:0,tones:[],silent:0};
  const notification={permission:options.permission||'default',requestPermission(){calls.prompts++;notification.permission=options.answer||'granted';return Promise.resolve(notification.permission);}};
  const registration={active:{state:'activated'},showNotification(title,settings){calls.notifications.push({title,settings});return options.showError?Promise.reject(new Error('device failure')):Promise.resolve();}};
  class Audio{
    constructor(){this.state='suspended';this.destination={};this.currentTime=10;}
    resume(){calls.resume++;this.state=options.audioBlocked?'suspended':'running';return options.audioBlocked?Promise.reject(new Error('autoplay blocked')):Promise.resolve();}
    createBuffer(){return {};}
    createBufferSource(){return {connect(){},start(){calls.silent++;},disconnect(){}};}
    createOscillator(){return {frequency:{setValueAtTime(value,time){calls.tones.push({value,time});}},connect(){},start(){},stop(){},disconnect(){}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const c={Promise,Date,Math,JSON,Array,Number,setTimeout,clearTimeout,isSecureContext:options.insecure!==true,
    Notification:options.unsupported?undefined:notification,AudioContext:options.noAudio?undefined:Audio,
    navigator:{vibrate:pattern=>{calls.vibrations.push(pattern);return true;},serviceWorker:{register(url,settings){calls.registrations.push({url,settings});return options.registerError?Promise.reject(new Error('registration failed')):options.registerPending?new Promise(()=>{}):Promise.resolve(registration);}}},
    localStorage:{getItem:key=>{if(options.storageError)throw new Error('blocked');return storage.get(key)||null;},setItem:(key,value)=>{if(options.storageError)throw new Error('blocked');storage.set(key,value);}}};
  if(options.noVibration)delete c.navigator.vibrate;
  vm.createContext(c);vm.runInContext(source,c);
  return {api:c.GrowellTimerAlerts,c,calls,notification,registration,storage};
}
const countdown=id=>({bookId:'emotion',bookTitle:'PRIVATE BOOK TITLE',durationSeconds:1200,countdownId:id});

test('prepare unlocks audio from the timer gesture and never requests notification permission',async()=>{
  const h=harness();await h.api.prepare();
  assert.equal(h.calls.prompts,0);assert.equal(h.calls.resume,1);assert.equal(h.calls.silent,1);assert.equal(h.calls.tones.length,0);
  assert.equal(h.calls.registrations.length,0);assert.equal(h.api.notificationStatus().enabled,false);
});
test('a countdown uses a short sound and vibration even before OS notifications are allowed',async()=>{
  const h=harness();await h.api.prepare();const result=await h.api.notify(countdown('countdown-1'));
  assert.equal(result.audio,true);assert.equal(result.vibration,true);assert.equal(result.notification,false);
  assert.equal(h.calls.tones.length,2);assert.equal(h.calls.vibrations.length,1);assert.equal(h.calls.prompts,0);assert.equal(h.calls.notifications.length,0);
});
test('only explicit enable requests permission and uses a mobile-compatible service worker notification',async()=>{
  const h=harness();const pending=h.api.enableNotifications();assert.equal(h.calls.prompts,1,'permission call is synchronous with the button gesture');
  assert.equal((await pending).enabled,true);assert.equal(h.calls.registrations[0].url,'/timer-alert-sw.js');assert.equal(h.calls.registrations[0].settings.scope,'/');
  const result=await h.api.notify(countdown('countdown-2'));assert.equal(result.notification,true);
  const message=h.calls.notifications[0];assert.equal(message.title,'카운트다운 종료!');assert.match(message.settings.body,/독서 시간은 계속 기록/);assert.equal(message.settings.data.bookId,'emotion');
  assert.doesNotMatch(JSON.stringify(message),/PRIVATE BOOK TITLE|1200/);assert.equal(h.calls.prompts,1);
});
test('denied, unsupported and failed device APIs degrade without permission loops or timer errors',async()=>{
  const denied=harness({permission:'denied',noAudio:true,noVibration:true});
  assert.equal((await denied.api.enableNotifications()).enabled,false);assert.equal(denied.calls.prompts,0);
  assert.equal((await denied.api.notify(countdown('denied'))).notified,false);
  const missing=harness({unsupported:true,noAudio:true,noVibration:true});await missing.api.prepare();
  assert.equal((await missing.api.enableNotifications()).supported,false);assert.equal((await missing.api.notify(countdown('missing'))).notified,false);
  const failed=harness({registerError:true});const status=await failed.api.enableNotifications();
  assert.equal(status.enabled,false);assert.match(status.label,/다시 시도/);
  await failed.api.prepare();const result=await failed.api.notify(countdown('failed'));assert.equal(result.audio,true);assert.equal(result.notification,false);
  const blocked=harness({audioBlocked:true,noVibration:true});await blocked.api.prepare();assert.equal((await blocked.api.notify(countdown('audio-blocked'))).audio,false);
});
test('concurrent completion, rerender and reload never repeat an already claimed countdown',async()=>{
  const h=harness({noAudio:true});const [first,second]=await Promise.all([h.api.notify(countdown('same-countdown')),h.api.notify(countdown('same-countdown'))]);
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(h.calls.vibrations.length,1);
  const restored=harness({storage:h.storage});assert.equal((await restored.api.notify(countdown('same-countdown'))).duplicate,true);assert.equal(restored.calls.vibrations.length,0);
  assert.equal((await restored.api.notify(countdown('new-countdown'))).duplicate,false);
});
test('a stalled registration resolves to a retryable status rather than leaving the permission button waiting',async()=>{
  const h=harness({registerPending:true});h.c.setTimeout=(callback,delay)=>setTimeout(callback,Math.min(delay,10));
  const status=await h.api.enableNotifications();assert.equal(status.enabled,false);assert.match(status.label,/다시 시도/);
});
test('deduplication storage stays bounded and contains only opaque identifiers and timestamps',async()=>{
  const h=harness({noAudio:true,noVibration:true});
  for(let i=0;i<75;i++)await h.api.notify(countdown('PRIVATE-COUNTDOWN-'+i));
  const raw=h.storage.get('growell_timer_alerts_v1'),records=JSON.parse(raw);
  assert.equal(records.length,64);assert.doesNotMatch(raw,/PRIVATE|emotion|BOOK/);
  for(const record of records){assert.deepEqual(Object.keys(record).sort(),['at','id']);assert.match(record.id,/^t1-[0-9a-f]+-[0-9a-f]+$/);}
  const blocked=harness({storageError:true,noAudio:true});await blocked.api.notify(countdown('in-memory'));
  assert.equal((await blocked.api.notify(countdown('in-memory'))).duplicate,true);
});
test('invalid identifiers cannot trigger alerts, unsafe book routes are omitted, and notification failure does not stop sound',async()=>{
  const h=harness({permission:'granted',showError:true});await h.api.prepare();
  assert.equal((await h.api.notify({countdownId:''})).notified,false);assert.equal(h.calls.vibrations.length,0);
  const result=await h.api.notify({...countdown('good-id'),bookId:'https://evil.test/steal'});
  assert.equal(result.audio,true);assert.equal(result.notification,false);assert.equal(h.calls.notifications[0].settings.data.bookId,null);
  assert.equal(h.api.notificationStatus().enabled,false);
});

function workerHarness(windows=[]){
  const events={},opened=[],focused=[],c={URL,self:{location:{origin:'https://growell-book.vercel.app'},
    addEventListener:(name,callback)=>{events[name]=callback;},skipWaiting:()=>Promise.resolve(),
    clients:{claim:()=>Promise.resolve(),matchAll:()=>Promise.resolve(windows),openWindow:url=>{opened.push(url);return Promise.resolve();}}}};
  vm.createContext(c);vm.runInContext(workerSource,c);
  async function click(data){let waiting,closed=false;events.notificationclick({notification:{data,close(){closed=true;}},waitUntil:promise=>{waiting=promise;}});await waiting;assert.equal(closed,true);}
  return {events,opened,focused,click};
}
test('notification clicks open only allowlisted same-origin book routes and preserve another page draft',async()=>{
  let navigations=0;
  const h=workerHarness([{url:'https://growell-book.vercel.app/#/book/thought/mine',navigate(){navigations++;}},{url:'https://evil.test/#/book/emotion/mine',focus(){throw new Error('foreign window');}}]);
  await h.click({bookId:'emotion',url:'https://evil.test/redirect'});
  assert.equal(h.opened[0],'https://growell-book.vercel.app/#/book/emotion/mine');assert.equal(navigations,0);
  await h.click({bookId:'../../evil',url:'https://evil.test/redirect'});assert.equal(h.opened[1],'https://growell-book.vercel.app/#/');
  assert.deepEqual(Object.keys(h.events).sort(),['activate','install','notificationclick'],'no response cache, fetch interception or pretend background push');
});
test('notification click focuses an exact existing reading page without opening or navigating it',async()=>{
  let focused=0;const h=workerHarness([{url:'https://growell-book.vercel.app/#/book/action/mine',focus(){focused++;return Promise.resolve();}}]);
  await h.click({bookId:'action'});assert.equal(focused,1);assert.equal(h.opened.length,0);
});
