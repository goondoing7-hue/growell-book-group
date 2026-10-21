'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Drive = require('../server/driveBackupDomain.cjs');
const Calendar = require('../server/meetingCalendarDomain.cjs');
const Service = require('../server/driveBackupService.cjs');
const Google = require('../server/googleConnectionService.cjs');

const NOW = Date.parse('2026-10-12T09:00:00+09:00');
const AUTH = '11111111-1111-4111-8111-111111111111';
const PROFILE = {id: 'fixture-member', auth_user_id: AUTH, approval_status: 'approved', is_deleted: false};
const CONFIG = Drive.getConfig({GROWELL_GOOGLE_CLIENT_ID: 'fixture-client', GROWELL_GOOGLE_CLIENT_SECRET: 'fixture-secret',
  GROWELL_SYNC_KEY: Buffer.alloc(32, 9).toString('base64'), SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', CRON_SECRET: 'fixture-cron'});
const TOKENS = {accessToken: 'fixture-access', refreshToken: 'fixture-refresh', scope: Drive.GOOGLE_SCOPES};
const IDENTITY = {subject: 'fixture-google-account', email: 'member@example.test'};

function fixture({scope = Drive.GOOGLE_SCOPES, driveFailure, calendarFailure, mailFailure, authUser} = {}) {
  const state = {pending: null, member: structuredClone(PROFILE), calls: [], writes: [], exchange: 0, authUser:authUser || {id:AUTH,identities:[]}, authReads:[]};
  const configure = (name, failure) => async (owner, auth, operation, payload) => {
    state.calls.push({name, owner, auth, operation, payload});
    if (failure) throw failure;
    state.writes.push({name, payload});
  };
  state.drive = {owner_id: PROFILE.id, auth_user_id: AUTH, generation: '22222222-2222-4222-8222-222222222222', token_cipher: 'fixture-drive-cipher',
    account_id: Drive.hash(IDENTITY.subject), account_email: IDENTITY.email, enabled: true, dirty_revision: 1, synced_revision: 1};
  state.calendar = {owner_id: PROFILE.id, auth_user_id: AUTH, generation: '33333333-3333-4333-8333-333333333333', token_cipher: 'fixture-calendar-cipher',
    account_id: Drive.hash(IDENTITY.subject), account_email: IDENTITY.email, enabled: true};
  const driveStore = {profile: async () => state.member, connection: async () => state.drive, configure: configure('drive', driveFailure),
    oauth: async (operation, payload) => { if (operation === 'put') { state.pending = payload; return {}; }
      const pending = state.pending; state.pending = null; return pending; }};
  const calendarStore = {connection: async () => state.calendar, jobs: async () => [], configure: configure('calendar', calendarFailure)};
  state.mail = {connected:true,enabled:true,accountEmail:IDENTITY.email,latestStatus:'pending',pendingCount:1,lastSentAt:null};
  const mailStore = {configure: async (owner, auth, operation, payload) => {
    if (mailFailure) throw mailFailure;
    if (operation !== 'status') state.calls.push({name:'mail',owner,auth,operation,payload});
    return state.mail;
  }};
  const provider = {exchange: async () => { state.exchange++; return {...TOKENS, scope}; }, identity: async () => IDENTITY};
  const service = Service.createService({config: CONFIG, store: driveStore, calendarStore, mailStore, providerFactory: () => provider,
    now: () => NOW, request: async url => {state.authReads.push(url);return structuredClone(state.authUser);}});
  return {state, service, driveStore, calendarStore, mailStore, provider};
}

async function finish(f, combined = true) {
  const start = await f.service.connect(PROFILE, combined), state = new URL(start.url).searchParams.get('state');
  const result = await f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=' + state);
  return {start, result, state};
}

test('one Google authorization uses the already registered Drive callback and both limited scopes', async () => {
  const f = fixture(), start = await f.service.connect(PROFILE, true), url = new URL(start.url);
  assert.equal(url.origin + url.pathname, Drive.AUTH_URL);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.origin + '/api/drive-backup');
  assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set(['openid', 'email', Drive.DRIVE_SCOPE, Calendar.CALENDAR_SCOPE]));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(start.cookie.includes('Secure; HttpOnly; SameSite=Lax'), true);
  assert.equal(JSON.stringify(f.state.pending).includes('googleConnection'), false);
});

