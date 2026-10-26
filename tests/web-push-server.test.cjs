'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const S=require('../server/webPushService.cjs'),D=require('../server/driveBackupDomain.cjs');
const Verse=require('../dailyVerseDomain.js'),VERSES=require('../dailyVerses.js');
const AUTH='11111111-1111-4111-8111-111111111111',JOB='22222222-2222-4222-8222-222222222222',LEASE='33333333-3333-4333-8333-333333333333';
const PROFILE={id:'fixture-member',auth_user_id:AUTH,is_deleted:false,approval_status:'approved'};
const e=crypto.createECDH('prime256v1');e.generateKeys();
const CONFIG=S.getConfig({SUPABASE_SERVICE_ROLE_KEY:'fixture-service-key',CRON_SECRET:'fixture-cron-secret',GROWELL_SYNC_KEY:Buffer.alloc(32,7).toString('base64'),GROWELL_WEB_PUSH_PUBLIC_KEY:e.getPublicKey().toString('base64url'),GROWELL_WEB_PUSH_PRIVATE_KEY:e.getPrivateKey().toString('base64url')});
const SUB={endpoint:'https://fcm.googleapis.com/fcm/send/SYNTHETIC_ENDPOINT',expirationTime:null,keys:{p256dh:e.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}};
const NOW=Date.parse('2026-10-17T00:00:00Z');
function fixture(options={}){
  const state={profile:structuredClone(PROFILE),reads:[],writes:[],sends:[],stored:null,claims:[],snapshots:{},finishes:[]};Object.assign(state,options.state);
  const store={
    profile:async id=>{state.reads.push(id);return structuredClone(state.profile);},
    configure:async(profile,operation,payload)=>{
      state.writes.push({profile,operation,payload});
      if(options.configureError)throw options.configureError;
      if(operation==='connect')state.stored={...payload};
      if(operation==='disconnect')state.stored=null;
      return{connected:!!state.stored,newPosts:state.stored?.new_posts,dailyVerse:state.stored?.daily_verse,lastSentAt:null,lastError:null,subscription_cipher:'MUST NOT LEAK',owner_id:'MUST NOT LEAK'};
    },tick:async()=>{state.reads.push('tick');return{queued:state.queued||0};},claim:async()=>state.claims,
    workerAuthorized:async secret=>{state.reads.push('worker-auth');return secret==='v'.repeat(40);},
    apply:async(job,operation,payload)=>{
      if(['snapshot','prepare'].includes(operation)){state.reads.push(operation);if(options.guardFalse===operation)return{applied:false};return{...state.snapshots[job.id],...(operation==='prepare'?options.prepareChange:{})};}
      state.finishes.push([operation,payload]);if(options.acceptedError&&operation==='accepted')throw new Error('PRIVATE DATABASE');return{applied:true};
    }
  };
  const request=async(url,options,kind)=>{if(kind!=='auth'||options.headers.Authorization!=='Bearer fixture.jwt')throw new D.BackupError('authentication-required',401);return{id:AUTH};};
  const provider={send:async(...args)=>{state.sends.push(args);if(options.sendError)throw options.sendError;return{accepted:true};}};
  const service=S.createService({config:options.config||CONFIG,request,store,provider,now:options.now||(()=>NOW)});
  return{state,store,service,handler:S.createHandler({service})};
}
function queue(f,kind='post',overrides={}){
  const hash=S.fingerprint(SUB.endpoint);f.state.claims=[{id:JOB,lease_token:LEASE}];
  f.state.snapshots[JOB]={applied:true,owner_id:PROFILE.id,auth_user_id:AUTH,endpoint_hash:hash,subscription_cipher:D.seal(SUB,CONFIG.key,S.context(PROFILE.id,AUTH,hash)),kind,post_id:'post-fixture',book_id:'emotion',verse_day:Verse.getCompact(VERSES,NOW).dateKey,expires_at:new Date(NOW+3600000).toISOString(),...overrides};
}
async function invoke(handler,options={}){
  const headers={};let value;await handler({method:'POST',url:'/api/web-push',body:{action:'config'},headers:{authorization:'Bearer fixture.jwt',origin:CONFIG.origin,'content-type':'application/json'},...options},{setHeader:(k,v)=>{headers[k]=v;},set statusCode(v){headers.status=v;},end:v=>{value=v;}});return{headers,body:JSON.parse(value)};
}
test('config exposes public key only to an approved verified member, including safe disabled configuration',async()=>{
  const result=await invoke(fixture().handler);assert.equal(result.headers.status,200);assert.deepEqual(result.body,{configured:true,publicKey:CONFIG.publicKey});assert.equal(JSON.stringify(result.body).includes(CONFIG.privateKey),false);assert.equal(result.headers['Cache-Control'],'no-store, private');
  const off=await invoke(fixture({config:{...CONFIG,configured:false}}).handler);assert.deepEqual(off.body,{configured:false,publicKey:null});
  for(const profile of [{...PROFILE,approval_status:'pending'},{...PROFILE,is_deleted:true},{...PROFILE,auth_user_id:JOB},null])assert.equal((await invoke(fixture({state:{profile}}).handler)).headers.status,403);
  assert.equal((await invoke(fixture().handler,{headers:{authorization:'Bearer invalid',origin:CONFIG.origin,'content-type':'application/json'}})).headers.status,401);
});
test('subscribe encrypts full validated subscription with owner/auth/endpoint associated context',async()=>{
  const f=fixture(),result=await invoke(f.handler,{body:{action:'subscribe',subscription:SUB,preferences:{posts:true,dailyVerse:false}}});
  assert.equal(result.headers.status,200);assert.deepEqual(result.body.subscription.preferences,{posts:true,dailyVerse:false});
  const saved=f.state.writes[0];assert.equal(saved.operation,'connect');assert.equal(saved.payload.fingerprint,D.hash(SUB.endpoint));assert.equal(saved.payload.new_posts,true);assert.equal(saved.payload.daily_verse,false);
  assert.equal(JSON.stringify(saved.payload).includes(SUB.endpoint),false);assert.deepEqual(D.unseal(saved.payload.subscription_cipher,CONFIG.key,S.context(PROFILE.id,AUTH,saved.payload.fingerprint)),SUB);
  assert.throws(()=>D.unseal(saved.payload.subscription_cipher,CONFIG.key,S.context('another-member',AUTH,saved.payload.fingerprint)));
  assert.equal(JSON.stringify(result.body).includes('MUST NOT LEAK'),false);assert.equal(JSON.stringify(result.body).includes(SUB.endpoint),false);
});
test('status, preference update, test and disconnect are fenced by verified profile and hashed current device',async()=>{
  const f=fixture();assert.deepEqual((await invoke(f.handler,{body:{action:'status'}})).body,{configured:true,subscription:null});
  f.state.stored={new_posts:false,daily_verse:true};
  for(const action of ['status','preferences','test','unsubscribe']){
    const body={action,endpoint:SUB.endpoint,...(action==='preferences'?{preferences:{posts:false,dailyVerse:true}}:{})};
    const response=await invoke(f.handler,{body});assert.equal(response.headers.status,200);
    const last=f.state.writes.at(-1);assert.equal(last.profile.id,PROFILE.id);assert.equal(last.profile.auth_user_id,AUTH);assert.equal(last.payload.fingerprint,D.hash(SUB.endpoint));
    if(action==='test')assert.deepEqual(response.body,{ok:true});
  }
  assert.equal(f.state.stored,null);
});

