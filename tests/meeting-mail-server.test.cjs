'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const D=require('../server/driveBackupDomain.cjs');const Mail=require('../server/meetingMailService.cjs');
const JOB='33333333-3333-4333-8333-333333333333',LEASE='44444444-4444-4444-8444-444444444444';
const AUTH='11111111-1111-4111-8111-111111111111';
const CONFIG=D.getConfig({GROWELL_GOOGLE_CLIENT_ID:'fixture-client',GROWELL_GOOGLE_CLIENT_SECRET:'fixture-secret',GROWELL_SYNC_KEY:Buffer.alloc(32,5).toString('base64'),SUPABASE_SERVICE_ROLE_KEY:'fixture-service',CRON_SECRET:'fixture-cron'});
const PROFILE={id:'owner',auth_user_id:AUTH};
const RAW={configured:true,connected:true,enabled:true,accountEmail:'member@example.test',lastSentAt:null,pendingCount:1,sentCount:0,reviewCount:0,latestStatus:'pending',errorCode:null};
const SNAPSHOT={applied:true,recipient:'member@example.test',record:{id:JOB,bookId:'emotion',round:1,date:'2026-10-10',topic:'내용 중심 모임',sections:[{summary:'균형',detail:'내용이다.'}],concepts:[],nextMeeting:null,revision:2,status:'published'},materials:[{id:'m',title:'관련 자료',url:'https://untrusted.example/private'}],
  insights:[{authorName:'공개 이름',date:'2026-10-10T10:00:00.000Z',q1:'소감',q2:'배움',q3:'실천',email:'PRIVATE EMAIL MUST NOT PASS',privateEntries:['PRIVATE']}],content_hash:'a'.repeat(64)};
function fixture(options={}){const calls=[],auth=[];let content;
  const service=Mail.createService({config:CONFIG,store:{configure:async(...args)=>{calls.push(['configure',...args]);return options.status||RAW;},apply:async(...args)=>{calls.push(['apply',...args]);return options.snapshot||SNAPSHOT;}},
    authService:{authenticate:async req=>{auth.push(req.headers.authorization);if(req.headers.authorization!=='Bearer fixture-user')throw new D.BackupError('authentication-required',401);return PROFILE;}},
    pdfFactory:async data=>{content=data;if(options.pdfFailure)throw new Error('SECRET PROVIDER DETAILS');return options.pdfBuffer||Buffer.from('%PDF-'+'.'.repeat(120));}});
  return{service,calls,auth,content:()=>content,handler:Mail.createHandler({service})};}
async function invoke(handler,action,{method='POST',body={},authorization='Bearer fixture-user',origin=CONFIG.origin,type='application/json'}={}){const headers={};let data;
  await handler({url:'/api/meeting-record-mail?action='+action,method,body,headers:{authorization,origin,'content-type':type}},{setHeader:(k,v)=>{headers[k]=v;},end:value=>{data=value;},set statusCode(v){headers.status=v;}});
  return{headers,body:Buffer.isBuffer(data)?data:JSON.parse(data)};}
