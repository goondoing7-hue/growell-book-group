'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const reminder=require('../habitReminder.js');

const origin='https://growell-book.vercel.app';
const callback=origin+'/api/habit-sync';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=(data={connected:false},extra={})=>({ok:true,status:200,json:async()=>data,...extra});
function harness(extra={}){
  let current=true,tokenReads=0;const calls=[];
  const client=reminder.createClient({isCurrent:()=>current,getAccessToken:()=>{tokenReads++;return Promise.resolve('SYNTHETIC_BEARER_TOKEN');},
    fetch:async(url,options)=>{calls.push({url,options});return response();},...extra});
  return {client,calls,setCurrent:value=>{current=value;},get tokenReads(){return tokenReads;}};
}
async function rejectsCode(promise,code){await assert.rejects(promise,error=>error.code===code);}

 test('default reminder times require exact 24-hour HH:mm strings',()=>{
  for(const value of ['00:00','09:05','21:00','23:59'])assert.equal(reminder.validTime(value),true,value);
  for(const value of ['',null,undefined,0,900,'9:00','24:00','12:60','09:00:00',' 09:00','09:00 ','9시','2026-10-02T09:00','09:00\n'])assert.equal(reminder.validTime(value),false,String(value));
});

test('config is an unauthenticated same-origin GET with no user data',async()=>{
  const box=harness();await box.client.request('config',{owner:'PRIVATE_OWNER',token:'PRIVATE_TOKEN'});
  assert.equal(box.tokenReads,0);assert.equal(box.calls.length,1);
  const {url,options}=box.calls[0];assert.equal(url,'/api/habit-sync?action=config');assert.equal(options.method,'GET');
  assert.deepEqual(options.headers,{Accept:'application/json'});assert.equal(options.body,undefined);
  assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.ok(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);
  assert.doesNotMatch(JSON.stringify({url,options}),/PRIVATE_/);
});

test('status reads send the fresh access token only in Authorization',async()=>{
  const box=harness();assert.deepEqual(await box.client.request('status',{owner:'PRIVATE_OWNER'}),{connected:false});
  assert.equal(box.tokenReads,1);const {url,options}=box.calls[0];
  assert.equal(url,'/api/habit-sync?action=status');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
  assert.deepEqual(options.headers,{Accept:'application/json',Authorization:'Bearer SYNTHETIC_BEARER_TOKEN'});
  assert.doesNotMatch(url,/TOKEN|OWNER/);assert.equal(options.redirect,'error');
});

test('write requests whitelist their body and cannot send arbitrary member or habit content',async()=>{
  const privateFields={owner:'PRIVATE_OWNER',auth_user_id:'PRIVATE_AUTH',token:'PRIVATE_TOKEN',goal:'PRIVATE_GOAL',notes:'PRIVATE_NOTES',url:'https://example.invalid/PRIVATE_URL'};
  const box=harness();const cases=[
    ['connect',{...privateFields,defaultTime:'08:30',enabled:false},{defaultTime:'08:30'}],
    ['settings',{...privateFields,defaultTime:'21:15',enabled:false},{defaultTime:'21:15',enabled:false}],
    ['import',{...privateFields,habitId:'habit_synthetic-123'},{habitId:'habit_synthetic-123'}],
    ['import',privateFields,{}],['disconnect',privateFields,{}],['run',privateFields,{}]
  ];
  for(const [action,payload,expected] of cases){
    await box.client.request(action,Object.freeze(payload));const call=box.calls.at(-1);
    assert.equal(call.url,'/api/habit-sync?action='+action);assert.equal(call.options.method,'POST');
    assert.deepEqual(JSON.parse(call.options.body),expected);assert.doesNotMatch(call.options.body,/PRIVATE_|TOKEN/);
    assert.deepEqual(call.options.headers,{Accept:'application/json',Authorization:'Bearer SYNTHETIC_BEARER_TOKEN','Content-Type':'application/json'});
    assert.equal(call.options.redirect,'error');assert.equal(call.options.mode,'same-origin');
  }
});

test('unknown and inherited action names reject before token access or network calls',async()=>{
  const box=harness();
  for(const action of [undefined,null,'','delete','callback','claim','constructor','__proto__','toString','status&owner=private'])await rejectsCode(box.client.request(action,{}),'invalid_action');
  assert.equal(box.tokenReads,0);assert.deepEqual(box.calls,[]);
});

test('connect and settings reject ambiguous times or nonboolean enable flags before network',async()=>{
  const box=harness();
  for(const payload of [undefined,null,{}, {defaultTime:'9:00'},{defaultTime:'24:00'},{defaultTime:'09:00\n'},{defaultTime:900}]){
    await rejectsCode(box.client.request('connect',payload),'invalid_time');await rejectsCode(box.client.request('settings',payload),'invalid_time');
  }
  for(const enabled of [undefined,null,'true',1,0,{}])await rejectsCode(box.client.request('settings',{defaultTime:'09:00',enabled}),'invalid_time');
  assert.equal(box.tokenReads,0);assert.deepEqual(box.calls,[]);
});