test('one grant creates both owner-specific encrypted connections without exporting access tokens or source data', async () => {
  const f = fixture(), {result} = await finish(f);
  assert.equal(result, CONFIG.origin + '/?google-connection=connected#/');
  assert.equal(f.state.exchange, 1); assert.equal(f.state.writes.length, 2);
  const [drive, calendar] = f.state.writes;
  assert.deepEqual(f.state.calls.map(({name, owner, auth, operation}) => ({name, owner, auth, operation})), [
    {name: 'drive', owner: PROFILE.id, auth: AUTH, operation: 'connect'},
    {name: 'calendar', owner: PROFILE.id, auth: AUTH, operation: 'connect'},
    {name: 'mail', owner: PROFILE.id, auth: AUTH, operation: 'connect'}]);
  assert.equal(drive.payload.account_id, calendar.payload.account_id);
  assert.equal(drive.payload.account_id, Drive.hash(IDENTITY.subject));
  assert.equal(drive.payload.account_email, IDENTITY.email);
  assert.notEqual(drive.payload.generation, calendar.payload.generation);
  const driveToken = Drive.unseal(drive.payload.token_cipher, CONFIG.key, Drive.tokenContext(PROFILE.id, drive.payload.generation));
  const calendarToken = Calendar.unseal(calendar.payload.token_cipher, CONFIG.key, Calendar.tokenContext(PROFILE.id, calendar.payload.generation));
  assert.deepEqual(driveToken, {refreshToken: TOKENS.refreshToken, scope: Drive.GOOGLE_SCOPES});
  assert.deepEqual(calendarToken, driveToken);
  assert.throws(() => Calendar.unseal(drive.payload.token_cipher, CONFIG.key, Calendar.tokenContext(PROFILE.id, drive.payload.generation)), /connection-key-invalid/);
  for (const {payload} of f.state.calls) {
    assert.equal(JSON.stringify(payload).includes(TOKENS.refreshToken), false);
    for (const field of ['accessToken', 'folder_id', 'file_id', 'event_id', 'jobs', 'snapshot', 'records']) assert.equal(payload[field], undefined);
  }
});

test('granting only one permission cannot modify either prior connection', async () => {
  for (const scope of [Drive.SCOPES, Calendar.SCOPES, Drive.DRIVE_SCOPE + ' ' + Calendar.CALENDAR_SCOPE]) {
    const f = fixture({scope});
    await assert.rejects(finish(f), {code: 'consent-required'});
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.writes.length, 0);
  }
});

test('a partial store outage is reported and never disconnects a successfully connected service', async () => {
  for (const options of [{driveFailure: new Drive.BackupError('backup-busy', 409)}, {calendarFailure: new Calendar.CalendarError('calendar-busy', 409)}]) {
    const f = fixture(options), {result} = await finish(f);
    assert.equal(result, CONFIG.origin + '/?google-connection=partial#/');
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.calls.length, 2);
    assert.equal(f.state.calls.every(({operation}) => operation === 'connect'), true);
  }
});

test('both store failures produce a safe error and do not claim a successful connection', async () => {
  const f = fixture({driveFailure: new Error('secret storage detail'), calendarFailure: new Error('private provider detail')});
  await assert.rejects(finish(f), {code: 'service-unavailable'});
  assert.equal(f.state.writes.length, 0);
});

test('membership revocation between writes prevents the next connection and preserves the first success', async () => {
  const f = fixture(), configure = f.driveStore.configure;
  f.driveStore.configure = async (...args) => { await configure(...args); f.state.member.approval_status = 'pending'; };
  await assert.rejects(finish(f), {code: 'membership-required'});
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes.length, 1);
});

test('a permission failure in the first connector stops instead of claiming a partial success', async () => {
  const f = fixture({driveFailure: new Drive.BackupError('membership-required', 403)});
  await assert.rejects(finish(f), {code: 'membership-required'});
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes.length, 0);
});

