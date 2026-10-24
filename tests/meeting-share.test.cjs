'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const domain=require('../meetingRecordShare.js');
const service=require('../server/meetingShareService.cjs');
const root=path.resolve(__dirname,'..');
const record={bookId:'emotion',round:2,status:'published',topic:'공유하지 않는 주제',sections:[{detail:'공유하지 않는 원문'}],userId:'secret-owner'};

test('future meeting rounds receive canonical public links and only a short round title',()=>{
  for(const bookId of ['emotion','thought','body','action'])for(const round of [1,2,9999]){
    assert.deepEqual(domain.target(bookId,round),{bookId,round,title:'GROWELL · '+round+'번째 모임 기록',
      url:'https://growell-book.vercel.app/meeting/'+bookId+'/'+round,
      appUrl:'https://growell-book.vercel.app/#/book/'+bookId+'/share/meeting/'+round});
  }
  assert.deepEqual(domain.shareData(record),{title:'GROWELL · 2번째 모임 기록',url:'https://growell-book.vercel.app/meeting/emotion/2'});
  assert.equal(JSON.stringify(domain.shareData(record)).includes('공유하지'),false);
  assert.equal(JSON.stringify(domain.shareData(record)).includes('secret-owner'),false);
});

test('drafts, unknown books, injection strings and unbounded rounds never create share payloads',()=>{
  for(const bookId of ['',null,{},['emotion'],'EMOTION','../emotion','emotion"/><script>','https://evil.test'])assert.equal(domain.target(bookId,2),null);
  for(const round of [null,{},[2],false,0,-1,1.2,10000,'2x','02',' 2','2/../3','２','2"><script>','Infinity'])assert.equal(domain.target('emotion',round),null);
  for(const status of ['draft','deleted',null,undefined])assert.equal(domain.shareData({...record,status}),null);
});

function response(){return {statusCode:0,headers:{},body:undefined,setHeader(key,value){this.headers[key]=value;},end(body){this.body=body;}};}
function request(url,extra={}){const res=response();service.createHandler()({url,method:'GET',...extra},res);return res;}

test('public HTML exposes escaped round metadata and a same-origin authenticated app destination',()=>{
  const res=request('/meeting/emotion/2',{headers:{host:'evil.test',authorization:'Bearer secret'},query:{topic:'secret-topic'}});
  assert.equal(res.statusCode,200);assert.match(res.headers['Content-Type'],/text\/html; charset=utf-8/);
  assert.match(res.body,/<meta property="og:title" content="GROWELL · 2번째 모임 기록">/);
  assert.match(res.body,/<meta property="og:url" content="https:\/\/growell-book.vercel.app\/meeting\/emotion\/2">/);
  assert.match(res.body,/<meta property="og:image" content="https:\/\/growell-book.vercel.app\/covers\/og-image-v4.jpg">/);
  assert.match(res.body,/location.replace\("https:\/\/growell-book.vercel.app\/#\/book\/emotion\/share\/meeting\/2"\)/);
  assert.doesNotMatch(res.body,/evil\.test|secret|topic|userId|sections|access_token|refresh_token/);
  assert.equal(res.headers['Content-Length'],String(Buffer.byteLength(res.body)));
  assert.match(res.headers['Cache-Control'],/^public, max-age=300, s-maxage=3600, stale-while-revalidate=3600$/);
  assert.equal(res.headers['X-Robots-Tag'],'noindex, nofollow');
  const script=/<script>(.*?)<\/script>/.exec(res.body)[1];
  assert.ok(res.headers['Content-Security-Policy'].includes("'sha256-"+crypto.createHash('sha256').update(script).digest('base64')+"'"));
  assert.doesNotMatch(res.headers['Content-Security-Policy'],/unsafe-inline|unsafe-eval/);
});

test('rewrite query values and direct API links are validated without host or private field reflection',()=>{
  const api=request('/api/meeting-share?bookId=action&round=9999&email=private@example.test');
  assert.equal(api.statusCode,200);assert.match(api.body,/GROWELL · 9999번째 모임 기록/);assert.doesNotMatch(api.body,/private@example.test/);
  const rewritten=request('/api/meeting-share',{query:{bookId:'body',round:'4'}});
  assert.equal(rewritten.statusCode,200);assert.match(rewritten.body,/meeting\/body\/4/);
  const pathWins=request('/meeting/emotion/2?bookId=thought&round=3',{query:{bookId:'thought',round:'3'}});
  assert.equal(pathWins.statusCode,200);assert.match(pathWins.body,/meeting\/emotion\/2/);assert.doesNotMatch(pathWins.body,/meeting\/thought/);
});

