'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const workerSource=fs.readFileSync(path.join(__dirname,'../server/signup-notification-worker.ts'),'utf8');
const source=stripTypeScriptTypes(workerSource.replace(/^import\s+.+\s+from\s+'npm:[^']+'\s*$/gm,''));
const account='goondoing7@gmail.com';
const secret='synthetic-worker-secret-'.repeat(3);
const fixture=()=>({id:'10000000-0000-4000-8000-000000000001',lease_token:'20000000-0000-4000-8000-000000000001',
  applicant_name:'임시 회원',login_id:'fixture_member',requested_at:'2026-09-28T00:05:00Z',
  sender:account,recipient:account,provider:'gmail_smtp',template_version:1});
function harness(options={}){
  let handler,claims=0,verifications=0,closed=0;
  const calls=[],deliveries=[],transports=[];
  const env={SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',
    GROWELL_GMAIL_APP_PASSWORD:'abcdefghijklmnop',...options.env};
  const client={rpc:async(name,input)=>{
    calls.push({name,input});
    if(name==='growell_authorize_signup_notification_worker'){
      if(options.authThrows)throw new Error('private DB details');
      return {data:input.p_secret===secret,error:options.authError?{code:'private error'}:null};
    }
    if(name==='growell_claim_signup_notification_v2'){
      if(options.queueError)return {error:{code:'synthetic_error'}};
      return {data:!options.empty&&claims++===0?[options.job||fixture()]:[],error:null};
    }
    assert.equal(name,'growell_finish_signup_notification');
    if(options.ackThrows)throw new Error('synthetic DB timeout');
    return {data:options.ack!==false,error:options.ackError?{code:'synthetic_error'}:null};
  }};
  const context={Response,Request,Date,Intl,crypto:{randomUUID:()=> '30000000-0000-4000-8000-000000000001'},
    createClient:()=>client,
    nodemailer:{createTransport:config=>{
      transports.push(config);return {
        verify:async()=>{verifications++;if(options.verifyError)throw options.verifyError;return true},
        close:()=>{closed++},
        sendMail:async message=>{
          deliveries.push(message);if(options.smtpError)throw options.smtpError;
          return {...{accepted:[account],rejected:[],response:'250 2.0.0 OK synthetic-message gsmtp',messageId:message.messageId},...options.info};
        }
      };
    }},
    Deno:{env:{get:key=>env[key]},serve:fn=>handler=fn}
  };
  vm.createContext(context);vm.runInContext(source,context,{filename:'signup-notification-worker.ts'});
  async function request(overrides={}){
    const method=overrides.method||'POST';
    const response=await handler(new Request('https://example.invalid/worker',{method,
      headers:{'Content-Type':'application/json','x-growell-worker-secret':overrides.secret??secret},
      ...(method==='GET'?{}:{body:overrides.raw??JSON.stringify(overrides.body||{})})}));
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  return {request,calls,deliveries,transports,context,stats:()=>({claims,verifications,closed})};
}
const ack=h=>h.calls.find(c=>c.name==='growell_finish_signup_notification').input;
const claims=h=>h.calls.filter(c=>c.name==='growell_claim_signup_notification_v2');

test('public callers cannot claim, test-send or verify; wrong long secrets only reach auth RPC',async()=>{
  for(const action of ['process','verify','test'])for(const options of [{secret:'wrong'},{secret:''},{secret:'wrong-secret-'.repeat(5)},{method:'GET'}]){
    const h=harness(),r=await h.request({...options,body:{action}});
    assert.equal(r.status,options.method==='GET'?405:401);assert.equal(claims(h).length,0);assert.equal(h.transports.length,0);
    assert.ok(h.calls.every(c=>c.name==='growell_authorize_signup_notification_worker'));
    assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
});
test('authorization database failure fails closed before reading Gmail secret or queue',async()=>{
  for(const options of [{authError:true},{authThrows:true}]){const h=harness(options),r=await h.request();
    assert.equal(r.status,503);assert.equal(r.body.error,'authorization_unavailable');assert.equal(h.transports.length,0);assert.equal(claims(h).length,0);
    assert.doesNotMatch(JSON.stringify(r.body),/private|synthetic|secret/);
  }
});
test('missing app password or service configuration leaves queue untouched',async()=>{
  for(const env of [{GROWELL_GMAIL_APP_PASSWORD:''},{GROWELL_GMAIL_APP_PASSWORD:'normal-login-password'},
    {GROWELL_GMAIL_APP_PASSWORD:'abcdefghijklmnop\r\n'},{SUPABASE_SERVICE_ROLE_KEY:''},{SUPABASE_URL:''}]){
    const h=harness({env}),r=await h.request();assert.equal(r.status,503);assert.equal(r.body.error,'notification_not_configured');
    assert.equal(claims(h).length,0);assert.equal(h.transports.length,0);
  }
});
test('pinned Gmail transport enforces TLS, fixed account and no logging or external attachment reads',async()=>{
  const h=harness({env:{GROWELL_GMAIL_APP_PASSWORD:'abcd efgh ijkl mnop',GROWELL_SIGNUP_FROM:'ignored@example.invalid',RESEND_API_KEY:'ignored'}});
  await h.request();const config=h.transports[0];
  assert.match(workerSource,/npm:nodemailer@9\.0\.1/);assert.equal(config.host,'smtp.gmail.com');assert.equal(config.port,465);
  assert.equal(config.secure,true);assert.equal(config.tls.rejectUnauthorized,true);assert.equal(config.tls.minVersion,'TLSv1.2');
  assert.equal(config.auth.user,account);assert.equal(config.auth.pass,'abcdefghijklmnop');
  for(const property of ['logger','debug','transactionLog','pool'])assert.equal(config[property],false);
  assert.equal(config.disableFileAccess,true);assert.equal(config.disableUrlAccess,true);assert.equal(h.stats().closed,1);
});
test('signup SMTP envelope and content stay fixed despite caller-controlled inputs',async()=>{
  const h=harness(),r=await h.request({body:{to:'attacker@example.invalid',from:'attacker@example.invalid',html:'injected',host:'attacker'}});
  assert.equal(r.status,200);assert.equal(r.body.processed,1);assert.equal(h.deliveries.length,1);
  const message=h.deliveries[0];assert.deepEqual([...message.to],[account]);assert.equal(message.from,'GROWELL <'+account+'>');
  assert.equal(message.envelope.from,account);assert.deepEqual([...message.envelope.to],[account]);
  assert.match(message.text,/임시 회원/);assert.match(message.text,/fixture_member/);assert.match(message.text,/09:05/);
  assert.match(message.text,/https:\/\/growell-book.vercel.app\/#\/admin\/users/);
  assert.doesNotMatch(JSON.stringify(message),/attacker|password|pw_hint|avatar|pbkdf2|synthetic-service-key/);
  assert.equal(message.messageId,'<growell-signup-v1-'+fixture().id+'@gmail.com>');
  assert.equal(ack(h).p_provider_id,message.messageId);assert.equal(ack(h).p_lease_token,fixture().lease_token);
  const claim=claims(h)[0].input;assert.equal(claim.p_provider,'gmail_smtp');assert.equal(claim.p_sender,account);assert.equal(claim.p_recipient,account);
});
test('applicant HTML is escaped and safe retries keep stable message metadata',async()=>{
  const job={...fixture(),applicant_name:'<script>alert(1)</script>',password:'must-never-copy',pw_hint:'must-never-copy'};
  const first=harness({job}),second=harness({job});await first.request();await second.request();
  assert.equal(JSON.stringify(first.deliveries),JSON.stringify(second.deliveries));
  assert.doesNotMatch(first.deliveries[0].html,/<script>|must-never-copy/);assert.match(first.deliveries[0].html,/&lt;script&gt;/);
});
test('only definite pre-DATA temporary errors are eligible for queue retry',async()=>{
  for(const smtpError of [{code:'EDNS',command:'CONN'},{code:'ESOCKET',command:'CONN',syscall:'connect'},
    {code:'EAUTH',command:'AUTH PLAIN',responseCode:454},{code:'EENVELOPE',command:'MAIL FROM',responseCode:421},
    {code:'EENVELOPE',command:'RCPT TO',responseCode:450},{code:'ECONNECTION',command:'EHLO',responseCode:421}]){
    const h=harness({smtpError});await h.request();assert.equal(ack(h).p_error,'smtp_before_data_temporary');
    assert.equal(ack(h).p_retryable,true);assert.equal(ack(h).p_provider_id,null);assert.equal(h.deliveries.length,1);assert.equal(claims(h).length,1);
  }
});
test('post-DATA and generic CONN timeouts never trigger automatic resend',async()=>{
  for(const smtpError of [{code:'ETIMEDOUT',command:'CONN'},{code:'ESOCKET',command:'CONN',syscall:'read'},
    {code:'ECONNECTION',command:'CONN'},{code:'ESTREAM',command:'API'},{code:'ETIMEDOUT',command:'DATA'},new Error('unknown')]){
    const h=harness({smtpError});await h.request();assert.equal(ack(h).p_error,'smtp_delivery_uncertain');
    assert.equal(ack(h).p_retryable,false);assert.equal(h.deliveries.length,1);
  }
});
test('authentication and explicit SMTP rejection require review without retry',async()=>{
  for(const smtpError of [{code:'EAUTH',command:'AUTH PLAIN',responseCode:535},{code:'EENVELOPE',command:'RCPT TO',responseCode:550},
    {code:'EMESSAGE',command:'DATA',responseCode:451},{code:'EMESSAGE',command:'DATA',responseCode:554}]){
    const h=harness({smtpError});await h.request();assert.equal(ack(h).p_retryable,false);assert.ok(['smtp_auth_failed','smtp_rejected'].includes(ack(h).p_error));
  }
});
test('local Message-ID without final SMTP acceptance is ambiguous, never sent',async()=>{
  for(const info of [{accepted:[]},{rejected:[account]},{response:''},{response:'354 Continue'},{messageId:'different'},{accepted:['other@example.invalid']}]){
    const h=harness({info});await h.request();assert.equal(ack(h).p_provider_id,null);
    assert.equal(ack(h).p_error,'smtp_delivery_uncertain');assert.equal(ack(h).p_retryable,false);
  }
});
test('legacy provider, changed address, template or invalid job metadata cannot reach SMTP',async()=>{
  for(const patch of [{provider:'legacy_resend'},{sender:'other@example.invalid'},{recipient:'goondoing7@kakao.com'},
    {template_version:2},{requested_at:'bad-date'},{id:'injected\r\nHeader'},{lease_token:''}]){
    const h=harness({job:{...fixture(),...patch}});await h.request();assert.equal(h.deliveries.length,0);
    assert.equal(ack(h).p_error,'invalid_request');assert.equal(ack(h).p_retryable,false);
  }
});
test('lost DB acknowledgment does not send or claim another job',async()=>{
  for(const options of [{ack:false},{ackError:true},{ackThrows:true}]){
    const h=harness(options),r=await h.request();assert.equal(r.status,503);assert.equal(h.deliveries.length,1);
    assert.equal(claims(h).length,1);assert.equal(h.stats().closed,1);
  }
  const h=harness({queueError:true});assert.equal((await h.request()).status,503);assert.equal(h.deliveries.length,0);
});
test('verify checks authentication only; self-test sends one fixed message without queue access',async()=>{
  const h=harness(),r=await h.request({body:{action:'verify'}});assert.equal(r.body.connectionVerified,true);
  assert.equal(h.stats().verifications,1);assert.equal(claims(h).length,0);assert.equal(h.deliveries.length,0);
  const failed=harness({verifyError:{code:'EAUTH',message:'must-not-expose-password',response:'secret server details'}});
  const failure=await failed.request({body:{action:'verify'}});assert.equal(failure.status,503);
  assert.equal(failure.body.error,'smtp_auth_failed');assert.doesNotMatch(JSON.stringify(failure.body),/must-not-expose|details/);
  const t=harness(),result=await t.request({body:{action:'test',to:'other@example.invalid',subject:'injected',text:'injected'}});
  assert.equal(result.body.accepted,true);assert.equal(t.deliveries.length,1);assert.equal(claims(t).length,0);
  assert.equal(t.deliveries[0].subject,'[GROWELL] 승인 알림 연결 테스트');assert.deepEqual([...t.deliveries[0].to],[account]);
  assert.doesNotMatch(JSON.stringify(t.deliveries[0]),/injected|other@example.invalid/);
  const e=harness({smtpError:{code:'EDNS'}}),error=await e.request({body:{action:'test'}});
  assert.equal(error.body.automaticRetry,false);assert.equal(e.deliveries.length,1);assert.equal(claims(e).length,0);
});
test('invalid action payloads never start SMTP or queue operations',async()=>{
  for(const overrides of [{body:{action:'send'}},{body:[]},{raw:'null'},{raw:'not json'},{raw:'x'.repeat(1025)}]){
    const h=harness(),r=await h.request(overrides);assert.equal(r.status,400);assert.equal(claims(h).length,0);assert.equal(h.transports.length,0);
  }
});
