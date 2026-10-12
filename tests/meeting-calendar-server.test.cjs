'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const S=require('../server/meetingCalendarService.cjs'),D=require('../server/meetingCalendarDomain.cjs');
const NOW=Date.parse('2026-10-11T00:00:00Z'),AUTH='11111111-1111-4111-8111-111111111111',GEN='22222222-2222-4222-8222-222222222222',SCHEDULE='33333333-3333-4333-8333-333333333333';
const profile={id:'fixture-member',auth_user_id:AUTH,approval_status:'approved',is_deleted:false};
const config=D.getConfig({GROWELL_GOOGLE_CLIENT_ID:'fixture-client',GROWELL_GOOGLE_CLIENT_SECRET:'fixture-secret',GROWELL_SYNC_KEY:Buffer.alloc(32,8).toString('base64'),SUPABASE_SERVICE_ROLE_KEY:'fixture-service',CRON_SECRET:'fixture-cron'});
function fixture() {
  const c={owner_id:profile.id,auth_user_id:AUTH,generation:GEN,token_cipher:D.seal({refreshToken:'fixture-refresh',scope:D.SCOPES},config.key,D.tokenContext(profile.id,GEN)),account_id:'fixture-account',account_email:'fixture@example.test',enabled:true,lease_token:'lease',lease_until:new Date(NOW+90000).toISOString()};
  const job={owner_id:profile.id,generation:GEN,schedule_id:SCHEDULE,revision:2,synced_revision:0,event_created:false,desired:{schedule_id:SCHEDULE,meeting_date:'2026-10-24',start_time:'13:30',end_time:'15:00',place:'교육관',book_id:'emotion',meeting_no:'2',chapter:'3장',reading_range:'80~120쪽'}};
  const state={c,job,member:structuredClone(profile),valid:true,operations:[],writes:[],oauth:null};
  const store={
    profile:async()=>state.member,connection:async()=>c,jobs:async()=>[structuredClone(job)],
    claim:async()=>state.valid&&c.token_cipher&&(c.enabled||c.manual_requested)?[{connection:structuredClone(c),jobs:[structuredClone(job)]}]:[],
    apply:async(conn,op,payload={})=>{
      state.operations.push([op,payload]);if(!state.valid||conn.generation!==c.generation)return {applied:false};
      if(op==='guard'&&payload.revision&&payload.revision!==job.revision)return {applied:false};
      if(op==='created'){job.event_created=true;job.event_id=payload.event_id;}
      if(op==='success'){job.synced_revision=payload.revision;job.event_id=payload.event_id;c.last_synced_at=new Date(NOW).toISOString();c.manual_requested=false;}
      if(op==='failure'){job.last_error=payload.error_code;c.error_code=payload.error_code;if(payload.disable)c.enabled=false;}
      if(op==='release'){c.lease_token=null;c.lease_until=null;}
      return {applied:true};
    },
    configure:async(owner,auth,op,payload={})=>{state.operations.push(['configure',op,payload]);if(op==='connect')Object.assign(c,payload);if(op==='settings')c.enabled=payload.enabled;if(op==='disconnect'){c.token_cipher=null;c.enabled=false;}if(op==='sync')c.manual_requested=true;},
    oauth:async(op,payload)=>{if(op==='put'){state.oauth=payload;return {};}const saved=state.oauth;state.oauth=null;return saved;}
  };
  const provider={exchange:async()=>({accessToken:'fixture-access',refreshToken:'fixture-refresh',scope:D.SCOPES}),identity:async()=>({subject:'fixture-google-subject',email:'fixture@example.test'}),refresh:async p=>({accessToken:'fixture-access',refreshToken:p.refreshToken,scope:p.scope}),writeEvent:async args=>{await args.beforeWrite();await args.onCreated();state.writes.push(args.event);return {id:args.event.id};}};
  const service=S.createService({config,store,providerFactory:()=>provider,now:()=>NOW,request:async()=>({id:AUTH})});return {state,store,provider,service};
}
async function invoke(handler,request={}) {
  const response={headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},end(text=''){this.text=text;}};
  await handler({method:'GET',url:'/api/meeting-calendar?action=status',headers:{authorization:'Bearer fixture.jwt'},...request},response);if(response.text.startsWith('{'))response.body=JSON.parse(response.text);return response;
}
const post=(action,body={})=>({method:'POST',url:'/api/meeting-calendar?action='+action,body,headers:{authorization:'Bearer fixture.jwt',origin:config.origin,'content-type':'application/json'}});
test('Member status contains connection progress without credentials, private identifiers or event content',async()=>{
  const f=fixture(),value=await f.service.status(profile);assert.equal(value.connected,true);assert.equal(value.pendingCount,1);assert.equal(value.syncedCount,0);
  for(const key of ['token_cipher','account_id','generation','owner_id','auth_user_id','lease_token','jobs','event_id'])assert.equal(value[key],undefined);
  assert.equal((await invoke(S.createHandler({service:f.service}))).headers['cache-control'],'no-store, private');
});
test('Worker creates only the claimed member schedule and releases its lease',async()=>{
  const f=fixture(),result=await f.service.run(profile.id);assert.equal(result.processed,1);assert.equal(f.state.writes.length,1);assert.equal(f.state.job.synced_revision,2);assert.equal(f.state.c.lease_token,null);
  assert.deepEqual(f.state.operations.find(([op])=>op==='guard')[1],{});assert.equal(f.state.operations.some(([op,p])=>op==='guard'&&p.schedule_id===SCHEDULE&&p.revision===2),true);
});
test('Background workers claim five members and release untouched leases when their budget is nearly spent',async()=>{
  const f=fixture();let clock=NOW,limit;
  f.store.claim=async(owner,count)=>{limit=count;return Array.from({length:3},()=>({connection:structuredClone(f.state.c),jobs:[structuredClone(f.state.job)]}));};
  const write=f.provider.writeEvent;f.provider.writeEvent=async args=>{await write(args);clock=NOW+34000;};
  const service=S.createService({config,store:f.store,providerFactory:()=>f.provider,now:()=>clock,request:async()=>({id:AUTH})});
  const result=await service.run();assert.equal(limit,5);assert.equal(result.processed,1);assert.equal(f.state.writes.length,1);assert.equal(f.state.operations.filter(([op])=>op==='release').length,3);
});
test('A rescheduled meeting retains the same remote ID and does not touch source records',async()=>{
  const f=fixture(),source=structuredClone(f.state.job.desired);await f.service.run(profile.id);const first=f.state.writes[0].id;
  f.state.job.desired.meeting_date='2026-10-25';f.state.job.revision=3;await f.service.run(profile.id);assert.equal(f.state.writes[1].id,first);assert.equal(source.meeting_date,'2026-10-24');
});
test('Changes during delivery remain pending instead of acknowledging an unsent revision',async()=>{
  const f=fixture(),write=f.provider.writeEvent;f.provider.writeEvent=async args=>{await write(args);f.state.job.revision=3;};await f.service.run(profile.id);
  assert.equal(f.state.job.synced_revision,2);assert.equal((await f.service.status(profile)).pendingCount,1);
});
test('An edited queue revision before delivery is fenced before Google writes',async()=>{
  const f=fixture();f.provider.writeEvent=async args=>{f.state.job.revision=3;await args.beforeWrite();f.state.writes.push(args.event);};await f.service.run(profile.id);
  assert.equal(f.state.writes.length,0);assert.equal(f.state.job.synced_revision,0);
});
test('Revoked membership, replaced connection generations and invalid schedules cannot write',async()=>{
  for(const change of [f=>{f.state.member.approval_status='pending';},f=>{f.state.member.is_deleted=true;},f=>{f.state.member.id='other-member';},f=>{f.state.job.generation='44444444-4444-4444-8444-444444444444';},f=>{f.state.job.desired.meeting_date='10/24';}]){const f=fixture();change(f);await f.service.run(profile.id);assert.equal(f.state.writes.length,0);assert.equal(f.state.job.synced_revision,0);}
});
test('Revocation immediately before a Google write prevents transmission',async()=>{
  const f=fixture();f.provider.writeEvent=async args=>{f.state.member.approval_status='rejected';await args.beforeWrite();f.state.writes.push(args.event);};await f.service.run(profile.id);assert.equal(f.state.writes.length,0);
});
test('Refresh failures are bound to the claimed job and disable expired connections safely',async()=>{
  const f=fixture();f.provider.refresh=async()=>{throw new D.CalendarError('reconnect-required');};await f.service.run(profile.id);
  const failure=f.state.operations.find(([op])=>op==='failure')[1];assert.equal(failure.schedule_id,SCHEDULE);assert.equal(failure.revision,2);assert.equal(f.state.c.enabled,false);assert.equal(f.state.c.token_cipher.startsWith('v1.'),true);assert.equal(f.state.writes.length,0);
});
test('Externally deleted events retain their receipt and return a clear error without recreation',async()=>{
  const f=fixture();f.state.job.event_created=true;f.provider.writeEvent=async()=>{throw new D.CalendarError('calendar-remote-missing',409);};await f.service.run(profile.id);assert.equal(f.state.job.event_created,true);assert.equal(f.state.writes.length,0);assert.equal((await f.service.status(profile)).errorCode,'calendar-remote-missing');
});
test('OAuth uses a one-time state, matching secure cookie, encrypted verifier and rechecks membership',async()=>{
  const f=fixture(),result=await f.service.connect(profile),state=new URL(result.url).searchParams.get('state'),pending=structuredClone(f.state.oauth);
  assert.match(result.cookie,/^__Host-growell-meeting-calendar=/);assert.match(result.cookie,/Secure; HttpOnly; SameSite=Lax/);assert.equal(pending.verifier_cipher.includes('fixture-refresh'),false);
  await assert.rejects(f.service.callback(new URLSearchParams({state,code:'fixture-code'}),'wrong-cookie'),{code:'oauth-state-invalid'});
  const redirect=await f.service.callback(new URLSearchParams({state,code:'fixture-code'}),result.cookie);assert.equal(redirect,config.origin+'/?meeting-calendar=connected#/');assert.equal(f.state.oauth,null);
  await assert.rejects(f.service.callback(new URLSearchParams({state,code:'fixture-code'}),result.cookie),{code:'oauth-state-invalid'});
  const token=D.unseal(f.state.c.token_cipher,config.key,D.tokenContext(profile.id,f.state.c.generation));assert.equal(token.refreshToken,'fixture-refresh');
});
test('Cancelled and expired OAuth attempts do not create a connection',async()=>{
  for(const mode of ['cancelled','expired','revoked']){const f=fixture(),result=await f.service.connect(profile),state=new URL(result.url).searchParams.get('state');if(mode==='expired')f.state.oauth.expires_at=new Date(NOW-1).toISOString();if(mode==='revoked')f.state.member.approval_status='rejected';await assert.rejects(f.service.callback(new URLSearchParams({state,...(mode==='cancelled'?{error:'access_denied'}:{code:'fixture-code'})}),result.cookie));assert.equal(f.state.operations.some(([op,action])=>op==='configure'&&action==='connect'),false);}
});
test('Disconnect removes credentials without deleting schedules or Google events',async()=>{
  const f=fixture(),saved=structuredClone(f.state.job);await f.service.mutate(profile,'disconnect',{});assert.equal(f.state.c.token_cipher,null);assert.deepEqual(f.state.job,saved);assert.equal(f.state.writes.length,0);
});
test('HTTP origin, membership and body allowlists block injected ownership or remote IDs',async()=>{
  const f=fixture(),handler=S.createHandler({service:f.service});assert.equal((await invoke(handler,{...post('sync'),headers:{authorization:'Bearer fixture.jwt',origin:'https://other.test','content-type':'application/json'}})).statusCode,403);
  for(const [action,body] of [['connect',{owner_id:'other-member'}],['sync',{event_id:'injected'}],['connect',{refresh_token:'injected'}],['configure',{enabled:'yes'}]])assert.equal((await invoke(handler,post(action,body))).statusCode,400);
  f.state.member.approval_status='pending';assert.equal((await invoke(handler,post('connect'))).statusCode,403);assert.equal(f.state.writes.length,0);
});
test('Worker authentication and safe errors never expose SQL details or provider secrets',async()=>{
  const f=fixture(),handler=S.createHandler({service:f.service});assert.equal((await invoke(handler,{url:'/api/meeting-calendar?action=worker'})).statusCode,401);
  f.store.connection=async()=>{throw new Error('fixture-secret SQL private content');};assert.deepEqual((await invoke(handler)).body,{error:'service-unavailable'});
  for(const [code,wanted] of [['42501','membership-required'],['40001','calendar-busy'],['22023','invalid-request']])await assert.rejects(S.createTransport(async()=>new Response(JSON.stringify({code,message:'private fixture-secret'}),{status:400}))('https://fixture.test'),{code:wanted});
});
test('Missing server setup is reported rather than offering a false working connection',async()=>{
  const handler=S.createHandler({service:S.createService({config:D.getConfig({})})});assert.deepEqual((await invoke(handler,{url:'/api/meeting-calendar?action=config'})).body,{configured:false});assert.equal((await invoke(handler,post('connect'))).statusCode,503);
});