test('nightly habit preference is optional for old clients and only accepts an explicit boolean',()=>{
  assert.deepEqual(S.preferences({posts:false,dailyVerse:true}),{new_posts:false,daily_verse:true});
  assert.deepEqual(S.preferences({posts:false,dailyVerse:true,habitCheck:false}),{new_posts:false,daily_verse:true,habit_check:false});
  for(const habitCheck of [null,undefined,1,'true',{},[]])assert.throws(()=>S.preferences({posts:true,dailyVerse:true,habitCheck}),e=>e.code==='invalid-request');
  const status=S.statusResult(CONFIG,{connected:true,newPosts:false,dailyVerse:true,habitCheck:false});
  assert.deepEqual(status.subscription.preferences,{posts:false,dailyVerse:true,habitCheck:false});
});

test('nightly habit delivery rechecks its live lease and day before the provider without copying habits',async()=>{
  const at=Date.parse('2026-10-26T23:00:00+09:00'),f=fixture({now:()=>at});queue(f,'habit',{habit_day:'2026-10-26',expires_at:new Date(at+1800000).toISOString(),habit_name:'PRIVATE HABIT NAME',checked_dates:['PRIVATE CHECK HISTORY']});
  await f.service.run();assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0][1].type,'habit');assert.equal(f.state.sends[0][2],1800);assert.doesNotMatch(JSON.stringify(f.state.sends),/PRIVATE HABIT|PRIVATE CHECK/);
  const completed=fixture({now:()=>at,guardFalse:'prepare'});queue(completed,'habit',{habit_day:'2026-10-26',expires_at:new Date(at+1800000).toISOString()});await completed.service.run();assert.equal(completed.state.sends.length,0);
  const stale=fixture({now:()=>at});queue(stale,'habit',{habit_day:'2026-10-25',expires_at:new Date(at+1800000).toISOString()});await stale.service.run();assert.equal(stale.state.sends.length,0);
});

