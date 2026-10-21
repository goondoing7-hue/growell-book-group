'use strict';
const crypto=require('node:crypto');
const D=require('./meetingCalendarDomain.cjs');
const {createProvider}=require('./meetingCalendarProvider.cjs');
const Google=require('./googleConnectionService.cjs');
const COOKIE='__Host-growell-meeting-calendar';
const MAX_BYTES=1024*1024;
const CODES=new Set(['not-configured','authentication-required','membership-required','invalid-request','invalid-schedule','connection-required','service-unavailable','rate-limited',
  'calendar-busy','calendar-stale','calendar-deferred','calendar-too-large','oauth-state-invalid','oauth-cancelled','consent-required','identity-invalid','google-account-mismatch','connection-key-invalid','reconnect-required',
  'calendar-remote-missing','calendar-remote-conflict','calendar-version-conflict','calendar-event-unsafe','calendar-permission-denied','calendar-unavailable','calendar-response-invalid']);
function safeError(error){return CODES.has(error?.code)?error.code:'service-unavailable';}
function createTransport(fetchImpl=globalThis.fetch) {
  return async function request(url,options={},kind='database') {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try {
      const res=await fetchImpl(url,{...options,signal:controller.signal,redirect:'error'});
      if(!res.ok) {
        let code='service-unavailable',status=503;
        if(kind==='auth' && [401,403].includes(res.status)){code='authentication-required';status=401;}
        if(kind==='database') {
          let dbCode;try{const raw=await res.text();dbCode=raw.length<16000?JSON.parse(raw).code:'';}catch(_){}
          if(dbCode==='42501'){code='membership-required';status=403;}
          if(dbCode==='40001'){code='calendar-busy';status=409;}
          if(dbCode==='55000'){code='connection-required';status=409;}
          if(dbCode==='22023'){code='invalid-request';status=400;}
          if(['54000','22001'].includes(dbCode)){code='calendar-too-large';status=413;}
        }
        if(res.status===429){code='rate-limited';status=429;}
        throw new D.CalendarError(code,status);
      }
      if(res.status===204)return null;
      const chunks=[];let size=0;
      if(res.body?.getReader) {
        const reader=res.body.getReader();while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new D.CalendarError('calendar-too-large',413);}chunks.push(Buffer.from(value));}
      }else{const raw=Buffer.from(await res.text());size=raw.length;chunks.push(raw);}
      if(size>MAX_BYTES)throw new D.CalendarError('calendar-too-large',413);
      const text=Buffer.concat(chunks).toString('utf8');return text?JSON.parse(text):null;
    }catch(error){if(error instanceof D.CalendarError)throw error;throw new D.CalendarError('service-unavailable');}
    finally{clearTimeout(timer);}
  };
}
function createStore(config,request) {
  const headers={apikey:config.serviceKey,Authorization:'Bearer '+config.serviceKey,'Content-Type':'application/json'};
  const db=(path,method='GET',body)=>request(config.database+'/rest/v1/'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const rpc=(name,body)=>db('rpc/growell_meeting_calendar_'+name,'POST',body);
  async function rows(path){const result=await db(path);if(!Array.isArray(result))throw new D.CalendarError('service-unavailable');return result;}
  return {
    async profile(authId){const result=await rows('profiles?select=id,auth_user_id,is_deleted,approval_status&auth_user_id=eq.'+encodeURIComponent(authId)+'&limit=2');return result.length===1?result[0]:null;},
    async connection(owner){const result=await rows('growell_meeting_calendar_connections?select=*&owner_id=eq.'+encodeURIComponent(owner)+'&limit=1');return result[0]||null;},
    async jobs(owner,generation){const result=await rows('growell_meeting_calendar_jobs?select=owner_id,generation,schedule_id,revision,synced_revision,last_error,event_created&owner_id=eq.'+encodeURIComponent(owner)+'&generation=eq.'+encodeURIComponent(generation)+'&order=schedule_id.asc&limit=1001');if(result.length>1000)throw new D.CalendarError('calendar-too-large',413);return result;},
    oauth:(operation,payload)=>rpc('oauth',{p_operation:operation,p_payload:payload}),
    configure:(owner,authId,operation,payload={})=>rpc('configure',{p_owner:owner,p_auth:authId,p_operation:operation,p_payload:payload}),
    claim:(owner=null,limit=1)=>rpc('claim',{p_owner:owner,p_limit:limit}),
    apply:(c,operation,payload={})=>rpc('apply',{p_owner:c.owner_id,p_generation:c.generation,p_lease:c.lease_token,p_operation:operation,p_payload:payload})
  };
}
function safeConnection(c,jobs=[],now=Date.now()) {
  const connected=!!c?.token_cipher;
  return {configured:true,connected,enabled:connected&&c.enabled===true,accountEmail:connected?D.clean(c.account_email,254):'',calendarName:'내 Google 캘린더',timeZone:'Asia/Seoul',
    lastSyncedAt:c?.last_synced_at||null,pendingCount:connected?jobs.filter(j=>Number(j.revision)>Number(j.synced_revision)).length:0,
    syncedCount:connected?jobs.filter(j=>Number(j.synced_revision)>0&&Number(j.revision)===Number(j.synced_revision)).length:0,
    busy:connected&&!!c.lease_token&&Date.parse(c.lease_until)>now,
    errorCode:c?.error_code?safeError({code:c.error_code}):jobs.find(j=>j.last_error)?.last_error?safeError({code:jobs.find(j=>j.last_error).last_error}):null};
}
function createService(options={}) {
  const config=options.config||D.getConfig(),now=options.now||Date.now,request=options.request||createTransport(options.fetch);
  const store=options.store||createStore(config,request),providerFactory=options.providerFactory||(deadline=>createProvider(config,{fetch:options.fetch,now,deadline}));
  const loginAccounts=new WeakMap();
  const callbackRedirect=state=>config.origin+'/?meeting-calendar='+state+'#/';
  const oauthContext=(owner,stateHash)=>'oauth:'+owner+':'+stateHash;
  function requireConfigured(){if(!config.configured)throw new D.CalendarError('not-configured');}
  async function approved(authId,owner) {
    const p=await store.profile(authId);
    if(!p||p.auth_user_id!==authId||p.is_deleted!==false||p.approval_status!=='approved'||owner&&p.id!==owner)throw new D.CalendarError('membership-required',403);return p;
  }
  async function authenticate(req) {
    requireConfigured();const match=/^Bearer ([A-Za-z0-9._~-]{1,16000})$/.exec(req.headers.authorization||'');
    if(!match)throw new D.CalendarError('authentication-required',401);
    const user=await request(config.database+'/auth/v1/user',{headers:{apikey:config.serviceKey,Authorization:'Bearer '+match[1]}},'auth');
    if(!D.UUID.test(user?.id||''))throw new D.CalendarError('authentication-required',401);
    const profile=await approved(user.id);
    try{loginAccounts.set(profile,Google.verifiedGoogleAccount(user,user.id));}catch(error){throw new D.CalendarError(error.code||'authentication-required',error.status||401);}
    return profile;
  }
  async function loginAccount(profile){
    try{return loginAccounts.has(profile)?loginAccounts.get(profile):await Google.loadGoogleAccount({config,request,authId:profile.auth_user_id});}
    catch(error){throw new D.CalendarError(error.code||'service-unavailable',error.status||503);}
  }
  async function ensureGoogleAccount(profile){
    const expected=await loginAccount(profile);if(!expected)return;
    const connection=await store.connection(profile.id);
    if(connection&&(connection.owner_id!==profile.id||connection.auth_user_id!==profile.auth_user_id))throw new D.CalendarError('membership-required',403);
    if(connection?.token_cipher&&!D.equal(connection.account_id,expected))throw new D.CalendarError('google-account-mismatch',409);
  }
  async function status(profile) {
    const c=await store.connection(profile.id);
    if(c&&(c.owner_id!==profile.id||c.auth_user_id!==profile.auth_user_id))throw new D.CalendarError('membership-required',403);
    const jobs=c?.token_cipher?await store.jobs(profile.id,c.generation):[];
    if(!Array.isArray(jobs)||jobs.some(j=>j.owner_id!==profile.id||j.generation!==c?.generation))throw new D.CalendarError('service-unavailable');
    return safeConnection(c,jobs,now());
  }
  async function connect(profile) {
    const expectedAccount=await loginAccount(profile);
    requireConfigured();const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url'),stateHash=D.hash(state);
    await store.oauth('put',{state_hash:stateHash,owner_id:profile.id,auth_user_id:profile.auth_user_id,verifier_cipher:D.seal({verifier,expectedAccount},config.key,oauthContext(profile.id,stateHash)),expires_at:new Date(now()+600000).toISOString()});
    return {url:D.authorizationUrl(config,{state,verifier}),cookie:COOKIE+'='+state+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'};
  }
  async function callback(query,cookies) {
    requireConfigured();const state=query.get('state')||'',cookie=String(cookies||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!D.equal(state,cookie))throw new D.CalendarError('oauth-state-invalid',400);
    const pending=await store.oauth('consume',{state_hash:D.hash(state)});
    if(!pending||!Number.isFinite(Date.parse(pending.expires_at))||Date.parse(pending.expires_at)<=now())throw new D.CalendarError('oauth-state-invalid',400);
    await approved(pending.auth_user_id,pending.owner_id);
    if(query.get('error')||!query.get('code')||query.get('code').length>4096)throw new D.CalendarError('oauth-cancelled',400);
    const {verifier,expectedAccount}=D.unseal(pending.verifier_cipher,config.key,oauthContext(pending.owner_id,D.hash(state)));
    if(expectedAccount!==undefined&&expectedAccount!==null&&(typeof expectedAccount!=='string'||!/^[a-f0-9]{64}$/.test(expectedAccount)))throw new D.CalendarError('oauth-state-invalid',400);
    const currentAccount=await loginAccount({auth_user_id:pending.auth_user_id});
    if(expectedAccount&&!D.equal(expectedAccount,currentAccount))throw new D.CalendarError('google-account-mismatch',409);
    const provider=providerFactory(now()+35000),tokens=await provider.exchange({code:query.get('code'),verifier});
    if(!tokens.refreshToken)throw new D.CalendarError('consent-required',403);
    const identity=await provider.identity(tokens.accessToken),generation=crypto.randomUUID();
    if((currentAccount||expectedAccount)&&!D.equal(D.hash(identity.subject),currentAccount||expectedAccount))throw new D.CalendarError('google-account-mismatch',409);
    const finalAccount=await loginAccount({auth_user_id:pending.auth_user_id});
    if(!D.equal(currentAccount||'',finalAccount||''))throw new D.CalendarError('google-account-mismatch',409);
    await approved(pending.auth_user_id,pending.owner_id);
    await store.configure(pending.owner_id,pending.auth_user_id,'connect',{generation,account_id:D.hash(identity.subject),account_email:identity.email,
      token_cipher:D.seal({refreshToken:tokens.refreshToken,scope:tokens.scope},config.key,D.tokenContext(pending.owner_id,generation))});
    return callbackRedirect('connected');
  }
  async function apply(c,operation,payload={}) {const result=await store.apply(c,operation,payload);if(result?.applied!==true)throw new D.CalendarError('calendar-stale',409);return result;}
  async function run(owner=null) {
    requireConfigured();const deadline=now()+45000,claims=await store.claim(owner,owner?1:5);if(!Array.isArray(claims))throw new D.CalendarError('service-unavailable');
    let processed=0;
    for(let index=0;index<claims.length;index++) {
      const claim=claims[index];
      const c=claim?.connection,jobs=claim?.jobs;
      if(!c||!Array.isArray(jobs)||(owner&&c.owner_id!==owner))throw new D.CalendarError('service-unavailable');
      if(now()+12000>deadline){
        // Release untouched claims together while the time reserved for cleanup
        // remains. Failed releases expire naturally and preserve all queued jobs.
        await Promise.allSettled(claims.slice(index).map(item=>store.apply(item.connection,'release')));break;
      }
      try {
        await approved(c.auth_user_id,c.owner_id);await apply(c,'guard');
        const provider=providerFactory(deadline),previous=D.unseal(c.token_cipher,config.key,D.tokenContext(c.owner_id,c.generation));
        const tokens=await provider.refresh(previous);
        if(tokens.refreshToken&&tokens.refreshToken!==previous.refreshToken)await apply(c,'token',{token_cipher:D.seal({refreshToken:tokens.refreshToken,scope:tokens.scope||previous.scope},config.key,D.tokenContext(c.owner_id,c.generation))});
        for(const job of jobs.slice(0,3)) {
          try {
            if(job.generation!==c.generation||!D.UUID.test(job.schedule_id||'')||!Number.isSafeInteger(Number(job.revision))||Number(job.revision)<1||job.desired?.schedule_id!==job.schedule_id)throw new D.CalendarError('invalid-schedule',400);
            const identity=D.eventIdentity(c.owner_id,c.account_id,job.schedule_id,config.key);
            if(job.event_id&&job.event_id!==identity.id)throw new D.CalendarError('calendar-event-unsafe',409);
            const event=D.buildEvent(job.desired,identity),payload={schedule_id:job.schedule_id,revision:Number(job.revision),event_id:identity.id};
            await provider.writeEvent({accessToken:tokens.accessToken,event,eventCreated:job.event_created===true,
              beforeWrite:async()=>{await approved(c.auth_user_id,c.owner_id);await apply(c,'guard',{schedule_id:job.schedule_id,revision:Number(job.revision)});},
              onCreated:()=>apply(c,'created',payload)});
            await apply(c,'success',payload);processed++;
          }catch(error) {
            await apply(c,'failure',{schedule_id:job.schedule_id,revision:Number(job.revision),error_code:safeError(error),retry_after:Math.min(3600,Math.max(60,Number(error.retryAfter)||300)),disable:['reconnect-required','calendar-permission-denied'].includes(error.code)});
            if(['calendar-deferred','calendar-stale','reconnect-required','calendar-permission-denied'].includes(error.code))break;
          }
        }
      }catch(error) {
        try{const first=jobs[0];if(first)await apply(c,'failure',{schedule_id:first.schedule_id,revision:Number(first.revision),error_code:safeError(error),retry_after:Math.min(3600,Math.max(60,Number(error.retryAfter)||300)),disable:['reconnect-required','calendar-permission-denied'].includes(error.code)});}catch(_){}
      }finally{try{await store.apply(c,'release');}catch(_){/* A stale or expired worker cannot alter a replacement connection. */}}
    }
    return {processed};
  }
  async function mutate(profile,action,body) {
    if(action==='configure'){if(typeof body.enabled!=='boolean')throw new D.CalendarError('invalid-request',400);if(body.enabled)await ensureGoogleAccount(profile);await store.configure(profile.id,profile.auth_user_id,'settings',{enabled:body.enabled});}
    else if(action==='disconnect')await store.configure(profile.id,profile.auth_user_id,'disconnect');
    else if(action==='sync'){await ensureGoogleAccount(profile);await store.configure(profile.id,profile.auth_user_id,'sync');await run(profile.id);}
    else throw new D.CalendarError('invalid-request',400);
    return status(profile);
  }
  return {config,store,authenticate,approved,status,connect,callback,callbackRedirect,mutate,run};
}
function createHandler(options={}) {
  const service=options.service||createService(options);
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
    try {
      const url=new URL(req.url||'/',service.config.origin);
      let action=url.searchParams.get('action')||(req.method==='GET'&&url.searchParams.has('state')?'callback':'status');
      if(action==='authorize')action='connect';if(action==='run')action='sync';
      if(req.method==='GET'&&action==='config')return send(200,{configured:!!service.config.configured});
      if(!service.config.configured)throw new D.CalendarError('not-configured');
      if(req.method==='GET'&&action==='callback') {
        res.setHeader('Set-Cookie',COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        let target;try{target=await service.callback(url.searchParams,req.headers.cookie);}catch(_){target=service.callbackRedirect('error');}
        res.statusCode=303;res.setHeader('Location',target);return res.end();
      }
      if(req.method==='GET'&&action==='worker') {
        if(!service.config.cronSecret||!D.equal(req.headers.authorization||'','Bearer '+service.config.cronSecret))throw new D.CalendarError('authentication-required',401);
        return send(200,await service.run());
      }
      if(req.method!=='POST'&&!(req.method==='GET'&&action==='status'))return send(405,{error:'method-not-allowed'});
      if(req.method==='POST'&&(req.headers.origin!==service.config.origin||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')))return send(403,{error:'same-origin-required'});
      const profile=await service.authenticate(req);if(action==='status'&&req.method==='GET')return send(200,await service.status(profile));
      let body=req.body;if(typeof body==='string'){if(body.length>2048)return send(413,{error:'request-too-large'});try{body=JSON.parse(body);}catch(_){return send(400,{error:'invalid-json'});}}
      if(!body||typeof body!=='object'||Array.isArray(body)||JSON.stringify(body).length>2048)return send(400,{error:'invalid-json'});
      if(Object.keys(body).some(key=>action!=='configure'||key!=='enabled'))return send(400,{error:'invalid-request'});
      if(action==='connect'){const result=await service.connect(profile);res.setHeader('Set-Cookie',result.cookie);return send(200,{url:result.url});}
      return send(200,await service.mutate(profile,action,body));
    }catch(error){return send(error instanceof D.CalendarError?error.status:503,{error:safeError(error)});}
  };
}
module.exports={COOKIE,MAX_BYTES,createTransport,createStore,safeConnection,safeError,createService,createHandler};