test('invalid route and repeated or array query parameters return a non-cacheable empty 404',()=>{
  for(const url of ['/meeting/unknown/2','/meeting/emotion/0','/meeting/emotion/10000','/meeting/emotion/02',
    '/meeting/emotion/%3Cscript%3E','/meeting/emotion/2/extra','/api/meeting-share?bookId=emotion&round=2&round=3',
    '/api/meeting-share?bookId=emotion&bookId=thought&round=2','/api/meeting-share','/other/emotion/2']){
    const res=request(url);assert.equal(res.statusCode,404,url);assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(res.body,undefined);
  }
  assert.equal(request('/api/meeting-share',{query:{bookId:['emotion'],round:'2'}}).statusCode,404);
  assert.equal(request('/api/meeting-share',{query:{bookId:'emotion',round:['2','3']}}).statusCode,404);
});

test('HEAD returns metadata headers without a body and write methods cannot mutate anything',()=>{
  const get=request('/meeting/emotion/2'),head=request('/meeting/emotion/2',{method:'HEAD'});
  assert.equal(head.statusCode,200);assert.equal(head.body,undefined);assert.deepEqual(head.headers,get.headers);
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
    const res=request('/meeting/emotion/2',{method});assert.equal(res.statusCode,405);assert.equal(res.headers.Allow,'GET, HEAD');assert.equal(res.body,undefined);
  }
});

test('metadata service has no database, record lookup, secrets or authentication dependency',()=>{
  const code=fs.readFileSync(path.join(root,'server/meetingShareService.cjs'),'utf8');
  assert.doesNotMatch(code,/process\.env|supabase|fetch\(|select\(|authorization|cookie/i);
  const config=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));
  assert.deepEqual(config.rewrites.find(row=>row.source==='/meeting/:bookId/:round'),{source:'/meeting/:bookId/:round',destination:'/api/meeting-share?bookId=:bookId&round=:round'});
  const files=require('../scripts/files.cjs');
  assert.ok(files.DEPLOY_FILES.includes('meetingRecordShare.js'));
  for(const file of ['api/meeting-share.js','server/meetingShareService.cjs','tests/meeting-share.test.cjs'])assert.ok(files.PUBLISH_FILES.includes(file));
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.ok(html.indexOf('src="meetingRecordShare.js"')<html.indexOf('src="meetingRecords.js"'));
});

test('native sharing sends only the canonical public link and title',async()=>{
  const sent=[];
  const result=await domain.shareRecord({navigator:{share:async data=>sent.push(data)}},record);
  assert.deepEqual(result,{status:'shared'});assert.deepEqual(sent,[domain.shareData(record)]);
});

test('native share cancellation does not unexpectedly copy a link',async()=>{
  let copies=0;
  const result=await domain.shareRecord({navigator:{share:async()=>{throw Object.assign(new Error('cancel'),{name:'AbortError'});},clipboard:{writeText:async()=>copies++}}},record);
  assert.deepEqual(result,{status:'cancelled'});assert.equal(copies,0);
});

test('clipboard supports unavailable or failed native sharing and stores no record text',async()=>{
  for(const share of [undefined,async()=>{throw new Error('unavailable');}]){
    const copied=[];
    const result=await domain.shareRecord({navigator:{share,clipboard:{writeText:async url=>copied.push(url)}}},record);
    assert.deepEqual(result,{status:'copied'});assert.deepEqual(copied,[domain.shareData(record).url]);
  }
});

test('legacy clipboard fallback restores focus and removes its temporary field',async()=>{
  const nodes=[],copy=[];let restored=0;
  const previous={isConnected:true,focus(){restored++;}};
  const doc={activeElement:previous,body:{appendChild(node){nodes.push(node);}},
    createElement(){return {style:{},setAttribute(){},select(){copy.push(this.value);},setSelectionRange(){},remove(){nodes.splice(nodes.indexOf(this),1);}};},
    execCommand(command){assert.equal(command,'copy');return true;}};
  const result=await domain.shareRecord({document:doc,navigator:{clipboard:{writeText:async()=>{throw new Error('denied');}}}},record);
  assert.deepEqual(result,{status:'copied'});assert.deepEqual(copy,[domain.shareData(record).url]);assert.deepEqual(nodes,[]);assert.equal(restored,1);
});

test('failed copying reports a recoverable error, while drafts never invoke platform APIs',async()=>{
  await assert.rejects(domain.shareRecord({},record),/링크를 복사하지 못했어요/);
  let calls=0;
  await assert.rejects(domain.shareRecord({navigator:{share:async()=>calls++}}, {...record,status:'draft'}),/게시된 모임 기록만/);
  assert.equal(calls,0);
});

test('account or view changes prevent clipboard fallback and completion feedback',async()=>{
  let active=true,copies=0,fail;
  const native=new Promise((resolve,reject)=>{fail=reject;});
  const pending=domain.shareRecord({navigator:{share:()=>native,clipboard:{writeText:async()=>copies++}}},record,{isCurrent:()=>active});
  active=false;fail(new Error('native unavailable'));
  assert.deepEqual(await pending,{status:'cancelled'});assert.equal(copies,0);
  assert.deepEqual(await domain.shareRecord({navigator:{share:async()=>{throw new Error('must not run');}}},record,{isCurrent:()=>false}),{status:'cancelled'});
});
