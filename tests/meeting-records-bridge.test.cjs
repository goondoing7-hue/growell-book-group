'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../meetingRecordsBridge.js');
function fixture(domain){
  let user='admin',epoch=1,blocked=false;
  const rows={posts:[{id:'p1',bookId:'emotion',noteType:'insight',meetingNo:'1',q1:'내 소감',q2:'깨달음',q3:'실천',createdAt:1},{id:'p2',bookId:'emotion',noteType:'thought',meetingNo:'1'},{id:'p3',bookId:'emotion',noteType:'insight',meetingNo:'2'}],material_notes:[{id:'mn_one',bookId:'emotion',userId:'admin',title:'연결 자료'}]};
  const calls=[],opened=[];let resolve;
  let rpcResult={data:[]};let pending=false;
  const bridge=create({sessionUserId:()=>user,sessionEpoch:()=>epoch,canReadBook:()=>!blocked,isAdmin:()=>user==='admin',
    domain:domain||{normalizeRecord:x=>x,validateRecord:()=>({ok:true})},mapPost:x=>x,mapMaterial:x=>x,showToast:()=>{},openSource:(...args)=>opened.push(args),
    sb:{rpc:async(...args)=>{calls.push(args);return pending?await new Promise(r=>{resolve=r;}):rpcResult;},from:table=>({select:()=>({eq:async()=>({data:rows[table]})})})}});
  return {bridge,calls,opened,rows,change:()=>{user='member';epoch++;},block:()=>{blocked=true;},result:x=>{rpcResult=x;},hold:()=>{pending=true;},release:x=>resolve(x)};
}
test('only public insight posts matching book and round become carousel cards, source opens original',async()=>{
 const f=fixture();await f.bridge.loadRecords('emotion');
 assert.deepEqual(f.bridge.getInsights('emotion',1).map(x=>x.id),['p1']);
 assert.deepEqual(f.bridge.getInsights('emotion',1)[0].answers,['내 소감','깨달음','실천']);
 f.bridge.openPost('p1','emotion');assert.equal(f.opened[0][0].id,'p1');assert.equal(f.opened[0][1],'post');
 f.bridge.openPost('missing','emotion');assert.equal(f.opened.length,1);
 assert.equal(f.bridge.getMaterials('emotion')[0].id,'mn_one');
});