test('the signed, encrypted pending state selects unified mode and remains single-use and browser-bound', async () => {
  const f = fixture(), start = await f.service.connect(PROFILE, true), state = new URL(start.url).searchParams.get('state');
  await assert.rejects(f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=another-browser'), {code: 'oauth-state-invalid'});
  assert.equal(f.state.exchange, 0); assert.ok(f.state.pending);
  await f.service.callback(new URLSearchParams({state, code: 'fixture-code', combined: 'false'}), Service.COOKIE + '=' + state);
  assert.equal(f.state.writes.length, 2);
  await assert.rejects(f.service.callback(new URLSearchParams({state, code: 'fixture-code'}), Service.COOKIE + '=' + state), {code: 'oauth-state-invalid'});
  assert.equal(f.state.exchange, 1);
});

test('legacy pending states retain their original single Drive callback behavior', async () => {
  const f = fixture({scope: Drive.SCOPES}), {result, start} = await finish(f, false);
  assert.equal(new URL(start.url).searchParams.get('scope'), Drive.SCOPES);
  assert.equal(result, CONFIG.origin + '/?drive-backup=connected#/');
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].name, 'drive');
});

test('HTTP connect always starts the combined flow, rejecting client owner, scopes and mode overrides', async () => {
  const f = fixture(), handler = Service.createHandler({service: f.service});
  async function invoke(body = {}, headers = {}) {
    const response = {headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.value = value; }};
    await handler({method: 'POST', url: '/api/drive-backup?action=connect', body,
      headers: {authorization: 'Bearer fixture.jwt', origin: CONFIG.origin, 'content-type': 'application/json', ...headers}}, response);
    return {...response, body: JSON.parse(response.value)};
  }
  const accepted = await invoke();
  assert.equal(accepted.statusCode, 200); assert.equal(new URL(accepted.body.url).searchParams.get('scope'), Drive.GOOGLE_SCOPES);
  for (const body of [{owner: 'another-member'}, {combined: false}, {scope: 'https://mail.google.com/'}]) assert.equal((await invoke(body)).statusCode, 400);
  assert.equal((await invoke({}, {origin: 'https://foreign.example'})).statusCode, 403);
});

test('both scope and refresh-token validation complete before connection writes', async () => {
  const saved = [];
  for (const tokens of [{...TOKENS, refreshToken: ''}, {...TOKENS, scope: ''}, {...TOKENS, scope: null}]) {
    await assert.rejects(Google.saveConnections({config: CONFIG, driveStore: {configure: async () => saved.push('drive')},
      calendarStore: {configure: async () => saved.push('calendar')}, approved: async () => PROFILE, owner: PROFILE.id, authId: AUTH, tokens, identity: IDENTITY}), {code: 'consent-required'});
  }
  assert.deepEqual(saved, []);
});

test('combined status compares stable Google subject hashes and never returns connector secrets', async () => {
  const f = fixture(), value = await f.service.googleStatus(PROFILE);
  assert.equal(value.connected, true); assert.equal(value.sameAccount, true); assert.equal(value.partial, false); assert.equal(value.unavailable, false);
  const serialized = JSON.stringify(value);
  for (const secret of ['fixture-drive-cipher', 'fixture-calendar-cipher', 'account_id', 'auth_user_id', 'generation', 'lease_token', 'owner_id']) assert.equal(serialized.includes(secret), false);
  // Changed or unavailable display email cannot change authenticated identity.
  f.state.calendar.account_email = '';
  assert.equal((await f.service.googleStatus(PROFILE)).sameAccount, true);
  f.state.calendar.account_id = Drive.hash('another-google-account');
  const mismatch = await f.service.googleStatus(PROFILE);
  assert.equal(mismatch.sameAccount, false); assert.equal(mismatch.connected, false); assert.equal(mismatch.partial, true);
});

test('single-service failure keeps the known status and marks unavailable state without claiming disconnection', async () => {
  for (const target of ['driveStore', 'calendarStore']) {
    const f = fixture(); f[target].connection = async () => { throw new Error('secret db detail'); };
    const result = await f.service.googleStatus(PROFILE);
    const failed = target === 'driveStore' ? result.drive : result.calendar, known = target === 'driveStore' ? result.calendar : result.drive;
    assert.equal(failed.connected, null); assert.equal(failed.unavailable, true); assert.equal(failed.errorCode, 'service-unavailable');
    assert.equal(known.connected, true); assert.equal(result.connected, null); assert.equal(result.sameAccount, null);
    assert.equal(result.partial, true); assert.equal(result.unavailable, true); assert.equal(JSON.stringify(result).includes('secret db detail'), false);
  }
});

