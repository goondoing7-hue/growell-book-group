'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Google=require('../googleConnection.js');
const Drive=require('../driveBackup.js');
const Calendar=require('../meetingCalendar.js');
const origin='https://growell-book.vercel.app';
const response=(value,extra={})=>({ok:true,status:200,json:async()=>value,...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const connected=(overrides={})=>({configured:true,connected:true,enabled:true,accountEmail:'fixture@example.invalid',...overrides});
const joint=(overrides={})=>({configured:true,drive:connected({lastBackedUpAt:'2026-10-11T01:00:00Z'}),calendar:connected({lastSyncedAt:'2026-10-11T02:00:00Z'}),mail:connected({latestStatus:'none',pendingCount:0,lastSentAt:null}),sameAccount:true,connected:true,partial:false,unavailable:false,...overrides});
function harness(extra={}){
  let current=true;const calls=[];
  const client=Google.createClient({isCurrent:()=>current,getAccessToken:async()=> 'SYNTHETIC_MEMBER_TOKEN',fetch:async(url,options)=>{calls.push({url,options});return response(url.endsWith('action=config')?{configured:true}:joint());},...extra});
  return {client,calls,setCurrent:value=>{current=value;}};
}

test('initial load checks both service configs then obtains authenticated joint account status',async()=>{
  const box=harness(),entries=await box.client.load(true);
  assert.deepEqual(box.calls.map(call=>call.url),['/api/drive-backup?action=config','/api/meeting-calendar?action=config','/api/drive-backup?action=google-status']);
  assert.equal(entries.sameAccount,true);assert.equal(Google.summaryView(entries).sameAccount,true);
  for(const {url,options} of box.calls){
    assert.equal(options.mode,'same-origin');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(options.headers.Authorization,url.endsWith('action=config')?undefined:'Bearer SYNTHETIC_MEMBER_TOKEN');
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);
  }
  box.client.dispose();
});

test('refresh uses server subject comparison rather than comparing account email text',async()=>{
  const box=harness({fetch:async()=>response(joint({drive:connected({accountEmail:'a@example.invalid'}),calendar:connected({accountEmail:'b@example.invalid'})}))});
  const entries=await box.client.load(false);assert.equal(Google.summaryView(entries).kind,'connected');assert.equal(Google.summaryView(entries).showConnect,false);
  entries.sameAccount=false;entries.calendar.status.accountEmail=entries.drive.status.accountEmail;
  const summary=Google.summaryView(entries);assert.equal(summary.kind,'mismatch');assert.equal(summary.sameAccount,false);assert.equal(summary.showConnect,true);assert.match(summary.text,/자동으로 합치지/);
  entries.sameAccount=null;assert.equal(Google.summaryView(entries).kind,'unknown');box.client.dispose();
});

test('one unavailable service cannot become a completed shared connection',async()=>{
  const box=harness({fetch:async()=>response(joint({calendar:{configured:true,connected:null,enabled:null,unavailable:true,errorCode:'service-unavailable'},sameAccount:null,connected:null,partial:true,unavailable:true}))});
  const entries=await box.client.load(false);assert.equal(entries.drive.status.connected,true);assert.equal(entries.calendar.status,null);assert.equal(entries.calendar.error.code,'service-unavailable');
  const summary=Google.summaryView(entries);assert.equal(summary.kind,'error');assert.equal(summary.sameAccount,false);assert.equal(summary.email,'');assert.equal(summary.canConnect,true);box.client.dispose();
});

test('unprepared Calendar keeps known Drive status without a claim of joint connection',async()=>{
  const calls=[];const box=harness({fetch:async(url)=>{calls.push(url);return response(url==='/api/meeting-calendar?action=config'?{configured:false}:url.endsWith('action=config')?{configured:true}:connected());}});
  const entries=await box.client.load(true);assert.equal(entries.drive.status.connected,true);assert.equal(entries.calendar.status.configured,false);
  assert.deepEqual(calls,['/api/drive-backup?action=config','/api/meeting-calendar?action=config','/api/drive-backup?action=status']);
  assert.equal(Google.summaryView(entries).kind,'setup');assert.equal(Google.summaryView(entries).canConnect,false);box.client.dispose();
});

test('status sanitization removes tokens, unsafe URLs and malformed dates',()=>{
  const status=Google.statusView('calendar',connected({lastSyncedAt:'invalid',pendingCount:'3',accountEmail:'fixture@example.invalid',token:'PRIVATE_SECRET',errorCode:'<script>'}));
  assert.equal(status.lastSyncedAt,'');assert.equal(status.pending,false);assert.equal(status.errorCode,'');assert.doesNotMatch(JSON.stringify(status),/PRIVATE_SECRET|token|script/);
  for(const value of [null,{}, {configured:true,connected:null},{configured:true,connected:'true'}])assert.throws(()=>Google.statusView('calendar',value),{code:'unavailable'});
  const drive=Google.statusView('drive',connected({folderUrl:'javascript:alert(1)'}));assert.equal(drive.folderUrl,'');
});

test('configure and sync keep service controls independent and strip arbitrary payload',async()=>{
  const box=harness();
  await box.client.request('drive','configure',{enabled:false,userId:'PRIVATE_OWNER',records:'PRIVATE_RECORD'});
  await box.client.request('calendar','configure',{enabled:true,refreshToken:'PRIVATE_SECRET'});
  await box.client.request('calendar','sync',{records:'PRIVATE_RECORD'});
  assert.deepEqual(box.calls.map(call=>[call.url,JSON.parse(call.options.body)]),[
    ['/api/drive-backup?action=configure',{enabled:false}],['/api/meeting-calendar?action=configure',{enabled:true}],['/api/meeting-calendar?action=sync',{}]
  ]);
  await box.client.request('drive','disconnect',{records:'PRIVATE_RECORD'});await box.client.request('calendar','disconnect',{userId:'PRIVATE_OWNER'});
  assert.deepEqual(box.calls.slice(-2).map(call=>[call.url,JSON.parse(call.options.body)]),[['/api/drive-backup?action=disconnect',{}],['/api/meeting-calendar?action=disconnect',{}]]);
  for(const [service,action] of [['mail','disconnect'],['calendar','connect'],['__proto__','configure'],['drive','worker']])await assert.rejects(box.client.request(service,action,{}),{code:'invalid_action'});
  box.client.dispose();
});

test('unified connect uses only Drive registered callback flow',async()=>{
  const box=harness();await box.client.connect();assert.equal(box.calls.length,1);assert.equal(box.calls[0].url,'/api/drive-backup?action=connect');assert.deepEqual(JSON.parse(box.calls[0].options.body),{});box.client.dispose();
});

test('replaced member sessions never issue requests using a previous access token',async()=>{
  const token=deferred(),box=harness({getAccessToken:()=>token.promise});const pending=box.client.load(false);await flush();box.setCurrent(false);token.resolve('PREVIOUS_MEMBER_TOKEN');
  await assert.rejects(pending,{code:'session_changed'});assert.equal(box.calls.length,0);box.client.dispose();
});

test('disposing joint status aborts its request and rejects late results',async()=>{
  const answer=deferred();let signal;const box=harness({fetch:async(url,options)=>{signal=options.signal;return answer.promise;}});
  const pending=box.client.load(false);await flush();box.client.dispose();assert.equal(signal.aborted,true);answer.resolve(response(joint()));await assert.rejects(pending,{code:'session_changed'});
});

class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.hidden=false;this.disabled=false;this.checked=false;this.open=false;this.textContent='';this.attributes={};this.nodes={};this.events={};this.classes=new Set();this.classList={toggle:(name,value)=>value?this.classes.add(name):this.classes.delete(name),add:name=>this.classes.add(name)};}
  set innerHTML(html){this.html=html;this.nodes={};for(const [,tag,attributes] of html.matchAll(/<([a-z]+)\b([^>]*)>/g)){const attrs=[...attributes.matchAll(/\b(data-[a-z-]+)(?:="[^"]*")?/g)];if(!attrs.length)continue;const node=new Element(tag);node.hidden=/\bhidden\b/.test(attributes);for(const [,attr] of attrs)this.nodes['['+attr+']']=node;}}
  get innerHTML(){return this.html;}
  querySelector(selector){assert.ok(this.nodes[selector],'fixture selector '+selector);return this.nodes[selector];}
  querySelectorAll(selectors){return selectors.split(',').map(selector=>this.nodes[selector]).filter(Boolean);}
  setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this.attributes[name];if(name==='href')this.href='';}
  addEventListener(type,listener){(this.events[type]||=[]).push(listener);}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){this.removed=true;}
  getBoundingClientRect(){return {left:0,right:500,top:0,bottom:500};}
}
function uiHarness(extra={}){
  let current=true;const calls=[],navigation=[],documentEvents={},dialogs=[],history=[];
  const document={hidden:false,body:{appendChild(node){dialogs.push(node);}},createElement:tag=>new Element(tag),addEventListener(type,listener){(documentEvents[type]||=[]).push(listener);},removeEventListener(type,listener){documentEvents[type]=(documentEvents[type]||[]).filter(item=>item!==listener);}};
  const root={document,URL,Promise,Date,setTimeout,clearTimeout,AbortController,GrowellDriveBackup:Drive,GrowellMeetingCalendar:Calendar,
    fetch:async(url,options)=>{calls.push({url,options});return response(url.endsWith('action=config')?{configured:true}:joint());},
    location:{origin,assign(url){navigation.push(url);}},addEventListener(){},GrowellPopupHistory:{open(id){history.push('open:'+id);},closed(id){history.push('close:'+id);}},...extra.root};
  vm.createContext(root);if(extra.webPush)vm.runInContext(fs.readFileSync(path.join(__dirname,'../webPush.js'),'utf8'),root);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../googleConnection.js'),'utf8'),root);
  const options={isCurrent:()=>current,getAccessToken:async()=> 'SYNTHETIC_MEMBER_TOKEN',...extra.options};root.GrowellGoogleConnection.open(options);
  return {root,calls,navigation,documentEvents,history,node:dialogs.at(-1),setCurrent:value=>{current=value;},q(selector){return this.node.querySelector(selector);},close(){root.GrowellGoogleConnection.close(false);}};
}

test('the dialog displays three services with separate switches and a validated Drive folder',async()=>{
  const url='https://drive.google.com/drive/folders/Fixture_123';const box=uiHarness({root:{fetch:async(urlPath)=>response(urlPath.endsWith('action=config')?{configured:true}:joint({drive:connected({folderUrl:url})}))}});await flush();
  assert.equal(box.q('[data-google-connect]').hidden,true);assert.equal(box.q('[data-google-drive-enabled]').checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);
  assert.equal(box.q('[data-google-mail-enabled]').checked,true);assert.match(box.node.html,/모임 기록 PDF 이메일/);assert.match(box.node.html,/이미 보낸 기록을 수정해도 다시 보내지/);assert.doesNotMatch(box.node.html,/data-google-mail-sync/);
  assert.equal(box.q('[data-google-mail-email]').hidden,false);assert.equal(box.q('[data-google-mail-email]').textContent,'fixture@example.invalid');
  assert.equal(box.q('[data-google-drive-folder]').href,url);assert.equal(box.q('[data-google-drive-folder]').hidden,false);assert.match(box.q('[data-google-summary]').textContent,/같은 Google 계정/);assert.equal(box.node.open,true);box.close();
});

test('mail status rejects malformed connection data and strips unsafe fields',()=>{
  for(const value of [null,{}, {configured:true,connected:null},{configured:true,connected:'true'}])assert.throws(()=>Google.statusView('mail',value),{code:'unavailable'});
  const status=Google.statusView('mail',connected({lastSentAt:'invalid',latestStatus:'<script>',pendingCount:'3',recipientId:'PRIVATE_OWNER',refreshToken:'PRIVATE_SECRET',errorCode:'<script>'}));
  assert.equal(status.lastSentAt,'');assert.equal(status.latestStatus,'');assert.equal(status.pending,false);assert.equal(status.errorCode,'');assert.doesNotMatch(JSON.stringify(status),/PRIVATE_OWNER|PRIVATE_SECRET|script/);
  assert.match(Google.stateText('mail',status),/자동 발송 켜짐/);assert.doesNotMatch(Google.stateText('mail',status),/완료/);
});

test('uncertain mail delivery remains distinct from confirmed sent status',()=>{
  const mail=Google.statusView('mail',connected({latestStatus:'uncertain',errorCode:'delivery-uncertain',lastSentAt:'2026-10-11T01:00:00Z'}));
  assert.match(Google.stateText('mail',mail),/미확인/);assert.doesNotMatch(Google.stateText('mail',mail),/발송 완료/);
  assert.match(Google.stateText('mail',Google.statusView('mail',connected({latestStatus:'sent'}))),/발송 완료/);
  assert.match(Google.message('mail',{code:'delivery-uncertain'}),/중복 발송/);
});

test('a stopped PDF preparation failure stays distinct from an uncertain delivered email',()=>{
  const status=Google.statusView('mail',connected({latestStatus:'failed',errorCode:'pdf-unavailable',pendingCount:0}));
  assert.equal(status.latestStatus,'failed');assert.match(Google.stateText('mail',status),/PDF 이메일 준비 실패/);assert.doesNotMatch(Google.stateText('mail',status),/미확인|발송 완료/);
});

test('mail unavailable or unconfigured does not pretend delivery succeeded or disable Google connect',async()=>{
  for(const mail of [{configured:false},{unavailable:true,errorCode:'service-unavailable'}]){
    const box=uiHarness({root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:joint({mail}))}});await flush();
    assert.equal(box.q('[data-google-mail-connected]').hidden,true);assert.equal(box.q('[data-google-mail-enabled]').disabled,true);
    assert.doesNotMatch(box.q('[data-google-mail-status]').textContent,/발송 완료/);assert.equal(box.q('[data-google-connect]').disabled,false);
    assert.equal(box.q('[data-google-drive-enabled]').checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);box.close();
  }
});