test('popup source getter preserves full permitted insight rows and is fenced by session, book access and reset',async()=>{
 const f=fixture();Object.assign(f.rows.posts[0],{html:'legacy full body',photo:{dataUrl:'https://example.test/photo.jpg'},q3:'complete tail'});
 const before=JSON.stringify(f.rows);await f.bridge.loadRecords('emotion');
 const rows=f.bridge.getInsightPosts('emotion');assert.deepEqual(rows.map(p=>p.id),['p1','p3']);assert.equal(rows[0].html,'legacy full body');assert.equal(rows[0].q3,'complete tail');assert.deepEqual(rows[0].photo,{dataUrl:'https://example.test/photo.jpg'});
 assert.deepEqual(f.bridge.getInsightPosts('thought'),[]);assert.equal(JSON.stringify(f.rows),before);
 f.block();assert.deepEqual(f.bridge.getInsightPosts('emotion'),[]);
 const second=fixture();await second.bridge.loadRecords('emotion');second.change();assert.deepEqual(second.bridge.getInsightPosts('emotion'),[]);
 const third=fixture();await third.bridge.loadRecords('emotion');third.bridge.reset();assert.deepEqual(third.bridge.getInsightPosts('emotion'),[]);
});
test('late load cannot cross login session or reset and cannot populate source cache',async()=>{
 for(const action of ['change','reset']){const f=fixture();f.hold();const load=f.bridge.loadRecords('emotion');
 if(action==='change')f.change();else f.bridge.reset();
 f.release({data:[]});await assert.rejects(load,/계정/);assert.deepEqual(f.bridge.getInsights('emotion',1),[]);}
});
test('insights retain author identity for current profile lookup without copying attachment photos',async()=>{
 const f=fixture();Object.assign(f.rows.posts[0],{userId:'member-1',userName:'회원',photo:'attachment.jpg'});
 const before=JSON.stringify(f.rows);await f.bridge.loadRecords('emotion');
 const insight=f.bridge.getInsights('emotion',1)[0];
 assert.equal(insight.userId,'member-1');assert.equal(insight.name,'회원');
 assert.equal(Object.hasOwn(insight,'photo'),false);assert.equal(Object.hasOwn(insight,'avatar'),false);
 assert.equal(JSON.stringify(f.rows),before,'profile display must not change original member posts');
});
test('failed partial reads preserve earlier valid results and report failure rather than fake empty record list',async()=>{
 const f=fixture();await f.bridge.loadRecords('emotion');f.result({error:{message:'offline'}});
 await assert.rejects(f.bridge.loadRecords('emotion'),/처리하지/);assert.equal(f.bridge.getInsights('emotion',1).length,1);
 f.block();assert.deepEqual(f.bridge.getInsights('emotion',1),[]);
});
test('writes carry expected revision and preserve conflicts; other user cannot write',async()=>{
 const f=fixture();const record={id:'record',bookId:'emotion',userId:'admin',revision:4};
 f.result({data:{...record,revision:5}});assert.equal((await f.bridge.saveRecord(record)).revision,5);
 assert.equal(f.calls[0][1].p_expected_revision,4);
 f.result({error:{message:'Meeting record changed; reload before saving'}});await assert.rejects(f.bridge.saveRecord(record),/다른 화면/);assert.equal(record.revision,4);
 f.change();await assert.rejects(f.bridge.saveRecord(record),/권한/);assert.equal(f.calls.length,2);
});
test('delete must receive committed tombstone acknowledgement',async()=>{
 const f=fixture(),record={id:'record',bookId:'emotion',userId:'admin',revision:3};
 f.result({data:null});await assert.rejects(f.bridge.deleteRecord(record));
 f.result({data:{id:'record',deleted:true,revision:4}});assert.equal((await f.bridge.deleteRecord(record)).deleted,true);
 assert.equal(f.calls[1][1].p_expected_revision,3);
});
test('RPC failures retain conflict codes required to recover editor and deletion conflicts',async()=>{
 const record={id:'record',bookId:'emotion',userId:'admin',revision:3};
 for(const failure of [
   {message:'Meeting record changed; reload before saving',code:'40001'},
   {message:'duplicate key value violates unique constraint',code:'23505'},
   {message:'Meeting record deleted',code:'40001'},
   {message:'upstream response omitted text',code:'40001'}
 ]){
   const f=fixture();f.result({error:failure});
   await assert.rejects(f.bridge.saveRecord(record),error=>error.code===failure.code);
   await assert.rejects(f.bridge.deleteRecord(record),error=>error.code===failure.code);
 }
 const f=fixture();f.result({error:{message:'Meeting record changed; reload before saving'}});
 await assert.rejects(f.bridge.saveRecord(record),error=>error.code==='40001');
});
test('an older overlapping book read cannot overwrite newer insight and material caches',async()=>{
 const pending=[],opened=[];let version='old';
 const bridge=create({sessionUserId:()=> 'admin',sessionEpoch:()=>1,canReadBook:()=>true,isAdmin:()=>true,
   domain:{normalizeRecord:x=>x},mapPost:x=>x,mapMaterial:x=>x,showToast:()=>{},openSource:(item)=>opened.push(item),
   sb:{rpc:()=>new Promise(resolve=>pending.push(resolve)),from:table=>({select:()=>({eq:async()=>({data:table==='posts'
     ?[{id:version+'-insight',bookId:'emotion',noteType:'insight',meetingNo:'1',q1:version,createdAt:1}]
     :[{id:'mn_'+version,bookId:'emotion',userId:'admin',title:version}]})})})}});
 const oldLoad=bridge.loadRecords('emotion');version='new';const newLoad=bridge.loadRecords('emotion');
 pending[1]({data:[]});await newLoad;
 pending[0]({data:[]});await oldLoad;
 assert.deepEqual(bridge.getInsights('emotion',1).map(row=>row.id),['new-insight']);
 assert.deepEqual(bridge.getMaterials('emotion').map(row=>row.id),['mn_new']);
 bridge.openPost('old-insight','emotion');assert.equal(opened.length,0);
 bridge.openPost('new-insight','emotion');assert.equal(opened[0].q1,'new');
});
test('real domain bridge accepts incomplete new drafts with text material IDs and nullable dates',async()=>{
 const domain=require('../meetingRecordsDomain.js'),f=fixture(domain),draft=domain.newRecord('emotion','admin');
 draft.date='';draft.materialIds=['mn_existing'];
 const saved={...domain.normalizeRecord(draft),revision:1,createdAt:'2026-10-11T00:00:00+00:00',updatedAt:'2026-10-11T00:00:00+00:00'};
 f.result({data:saved});
 assert.deepEqual(await f.bridge.saveRecord(draft),saved);
 assert.equal(f.calls[0][1].p_expected_revision,0);
 assert.equal(f.calls[0][1].p_record.date,null);
 assert.deepEqual(f.calls[0][1].p_record.materialIds,['mn_existing']);
 assert.equal(draft.date,'','normalization never mutates the editor draft');
 await assert.rejects(f.bridge.saveRecord({...draft,createdAt:''}),/기록 시각/);
 assert.equal(f.calls.length,1,'invalid metadata is rejected before any RPC write');
});