test('an expired owned device returns inactive status and confirmed preferences without exposing its identity or subscription',async()=>{
  for(const preferences of [{posts:false,dailyVerse:true},{posts:true,dailyVerse:false},{posts:false,dailyVerse:false}]){
    const f=fixture();
    f.store.configure=async(profile,operation,payload)=>{
      assert.deepEqual(profile,PROFILE);assert.equal(operation,'status');assert.deepEqual(payload,{fingerprint:D.hash(SUB.endpoint)});
      return{connected:false,deviceId:JOB,newPosts:preferences.posts,dailyVerse:preferences.dailyVerse,lastSentAt:'2026-10-20T00:00:09Z',lastError:'subscription-expired',subscription_cipher:'PRIVATE_CIPHER',owner_id:PROFILE.id,auth_user_id:AUTH,endpoint:SUB.endpoint,keys:SUB.keys};
    };
    const response=await invoke(f.handler,{body:{action:'status',endpoint:SUB.endpoint}});
    assert.equal(response.headers.status,200);
    assert.deepEqual(response.body,{configured:true,subscription:{active:false,preferences,lastSentAt:'2026-10-20T00:00:09Z',lastError:'subscription-expired'}});
    for(const privateValue of [JOB,PROFILE.id,AUTH,SUB.endpoint,SUB.keys.auth,SUB.keys.p256dh,'PRIVATE_CIPHER'])assert.equal(JSON.stringify(response.body).includes(privateValue),false);
    assert.equal(f.state.sends.length,0);
  }
  assert.equal(S.safeError({code:'subscription-expired'}),'subscription-expired');
});

test('inactive status requires the RPC ownership marker and never invents an expiration for an explicit disconnect',()=>{
  const own={connected:false,deviceId:JOB,newPosts:false,dailyVerse:true,lastSentAt:null,lastError:null};
  assert.deepEqual(S.statusResult(CONFIG,own),{configured:true,subscription:{active:false,preferences:{posts:false,dailyVerse:true},lastSentAt:null,lastError:null}});
  for(const value of [null,{},
    {...own,deviceId:null},{...own,deviceId:undefined},{...own,deviceId:'PRIVATE_FOREIGN_DEVICE'},
    {...own,newPosts:undefined},{...own,newPosts:'false'},{...own,dailyVerse:undefined},{...own,dailyVerse:1},
    {...own,connected:undefined},{...own,deviceId:null,newPosts:true,dailyVerse:true,lastError:'subscription-expired'}]){
    assert.deepEqual(S.statusResult(CONFIG,value),{configured:true,subscription:null});
  }
  const hidden=S.statusResult(CONFIG,{...own,lastSentAt:'PRIVATE_INVALID_DATE',lastError:'PRIVATE_DATABASE_ERROR'});
  assert.equal(hidden.subscription.lastSentAt,null);assert.equal(hidden.subscription.lastError,'service-unavailable');assert.doesNotMatch(JSON.stringify(hidden),/PRIVATE_/);
});