test('mail configure uses one owner authenticated request with enabled-only payload',async()=>{
  const box=harness();await box.client.request('mail','configure',{enabled:false,userId:'PRIVATE_OWNER',email:'OTHER_OWNER',records:'PRIVATE_RECORD'});
  assert.deepEqual(box.calls.map(call=>[call.url,JSON.parse(call.options.body)]),[['/api/drive-backup?action=mail-configure',{enabled:false}]]);
  assert.equal(box.calls[0].options.headers.Authorization,'Bearer SYNTHETIC_MEMBER_TOKEN');
  for(const action of ['sync','connect','send','disconnect'])await assert.rejects(box.client.request('mail',action,{}),{code:'invalid_action'});box.client.dispose();
});

test('failed mail switch save rolls back without changing Drive or Calendar settings',async()=>{
  const box=uiHarness({root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:url.endsWith('action=mail-configure')?{error:'service-unavailable'}:joint(),url.endsWith('action=mail-configure')?{ok:false,status:503}:{})}});await flush();
  const toggle=box.q('[data-google-mail-enabled]');toggle.checked=false;toggle.onchange();await flush();
  assert.equal(toggle.checked,true);assert.equal(box.q('[data-google-drive-enabled]').checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);
  assert.match(box.q('[data-google-mail-status]').textContent,/확인하지 못/);box.close();
});