test('import accepts only bounded opaque habit identifiers, and no id means explicit bulk import',async()=>{
  const box=harness();
  for(const habitId of ['',42,{},'../../private','habit?owner=x','habit/other','한글','h'.repeat(385),'habit\n'])await rejectsCode(box.client.request('import',{habitId}),'invalid_habit');
  assert.equal(box.tokenReads,0);
  for(const habitId of ['h','h'.repeat(384),'H_1-2']){
    await box.client.request('import',{habitId});assert.deepEqual(JSON.parse(box.calls.at(-1).options.body),{habitId});
  }
  await box.client.request('import',{});assert.deepEqual(JSON.parse(box.calls.at(-1).options.body),{});
});

test('missing access tokens reject authenticated calls without sending a request',async()=>{
  for(const token of [null,undefined,'',42,{}]){
    const box=harness({getAccessToken:async()=>token});await rejectsCode(box.client.request('status'),'auth_required');assert.deepEqual(box.calls,[]);
  }
});

test('an inaccessible session rejects before token lookup or request',async()=>{
  const box=harness();box.setCurrent(false);
  for(const action of ['config','status'])await rejectsCode(box.client.request(action),'session_changed');
  await rejectsCode(box.client.request('connect',{defaultTime:'09:00'}),'session_changed');
  assert.equal(box.tokenReads,0);assert.deepEqual(box.calls,[]);
});

test('a session change during token acquisition prevents credentials being sent',async()=>{
  for(const outcome of ['resolve','reject']){
    const token=deferred();const box=harness({getAccessToken:()=>token.promise});
    const pending=box.client.request('settings',{defaultTime:'09:00',enabled:true});await flush();box.setCurrent(false);
    if(outcome==='resolve')token.resolve('OLD_SESSION_TOKEN');else token.reject(new Error('PRIVATE_AUTH_FAILURE'));
    await rejectsCode(pending,'session_changed');assert.deepEqual(box.calls,[]);
  }
});

test('a session change while awaiting fetch prevents response data from being read',async()=>{
  const network=deferred();let jsonReads=0;const box=harness({fetch:()=>network.promise});
  const pending=box.client.request('status');await flush();box.setCurrent(false);
  network.resolve(response({}, {json:async()=>{jsonReads++;return {connected:true,owner:'OLD_OWNER'};}}));
  await rejectsCode(pending,'session_changed');assert.equal(jsonReads,0);
});

test('a session change while decoding JSON prevents old account data from being returned',async()=>{
  const body=deferred();let jsonReads=0;const box=harness({fetch:async()=>response({}, {json:()=>{jsonReads++;return body.promise;}})});
  const pending=box.client.request('status');await flush();assert.equal(jsonReads,1);box.setCurrent(false);
  body.resolve({connected:true,account:'OLD_ACCOUNT'});await rejectsCode(pending,'session_changed');
});

test('disposed clients abort every outstanding request and ignore late data',async()=>{
  const pendingNetwork=[],signals=[];const box=harness({fetch:(url,options)=>{
    const task=deferred();signals.push(options.signal);pendingNetwork.push(task);return task.promise;
  }});
  const one=box.client.request('status'),two=box.client.request('config');await flush();assert.equal(signals.length,2);
  box.client.dispose();assert.equal(signals.every(signal=>signal.aborted),true);
  for(const task of pendingNetwork)task.resolve(response({connected:true}));
  await rejectsCode(one,'session_changed');await rejectsCode(two,'session_changed');
  await rejectsCode(box.client.request('status'),'session_changed');assert.equal(signals.length,2);
});

test('dispose while fetching the token also prevents a later network request',async()=>{
  const token=deferred();const box=harness({getAccessToken:()=>token.promise});const pending=box.client.request('status');await flush();
  box.client.dispose();token.resolve('OLD_TOKEN');await rejectsCode(pending,'session_changed');assert.deepEqual(box.calls,[]);
});

test('a pending mutation blocks duplicate writes but permits connection reads',async()=>{
  const network=deferred();let writes=0,reads=0;const box=harness({fetch:async(url,options)=>{
    if(options.method==='POST'){writes++;return network.promise;}reads++;return response({connected:true});
  }});
  const first=box.client.request('connect',{defaultTime:'09:00'});
  for(const [action,payload] of [['connect',{defaultTime:'09:00'}],['settings',{defaultTime:'20:00',enabled:true}],['import',{}],['disconnect',{}],['run',{}]])await rejectsCode(box.client.request(action,payload),'busy');
  await box.client.request('status');assert.equal(writes,1);assert.equal(reads,1);
  network.resolve(response({url:'synthetic'}));await first;
  await box.client.request('run');assert.equal(writes,2);
});