test('one-minute background test is queued for the verified device without sending from the member request',async()=>{
  const f=fixture();f.state.stored={new_posts:true,daily_verse:true};
  const response=await invoke(f.handler,{body:{action:'test',endpoint:SUB.endpoint,delaySeconds:60}});
  assert.equal(response.headers.status,200);assert.deepEqual(response.body,{ok:true});
  assert.deepEqual(f.state.writes.at(-1),{profile:PROFILE,operation:'test',payload:{fingerprint:D.hash(SUB.endpoint),delay_seconds:60}});
  assert.equal(f.state.sends.length,0,'only the server worker may deliver queued tests');
  assert.equal(JSON.stringify(response.body).includes(SUB.endpoint),false);
  const immediate=fixture();immediate.state.stored={};
  assert.equal((await invoke(immediate.handler,{body:{action:'test',endpoint:SUB.endpoint}})).headers.status,200);
  assert.deepEqual(immediate.state.writes.at(-1).payload,{fingerprint:D.hash(SUB.endpoint)});
});

test('test delay accepts only the explicit sixty-second option and preserves authentication and cooldown checks',async()=>{
  const f=fixture();for(const delaySeconds of [0,1,59,61,-60,600,60.1,'60',null,true,{},[]]){
    assert.equal((await invoke(f.handler,{body:{action:'test',endpoint:SUB.endpoint,delaySeconds}})).headers.status,400);
  }
  for(const action of ['config','status','preferences','unsubscribe','subscribe'])assert.equal((await invoke(f.handler,{body:{action,endpoint:SUB.endpoint,delaySeconds:60}})).headers.status,400);
  assert.equal(f.state.writes.length,0);
  assert.equal((await invoke(f.handler,{body:{action:'test',endpoint:SUB.endpoint,delaySeconds:60},headers:{origin:CONFIG.origin,'content-type':'application/json'}})).headers.status,401);
  const limited=fixture({configureError:new D.BackupError('rate-limited',429)});
  assert.deepEqual((await invoke(limited.handler,{body:{action:'test',endpoint:SUB.endpoint,delaySeconds:60}})).body,{error:'rate-limited'});
  assert.equal(limited.state.sends.length,0);
});
test('invalid origin/content-type/method/shape/endpoint cannot mutate a push device',async()=>{
  const f=fixture();
  assert.equal((await invoke(f.handler,{headers:{authorization:'Bearer fixture.jwt',origin:'https://attacker.example','content-type':'application/json'}})).headers.status,403);
  assert.equal((await invoke(f.handler,{method:'GET'})).headers.status,405);
  for(const body of [{action:'worker'},{action:'status',owner:PROFILE.id},{action:'subscribe',subscription:SUB,preferences:{posts:'true',dailyVerse:true}},{action:'subscribe',subscription:{...SUB,endpoint:'https://localhost/x'},preferences:{posts:true,dailyVerse:true}},{action:'preferences',endpoint:SUB.endpoint,preferences:{posts:true}},{action:'test',endpoint:'https://attacker.example/x'}])assert.notEqual((await invoke(f.handler,{body})).headers.status,200);
  assert.equal((await invoke(f.handler,{body:'{'})).headers.status,400);assert.equal((await invoke(f.handler,{body:'x'.repeat(S.MAX_BODY_BYTES+1)})).headers.status,413);assert.equal(f.state.writes.length,0);
});
test('expired subscriptions and private API errors never leak credentials or invoke network delivery',async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,{body:{action:'subscribe',subscription:{...SUB,expirationTime:NOW-1},preferences:{posts:true,dailyVerse:true}}})).headers.status,400);assert.equal(f.state.writes.length,0);
  const failure=await invoke(fixture({configureError:new Error('PRIVATE KEY AND ENDPOINT')}).handler,{body:{action:'status',endpoint:SUB.endpoint}});assert.deepEqual(failure.body,{error:'service-unavailable'});assert.equal(failure.headers.status,503);
});
test('worker requires a server cron bearer or verified Vault worker secret, never a member bearer',async()=>{
  const f=fixture();for(const headers of [{authorization:'Bearer fixture.jwt'},{},{'x-growell-worker-secret':'invalid'}])assert.equal((await invoke(f.handler,{url:'/api/web-push?action=worker',headers})).headers.status,401);
  assert.equal((await invoke(f.handler,{method:'GET',url:'/api/web-push?action=worker',headers:{authorization:'Bearer '+CONFIG.cronSecret}})).headers.status,200);
  assert.equal((await invoke(f.handler,{url:'/api/web-push?action=worker',headers:{'x-growell-worker-secret':'v'.repeat(40)}})).headers.status,200);
});
test('Vault worker secret accepts exact SQL-compatible length bounds without returning the secret',async()=>{
  const f=fixture(),checked=[];f.store.workerAuthorized=async secret=>{checked.push(secret.length);return true;};
  for(const length of [31,32,200,201,256,257]){
    const result=await invoke(f.handler,{url:'/api/web-push?action=worker',headers:{'x-growell-worker-secret':'s'.repeat(length)}});
    assert.equal(result.headers.status,length>=32&&length<=256?200:401);
    assert.equal(JSON.stringify(result.body).includes('s'.repeat(31)),false);
  }
  assert.deepEqual(checked,[32,200,201,256]);
});
test('new post delivery rechecks eligible lease immediately before network and contains no member content',async()=>{
  const f=fixture();queue(f);assert.deepEqual(await f.service.run(),{queued:0,claimed:1,processed:1,accepted:1,deferred:0});assert.deepEqual(f.state.reads.slice(-2),['snapshot','prepare']);assert.equal(f.state.sends.length,1);
  const [subscription,payload,ttl]=f.state.sends[0];assert.deepEqual(subscription,SUB);assert.equal(payload.type,'post');assert.equal(payload.postId,'post-fixture');assert.equal(payload.bookId,'emotion');assert.equal(ttl,3600);assert.equal(payload.body.includes('새로운 나눔'),true);
  assert.deepEqual(Object.keys(payload).sort(),['version','type','bookId','postId','tag','body'].sort());assert.deepEqual(f.state.finishes.map(x=>x[0]),['accepted']);
});