test('mail configuration stops before network if current member is replaced while obtaining token',async()=>{
  const token=deferred(),box=harness({getAccessToken:()=>token.promise});const pending=box.client.request('mail','configure',{enabled:true});await flush();box.setCurrent(false);token.resolve('OLD_MEMBER_TOKEN');
  await assert.rejects(pending,{code:'session_changed'});assert.equal(box.calls.length,0);box.client.dispose();
});

test('Microsoft reminder settings close the Google dialog without triggering Google OAuth',async()=>{
  let opened=0;const box=uiHarness({options:{onReminderSettings(){opened++;assert.equal(box.node.removed,true);assert.equal(box.documentEvents.visibilitychange.length,0);}}});await flush();
  assert.equal(box.q('[data-google-reminder]').hidden,false);assert.match(box.node.html,/Microsoft 계정을 한 번 더 연결/);
  assert.match(box.node.html,/같은 책·해당 회차에 회원이 공개한 통찰/);assert.match(box.node.html,/개인 기록과 공개하지 않은 글은 포함하지/);
  box.q('[data-google-reminder-open]').onclick();assert.equal(opened,1);assert.equal(box.calls.some(call=>call.url.endsWith('action=connect')),false);assert.equal(box.navigation.length,0);box.close();
});

test('Google login settings are available to ordinary members without starting the backup OAuth flow',async()=>{
  let opened=0;const box=uiHarness({options:{onGoogleLoginSettings(){opened++;assert.equal(box.node.removed,true);assert.equal(box.documentEvents.visibilitychange.length,0);}}});await flush();
  assert.equal(box.q('[data-google-login]').hidden,false);assert.match(box.node.html,/Google 로그인 설정/);assert.match(box.node.html,/기존 아이디 로그인과 작성한 기록은 그대로/);
  box.q('[data-google-login-open]').onclick();assert.equal(opened,1);assert.equal(box.calls.some(call=>call.url.endsWith('action=connect')),false);assert.equal(box.navigation.length,0);box.close();
});

