'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const api=require('../materialTranscript.js');
const videoId='dQw4w9WgXcQ';
const ready=()=>({status:'ready',videoId,transcript:{text:'첫 문장\n\n  들여쓴 원문 <script>alert(1)</script>',language:'ko',source:'youtube_captions'},fetchedAt:'2026-10-03T01:02:03Z'});
const translated=()=>({...ready(),transcript:{...ready().transcript,text:'Original English captions\n\n  with spacing.',language:'en',title:'실제 영상 제목'},
  translation:{text:'한국어 번역문\n\n  <img src=x onerror=alert(1)>',language:'ko',source:'ai_translation',generatedAt:'2026-10-03T02:00:00Z',model:'translation-model',generationId:'translation-123'}});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(overrides={}){
  const states=[],requests=[],timers=new Map();let serial=0,current=true;
  const options={postId:'post-1',videoId,isCurrent:()=>current,getAccessToken:async()=> 'test-jwt',
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>ready()};},
    render:state=>states.push(state),setTimeout:(callback,delay)=>{timers.set(++serial,{callback,delay});return serial;},clearTimeout:id=>timers.delete(id),...overrides};
  return {controller:api.createController(options),states,requests,timers,setCurrent:value=>current=value};
}

test('the compact control escapes metadata and rejects non-YouTube identifiers',()=>{
  const markup=api.html('post" onclick="bad',{id:videoId,title:'<img src=x onerror=bad>'});
  assert.match(markup,/전체 스크립트/);assert.match(markup,/aria-haspopup="dialog"/);assert.match(markup,/ disabled /);
  assert.ok(markup.includes('post&quot; onclick=&quot;bad'));assert.ok(markup.includes('&lt;img src=x onerror=bad&gt;'));
  assert.doesNotMatch(markup,/<img|data-transcript-title="<|data-transcript-post="post" onclick/);
  assert.equal(api.html('p',{id:'bad-id'}),'');
});

test('requests require the existing JWT and only send the post/video identifiers',async()=>{
  const h=harness();await h.controller.start();
  assert.equal(h.requests.length,1);const request=h.requests[0];
  assert.equal(request.url,'/api/material-video-transcript');assert.equal(request.options.method,'POST');
  assert.equal(request.options.headers.Authorization,'Bearer test-jwt');
  assert.deepEqual(JSON.parse(request.options.body),{postId:'post-1',videoId});
  assert.equal(h.states.at(-1).text,ready().transcript.text);assert.equal(h.timers.size,0);
  const missing=harness({getAccessToken:async()=>null});await missing.controller.start();
  assert.equal(missing.requests.length,0);assert.equal(missing.states.at(-1).reason,'auth_required');
});

test('logout while obtaining authorization cannot start a request',async()=>{
  const token=deferred(),h=harness({getAccessToken:()=>token.promise});
  const done=h.controller.start();h.setCurrent(false);token.resolve('test-jwt');await done;
  assert.equal(h.requests.length,0);assert.deepEqual(h.states,[{status:'loading'}]);
});

test('late response and JSON completion cannot update a changed material or cache it',async()=>{
  let cacheWrites=0;const body=deferred();
  const h=harness({fetch:async()=>({ok:true,json:()=>body.promise}),onReady:()=>cacheWrites++});
  const done=h.controller.start();await tick();h.setCurrent(false);body.resolve(ready());await done;
  assert.equal(cacheWrites,0);assert.deepEqual(h.states,[{status:'loading'}]);
});

test('disposing aborts in-flight requests and suppresses late failures',async()=>{
  const response=deferred();let signal;
  const h=harness({fetch:async(url,options)=>{signal=options.signal;return response.promise;}});
  const done=h.controller.start();await tick();h.controller.dispose();assert.equal(signal.aborted,true);
  response.resolve({ok:false,status:500});await done;
  assert.deepEqual(h.states,[{status:'loading'}]);assert.equal(h.timers.size,0);
});

test('pending is polled at most four times and its retry delay is bounded',async()=>{
  let calls=0;const h=harness({fetch:async()=>{calls++;return {ok:true,json:async()=>({status:'pending',retryAfter:100000})};}});
  await h.controller.start();
  for(let i=0;i<3;i++){
    assert.equal(h.timers.size,1);const [id,timer]=[...h.timers.entries()][0];assert.equal(timer.delay,15000);
    h.timers.delete(id);timer.callback();await tick();
  }
  assert.equal(calls,4);assert.equal(h.states.at(-1).reason,'processing');assert.equal(h.timers.size,0);
});

test('missing materials, unconfigured service, and unavailable captions show distinct statuses',async()=>{
  const missing=harness({fetch:async()=>({ok:false,status:404})});await missing.controller.start();
  assert.equal(missing.states.at(-1).reason,'not_found');assert.match(api.statusText(missing.states.at(-1)),/삭제되었거나 영상 링크가 변경/);
  const unconfigured=harness({fetch:async()=>({ok:true,json:async()=>({status:'unavailable',reason:'not_configured'})})});await unconfigured.controller.start();
  assert.match(api.statusText(unconfigured.states.at(-1)),/준비/);
  const absent=harness({fetch:async()=>({ok:true,json:async()=>({status:'unavailable',reason:'transcript_unavailable'})})});await absent.controller.start();
  assert.match(api.statusText(absent.states.at(-1)),/공개 자막이 없어/);assert.equal(absent.timers.size,0);
});

test('only the matching video and genuine nonempty caption payload can become ready',()=>{
  assert.equal(api.readyData({...ready(),videoId:'abcdefghijk'},videoId),null);
  assert.equal(api.readyData({...ready(),transcript:{...ready().transcript,source:'ai_summary'}},videoId),null);
  assert.equal(api.readyData({...ready(),transcript:{...ready().transcript,text:'  \n'}},videoId),null);
  assert.equal(api.readyData({...ready(),fetchedAt:'not-a-date'},videoId).fetchedAt,'');
  assert.equal(api.readyData(ready(),videoId).text,ready().transcript.text);
});

test('optional server titles are normalized and bounded without dropping a valid transcript',()=>{
  const payload=ready();payload.transcript.title='  실제\n 영상\u0000 제목  ';
  assert.equal(api.readyData(payload,videoId).title,'실제 영상 제목');
  payload.transcript.title='😀'.repeat(301);assert.equal(api.readyData(payload,videoId).title,'😀'.repeat(300));
  for(const title of [undefined,null,{},' \n ']){
    payload.transcript.title=title;const normalized=api.readyData(payload,videoId);
    assert.equal(normalized.title,undefined);assert.equal(normalized.text,payload.transcript.text);
  }
});

test('AI translations remain separate from the required native transcript and keep their provenance',()=>{
  const payload=translated(),data=api.readyData(payload,videoId);
  assert.equal(data.text,payload.transcript.text);assert.equal(data.source,'youtube_captions');assert.equal(data.language,'en');
  assert.deepEqual(data.translation,payload.translation);assert.match(api.statusText(data),/AI 한국어 번역/);
  assert.equal(api.readyData({...payload,transcript:undefined},videoId),null);
  assert.equal(api.readyData({...payload,transcript:{...payload.transcript,source:'ai_translation'}},videoId),null);
  for(const invalid of [{...payload.translation,text:'  '},{...payload.translation,language:'en'},{...payload.translation,source:'youtube_captions'}]){
    const native=api.readyData({...payload,translation:invalid},videoId);assert.equal(native.translation,undefined);assert.equal(native.text,payload.transcript.text);
  }
});

test('a ready native response pending translation stays readable and polls until translation arrives',async()=>{
  let calls=0,cacheWrites=0;const original={...translated(),translation:undefined,translationStatus:'pending',retryAfter:5};
  const h=harness({fetch:async()=>({ok:true,json:async()=>++calls===1?original:translated()}),onReady:()=>cacheWrites++});
  await h.controller.start();assert.equal(h.states.at(-1).status,'ready');assert.equal(h.states.at(-1).text,original.transcript.text);assert.equal(cacheWrites,0);
  assert.match(api.statusText(h.states.at(-1)),/한국어 번역 준비 중/);
  const [id,timer]=[...h.timers.entries()][0];assert.equal(timer.delay,5000);h.timers.delete(id);timer.callback();await tick();
  assert.equal(calls,2);assert.equal(cacheWrites,1);assert.equal(h.states.at(-1).translation.text,translated().translation.text);assert.equal(h.timers.size,0);
});

test('translation polling stops after four requests without hiding or falsely relabeling the native text',async()=>{
  let calls=0,cacheWrites=0;const pending={...translated(),translation:undefined,translationStatus:'pending'};
  const h=harness({fetch:async()=>{calls++;return {ok:true,json:async()=>pending};},onReady:()=>cacheWrites++});
  await h.controller.start();
  for(let i=0;i<3;i++){const [id,timer]=[...h.timers.entries()][0];h.timers.delete(id);timer.callback();await tick();}
  assert.equal(calls,4);assert.equal(cacheWrites,0);assert.equal(h.timers.size,0);
  const state=h.states.at(-1);assert.equal(state.status,'ready');assert.equal(state.text,pending.transcript.text);assert.equal(state.translation,undefined);assert.equal(state.translationRetryAvailable,true);
});

test('translation unavailable is a final native result, while polling failures never fabricate a translation',async()=>{
  let cacheWrites=0;const unavailable={...translated(),translation:undefined,translationStatus:'unavailable'};
  const h=harness({fetch:async()=>({ok:true,json:async()=>unavailable}),onReady:()=>cacheWrites++});
  await h.controller.start();assert.equal(cacheWrites,1);assert.equal(h.states.at(-1).text,unavailable.transcript.text);assert.equal(h.timers.size,0);
  for(const status of [500,401]){
    let calls=0;const failed=harness({fetch:async()=>++calls===1?{ok:true,json:async()=>({...unavailable,translationStatus:'pending'})}:{ok:false,status}});
    await failed.controller.start();const [id,timer]=[...failed.timers.entries()][0];failed.timers.delete(id);timer.callback();await tick();
    const state=failed.states.at(-1);
    if(status===500){assert.equal(state.status,'ready');assert.equal(state.text,unavailable.transcript.text);assert.equal(state.translation,undefined);}
    else{assert.equal(state.reason,'auth_required');assert.equal(state.text,undefined);}
    assert.equal(failed.timers.size,0);
  }
});

class FakeElement{
  constructor(document,tag){this.ownerDocument=document;this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.events={};this.isConnected=true;this.hidden=false;this._text='';this.classNames=new Set();this.classList={add:name=>this.classNames.add(name),remove:name=>this.classNames.delete(name),contains:name=>this.classNames.has(name)};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(value){throw new Error('Untrusted transcript must never enter innerHTML');}
  appendChild(child){child.parentNode=this;this.children.push(child);return child;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  addEventListener(name,handler){(this.events[name] ||= []).push(handler);}
  dispatch(name,event={}){(this.events[name]||[]).forEach(handler=>handler(event));}
  remove(){this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
  focus(){this.ownerDocument.activeElement=this;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatch('close');}
  getBoundingClientRect(){return {left:0,top:0,right:800,bottom:600};}
}
function browserHarness(){
  const document={createElement(tag){return new FakeElement(document,tag);}};document.body=document.createElement('body');
  const listeners=new Map();const browser={document,printCalls:0,setTimeout,clearTimeout,AbortController,
    addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(name,handler){if(listeners.get(name)===handler)listeners.delete(name);},
    print(){this.printCalls++;},listeners};
  return browser;
}
function walk(element){return [element,...element.children.flatMap(walk)];}

test('print uses a separate text-only sheet, preserves lines, and removes it after printing',()=>{
  const browser=browserHarness(),details={...api.readyData(ready(),videoId),title:'<img src=x onerror=alert(1)>'};
  const app=browser.document.createElement('main');browser.document.body.appendChild(app);
  const cleanup=api.printTranscript(browser,details);
  assert.equal(browser.printCalls,1);assert.equal(browser.document.body.classList.contains('mat-transcript-printing'),true);
  const sheet=browser.document.body.children[1],nodes=walk(sheet);
  assert.equal(sheet.className,'mat-transcript-print-sheet');assert.ok(nodes.some(node=>node.textContent===details.text));
  assert.ok(nodes.some(node=>node.textContent===details.title));assert.ok(sheet.textContent.includes('https://www.youtube.com/watch?v='+videoId));
  assert.ok(sheet.textContent.includes('가져온 시각:'));assert.equal(nodes.some(node=>['IFRAME','SCRIPT','IMG'].includes(node.tagName)),false);
  browser.listeners.get('afterprint')();cleanup();
  assert.deepEqual(browser.document.body.children,[app]);assert.equal(browser.document.body.classList.contains('mat-transcript-printing'),false);
});

test('print failure restores the app print state and does not leave a hidden transcript sheet',()=>{
  const browser=browserHarness();browser.print=()=>{throw new Error('print unavailable');};
  assert.throws(()=>api.printTranscript(browser,api.readyData(ready(),videoId)),/print unavailable/);
  assert.equal(browser.document.body.children.length,0);assert.equal(browser.document.body.classList.contains('mat-transcript-printing'),false);assert.equal(browser.listeners.size,0);
});

test('print CSS hides every other body child and preserves the complete transcript without scrolling',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../materialTranscript.css'),'utf8');
  assert.match(css,/@media print/);assert.match(css,/body\.mat-transcript-printing> :not\(\.mat-transcript-print-sheet\)\{display:none!important\}/);
  assert.match(css,/\.mat-transcript-print-text\{[^}]*white-space:pre-wrap[^}]*overflow:visible!important;max-height:none!important/);
});

function bindingHarness(){
  const browser=browserHarness(),element=browser.document.createElement('div');element.setAttribute('data-material-transcript',videoId);element.setAttribute('data-transcript-post','post-1');element.setAttribute('data-transcript-title','테스트 영상');
  const controls={};for(const name of ['open','status','retry'])controls[name]=browser.document.createElement(name==='status'?'span':'button');
  element.querySelector=selector=>controls[selector.match(/data-transcript-(.+)\]/)[1]];
  const container={querySelectorAll:()=>[element]};browser.GrowellPopupHistory={open(){},closed(){}};
  vm.createContext(browser);vm.runInContext(fs.readFileSync(path.join(__dirname,'../materialTranscript.js'),'utf8'),browser);
  let current=true,requests=0;
  const options={container,owner:'member-a',isCurrent:()=>current,getAccessToken:async()=> 'test-token',fetch:async()=>{requests++;return {ok:true,json:async()=>ready()};}};
  return {browser,element,controls,options,api:browser.GrowellMaterialTranscript,setCurrent:value=>current=value,get requests(){return requests;}};
}

test('binding reuses only the current member cache and opens an accessible escaped popup',async()=>{
  const h=bindingHarness();h.api.bind(h.options);await tick();assert.equal(h.requests,1);assert.equal(h.controls.open.disabled,false);
  h.api.bind(h.options);await tick();assert.equal(h.requests,1);
  h.controls.open.onclick();const dialog=h.browser.document.body.children[0],nodes=walk(dialog);
  assert.equal(dialog.tagName,'DIALOG');assert.ok(dialog.getAttribute('aria-labelledby'));assert.equal(dialog.open,true);
  const text=nodes.find(node=>node.className==='mat-transcript-text');assert.equal(text.textContent,ready().transcript.text);assert.equal(text.getAttribute('aria-label'),'자막 원문');
  assert.equal(nodes.some(node=>['SCRIPT','IMG','IFRAME'].includes(node.tagName)),false);
  dialog.dispatch('cancel',{preventDefault(){}});assert.equal(h.browser.document.body.children.length,0);assert.equal(h.browser.document.activeElement,h.controls.open);
  h.api.bind({...h.options,owner:'member-b'});await tick();assert.equal(h.requests,2);
  h.api.dispose();assert.equal(h.controls.open.onclick,null);
});

test('logout or a changed material prevents popup opening and cancels its controls',async()=>{
  const h=bindingHarness();const stop=h.api.bind(h.options);await tick();h.setCurrent(false);h.controls.open.onclick();
  assert.equal(h.browser.document.body.children.length,0);stop();assert.equal(h.controls.open.onclick,null);assert.equal(h.controls.retry.onclick,null);
});

test('the actual server video title wins over a placeholder in both the popup and print sheet',async()=>{
  const h=bindingHarness(),payload=ready();payload.transcript.title='실제 <영상> 제목 & 함께 읽기';payload.transcript.language='en-US';
  h.element.setAttribute('data-transcript-title','유튜브 영상');h.options.fetch=async()=>({ok:true,json:async()=>payload});
  h.api.bind(h.options);await tick();h.controls.open.onclick();
  const dialog=h.browser.document.body.children[0],nodes=walk(dialog);
  assert.equal(nodes.find(node=>node.tagName==='H2').textContent,payload.transcript.title);
  assert.match(nodes.find(node=>node.className==='mat-transcript-notice').textContent,/한국어 자막·번역을 가져올 수 없어 영어 원문/);
  nodes.find(node=>node.className==='mat-transcript-print').dispatch('click');
  const sheet=h.browser.document.body.children.find(node=>node.className==='mat-transcript-print-sheet');
  assert.equal(walk(sheet).find(node=>node.tagName==='H1').textContent,payload.transcript.title);
  assert.match(sheet.textContent,/한국어 자막·번역을 가져올 수 없어 영어 원문/);assert.equal(h.browser.printCalls,1);
  h.api.dispose();
});

test('a missing server title preserves the existing title and Korean captions have no fallback notice',async()=>{
  const h=bindingHarness(),payload=ready();payload.transcript.title={invalid:true};payload.transcript.language='ko-KR';
  h.options.fetch=async()=>({ok:true,json:async()=>payload});h.api.bind(h.options);await tick();h.controls.open.onclick();
  const dialog=h.browser.document.body.children[0];assert.equal(walk(dialog).find(node=>node.tagName==='H2').textContent,'테스트 영상');
  assert.doesNotMatch(dialog.textContent,/한국어 자막을 가져올 수 없어/);assert.ok(dialog.textContent.includes('한국어'));
  const sheet=api.buildPrintSheet(h.browser.document,{...api.readyData(payload,videoId),title:'테스트 영상'});
  assert.doesNotMatch(sheet.textContent,/한국어 자막을 가져올 수 없어/);h.api.dispose();
});

test('translated popups default to clearly labeled Korean and print exactly the selected translation or original',async()=>{
  const h=bindingHarness(),payload=translated();h.options.fetch=async()=>({ok:true,json:async()=>payload});
  h.api.bind(h.options);await tick();h.controls.open.onclick();
  const dialog=h.browser.document.body.children[0],nodes=walk(dialog),content=nodes.find(node=>node.className==='mat-transcript-text');
  const eyebrow=nodes.find(node=>node.className==='mat-transcript-eyebrow'),views=nodes.find(node=>node.className==='mat-transcript-views');
  const original=nodes.find(node=>node.getAttribute('data-transcript-view')==='original'),translation=nodes.find(node=>node.getAttribute('data-transcript-view')==='translation');
  const print=nodes.find(node=>node.className==='mat-transcript-print');
  assert.equal(views.hidden,false);assert.equal(views.getAttribute('aria-label'),'스크립트 보기');assert.equal(content.textContent,payload.translation.text);
  assert.match(eyebrow.textContent,/AI 한국어 번역/);assert.equal(translation.getAttribute('aria-pressed'),'true');assert.equal(original.getAttribute('aria-pressed'),'false');
  assert.equal(nodes.some(node=>['IMG','SCRIPT'].includes(node.tagName)),false);
  print.dispatch('click');let sheet=h.browser.document.body.children.find(node=>node.className==='mat-transcript-print-sheet');
  assert.equal(walk(sheet).find(node=>node.className==='mat-transcript-print-text').textContent,payload.translation.text);
  assert.equal(walk(sheet).find(node=>node.tagName==='H1').textContent,payload.transcript.title);
  assert.match(sheet.textContent,/AI 한국어 번역 · 한국어/);assert.match(sheet.textContent,/원문 언어: 영어/);assert.match(sheet.textContent,/번역 시각:/);
  assert.doesNotMatch(sheet.textContent,/YouTube 공개 자막 원문 · 한국어/);
  h.browser.listeners.get('afterprint')();original.dispatch('click');assert.equal(content.textContent,payload.transcript.text);assert.match(eyebrow.textContent,/공개 자막 원문/);
  assert.equal(original.getAttribute('aria-pressed'),'true');assert.equal(translation.getAttribute('aria-pressed'),'false');
  assert.doesNotMatch(nodes.find(node=>node.className==='mat-transcript-notice').textContent,/가져올 수 없어/);
  print.dispatch('click');sheet=h.browser.document.body.children.find(node=>node.className==='mat-transcript-print-sheet');
  assert.equal(walk(sheet).find(node=>node.className==='mat-transcript-print-text').textContent,payload.transcript.text);
  assert.match(sheet.textContent,/YouTube 공개 자막 원문 · 영어/);assert.doesNotMatch(sheet.textContent,/AI 한국어 번역|번역 시각:/);
  translation.dispatch('click');assert.equal(content.textContent,payload.translation.text);h.api.dispose();
});

test('an open native popup updates when translation finishes, and pending entries are not stored as final cache',async()=>{
  const h=bindingHarness(),timers=new Map();let serial=0,calls=0;
  h.browser.setTimeout=(callback,delay)=>{timers.set(++serial,{callback,delay});return serial;};h.browser.clearTimeout=id=>timers.delete(id);
  h.options.fetch=async()=>({ok:true,json:async()=>++calls<3?{...translated(),translation:undefined,translationStatus:'pending'}:translated()});
  h.api.bind(h.options);await tick();assert.equal(h.controls.open.disabled,false);h.api.bind(h.options);await tick();assert.equal(calls,2);
  h.controls.open.onclick();const dialog=h.browser.document.body.children[0],content=walk(dialog).find(node=>node.className==='mat-transcript-text');
  assert.equal(content.textContent,translated().transcript.text);assert.match(dialog.textContent,/AI 한국어 번역을 준비 중/);
  const [id,timer]=[...timers.entries()][0];timers.delete(id);timer.callback();await tick();
  assert.equal(calls,3);assert.equal(h.browser.document.body.children[0],dialog);assert.equal(content.textContent,translated().translation.text);
  assert.match(walk(dialog).find(node=>node.className==='mat-transcript-eyebrow').textContent,/AI 한국어 번역/);assert.equal(timers.size,0);
  h.api.bind(h.options);await tick();assert.equal(calls,3);h.api.dispose();
});

test('a translated print sheet cannot be built without genuine native source text',()=>{
  const browser=browserHarness(),payload=translated(),data=api.readyData(payload,videoId);
  assert.equal(api.buildPrintSheet(browser.document,{...data,text:''}),null);
  assert.equal(api.buildPrintSheet(browser.document,{...data,source:'ai_translation'}),null);
  const sheet=api.buildPrintSheet(browser.document,data);assert.match(sheet.textContent,/AI 한국어 번역/);
  assert.equal(walk(sheet).find(node=>node.className==='mat-transcript-print-text').textContent,payload.translation.text);
});