test('new materials pass the same durable lease guards and expose only the public book and opaque material ID',async()=>{
  const f=fixture();queue(f,'material',{post_id:null,material_id:'mn_fixture_material',book_id:'thought',title:'PRIVATE_MEMBER_TITLE',body:'PRIVATE_MEMBER_BODY',user_name:'PRIVATE_MEMBER_NAME'});
  assert.deepEqual(await f.service.run(),{queued:0,claimed:1,processed:1,accepted:1,deferred:0});assert.deepEqual(f.state.reads.slice(-2),['snapshot','prepare']);assert.equal(f.state.sends.length,1);
  const [subscription,payload,ttl]=f.state.sends[0];assert.deepEqual(subscription,SUB);assert.equal(ttl,3600);
  assert.deepEqual(payload,{version:1,type:'material',bookId:'thought',materialId:'mn_fixture_material',tag:'growell-material-mn_fixture_material',body:'『생각이 너무 많은 어른들을 위한 심리학』 자료실에 새 자료가 올라왔어요.'});
  assert.deepEqual(Object.keys(payload).sort(),['version','type','bookId','materialId','tag','body'].sort());assert.deepEqual(f.state.finishes.map(row=>row[0]),['accepted']);
  const output=JSON.stringify(payload);for(const value of ['PRIVATE_MEMBER_TITLE','PRIVATE_MEMBER_BODY','PRIVATE_MEMBER_NAME',PROFILE.id,AUTH,SUB.endpoint,SUB.keys.auth])assert.equal(output.includes(value),false);
});

test('deleted or withdrawn materials and changed source identity are rejected before a provider request',async()=>{
  for(const options of [{guardFalse:'snapshot'},{guardFalse:'prepare'},{prepareChange:{material_id:'mn_different_source'}},{prepareChange:{book_id:'body'}},{prepareChange:{kind:'post',post_id:'different-post'}}]){
    const f=fixture(options);queue(f,'material',{material_id:'mn_fixture_material',post_id:null});await f.service.run();assert.equal(f.state.sends.length,0);
  }
  for(const material_id of [null,undefined,123,{},[],true,'','../elsewhere','id?route=elsewhere','id/elsewhere','x'.repeat(101)]){
    const f=fixture();queue(f,'material',{material_id,post_id:null});await f.service.run();assert.equal(f.state.sends.length,0);
  }
  const wrongBook=fixture();queue(wrongBook,'material',{material_id:'mn_fixture_material',book_id:'private-book'});await wrongBook.service.run();assert.equal(wrongBook.state.sends.length,0);
});