test('Google login entry stays hidden without its adapter and cannot open after the member changes',async()=>{
  const unavailable=uiHarness();await flush();assert.equal(unavailable.q('[data-google-login]').hidden,true);unavailable.close();
  let opened=0;const box=uiHarness({options:{onGoogleLoginSettings(){opened++;}}});await flush();box.setCurrent(false);box.q('[data-google-login-open]').onclick();assert.equal(opened,0);assert.equal(box.node.removed,undefined);box.close();
});

test('failed checkbox saves roll back the displayed setting and preserve the other service',async()=>{
  const box=uiHarness({root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:url.includes('action=configure')?{error:'unavailable'}:joint(),url.includes('action=configure')?{ok:false,status:503}:{})}});await flush();
  const enabled=box.q('[data-google-drive-enabled]');enabled.checked=false;enabled.onchange();await flush();
  assert.equal(enabled.checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);assert.match(box.q('[data-google-drive-status]').textContent,/확인하지 못/);
  assert.doesNotMatch(box.q('[data-google-summary]').textContent,/같은 Google 계정/);box.close();
});

test('a partial OAuth return shows verified child states without declaring full connection',async()=>{
  const box=uiHarness({options:{connectionResult:'partial'},root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:joint({calendar:connected({connected:false,enabled:false,accountEmail:''}),sameAccount:false,connected:false,partial:true}))}});await flush();
  assert.equal(box.q('[data-google-return]').hidden,false);assert.match(box.q('[data-google-return]').textContent,/일부 Google 연결/);assert.equal(box.q('[data-google-connect]').hidden,false);assert.equal(box.q('[data-google-connect]').textContent,'Google 계정 다시 연결');
  assert.match(box.q('[data-google-calendar-status]').textContent,/아직 연결하지/);assert.doesNotMatch(box.q('[data-google-summary]').textContent,/같은 Google 계정/);box.close();
});

