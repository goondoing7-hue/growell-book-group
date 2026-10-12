'use strict';
const crypto = require('node:crypto');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_ORIGIN = 'https://www.googleapis.com';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
const SCOPES = 'openid email ' + CALENDAR_SCOPE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[a-v0-9]{5,1024}$/;
const BOOKS = Object.freeze({emotion:'감정을 마주하면 길이 보인다',thought:'생각이 너무 많은 어른들을 위한 심리학',body:'몸이 나를 위로한다',action:'습관이 영성이다'});
class CalendarError extends Error {
  constructor(code, status = 503, retryAfter = 30, uncertain = false) { super(code); this.code=code; this.status=status; this.retryAfter=retryAfter; this.uncertain=uncertain; }
}
function getConfig(env = process.env) {
  let key; try { key=Buffer.from(env.GROWELL_SYNC_KEY || '', 'base64'); } catch (_) { key=Buffer.alloc(0); }
  const origin=env.GROWELL_SYNC_ORIGIN || 'https://growell-book.vercel.app';
  const database=env.GROWELL_SUPABASE_URL || 'https://oxaeecawijnetwmvggjs.supabase.co';
  const config={origin,database,key,clientId:env.GROWELL_GOOGLE_CLIENT_ID || '',clientSecret:env.GROWELL_GOOGLE_CLIENT_SECRET || '',
    serviceKey:env.SUPABASE_SERVICE_ROLE_KEY || '',cronSecret:env.CRON_SECRET || '',scopes:SCOPES,redirectUri:origin+'/api/meeting-calendar'};
  config.configured=!!(/^https:\/\/[^/?#:@]+(?::443)?$/.test(origin) && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database)
    && key.length===32 && config.clientId && config.clientSecret && config.serviceKey && config.cronSecret);
  return config;
}
function seal(value,key,context) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('growell-meeting-calendar:'+context));
  const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}
function unseal(value,key,context) {
  try {
    const parts=value.split('.');if(parts.length!==4 || parts[0]!=='v1')throw new Error();
    const cipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(parts[1],'base64url'));
    cipher.setAAD(Buffer.from('growell-meeting-calendar:'+context));cipher.setAuthTag(Buffer.from(parts[2],'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(parts[3],'base64url')),cipher.final()]).toString('utf8'));
  } catch (_) { throw new CalendarError('connection-key-invalid'); }
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function equal(left,right) {
  if(typeof left!=='string' || typeof right!=='string')return false;
  const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function clean(value,length=500) { return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,length):''; }
function tokenContext(owner,generation) { return 'token:'+owner+':'+generation; }
function eventIdentity(owner,accountId,scheduleId,key) {
  if(typeof owner!=='string' || !owner || typeof accountId!=='string' || !accountId || !UUID.test(scheduleId || ''))throw new CalendarError('invalid-schedule',400);
  const marker=crypto.createHmac('sha256',key).update('growell-meeting-calendar:'+JSON.stringify([owner,accountId,scheduleId])).digest('hex');
  return {id:marker,marker};
}
function retryDelay(header,now=Date.now()) {
  let seconds=Number(header);if(!Number.isFinite(seconds)||seconds<0)seconds=Math.ceil((Date.parse(header)-now)/1000);
  return Math.max(30,Math.min(86400,Number.isFinite(seconds)&&seconds>0?seconds:30));
}
function authorizationUrl(config,{state,verifier}={}) {
  if(!config.configured)throw new CalendarError('not-configured');
  if(!/^[A-Za-z0-9_-]{20,200}$/.test(state || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier || ''))throw new CalendarError('invalid-request',400);
  const params=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:SCOPES,
    access_type:'offline',prompt:'consent select_account',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  return AUTH_URL+'?'+params;
}
function buildEvent(desired,identity) {
  if(!desired || typeof desired!=='object' || Array.isArray(desired) || !UUID.test(desired.schedule_id || '') || !EVENT_ID.test(identity?.id || '') || !/^[a-f0-9]{64}$/.test(identity?.marker || ''))throw new CalendarError('invalid-schedule',400);
  const date=desired.meeting_date,start=desired.start_time,end=desired.end_time;
  if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
    || typeof start!=='string' || typeof end!=='string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(end) || end<=start)throw new CalendarError('invalid-schedule',400);
  const bookId=clean(desired.book_id,40);if(!Object.prototype.hasOwnProperty.call(BOOKS,bookId))throw new CalendarError('invalid-schedule',400);
  const book=clean(desired.book_title,160)||BOOKS[bookId],round=clean(desired.meeting_no,10),chapter=clean(desired.chapter,200),range=clean(desired.reading_range,300),note=clean(desired.note,1000);
  if(round && !/^[1-9][0-9]{0,3}$/.test(round))throw new CalendarError('invalid-schedule',400);
  return {id:identity.id,summary:'GROWELL 독서모임'+(round?' · '+round+'번째 모임':''),location:clean(desired.place,500),
    description:['읽을 책: '+book,[chapter,range].filter(Boolean).length?'읽을 범위: '+[chapter,range].filter(Boolean).join(' · '):'',note?'안내: '+note:''].filter(Boolean).join('\n'),
    start:{dateTime:date+'T'+start+':00+09:00',timeZone:'Asia/Seoul'},end:{dateTime:date+'T'+end+':00+09:00',timeZone:'Asia/Seoul'},
    visibility:'private',extendedProperties:{private:{growellMeeting:'v1',growellOwner:identity.marker,growellSchedule:desired.schedule_id}}};
}
module.exports={AUTH_URL,TOKEN_URL,USERINFO_URL,CALENDAR_ORIGIN,CALENDAR_SCOPE,SCOPES,UUID,EVENT_ID,CalendarError,getConfig,seal,unseal,hash,equal,clean,tokenContext,eventIdentity,retryDelay,authorizationUrl,buildEvent};