test('member mail status and toggle use authenticated owner and never return service-only metadata',async()=>{
  const f=fixture({status:{...RAW,auth_user_id:AUTH,lease_token:LEASE,recipient:'LEAK',token_cipher:'SECRET'}});
  const res=await invoke(f.handler,'status',{method:'GET'});assert.equal(res.headers.status,200);assert.deepEqual(res.body,Mail.safeStatus(RAW));
  assert.equal(JSON.stringify(res.body).includes('SECRET'),false);assert.deepEqual(f.calls[0],['configure','owner',AUTH,'status',{}]);
  const toggled=await invoke(f.handler,'configure',{body:{enabled:false}});assert.equal(toggled.headers.status,200);assert.deepEqual(f.calls[1],['configure','owner',AUTH,'settings',{enabled:false}]);
});
test('arbitrary recipient, owner, resend and account identity cannot be supplied by a member',async()=>{
  const f=fixture();for(const body of [{enabled:true,owner:'other'},{enabled:true,recipient:'victim@example.test'},{enabled:true,account_id:'foreign'},{resend:true},{}]){const result=await invoke(f.handler,'configure',{body});assert.equal(result.headers.status,400);}
  assert.equal(f.calls.length,0);assert.equal((await invoke(f.handler,'send')).headers.status,405);
});
test('toggle requires a same-origin JSON request and an authenticated member',async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,'configure',{origin:'https://attacker.example',body:{enabled:true}})).headers.status,403);
  assert.equal((await invoke(f.handler,'configure',{type:'text/plain',body:{enabled:true}})).headers.status,400);
  assert.equal((await invoke(f.handler,'configure',{authorization:'Bearer unknown',body:{enabled:true}})).headers.status,401);assert.equal(f.calls.length,0);
});
test('PDF is worker-only and a normal member cannot use its job or a public route to obtain it',async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,'pdf',{body:{jobId:JOB,lease:LEASE}})).headers.status,401);assert.equal(f.calls.length,0);
  assert.equal((await invoke(f.handler,'pdf',{method:'GET',authorization:'Bearer fixture-cron',body:{jobId:JOB,lease:LEASE}})).headers.status,405);
  assert.equal((await invoke(f.handler,'pdf',{authorization:'Bearer fixture-cron',body:{jobId:JOB,lease:LEASE,recipient:'attacker@example.test'}})).headers.status,400);
  assert.equal(f.calls.length,0);
});
test('PDF route renders only a database-guarded lease snapshot and returns an exact revision fence',async()=>{
  const f=fixture(),res=await invoke(f.handler,'pdf',{authorization:'Bearer fixture-cron',origin:undefined,body:{jobId:JOB,lease:LEASE}});
  assert.equal(res.headers.status,200);assert.equal(res.headers['Content-Type'],'application/pdf');assert.equal(res.headers['X-Growell-Record-Revision'],'2');assert.equal(res.headers['Cache-Control'],'no-store, private');
  assert.equal(res.headers['X-Growell-Content-Hash'],'a'.repeat(64));
  assert.deepEqual(f.calls,[['apply',JOB,LEASE,'snapshot',{}]]);assert.equal(f.auth.length,0);assert.equal(f.content().bookTitle,Mail.BOOKS.emotion);
  assert.deepEqual(f.content().materials,[{title:'관련 자료'}]);assert.equal(Object.hasOwn(f.content(),'recipient'),false);assert.equal(res.body.subarray(0,5).toString(),'%PDF-');
  assert.deepEqual(f.content().insights,[{authorName:'공개 이름',date:'2026-10-10T10:00:00.000Z',q1:'소감',q2:'배움',q3:'실천'}]);assert.equal(JSON.stringify(f.content()).includes('PRIVATE'),false);
});
test('stale or withdrawn records and failed PDF rendering expose no content or provider details',async()=>{
  for(const snapshot of [{applied:false},{...SNAPSHOT,record:{...SNAPSHOT.record,status:'draft'}},{...SNAPSHOT,record:{...SNAPSHOT.record,round:'1\r\nInjected:yes'}}]){const f=fixture({snapshot});const res=await invoke(f.handler,'pdf',{authorization:'Bearer fixture-cron',body:{jobId:JOB,lease:LEASE}});assert.equal(res.headers.status,409);assert.equal(f.content(),undefined);}
  const f=fixture({pdfFailure:true}),res=await invoke(f.handler,'pdf',{authorization:'Bearer fixture-cron',body:{jobId:JOB,lease:LEASE}});assert.equal(res.headers.status,503);assert.equal(JSON.stringify(res.body).includes('SECRET'),false);
  assert.equal((await invoke(fixture({pdfBuffer:Buffer.from('invalid pdf')}).handler,'pdf',{authorization:'Bearer fixture-cron',body:{jobId:JOB,lease:LEASE}})).headers.status,503);
});
test('status validation never exposes unknown delivery states as sent and service RPC errors stay errors',async()=>{
  assert.equal(Mail.safeStatus({...RAW,latestStatus:'unknown',errorCode:'smtp private response'}).latestStatus,'none');assert.equal(Mail.safeStatus({...RAW,latestStatus:'unknown',errorCode:'smtp private response'}).errorCode,'service-unavailable');
  assert.equal(Mail.safeStatus({...RAW,reviewCount:3,latestStatus:'uncertain',errorCode:'delivery-uncertain'}).latestStatus,'uncertain');
  assert.throws(()=>Mail.safeStatus({error:'query failed'}),e=>e.code==='service-unavailable');
});
test('service store sends only fixed privileged RPC endpoints and serializes exact owner guards',async()=>{
  const calls=[],store=Mail.createStore(CONFIG,async(...args)=>{calls.push(args);return{};});await store.configure('owner',AUTH,'status');await store.apply(JOB,LEASE,'prepare',{record_revision:2});
  assert.equal(calls[0][0],CONFIG.database+'/rest/v1/rpc/growell_meeting_mail_configure');assert.equal(calls[0][1].headers.Authorization,'Bearer fixture-service');
  assert.deepEqual(JSON.parse(calls[1][1].body),{p_job:JOB,p_lease:LEASE,p_operation:'prepare',p_payload:{record_revision:2}});
});
test('PDF preparation diagnostics reveal a fixed category only, preserving all source and credential details',()=>{
  for(const [error,expected] of [
    [Object.assign(new Error('PRIVATE PATH AND RECORD'),{code:'MODULE_NOT_FOUND'}),'pdf-module-missing'],
    [Object.assign(new Error('PRIVATE PATH AND RECORD'),{code:'ENOENT'}),'pdf-font-asset-missing'],
    [Object.assign(new Error('PRIVATE GLYPH AND RECORD'),{code:'PDF_UNSUPPORTED_GLYPH'}),'pdf-glyph-unsupported'],
    [new TypeError('PRIVATE CONTENT'), 'pdf-content-invalid'],
    [new Error('SECRET PROVIDER'), 'pdf-render-unavailable']
  ]){
    const result=Mail.pdfFailure(error);
    assert.equal(result.code,expected);assert.equal(result.status,503);
    assert.equal(result.message.includes('PRIVATE'),false);assert.equal(result.message.includes('SECRET'),false);
  }
});