test('unfinished drafts block OAuth before connect requests or navigation',async()=>{
  const box=uiHarness({options:{beforeConnect:async()=>{throw Object.assign(new Error('PRIVATE_DRAFT'),{code:'draft_not_saved'});}},root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:joint({drive:connected({connected:false,enabled:false}),calendar:connected({connected:false,enabled:false}),sameAccount:false,connected:false}))}});await flush();
  box.q('[data-google-connect]').onclick();await flush();assert.equal(box.navigation.length,0);assert.equal(box.calls.some(call=>call.url.endsWith('action=connect')),false);assert.equal(box.q('[data-google-summary]').textContent,'작성 중인 내용을 먼저 저장하거나 편집을 마친 뒤 연결해주세요.');box.close();
});

test('OAuth navigation rejects calendar-only callbacks and arbitrary remote URLs',async()=>{
  for(const target of ['https://evil.example/login','https://accounts.google.com/o/oauth2/v2/auth?redirect_uri='+encodeURIComponent(origin+'/api/meeting-calendar')]){
    const box=uiHarness({root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:url.endsWith('action=connect')?{url:target}:joint({drive:connected({connected:false,enabled:false}),calendar:connected({connected:false,enabled:false}),sameAccount:false,connected:false}))}});await flush();
    box.q('[data-google-connect]').onclick();await flush();assert.equal(box.navigation.length,0);assert.match(box.q('[data-google-summary]').textContent,/확인하지 못/);box.close();
  }
  const target='https://accounts.google.com/o/oauth2/v2/auth?redirect_uri='+encodeURIComponent(origin+'/api/drive-backup');
  const box=uiHarness({root:{fetch:async(url)=>response(url.endsWith('action=config')?{configured:true}:url.endsWith('action=connect')?{url:target}:joint({drive:connected({connected:false,enabled:false}),calendar:connected({connected:false,enabled:false}),sameAccount:false,connected:false}))}});await flush();box.q('[data-google-connect]').onclick();await flush();assert.deepEqual(box.navigation,[target]);box.close();
});

test('closing the dialog aborts late loads, removes observers and restores focus once',async()=>{
  const answer=deferred();let signal,restored=0;const box=uiHarness({options:{restoreFocus(){restored++;}},root:{fetch:async(url,options)=>{if(url.endsWith('action=config'))return response({configured:true});signal=options.signal;return answer.promise;}}});await flush();
  box.q('[data-google-close]').onclick();assert.equal(signal.aborted,true);assert.equal(box.node.removed,true);assert.equal(box.documentEvents.visibilitychange.length,0);assert.equal(restored,1);assert.deepEqual(box.history,['open:google-connection','close:google-connection']);
  answer.resolve(response(joint({drive:connected({accountEmail:'OLD_MEMBER@example.invalid'})})));await flush();assert.doesNotMatch(box.node.html+box.q('[data-google-summary]').textContent,/OLD_MEMBER/);box.close();assert.equal(restored,1);
});

test('administrator details open only after disposing the unified dialog',async()=>{
  let opened=false;const box=uiHarness({options:{isAdmin:true,onCalendarDetails(){opened=true;assert.equal(box.node.removed,true);assert.equal(box.documentEvents.visibilitychange.length,0);}}});await flush();
  assert.equal(box.q('[data-google-drive-details]').hidden,true);assert.equal(box.q('[data-google-calendar-details]').hidden,false);box.q('[data-google-calendar-details]').onclick();assert.equal(opened,true);box.close();
});

function pushBrowser(){
  const key=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,9)]).toString('base64url');
  const subscription={endpoint:'https://push.example.invalid/PRIVATE_DEVICE_ENDPOINT',toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'PRIVATE_KEY',auth:'PRIVATE_AUTH'}};},unsubscribe:async()=>true};
  return {key,root:{isSecureContext:true,PushManager:function(){},Notification:{permission:'granted',requestPermission(){throw Error('must not prompt on opening');}},
    atob:value=>Buffer.from(value,'base64').toString('binary'),navigator:{userAgent:'Windows',serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:async()=>subscription}})}}}};
}