test('material replacement tags remain stable across retries and cannot collide with a post sharing the same ID',()=>{
  const source={kind:'material',material_id:'shared_fixture_id',book_id:'emotion'},otherJob='44444444-4444-4444-8444-444444444444';
  const payload=S.payloadFor(source,NOW,JOB);assert.deepEqual(payload,S.payloadFor(source,NOW,otherJob));
  assert.notEqual(payload.tag,S.payloadFor({kind:'post',post_id:source.material_id,book_id:'emotion'},NOW,JOB).tag);
  for(const material_id of ['m','a'.repeat(100),'mn_MIXED-Case_123'])assert.equal(S.payloadFor({...source,material_id},NOW,JOB).materialId,material_id);
});
test('separate durable test jobs produce separate visible notification tags without source metadata',async()=>{
  const otherJob='44444444-4444-4444-8444-444444444444',first=fixture(),second=fixture();queue(first,'test');queue(second,'test');
  second.state.claims[0].id=otherJob;second.state.snapshots[otherJob]=second.state.snapshots[JOB];delete second.state.snapshots[JOB];
  assert.deepEqual(await first.service.run(),{queued:0,claimed:1,processed:1,accepted:1,deferred:0});assert.deepEqual(await second.service.run(),{queued:0,claimed:1,processed:1,accepted:1,deferred:0});
  const a=first.state.sends[0][1],b=second.state.sends[0][1];
  assert.equal(a.tag,'growell-push-test-'+JOB);assert.equal(b.tag,'growell-push-test-'+otherJob);assert.notEqual(a.tag,b.tag);
  assert.equal(a.body,b.body);assert.deepEqual(Object.keys(a).sort(),['version','type','tag','body'].sort());
  for(const payload of [a,b]){const text=JSON.stringify(payload);assert.equal(text.includes(PROFILE.id),false);assert.equal(text.includes(AUTH),false);assert.equal(text.includes(SUB.endpoint),false);assert.equal(text.includes('post-fixture'),false);}
  assert.throws(()=>S.payloadFor({kind:'test'},NOW),error=>error.code==='push-unavailable');
  assert.throws(()=>S.payloadFor({kind:'test'},NOW,'https://attacker.example'),error=>error.code==='push-unavailable');
});
test('post and daily verse retain stable replacement tags regardless of a different job UUID',()=>{
  const otherJob='44444444-4444-4444-8444-444444444444',day=Verse.getCompact(VERSES,NOW).dateKey;
  for(const source of [{kind:'post',book_id:'emotion',post_id:'post-fixture'},{kind:'verse',verse_day:day}])assert.deepEqual(S.payloadFor(source,NOW,JOB),S.payloadFor(source,NOW,otherJob));
});
test('daily verse uses exact same short passage and Korean day as home, with no AI or original rewrite',async()=>{
  const f=fixture();queue(f,'verse');await f.service.run();const current=Verse.getCompact(VERSES,NOW),payload=f.state.sends[0][1];assert.equal(payload.body,current.text+'\n'+current.reference);assert.equal(payload.tag,'growell-verse-'+current.dateKey);
  const stale=fixture();queue(stale,'verse',{verse_day:'2000-01-01'});await stale.service.run();assert.equal(stale.state.sends.length,0);
});
test('morning worker runs independently of an open browser and returns only aggregate queue diagnostics',async()=>{
  const f=fixture();queue(f,'verse');f.state.queued=1;
  const result=await invoke(f.handler,{method:'GET',url:'/api/web-push?action=worker',headers:{authorization:'Bearer '+CONFIG.cronSecret}});
  assert.equal(result.headers.status,200);assert.deepEqual(result.body,{queued:1,claimed:1,processed:1,accepted:1,deferred:0});
  assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0][1].type,'verse');
  const text=JSON.stringify(result.body);for(const sensitive of [PROFILE.id,AUTH,SUB.endpoint,SUB.keys.auth,SUB.keys.p256dh])assert.equal(text.includes(sensitive),false);
});
test('October 19 and following Korean mornings reach the actual service worker without a page or date-list filter',async()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),events={},displayed=[];
  const context={Promise,self:{addEventListener:(name,fn)=>{events[name]=fn;},registration:{showNotification:(title,options)=>{displayed.push({title,options});return Promise.resolve();}}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../timer-alert-sw.js'),'utf8'),context);
  for(const day of ['2026-10-19','2026-10-20']){
    const morning=Date.parse(day+'T09:00:01+09:00'),current=Verse.getCompact(VERSES,morning),payload=S.payloadFor({kind:'verse',verse_day:day},morning);
    let completion;events.push({data:{json:()=>payload},waitUntil:value=>{completion=value;}});assert.ok(completion);await completion;
    const output=displayed.at(-1);assert.equal(output.title,'오늘의 말씀');assert.equal(output.options.body,current.text+'\n'+current.reference);
    assert.equal(output.options.tag,'growell-growell-verse-'+day);assert.equal(output.options.data.type,'verse');
  }
  assert.equal(displayed.length,2);assert.notEqual(displayed[0].options.tag,displayed[1].options.tag,'a previous day notification cannot silently replace a different day');
});
test('queue diagnostics distinguish deadline deferral from an empty morning queue',async()=>{
  let time=NOW;const f=fixture({now:()=>time});queue(f,'verse');
  f.store.tick=async()=>{time+=13000;return{queued:1};};
  assert.deepEqual(await f.service.run(),{queued:1,claimed:1,processed:0,accepted:0,deferred:1});assert.equal(f.state.sends.length,0);
  const empty=fixture();assert.deepEqual(await empty.service.run(),{queued:0,claimed:0,processed:0,accepted:0,deferred:0});
  const invalid=fixture();invalid.store.tick=async()=>({queued:'PRIVATE RESPONSE'});await assert.rejects(invalid.service.run(),error=>error.code==='service-unavailable');
});
test('withdrawn eligibility, changed device or invalid encrypted context prevents a network push',async()=>{
  for(const options of [{guardFalse:'snapshot'},{guardFalse:'prepare'},{prepareChange:{owner_id:'different-owner'}},{prepareChange:{subscription_cipher:'modified'}}]){const f=fixture(options);queue(f);await f.service.run();assert.equal(f.state.sends.length,0);}
  for(const overrides of [{subscription_cipher:'not-cipher'},{endpoint_hash:'0'.repeat(64)},{book_id:'private-book'},{expires_at:new Date(NOW-1).toISOString()}]){const f=fixture();queue(f,'post',overrides);await f.service.run();assert.equal(f.state.sends.length,0);}
});
test('provider outcomes use durable bounded retry, inactive-device or uncertain-delivery states',async()=>{
  for(const [code,status,operation] of [['subscription-gone',410,'gone'],['push-rate-limited',429,'retry'],['push-unavailable',503,'retry'],['push-rejected',502,'uncertain'],['push-uncertain',503,'uncertain']]){
    const f=fixture({sendError:new D.BackupError(code,status)});queue(f);await f.service.run();assert.equal(f.state.finishes[0][0],operation);assert.equal(JSON.stringify(f.state.finishes).includes(SUB.endpoint),false);
    if(code==='push-rate-limited')assert.equal(f.state.finishes[0][1].error_code,'rate-limited');
  }
  const f=fixture({acceptedError:true});queue(f);await f.service.run();assert.deepEqual(f.state.finishes.map(row=>row[0]),['accepted','uncertain']);assert.equal(f.state.sends.length,1);
});
test('store passes authenticated ownership and opaque fields only to service-role RPCs',async()=>{
  const calls=[],store=S.createStore(CONFIG,async(...args)=>{calls.push(args);return true;});
  await store.configure(PROFILE,'disconnect',{fingerprint:D.hash(SUB.endpoint)});await store.tick(NOW);await store.claim(5);await store.apply({id:JOB,lease_token:LEASE},'accepted');
  assert.equal(calls[0][0],CONFIG.database+'/rest/v1/rpc/growell_web_push_configure');assert.deepEqual(JSON.parse(calls[0][1].body),{p_owner:PROFILE.id,p_auth:AUTH,p_operation:'disconnect',p_payload:{fingerprint:D.hash(SUB.endpoint)}});assert.equal(calls[0][1].headers.Authorization,'Bearer '+CONFIG.serviceKey);
});
test('transport maps authentication, database limits and failures without copying provider bodies',async()=>{
  for(const [status,raw,kind,code] of [[401,'{}','auth','authentication-required'],[400,'{"code":"54000","message":"PRIVATE"}','database','rate-limited'],[403,'{"code":"42501","message":"PRIVATE"}','database','membership-required'],[500,'{"message":"PRIVATE"}','database','service-unavailable']]){
    const transport=S.createTransport(async()=>({ok:false,status,text:async()=>raw}));await assert.rejects(transport(CONFIG.database,{},kind),error=>error.code===code&&!JSON.stringify(error).includes('PRIVATE'));
  }
});
