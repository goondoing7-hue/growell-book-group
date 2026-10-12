'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const D=require('../server/meetingCalendarDomain.cjs');
const {createProvider}=require('../server/meetingCalendarProvider.cjs');
const config=D.getConfig({GROWELL_GOOGLE_CLIENT_ID:'fixture-client',GROWELL_GOOGLE_CLIENT_SECRET:'fixture-secret',GROWELL_SYNC_KEY:Buffer.alloc(32,8).toString('base64'),SUPABASE_SERVICE_ROLE_KEY:'fixture-service',CRON_SECRET:'fixture-cron'});
const NOW=Date.parse('2026-10-11T00:00:00Z'),SCHEDULE='33333333-3333-4333-8333-333333333333';
const desired=()=>({schedule_id:SCHEDULE,meeting_date:'2026-10-24',start_time:'13:30',end_time:'15:00',place:'교육관 2층',book_id:'emotion',meeting_no:'2',chapter:'3장',reading_range:'80~120쪽',note:'책을 가져옵니다.'});
const identity=D.eventIdentity('fixture-member','fixture-account',SCHEDULE,config.key),event=()=>D.buildEvent(desired(),identity);
const reply=(body,status=200,headers={})=>new Response(body==null?null:JSON.stringify(body),{status,headers});
function meta(value=event()){return {id:value.id,status:'confirmed',etag:'"fixture-etag"',organizer:{self:true},eventType:'default',extendedProperties:value.extendedProperties};}
function fixture({existing=true,mutate,handle}={}) {
  let resource=existing?meta():null;const calls=[];if(mutate)resource=mutate(resource);
  const fetch=async(url,init)=>{
    const call={url:String(url),...init};calls.push(call);if(handle){const answer=await handle(call,()=>resource,value=>{resource=value;});if(answer)return answer;}
    const parsed=new URL(url);assert.equal(parsed.origin,D.CALENDAR_ORIGIN);assert.ok(parsed.pathname.startsWith('/calendar/v3/calendars/primary/events'));
    if(!init.method)return resource?reply(resource):reply({error:'missing'},404);
    if(init.method==='POST'){if(resource)return reply({error:'conflict'},409);resource=meta(JSON.parse(init.body));return reply(resource);}
    if(init.method==='PATCH'){assert.equal(init.headers['If-Match'],resource.etag);const update=JSON.parse(init.body);resource={...resource,extendedProperties:update.extendedProperties,etag:'"next-etag"'};return reply(resource);}
    throw new Error('Unexpected method');
  };
  const provider=createProvider(config,{fetch,now:()=>NOW});
  return {calls,provider,fetch,get resource(){return resource;},write:extra=>provider.writeEvent({accessToken:'fixture-access',event:event(),eventCreated:existing,...extra})};
}
test('Calendar configuration uses a separate callback with owned-event permission',()=>{
  assert.equal(config.configured,true);assert.equal(config.redirectUri,config.origin+'/api/meeting-calendar');
  const url=new URL(D.authorizationUrl(config,{state:'s'.repeat(48),verifier:'v'.repeat(64)}));
  assert.equal(url.searchParams.get('scope'),D.SCOPES);assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('prompt'),'consent select_account');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.has('client_secret'),false);
  assert.ok(!D.SCOPES.includes('drive.')&&!D.SCOPES.includes('calendar.events '));
  for(const overrides of [{},{GROWELL_SYNC_ORIGIN:'https://user:password@example.test'},{GROWELL_SYNC_ORIGIN:'https://example.test/path'},{GROWELL_SUPABASE_URL:'https://attacker.test'},{GROWELL_SYNC_KEY:'bad'}])assert.equal(D.getConfig(overrides).configured,false);
});
test('Calendar refresh tokens cannot be decrypted under another member, generation or Drive connector',()=>{
  const Drive=require('../server/driveBackupDomain.cjs'),value={refreshToken:'fixture-refresh'},context=D.tokenContext('fixture-member','generation-one'),cipher=D.seal(value,config.key,context);
  assert.deepEqual(D.unseal(cipher,config.key,context),value);
  for(const other of [D.tokenContext('other-member','generation-one'),D.tokenContext('fixture-member','generation-two')])assert.throws(()=>D.unseal(cipher,config.key,other),{code:'connection-key-invalid'});
  assert.throws(()=>Drive.unseal(cipher,config.key,context),{code:'connection-key-invalid'});
});
test('Stable event identifiers preserve rescheduling identity and differ for other members, accounts and meetings',()=>{
  assert.match(identity.id,D.EVENT_ID);assert.equal(identity.id.length,64);
  assert.deepEqual(D.eventIdentity('fixture-member','fixture-account',SCHEDULE,config.key),identity);
  for(const args of [['other-member','fixture-account',SCHEDULE],['fixture-member','other-account',SCHEDULE],['fixture-member','fixture-account','44444444-4444-4444-8444-444444444444']])assert.notEqual(D.eventIdentity(...args,config.key).id,identity.id);
});
test('Meeting events contain native place, book and reading range with explicit Korean start/end times',()=>{
  const before=desired(),source=structuredClone(before),value=D.buildEvent(source,identity);
  assert.equal(value.location,'교육관 2층');assert.match(value.description,/읽을 책: 감정을 마주하면 길이 보인다/);assert.match(value.description,/읽을 범위: 3장 · 80~120쪽/);
  assert.equal(value.start.dateTime,'2026-10-24T13:30:00+09:00');assert.equal(value.end.dateTime,'2026-10-24T15:00:00+09:00');assert.equal(value.start.timeZone,'Asia/Seoul');assert.equal(value.visibility,'private');
  assert.equal(value.attendees,undefined);assert.deepEqual(source,before);
});
test('Ambiguous legacy dates, impossible dates and reversed or missing times never generate guessed schedules',()=>{
  for(const changes of [{meeting_date:'10/24(토)'},{meeting_date:'2026-02-30'},{start_time:'오후 1시'},{start_time:['13:30']},{end_time:''},{end_time:'13:00'},{end_time:'13:30'},{schedule_id:'global'},{book_id:'private'},{meeting_no:'1st'}])assert.throws(()=>D.buildEvent({...desired(),...changes},identity),{code:'invalid-schedule'});
});
test('Token exchange is fixed to Google, includes PKCE and does not accept incomplete Calendar consent',async()=>{
  let seen;const raw={access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,token_type:'Bearer',scope:D.SCOPES};
  const provider=createProvider(config,{now:()=>NOW,fetch:async(url,init)=>{seen={url,init};return reply(raw);}});
  await provider.exchange({code:'fixture-code',verifier:'v'.repeat(64)});assert.equal(seen.url,D.TOKEN_URL);assert.equal(seen.init.redirect,'error');assert.equal(new URLSearchParams(seen.init.body).get('redirect_uri'),config.redirectUri);
  for(const changed of [{scope:'openid email'},{scope:D.CALENDAR_SCOPE},{refresh_token:''},{token_type:'MAC'}]){const bad=createProvider(config,{fetch:async()=>reply({...raw,...changed})});await assert.rejects(bad.exchange({code:'fixture-code',verifier:'v'.repeat(64)}),error=>['calendar-permission-denied','reconnect-required'].includes(error.code));}
});
test('Google may omit scope and refresh token on refresh without losing saved consent',async()=>{
  const p=createProvider(config,{now:()=>NOW,fetch:async()=>reply({access_token:'new-access',expires_in:3600,token_type:'Bearer'})});
  assert.equal((await p.refresh({refreshToken:'saved-refresh',scope:D.SCOPES})).refreshToken,'saved-refresh');
});
test('New events are inserted using their reserved ID only after the membership guard',async()=>{
  const f=fixture({existing:false}),steps=[];await f.write({beforeWrite:async()=>steps.push('guard'),onCreated:async()=>steps.push('receipt')});
  assert.deepEqual(steps,['guard','receipt']);const call=f.calls.find(c=>c.method==='POST');assert.equal(JSON.parse(call.body).id,identity.id);assert.equal(new URL(call.url).searchParams.get('sendUpdates'),'none');assert.equal(f.calls.some(c=>c.method==='DELETE'),false);
});
test('Updates preserve personal reminders and unrelated metadata and use an ETag',async()=>{
  const f=fixture({mutate:r=>({...r,extendedProperties:{private:{...r.extendedProperties.private,personalMemo:'keep'}}})});await f.write();
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);const patch=JSON.parse(f.calls.find(c=>c.method==='PATCH').body);
  assert.equal(patch.reminders,undefined);assert.equal(patch.attendees,undefined);assert.equal(patch.colorId,undefined);assert.equal(patch.extendedProperties.private.personalMemo,'keep');assert.equal(patch.visibility,undefined);
});
test('Foreign or unmarked events are never changed despite an identifier collision',async()=>{
  for(const mutate of [r=>({...r,organizer:{self:false}}),r=>({...r,extendedProperties:{private:{}}}),r=>({...r,eventType:'birthday'})]){const f=fixture({mutate});await assert.rejects(f.write(),{code:'calendar-event-unsafe'});assert.equal(f.calls.some(c=>c.method),false);}
});
test('An established event deleted or cancelled externally is not recreated',async()=>{
  for(const mutate of [()=>null,r=>({...r,status:'cancelled'})]){const f=fixture({mutate});await assert.rejects(f.write(),{code:'calendar-remote-missing'});assert.equal(f.calls.some(c=>c.method),false);}
});
test('Lost insertion responses retry the same event ID without producing duplicates',async()=>{
  let fail=true;const f=fixture({existing:false,handle:async(call,get,set)=>{if(fail&&call.method==='POST'){fail=false;set(meta(JSON.parse(call.body)));throw new Error('network lost fixture-secret');}}});
  await assert.rejects(f.write(),e=>e.code==='calendar-unavailable'&&e.uncertain);await f.write();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('An insertion conflict validates the existing app event and still applies the current desired schedule',async()=>{
  const f=fixture({existing:false,handle:(call,get,set)=>{if(call.method==='POST'){set(meta());return reply({error:'already exists'},409);}}});
  let receipts=0;await f.write({onCreated:async()=>{receipts++;}});assert.equal(receipts,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(JSON.parse(f.calls.find(c=>c.method==='PATCH').body).start.dateTime,'2026-10-24T13:30:00+09:00');
});
test('Concurrent edits fail safely and raw provider failures never leak credentials',async()=>{
  const f=fixture({handle:call=>call.method==='PATCH'?reply({error:'fixture-secret fixture-access'},412):null});await assert.rejects(f.write(),{code:'calendar-version-conflict'});
  const p=createProvider(config,{fetch:async()=>reply({error:'fixture-secret fixture-refresh'},400)});await assert.rejects(p.exchange({code:'fixture-code',verifier:'v'.repeat(64)}),e=>e.message==='reconnect-required'&&!JSON.stringify(e).includes('fixture-secret'));
});
test('A deferred worker and a revoked membership perform no Google write',async()=>{
  const f=fixture();await assert.rejects(f.write({beforeWrite:async()=>{throw new D.CalendarError('membership-required',403);}}),{code:'membership-required'});assert.equal(f.calls.some(c=>c.method),false);
  const late=createProvider(config,{fetch:async()=>{throw new Error('must not call');},now:()=>NOW,deadline:NOW+100});await assert.rejects(late.writeEvent({accessToken:'fixture-access',event:event()}),{code:'calendar-deferred'});
});
