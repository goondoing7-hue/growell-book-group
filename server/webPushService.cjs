'use strict';

const D=require('./driveBackupDomain.cjs');
const P=require('./webPushProvider.cjs');
const Verse=require('../dailyVerseDomain.js');
const VERSES=require('../dailyVerses.js');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOKS=new Set(['emotion','thought','body','action']);
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY_BYTES=12000;
const SAFE_CODES=new Set(['not-configured','authentication-required','membership-required','same-origin-required','invalid-request','subscription-invalid','connection-required','service-unavailable','rate-limited','push-unavailable','subscription-gone','push-rate-limited','push-rejected','push-uncertain']);
function safeError(error){return SAFE_CODES.has(error?.code)?error.code:'service-unavailable';}
function getConfig(env=process.env){
  let key;try{key=Buffer.from(env.GROWELL_SYNC_KEY||'','base64');}catch(_){key=Buffer.alloc(0);}
  const origin=env.GROWELL_SYNC_ORIGIN||'https://growell-book.vercel.app',database=env.GROWELL_SUPABASE_URL||'https://oxaeecawijnetwmvggjs.supabase.co';
  const config={origin,database,key,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY||'',cronSecret:env.CRON_SECRET||'',publicKey:env.GROWELL_WEB_PUSH_PUBLIC_KEY||'',privateKey:env.GROWELL_WEB_PUSH_PRIVATE_KEY||''};
  config.baseConfigured=!!(/^https:\/\/[^/?#:@]+(?::443)?$/.test(origin)&&/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database)&&config.serviceKey);
  config.configured=config.baseConfigured&&key.length===32&&P.validateVapid(config.publicKey,config.privateKey);
  return config;
}
function createTransport(fetchImpl=globalThis.fetch){
  return async(url,options={},kind='database')=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
    try{
      const response=await fetchImpl(url,{...options,signal:controller.signal,redirect:'error'});
      const raw=await response.text();if(Buffer.byteLength(raw)>250000)throw new D.BackupError('service-unavailable');
      let result;try{result=raw?JSON.parse(raw):null;}catch(_){throw new D.BackupError('service-unavailable');}
      if(!response.ok){
        if(kind==='auth'&&[401,403].includes(response.status))throw new D.BackupError('authentication-required',401);
        if(response.status===429||['40001','54000'].includes(result?.code))throw new D.BackupError('rate-limited',429);
        if(result?.code==='42501')throw new D.BackupError('membership-required',403);
        if(result?.code==='22023')throw new D.BackupError('invalid-request',400);
        if(result?.code==='55000')throw new D.BackupError('connection-required',409);
        if(['42883','PGRST202'].includes(result?.code))throw new D.BackupError('not-configured');
        throw new D.BackupError('service-unavailable');
      }
      return result;
    }catch(error){if(error instanceof D.BackupError)throw error;throw new D.BackupError('service-unavailable');}finally{clearTimeout(timer);}
  };
}
function createStore(config,request){
  const headers={apikey:config.serviceKey,Authorization:'Bearer '+config.serviceKey,'Content-Type':'application/json'};
  const rpc=(name,body)=>request(config.database+'/rest/v1/rpc/growell_web_push_'+name,{method:'POST',headers,body:JSON.stringify(body)});
  return{
    async profile(auth){const rows=await request(config.database+'/rest/v1/profiles?select=id,auth_user_id,is_deleted,approval_status&auth_user_id=eq.'+encodeURIComponent(auth)+'&limit=2',{headers});if(!Array.isArray(rows))throw new D.BackupError('service-unavailable');return rows.length===1?rows[0]:null;},
    configure:(profile,operation,payload={})=>rpc('configure',{p_owner:profile.id,p_auth:profile.auth_user_id,p_operation:operation,p_payload:payload}),
    tick:now=>rpc('tick',{p_now:new Date(now).toISOString()}),
    claim:limit=>rpc('claim',{p_limit:limit}),
    apply:(job,operation,payload={})=>rpc('apply',{p_job:job.id,p_lease:job.lease_token,p_operation:operation,p_payload:payload}),
    workerAuthorized:secret=>rpc('worker_authorized',{p_secret:secret})
  };
}
function context(owner,auth,fingerprint){return 'web-push:'+owner+':'+auth+':'+fingerprint;}
function fingerprint(endpoint){P.endpointUrl(endpoint);return D.hash(endpoint);}
function statusResult(config,value){
  if(!value||value.connected!==true)return {configured:config.configured,subscription:null};
  return{configured:config.configured,subscription:{active:true,preferences:{posts:value.newPosts===true,dailyVerse:value.dailyVerse===true},lastSentAt:typeof value.lastSentAt==='string'&&Number.isFinite(Date.parse(value.lastSentAt))?value.lastSentAt:null,lastError:value.lastError?safeError({code:value.lastError}):null}};
}
function preferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||typeof value.posts!=='boolean'||typeof value.dailyVerse!=='boolean')throw new D.BackupError('invalid-request',400);
  return{new_posts:value.posts,daily_verse:value.dailyVerse};
}
function payloadFor(job,now){
  if(job.kind==='post'){
    if(!BOOKS.has(job.book_id)||!ID.test(job.post_id||''))throw new D.BackupError('push-unavailable');
    return{version:1,type:'post',bookId:job.book_id,postId:job.post_id,tag:'growell-post-'+job.post_id,body:'새로운 나눔이 올라왔어요. GROWELL에서 확인해 보세요.'};
  }
  if(job.kind==='verse'){
    const verse=Verse.getCompact(VERSES,now);
    if(!verse||verse.dateKey!==job.verse_day)throw new D.BackupError('push-unavailable');
    const body=verse.text+'\n'+verse.reference;
    if(Array.from(body).length>400)throw new D.BackupError('push-unavailable');
    return{version:1,type:'verse',tag:'growell-verse-'+verse.dateKey,body};
  }
  if(job.kind==='test')return{version:1,type:'test',tag:'growell-push-test',body:'GROWELL 알림이 연결되었어요.'};
  throw new D.BackupError('push-unavailable');
}
function createService(options={}){
  const config=options.config||getConfig(),now=options.now||Date.now,request=options.request||createTransport(options.fetch),store=options.store||createStore(config,request),provider=options.provider||P.createProvider(config,options);
  function requireConfigured(){if(!config.configured)throw new D.BackupError('not-configured');}
  async function authenticate(req){
    if(!config.baseConfigured)throw new D.BackupError('not-configured');
    const match=/^Bearer ([A-Za-z0-9._~-]{1,16000})$/.exec(req.headers?.authorization||'');if(!match)throw new D.BackupError('authentication-required',401);
    const user=await request(config.database+'/auth/v1/user',{headers:{apikey:config.serviceKey,Authorization:'Bearer '+match[1]}},'auth');
    if(!UUID.test(user?.id||''))throw new D.BackupError('authentication-required',401);
    const profile=await store.profile(user.id);
    if(!profile||profile.auth_user_id!==user.id||typeof profile.id!=='string'||!profile.id||profile.approval_status!=='approved'||profile.is_deleted!==false)throw new D.BackupError('membership-required',403);
    return profile;
  }
  async function member(profile,body){
    const fields={config:['action'],status:['action','endpoint'],subscribe:['action','subscription','preferences'],preferences:['action','endpoint','preferences'],unsubscribe:['action','endpoint'],test:['action','endpoint']}[body.action];
    if(!fields||Object.keys(body).some(key=>!fields.includes(key)))throw new D.BackupError('invalid-request',400);
    if(body.action==='config')return{configured:config.configured,publicKey:config.configured?config.publicKey:null};
    requireConfigured();
    if(body.action==='subscribe'){
      const subscription=P.validateSubscription(body.subscription),hash=fingerprint(subscription.endpoint),settings=preferences(body.preferences);
      if(subscription.expirationTime!==null&&subscription.expirationTime<=now())throw new D.BackupError('subscription-invalid',400);
      const subscription_cipher=D.seal(subscription,config.key,context(profile.id,profile.auth_user_id,hash));
      return statusResult(config,await store.configure(profile,'connect',{fingerprint:hash,subscription_cipher,...settings}));
    }
    if(body.action==='status'&&body.endpoint===undefined)return{configured:true,subscription:null};
    const hash=fingerprint(body.endpoint),operation={status:'status',preferences:'settings',unsubscribe:'disconnect',test:'test'}[body.action];
    const result=await store.configure(profile,operation,{fingerprint:hash,...(body.action==='preferences'?preferences(body.preferences):{})});
    if(body.action==='test')return{ok:result?.connected===true};
    return statusResult(config,result);
  }
  async function authorizeWorker(req){
    requireConfigured();
    const bearer=/^Bearer ([^\r\n]{1,200})$/.exec(req.headers?.authorization||'');
    if(config.cronSecret&&bearer&&D.equal(bearer[1],config.cronSecret))return true;
    const secret=req.headers?.['x-growell-worker-secret'];
    if(typeof secret!=='string'||secret.length<32||secret.length>256)return false;
    return await store.workerAuthorized(secret)===true;
  }
  async function run(){
    requireConfigured();const deadline=now()+44000;
    await store.tick(now());const claims=await store.claim(5);if(!Array.isArray(claims)||claims.length>5)throw new D.BackupError('service-unavailable');
    let processed=0,accepted=0;
    for(const job of claims){
      // A job can spend seven seconds per database guard/finish and six at
      // the provider. Reserve cleanup time before starting another lease.
      if(now()>deadline-32000)break;
      if(!UUID.test(job?.id||'')||!UUID.test(job?.lease_token||''))continue;
      let prepared=false,sent=false;
      try{
        const first=await store.apply(job,'snapshot');if(first?.applied!==true)continue;
        if(typeof first.owner_id!=='string'||!first.owner_id||!UUID.test(first.auth_user_id||'')||!/^[a-f0-9]{64}$/.test(first.endpoint_hash||''))throw new D.BackupError('subscription-invalid');
        let subscription;try{subscription=P.validateSubscription(D.unseal(first.subscription_cipher,config.key,context(first.owner_id,first.auth_user_id,first.endpoint_hash)));}catch(_){throw new D.BackupError('subscription-invalid');}
        if(fingerprint(subscription.endpoint)!==first.endpoint_hash||subscription.expirationTime!==null&&subscription.expirationTime<=now())throw new D.BackupError('subscription-invalid');
        const outgoing=payloadFor(first,now());
        const latest=await store.apply(job,'prepare');if(latest?.applied!==true)continue;
        if(first.subscription_cipher!==latest.subscription_cipher||first.endpoint_hash!==latest.endpoint_hash||first.owner_id!==latest.owner_id||first.auth_user_id!==latest.auth_user_id||JSON.stringify(payloadFor(latest,now()))!==JSON.stringify(outgoing))throw new D.BackupError('subscription-invalid');
        const expiry=Date.parse(latest.expires_at);if(!Number.isFinite(expiry)||expiry<=now())throw new D.BackupError('push-unavailable');
        prepared=true;
        await provider.send(subscription,outgoing,Math.ceil((expiry-now())/1000));
        sent=true;
        await store.apply(job,'accepted');accepted++;
      }catch(error){
        const code=safeError(error);
        const operation=sent?'uncertain':['subscription-gone','subscription-invalid'].includes(code)?'gone':!prepared?'retry':error?.uncertain||code==='push-uncertain'||code==='push-rejected'?'uncertain':'retry';
        const storedCode=operation==='retry'?(code==='push-rate-limited'?'rate-limited':['push-unavailable','service-unavailable','rate-limited'].includes(code)?code:'push-unavailable'):code;
        try{await store.apply(job,operation,{error_code:storedCode,retry_after:Math.max(60,Math.min(1800,Number(error.retryAfter)||120))});}catch(_){/* A revoked or expired lease cannot update another device. */}
      }
      processed++;
    }
    return{processed,accepted};
  }
  return{config,store,authenticate,member,authorizeWorker,run};
}
function createHandler(options={}){
  const service=options.service||createService(options);
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
    try{
      const worker=new URL(req.url||'/api/web-push',service.config.origin).searchParams.get('action')==='worker';
      if(worker){
        if(!['GET','POST'].includes(req.method))return send(405,{error:'method-not-allowed'});
        if(!await service.authorizeWorker(req))return send(401,{error:'authentication-required'});
        return send(200,await service.run());
      }
      if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{error:'method-not-allowed'});}
      if(req.headers?.origin!==service.config.origin)return send(403,{error:'same-origin-required'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||''))return send(400,{error:'invalid-request'});
      if(Number(req.headers?.['content-length'])>MAX_BODY_BYTES)return send(413,{error:'request-too-large'});
      let body=req.body;if(typeof body==='string'){if(Buffer.byteLength(body)>MAX_BODY_BYTES)return send(413,{error:'request-too-large'});try{body=JSON.parse(body);}catch(_){return send(400,{error:'invalid-request'});}}
      if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>MAX_BODY_BYTES)return send(400,{error:'invalid-request'});
      return send(200,await service.member(await service.authenticate(req),body));
    }catch(error){return send(error instanceof D.BackupError?error.status:503,{error:safeError(error)});}
  };
}
module.exports={MAX_BODY_BYTES,safeError,getConfig,createTransport,createStore,context,fingerprint,statusResult,preferences,payloadFor,createService,createHandler};
