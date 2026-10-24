const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../webPush.js'),'utf8');
const workerSource=fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8');
const key=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,9)]).toString('base64url');
const json=value=>JSON.parse(JSON.stringify(value));
const repairEntries=memory=>[...memory].filter(([name])=>name.startsWith('growell_push_repair_v1:'));
function createLocks(){let tail=Promise.resolve();const calls=[];return {calls,request(name,settings,callback){calls.push(name);const task=tail.then(()=>{if(settings.signal.aborted){const error=Error('cancelled');error.name='AbortError';throw error;}return callback({name});});tail=task.catch(()=>{});return task;}};}
function harness(options={}){
  const calls={prompts:0,registrations:[],requests:[],subscriptions:0,unsubscribe:0,tokens:0,changes:[],localNotifications:[]};
  let current=true;const backend=options.backend||{active:!!options.subscribed,prefs:{posts:options.posts!==false,dailyVerse:options.dailyVerse!==false},endpoint:'https://push.example.test/private-endpoint'};
  const notification={permission:options.permission||'default',requestPermission(){calls.prompts++;notification.permission=options.answer||'granted';return Promise.resolve(notification.permission);}};
  const native=options.native||{};function createSubscription(endpoint,expirationTime=null){return {endpoint,expirationTime,toJSON(){return {endpoint:this.endpoint,expirationTime:this.expirationTime,keys:{p256dh:'PRIVATE_KEY',auth:'PRIVATE_AUTH'}};},unsubscribe(){calls.unsubscribe++;if(options.unsubscribeError)return Promise.reject(Error('device error'));if(options.unsubscribeFalse)return Promise.resolve(false);if(!options.keepNative)native.value=null;if(options.onUnsubscribe)options.onUnsubscribe();return Promise.resolve(true);}};}
  const subscription=createSubscription('https://push.example.test/private-endpoint',options.expirationTime??null);
  if(!('value' in native))native.value=options.subscribed||options.existing||options.inactive?subscription:null;
  const memory=options.memory||new Map(),storage={get length(){if(options.storageReadFailure)throw Error('storage blocked');return memory.size;},key:i=>[...memory.keys()][i]??null,getItem:name=>{if(options.storageReadFailure)throw Error('storage blocked');return memory.get(name)??null;},setItem:(name,value)=>{if(options.storageFailure)throw Error('storage blocked');if(!options.storageNoop)memory.set(name,value);},removeItem:name=>memory.delete(name)};
  const registration={scope:'https://growell-book.vercel.app/',active:{state:'activated',scriptURL:'https://growell-book.vercel.app/timer-alert-sw.js'},
    showNotification(title,settings){calls.localNotifications.push({title,settings});return options.localError?Promise.reject(Error('PRIVATE_DEVICE_FAILURE')):Promise.resolve();},
    pushManager:{getSubscription(){return options.subscriptionDeferred||Promise.resolve(native.value);},subscribe(settings){calls.subscriptions++;calls.subscribeSettings=settings;if(options.nativeSubscribeError)return Promise.reject(Error('native failed'));native.value=options.freshEndpoint?createSubscription(options.freshEndpoint):subscription;return Promise.resolve(native.value);}}};
  async function fetch(url,settings){
    const body=JSON.parse(settings.body);calls.requests.push({url,settings,body});
    if(options.onFetch)options.onFetch(body);
    if(options.fetchDeferred&&body.action===options.fetchDeferredAction)return options.fetchDeferred;
    if(options.networkError)throw Error('PRIVATE_NETWORK_BODY');
    if(options.failure===body.action)return {ok:false,status:503,json:async()=>({error:options.errorCode||'unavailable',detail:'PRIVATE_ERROR_DETAIL'})};
    let data;
    if(body.action==='config')data={configured:options.configured!==false,publicKey:options.badKey||key};
    else if(body.action==='status')data={configured:true,subscription:body.endpoint===backend.endpoint&&(backend.active||options.inactive)?{active:backend.active,preferences:backend.prefs,lastSentAt:options.lastSentAt,lastError:backend.active?null:options.lastError??'subscription-expired'}:null};
    else if(body.action==='subscribe'){backend.active=true;backend.endpoint=body.subscription.endpoint;backend.prefs=options.serverPrefs||body.preferences;data={ok:true};}
    else if(body.action==='preferences'){backend.prefs=body.preferences;data={ok:true};}
    else if(body.action==='unsubscribe'){backend.active=false;data={ok:true};}
    else data={ok:true};
    return {ok:true,status:200,json:async()=>data};
  }
  const c={Promise,Date,Math,JSON,Array,Number,Object,Set,Uint8Array,AbortController,URL,crypto:require('node:crypto').webcrypto,localStorage:storage,
    setTimeout:options.fastTimers?(fn,delay)=>setTimeout(fn,Math.min(delay,10)):setTimeout,clearTimeout,
    atob:value=>Buffer.from(value,'base64').toString('binary'),isSecureContext:!options.insecure,Notification:options.unsupported?undefined:notification,PushManager:options.unsupported?undefined:function(){},
    location:{origin:'https://growell-book.vercel.app'},matchMedia:()=>({matches:!!options.standalone}),navigator:{locks:options.noLocks?undefined:options.locks||createLocks(),userAgent:options.ios?'iPhone':'Windows',platform:options.ipad?'MacIntel':'Win32',maxTouchPoints:options.ipad?5:0,
      standalone:!!options.standalone,serviceWorker:{getRegistration(){calls.getRegistration=(calls.getRegistration||0)+1;return options.registrationDeferred||Promise.resolve(registration);},register(url,settings){calls.registrations.push({url,settings});return options.registerError?Promise.reject(Error('device registration')):Promise.resolve(registration);}}},fetch};
  vm.createContext(c);vm.runInContext(source,c);
  const api=c.GrowellWebPush,adapter={memberKey:options.memberKey||'SYNTHETIC_MEMBER',isCurrent:()=>current,getAccessToken:()=>{calls.tokens++;return Promise.resolve('PRIVATE_BEARER_TOKEN');},onChange:value=>calls.changes.push(json(value))};
  return {api,c,calls,notification,subscription,registration,adapter,options,memory,native,backend,controller:api.createController(adapter),endSession(){current=false;},setCurrent(value){current=value;}};
}
test('opening settings only checks the current device and never asks permission or subscribes',async()=>{
  const h=harness();await h.controller.refresh();
  assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.registrations.length,0);
  assert.equal(h.controller.snapshot().loaded,true);assert.equal(h.controller.snapshot().subscribed,false);
  assert.deepEqual(h.calls.requests.map(r=>r.body.action),['config','status']);
  assert.equal(h.calls.requests[0].settings.headers.Authorization,'Bearer PRIVATE_BEARER_TOKEN');
  assert.equal(h.calls.requests[0].settings.credentials,'same-origin');assert.equal(h.calls.requests[0].settings.redirect,'error');
});
test('permission is requested in the explicit enable gesture before async token/network work',async()=>{
  const h=harness();await h.controller.refresh();const before=h.calls.tokens;
  const pending=h.controller.enable();assert.equal(h.calls.prompts,1);assert.equal(h.calls.tokens,before);
  assert.equal(await pending,true);assert.equal(h.controller.snapshot().subscribed,true);
  assert.equal(h.calls.registrations[0].url,'/timer-alert-sw.js');assert.equal(h.calls.registrations[0].settings.scope,'/');
  assert.equal(h.calls.subscribeSettings.userVisibleOnly,true);assert.equal(h.calls.subscribeSettings.applicationServerKey.length,65);
  const sent=h.calls.requests.find(r=>r.body.action==='subscribe');assert.deepEqual(sent.body.preferences,{posts:true,dailyVerse:true});
  assert.equal(sent.body.subscription.endpoint,h.subscription.endpoint);assert.doesNotMatch(JSON.stringify(h.calls.changes),/PRIVATE_|push\.example|private-endpoint/);
});
test('already granted permission reuses the browser subscription and explicitly registers this member',async()=>{
  const h=harness({permission:'granted',existing:true});await h.controller.refresh();assert.equal(h.controller.snapshot().subscribed,false);
  await h.controller.enable();assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);
  assert.equal(h.calls.requests.filter(r=>r.body.action==='subscribe').length,1);assert.equal(h.controller.snapshot().subscribed,true);
});
test('unsupported/insecure browsers and non-installed iOS devices get guidance without prompting',async()=>{
  for(const options of [{unsupported:true},{insecure:true},{ios:true},{ipad:true}]){
    const h=harness(options);await h.controller.refresh();await h.controller.enable();
    assert.equal(h.calls.prompts,0);assert.equal(h.calls.registrations.length,0);assert.equal(h.calls.requests.length,0);
    assert.match(h.api.message({code:h.controller.snapshot().errorCode}),/브라우저|홈 화면/);
  }
  const installed=harness({ios:true,standalone:true});await installed.controller.refresh();assert.equal(installed.controller.snapshot().supported,true);assert.equal(installed.controller.snapshot().iosNeedsInstall,false);
});
test('denied/dismissed permissions and incomplete setup never create a subscription',async()=>{
  for(const options of [{permission:'denied'},{answer:'denied'},{answer:'default'},{configured:false},{badKey:'INVALID_KEY'}]){
    const h=harness(options);await h.controller.refresh();await h.controller.enable();assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.registrations.length,0);
    assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.controller.snapshot().busy,false);
  }
});
test('the two preferences are independent and are restored from server confirmation',async()=>{
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();
  assert.equal(await h.controller.preferences({posts:false,dailyVerse:true}),true);
  assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:true});
  assert.deepEqual(h.calls.requests.find(r=>r.body.action==='preferences').body.preferences,{posts:false,dailyVerse:true});
  assert.equal(await h.controller.preferences({posts:false,dailyVerse:false}),true);
  assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});
});
test('a failed preference save retains confirmed choices and never exposes server details',async()=>{
  const h=harness({subscribed:true,permission:'granted',failure:'preferences'});await h.controller.refresh();
  assert.equal(await h.controller.preferences({posts:false,dailyVerse:false}),false);
  assert.deepEqual(json(h.controller.snapshot().preferences),{posts:true,dailyVerse:true});
  assert.doesNotMatch(h.api.message({code:h.controller.snapshot().errorCode}),/PRIVATE/);
});
test('testing is authenticated and enabled only for the current device subscription',async()=>{
  const missing=harness();await missing.controller.refresh();await missing.controller.test();assert.equal(missing.calls.requests.some(r=>r.body.action==='test'),false);
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();await h.controller.test();
  const call=h.calls.requests.find(r=>r.body.action==='test');assert.equal(call.body.endpoint,h.subscription.endpoint);assert.match(h.controller.snapshot().notice,/테스트 알림/);
  assert.match(h.controller.snapshot().notice,/요청했어요.*1분/);assert.doesNotMatch(h.controller.snapshot().notice,/보냈어요|발송 완료/);
});
test('safe server error categories produce connection, approval and retry guidance without raw diagnostics',()=>{
  const h=harness();assert.match(h.api.message({code:'connection-required'}),/알림 받기/);assert.match(h.api.message({code:'subscription-invalid'}),/알림 받기/);
  assert.match(h.api.message({code:'membership-required'}),/가입 승인/);assert.match(h.api.message({code:'rate-limited'}),/잠시 기다린/);
  assert.doesNotMatch(h.api.message({code:'<PRIVATE_DIAGNOSTIC>'}),/PRIVATE/);
});
test('delayed device testing requests a 60 second server schedule without changing subscriptions or preferences',async()=>{
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();const before=h.calls.requests.length;
  assert.equal(h.calls.requests.some(r=>r.body.action==='test'),false);assert.equal(await h.controller.testDelayed(),true);
  const requested=h.calls.requests.slice(before);assert.equal(requested.length,1);assert.equal(requested[0].body.action,'test');assert.equal(requested[0].body.delaySeconds,60);assert.equal(requested[0].body.endpoint,h.subscription.endpoint);
  assert.deepEqual(Object.keys(requested[0].body).sort(),['action','delaySeconds','endpoint']);assert.match(h.controller.snapshot().notice,/화면을 닫고.*잠근 뒤/);assert.match(h.controller.snapshot().notice,/예약/);assert.doesNotMatch(h.controller.snapshot().notice,/수신 완료/);
  assert.deepEqual(json(h.controller.snapshot().preferences),{posts:true,dailyVerse:true});assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);
  await h.controller.test();assert.equal('delaySeconds' in h.calls.requests.at(-1).body,false,'the existing immediate test stays immediate');
});
test('delayed testing requires this device connection and retains safe errors when scheduling fails',async()=>{
  const missing=harness();await missing.controller.refresh();assert.equal(await missing.controller.testDelayed(),false);assert.equal(missing.calls.requests.some(r=>r.body.action==='test'),false);
  const failed=harness({subscribed:true,permission:'granted',failure:'test',errorCode:'rate-limited'});await failed.controller.refresh();assert.equal(await failed.controller.testDelayed(),false);assert.equal(failed.controller.snapshot().notice,'');assert.equal(failed.controller.snapshot().errorCode,'rate-limited');
});
test('local device display check uses no server request or permission prompt and always has a fresh safe tag',async()=>{
  const h=harness({subscribed:true,permission:'granted',lastSentAt:'2026-10-17T01:23:45Z'});await h.controller.refresh();
  const before=h.calls.requests.length;assert.equal(await h.controller.localTest(),true);assert.equal(await h.controller.localTest(),true);
  assert.equal(h.calls.requests.length,before);assert.equal(h.calls.prompts,0);assert.equal(h.calls.localNotifications.length,2);
  assert.notEqual(h.calls.localNotifications[0].settings.tag,h.calls.localNotifications[1].settings.tag);
  assert.deepEqual(json(h.calls.localNotifications[0].settings.data),{kind:'growell-push',type:'test'});
  assert.doesNotMatch(JSON.stringify(h.calls.localNotifications),/PRIVATE_|private-endpoint|push\.example/);
  assert.match(h.controller.snapshot().notice,/표시를 요청.*알림창/);assert.doesNotMatch(h.controller.snapshot().notice,/수신 완료|표시 성공/);
  assert.equal(h.controller.snapshot().lastSentAt,'2026-10-17T01:23:45.000Z');
});
test('a local notification API rejection gives device settings guidance without pretending delivery',async()=>{
  const h=harness({subscribed:true,permission:'granted',localError:true});await h.controller.refresh();assert.equal(await h.controller.localTest(),false);
  assert.equal(h.controller.snapshot().errorCode,'device_display_failed');assert.match(h.api.message({code:h.controller.snapshot().errorCode}),/브라우저.*갤럭시/);
  assert.doesNotMatch(h.controller.snapshot().notice+h.api.message({code:h.controller.snapshot().errorCode}),/PRIVATE_DEVICE_FAILURE|수신 완료/);
});
test('local checks require current permission, exact worker scope/script and matching current subscription',async()=>{
  for(const edit of [h=>{h.notification.permission='denied';},h=>{h.registration.scope='https://foreign.example/';},h=>{h.registration.active.scriptURL='https://growell-book.vercel.app/other-sw.js';},h=>{h.registration.active.state='activating';},h=>{h.registration.pushManager.getSubscription=async()=>({endpoint:'https://push.example.test/another-account'});}]){
    const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();edit(h);assert.equal(await h.controller.localTest(),false);assert.equal(h.calls.localNotifications.length,0);assert.equal(h.calls.prompts,0);
  }
});
test('malformed server timestamps are omitted and server acceptance is not labelled device receipt',async()=>{
  const h=harness({subscribed:true,lastSentAt:'PRIVATE_NOT_A_DATE'});await h.controller.refresh();assert.equal(h.controller.snapshot().lastSentAt,'');
  const parsed=h.api.subscriptionStatus({configured:true,subscription:{active:true,preferences:{posts:true,dailyVerse:true},lastSentAt:'2026-10-17T01:23:45Z'}});
  assert.equal(parsed.lastSentAt,'2026-10-17T01:23:45.000Z');assert.equal('receivedAt' in parsed,false);
});
test('enabling waits for an installing replacement instead of accepting a still-active old timer worker',async()=>{
  const h=harness({permission:'granted'});await h.controller.refresh();let listener,removed=0;
  const replacement={state:'installing',scriptURL:'https://growell-book.vercel.app/timer-alert-sw.js',addEventListener(name,fn){assert.equal(name,'statechange');listener=fn;},removeEventListener(name,fn){if(fn===listener)removed++;}};
  h.registration.installing=replacement;const pending=h.controller.enable();await new Promise(setImmediate);
  assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(r=>r.body.action==='subscribe'),false);
  replacement.state='activated';h.registration.active=replacement;h.registration.installing=null;listener();
  assert.equal(await pending,true);assert.equal(h.calls.subscriptions,1);assert.equal(removed,1);
});
test('a failed replacement activation cannot mark push connected and its state listener is cleaned up',async()=>{
  const h=harness({permission:'granted',fastTimers:true});await h.controller.refresh();let removed=0;
  h.registration.installing={state:'installing',addEventListener(){},removeEventListener(){removed++;}};
  assert.equal(await h.controller.enable(),false);assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.calls.subscriptions,0);assert.equal(removed,1);
});
test('already connected device checks update and await the replacement before local display or server scheduling',async()=>{
  for(const method of ['localTest','test']){
    const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();let listener,updates=0;
    const replacement={state:'installing',scriptURL:'https://growell-book.vercel.app/timer-alert-sw.js',addEventListener(name,fn){listener=fn;},removeEventListener(){}};
    h.registration.update=async()=>{updates++;h.registration.installing=replacement;};
    const before=h.calls.requests.length,pending=h.controller[method]();await new Promise(setImmediate);
    assert.equal(updates,1);assert.equal(h.calls.localNotifications.length,0);assert.equal(h.calls.requests.length,before);
    replacement.state='activated';h.registration.active=replacement;h.registration.installing=null;listener();assert.equal(await pending,true);
    if(method==='localTest'){assert.equal(h.calls.localNotifications.length,1);assert.equal(h.calls.requests.length,before);}
    else assert.equal(h.calls.requests.at(-1).body.action,'test');
  }
});
test('local display diagnosis remains usable offline while server testing requires a successful worker update',async()=>{
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();const before=h.calls.requests.length;
  h.registration.update=async()=>{throw Error('offline');};assert.equal(await h.controller.localTest(),true);assert.equal(h.calls.localNotifications.length,1);
  assert.equal(await h.controller.test(),false);assert.equal(h.calls.requests.length,before);assert.equal(h.calls.prompts,0);
});
test('changing the account during a local diagnosis prevents a notification on a later account device',async()=>{
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();let finish;
  h.registration.pushManager.getSubscription=()=>new Promise(resolve=>{finish=resolve;});const pending=h.controller.localTest();await new Promise(setImmediate);
  h.endSession();finish(h.subscription);assert.equal(await pending,false);assert.equal(h.calls.localNotifications.length,0);
});
test('turning this device off deactivates server delivery before browser unsubscribe without touching user data',async()=>{
  const h=harness({subscribed:true,permission:'granted'});await h.controller.refresh();await h.controller.disable();
  assert.equal(h.calls.unsubscribe,1);assert.equal(h.controller.snapshot().subscribed,false);
  assert.deepEqual(h.calls.requests.map(r=>r.body.action),['config','status','unsubscribe']);
  const failed=harness({subscribed:true,permission:'granted',failure:'unsubscribe'});await failed.controller.refresh();await failed.controller.disable();assert.equal(failed.calls.unsubscribe,1);assert.equal(failed.controller.snapshot().subscribed,false);
});
test('network/registration errors are retryable and do not fabricate successful delivery',async()=>{
  const h=harness({networkError:true});await h.controller.refresh();assert.equal(h.controller.snapshot().loaded,false);assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.controller.snapshot().errorCode,'unavailable');
  const reg=harness({registerError:true});await reg.controller.refresh();assert.equal(await reg.controller.enable(),false);assert.equal(reg.controller.snapshot().subscribed,false);assert.equal(reg.calls.requests.some(r=>r.body.action==='subscribe'),false);
});
test('duplicate clicks stay serialized and reset discards a late authenticated result',async()=>{
  let finish;const delayed=new Promise(resolve=>{finish=resolve;});const h=harness({fetchDeferred:delayed,fetchDeferredAction:'status'});
  const loading=h.controller.refresh();await new Promise(setImmediate);assert.equal(h.controller.snapshot().busy,true);assert.equal(await h.controller.enable(),false);assert.equal(h.calls.prompts,0);
  const changes=h.calls.changes.length;h.api.reset();finish({ok:true,json:async()=>({configured:true,subscription:{active:true,preferences:{posts:true,dailyVerse:true}}})});
  assert.equal(await loading,false);assert.equal(h.calls.changes.length,changes);assert.equal(h.calls.requests.filter(r=>r.body.action==='subscribe').length,0);
});
test('logout detaches the captured device even when the network is offline',async()=>{
  const h=harness({subscribed:true,networkError:true});assert.equal(await h.api.detach(h.adapter),true);assert.equal(h.calls.unsubscribe,1);
  assert.equal(h.calls.requests[0].body.action,'unsubscribe');assert.equal(h.calls.requests[0].body.endpoint,h.subscription.endpoint);
});
test('logout checks identity before capturing a subscription belonging to a later account',async()=>{
  let finish;const deferred=new Promise(resolve=>{finish=resolve;});const h=harness({subscribed:true,registrationDeferred:deferred});
  const pending=h.api.detach(h.adapter);h.endSession();finish(h.registration);assert.equal(await pending,false);assert.equal(h.calls.unsubscribe,0);assert.equal(h.calls.requests.length,0);
});
test('logout finishes unsubscribe on its exact captured object after the prior session clears',async()=>{
  const h=harness({subscribed:true});let finish;h.subscription.unsubscribe=()=>{h.calls.unsubscribe++;h.endSession();return new Promise(resolve=>{finish=resolve;});};
  const pending=h.api.detach(h.adapter);await new Promise(setImmediate);finish(true);assert.equal(await pending,true);assert.equal(h.calls.unsubscribe,1);
});
test('a stalled session check and unavailable browser storage leave settings retryable',async()=>{
  const h=harness({fastTimers:true});const c=h.api.createController({isCurrent:()=>true,getAccessToken:()=>new Promise(()=>{})});
  assert.equal(await c.refresh(),false);assert.equal(c.snapshot().errorCode,'timeout');assert.equal(c.snapshot().busy,false);c.destroy();
  h.c.navigator.serviceWorker.getRegistration=()=>{throw Error('storage blocked');};
  assert.equal(await h.api.detach(h.adapter),false);
});
function mountHarness(options={},mode={}){
  const h=harness(options),nodes=new Map();
  const container={classList:{add(){}},setAttribute(){},set innerHTML(value){this.markup=value;for(const match of value.matchAll(/data-push-[a-z]+/g)){
    if(!nodes.has(match[0]))nodes.set(match[0],{hidden:false,disabled:false,checked:false,textContent:'',classList:{toggle(){}}});
  }},querySelector(selector){return nodes.get(selector.slice(1,-1));},querySelectorAll(selectors){return selectors.split(',').map(selector=>this.querySelector(selector)).filter(Boolean);}};
  const view=h.api.mount(container,Object.assign({},h.adapter,mode));return {h,nodes,container,view};
}
test('the administrator settings expose clear per-device controls, diagnostics and confirmed preferences',async()=>{
  const {h,nodes,container,view}=mountHarness({subscribed:true,permission:'granted',posts:false,lastSentAt:'2026-10-17T01:23:45Z'},{isAdmin:true});await new Promise(setImmediate);
  assert.match(container.markup,/이 기기에서 알림 받기/);assert.match(container.markup,/테스트 알림 보내기/);
  assert.match(container.markup,/기기 알림 표시 확인/);assert.match(nodes.get('data-push-last').textContent,/최근 전체 알림 발송:.*2026.*기기 수신 확인과는 달라요/);
  assert.match(container.markup,/새 나눔·자료 알림/);assert.match(container.markup,/나눔과 자료실의 새 글/);assert.match(container.markup,/한국 시간 오전 9시/);
  assert.equal(nodes.get('data-push-enable').hidden,true);assert.equal(nodes.get('data-push-settings').hidden,false);
  assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,true);
  assert.doesNotMatch(container.markup+JSON.stringify([...nodes.values()]),/PRIVATE_|private-endpoint|push\.example/);
  const before=h.calls.requests.length;view.destroy();await nodes.get('data-push-refresh').onclick().catch(()=>{});assert.equal(h.calls.requests.length,before);
});
test('ordinary member settings retain one test and recovery controls while omitting administrator diagnostics',async()=>{
  for(const isAdmin of [undefined,false,'true',1]){
    const {h,nodes,container,view}=mountHarness({subscribed:true,permission:'granted',posts:false},{isAdmin});await new Promise(setImmediate);
    assert.match(container.markup,/테스트 알림 보내기/);assert.doesNotMatch(container.markup,/기기 알림 표시 확인|1분 뒤 알림 확인|최근 전체 알림 발송|data-push-local|data-push-delayed|data-push-last/);
    assert.equal(nodes.get('data-push-settings').hidden,false);assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,true);
    assert.equal(await nodes.get('data-push-test').onclick(),true);assert.equal(h.calls.requests.at(-1).body.action,'test');assert.equal(typeof nodes.get('data-push-disable').onclick,'function');view.destroy();
  }
});
test('compact settings expose only three notification switches for members and administrators',async()=>{
  for(const isAdmin of [false,true]){
    const {h,nodes,container,view}=mountHarness({subscribed:true,permission:'granted',posts:false},{compact:true,isAdmin});await new Promise(setImmediate);
    assert.equal((container.markup.match(/role="switch"/g)||[]).length,3);
    assert.match(container.markup,/이 기기 알림/);assert.match(container.markup,/새 나눔·자료 알림/);assert.match(container.markup,/매일 오전 9시 말씀/);
    assert.doesNotMatch(container.markup,/<button|<h3|<small|설명|받아요|확인하고|테스트|새로고침|data-push-(?:enable|disable|refresh|test|local|delayed|last|install|reconnect)/);
    assert.equal(nodes.get('data-push-device').checked,true);assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,true);
    assert.equal(nodes.get('data-push-status').hidden,true);assert.equal(nodes.get('data-push-status').textContent,'');
    assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);view.destroy();
  }
});
test('compact device ON requests permission in the original gesture and waits for confirmed subscription',async()=>{
  const {h,nodes,view}=mountHarness({}, {compact:true});await new Promise(setImmediate);
  assert.equal(nodes.get('data-push-device').checked,false);assert.equal(nodes.get('data-push-device').disabled,false);
  assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-posts').disabled,true);
  const tokens=h.calls.tokens;nodes.get('data-push-device').checked=true;
  const enabled=nodes.get('data-push-device').onchange();
  assert.equal(h.calls.prompts,1);assert.equal(h.calls.tokens,tokens);
  assert.equal(nodes.get('data-push-device').checked,false,'unconfirmed ON is reverted while permission and registration are pending');
  assert.equal(nodes.get('data-push-device').disabled,true);
  assert.equal(await enabled,true);
  assert.equal(nodes.get('data-push-device').checked,true);assert.equal(nodes.get('data-push-posts').checked,true);assert.equal(nodes.get('data-push-verse').checked,true);
  assert.equal(nodes.get('data-push-status').hidden,true);view.destroy();
});
test('compact ON failure remains OFF with only an actionable error and no diagnostics',async()=>{
  for(const options of [{answer:'denied'},{failure:'subscribe'}]){
    const {h,nodes,container,view}=mountHarness(options,{compact:true,isAdmin:true});await new Promise(setImmediate);
    nodes.get('data-push-device').checked=true;assert.equal(await nodes.get('data-push-device').onchange(),false);
    assert.equal(nodes.get('data-push-device').checked,false);assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-posts').disabled,true);
    assert.equal(nodes.get('data-push-status').hidden,false);assert.match(nodes.get('data-push-status').textContent,/허용해주세요|다시 시도/);
    assert.doesNotMatch(container.markup+nodes.get('data-push-status').textContent,/PRIVATE_|private-endpoint|push\.example|테스트|새로고침/);
    if(options.answer==='denied')assert.equal(h.calls.subscriptions,0);view.destroy();
  }
});
test('compact topic switches and device OFF preserve confirmed preferences across reconnection',async()=>{
  const {h,nodes,view}=mountHarness({subscribed:true,permission:'granted'},{compact:true});await new Promise(setImmediate);
  nodes.get('data-push-posts').checked=false;assert.equal(await nodes.get('data-push-posts').onchange(),true);
  assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,true);
  const change=h.calls.requests.find(call=>call.body.action==='preferences');assert.deepEqual(json(change.body.preferences),{posts:false,dailyVerse:true});
  nodes.get('data-push-device').checked=false;assert.equal(await nodes.get('data-push-device').onchange(),true);
  assert.equal(nodes.get('data-push-device').checked,false);assert.equal(nodes.get('data-push-verse').checked,false);assert.equal(nodes.get('data-push-verse').disabled,true);assert.equal(h.calls.unsubscribe,1);
  nodes.get('data-push-device').checked=true;assert.equal(await nodes.get('data-push-device').onchange(),true);
  assert.equal(nodes.get('data-push-device').checked,true);assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,true);
  assert.equal(h.calls.prompts,0);view.destroy();
});
test('compact preference failures restore confirmed switches and disabled views cannot use a prior session',async()=>{
  const {h,nodes,view}=mountHarness({subscribed:true,permission:'granted',failure:'preferences'},{compact:true});await new Promise(setImmediate);
  nodes.get('data-push-posts').checked=false;assert.equal(await nodes.get('data-push-posts').onchange(),false);assert.equal(nodes.get('data-push-posts').checked,true);
  assert.equal(nodes.get('data-push-status').hidden,false);
  const before=h.calls.requests.length;view.destroy();nodes.get('data-push-device').checked=false;await assert.rejects(nodes.get('data-push-device').onchange(),error=>error.code==='session_changed');assert.equal(h.calls.requests.length,before);
});
test('compact device ON repairs an expired connection without reviving disabled topic preferences',async()=>{
  const {h,nodes,container,view}=mountHarness({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/compact-repaired'},{compact:true});await new Promise(setImmediate);
  assert.equal(nodes.get('data-push-device').checked,false);assert.equal(nodes.get('data-push-device').disabled,false);assert.equal(nodes.get('data-push-status').hidden,true);
  assert.doesNotMatch(container.markup,/다시 연결하기|연결이 만료|테스트|새로고침/);
  assert.equal(h.calls.unsubscribe,0);nodes.get('data-push-device').checked=true;assert.equal(await nodes.get('data-push-device').onchange(),true);
  assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.subscriptions,1);
  assert.equal(nodes.get('data-push-device').checked,true);assert.equal(nodes.get('data-push-posts').checked,false);assert.equal(nodes.get('data-push-verse').checked,false);view.destroy();
});
test('compact unavailable devices retain OFF switches without asking permission or exposing long instructions',async()=>{
  for(const options of [{unsupported:true},{ios:true},{permission:'denied'}]){
    const {h,nodes,container,view}=mountHarness(options,{compact:true});await new Promise(setImmediate);
    assert.equal(nodes.get('data-push-device').checked,false);assert.equal(nodes.get('data-push-posts').disabled,true);assert.equal(nodes.get('data-push-verse').disabled,true);
    assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);assert.equal(nodes.get('data-push-status').hidden,false);
    assert.ok(nodes.get('data-push-status').textContent.length<45);assert.doesNotMatch(container.markup,/Safari|16\.4|알림을 받을 기기마다|집중 모드|발송|새로고침/);view.destroy();
  }
});
test('an expired own subscription displays its reconnect action outside the hidden connected settings',async()=>{
  const {h,nodes,container,view}=mountHarness({inactive:true,permission:'granted',posts:false,dailyVerse:false});await new Promise(setImmediate);
  assert.equal(nodes.get('data-push-settings').hidden,true);assert.equal(nodes.get('data-push-enable').hidden,false);assert.equal(nodes.get('data-push-enable').textContent,'다시 연결하기');assert.equal(nodes.get('data-push-reconnect').hidden,false);
  assert.match(nodes.get('data-push-reconnect').textContent,/연결이 만료.*기존 수신 설정은 유지/);assert.ok(container.markup.indexOf('data-push-reconnect')<container.markup.indexOf('data-push-settings'));assert.equal(h.calls.unsubscribe,0);assert.equal(h.calls.subscriptions,0);view.destroy();
});
test('expired own devices renew only on explicit click and keep both disabled preferences on a different endpoint',async()=>{
  const h=harness({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/fresh-device'});
  await h.controller.refresh();await h.controller.refresh();assert.equal(h.calls.unsubscribe,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  assert.equal(h.controller.snapshot().expired,true);assert.equal(h.controller.snapshot().subscribed,false);assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});
  assert.equal(await h.controller.enable(),true);assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.subscriptions,1);assert.equal(h.calls.prompts,0);
  const request=h.calls.requests.find(call=>call.body.action==='subscribe');assert.equal(request.body.subscription.endpoint,'https://push.example.test/fresh-device');assert.notEqual(request.body.subscription.endpoint,h.subscription.endpoint);assert.deepEqual(request.body.preferences,{posts:false,dailyVerse:false});
  assert.equal(h.controller.snapshot().subscribed,true);assert.equal(h.controller.snapshot().reconnectRequired,false);assert.equal(h.controller.snapshot().expired,false);assert.equal(repairEntries(h.memory).length,0);assert.match(h.controller.snapshot().notice,/다시 연결.*수신 설정은 그대로/);
});
test('native expiration renews even when the server last knew it as active while healthy refreshes never rotate',async()=>{
  const expired=harness({subscribed:true,permission:'granted',expirationTime:Date.now()-1,posts:false,freshEndpoint:'https://push.example.test/renewed-native'});await expired.controller.refresh();assert.equal(expired.controller.snapshot().subscribed,false);assert.equal(expired.controller.snapshot().expired,true);
  assert.equal(await expired.controller.enable(),true);assert.equal(expired.calls.unsubscribe,1);assert.deepEqual(expired.calls.requests.find(call=>call.body.action==='subscribe').body.preferences,{posts:false,dailyVerse:true});
  const healthy=harness({subscribed:true,permission:'granted',expirationTime:Date.now()+86400000});for(let i=0;i<3;i++)await healthy.controller.refresh();assert.equal(healthy.controller.snapshot().subscribed,true);assert.equal(healthy.calls.unsubscribe,0);assert.equal(healthy.calls.subscriptions,0);assert.equal(healthy.calls.requests.some(call=>['subscribe','preferences'].includes(call.body.action)),false);
});
test('reconnection must verify preference backup and exact unsubscribe before issuing a fresh native or server subscription',async()=>{
  for(const boundary of [{storageFailure:true},{storageNoop:true},{storageReadFailure:true},{unsubscribeError:true},{unsubscribeFalse:true},{keepNative:true}]){
    const h=harness(Object.assign({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/new'},boundary));await h.controller.refresh();
    assert.equal(await h.controller.enable(),false,JSON.stringify(boundary));assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);assert.equal(h.native.value,h.subscription);
    if(boundary.storageFailure||boundary.storageNoop||boundary.storageReadFailure)assert.equal(h.calls.unsubscribe,0);
    assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});assert.equal(h.controller.snapshot().busy,false);
  }
});
test('reconnection rejects a different worker or a changed native endpoint without touching either device',async()=>{
  for(const alter of [h=>{h.registration.scope='https://growell-book.vercel.app/other/';},h=>{h.registration.active.scriptURL='https://growell-book.vercel.app/unrelated.js';},h=>{h.native.value={endpoint:'https://push.example.test/other-account'};}]){
    const h=harness({inactive:true,permission:'granted',posts:false});await h.controller.refresh();alter(h);assert.equal(await h.controller.enable(),false);assert.equal(h.calls.unsubscribe,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  }
});
test('session replacement during exact old unsubscribe prevents creation or registration for the next account',async()=>{
  const h=harness({inactive:true,permission:'granted',posts:false});await h.controller.refresh();h.options.onUnsubscribe=()=>h.endSession();assert.equal(await h.controller.enable(),false);
  assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);assert.equal(repairEntries(h.memory).length,1);
  const other=harness({permission:'granted',memberKey:'ANOTHER_SYNTHETIC_MEMBER',memory:h.memory,native:h.native});await other.controller.refresh();assert.deepEqual(json(other.controller.snapshot().preferences),{posts:true,dailyVerse:true});assert.equal(other.controller.snapshot().reconnectRequired,false);assert.equal(other.calls.subscriptions,0);
});
test('a fresh endpoint whose server save fails retains OFF choices through refresh and reload until confirmed retry',async()=>{
  const h=harness({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/fresh-unregistered',failure:'subscribe'});await h.controller.refresh();assert.equal(await h.controller.enable(),false);
  assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.subscriptions,1);assert.equal(repairEntries(h.memory).length,1);assert.equal(h.native.value.endpoint,'https://push.example.test/fresh-unregistered');
  const [savedKey,savedRaw]=[...h.memory][0];assert.match(savedKey,/^growell_push_repair_v1:[a-f0-9]+-[a-f0-9]+:\d+-[a-f0-9]{32}$/);assert.deepEqual(JSON.parse(savedRaw),{posts:false,dailyVerse:false});assert.doesNotMatch(savedKey+savedRaw,/SYNTHETIC_MEMBER|PRIVATE|endpoint|push\.example|TOKEN|AUTH/);
  await h.controller.refresh();assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.subscriptions,1);h.controller.destroy();
  const reload=harness({permission:'granted',native:h.native,memory:h.memory});await reload.controller.refresh();assert.equal(reload.controller.snapshot().subscribed,false);assert.equal(reload.controller.snapshot().reconnectRequired,true);assert.deepEqual(json(reload.controller.snapshot().preferences),{posts:false,dailyVerse:false});
  assert.equal(await reload.controller.enable(),true);assert.equal(reload.calls.subscriptions,0);assert.equal(reload.calls.unsubscribe,0);assert.deepEqual(reload.calls.requests.find(call=>call.body.action==='subscribe').body.preferences,{posts:false,dailyVerse:false});assert.equal(repairEntries(reload.memory).length,0);
});
test('failed repair followed by unreadable or malformed durable choices fails closed before any device or server change',async()=>{
  const initial=harness({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/new-endpoint',failure:'subscribe'});await initial.controller.refresh();await initial.controller.enable();initial.controller.destroy();
  for(const mode of ['blocked','malformed']){
    const memory=new Map(initial.memory);if(mode==='malformed')memory.set([...memory.keys()][0],'{not-json');
    const h=harness({permission:'granted',native:initial.native,memory,storageReadFailure:mode==='blocked'});await h.controller.refresh();assert.equal(await h.controller.enable(),false);assert.equal(h.calls.unsubscribe,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);assert.equal(h.native.value.endpoint,'https://push.example.test/new-endpoint');assert.equal(memory.size,1);
  }
});
test('pending OFF choices prevent confirmed ON settings from hiding the repair and are restored before success',async()=>{
  const first=harness({inactive:true,permission:'granted',posts:false,dailyVerse:false,failure:'subscribe'});await first.controller.refresh();await first.controller.enable();first.controller.destroy();
  const h=harness({subscribed:true,permission:'granted',memory:first.memory,native:first.native,serverPrefs:{posts:true,dailyVerse:true}});await h.controller.refresh();assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.controller.snapshot().reconnectRequired,true);assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});
  assert.equal(await h.controller.enable(),true);assert.deepEqual(h.calls.requests.find(call=>call.body.action==='preferences').body.preferences,{posts:false,dailyVerse:false});assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});assert.equal(repairEntries(h.memory).length,0);
});
test('reconnection cleanup cannot erase a newer pending preference generation created during registration',async()=>{
  const h=harness({inactive:true,permission:'granted',posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/fresh-generation'});await h.controller.refresh();let newKey;
  h.options.onFetch=body=>{if(body.action==='subscribe'){const prefix=[...h.memory.keys()][0].split(':').slice(0,2).join(':')+':';newKey=prefix+'9999999999999-'+'a'.repeat(32);h.memory.set(newKey,JSON.stringify({posts:false,dailyVerse:false}));}};
  assert.equal(await h.controller.enable(),true);assert.equal(repairEntries(h.memory).length,1);assert.equal(h.memory.has(newKey),true);assert.deepEqual(JSON.parse(h.memory.get(newKey)),{posts:false,dailyVerse:false});
});
test('a newer OFF generation arriving after registration is preserved and cannot be declared connected with ON settings',async()=>{
  const h=harness({inactive:true,permission:'granted',freshEndpoint:'https://push.example.test/fresh-conflict'});await h.controller.refresh();let newKey;
  h.options.onFetch=body=>{if(body.action==='subscribe'){const prefix=[...h.memory.keys()][0].split(':').slice(0,2).join(':')+':';newKey=prefix+'9999999999999-'+'b'.repeat(32);h.memory.set(newKey,JSON.stringify({posts:false,dailyVerse:false}));}};
  assert.equal(await h.controller.enable(),false);assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.memory.has(newKey),true);assert.deepEqual(json(h.controller.snapshot().preferences),{posts:false,dailyVerse:false});
});
test('a native endpoint replaced during server confirmation is not reported as a completed connection',async()=>{
  const h=harness({inactive:true,permission:'granted',posts:false,freshEndpoint:'https://push.example.test/new'});await h.controller.refresh();h.options.onFetch=body=>{if(body.action==='subscribe')h.native.value={endpoint:'https://push.example.test/later-account'};};
  assert.equal(await h.controller.enable(),false);assert.equal(h.controller.snapshot().errorCode,'device_changed');assert.equal(h.controller.snapshot().subscribed,false);assert.equal(h.controller.snapshot().reconnectRequired,true);assert.equal(repairEntries(h.memory).length,1);assert.equal(h.calls.unsubscribe,1);assert.equal(h.calls.requests.some(call=>call.body.endpoint==='https://push.example.test/later-account'),false);
});
function savedChoice(memory){const pair=[...memory].find(([name])=>name.startsWith('growell_push_choice_v1:'));assert.ok(pair);return {name:pair[0],value:JSON.parse(pair[1])};}
async function remembered(options={}){const h=harness(Object.assign({permission:'granted'},options));await h.controller.refresh();assert.equal(await h.controller.enable(),true);h.controller.destroy();return h;}
test('successful device consent and topic choices survive safe logout and restore only the same owner without a permission prompt',async()=>{
  const first=harness({permission:'granted'});await first.controller.refresh();await first.controller.enable();await first.controller.preferences({posts:false,dailyVerse:true});
  const record=savedChoice(first.memory),raw=JSON.stringify([...first.memory]);assert.deepEqual(Object.keys(record.value).sort(),['dailyVerse','enabled','posts','revision']);
  assert.equal(record.value.enabled,true);assert.equal(record.value.posts,false);assert.doesNotMatch(raw,/SYNTHETIC_MEMBER|PRIVATE|endpoint|Bearer|auth|email|push\.example/);
  assert.equal(await first.api.detach(first.adapter),true);assert.equal(first.calls.unsubscribe,1);assert.equal(first.native.value,null);assert.equal(savedChoice(first.memory).value.enabled,true);first.controller.destroy();
  const next=harness({permission:'granted',memory:first.memory,native:first.native,freshEndpoint:'https://push.example.test/restored-owner'});await next.controller.refresh();
  assert.deepEqual(json(next.controller.decision()),{enabled:true,owned:true});assert.equal(await next.controller.restore(),true);assert.equal(next.calls.prompts,0);assert.equal(next.calls.subscriptions,1);
  assert.deepEqual(next.calls.requests.find(call=>call.body.action==='subscribe').body.preferences,{posts:false,dailyVerse:true});assert.equal(next.controller.snapshot().subscribed,true);
});
test('explicit device OFF remains a completed choice even when the disconnect request fails and cannot be auto-enabled later',async()=>{
  for(const failure of [undefined,'unsubscribe']){
    const first=harness({subscribed:true,permission:'granted',failure});await first.controller.refresh();await first.controller.disable();assert.equal(savedChoice(first.memory).value.enabled,false);first.controller.destroy();
    const next=harness({permission:'granted',memory:first.memory,native:{value:null}});await next.controller.refresh();assert.deepEqual(json(next.controller.decision()),{enabled:false,owned:true});assert.equal(await next.controller.restore(),false);
    assert.equal(next.calls.prompts,0);assert.equal(next.calls.subscriptions,0);assert.equal(next.calls.requests.some(call=>call.body.action==='subscribe'),false);
  }
});
test('a browser permission or a previous member choice alone cannot automatically transfer another account subscription',async()=>{
  const first=await remembered();const other=harness({permission:'granted',existing:true,memberKey:'ANOTHER_SYNTHETIC_MEMBER',memory:first.memory});await other.controller.refresh();
  assert.equal(other.controller.decision(),null);assert.equal(await other.controller.restore(),false);assert.equal(other.calls.subscriptions,0);assert.equal(other.calls.requests.some(call=>call.body.action==='subscribe'),false);
  assert.equal(await other.controller.enable(),true);other.controller.destroy();
  const prior=harness({permission:'granted',memberKey:'SYNTHETIC_MEMBER',memory:first.memory});await prior.controller.refresh();assert.deepEqual(json(prior.controller.decision()),{enabled:true,owned:false});assert.equal(await prior.controller.restore(),false);assert.equal(prior.calls.subscriptions,0);
});
test('remembered ON never requests permission again after revocation, unsupported context or missing home-screen installation',async()=>{
  const first=await remembered();
  for(const options of [{permission:'default'},{permission:'denied'},{permission:'granted',unsupported:true},{permission:'granted',insecure:true},{permission:'granted',ios:true}]){
    const h=harness(Object.assign({memory:new Map(first.memory)},options));await h.controller.refresh();assert.equal(await h.controller.restore(),false);assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  }
});
test('malformed or unavailable local consent fails closed and never becomes origin-wide permission to connect',async()=>{
  const first=await remembered();
  for(const mode of ['malformed','unreadable','wrong-owner']){
    const memory=new Map(first.memory),record=savedChoice(memory);if(mode==='malformed')memory.set(record.name,'{"enabled":true,"token":"DO_NOT_USE"}');if(mode==='wrong-owner')memory.set('growell_push_owner_v1','different-owner');
    const h=harness({permission:'granted',memory,storageReadFailure:mode==='unreadable'});await h.controller.refresh();assert.equal(await h.controller.restore(),false);assert.equal(h.calls.prompts,0);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  }
});
test('legacy active choices are adopted before logout without retaining the signed-out subscription or re-enabling an explicit OFF',async()=>{
  const h=harness({subscribed:true,permission:'granted',posts:false,dailyVerse:false});assert.equal(await h.api.detach(h.adapter),true);
  assert.deepEqual(h.calls.requests.map(call=>call.body.action),['status','unsubscribe']);assert.equal(h.native.value,null);assert.equal(savedChoice(h.memory).value.enabled,true);assert.equal(savedChoice(h.memory).value.posts,false);assert.equal(savedChoice(h.memory).value.dailyVerse,false);
  const off=harness({subscribed:true,permission:'granted'});await off.controller.refresh();off.options.failure='unsubscribe';await off.controller.disable();off.options.failure=undefined;const before=off.calls.requests.length;await off.api.detach(off.adapter);
  assert.deepEqual(off.calls.requests.slice(before).map(call=>call.body.action),[]);assert.equal(off.native.value,null);assert.equal(savedChoice(off.memory).value.enabled,false);
});
test('automatic renewal preserves remembered topic OFF choices on an expired subscription and a new endpoint',async()=>{
  const first=await remembered({posts:false,dailyVerse:false});const record=savedChoice(first.memory);record.value.posts=false;record.value.dailyVerse=false;first.memory.set(record.name,JSON.stringify(record.value));
  const h=harness({permission:'granted',inactive:true,memory:first.memory,posts:false,dailyVerse:false,freshEndpoint:'https://push.example.test/auto-renewed'});await h.controller.refresh();assert.equal(await h.controller.restore(),true);
  assert.equal(h.calls.prompts,0);assert.equal(h.calls.unsubscribe,1);assert.deepEqual(h.calls.requests.find(call=>call.body.action==='subscribe').body.preferences,{posts:false,dailyVerse:false});assert.equal(h.controller.snapshot().subscribed,true);
});
test('network failure or a bounded automatic restoration timeout preserves intent without prompting or fabricating success',async()=>{
  const first=await remembered();
  const failed=harness({permission:'granted',memory:new Map(first.memory),failure:'subscribe'});await failed.controller.refresh();assert.equal(await failed.controller.restore(),false);assert.equal(failed.calls.prompts,0);assert.equal(failed.controller.snapshot().subscribed,false);assert.equal(savedChoice(failed.memory).value.enabled,true);
  const slow=harness({permission:'granted',memory:new Map(first.memory),fastTimers:true});await slow.controller.refresh();slow.adapter.getAccessToken=()=>new Promise(()=>{});slow.controller.destroy();const controller=slow.api.createController(slow.adapter);
  assert.equal(await controller.refresh(),false);assert.equal(controller.snapshot().errorCode,'timeout');assert.equal(controller.snapshot().busy,false);assert.equal(slow.calls.prompts,0);assert.equal(savedChoice(slow.memory).value.enabled,true);controller.destroy();
});
test('changing the account or saved OFF choice during automatic restoration stops before native or server registration',async()=>{
  const first=await remembered();
  for(const change of ['account','off','owner']){
    const h=harness({permission:'granted',memory:new Map(first.memory)});await h.controller.refresh();let finish;h.registration.pushManager.getSubscription=()=>new Promise(resolve=>{finish=resolve;});
    const pending=h.controller.restore();await new Promise(setImmediate);assert.equal(typeof finish,'function');
    if(change==='account')h.endSession();else if(change==='owner')h.memory.set('growell_push_owner_v1','later-member');else{const record=savedChoice(h.memory);record.value.enabled=false;record.value.revision='f'.repeat(32);h.memory.set(record.name,JSON.stringify(record.value));}
    finish(null);assert.equal(await pending,false);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.requests.some(call=>call.body.action==='subscribe'),false);
  }
});
test('all ownership-changing transactions use one origin-wide device lock including another member and logout',async()=>{
  const locks=createLocks(),h=harness({permission:'granted',locks});await h.controller.refresh();await h.controller.enable();await h.controller.preferences({posts:false,dailyVerse:true});await h.controller.disable();await h.controller.enable();await h.api.detach(h.adapter);
  const other=harness({permission:'granted',memberKey:'ANOTHER_SYNTHETIC_MEMBER',locks});await other.controller.refresh();await other.controller.enable();
  assert.equal(locks.calls.length,6);assert.equal(new Set(locks.calls).size,1);assert.equal(locks.calls[0],'growell-web-push-device-v1');assert.doesNotMatch(locks.calls.join(''),/SYNTHETIC|PRIVATE|endpoint/);
});
test('an OFF queued behind an in-flight automatic renewal cannot finish first or leave a receiving endpoint alive',async()=>{
  const first=await remembered(),locks=createLocks(),backend={active:true,prefs:{posts:true,dailyVerse:true},endpoint:first.subscription.endpoint},native=first.native;
  const off=harness({permission:'granted',locks,backend,native,memory:first.memory});await off.controller.refresh();assert.equal(off.controller.snapshot().subscribed,true);
  backend.active=false;let finish;const pendingServer=new Promise(resolve=>{finish=resolve;});
  const auto=harness({permission:'granted',inactive:true,locks,backend,native,memory:first.memory,freshEndpoint:'https://push.example.test/queued-auto-endpoint',fetchDeferred:pendingServer,fetchDeferredAction:'subscribe'});await auto.controller.refresh();
  const restoring=auto.controller.restore();await new Promise(setImmediate);assert.equal(auto.calls.requests.at(-1).body.action,'subscribe');assert.equal(native.value.endpoint,'https://push.example.test/queued-auto-endpoint');
  const disabling=off.controller.disable();await new Promise(setImmediate);assert.equal(off.calls.requests.some(call=>call.body.action==='unsubscribe'),false,'OFF must wait until the preceding subscribe transaction settles');
  backend.active=true;backend.endpoint=native.value.endpoint;finish({ok:true,json:async()=>({ok:true})});assert.equal(await restoring,false);assert.equal(await disabling,true);
  assert.equal(native.value,null);assert.equal(savedChoice(first.memory).value.enabled,false);assert.equal(auto.calls.unsubscribe,1,'the unconfirmed fresh automatic endpoint is retired before releasing the lock');
});
test('an uncertain automatic subscribe retires its exact fresh endpoint before a late server commit and a queued OFF',async()=>{
  const first=await remembered(),locks=createLocks(),backend={active:true,prefs:{posts:true,dailyVerse:true},endpoint:first.subscription.endpoint},native=first.native;
  const off=harness({permission:'granted',locks,backend,native,memory:first.memory});await off.controller.refresh();backend.active=false;
  let finish;const response=new Promise(resolve=>{finish=resolve;}),auto=harness({permission:'granted',inactive:true,locks,backend,native,memory:first.memory,freshEndpoint:'https://push.example.test/uncertain-auto',fetchDeferred:response,fetchDeferredAction:'subscribe'});await auto.controller.refresh();const restoring=auto.controller.restore();await new Promise(setImmediate);
  const created=native.value,disabling=off.controller.disable();finish({ok:false,status:503,json:async()=>({error:'timeout'})});assert.equal(await restoring,false);await disabling;
  assert.equal(native.value,null);assert.equal(auto.calls.unsubscribe,1);assert.equal(savedChoice(first.memory).value.enabled,false);
  backend.endpoint=created.endpoint;backend.active=true;assert.equal(native.value,null,'a commit after the uncertain response can only point at the retired native endpoint');
});
test('automatic failure cleanup never unsubscribes a different endpoint that appeared later',async()=>{
  const first=await remembered(),h=harness({permission:'granted',memory:first.memory,failure:'subscribe',freshEndpoint:'https://push.example.test/failed-auto'});await h.controller.refresh();let touched=0;
  h.options.onFetch=body=>{if(body.action==='subscribe')h.native.value={endpoint:'https://push.example.test/later-owner',unsubscribe(){touched++;return Promise.resolve(true);}};};
  assert.equal(await h.controller.restore(),false);assert.equal(h.native.value.endpoint,'https://push.example.test/later-owner');assert.equal(touched,0);assert.equal(h.calls.unsubscribe,0);
});
test('without a cross-tab lock automatic restoration stays off while an explicit settings gesture remains available',async()=>{
  const first=await remembered(),h=harness({permission:'granted',noLocks:true,memory:first.memory});await h.controller.refresh();assert.equal(await h.controller.restore(),false);assert.equal(h.calls.subscriptions,0);assert.equal(h.calls.prompts,0);
  assert.equal(await h.controller.enable(),true);assert.equal(h.calls.subscriptions,1);assert.equal(h.calls.prompts,0);
});
test('a delayed legacy status cannot overwrite a device owner that changed while its request was pending',async()=>{
  let finish;const delayed=new Promise(resolve=>{finish=resolve;}),h=harness({permission:'granted',subscribed:true,fetchDeferred:delayed,fetchDeferredAction:'status'});const refreshing=h.controller.refresh();await new Promise(setImmediate);h.memory.set('growell_push_owner_v1','later-owner');finish({ok:true,json:async()=>({configured:true,subscription:{active:true,preferences:{posts:true,dailyVerse:true}}})});assert.equal(await refreshing,true);
  assert.equal(h.memory.get('growell_push_owner_v1'),'later-owner');assert.equal([...h.memory.keys()].some(name=>name.startsWith('growell_push_choice_v1:')),false);
});
function workerHarness(windows=[]){
  const events={},notifications=[],opened=[],c={URL,Promise,self:{location:{origin:'https://growell-book.vercel.app'},addEventListener:(name,fn)=>events[name]=fn,
    registration:{showNotification(title,settings){notifications.push({title,settings});return Promise.resolve();}},skipWaiting:()=>Promise.resolve(),clients:{claim:()=>Promise.resolve(),matchAll:()=>Promise.resolve(windows),openWindow:url=>{opened.push(url);return Promise.resolve();}}}};
  vm.createContext(c);vm.runInContext(workerSource,c);
  async function push(payload,malformed=false){let waiting;events.push({data:{json(){if(malformed)throw Error('bad json');return payload;}},waitUntil:value=>{waiting=value;}});if(waiting)await waiting;}
  async function click(data){let waiting;events.notificationclick({notification:{data,close(){}},waitUntil:value=>{waiting=value;}});await waiting;}
  return {events,notifications,opened,push,click};
}
test('worker publishes only allowlisted posts with generic text, opaque tag and a validated route',async()=>{
  const h=workerHarness();await h.push({version:1,type:'post',tag:'post:opaque123',bookId:'emotion',postId:'p_abc123',body:'PRIVATE SOURCE',url:'https://evil.test'});
  assert.equal(h.notifications.length,1);assert.match(h.notifications[0].settings.body,/새로운 나눔/);
  assert.doesNotMatch(JSON.stringify(h.notifications),/PRIVATE|evil/);assert.equal(h.notifications[0].settings.tag,'growell-post:opaque123');assert.equal(h.notifications[0].settings.renotify,false);
  await h.click(h.notifications[0].settings.data);assert.equal(h.opened[0],'https://growell-book.vercel.app/#/book/emotion/share/post/p_abc123');
});
test('worker carries the exact daily verse and ignores malformed payloads or unsafe identifiers',async()=>{
  const h=workerHarness();await h.push({version:1,type:'verse',tag:'verse:20261017',body:'말씀 예시 · 시편 1:1'});
  assert.equal(h.notifications[0].settings.body,'말씀 예시 · 시편 1:1');await h.click(h.notifications[0].settings.data);assert.equal(h.opened[0],'https://growell-book.vercel.app/#/');
  for(const payload of [null,[],{version:2,type:'test',tag:'test'},{version:1,type:'test',tag:'../unsafe'},{version:1,type:'post',tag:'post1',bookId:'emotion',postId:'../evil'},{version:1,type:'post',tag:'post1',bookId:'unknown',postId:'p1'},{version:1,type:'verse',tag:'verse1',body:'x'.repeat(801)}])await h.push(payload);
  await h.push(null,true);assert.equal(h.notifications.length,1);
});
test('test push is fixed text and clicking focuses exact destinations while preserving other drafts',async()=>{
  let focused=0,navigated=0;const h=workerHarness([{url:'https://growell-book.vercel.app/#/book/emotion/share/post/p_1',focus(){focused++;return Promise.resolve();}},{url:'https://growell-book.vercel.app/#/book/emotion/mine',navigate(){navigated++;}}]);
  await h.push({version:1,type:'test',tag:'test:opaque',body:'PRIVATE',url:'https://evil.test'});assert.doesNotMatch(JSON.stringify(h.notifications),/PRIVATE|evil/);
  await h.click({kind:'growell-push',type:'post',bookId:'emotion',postId:'p_1'});assert.equal(focused,1);assert.equal(h.opened.length,0);assert.equal(navigated,0);
  await h.click({kind:'growell-push',type:'post',bookId:'action',postId:'p_other'});assert.equal(h.opened.length,1);assert.equal(navigated,0);
});
