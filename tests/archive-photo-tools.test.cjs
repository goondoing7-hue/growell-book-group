'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Domain=require('../archiveDomain.js'),source=fs.readFileSync(path.join(__dirname,'../archive.js'),'utf8');
const fixture=fs.readFileSync(path.join(__dirname,'archive-ui.test.cjs'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const unesc=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function flush(){for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));}
const environment={Domain,source,clone,unesc,vm,assert,URL,Date,Promise,Set,AbortController,setTimeout,clearTimeout,flush};
const fixtureStart=fixture.indexOf('class Node {'),fixtureEnd=fixture.indexOf("test('empty review",fixtureStart);assert.ok(fixtureStart>=0&&fixtureEnd>fixtureStart);
vm.runInNewContext(fixture.slice(fixtureStart,fixtureEnd)+'\nthis.buildHarness=harness;this.buildRow=makeRow;',environment);
const jpeg=value=>'data:image/jpeg;base64,'+Buffer.concat([Buffer.from([255,216,255]),Buffer.from(value),Buffer.from([255,217])]).toString('base64');
const originalPhoto=jpeg('SYNTHETIC ORIGINAL'),editedPhoto=jpeg('SYNTHETIC EDITED');
function row(photo=originalPhoto){return environment.buildRow('photos',{rating:4,review:'보존할 책 감상',notes:[{id:'kept-note',title:'보존할 제목',text:'보존할 본문',category:'quote',page:7,bgColor:'#E4EEE6',photo,createdAt:1000}]});}
function setup(options={}){
  const h=environment.buildHarness([row(options.photo===undefined?originalPhoto:options.photo)]),calls=[],ocrCalls=[],sourceCalls=[],decodes=[];let photoClosed=0,ocrClosed=0;
  h.c.Blob=Blob;h.c.Uint8Array=Uint8Array;h.c.atob=atob;h.c.location={origin:'https://growell-book.vercel.app',href:'https://growell-book.vercel.app/#/archive'};
  const create=h.doc.createElement;h.doc.createElement=tag=>{if(tag!=='canvas')return create(tag);return {width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=>editedPhoto};};
  h.c.Image=class{constructor(){this.width=600;this.height=400;}set src(value){decodes.push(value);Promise.resolve().then(()=>this.onload());}};
  const photoEditor={edit:async(file,config)=>{calls.push({file,config});return options.edit?options.edit(file,config):new Blob(['synthetic-edited-pixels'],{type:'image/jpeg'});},close(){photoClosed++;}};
  h.c.GrowellPhotoEditor={create:()=>photoEditor};h.c.GrowellBookPhotoOcr={create:config=>({open:request=>ocrCalls.push({config,request}),close(){ocrClosed++;}})};
  if(options.select)h.c.GrowellPhotoSources={create:()=>({open:request=>{sourceCalls.push(request);return options.select(request);},close(){}})};
  if(options.rich){h.adapter.sanitizeHtml=html=>String(html).replace(/<script>[\s\S]*?<\/script>/g,'');h.adapter.plainText=html=>html.replace(/<[^>]*>/g,'');h.adapter.editorHtml=html=>'<div contenteditable="true">'+html+'</div>';h.adapter.bindEditor=()=>()=>{};}
  async function open(){await h.mount();await h.body.querySelector('[data-archive-read-note]').click();const popup=h.body.querySelector('.archive-note-dialog');await popup.querySelector('[data-note-edit]').click();return {popup,form:popup.querySelector('form')};}
  return Object.assign(h,{calls,ocrCalls,sourceCalls,decodes,openEditor:open,get photoClosed(){return photoClosed;},get ocrClosed(){return ocrClosed;}});
}
test('archive notes offer camera, gallery, existing-photo edit and OCR while preserving the original note until save',async()=>{
  const h=setup(),before=clone(h.rows()[0]),{form}=await h.openEditor();assert.ok(form.elements.noteCamera);assert.equal(form.elements.noteCamera.getAttribute('capture'),'environment');assert.ok(form.elements.notePhoto);assert.ok(form.querySelector('[data-note-photo-ocr]'));assert.ok(form.querySelector('[data-note-photo-edit]'));
  form.elements.notePhoto.files=[new Blob(['synthetic-source'],{type:'image/jpeg'})];await form.elements.notePhoto.onchange.call(form.elements.notePhoto);assert.equal(h.calls.length,1);assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),editedPhoto);assert.deepEqual(h.rows()[0],before);assert.equal(h.saved.length,0);
  await form.onsubmit({preventDefault(){}});const stored=h.rows()[0];assert.equal(stored.entry.id,before.entry.id);assert.equal(stored.book.rating,4);assert.equal(stored.book.review,before.book.review);const note=stored.book.notes[0];for(const key of ['id','createdAt','title','text','category','page','bgColor'])assert.equal(note[key],before.book.notes[0][key],key);assert.equal(note.photo,editedPhoto);
});
test('photo editing cancellation or errors keep the original attachment and do not mark the archive note dirty',async()=>{
  for(const edit of [async()=>null,async()=>{throw new Error('PRIVATE IMAGE DETAILS');}]){
    const h=setup({edit}),{popup,form}=await h.openEditor();form.elements.noteCamera.files=[new Blob(['camera-source'],{type:'image/jpeg'})];await form.elements.noteCamera.onchange.call(form.elements.noteCamera);
    assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),originalPhoto);assert.equal(popup._dirty,false);assert.equal(h.saved.length,0);assert.equal(popup.textContent.includes('PRIVATE'),false);assert.equal(form.elements.text.value,'보존할 본문');
  }
});
test('late edited photos are blocked after account, route or form identity changes and removal invalidates pending selection',async()=>{
  for(const change of [h=>h.setSession({userId:'owner'}),h=>h.c.location.href='https://growell-book.vercel.app/#/book/emotion/mine',h=>h.api.reset()]){
    const pending=deferred(),h=setup({edit:()=>pending.promise}),before=clone(h.rows()[0]),{form}=await h.openEditor();form.elements.notePhoto.files=[new Blob(['old-source'],{type:'image/jpeg'})];const work=form.elements.notePhoto.onchange.call(form.elements.notePhoto);await flush();assert.equal(h.calls[0].config.isCurrent(),true);change(h);assert.equal(h.calls[0].config.isCurrent(),false);pending.resolve(new Blob(['old-edited'],{type:'image/jpeg'}));await work;assert.equal(h.saved.length,0);assert.deepEqual(h.rows()[0],before);assert.equal(h.decodes.length,0);
  }
  const pending=deferred(),h=setup({edit:()=>pending.promise}),{form}=await h.openEditor();form.elements.notePhoto.files=[new Blob(['source'],{type:'image/jpeg'})];const work=form.elements.notePhoto.onchange.call(form.elements.notePhoto);await flush();await form.querySelector('[data-note-photo-remove]').click();pending.resolve(new Blob(['late'],{type:'image/jpeg'}));await work;assert.equal(form.querySelector('[data-note-photo-preview] img'),null);assert.equal(h.decodes.length,0);
});
test('existing local photo is decoded for editing but an external photo URL is never fetched or replaced',async()=>{
  const h=setup(),{form}=await h.openEditor();await form.querySelector('[data-note-photo-edit]').click();assert.equal(h.calls.length,1);assert.ok(h.calls[0].file instanceof Blob);assert.equal(h.calls[0].file.type,'image/jpeg');assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),editedPhoto);
  const remote=setup({photo:'https://external.example.test/keep.jpg'}),opened=await remote.openEditor();let fetched=0;remote.setFetch(async()=>{fetched++;throw Error('must not fetch');});await opened.form.querySelector('[data-note-photo-edit]').click();assert.equal(fetched,0);assert.equal(remote.calls.length,0);assert.equal(opened.form.querySelector('[data-note-photo-preview] img').getAttribute('src'),'https://external.example.test/keep.jpg');assert.match(opened.form.querySelector('.archive-form-status').textContent,/기존 외부 사진/);
});
test('archive OCR uses an isolated controller and appends reviewed text to a legacy textarea only on acceptance',async()=>{
  const h=setup(),before=clone(h.rows()[0]),{popup,form}=await h.openEditor();await form.querySelector('[data-note-photo-ocr]').click();assert.equal(h.ocrCalls.length,1);const ocr=h.ocrCalls[0],context=ocr.request.getContext();assert.equal(ocr.request.isCurrent(context),true);assert.equal(form.elements.text.value,'보존할 본문');assert.equal(h.saved.length,0);
  const paragraph=h.doc.createElement('p');paragraph.textContent='인식한 책 문장';ocr.request.editor.appendChild(paragraph);ocr.request.onAppend();assert.equal(form.elements.text.value,'보존할 본문\n\n인식한 책 문장');assert.equal(popup._dirty,true);assert.deepEqual(h.rows()[0],before);assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),originalPhoto);
  await form.onsubmit({preventDefault(){}});assert.equal(h.rows()[0].book.notes[0].text,'보존할 본문\n\n인식한 책 문장');assert.equal(h.rows()[0].book.notes[0].id,before.book.notes[0].id);assert.equal(h.rows()[0].book.notes[0].category,'quote');assert.equal(h.rows()[0].book.notes[0].photo,originalPhoto);
});
test('rich archive OCR targets the existing body and stale contexts cannot modify the next editor or another account',async()=>{
  const h=setup({rich:true}),{form}=await h.openEditor(),body=form.querySelector('[contenteditable="true"]');await form.querySelector('[data-note-photo-ocr]').click();const request=h.ocrCalls[0].request,context=request.getContext();assert.equal(request.editor,body);assert.equal(request.composer,form);assert.equal(request.isCurrent(context),true);
  body.innerHTML+='<p>명시적으로 추가한 책 문장</p>';request.onAppend();assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),originalPhoto);
  h.setSession({userId:'other'});assert.equal(request.isCurrent(context),false);assert.equal(h.saved.length,0);assert.equal(h.rows()[0].book.notes[0].text,'보존할 본문');
});

