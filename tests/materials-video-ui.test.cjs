'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const media=require('../materialsMedia.js');
const ui=require('../materialsVideo.js');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const ready=(id='abcdefghijk')=>({status:'ready',videoId:id,summary:{overview:'영상 핵심 내용',points:['핵심 하나','핵심 둘','핵심 셋']},generatedAt:'2026-10-03T00:00:00.000Z'});
async function flush(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));}
function setup(overrides={}){
  const renders=[],requests=[],timers=new Map();let timerId=0,current=true;
  const options={postId:'mn-1',videoId:'abcdefghijk',isCurrent:()=>current,getAccessToken:async()=>'synthetic-token',
    fetch:async(url,options)=>{requests.push({url,options});return response(ready());},render:(html,busy)=>renders.push({html,busy}),
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),...overrides};
  return {client:ui.createController(options),renders,requests,timers,options,setCurrent:value=>{current=value;}};
}
test('video parsing matches only YouTube hosts and deduplicates all saved links',()=>{
  const videos=media.videos({driveLinks:[{driveUrl:'https://youtube.com/watch?v=abcdefghijk',title:'제목'}]},[
    'https://youtu.be/abcdefghijk?t=6','https://www.youtube.com/live/ABCDEFGHIJK','https://youtube.com.attacker.example/watch?v=abcdEFGHIJK',
    'https://example.com/?video=https://youtu.be/abc12345678','javascript:alert(1)','https://youtu.be/notvalid']);
  assert.deepEqual(videos.map(video=>video.id),['abcdefghijk','ABCDEFGHIJK']);
  const html=ui.html('mn"unsafe',videos);
  assert.equal((html.match(/<iframe /g)||[]).length,2);assert.match(html,/youtube-nocookie\.com\/embed\/abcdefghijk\?playsinline=1/);
  assert.match(html,/referrerpolicy="strict-origin-when-cross-origin"/);assert.match(html,/allowfullscreen/);
  assert.doesNotMatch(html,/autoplay/);assert.match(html,/data-material-post="mn&quot;unsafe"/);
  assert.equal(ui.html('x',[{id:'" onload="bad'}]),'');
});
test('summary requests send only saved post and video identifiers with member authorization',async()=>{
  const h=setup();h.client.start();await flush();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/material-video-summary');
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{postId:'mn-1',videoId:'abcdefghijk'});
  assert.equal(h.requests[0].options.headers.Authorization,'Bearer synthetic-token');
  assert.match(h.renders.at(-1).html,/영상 핵심 내용/);assert.equal(h.renders.at(-1).busy,false);
  assert.equal(h.timers.size,0);
});
test('summary output remains escaped text and rejects mismatched or malformed ready payloads',async()=>{
  const html=ui.summaryHtml({overview:'<img src=x onerror=bad>',points:['<script>bad()</script>']});
  assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;script&gt;/);
  assert.equal(ui.summaryHtml({overview:'empty',points:[]}),null);
  for(const data of [ready('ABCDEFGHIJK'),{status:'ready',videoId:'abcdefghijk',summary:{overview:'',points:[]}}]){
    const h=setup({fetch:async()=>response(data)});h.client.start();await flush();
    assert.match(h.renders.at(-1).html,/불러오지 못했어요/);assert.doesNotMatch(h.renders.at(-1).html,/핵심 하나/);
  }
});
test('pending results retry at a bounded interval and eventually expose a manual retry',async()=>{
  let calls=0;const h=setup({fetch:async()=>{calls++;return response({status:'pending',retryAfter:3});}});
  h.client.start();await flush();
  for(let i=0;i<4;i++){
    assert.equal(h.timers.size,1);const [id,timer]=[...h.timers][0];assert.equal(timer.ms,3000);
    h.timers.delete(id);timer.fn();await flush();
  }
  assert.equal(calls,5);assert.equal(h.timers.size,0);assert.match(h.renders.at(-1).html,/data-material-video-retry/);
  h.client.start();await flush();assert.equal(calls,6);h.client.dispose();assert.equal(h.timers.size,0);
});
test('unavailable, authorization, and network states never masquerade as generated summaries',async()=>{
  for(const reason of ['video_unavailable','not_configured','rate_limited','temporary_error']){
    const h=setup({fetch:async()=>response({status:'unavailable',reason})});h.client.start();await flush();
    assert.match(h.renders.at(-1).html,/data-material-video-retry/);assert.equal(h.renders.at(-1).busy,false);
    assert.doesNotMatch(h.renders.at(-1).html,/mat-video-points/);
  }
  for(const status of [401,403,404,429]){
    const h=setup({fetch:async()=>response({},status)});h.client.start();await flush();
    assert.equal(h.renders.at(-1).busy,false);assert.doesNotMatch(h.renders.at(-1).html,/mat-video-points/);
  }
  const h=setup({fetch:async()=>{throw new Error('offline');}});h.client.start();await flush();assert.match(h.renders.at(-1).html,/불러오지 못했어요/);
});
test('route changes, deleted links, logout, and disposal ignore late responses and prevent retries',async()=>{
  for(const dispose of [false,true]){
    let finish;const h=setup({fetch:()=>new Promise(resolve=>{finish=resolve;})});h.client.start();await flush();
    const before=h.renders.length;if(dispose)h.client.dispose();else h.setCurrent(false);
    finish(response(ready()));await flush();assert.equal(h.renders.length,before);assert.equal(h.timers.size,0);
  }
  let resolveToken;let requested=false;
  const h=setup({getAccessToken:()=>new Promise(resolve=>{resolveToken=resolve;}),fetch:async()=>{requested=true;return response(ready());}});
  h.client.start();h.setCurrent(false);resolveToken('old-token');await flush();assert.equal(requested,false);
});
test('material detail binding excludes other routes, missing videos, switched members and stale saves',()=>{
  let options;const note={id:'mn-1',bookId:'emotion',driveLinks:[{driveUrl:'https://youtu.be/abcdefghijk'}]};
  const c={GrowellMaterialsVideo:{bind:value=>{options=value;}},GrowellMaterialsMedia:media,SESSION:{userId:'one'},saveSessionEpoch:1,
    STATE:{materialNotes:{'mn-1':note}},location:{href:'https://growell.test/#/book/emotion/materials/post/mn-1'},
    document:{getElementById:()=>({})},window:{fetch(){}},habitSyncAccessToken:()=>{},materialBodyUrls:()=>[]};vm.createContext(c);
  const begin=source.indexOf('function bindMaterialVideos('),end=source.indexOf('function readFileAsDataURL(',begin);
  vm.runInContext(source.slice(begin,end),c);
  c.bindMaterialVideos({view:'book',bookId:'emotion',tab:'materials',postId:'mn-1'});
  assert.equal(options.isCurrent('mn-1','abcdefghijk'),true);
  c.STATE.materialNotes['mn-1']={...note,driveLinks:[]};assert.equal(options.isCurrent('mn-1','abcdefghijk'),false);
  c.STATE.materialNotes['mn-1']=note;c.saveSessionEpoch++;assert.equal(options.isCurrent('mn-1','abcdefghijk'),false);
  c.saveSessionEpoch--;c.SESSION={userId:'two'};assert.equal(options.isCurrent('mn-1','abcdefghijk'),false);
  c.bindMaterialVideos({view:'book',bookId:'emotion',tab:'share',postId:'mn-1'});assert.equal(options.isCurrent('mn-1','abcdefghijk'),false);
});
test('successful material create and edit saves open the saved post only on the current route',()=>{
  const c={SESSION:{userId:'one',name:'사용자'},STATE:{materialNotes:{existing:{id:'existing',bookId:'emotion',userId:'one',createdAt:1}}},isAdmin:()=>true,
    buildMaterialFields:()=>({ok:true,fields:{html:'saved'}}),captureComposerDraft:()=>({}),finishComposerDraft:()=>true,
    uid:()=> 'new-id',saveState:(mutate,options)=>{c.saved=options;},resetMaterialsComposer:()=>{},render:()=>{},location:{hash:'#/book/emotion/materials'}};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function submitMaterialPost('),source.indexOf('function deleteMaterialNote(')),c);
  c.submitMaterialPost('emotion',{});assert.equal(c.location.hash,'#/book/emotion/materials');c.saved.onSuccess();
  assert.equal(c.location.hash,'#/book/emotion/materials/post/new-id');
  c.location.hash='#/book/emotion/materials';c.editMaterialPost('existing',{});c.saved.onSuccess();
  assert.equal(c.location.hash,'#/book/emotion/materials/post/existing');
  c.location.hash='#/book/emotion/materials';c.submitMaterialPost('emotion',{});c.location.hash='#/';c.saved.onSuccess();assert.equal(c.location.hash,'#/');
});
