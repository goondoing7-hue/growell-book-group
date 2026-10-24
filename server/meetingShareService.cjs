'use strict';

const crypto=require('node:crypto');
const {target}=require('../meetingRecordShare.js');

function escapeHtml(value){return String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function requestTarget(req){
  let url;
  try{url=new URL(req.url||'', 'https://growell-book.vercel.app');}catch(error){return null;}
  const path=/^\/meeting\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if(path)return target(path[1],path[2]);
  if(url.pathname!=='/api/meeting-share')return null;
  // A rewritten request may expose route values through req.query instead of
  // its original pathname. Reject repeated/array inputs rather than guessing.
  for(const name of ['bookId','round'])if(url.searchParams.getAll(name).length>1)return null;
  const query=req.query||{};
  const bookId=Object.hasOwn(query,'bookId')?query.bookId:url.searchParams.get('bookId');
  const round=Object.hasOwn(query,'round')?query.round:url.searchParams.get('round');
  return target(bookId,round);
}
function page(value){
  const title=escapeHtml(value.title),url=escapeHtml(value.url),appUrl=escapeHtml(value.appUrl);
  const script='location.replace('+JSON.stringify(value.appUrl).replace(/</g,'\\u003c')+');';
  const scriptHash=crypto.createHash('sha256').update(script).digest('base64');
  // This page intentionally reads no database, auth session, record body,
  // draft status, member name or meeting topic. Only the validated round is public.
  const html='<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>'+title+'</title><meta name="description" content="모임 기록을 확인해보세요.">'+
    '<meta name="robots" content="noindex,nofollow"><link rel="canonical" href="'+url+'">'+
    '<meta property="og:type" content="website"><meta property="og:locale" content="ko_KR">'+
    '<meta property="og:site_name" content="GROWELL"><meta property="og:title" content="'+title+'">'+
    '<meta property="og:description" content="모임 기록을 확인해보세요."><meta property="og:url" content="'+url+'">'+
    '<meta property="og:image" content="https://growell-book.vercel.app/covers/og-image-v4.jpg">'+
    '<meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1200">'+
    '<meta property="og:image:height" content="630"><meta property="og:image:alt" content="GROWELL 독서모임">'+
    '</head><body><main><h1>'+title+'</h1><p><a href="'+appUrl+'">모임 기록 열기</a></p></main><script>'+script+'</script></body></html>';
  return {html,scriptHash};
}
function createHandler(){
  return function handler(req,res){
    const method=String(req.method||'GET').toUpperCase();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    if(method!=='GET'&&method!=='HEAD'){
      res.statusCode=405;res.setHeader('Allow','GET, HEAD');res.setHeader('Cache-Control','no-store');res.end();return;
    }
    const value=requestTarget(req);
    if(!value){res.statusCode=404;res.setHeader('Cache-Control','no-store');res.end();return;}
    const output=page(value);
    res.statusCode=200;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Cache-Control','public, max-age=300, s-maxage=3600, stale-while-revalidate=3600');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'sha256-"+output.scriptHash+"'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Content-Length',String(Buffer.byteLength(output.html)));
    res.end(method==='HEAD'?undefined:output.html);
  };
}
module.exports={requestTarget,page,createHandler};