test('archive media icons use the shared source sheet and cancellation returns to the unchanged note',async()=>{
  const selected=deferred(),h=setup({select:()=>selected.promise}),before=clone(h.rows()[0]),{popup,form}=await h.openEditor();
  const work=form.querySelector('[data-note-photo-pick]').click();await flush();assert.equal(h.sourceCalls[0].mode,'photo');assert.equal(h.sourceCalls[0].isCurrent(),true);assert.equal(form.querySelector('[data-note-photo-pick]').getAttribute('aria-label'),'사진 촬영 또는 첨부');assert.equal(form.querySelector('[data-note-photo-ocr]').getAttribute('aria-label'),'사진에서 글자 추출');
  selected.resolve(null);await work;assert.equal(form.isConnected,true);assert.equal(popup._dirty,false);assert.equal(h.saved.length,0);assert.deepEqual(h.rows()[0],before);assert.equal(form.elements.text.value,'보존할 본문');assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),originalPhoto);
});

test('archive source selection and edit cancellation fence late photos before any draft or saved note replacement',async()=>{
  for(const stale of [false,true]){
    const selected=deferred(),edited=deferred(),h=setup({select:()=>selected.promise,edit:()=>edited.promise}),before=clone(h.rows()[0]),{popup,form}=await h.openEditor();
    const work=form.querySelector('[data-note-photo-pick]').click();await flush();if(stale)h.setSession({userId:'another-member'});selected.resolve(new Blob(['source-pixels'],{type:'image/jpeg'}));await flush();
    if(!stale){assert.equal(h.calls.length,1);h.calls[0].config.onCancel();edited.resolve(new Blob(['cancelled-late-pixels'],{type:'image/jpeg'}));}
    await work;assert.equal(h.calls.length,stale?0:1);assert.equal(h.decodes.length,0);assert.equal(popup._dirty,false);assert.equal(h.saved.length,0);assert.deepEqual(h.rows()[0],before);assert.equal(form.querySelector('[data-note-photo-preview] img').getAttribute('src'),originalPhoto);
  }
});
