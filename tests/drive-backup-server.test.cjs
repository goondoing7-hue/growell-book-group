'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/driveBackupService.cjs');
const D = require('../server/driveBackupDomain.cjs');
const NOW = Date.parse('2026-10-04T10:00:00Z');
const AUTH = '11111111-1111-4111-8111-111111111111';
const GEN = '22222222-2222-4222-8222-222222222222';
const profile = {id:'fixture-member',auth_user_id:AUTH,approval_status:'approved',is_deleted:false};
const config = D.getConfig({GROWELL_GOOGLE_CLIENT_ID:'fixture-client',GROWELL_GOOGLE_CLIENT_SECRET:'fixture-secret',GROWELL_SYNC_KEY:Buffer.alloc(32,7).toString('base64'),SUPABASE_SERVICE_ROLE_KEY:'fixture-service',CRON_SECRET:'fixture-cron'});
const data = () => Object.fromEntries(S.TABLES.map(name => [name, []]));
const clone = value => structuredClone(value);
function fixture() {
  const source = data();source.private_entries=[{id:'encrypted-record',user_id:profile.id,iv:'preserved-iv',data:'encrypted-content',created_at:'2026-09-01'}];
  source.habits=[{id:'habit-one',user_id:profile.id,name:'독서',checked_dates:['2026-10-01','2026-10-02']}];
  const c = {owner_id:profile.id,auth_user_id:AUTH,generation:GEN,token_cipher:D.seal({refreshToken:'fixture-refresh',scope:D.SCOPES},config.key,D.tokenContext(profile.id,GEN)),account_id:'fixture-account',account_email:'fixture@example.test',enabled:true,dirty_revision:2,synced_revision:0,lease_token:'lease',lease_until:new Date(NOW+90000).toISOString()};
  const state={c,member:clone(profile),snapshot:{revision:2,data:source},valid:true,operations:[],uploads:[],oauth:null};
  const store={
    profile:async()=>state.member,
    connection:async()=>state.c,
    claim:async(owner)=>state.valid&&c.token_cipher&&(c.enabled||c.manual_requested)?[{connection:clone(c)}]:[],
    snapshot:async()=>clone(state.snapshot),
    apply:async(conn,op,body={})=>{
      state.operations.push([op,body]);if(!state.valid||conn.generation!==c.generation)return {applied:false};
      if(op==='ids')Object.assign(c,body);
      if(op==='created'){c.folder_created ||=body.folder_created;c.file_created ||=body.file_created;}
      if(op==='success'){c.synced_revision=body.revision;c.last_synced_at=new Date(NOW).toISOString();c.last_counts=body.counts;c.manual_requested=false;}
      if(op==='failure'){c.error_code=body.error_code;if(body.disable)c.enabled=false;}
      if(op==='release'){c.lease_token=null;c.lease_until=null;}
      return {applied:true};
    },
    configure:async(owner,auth,op,body={})=>{state.operations.push(['configure',op,body]);if(op==='sync')c.manual_requested=true;if(op==='settings')c.enabled=body.enabled;if(op==='disconnect'){c.token_cipher=null;c.enabled=false;}if(op==='connect'){Object.assign(c,body);}},
    oauth:async(op,body)=>{if(op==='put'){state.oauth=body;return {};}const result=state.oauth;state.oauth=null;return result;}
  };
  const provider={
    exchange:async()=>({accessToken:'fixture-access',refreshToken:'fixture-refresh',scope:D.SCOPES}),
    identity:async()=>({subject:'google-fixture-subject',email:'fixture@example.test'}),
    refresh:async previous=>({accessToken:'fixture-access',refreshToken:previous.refreshToken,scope:previous.scope}),
    allocateIds:async()=>['folder-fixture','file-fixture'],
    writeBackup:async args=>{await args.beforeWrite();assert.equal(c.folder_id,args.folderId);assert.equal(c.file_id,args.fileId);await args.onCreated({folderCreated:true,fileCreated:true});state.uploads.push(JSON.parse(args.content));return {folderCreated:true,fileCreated:true};}
  };
  const service=S.createService({config,store,providerFactory:()=>provider,now:()=>NOW,request:async()=>({id:AUTH})});
  return {state,store,provider,service};
}
async function invoke(handler,request={}) {
  const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(v=''){this.text=v;}};
  await handler({method:'GET',url:'/api/drive-backup?action=status',headers:{authorization:'Bearer fixture.jwt'},...request},res);
  if(res.text.startsWith('{'))res.body=JSON.parse(res.text);return res;
}
function post(action,body={}){return {method:'POST',url:'/api/drive-backup?action='+action,body,headers:{authorization:'Bearer fixture.jwt',origin:config.origin,'content-type':'application/json'}};}