test('no connections are distinct from a failed status lookup and foreign connection ownership fails closed', async () => {
  const f = fixture(); f.state.drive = null; f.state.calendar = null;
  const empty = await f.service.googleStatus(PROFILE);
  assert.equal(empty.connected, false); assert.equal(empty.partial, false); assert.equal(empty.unavailable, false);
  const foreign = fixture(); foreign.state.calendar.owner_id = 'another-member';
  await assert.rejects(foreign.service.googleStatus(PROFILE), {code: 'membership-required'});
});

test('calendar job lookup failures are unknown and cannot remove successful Drive status', async () => {
  const f = fixture(); f.calendarStore.jobs = async () => { throw new Error('private job content'); };
  const failed = await f.service.googleStatus(PROFILE);
  assert.equal(failed.drive.connected, true); assert.equal(failed.calendar.connected, null); assert.equal(failed.connected, null);
  f.calendarStore.jobs = async () => [{owner_id: 'another-member', generation: f.state.calendar.generation}];
  const foreign = await f.service.googleStatus(PROFILE);
  assert.equal(foreign.calendar.unavailable, true); assert.equal(foreign.calendar.errorCode, 'service-unavailable');
  assert.equal(foreign.calendar.jobs, undefined);
});

test('combined status is authenticated and same-source filtered without accepting browser identifiers', async () => {
  const f = fixture(), handler = Service.createHandler({service: f.service});
  const invoke = async headers => {
    const response = {headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, end(value) { this.value = value; }};
    await handler({method: 'GET', url: '/api/drive-backup?action=google-status&owner=another-member', headers}, response);
    return {...response, body: JSON.parse(response.value)};
  };
  assert.equal((await invoke({})).statusCode, 401);
  const accepted = await invoke({authorization: 'Bearer fixture.jwt'});
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.body.connected, true);
  assert.equal(accepted.headers['cache-control'], 'no-store, private');
});

test('mail enrollment follows both grants, derives recipient only on the server, and preserves independent failures', async () => {
  const f=fixture();await finish(f);
  assert.deepEqual(f.state.calls.at(-1),{name:'mail',owner:PROFILE.id,auth:AUTH,operation:'connect',payload:{}});
  const partial=fixture({mailFailure:new Error('private mail database detail')});
  assert.equal((await finish(partial)).result,CONFIG.origin+'/?google-connection=partial#/');
  assert.equal(partial.state.writes.length,2);
  const value=await partial.service.googleStatus(PROFILE);
  assert.equal(value.drive.connected,true);assert.equal(value.calendar.connected,true);
  assert.equal(value.mail.connected,null);assert.equal(value.mail.unavailable,true);
  assert.equal(JSON.stringify(value).includes('private mail database detail'),false);
  const missing=fixture({mailFailure:new Drive.BackupError('not-configured')});
  assert.deepEqual((await missing.service.googleStatus(PROFILE)).mail,{configured:false,loginAccountMatches:null});
});

test('mail settings are owner authenticated, enabled-only and never change either Google token store', async () => {
  const f=fixture(),handler=Service.createHandler({service:f.service});
  async function invoke(body,origin=CONFIG.origin){
    const res={setHeader(){},end(value){this.body=JSON.parse(value);}};
    await handler({method:'POST',url:'/api/drive-backup?action=mail-configure',headers:{authorization:'Bearer fixture.jwt',origin,'content-type':'application/json'},body},res);
    return res;
  }
  assert.equal((await invoke({enabled:false})).statusCode,200);
  assert.deepEqual(f.state.calls,[{name:'mail',owner:PROFILE.id,auth:AUTH,operation:'settings',payload:{enabled:false}}]);
  for(const body of [{enabled:true,recipient:'foreign@example.test'},{owner:'foreign',enabled:true},{enabled:'true'},{}])assert.equal((await invoke(body)).statusCode,400);
  assert.equal((await invoke({enabled:true},'https://foreign.example')).statusCode,403);
  assert.equal(f.state.writes.length,0);
});

test('only a missing mail RPC maps to setup state, temporary or unrelated lookup failures remain unavailable', async () => {
  for(const [url,dbCode,expected] of [
    [CONFIG.database+'/rest/v1/rpc/growell_meeting_mail_configure','PGRST202','not-configured'],
    [CONFIG.database+'/rest/v1/rpc/growell_meeting_mail_configure','42883','not-configured'],
    [CONFIG.database+'/rest/v1/rpc/growell_meeting_mail_configure','57014','service-unavailable'],
    [CONFIG.database+'/rest/v1/rpc/growell_drive_backup_configure','PGRST202','service-unavailable']
  ]){
    const transport=Service.createTransport(async()=>new Response(JSON.stringify({code:dbCode,message:'private detail'}),{status:404}));
    await assert.rejects(transport(url),{code:expected});
  }
});