test('push preferences remain usable while Google services are still loading',async()=>{
  const fixture=pushBrowser(),google=deferred(),requests=[];let preferences={posts:false,dailyVerse:true};
  const box=uiHarness({webPush:true,root:{...fixture.root,fetch:async(url,settings)=>{
    requests.push({url,settings});if(url==='/api/web-push'){
      const body=JSON.parse(settings.body);if(body.action==='config')return response({configured:true,publicKey:fixture.key});
      if(body.action==='preferences'){preferences=body.preferences;return response({ok:true});}
      return response({configured:true,subscription:{active:true,preferences}});
    }
    return url.endsWith('action=config')?response({configured:true}):google.promise;
  }}});await flush();
  const push=box.q('[data-google-push]'),q=selector=>push.querySelector(selector);
  assert.match(box.node.html,/<h2 id="google-connection-title">설정<\/h2>/);
  assert.equal(box.q('[data-google-drive-enabled]').disabled,true,'Google status is still loading');
  assert.equal(q('[data-push-settings]').hidden,false);assert.equal(q('[data-push-posts]').disabled,false);
  assert.equal(q('[data-push-posts]').checked,false);assert.equal(q('[data-push-verse]').checked,true);
  q('[data-push-verse]').checked=false;q('[data-push-verse]').onchange();await flush();
  assert.equal(q('[data-push-verse]').checked,false);assert.deepEqual(preferences,{posts:false,dailyVerse:false});
  const write=requests.find(call=>call.url==='/api/web-push'&&JSON.parse(call.settings.body).action==='preferences');
  assert.equal(write.settings.headers.Authorization,'Bearer SYNTHETIC_MEMBER_TOKEN');
  google.resolve(response(joint()));await flush();assert.equal(box.q('[data-google-drive-enabled]').checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);box.close();
});

test('Google connection failures do not block independently authenticated push settings',async()=>{
  const fixture=pushBrowser(),requests=[];
  const box=uiHarness({webPush:true,options:{isAdmin:true},root:{...fixture.root,fetch:async(url,settings)=>{
    requests.push(url);if(url==='/api/web-push')return response(JSON.parse(settings.body).action==='config'?{configured:true,publicKey:fixture.key}:{configured:true,subscription:{active:true,preferences:{posts:true,dailyVerse:true}}});
    throw Error('PRIVATE_GOOGLE_FAILURE');
  }}});await flush();
  assert.match(box.q('[data-google-summary]').textContent,/확인하지 못/);assert.equal(box.q('[data-google-drive-enabled]').disabled,true);
  const push=box.q('[data-google-push]');assert.equal(push.querySelector('[data-push-settings]').hidden,false);assert.equal(push.querySelector('[data-push-test]').disabled,false);
  assert.equal(requests.includes('/api/web-push'),true);assert.doesNotMatch(push.innerHTML+push.querySelector('[data-push-status]').textContent,/PRIVATE_GOOGLE_FAILURE|PRIVATE_DEVICE/);box.close();
});

test('closing connections destroys push requests and prevents late former-account state rendering',async()=>{
  const fixture=pushBrowser(),answer=deferred();let signal;
  const box=uiHarness({webPush:true,root:{...fixture.root,fetch:async(url,settings)=>{
    if(url==='/api/web-push'){
      if(JSON.parse(settings.body).action==='config')return response({configured:true,publicKey:fixture.key});
      signal=settings.signal;return answer.promise;
    }
    return response(url.endsWith('action=config')?{configured:true}:joint());
  }}});await flush();assert.ok(signal);const push=box.q('[data-google-push]'),before=push.querySelector('[data-push-status]').textContent;
  box.q('[data-google-close]').onclick();assert.equal(signal.aborted,true);assert.equal(box.node.removed,true);
  answer.resolve(response({configured:true,subscription:{active:true,preferences:{posts:true,dailyVerse:true}}}));await flush();
  assert.equal(push.querySelector('[data-push-status]').textContent,before);assert.equal(push.querySelector('[data-push-settings]').hidden,true);box.close();
});

test('replacing the member invalidates the push adapter and closes all connection observers',async()=>{
  const fixture=pushBrowser(),answer=deferred();let signal;
  const box=uiHarness({webPush:true,root:{...fixture.root,fetch:async(url,settings)=>{
    if(url==='/api/web-push'){
      if(JSON.parse(settings.body).action==='config')return response({configured:true,publicKey:fixture.key});
      signal=settings.signal;return answer.promise;
    }
    return response(url.endsWith('action=config')?{configured:true}:joint());
  }}});await flush();assert.ok(signal);box.setCurrent(false);box.root.GrowellGoogleConnection.refresh();
  assert.equal(signal.aborted,true);assert.equal(box.node.removed,true);assert.equal(box.documentEvents.visibilitychange.length,0);
  answer.resolve(response({configured:true,subscription:{active:true,preferences:{posts:false,dailyVerse:false}}}));await flush();
  assert.equal(box.q('[data-google-push]').querySelector('[data-push-settings]').hidden,true);box.close();
});