test('failed writes release the mutation lock so a later retry is possible',async()=>{
  let writes=0;const box=harness({fetch:async()=>{writes++;if(writes===1)throw new Error('PRIVATE_FAILURE');return response();}});
  await rejectsCode(box.client.request('run'),'unavailable');await box.client.request('run');assert.equal(writes,2);
});

test('HTTP errors expose safe machine codes, never raw server details',async()=>{
  const cases=[
    [401,{error:'auth_required',details:'PRIVATE_TOKEN'},'auth_required'],
    [400,{error:'invalid_time'},'invalid_time'],
    [503,{error:'setup_required'},'setup_required'],
    [401,{error:'Bearer PRIVATE_SECRET'},'auth_required'],
    [500,{error:'<script>PRIVATE</script>',details:'PRIVATE_TOKEN'},'unavailable'],
    [500,{error:'a'.repeat(61)},'unavailable'],[500,{},'unavailable']
  ];
  for(const [status,data,expected] of cases){
    const box=harness({fetch:async()=>response(data,{ok:false,status})});
    await assert.rejects(box.client.request('status'),error=>error.code===expected&&!/PRIVATE|Bearer|script/.test(reminder.message(error)));
  }
});

test('malformed JSON and primitive success bodies are not accepted as connection state',async()=>{
  for(const body of [null,undefined,'connected',1,true,[]]){
    const box=harness({fetch:async()=>response(null,{json:async()=>body})});await rejectsCode(box.client.request('status'),'unavailable');
  }
  const box=harness({fetch:async()=>response(null,{json:async()=>{throw new SyntaxError('PRIVATE_BODY');}})});
  await rejectsCode(box.client.request('status'),'unavailable');
});

test('network redirect rejection and cancellation map to bounded errors',async()=>{
  for(const [name,expected] of [['TypeError','unavailable'],['AbortError','timeout'],['Error','unavailable']]){
    const box=harness({fetch:async(url,options)=>{assert.equal(options.redirect,'error');throw Object.assign(new Error('PRIVATE_TRANSPORT_FAILURE'),{name});}});
    await rejectsCode(box.client.request('status'),expected);
  }
});

test('OAuth navigation accepts only Microsoft common authorize with this exact callback',()=>{
  const valid=new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  valid.searchParams.set('client_id','synthetic-app');valid.searchParams.set('redirect_uri',callback);valid.searchParams.set('response_type','code');valid.searchParams.set('state','synthetic');
  assert.equal(reminder.authorizationUrl(valid.href,origin),valid.href);
  const rejected=['','not-a-url','/authorize','javascript:alert(1)',
    valid.href.replace('https:','http:'),valid.href.replace('login.microsoftonline.com','login.microsoftonline.com.evil.invalid'),
    valid.href.replace('login.microsoftonline.com','evil.invalid'),valid.href.replace('login.microsoftonline.com','user:pass@login.microsoftonline.com'),
    valid.href.replace('login.microsoftonline.com','login.microsoftonline.com:8443'),valid.href+'#private',
    valid.href.replace('/common/','/organizations/'),valid.href.replace('/authorize?','/token?')];
  for(const candidate of rejected)assert.equal(reminder.authorizationUrl(candidate,origin),'',candidate);
  for(const redirect of ['https://evil.invalid/callback',origin+'/api/habit-sync?action=callback',origin+'/api/habit-sync?owner=private',origin+'/api/habit-sync#extra',origin+'/api/habit-sync?action=status','http://growell-book.vercel.app/api/habit-sync']){
    const candidate=new URL(valid);candidate.searchParams.set('redirect_uri',redirect);assert.equal(reminder.authorizationUrl(candidate.href,origin),'',redirect);
  }
  const missing=new URL(valid);missing.searchParams.delete('redirect_uri');assert.equal(reminder.authorizationUrl(missing.href,origin),'');
  const duplicate=new URL(valid);duplicate.searchParams.append('redirect_uri','https://evil.invalid/callback');assert.equal(reminder.authorizationUrl(duplicate.href,origin),'');
});

test('user-facing errors never render raw exceptions, OAuth tokens or unknown server codes',()=>{
  const generic=reminder.message(new Error('PRIVATE_SECRET'));
  for(const error of [null,{},new Error('<script>PRIVATE</script>'),{code:'PRIVATE_TOKEN'},{code:'unknown_error',message:'Bearer PRIVATE_ACCESS_TOKEN'}])assert.equal(reminder.message(error),generic);
  for(const code of ['auth_required','unauthorized','invalid_session','setup_required','not_configured','invalid_time','reconnect_required','connection_expired','busy','timeout']){
    const text=reminder.message({code,message:'PRIVATE_SECRET'});assert.equal(typeof text,'string');assert.ok(text.length>0);assert.doesNotMatch(text,/PRIVATE|Bearer|<script>/);
  }
});