test('complete owned snapshot preserves encrypted bytes/check history and excludes unrelated source keys',()=>{
  const f=fixture();f.state.snapshot.data.profiles=[{password:'not-exported'}];
  const result=S.buildBackup(f.state.snapshot,profile.id,NOW), parsed=JSON.parse(result.content);
  assert.deepEqual(parsed.data.private_entries,f.state.snapshot.data.private_entries);
  assert.deepEqual(parsed.data.habits[0].checked_dates,['2026-10-01','2026-10-02']);
  assert.equal(parsed.data.profiles,undefined);assert.equal(result.counts.habits,1);assert.equal(result.hash.length,64);
});
test('missing table, foreign record or invalid revision cannot replace a previous backup',()=>{
  const f=fixture();delete f.state.snapshot.data.reading_logs;
  assert.throws(()=>S.buildBackup(f.state.snapshot,profile.id,NOW),{code:'snapshot-invalid'});
  f.state.snapshot.data.reading_logs=[{user_id:'another-member'}];
  assert.throws(()=>S.buildBackup(f.state.snapshot,profile.id,NOW),{code:'snapshot-invalid'});
  f.state.snapshot.data.reading_logs=[];f.state.snapshot.revision=0;
  assert.throws(()=>S.buildBackup(f.state.snapshot,profile.id,NOW),{code:'snapshot-invalid'});
});
test('status exposes neither encrypted tokens nor account hash, lease, auth or owner identifiers',()=>{
  const {state}=fixture();state.c.folder_id='folder-fixture';state.c.folder_created=true;
  const view=S.safeConnection(state.c,NOW);
  assert.equal(view.folderUrl,'https://drive.google.com/drive/folders/folder-fixture');
  for(const key of ['token_cipher','account_id','auth_user_id','owner_id','lease_token','generation'])assert.equal(view[key],undefined);
});
test('worker reserves IDs before upload then marks exactly the backed-up revision',async()=>{
  const f=fixture();await f.service.run(profile.id);
  assert.equal(f.state.uploads.length,1);assert.equal(f.state.c.synced_revision,2);
  assert.equal(f.state.c.folder_created,true);assert.equal(f.state.c.lease_token,null);
  assert.equal((await f.service.status(profile)).lastBackedUpAt,new Date(NOW).toISOString());
});
test('edits during upload remain pending for the next run',async()=>{
  const f=fixture(), upload=f.provider.writeBackup;
  f.provider.writeBackup=async args=>{const result=await upload(args);f.state.c.dirty_revision=3;return result;};
  await f.service.run(profile.id);
  assert.equal(f.state.c.synced_revision,2);assert.equal((await f.service.status(profile)).pending,true);
});
test('membership revocation prevents worker upload',async()=>{
  const f=fixture();f.state.member.approval_status='pending';await f.service.run();
  assert.equal(f.state.uploads.length,0);assert.equal(f.state.c.error_code,'membership-required');
});
test('generation change during token refresh prevents stale external writes',async()=>{
  const f=fixture();f.provider.refresh=async p=>{f.state.valid=false;return {accessToken:'fixture-access',...p};};
  await f.service.run();assert.equal(f.state.uploads.length,0);
});
test('snapshot failure retains last success and does not call Google',async()=>{
  const f=fixture();f.state.c.last_synced_at='2026-10-01T00:00:00Z';
  f.store.snapshot=async()=>{throw new Error('secret-database-response');};await f.service.run();
  assert.equal(f.state.uploads.length,0);assert.equal(f.state.c.last_synced_at,'2026-10-01T00:00:00Z');assert.equal(f.state.c.error_code,'service-unavailable');
});
test('manual backup works when automatic backup is paused',async()=>{
  const f=fixture();f.state.c.enabled=false;
  await f.service.mutate(profile,'sync',{});assert.equal(f.state.uploads.length,1);assert.equal(f.state.c.enabled,false);
});
test('disconnect removes server token without deleting remote files',async()=>{
  const f=fixture();const result=await f.service.mutate(profile,'disconnect',{});
  assert.equal(result.connected,false);assert.equal(f.state.uploads.length,0);assert.equal(f.state.c.token_cipher,null);
});
test('OAuth state is single-use, same-browser bound and preserves only encrypted refresh token',async()=>{
  const f=fixture(), start=await f.service.connect(profile), url=new URL(start.url), state=url.searchParams.get('state');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
  assert.ok(!JSON.stringify(f.state.oauth).includes('verifier"'));
  await assert.rejects(f.service.callback(new URLSearchParams({state,code:'fixture-code'}),'bad-cookie'),{code:'oauth-state-invalid'});
  const result=await f.service.callback(new URLSearchParams({state,code:'fixture-code'}),S.COOKIE+'='+state);
  assert.equal(result,config.origin+'/?drive-backup=connected#/');
  const saved=D.unseal(f.state.c.token_cipher,config.key,D.tokenContext(profile.id,f.state.c.generation));
  assert.equal(saved.refreshToken,'fixture-refresh');assert.equal(saved.accessToken,undefined);
  await assert.rejects(f.service.callback(new URLSearchParams({state,code:'fixture-code'}),S.COOKIE+'='+state),{code:'oauth-state-invalid'});
});
test('expired/cancelled OAuth never connects and cannot replay consumed state',async()=>{
  const f=fixture(), start=await f.service.connect(profile), state=new URL(start.url).searchParams.get('state');
  await assert.rejects(f.service.callback(new URLSearchParams({state,error:'access_denied'}),S.COOKIE+'='+state),{code:'oauth-cancelled'});
  assert.equal(f.state.operations.length,0);assert.equal(f.state.oauth,null);
});
test('public config works without member authentication but worker requires its own secret',async()=>{
  const f=fixture(), handler=S.createHandler({service:f.service});
  const cfg=await invoke(handler,{url:'/api/drive-backup?action=config',headers:{}});assert.deepEqual(cfg.body,{configured:true});
  const worker=await invoke(handler,{url:'/api/drive-backup?action=worker'});assert.equal(worker.statusCode,401);assert.equal(f.state.uploads.length,0);
});
test('POST rejects wrong origins and accepts only settings boolean, never client snapshots',async()=>{
  const f=fixture(), handler=S.createHandler({service:f.service}), request=post('sync');request.headers.origin='https://foreign.example';
  assert.equal((await invoke(handler,request)).statusCode,403);
  assert.equal((await invoke(handler,post('sync',{owner:'another-member'}))).statusCode,400);
  assert.equal((await invoke(handler,post('connect',{refresh_token:'injected'}))).statusCode,400);
  assert.equal((await invoke(handler,post('configure',{enabled:'yes'}))).statusCode,400);
  assert.equal(f.state.uploads.length,0);
});
test('API failures never expose raw database/provider exceptions',async()=>{
  const f=fixture();f.store.connection=async()=>{throw new Error('private-token-and-db-detail');};
  const result=await invoke(S.createHandler({service:f.service}));assert.deepEqual(result.body,{error:'service-unavailable'});
  assert.equal(result.headers['cache-control'],'no-store, private');
});
test('unconfigured service never presents a working connection',async()=>{
  const service=S.createService({config:D.getConfig({})});
  const handler=S.createHandler({service});
  assert.deepEqual((await invoke(handler,{url:'/api/drive-backup?action=config'})).body,{configured:false});
  assert.equal((await invoke(handler,post('connect'))).statusCode,503);
});
test('database ownership/size errors are safe and leave previous backups intact',async()=>{
  for(const [code,expected] of [['42501','membership-required'],['22001','backup-too-large'],['40001','backup-busy']]){
    const request=S.createTransport(async()=>new Response(JSON.stringify({code,message:'secret'}),{status:400}));
    await assert.rejects(request('https://example.test'),{code:expected});
  }
});
