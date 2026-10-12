'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const S=require('../server/meetingRecordDownloadService.cjs');
const D=require('../server/driveBackupDomain.cjs');
const AUTH='11111111-1111-4111-8111-111111111111';
const ID='22222222-2222-4222-8222-222222222222';
const CONFIG=S.getConfig({SUPABASE_SERVICE_ROLE_KEY:'fixture-service-key'});
const PROFILE={id:'fixture-owner',auth_user_id:AUTH,is_admin:true,is_deleted:false,approval_status:'approved'};
const RECORD={id:ID,bookId:'emotion',round:1,date:'2026-10-10',topic:'확인용 모임',sections:[{id:'section-1',summary:'균형',detail:'원문은 그대로 보존한다.'}],concepts:[{id:'concept-1',word:'균형',meaning:'서로 관계된 영역을 조절하는 것이다.'}],materialIds:['material-1'],nextMeeting:null,status:'published',userId:PROFILE.id,revision:2,createdAt:null,updatedAt:null};
const AUTHOR={id:'public-author',name:'공개 회원',approval_status:'approved',is_deleted:false};
const POST={id:'post-1',book_id:'emotion',user_id:AUTHOR.id,note_type:'insight',meeting_no:'1',created_at:1791600000000,q1:'모임 소감 원문',q2:'새로운 깨달음 원문',q3:'실천할 배움 원문'};
function fixture(options={}) {
  const state={profile:structuredClone(PROFILE),records:[structuredClone(RECORD)],posts:[structuredClone(POST)],authors:[structuredClone(AUTHOR)],materials:[{id:'material-1',book_id:'emotion',user_id:PROFILE.id,title:'함께 볼 자료'}],renders:[],reads:[]};
  Object.assign(state,options.state);
  const read=(name,args,value)=>{state.reads.push([name,...args]);return structuredClone(value);};
  const store={profile:async(...args)=>read('profile',args,state.profile),records:async(...args)=>read('records',args,state.records),posts:async(...args)=>read('posts',args,state.posts),authors:async(...args)=>read('authors',args,state.authors),materials:async(...args)=>read('materials',args,state.materials)};
  const request=async(url,requestOptions,kind)=>{state.reads.push(['auth',url,requestOptions,kind]);if(requestOptions.headers.Authorization!=='Bearer fixture.jwt')throw new D.BackupError('authentication-required',401);return {id:AUTH};};
  const pdfFactory=async(data,renderOptions)=>{state.renders.push([structuredClone(data),renderOptions]);if(options.afterRender)options.afterRender(state);if(options.renderError)throw options.renderError instanceof Error?options.renderError:new Error('PRIVATE SOURCE SECRET PATH');return options.buffer||Buffer.from('%PDF-'+'.'.repeat(150));};
  const service=S.createService({config:CONFIG,request,store,pdfFactory});
  return {state,store,service,handler:S.createHandler({service})};
}
async function invoke(handler,options={}) {
  const headers={};let value;
  const req={method:'POST',url:'/api/meeting-record-pdf',body:{bookId:'emotion',recordId:ID},headers:{authorization:'Bearer fixture.jwt',origin:CONFIG.origin,'content-type':'application/json'},...options};
  await handler(req,{setHeader:(name,content)=>{headers[name]=content;},set statusCode(status){headers.status=status;},end:content=>{value=content;}});
  return {headers,body:Buffer.isBuffer(value)?value:JSON.parse(value)};
}
test('saved PDF downloads canonical server content with private attachment headers and never writes source',async()=>{
  const f=fixture(),original=structuredClone({records:f.state.records,posts:f.state.posts,authors:f.state.authors,materials:f.state.materials});
  const result=await invoke(f.handler);
  assert.equal(result.headers.status,200);assert.equal(result.headers['Content-Type'],'application/pdf');assert.equal(result.headers['Content-Disposition'],'attachment; filename="GROWELL-meeting-1.pdf"');
  assert.equal(result.headers['Cache-Control'],'no-store, private');assert.equal(result.headers['X-Growell-Record-Revision'],'2');assert.equal(result.body.subarray(0,5).toString(),'%PDF-');
  assert.equal(f.state.renders.length,1);assert.equal(f.state.renders[0][1],undefined);
  assert.equal(f.state.renders[0][0].record.sections[0].detail,RECORD.sections[0].detail);
  assert.deepEqual(f.state.renders[0][0].insights,[{authorName:AUTHOR.name,date:new Date(POST.created_at).toISOString(),q1:POST.q1,q2:POST.q2,q3:POST.q3}]);
  assert.deepEqual(f.state.renders[0][0].materials,[{title:'함께 볼 자료',url:CONFIG.origin+'/#/book/emotion/materials/post/material-1'}]);
  assert.deepEqual({records:f.state.records,posts:f.state.posts,authors:f.state.authors,materials:f.state.materials},original);
  assert.equal(f.state.reads.filter(call=>call[0]==='records').length,2);
});
test('no auth, unapproved profile, incorrect origin, non-JSON and non-POST requests cannot download',async()=>{
  assert.equal((await invoke(fixture().handler,{headers:{authorization:'Bearer unknown',origin:CONFIG.origin,'content-type':'application/json'}})).headers.status,401);
  assert.equal((await invoke(fixture().handler,{headers:{origin:CONFIG.origin,'content-type':'application/json'}})).headers.status,401);
  assert.equal((await invoke(fixture({state:{profile:{...PROFILE,approval_status:'pending'}}}).handler)).headers.status,403);
  assert.equal((await invoke(fixture({state:{profile:{...PROFILE,is_deleted:true}}}).handler)).headers.status,403);
  const f=fixture();
  for(const headers of [{authorization:'Bearer fixture.jwt',origin:'https://attacker.example','content-type':'application/json'},{authorization:'Bearer fixture.jwt',origin:CONFIG.origin,'content-type':'text/plain'}])assert.notEqual((await invoke(f.handler,{headers})).headers.status,200);
  assert.equal((await invoke(f.handler,{method:'GET'})).headers.status,405);assert.equal(f.state.renders.length,0);
});
test('locked book permission, unavailable records and another operator draft remain inaccessible',async()=>{
  const f=fixture();f.store.records=async()=>{throw new D.BackupError('membership-required',403);};
  assert.equal((await invoke(f.handler,{body:{bookId:'thought',recordId:ID}})).headers.status,403);
  assert.equal((await invoke(fixture({state:{records:[]}}).handler)).headers.status,404);
  assert.equal((await invoke(fixture({state:{records:[{...RECORD,status:'draft',userId:'another-operator'}]}}).handler)).headers.status,404);
  assert.equal((await invoke(fixture({state:{profile:{...PROFILE,is_admin:false},records:[{...RECORD,status:'draft'}]}}).handler)).headers.status,404);
});
test('private, withdrawn, foreign-book/round and unapproved-author answers never enter the PDF',async()=>{
  const f=fixture();
  f.state.posts=[{...POST,email:'PRIVATE EMAIL',avatar:'PRIVATE PHOTO',privateEntries:['PRIVATE ENTRY']},
    ...[{is_private:true},{is_private:'true'},{is_private:'unknown'},{is_deleted:true},{deleted_at:'2026-10-12'},{visibility:'private'},{book_id:'body'},{meeting_no:'2'},{note_type:'thought'},{user_id:'pending-author'},{user_id:'deleted-author'}].map((fields,index)=>({...POST,id:'hidden-'+index,q2:'MUST NOT EXPORT '+index,...fields}))];
  f.state.authors.push({id:'pending-author',name:'MUST NOT EXPORT',approval_status:'pending',is_deleted:false},{id:'deleted-author',name:'MUST NOT EXPORT',approval_status:'approved',is_deleted:true});
  f.state.materials.push({id:'foreign',title:'MUST NOT EXPORT',book_id:'body',user_id:PROFILE.id});
  const result=await invoke(f.handler);assert.equal(result.headers.status,200);
  const outgoing=JSON.stringify(f.state.renders[0][0]);assert.equal(outgoing.includes('PRIVATE'),false);assert.equal(outgoing.includes('MUST NOT EXPORT'),false);assert.equal(f.state.renders[0][0].insights.length,1);
  assert.equal(f.state.reads.some(call=>String(call[0]).includes('private')),false);
});
test('preview permits an approved operator own draft or published edit without saving it',async()=>{
  for(const status of ['draft','published']) {
    const f=fixture(),preview={...structuredClone(RECORD),status,topic:status==='draft'?'':'수정 중인 주제',sections:[{id:'section-1',summary:'미리보기',detail:'아직 저장하지 않은 원문이다.'}]};
    const result=await invoke(f.handler,{body:{preview}});assert.equal(result.headers.status,200);assert.deepEqual(f.state.renders[0][1],{preview:true});assert.equal(f.state.renders[0][0].record.topic,preview.topic);
    assert.equal(f.state.records[0].topic,RECORD.topic);assert.equal(f.state.records[0].sections[0].detail,RECORD.sections[0].detail);
  }
  const f=fixture({state:{records:[]}}),preview={...structuredClone(RECORD),status:'draft',revision:0,topic:'',date:null};
  assert.equal((await invoke(f.handler,{body:{preview}})).headers.status,200);
});
test('caller cannot inject private sources, modify others previews, reuse deleted IDs or bypass revisions',async()=>{
  for (const body of [{bookId:'emotion',recordId:ID,record:{topic:'INJECTED'}},{bookId:'emotion',recordId:ID,insights:[{q2:'PRIVATE'}]},
    {preview:{...RECORD,userId:'another-member',status:'draft'}},{preview:{...RECORD,status:'draft',revision:1}},
    {preview:{...RECORD,status:'draft',privateEntries:['PRIVATE']}},{preview:{...RECORD,status:'draft'},materials:[{title:'PRIVATE'}]}]) {
    const f=fixture(),result=await invoke(f.handler,{body});assert.notEqual(result.headers.status,200);assert.equal(f.state.renders.length,0);
  }
  assert.equal((await invoke(fixture({state:{profile:{...PROFILE,is_admin:false}}}).handler,{body:{preview:{...RECORD,status:'draft'}}})).headers.status,403);
  assert.equal((await invoke(fixture({state:{records:[]}}).handler,{body:{preview:{...RECORD,status:'draft'}}})).headers.status,409);
});
test('revoked membership, changed record or withdrawn public answer during rendering blocks stale PDF',async()=>{
  for(const afterRender of [state=>{state.profile.approval_status='rejected';},state=>{state.records[0].revision++;state.records[0].topic='변경한 주제';},state=>{state.posts[0].is_private=true;},state=>{state.records=[];},state=>{state.authors[0].is_deleted=true;}]) {
    const f=fixture({afterRender}),result=await invoke(f.handler);assert.notEqual(result.headers.status,200);assert.equal(Buffer.isBuffer(result.body),false);
  }
});
test('body/PDF size bounds and rendering errors return safe failures without exposing source or credentials',async()=>{
  const tooLarge=await invoke(fixture().handler,{body:'x'.repeat(S.MAX_BODY_BYTES+1)});assert.equal(tooLarge.headers.status,413);
  assert.equal((await invoke(fixture().handler,{body:'{invalid-json'})).headers.status,400);
  const failed=await invoke(fixture({renderError:true}).handler);assert.equal(failed.headers.status,503);assert.equal(failed.body.error,'pdf-unavailable');assert.equal(JSON.stringify(failed.body).includes('PRIVATE'),false);
  const unsupported=await invoke(fixture({renderError:Object.assign(new Error('PRIVATE ORIGINAL GLYPH'),{code:'PDF_UNSUPPORTED_GLYPH'})}).handler);
  assert.equal(unsupported.headers.status,503);assert.equal(unsupported.body.error,'pdf-glyph-unsupported');assert.equal(JSON.stringify(unsupported.body).includes('PRIVATE'),false);
  assert.equal((await invoke(fixture({buffer:Buffer.from('not a PDF')}).handler)).headers.status,503);
  const huge=Buffer.alloc(S.MAX_PDF_BYTES+1);huge.write('%PDF-');assert.equal((await invoke(fixture({buffer:huge}).handler)).headers.status,413);
  const malformed=fixture();malformed.state.records[0].sections[0].detail='x'.repeat(10001);assert.equal((await invoke(malformed.handler)).headers.status,503);assert.equal(malformed.state.renders.length,0);
});
test('all content store reads preserve caller JWT and paginate instead of silently exporting an incomplete list',async()=>{
  const calls=[],store=S.createStore(CONFIG,async(url,options)=>{calls.push([url,options]);if(url.includes('rpc/'))return [RECORD];return [];});
  await store.profile('member.jwt',AUTH);await store.records('member.jwt','emotion');await store.posts('member.jwt','emotion');await store.authors('member.jwt',['profile"with,characters']);await store.materials('member.jwt',RECORD);
  for(const [,options] of calls){assert.equal(options.headers.Authorization,'Bearer member.jwt');assert.equal(options.headers.apikey,'fixture-service-key');assert.ok(['GET','POST'].includes(options.method));}
  assert.deepEqual(JSON.parse(calls[1][1].body),{p_book_id:'emotion'});assert.ok(calls[2][0].includes('limit=500&offset=0'));assert.equal(calls.some(([url])=>url.includes('private_entries')),false);
  assert.ok(calls[3][0].includes('approval_status=eq.approved&is_deleted=eq.false'));assert.ok(calls[4][0].includes('user_id=eq.fixture-owner'));
  let requests=0;
  const paged=S.createStore(CONFIG,async()=>{requests++;return requests===1?Array.from({length:500},(_,i)=>({id:'post-'+i})):[];});
  assert.equal((await paged.posts('member.jwt','emotion')).length,500);assert.equal(requests,2);
});
test('downloads need no Google consent, OAuth client secret, sync key or SMTP configuration',()=>{
  assert.equal(CONFIG.configured,true);assert.equal(Object.hasOwn(CONFIG,'clientSecret'),false);assert.equal(Object.hasOwn(CONFIG,'key'),false);assert.equal(S.getConfig({}).configured,false);
  assert.equal(S.safeError(new Error('SECRET PRIVATE RESPONSE')),'service-unavailable');
});
test('real server renderer produces an immediate PDF attachment for saved records and unsaved draft previews',async()=>{
  for (const preview of [false,true]) {
    const f=fixture(),service=S.createService({config:CONFIG,store:f.store,request:async()=>({id:AUTH})});
    const body=preview?{preview:{...structuredClone(RECORD),status:'draft',topic:'',date:null}}:{bookId:'emotion',recordId:ID};
    const result=await invoke(S.createHandler({service}),{body});
    assert.equal(result.headers.status,200);assert.equal(result.headers['Content-Type'],'application/pdf');assert.equal(Buffer.isBuffer(result.body),true);
    assert.ok(result.body.length>10000);assert.equal(result.body.subarray(0,5).toString(),'%PDF-');assert.ok(result.body.toString('latin1').includes('%%EOF'));
    assert.equal(f.state.records[0].status,'published');assert.equal(f.state.records[0].topic,RECORD.topic);
  }
});
