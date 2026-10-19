'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const start=html.indexOf("  var photoPreview = document.getElementById('photo-preview');"),end=html.indexOf("  if(typeof GrowellBookPhotoOcr!=='undefined'){",start);assert.ok(start>=0&&end>start);
const fixture=fs.readFileSync(path.join(__dirname,'book-photo-ocr.test.cjs'),'utf8'),nodeStart=fixture.indexOf('class Node{'),nodeEnd=fixture.indexOf('\nfunction harness(',nodeStart);
const scope={};vm.runInNewContext(fixture.slice(nodeStart,nodeEnd)+'\nthis.FixtureNode=Node;',scope);const Node=scope.FixtureNode;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
const sourcePhoto='https://example.test/synthetic-original-photo.jpg';
function harness(options={}){
  const body=new Node('body'),composer=new Node('div',{'class':'composer','data-draft-key':'synthetic-draft','data-draft-user':'owner'}),editor=new Node('div'),preview=new Node('div',{'id':'photo-preview'});
  editor.textContent='보존할 원래 본문';editor.closest=()=>composer;body.appendChild(composer);composer.appendChild(editor);composer.appendChild(preview);
  preview.innerHTML='<div><img src="'+sourcePhoto+'"></div>';
  for(const id of ['btn-photo-pick','note-photo-input','btn-photo-capture','note-photo-camera'])composer.appendChild(new Node(id.includes('input')||id==='note-photo-camera'?'input':'button',{id}));
  const edited=[],resized=[],toasts=[];let captures=0;
  const state={SESSION:{userId:'owner',keyB64:'synthetic-key'},saveSessionEpoch:4,location:{hash:'#/book/emotion/mine'},noteEditor:editor,
    document:{getElementById:id=>body.querySelector('#'+id)},showToast:(...args)=>toasts.push(args),captureComposerDraft:()=>{captures++;},
    GrowellPhotoSources:options.sources,
    GrowellPhotoEditor:{edit(file,config){edited.push({file,config});return options.edit?options.edit(file,config):Promise.resolve(new Blob(['accepted-edited-image'],{type:'image/jpeg'}));}},
    resizeNotePhotoDataUrl(image){resized.push(image);return options.resize?options.resize(image):Promise.resolve('data:image/jpeg;base64,RURJVEVELVBJWEVMUw==');}
  };
  vm.createContext(state);vm.runInContext(html.slice(start,end),state);
  function choose(file={type:'image/jpeg',size:2048},camera=false){const input=state.document.getElementById(camera?'note-photo-camera':'note-photo-input');input.files=[file];input.dispatchEvent({type:'change'});return flush();}
  return {state,body,composer,editor,preview,edited,resized,toasts,choose,get captures(){return captures;},photo:()=>JSON.parse(JSON.stringify(state.notePhotoData))};
}
test('original attachment and body stay intact until an edited photo is accepted and resized',async()=>{
  const editing=deferred(),resizing=deferred(),h=harness({edit:()=>editing.promise,resize:()=>resizing.promise}),original=h.photo();await h.choose();
  assert.deepEqual(h.photo(),original);assert.equal(h.editor.textContent,'보존할 원래 본문');assert.equal(h.captures,0);assert.equal(h.resized.length,0);
  const edited=new Blob(['accepted-only'],{type:'image/jpeg'});editing.resolve(edited);await flush();assert.equal(h.resized[0],edited);assert.deepEqual(h.photo(),original);assert.equal(h.captures,0);
  resizing.resolve('data:image/jpeg;base64,QUxMT1dFRC1FRElURUQ=');await flush();assert.deepEqual(h.photo(),{dataUrl:'data:image/jpeg;base64,QUxMT1dFRC1FRElURUQ=',mimeType:'image/jpeg'});assert.equal(h.captures,1);assert.equal(h.editor.textContent,'보존할 원래 본문');
});
test('gallery and camera use separate inputs but share the same explicit photo editor boundary',async()=>{
  const h=harness();const gallery=h.state.document.getElementById('note-photo-input'),camera=h.state.document.getElementById('note-photo-camera');
  h.state.document.getElementById('btn-photo-pick').click();h.state.document.getElementById('btn-photo-capture').click();assert.equal(gallery.clickCount,1);assert.equal(camera.clickCount,1);
  const image={type:'image/png',size:3000};await h.choose(image,true);assert.equal(h.edited[0].file,image);assert.equal(h.edited[0].config.trigger,h.state.document.getElementById('btn-photo-capture'));assert.equal(camera.value,'');assert.equal(h.captures,1);
});
test('cancelled or failed editing and failed resizing preserve the original attachment, text and draft',async()=>{
  for(const options of [{edit:async()=>null},{edit:async()=>{throw new Error('PRIVATE PHOTO DETAILS');}},{resize:async()=>{throw new Error('PRIVATE PHOTO DETAILS');}}]){
    const h=harness(options),original=h.photo();await h.choose();assert.deepEqual(h.photo(),original);assert.equal(h.editor.textContent,'보존할 원래 본문');assert.equal(h.captures,0);assert.equal(JSON.stringify(h.toasts).includes('PRIVATE'),false);
  }
});
test('session, epoch, route, draft owner and original editor identity guard both editing and late resizing',async()=>{
  const changes=[h=>{h.state.SESSION={userId:'owner'};},h=>{h.state.SESSION=null;},h=>{h.state.saveSessionEpoch++;},h=>{h.state.location.hash='#/book/emotion/share';},h=>{h.composer.setAttribute('data-draft-key','different-draft');},h=>{h.composer.setAttribute('data-draft-user','different-owner');},h=>{h.editor.remove();},h=>{h.composer.remove();},h=>{h.editor.closest=()=>new Node('div');}];
  for(const change of changes)for(const phase of ['editing','resizing']){
    const pending=deferred(),h=harness(phase==='editing'?{edit:()=>pending.promise}:{resize:()=>pending.promise}),original=h.photo();await h.choose();assert.equal(h.edited[0].config.isCurrent(),true);change(h);assert.equal(h.edited[0].config.isCurrent(),false);
    pending.resolve(phase==='editing'?new Blob(['old-photo'],{type:'image/jpeg'}):'data:image/jpeg;base64,T0xELVBIT1RP');await flush();assert.deepEqual(h.photo(),original,phase);assert.equal(h.captures,0,phase);assert.equal(h.editor.textContent,'보존할 원래 본문');
  }
});
test('a newer selection invalidates the earlier photo result and prevents late resize replacement',async()=>{
  const first=deferred(),second=deferred();let request=0;const h=harness({resize:()=>++request===1?first.promise:second.promise});
  await h.choose({type:'image/jpeg',size:1000});await h.choose({type:'image/jpeg',size:2000});assert.equal(h.edited[0].config.isCurrent(),false);assert.equal(h.edited[1].config.isCurrent(),true);
  second.resolve('data:image/jpeg;base64,TkVXLVBJQ1RVUkU=');await flush();first.resolve('data:image/jpeg;base64,T0xELVBJQ1RVUkU=');await flush();assert.equal(h.photo().dataUrl,'data:image/jpeg;base64,TkVXLVBJQ1RVUkU=');assert.equal(h.captures,1);
});
test('removing the preview during a pending resize invalidates that older photo so it cannot reappear',async()=>{
  const resized=deferred(),h=harness({resize:()=>resized.promise});await h.choose();
  h.state.document.getElementById('btn-photo-remove').click();assert.equal(h.photo(),null);assert.equal(h.captures,1);
  resized.resolve('data:image/jpeg;base64,TEFURS1SRVNPTEZFRD1JTUFHRQ==');await flush();assert.equal(h.photo(),null);assert.equal(h.captures,1);
});
test('unsupported or oversized inputs do not reach editing and keep existing photo data untouched',async()=>{
  for(const image of [{type:'text/html',size:100},{type:'image/jpeg',size:20*1024*1024+1}]){
    const h=harness(),original=h.photo();await h.choose(image);assert.equal(h.edited.length,0);assert.equal(h.resized.length,0);assert.deepEqual(h.photo(),original);assert.equal(h.captures,0);assert.equal(h.toasts.length,1);
  }
});

