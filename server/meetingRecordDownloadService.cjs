'use strict';

const D = require('./driveBackupDomain.cjs');
const {createTransport} = require('./driveBackupService.cjs');
const Domain = require('../meetingRecordsDomain.js');
const {BOOKS} = require('./meetingMailService.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 750000;
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const SAFE_CODES = new Set(['not-configured','authentication-required','membership-required','administrator-required','invalid-request','record-unavailable','record-changed','service-unavailable','rate-limited','pdf-unavailable','pdf-glyph-unsupported','pdf-too-large','request-too-large']);
function safeError(error) { return SAFE_CODES.has(error?.code) ? error.code : 'service-unavailable'; }
function getConfig(env = process.env) {
  const origin = env.GROWELL_SYNC_ORIGIN || 'https://growell-book.vercel.app';
  const database = env.GROWELL_SUPABASE_URL || 'https://oxaeecawijnetwmvggjs.supabase.co';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  return {origin, database, serviceKey, configured:!!(/^https:\/\/[^/?#:@]+(?::443)?$/.test(origin) && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(database) && serviceKey)};
}
function approved(profile, authId) {
  if (!profile || profile.auth_user_id !== authId || typeof profile.id !== 'string' || !profile.id || profile.is_deleted !== false || profile.approval_status !== 'approved') throw new D.BackupError('membership-required',403);
  return profile;
}
function createStore(config, request) {
  // The server key supplies the API key only. Authorization always stays the
  // requesting member's JWT, so every content read uses existing RLS / RPC
  // permissions rather than bypassing book, member, or ownership restrictions.
  const read = (token,path,method='GET',body) => request(config.database+'/rest/v1/'+path,{method,
    headers:{apikey:config.serviceKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  async function pageRows(token,path,maximum=10000) {
    const collected=[],pageSize=500;
    for (let offset=0;offset<=maximum;offset+=pageSize) {
      const result=await read(token,path+'&order=id.asc&limit='+pageSize+'&offset='+offset);
      if (!Array.isArray(result) || result.length>pageSize) throw new D.BackupError('service-unavailable');
      collected.push(...result);
      if (collected.length>maximum) throw new D.BackupError('pdf-too-large',413);
      if (result.length<pageSize) return collected;
    }
    throw new D.BackupError('pdf-too-large',413);
  }
  return {
    async profile(token,authId) {
      const rows=await read(token,'profiles?select=id,auth_user_id,is_admin,is_deleted,approval_status&auth_user_id=eq.'+encodeURIComponent(authId)+'&limit=2');
      if (!Array.isArray(rows)) throw new D.BackupError('service-unavailable');
      return rows.length===1?rows[0]:null;
    },
    records:(token,bookId)=>read(token,'rpc/growell_get_meeting_records','POST',{p_book_id:bookId}),
    posts:(token,bookId)=>pageRows(token,'posts?select=*&book_id=eq.'+encodeURIComponent(bookId)+'&note_type=eq.insight'),
    async authors(token,ids) {
      if (!ids.length) return [];
      // profile IDs are legacy text IDs; quote and URL-encode PostgREST values.
      const quote=value=>'"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
      const result=[];
      for (let offset=0;offset<ids.length;offset+=100) {
        const rows=await read(token,'profiles?select=id,name,approval_status,is_deleted&id=in.'+encodeURIComponent('('+ids.slice(offset,offset+100).map(quote).join(',')+')')+'&approval_status=eq.approved&is_deleted=eq.false&limit=101');
        if (!Array.isArray(rows) || rows.length>100) throw new D.BackupError('service-unavailable');
        result.push(...rows);
      }
      return result;
    },
    async materials(token,record) {
      if (!record.materialIds.length) return [];
      return read(token,'material_notes?select=*&book_id=eq.'+encodeURIComponent(record.bookId)+'&user_id=eq.'+encodeURIComponent(record.userId)+'&id=in.'+encodeURIComponent('('+record.materialIds.join(',')+')')+'&limit=31');
    }
  };
}
function visible(row) {
  const falseOrMissing=value=>value===undefined || value===null || value===false || value==='false';
  return row && falseOrMissing(row.is_deleted) && (row.deleted_at===undefined || row.deleted_at===null) && falseOrMissing(row.is_private)
    && (row.visibility === undefined || row.visibility === null || row.visibility === 'public');
}
function meetingRound(value) {
  const candidate=typeof value==='number'?String(value):typeof value==='string'?value.trim():'';
  return candidate.length<=30 && /^[+]?[0-9]{1,10}(?:[.][0-9]{1,10})?(?:[eE][+-]?[0-9]{1,3})?$/.test(candidate)?Number(candidate):null;
}
function insightDate(value) {
  if (value===null || value===undefined) return '';
  const date = new Date(typeof value==='number'?value:typeof value==='string' && /^[0-9]{1,16}$/.test(value)?Number(value):value);
  if (!Number.isFinite(date.getTime())) throw new D.BackupError('service-unavailable');
  return date.toISOString();
}
function requestShape(body) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new D.BackupError('invalid-request',400);
  if (Object.hasOwn(body,'preview')) {
    if (Object.keys(body).length!==1 || !body.preview || !Domain.validateRecord(body.preview).ok) throw new D.BackupError('invalid-request',400);
    return {preview:true,record:Domain.normalizeRecord(body.preview),bookId:body.preview.bookId};
  }
  if (Object.keys(body).some(key=>!['bookId','recordId'].includes(key)) || !Object.hasOwn(BOOKS,body.bookId) || !UUID.test(body.recordId||'')) throw new D.BackupError('invalid-request',400);
  return {preview:false,bookId:body.bookId,recordId:body.recordId};
}
function createService(options={}) {
  const config=options.config||getConfig(),request=options.request||createTransport(options.fetch),store=options.store||createStore(config,request);
  const pdfFactory=options.pdfFactory||((data,renderOptions)=>require('./meetingRecordPdf.cjs').createMeetingRecordPdf(data,renderOptions));
  async function authenticate(req) {
    if (!config.configured) throw new D.BackupError('not-configured');
    const match=/^Bearer ([A-Za-z0-9._~-]{1,16000})$/.exec(req.headers?.authorization||'');
    if (!match) throw new D.BackupError('authentication-required',401);
    const token=match[1],user=await request(config.database+'/auth/v1/user',{headers:{apikey:config.serviceKey,Authorization:'Bearer '+token}},'auth');
    if (!UUID.test(user?.id||'')) throw new D.BackupError('authentication-required',401);
    return {token,profile:approved(await store.profile(token,user.id),user.id)};
  }
  async function snapshot(identity,shape) {
    const {token,profile}=identity;
    const records=await store.records(token,shape.bookId);
    if (!Array.isArray(records)) throw new D.BackupError('service-unavailable');
    const saved=records.find(record=>record?.id===(shape.preview?shape.record.id:shape.recordId));
    let record;
    if (shape.preview) {
      if (profile.is_admin!==true || shape.record.userId!==profile.id || saved && (saved.userId!==profile.id || saved.bookId!==shape.bookId)) throw new D.BackupError('administrator-required',403);
      if (saved && saved.revision!==shape.record.revision || !saved && shape.record.revision!==0) throw new D.BackupError('record-changed',409);
      record=shape.record;
    } else {
      if (!saved || saved.bookId!==shape.bookId || saved.status!=='published' && !(saved.status==='draft' && profile.is_admin===true && saved.userId===profile.id)) throw new D.BackupError('record-unavailable',404);
      record=Domain.normalizeRecord(saved);
      if (!record || !Domain.validateRecord(record).ok) throw new D.BackupError('service-unavailable');
    }
    const [rawPosts,rawMaterials]=await Promise.all([store.posts(token,record.bookId),store.materials(token,record)]);
    if (!Array.isArray(rawPosts) || !Array.isArray(rawMaterials) || rawMaterials.length>30) throw new D.BackupError('service-unavailable');
    const posts=rawPosts.filter(row=>visible(row) && row.book_id===record.bookId && row.note_type==='insight' && meetingRound(row.meeting_no)===record.round);
    if (posts.length>300) throw new D.BackupError('pdf-too-large',413);
    const authors=await store.authors(token,[...new Set(posts.map(row=>row.user_id).filter(id=>typeof id==='string' && id))]);
    if (!Array.isArray(authors)) throw new D.BackupError('service-unavailable');
    const byId=new Map(authors.filter(row=>row?.approval_status==='approved' && row.is_deleted===false).map(row=>[row.id,row]));
    const insights=posts.filter(row=>byId.has(row.user_id)).sort((a,b)=>Number(a.created_at)-Number(b.created_at) || String(a.id).localeCompare(String(b.id)))
      .map(row=>({authorName:typeof byId.get(row.user_id).name==='string' && byId.get(row.user_id).name.trim()?byId.get(row.user_id).name:'회원',date:insightDate(row.created_at),
        q1:row.q1??'',q2:row.q2??'',q3:row.q3??''}));
    const materials=record.materialIds.map(id=>rawMaterials.find(row=>visible(row) && row.id===id && row.book_id===record.bookId && row.user_id===record.userId)).filter(Boolean)
      .map(row=>({title:row.title||'자료실 글',url:config.origin+'/#/book/'+encodeURIComponent(record.bookId)+'/materials/post/'+encodeURIComponent(row.id)}));
    // Deliberate projection: email, avatars, tokens, source dumps, photos,
    // private entries and arbitrary caller fields never enter a PDF.
    const projected={record:{round:record.round,date:record.date,topic:record.topic,sections:record.sections.map(item=>({summary:item.summary,detail:item.detail})),
      concepts:record.concepts.map(item=>({word:item.word,meaning:item.meaning})),nextMeeting:record.nextMeeting,status:record.status},bookTitle:BOOKS[record.bookId],materials,insights};
    return {projected,revision:record.revision,preview:shape.preview || record.status==='draft',round:record.round};
  }
  async function download(identity,body) {
    const shape=requestShape(body),first=await snapshot(identity,shape);
    let buffer;
    try { buffer=await pdfFactory(first.projected,first.preview?{preview:true}:undefined); }
    catch (error) { throw new D.BackupError(error?.code==='PDF_UNSUPPORTED_GLYPH'?'pdf-glyph-unsupported':'pdf-unavailable'); }
    if (!Buffer.isBuffer(buffer) || buffer.length<100 || buffer.subarray(0,5).toString()!=='%PDF-') throw new D.BackupError('pdf-unavailable');
    if (buffer.length>MAX_PDF_BYTES) throw new D.BackupError('pdf-too-large',413);
    // Recheck permission and the complete outgoing source after rendering. A
    // changed/withdrawn record or answer never ships an obsolete cached PDF.
    const currentProfile=approved(await store.profile(identity.token,identity.profile.auth_user_id),identity.profile.auth_user_id);
    const final=await snapshot({...identity,profile:currentProfile},shape);
    if (first.revision!==final.revision || D.hash(JSON.stringify(first.projected))!==D.hash(JSON.stringify(final.projected))) throw new D.BackupError('record-changed',409);
    return {buffer,revision:first.revision,filename:'GROWELL-meeting-'+first.round+'.pdf'};
  }
  return {config,store,authenticate,download};
}
function createHandler(options={}) {
  const service=options.service||createService(options);
  return async (req,res)=>{
    res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
    try {
      if (req.method!=='POST') {res.setHeader('Allow','POST');return send(405,{error:'method-not-allowed'});}
      if (req.headers?.origin!==service.config.origin) return send(403,{error:'same-origin-required'});
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||'')) return send(400,{error:'invalid-request'});
      if (Number(req.headers?.['content-length'])>MAX_BODY_BYTES) return send(413,{error:'request-too-large'});
      let body=req.body;
      if (typeof body==='string') {
        if (Buffer.byteLength(body,'utf8')>MAX_BODY_BYTES) return send(413,{error:'request-too-large'});
        try {body=JSON.parse(body);} catch (_) {return send(400,{error:'invalid-json'});}
      }
      if (!body || typeof body!=='object' || Array.isArray(body)) return send(400,{error:'invalid-request'});
      if (Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_BODY_BYTES) return send(413,{error:'request-too-large'});
      const result=await service.download(await service.authenticate(req),body);
      res.statusCode=200;res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="'+result.filename+'"');
      res.setHeader('Content-Length',String(result.buffer.length));res.setHeader('X-Growell-Record-Revision',String(result.revision));res.end(result.buffer);
    } catch(error) {return send(error instanceof D.BackupError?error.status:503,{error:safeError(error)});}
  };
}
module.exports={MAX_BODY_BYTES,MAX_PDF_BYTES,getConfig,safeError,createStore,requestShape,createService,createHandler};