test('settings defaults to notifications and switches tabs without changing saved connection choices',async()=>{
  const box=uiHarness();await flush();
  assert.match(box.node.html,/<h2 id="google-connection-title">설정<\/h2>/);
  assert.equal(box.q('[data-settings-notifications-panel]').hidden,false);assert.equal(box.q('[data-settings-connections-panel]').hidden,true);
  assert.equal(box.q('[data-settings-notifications-tab]').attributes['aria-selected'],'true');assert.equal(box.q('[data-settings-notifications-tab]').tabIndex,0);
  const before=box.calls.length;box.q('[data-settings-connections-tab]').onclick();
  assert.equal(box.q('[data-settings-connections-panel]').hidden,false);assert.equal(box.q('[data-settings-notifications-panel]').hidden,true);
  assert.equal(box.q('[data-google-drive-enabled]').checked,true);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);
  box.q('[data-settings-notifications-tab]').onclick();assert.equal(box.calls.length,before,'tab selection has no write or connection side effect');
  assert.equal(box.q('[data-google-mail-enabled]').checked,true);box.close();
});

test('switching settings tabs resets the shared scroll position while the same tab and status reload preserve it',async()=>{
  const box=uiHarness({options:{isAdmin:true}});await flush();const scroll=box.q('[data-settings-scroll]');
  scroll.scrollTop=240;box.q('[data-settings-notifications-tab]').onclick();assert.equal(scroll.scrollTop,240);
  box.q('[data-google-refresh]').onclick();await flush();assert.equal(scroll.scrollTop,240);
  box.q('[data-settings-connections-tab]').onclick();assert.equal(scroll.scrollTop,0);
  scroll.scrollTop=360;box.q('[data-settings-connections-tab]').onclick();assert.equal(scroll.scrollTop,360);
  box.q('[data-settings-notifications-tab]').onclick();assert.equal(scroll.scrollTop,0);box.close();
});