const linkedUser = (subject=IDENTITY.subject) => ({id:AUTH,identities:[{provider:'email',identity_data:{}},{provider:'google',provider_id:subject,identity_data:{sub:subject,email:'display-can-change@example.test'}}]});
async function finishStart(f,start) {
  const state=new URL(start.url).searchParams.get('state');
  return f.service.callback(new URLSearchParams({state,code:'fixture-code'}),Service.COOKIE+'='+state);
}

test('a compact switch grant creates both token stores but enables only the requested service',async()=>{
  for(const service of ['drive','calendar','mail']) {
    const f=fixture();f.state.drive=null;f.state.calendar=null;f.state.mail={...f.state.mail,connected:false,enabled:false};
    const start=await f.service.connect(PROFILE,true,service);
    const state=new URL(start.url).searchParams.get('state');
    const sealed=Drive.unseal(f.state.pending.verifier_cipher,CONFIG.key,'drive-backup-oauth:'+PROFILE.id+':'+Drive.hash(state));
    assert.deepEqual(sealed.desiredEnabled,{drive:service==='drive',calendar:service==='calendar',mail:service==='mail'});
    assert.equal(sealed.service,service);assert.equal(JSON.stringify(f.state.pending).includes('desiredEnabled'),false);
    assert.equal(await finishStart(f,start),CONFIG.origin+'/?google-connection=connected#/');
    for(const write of f.state.writes){assert.equal(write.payload.enabled,write.name===service?true:undefined);assert.equal(write.payload.default_enabled,write.name===service?undefined:false);}
    assert.deepEqual(f.state.calls.at(-1),{name:'mail',owner:PROFILE.id,auth:AUTH,operation:'connect',payload:service==='mail'?{enabled:true}:{default_enabled:false}});
  }
});

test('reconsent delegates unselected preferences to locked SQL whether another tab changed OFF to ON or ON to OFF',async()=>{
  for(const latest of [true,false]){
    const f=fixture();f.state.drive.enabled=!latest;f.state.mail.enabled=false;
    const start=await f.service.connect(PROFILE,true,'mail');
    f.state.drive.enabled=latest;f.state.calendar.enabled=latest;
    await finishStart(f,start);
    for(const write of f.state.writes){assert.equal(Object.hasOwn(write.payload,'enabled'),false);assert.equal(write.payload.default_enabled,false);}
    assert.deepEqual(f.state.calls.at(-1).payload,{enabled:true});
  }
});

test('a different service that was ON delegates its latest preference to locked SQL instead of forcing it back ON',async()=>{
  const f=fixture(),start=await f.service.connect(PROFILE,true,'drive');
  await finishStart(f,start);
  assert.equal(f.state.writes.find(value=>value.name==='drive').payload.enabled,true);
  assert.equal(Object.hasOwn(f.state.writes.find(value=>value.name==='calendar').payload,'enabled'),false);
  assert.equal(f.state.writes.find(value=>value.name==='calendar').payload.default_enabled,false);
  assert.deepEqual(f.state.calls.at(-1).payload,{default_enabled:false});
});

test('compact intent rejects unknown service, unavailable preferences and cancellation without connector writes',async()=>{
  const f=fixture();await assert.rejects(f.service.connect(PROFILE,true,'__proto__'),{code:'invalid-request'});assert.equal(f.state.pending,null);
  const unavailable=fixture();unavailable.calendarStore.connection=async()=>{throw new Drive.BackupError('service-unavailable');};
  await assert.rejects(unavailable.service.connect(PROFILE,true,'drive'),{code:'service-unavailable'});assert.equal(unavailable.state.pending,null);
  const cancel=fixture(),start=await cancel.service.connect(PROFILE,true,'drive'),state=new URL(start.url).searchParams.get('state');
  await assert.rejects(cancel.service.callback(new URLSearchParams({state,error:'access_denied'}),Service.COOKIE+'='+state),{code:'oauth-cancelled'});
  assert.equal(cancel.state.exchange,0);assert.equal(cancel.state.writes.length,0);assert.deepEqual(cancel.state.calls,[]);
});

