'use strict';

const D = require('./driveBackupDomain.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOKS = Object.freeze({emotion:'감정을 마주하면 길이 보인다',thought:'생각이 너무 많은 어른들을 위한 심리학',body:'몸이 나를 위로한다',action:'습관이 영성이다'});
const SAFE_CODES = new Set(['not-configured','authentication-required','membership-required','connection-required','invalid-request','service-unavailable','rate-limited','pdf-unavailable','record-changed','pdf-module-missing','pdf-font-asset-missing','pdf-glyph-unsupported','pdf-layout-overflow','pdf-content-invalid','pdf-render-unavailable']);
function safeError(error) { return SAFE_CODES.has(error?.code) ? error.code : 'service-unavailable'; }
function pdfFailure(error) {
  // Fixed diagnostics only. No original text, paths, addresses or provider
  // messages may leave the authenticated worker route.
  const code=error?.code==='MODULE_NOT_FOUND'?'pdf-module-missing':error?.code==='ENOENT'?'pdf-font-asset-missing':
    error?.code==='PDF_UNSUPPORTED_GLYPH'?'pdf-glyph-unsupported':error?.code==='PDF_LAYOUT_OVERFLOW'?'pdf-layout-overflow':error instanceof TypeError?'pdf-content-invalid':'pdf-render-unavailable';
  return new D.BackupError(code,503);
}

function createStore(config,request) {
  const headers = {apikey:config.serviceKey,Authorization:'Bearer '+config.serviceKey,'Content-Type':'application/json'};
  const rpc = (name,body) => request(config.database+'/rest/v1/rpc/growell_meeting_mail_'+name,{method:'POST',headers,body:JSON.stringify(body)});
  return {
    configure:(owner,authId,operation,payload={})=>rpc('configure',{p_owner:owner,p_auth:authId,p_operation:operation,p_payload:payload}),
    claim:(limit=1)=>rpc('claim',{p_limit:limit}),
    apply:(jobId,lease,operation,payload={})=>rpc('apply',{p_job:jobId,p_lease:lease,p_operation:operation,p_payload:payload})
  };
}
function safeStatus(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.connected !== 'boolean' || typeof raw.enabled !== 'boolean') throw new D.BackupError('service-unavailable');
  const count = value => Number.isSafeInteger(value) && value>=0 ? value : 0;
  return {configured:true,connected:raw.connected,enabled:raw.connected&&raw.enabled,
    accountEmail:raw.connected?D.clean(raw.accountEmail,254):'',lastSentAt:typeof raw.lastSentAt==='string'?raw.lastSentAt:null,
    pendingCount:count(raw.pendingCount),sentCount:count(raw.sentCount),reviewCount:count(raw.reviewCount),
    latestStatus:['none','pending','sending','sent','uncertain','failed','paused'].includes(raw.latestStatus)?raw.latestStatus:'none',
    errorCode:raw.errorCode==='delivery-uncertain'?'delivery-uncertain':raw.errorCode?safeError({code:raw.errorCode}):null};
}
function createService(options={}) {
  const DriveService=require('./driveBackupService.cjs');
  const config=options.config||D.getConfig(),request=options.request||DriveService.createTransport(options.fetch);
  const store=options.store||createStore(config,request),authService=options.authService||DriveService.createService({config,request});
  const pdfFactory=options.pdfFactory||((data)=>require('./meetingRecordPdf.cjs').createMeetingRecordPdf(data));
  const authenticate=req=>authService.authenticate(req);
  const status=async profile=>safeStatus(await store.configure(profile.id,profile.auth_user_id,'status',{}));
  async function configure(profile,body) {
    if (!body || typeof body.enabled!=='boolean' || Object.keys(body).some(key=>key!=='enabled')) throw new D.BackupError('invalid-request',400);
    return safeStatus(await store.configure(profile.id,profile.auth_user_id,'settings',{enabled:body.enabled}));
  }
  async function pdf(body) {
    if (!body || Object.keys(body).some(key=>!['jobId','lease'].includes(key)) || !UUID.test(body.jobId||'') || !UUID.test(body.lease||'')) throw new D.BackupError('invalid-request',400);
    const snapshot=await store.apply(body.jobId,body.lease,'snapshot',{});
    if (snapshot?.applied!==true || !snapshot.record || !Number.isSafeInteger(snapshot.record.revision) || snapshot.record.revision<1
      || snapshot.record.status!=='published' || !Object.hasOwn(BOOKS,snapshot.record.bookId) || !Number.isInteger(snapshot.record.round)
      || snapshot.record.round<1 || snapshot.record.round>9999 || !Array.isArray(snapshot.materials) || !Array.isArray(snapshot.insights)
      || !/^[0-9a-f]{64}$/.test(snapshot.content_hash||'')) throw new D.BackupError('record-changed',409);
    // Use only service-validated operator fields and expressly selected public
    // insights. Never receive a recipient, private record, HTML or URL from a caller.
    const record=snapshot.record;
    let buffer;
    try { buffer=await pdfFactory({record,bookTitle:BOOKS[record.bookId],materials:snapshot.materials.map(m=>({title:typeof m.title==='string'?m.title:''})),
      insights:snapshot.insights.map(i=>({authorName:i.authorName,date:i.date,q1:i.q1,q2:i.q2,q3:i.q3}))}); }
    catch(error) { throw pdfFailure(error); }
    if (!Buffer.isBuffer(buffer) || buffer.length<100 || buffer.length>8*1024*1024 || buffer.subarray(0,5).toString()!=='%PDF-') throw new D.BackupError('pdf-unavailable');
    return {buffer,revision:record.revision,contentHash:snapshot.content_hash,filename:'GROWELL-meeting-'+record.round+'.pdf'};
  }
  return {config,store,authenticate,status,configure,pdf};
}
function createHandler(options={}) {
  const service=options.service||createService(options);
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
    try {
      const url=new URL(req.url||'/',service.config.origin),action=url.searchParams.get('action')||'status';
      if(req.method==='GET'&&action==='config')return send(200,{configured:!!service.config.configured});
      if(!service.config.configured)throw new D.BackupError('not-configured');
      if(req.method==='GET'&&action==='status')return send(200,await service.status(await service.authenticate(req)));
      if(req.method!=='POST'||!['pdf','configure'].includes(action))return send(405,{error:'method-not-allowed'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return send(400,{error:'invalid-request'});
      if(action==='pdf'){
        if(!service.config.cronSecret||!D.equal(req.headers.authorization||'','Bearer '+service.config.cronSecret))throw new D.BackupError('authentication-required',401);
      }else if(req.headers.origin!==service.config.origin)return send(403,{error:'same-origin-required'});
      let body=req.body;
      if(typeof body==='string'){
        if(body.length>2048)return send(413,{error:'request-too-large'});
        try{body=JSON.parse(body);}catch(_){return send(400,{error:'invalid-json'});}
      }
      if(!body||typeof body!=='object'||Array.isArray(body)||JSON.stringify(body).length>2048)return send(400,{error:'invalid-request'});
      if(action==='configure')return send(200,await service.configure(await service.authenticate(req),body));
      const result=await service.pdf(body);
      res.statusCode=200;res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="'+result.filename+'"');
      res.setHeader('X-Growell-Record-Revision',String(result.revision));res.setHeader('X-Growell-Content-Hash',result.contentHash);res.end(result.buffer);
    }catch(error){return send(error instanceof D.BackupError?error.status:503,{error:safeError(error)});}
  };
}
module.exports={UUID,BOOKS,createStore,safeStatus,safeError,pdfFailure,createService,createHandler};