test('home or OAuth connection entry selects connections and tab keys keep one selected focus target',async()=>{
  for(const options of [{tab:'connections'},{connectionResult:'connected'},{tab:'notifications',connectionResult:'partial'}]){
    const box=uiHarness({options});await flush();assert.equal(box.q('[data-settings-connections-panel]').hidden,false);
    let prevented=false;box.q('[data-settings-connections-tab]').events.keydown[0]({key:'Home',preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.equal(box.q('[data-settings-notifications-panel]').hidden,false);assert.equal(box.q('[data-settings-notifications-tab]').focused,true);
    assert.equal(box.q('[data-settings-connections-tab]').tabIndex,-1);box.close();
  }
});

test('ordinary members retain essential connections but cannot open administrator details or diagnostics',async()=>{
  let opened=0;const box=uiHarness({options:{onDriveDetails(){opened++;},onCalendarDetails(){opened++;},onReminderSettings(){opened++;}}});await flush();
  for(const service of ['drive','calendar']){
    assert.equal(box.q('[data-google-'+service+'-details]').hidden,true);
    box.q('[data-google-'+service+'-details]').onclick();assert.equal(opened,0,'a synthetic click cannot run an administrator callback');
    assert.equal(box.q('[data-google-'+service+'-enabled]').disabled,false);assert.equal(box.q('[data-google-'+service+'-disconnect]').disabled,false);
  }
  assert.equal(box.q('[data-google-scope]').hidden,true);assert.equal(box.q('[data-google-refresh]').hidden,true);
  const before=box.calls.length;box.q('[data-google-refresh]').onclick();await flush();assert.equal(box.calls.length,before);
  assert.equal(box.q('[data-google-mail-enabled]').disabled,false);assert.equal(box.q('[data-google-reminder]').hidden,false);
  assert.match(box.node.html,/삼성 리마인더에서 GROWELL 습관을 열고/);assert.match(box.node.html,/iOS 26\.2/);assert.match(box.node.html,/Microsoft 계정 목록에는 자동 적용할 수 없어요/);
  assert.doesNotMatch(box.node.html,/<select\b|importance.*high|알림 강도.*<input/);box.close();
  const admin=uiHarness({options:{isAdmin:true,onDriveDetails(){},onCalendarDetails(){}}});await flush();
  assert.equal(admin.q('[data-google-scope]').hidden,false);assert.equal(admin.q('[data-google-refresh]').hidden,false);
  assert.equal(admin.q('[data-google-drive-details]').hidden,false);assert.equal(admin.q('[data-google-calendar-details]').hidden,false);admin.close();
});

test('member disconnection requires its own confirmation and uses only the chosen existing service API',async()=>{
  const requests=[];let driveConnected=true;const box=uiHarness({options:{tab:'connections'},root:{fetch:async(url,settings)=>{
    requests.push({url,settings});
    if(url.endsWith('action=config'))return response({configured:true});
    if(url.endsWith('action=disconnect')){assert.equal(url,'/api/drive-backup?action=disconnect');assert.deepEqual(JSON.parse(settings.body),{});driveConnected=false;return response({ok:true});}
    return response(joint({drive:connected({connected:driveConnected,enabled:driveConnected})}));
  }}});await flush();const before=requests.length;
  box.q('[data-google-drive-disconnect]').onclick();assert.equal(box.q('[data-google-drive-confirm]').hidden,false);assert.equal(requests.length,before);
  box.q('[data-google-drive-cancel]').onclick();assert.equal(box.q('[data-google-drive-confirm]').hidden,true);assert.equal(requests.length,before);
  box.q('[data-google-drive-disconnect]').onclick();box.q('[data-google-drive-confirm-yes]').onclick();await flush();
  assert.equal(box.q('[data-google-drive-connected]').hidden,true);assert.equal(box.q('[data-google-drive-confirm]').hidden,true);
  assert.equal(box.q('[data-google-calendar-connected]').hidden,false);assert.equal(box.q('[data-google-calendar-enabled]').checked,true);
  assert.equal(requests.filter(call=>call.url.endsWith('action=disconnect')).length,1);assert.match(box.node.html,/저장한 기록과 이미 만들어진 백업 파일은 삭제되지 않아요/);box.close();
});

test('settings passes the verified member and strict administrator flag into the push pane',async()=>{
  for(const isAdmin of [false,true,'true',undefined]){
    let adapter;const box=uiHarness({options:{memberKey:'fixture-member-key',isAdmin},root:{GrowellWebPush:{mount(container,options){adapter=options;return{destroy(){}};}}}});await flush();
    assert.equal(adapter.memberKey,'fixture-member-key');assert.equal(adapter.isAdmin,isAdmin===true);assert.equal(adapter.isCurrent(),true);
    box.setCurrent(false);assert.equal(adapter.isCurrent(),false);box.close();
  }
});

test('the actual profile adapter opens notifications by default and keeps OAuth, home and administrator detail returns on connections',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const begin=html.indexOf('function openGoogleConnection('),end=html.indexOf('function handleGoogleConnectionReturn()',begin);assert.ok(begin>0&&end>begin);
  let captured,administrator=false;const calls=[],session={userId:'fixture-member'};
  const root={SESSION:session,saveSessionEpoch:7,location:{href:origin+'/#/'},isAdmin:()=>administrator,
    GrowellGoogleConnection:{open(options){captured=options;}},GrowellDriveBackup:{close(){}},GrowellMeetingCalendar:{close(){}},
    openDriveBackup(...args){calls.push(['drive',...args]);},openMeetingCalendar(...args){calls.push(['calendar',...args]);},openHabitReminder(...args){calls.push(['habit',...args]);},
    habitSyncAccessToken:async()=> 'SYNTHETIC_MEMBER_TOKEN'};
  vm.createContext(root);vm.runInContext(html.slice(begin,end),root);
  root.openGoogleConnection('profile-trigger');assert.equal(captured.tab,'notifications');assert.equal(captured.isAdmin,false);assert.equal(captured.memberKey,session.userId);
  captured.onDriveDetails();captured.onCalendarDetails();assert.deepEqual(calls,[]);
  captured.onReminderSettings();assert.deepEqual(calls,[['habit',null,'profile-trigger']]);
  root.openGoogleConnection('home-trigger','','connections');assert.equal(captured.tab,'connections');
  root.openGoogleConnection('profile-trigger','partial');assert.equal(captured.tab,'connections');assert.equal(captured.connectionResult,'partial');
  administrator=true;root.openGoogleConnection('admin-trigger');captured.onDriveDetails();captured.onCalendarDetails();assert.deepEqual(calls.slice(-2),[['drive','admin-trigger',true],['calendar','admin-trigger',true]]);
  root.SESSION={userId:'other-member'};captured.onDriveDetails();assert.equal(calls.length,3);assert.equal(captured.isCurrent(),false);
  assert.match(html,/id="btn-profile-drive-backup"[^>]*>설정<\/button>/);assert.doesNotMatch(html,/id="btn-grant-admin"[^>]*>운영자 코드 입력<\/button>/);
  assert.match(html,/openGoogleConnection\(trigger,'','connections'\)/);
});
