'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../server/signup-notification-worker.ts'),'utf8')
  .replace(/^import\s+\{\s*createClient\s*\}\s+from\s+'npm:[^']+'\s*$/m,''));
const fixture=()=>({id:'10000000-0000-4000-8000-000000000001',lease_token:'20000000-0000-4000-8000-000000000001',
  applicant_name:'임시 회원',login_id:'fixture_member',requested_at:'2026-09-28T00:05:00Z',
  sender:'notice@example.invalid',recipient:'goondoing7@kakao.com',template_version:1});
const secret='synthetic-worker-secret-'.repeat(3);
function harness(options={}){
  let handler,claims=0;
  const calls=[],deliveries=[];
  const env={SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',
    GROWELL_NOTIFICATION_WORKER_SECRET:secret,RESEND_API_KEY:'synthetic-resend-key',GROWELL_SIGNUP_FROM:'notice@example.invalid',...options.env};
  const client={rpc:async(name,input)=>{
    calls.push({name,input});
    if(name==='growell_claim_signup_notification'){
      if(options.queueError)return {error:{code:'synthetic_error'}};
      return {data:claims++===0?[options.job||fixture()]:[],error:null};
    }
    assert.equal(name,'growell_finish_signup_notification');
    return {data:options.ack!==false,error:options.ackError?{code:'synthetic_error'}:null};
  }};
  const context={Response,Request,Date,Intl,AbortSignal,
    createClient:()=>client,
    fetch:async(url,request)=>{
      deliveries.push({url,request});
      if(options.fetchThrows)throw new Error('synthetic provider timeout');
      return new Response(options.badJson?'not json':JSON.stringify(options.body||{id:'synthetic-mail-id'}),{status:options.status||200});
    },
    Deno:{env:{get:key=>env[key]},serve:fn=>handler=fn}
  };
  vm.createContext(context);vm.runInContext(source,context,{filename:'signup-notification-worker.ts'});
  async function request(overrides={}){
    const method=overrides.method||'POST';
    const response=await handler(new Request('https://example.invalid/worker',{method,
      headers:{'Content-Type':'application/json','x-growell-worker-secret':overrides.secret??secret},
      ...(method==='GET'?{}:{body:JSON.stringify(overrides.body||{})})}));
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  return {request,calls,deliveries,context};
}

test('notification worker rejects public callers and never reads the queue for them',async()=>{
  for(const options of [{secret:'wrong'},{secret:''},{method:'GET'}]){
    const h=harness(),r=await h.request(options);
    assert.equal(r.status,options.method==='GET'?405:401);assert.equal(h.calls.length,0);assert.equal(h.deliveries.length,0);
    assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  const h=harness({env:{GROWELL_NOTIFICATION_WORKER_SECRET:'too-short'}});
  assert.equal((await h.request({secret:'too-short'})).status,401);assert.equal(h.calls.length,0);
});

test('missing sender credentials leave notices untouched instead of claiming or sending them',async()=>{
  for(const env of [{RESEND_API_KEY:''},{GROWELL_SIGNUP_FROM:''},{GROWELL_SIGNUP_FROM:'onboarding@resend.dev'},
    {GROWELL_SIGNUP_FROM:'Injected\r\nHeader@example.invalid'},{SUPABASE_SERVICE_ROLE_KEY:''}]){
    const h=harness({env}),r=await h.request();
    assert.equal(r.status,503);assert.equal(r.body.error,'notification_not_configured');
    assert.equal(h.calls.length,0);assert.equal(h.deliveries.length,0);
  }
});

test('confirmed signup notice goes only to configured administrator with fixed authenticated management URL',async()=>{
  const h=harness(),r=await h.request({body:{to:'attacker@example.invalid',html:'injected'}});
  assert.equal(r.status,200);assert.equal(r.body.processed,1);assert.equal(h.deliveries.length,1);
  const {url,request}=h.deliveries[0],payload=JSON.parse(request.body);
  assert.equal(url,'https://api.resend.com/emails');
  assert.deepEqual(payload.to,['goondoing7@kakao.com']);assert.equal(payload.from,'GROWELL <notice@example.invalid>');
  assert.match(payload.text,/임시 회원/);assert.match(payload.text,/fixture_member/);assert.match(payload.text,/09:05/);
  assert.match(payload.text,/https:\/\/growell-book.vercel.app\/#\/admin\/users/);
  assert.doesNotMatch(request.body,/attacker|password|pw_hint|avatar|pbkdf2|synthetic-service-key/);
  assert.equal(request.headers['Idempotency-Key'],'growell-signup-v1/'+fixture().id);
  const ack=h.calls.find(c=>c.name==='growell_finish_signup_notification').input;
  assert.equal(ack.p_provider_id,'synthetic-mail-id');assert.equal(ack.p_lease_token,fixture().lease_token);assert.equal(ack.p_error,null);
});

test('names are escaped and retries retain exactly the same payload and idempotency key',async()=>{
  const job={...fixture(),applicant_name:'<script>alert(1)</script>',password:'must-never-copy',pw_hint:'must-never-copy'};
  const h1=harness({job}),h2=harness({job});await h1.request();await h2.request();
  assert.equal(h1.deliveries[0].request.body,h2.deliveries[0].request.body);
  const payload=JSON.parse(h1.deliveries[0].request.body);
  assert.doesNotMatch(payload.html,/<script>|must-never-copy/);assert.match(payload.html,/&lt;script&gt;/);
  assert.equal(h1.deliveries[0].request.headers['Idempotency-Key'],h2.deliveries[0].request.headers['Idempotency-Key']);
});

test('temporary delivery errors are stored for retry without failing or mutating registration',async()=>{
  for(const options of [{status:429},{status:503},{fetchThrows:true},{badJson:true},
    {status:409,body:{name:'concurrent_idempotent_requests'}}]){
    const h=harness(options),r=await h.request();
    assert.equal(r.status,200);assert.equal(h.calls.filter(c=>c.name==='growell_finish_signup_notification').length,1);
    const ack=h.calls.find(c=>c.name==='growell_finish_signup_notification').input;
    assert.equal(ack.p_provider_id,null);assert.equal(ack.p_retryable,true);
    assert.ok(h.calls.every(c=>c.name.startsWith('growell_')&&c.name.endsWith('signup_notification')));
  }
});

test('permanent provider failures require review instead of uncontrolled resends',async()=>{
  for(const options of [{status:403},{status:422},{status:409,body:{name:'invalid_idempotent_request'}}]){
    const h=harness(options);await h.request();
    const ack=h.calls.find(c=>c.name==='growell_finish_signup_notification').input;
    assert.equal(ack.p_retryable,false);assert.equal(ack.p_provider_id,null);
  }
});

test('unexpected recipients or template versions are never submitted to email provider',async()=>{
  for(const job of [{...fixture(),recipient:'other@example.invalid'},{...fixture(),template_version:2},{...fixture(),requested_at:'bad-date'}]){
    const h=harness({job});await h.request();assert.equal(h.deliveries.length,0);
    assert.equal(h.calls.find(c=>c.name==='growell_finish_signup_notification').input.p_error,'invalid_request');
  }
});

test('lost delivery acknowledgement stops batch and preserves server lease for safe retry',async()=>{
  for(const options of [{ack:false},{ackError:true}]){
    const h=harness(options),r=await h.request();
    assert.equal(r.status,503);assert.equal(r.body.error,'acknowledgment_pending');
    assert.equal(h.deliveries.length,1);assert.equal(h.calls.filter(c=>c.name==='growell_claim_signup_notification').length,1);
  }
  const h=harness({queueError:true});assert.equal((await h.request()).status,503);assert.equal(h.deliveries.length,0);
});
