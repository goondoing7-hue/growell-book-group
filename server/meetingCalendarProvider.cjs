'use strict';
const D=require('./meetingCalendarDomain.cjs');
const FIELDS='id,status,etag,htmlLink,extendedProperties,organizer(self),eventType';
function createProvider(config,options={}) {
  const fetchImpl=options.fetch||globalThis.fetch,now=options.now||Date.now;
  async function request(url,init={},kind='calendar') {
    if(options.deadline && now()+8500>options.deadline)throw new D.CalendarError('calendar-deferred',409);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetchImpl(url,{...init,redirect:'error',signal:controller.signal});
      if(!response.ok) {
        let reason='';if(kind==='calendar' && response.status===403)try{const raw=await response.text();if(raw.length<16000)reason=JSON.parse(raw)?.error?.errors?.[0]?.reason||'';}catch(_){}
        const status=response.status,limited=status===429 || status===403 && ['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded'].includes(reason);
        const code=limited?'rate-limited':[404,410].includes(status)?'calendar-remote-missing':status===409?'calendar-remote-conflict':status===412?'calendar-version-conflict'
          :status===401 || kind==='token'&&status===400?'reconnect-required':status===403?'calendar-permission-denied':'calendar-unavailable';
        throw new D.CalendarError(code,limited?429:[404,410].includes(status)?409:status===409||status===412?409:503,D.retryDelay(response.headers.get('retry-after'),now()),!!init.method&&init.method!=='GET'&&status>=500);
      }
      const text=await response.text();if(text.length>1024*1024)throw new D.CalendarError('calendar-response-invalid');
      return text?JSON.parse(text):null;
    }catch(error){if(error instanceof D.CalendarError)throw error;throw new D.CalendarError('calendar-unavailable',503,30,!!init.method&&init.method!=='GET');}
    finally{clearTimeout(timer);}
  }
  function token(raw,previous) {
    const scope=typeof raw?.scope==='string'?raw.scope:previous?.scope,scopes=new Set((scope||'').split(/\s+/));
    if(!scopes.has(D.CALENDAR_SCOPE)||!scopes.has('openid')||!(scopes.has('email')||scopes.has('https://www.googleapis.com/auth/userinfo.email')))throw new D.CalendarError('calendar-permission-denied',403);
    const refreshToken=raw.refresh_token||previous?.refreshToken;
    if(typeof raw.access_token!=='string'||!raw.access_token||raw.access_token.length>16384||typeof refreshToken!=='string'||!refreshToken||refreshToken.length>16384
      || String(raw.token_type).toLowerCase()!=='bearer'||!Number.isFinite(+raw.expires_in)||+raw.expires_in<=0||+raw.expires_in>86400)throw new D.CalendarError('reconnect-required');
    return {accessToken:raw.access_token,refreshToken,expiresAt:now()+Number(raw.expires_in)*1000,scope};
  }
  const headers=(accessToken,extra={})=>{
    if(typeof accessToken!=='string'||!accessToken||/[\r\n]/.test(accessToken))throw new D.CalendarError('reconnect-required');
    return {Authorization:'Bearer '+accessToken,...extra};
  };
  const base=D.CALENDAR_ORIGIN+'/calendar/v3/calendars/primary/events';
  function path(id) {if(!D.EVENT_ID.test(id || ''))throw new D.CalendarError('invalid-request',400);return base+'/'+encodeURIComponent(id);}
  async function metadata(accessToken,id) {
    try{return await request(path(id)+'?'+new URLSearchParams({fields:FIELDS}),{headers:headers(accessToken)});}
    catch(error){if(error.code==='calendar-remote-missing')return null;throw error;}
  }
  function validate(meta,event) {
    if(meta?.status==='cancelled')throw new D.CalendarError('calendar-remote-missing',409);
    if(!meta || meta.id!==event.id || typeof meta.etag!=='string' || !meta.etag || /[\r\n]/.test(meta.etag) || meta.organizer?.self!==true || (meta.eventType!==undefined&&meta.eventType!=='default')
      || meta.extendedProperties?.private?.growellMeeting!=='v1'||meta.extendedProperties?.private?.growellOwner!==event.extendedProperties.private.growellOwner
      || meta.extendedProperties?.private?.growellSchedule!==event.extendedProperties.private.growellSchedule)throw new D.CalendarError('calendar-event-unsafe',409);
    return meta;
  }
  async function tokenRequest(body,previous) {return token(await request(D.TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,...body}).toString()},'token'),previous);}
  return {
    async exchange({code,verifier}={}) {if(typeof code!=='string'||!code||code.length>4096||/[\r\n]/.test(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier||''))throw new D.CalendarError('invalid-request',400);return tokenRequest({code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:config.redirectUri});},
    async refresh(previous) {if(typeof previous?.refreshToken!=='string'||!previous.refreshToken)throw new D.CalendarError('reconnect-required');return tokenRequest({refresh_token:previous.refreshToken,grant_type:'refresh_token'},previous);},
    async identity(accessToken) {const user=await request(D.USERINFO_URL,{headers:headers(accessToken)},'identity');if(typeof user?.sub!=='string'||!/^[A-Za-z0-9_-]{1,255}$/.test(user.sub))throw new D.CalendarError('identity-invalid');return {subject:user.sub,email:user.email_verified===true?D.clean(user.email,254):''};},
    async writeEvent({accessToken,event,eventCreated=false,beforeWrite=async()=>{},onCreated=async()=>{}}={}) {
      if(!event || !D.EVENT_ID.test(event.id||'') || !event.extendedProperties?.private)throw new D.CalendarError('invalid-request',400);
      let meta=await metadata(accessToken,event.id),receiptRecorded=false;
      if(!meta && eventCreated)throw new D.CalendarError('calendar-remote-missing',409);
      if(!meta) {
        await beforeWrite();
        let inserted=false;
        try{meta=await request(base+'?'+new URLSearchParams({sendUpdates:'none',fields:FIELDS}),{method:'POST',headers:headers(accessToken,{'Content-Type':'application/json'}),body:JSON.stringify(event)});inserted=true;}
        catch(error){if(error.code!=='calendar-remote-conflict')throw error;meta=await metadata(accessToken,event.id);}
        validate(meta,event);await onCreated();receiptRecorded=true;
        if(inserted)return {id:meta.id,etag:meta.etag};
      }
      validate(meta,event);
      if(!eventCreated&&!receiptRecorded)await onCreated();
      await beforeWrite();
      // Patch only fields owned by GROWELL; retain the member's reminders,
      // colour and unrelated extended properties. An ETag protects concurrent edits.
      const update={summary:event.summary,location:event.location,description:event.description,start:event.start,end:event.end,
        extendedProperties:{private:{...meta.extendedProperties.private,...event.extendedProperties.private}}};
      const saved=await request(path(event.id)+'?'+new URLSearchParams({sendUpdates:'none',fields:FIELDS}),{method:'PATCH',headers:headers(accessToken,{'Content-Type':'application/json','If-Match':meta.etag}),body:JSON.stringify(update)});
      validate(saved,event);return {id:saved.id,etag:saved.etag};
    }
  };
}
module.exports={createProvider,FIELDS};