test('linked Google consent is bound to the verified subject, never browser email or metadata',async()=>{
  const f=fixture({authUser:linkedUser()}),start=await f.service.connect(PROFILE,true,'drive');
  await finishStart(f,start);assert.equal(f.state.writes.length,2);
  assert.ok(f.state.authReads.every(url=>url===CONFIG.database+'/auth/v1/admin/users/'+AUTH));
  const value=await f.service.googleStatus(PROFILE);
  assert.equal(value.googleLoginLinked,true);assert.equal(value.loginAccountMatches,true);
  assert.equal(value.drive.loginAccountMatches,true);assert.equal(value.calendar.loginAccountMatches,true);assert.equal(value.mail.loginAccountMatches,true);
  assert.equal(JSON.stringify(value).includes(IDENTITY.subject),false);
  const forged=fixture({authUser:{id:AUTH,identities:[],user_metadata:{sub:IDENTITY.subject,provider:'google'}}});
  assert.equal((await forged.service.googleStatus(PROFILE)).googleLoginLinked,false);
});

test('wrong or changed Google accounts are rejected before any connection or mail enrollment writes',async()=>{
  for(const changed of ['consented-account','login-during-consent','login-during-exchange']) {
    const f=fixture({authUser:linkedUser()}),start=await f.service.connect(PROFILE,true,'mail');
    if(changed==='consented-account')f.provider.identity=async()=>({subject:'another-google-account',email:IDENTITY.email});
    if(changed==='login-during-consent')f.state.authUser=linkedUser('changed-google-identity');
    if(changed==='login-during-exchange')f.provider.identity=async()=>{f.state.authUser=linkedUser('changed-google-identity');return IDENTITY;};
    await assert.rejects(finishStart(f,start),{code:'google-account-mismatch'});
    assert.equal(f.state.writes.length,0);assert.deepEqual(f.state.calls,[]);
    if(changed==='login-during-consent')assert.equal(f.state.exchange,0);
  }
});

test('subject checks fail closed for malformed Auth identities and preserve actual enabled state on mismatch',async()=>{
  for(const authUser of [{id:AUTH},{id:'different-auth',identities:[]},{id:AUTH,identities:[{provider:'google',identity_data:{}}]},
    {id:AUTH,identities:[{provider:'google',provider_id:'different',identity_data:{sub:IDENTITY.subject}}]}]) {
    const f=fixture({authUser});await assert.rejects(f.service.connect(PROFILE,true,'drive'));assert.equal(f.state.pending,null);assert.equal(f.state.writes.length,0);
  }
  const f=fixture({authUser:linkedUser()});f.state.drive.account_id=Drive.hash('old-explicitly-connected-google');
  const status=await f.service.googleStatus(PROFILE);
  assert.equal(status.drive.enabled,true);assert.equal(status.drive.loginAccountMatches,false);assert.equal(status.calendar.loginAccountMatches,true);
  assert.equal(status.loginAccountMatches,false);
  await assert.rejects(f.service.mutate(PROFILE,'configure',{enabled:true}),{code:'google-account-mismatch'});
  await assert.rejects(f.service.mutate(PROFILE,'sync',{}),{code:'google-account-mismatch'});
  await assert.rejects(f.service.mutate(PROFILE,'mail-configure',{enabled:true}),{code:'google-account-mismatch'});
  assert.equal(f.state.writes.length,0);assert.deepEqual(f.state.calls,[]);
  await f.service.mutate(PROFILE,'configure',{enabled:false});
  assert.deepEqual(f.state.calls.at(-1),{name:'drive',owner:PROFILE.id,auth:AUTH,operation:'settings',payload:{enabled:false}});
});

test('HTTP compact connect accepts only a service name and never caller-supplied account or intent settings',async()=>{
  const f=fixture({authUser:linkedUser()}),handler=Service.createHandler({service:f.service});
  async function invoke(body){const res={setHeader(){},end(value){this.body=JSON.parse(value);}};await handler({method:'POST',url:'/api/drive-backup?action=connect',body,headers:{authorization:'Bearer fixture.jwt',origin:CONFIG.origin,'content-type':'application/json'}},res);return res;}
  assert.equal((await invoke({service:'calendar'})).statusCode,200);
  for(const body of [{service:'unknown'},{service:null},{service:'drive',desiredEnabled:{mail:true}},{service:'drive',subject:IDENTITY.subject},{service:'drive',email:'another@example.test'}])assert.equal((await invoke(body)).statusCode,400);
});