test('the single photo icon opens its source sheet and cancellation preserves the original body and attachment',async()=>{
  const selected=deferred(),requests=[],h=harness({sources:{open:settings=>{requests.push(settings);return selected.promise;}}}),original=h.photo();
  h.state.document.getElementById('btn-photo-pick').click();assert.equal(requests[0].mode,'photo');assert.equal(requests[0].isCurrent(),true);assert.equal(h.edited.length,0);
  selected.resolve(null);await flush();assert.deepEqual(h.photo(),original);assert.equal(h.editor.textContent,'보존할 원래 본문');assert.equal(h.composer.isConnected,true);assert.equal(h.captures,0);
});

test('a source-sheet file reaches the editor only for the original composer and a cancelled editor rejects its late Blob',async()=>{
  for(const stale of [false,true]){
    const selected=deferred(),editing=deferred(),h=harness({sources:{open:()=>selected.promise},edit:()=>editing.promise}),original=h.photo();h.state.document.getElementById('btn-photo-pick').click();
    if(stale)h.state.saveSessionEpoch++;selected.resolve({type:'image/jpeg',size:2048});await flush();
    if(stale){assert.equal(h.edited.length,0);continue;}
    assert.equal(h.edited.length,1);h.edited[0].config.onCancel();editing.resolve(new Blob(['must-not-attach-after-cancel'],{type:'image/jpeg'}));await flush();
    assert.equal(h.resized.length,0);assert.deepEqual(h.photo(),original);assert.equal(h.captures,0);assert.equal(h.editor.textContent,'보존할 원래 본문');
  }
});

test('common composers render just the two labelled media icons instead of separate camera and gallery buttons',()=>{
  const a=html.indexOf('function noteComposerHtml('),b=html.indexOf('\nfunction ',a+20),composer=html.slice(a,b);
  assert.match(composer,/class="note-photo-tool" id="btn-photo-pick"[^>]+aria-label="사진 촬영 또는 첨부"/);
  assert.match(composer,/id="btn-book-photo-ocr"[^>]+aria-label="사진에서 글자 추출"/);assert.match(composer,/photo-ocr-letter/);
  assert.doesNotMatch(composer,/id="btn-photo-capture"/);assert.match(html,/<script src="photoSources\.js"><\/script>/);assert.match(html,/<link rel="stylesheet" href="photoSources\.css">/);
});
