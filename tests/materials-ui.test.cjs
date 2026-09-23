'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const media=require('../materialsMedia.js');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function fragment(){
  let html='';
  return {set innerHTML(value){html=String(value);},get textContent(){return html.replace(/<[^>]*>/g,'');},content:{
    querySelectorAll(selector){
      if(selector==='a[href]')return [...html.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi)].map(match=>({getAttribute:()=>match[1].replace(/&amp;/g,'&')}));
      return [...html.matchAll(new RegExp('<('+selector.split(',').join('|')+')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>','gi'))].map(match=>({remove(){html=html.replace(match[0],'');}}));
    },get textContent(){return html.replace(/<[^>]*>/g,'');}
  }};
}
function harness(){
  const c={URL,Date,Number,String,Array,Object,Promise,Uint8Array,GrowellMaterialsMedia:media,esc,
    stripHtml:value=>String(value).replace(/<[^>]*>/g,''),sanitizeHtml:value=>value||'',svgIcon:()=>'<svg></svg>',
    I_CLOSE:'',I_DOC:'',I_IMG:'',I_PLUS:'',I_EDIT:'',I_COMMENT:'',I_BACK:'',I_LINK:'',
    fmtDate:()=> '2026. 09. 24.',commentsForPost:()=>[{}],SESSION:{userId:'admin'},saveSessionEpoch:1,
    STATE:{materialNotes:{},users:{admin:{authUserId:'auth-admin'}}},isAdmin:()=>true,matFeedFilter:{},materialsComposerOpenFor:null,materialsEditingId:null,
    document:{createElement:()=>fragment(),getElementById:()=>null},
    noteComposerHtml:()=>'<form>composer</form>',safePhotoUrl:media.safeImageUrl,
    postEditDelHtml:(mine,canDelete)=>'<span data-mine="'+mine+'" data-can-delete="'+canDelete+'"></span>',
    publicAuthorHtml:()=>'',postActionsHtml:()=>'',fontSizeOf:()=>({cls:''})};
  vm.createContext(c);
  vm.runInContext(section('var MATERIAL_CATS =','/* ---------------- book cover art')+
    section('function matLinkRowHtml(','function readFileAsDataURL(')+section('function buildMaterialFields(','function submitMaterialPost('),c);
  return c;
}
const book={id:'emotion'};
const post=(id,extra={})=>({id,bookId:'emotion',userId:'admin',title:'자료 '+id,html:'',createdAt:Date.now(),noteType:'meeting',...extra});

test('materials always expose every category, including empty lists, and filter newest-first without dropping categories',()=>{
  const c=harness();
  let html=c.materialsTabHtml(book);
  assert.equal((html.match(/data-filter=/g)||[]).length,6);
  assert.match(html,/자료실<\/h2>/);assert.match(html,/글쓰기/);
  assert.doesNotMatch(html,/share-cta|#모임자료/);
  c.STATE.materialNotes={a:post('a',{createdAt:1}),b:post('b',{createdAt:2,noteType:'video'}),other:post('other',{bookId:'thought'})};
  html=c.materialsTabHtml(book);
  assert.ok(html.indexOf('post/b')<html.indexOf('post/a'));assert.doesNotMatch(html,/post\/other/);
  c.matFeedFilter.emotion='video';html=c.materialsTabHtml(book);
  assert.equal((html.match(/data-filter=/g)||[]).length,6);
  assert.match(html,/aria-pressed="true" data-filter="video"/);assert.match(html,/資料|자료 1개/);
  assert.match(html,/post\/b/);assert.doesNotMatch(html,/post\/a/);
});

test('title and thumbnail use separate links, media opens its original resource, and text-only rows have no placeholder',()=>{
  const c=harness();
  let html=c.matRowHtml(book,post('video',{html:'<a href="https://youtu.be/abcdefghijk">영상</a>',title:'안전한 <제목>'}));
  const links=[...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)];
  assert.equal(links.length,2);assert.match(links[0][0],/href="#\/book\/emotion\/materials\/post\/video"/);
  assert.match(links[1][0],/href="https:\/\/youtu.be\/abcdefghijk"/);assert.match(links[1][0],/target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/유튜브 영상 열기|mat-row-play/);assert.match(html,/안전한 &lt;제목&gt;/);assert.doesNotMatch(links[0][0],/<a\b.*<a\b/);
  html=c.matRowHtml(book,post('pdf',{driveLinks:[{driveUrl:'https://files.example/book.pdf',thumbnailUrl:'https://files.example/first.jpg'}]}));
  assert.match(html,/href="https:\/\/files.example\/book.pdf"/);assert.match(html,/src="https:\/\/files.example\/first.jpg"/);
  html=c.matRowHtml(book,post('text'));
  assert.doesNotMatch(html,/mat-row-media|<img/);
});

test('rich body URLs are read from an inert template and excluded markup cannot add a video preview',()=>{
  const c=harness();
  const urls=c.materialBodyUrls('<script>https://youtu.be/secret12345</script><p>https://youtu.be/abcdefghijk.</p><a href="https://www.youtube.com/watch?v=ABCDEFGHIJK&amp;t=5">보기</a>');
  assert.ok(!urls.some(url=>url.includes('secret')));
  assert.ok(urls.includes('https://youtu.be/abcdefghijk'));
  assert.ok(urls.includes('https://www.youtube.com/watch?v=ABCDEFGHIJK&t=5'));
});

test('attachment metadata survives draft row capture and save normalization, while unsafe links fail explicitly',()=>{
  const c=harness(),values={'[data-mat-row-title]':'자료 PDF','[data-mat-row-url]':'https://files.example/book.pdf','[data-mat-thumbnail]':'https://files.example/custom.jpg','[data-mat-file-name]':'책.pdf','[data-mat-file-type]':'application/pdf','[data-mat-file-size]':'2048'};
  const row={querySelector:selector=>selector in values?{value:values[selector]}:null};
  const link=c.materialLinkFromRow(row);
  const result=c.buildMaterialFields({title:'첨부 글',html:'',noteType:'meeting',driveLinks:[link]});
  assert.equal(result.ok,true);assert.equal(result.fields.driveLinks[0].thumbnailUrl,values['[data-mat-thumbnail]']);
  assert.equal(result.fields.driveLinks[0].fileName,'책.pdf');assert.equal(result.fields.driveLinks[0].fileSize,2048);
  assert.equal(result.fields.driveLinks[0].mimeType,'application/pdf');
  assert.equal(c.buildMaterialFields({title:'x',noteType:'meeting',driveLinks:[{driveUrl:'javascript:alert(1)'}]}).ok,false);
});

test('member list hides writer controls, but detail retains existing owner/admin edit and delete permissions',()=>{
  const c=harness();c.isAdmin=()=>false;
  assert.doesNotMatch(c.materialsTabHtml(book),/btn-open-materials-composer/);
  let html=c.materialNoteCardHtml(book,post('owned'));
  assert.match(html,/data-mine="true" data-can-delete="true"/);
  html=c.materialNoteCardHtml(book,post('other',{userId:'other'}));
  assert.match(html,/data-mine="false" data-can-delete="false"/);
  c.isAdmin=()=>true;html=c.materialNoteCardHtml(book,post('other',{userId:'other'}));
  assert.match(html,/data-mine="false" data-can-delete="true"/);
});

function uploadHarness(c,{rejectUpload=false,previewFails=false,detachDuringUpload=false}={}){
  const values={'[data-mat-row-title]':{value:'기존 자료'},'[data-mat-row-url]':{value:'https://files.example/old.pdf'},'[data-mat-thumbnail]':{value:'https://files.example/old.jpg'},'[data-mat-file-name]':{value:'old.pdf'},'[data-mat-file-type]':{value:'application/pdf'},'[data-mat-file-size]':{value:'123'},'[data-mat-upload-status]':{textContent:''},'[data-mat-thumb-preview]':{hidden:false,src:'https://files.example/old.jpg',removeAttribute(){}}};
  const attrs={},buttons=[{disabled:false}],events={},uploads=[],drafts=[],toasts=[];
  const row={isConnected:true,getAttribute:key=>attrs[key],setAttribute:(key,value)=>{attrs[key]=value;},removeAttribute:key=>{delete attrs[key];},querySelector:selector=>values[selector],querySelectorAll:()=>buttons};
  const container={isConnected:true,querySelector:()=>attrs['data-mat-uploading']==='true'?row:null,addEventListener:(event,handler)=>{events[event]=handler;}};
  const bytes=new TextEncoder().encode('%PDF-1.4\nsynthetic PDF');
  const file={name:'새 자료.pdf',type:'application/pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer};
  const input={files:[file],value:'picked',matches:()=>true,hasAttribute:()=>true,closest:()=>row};
  c.GrowellMaterialsMedia={...media,renderPdfThumbnail:async()=>{if(previewFails)throw new Error('locked PDF');return 'data:image/jpeg;base64,AQID';}};
  c.MAX_FILE_BYTES=7*1024*1024;c.uid=prefix=>prefix+'-id';c.fmtSize=()=> '25MB';
  c.readFileAsDataURL=async()=> 'data:application/pdf;base64,AQID';
  c.uploadPhotoIfNeeded=async(bucket,owner,id,photo)=>{uploads.push({bucket,owner,id,photo});if(detachDuringUpload)row.isConnected=false;if(rejectUpload)throw new Error('network failure');return {dataUrl:'https://files.example/'+id+(id.includes('thumb')?'.jpg':'.pdf')};};
  c.captureComposerDraft=()=>drafts.push(c.materialLinkFromRow(row));c.showToast=(message)=>toasts.push(message);
  c.bindMaterialAttachmentInputs(container);
  return {start:()=>events.change({target:input}),values,uploads,drafts,toasts,row,attrs};
}
async function flush(){for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));}

test('PDF selection uploads original and first-page image under auth owner and preserves metadata in the draft',async()=>{
  const c=harness(),h=uploadHarness(c);h.start();await flush();
  assert.equal(h.uploads.length,2);assert.ok(h.uploads.every(upload=>upload.bucket==='post-photos'&&upload.owner==='auth-admin'));
  assert.equal(h.drafts.length,1);assert.equal(h.drafts[0].mimeType,'application/pdf');assert.equal(h.drafts[0].fileName,'새 자료.pdf');
  assert.match(h.drafts[0].driveUrl,/material-file/);assert.match(h.drafts[0].thumbnailUrl,/material-thumb/);
  assert.equal(h.attrs['data-mat-uploading'],undefined);
});

test('failed or abandoned upload keeps previous attachment intact and never commits late UI state',async()=>{
  for(const options of [{rejectUpload:true},{detachDuringUpload:true}]){
    const c=harness(),h=uploadHarness(c,options);h.start();await flush();
    assert.equal(h.values['[data-mat-row-url]'].value,'https://files.example/old.pdf');
    assert.equal(h.values['[data-mat-thumbnail]'].value,'https://files.example/old.jpg');assert.equal(h.drafts.length,0);
  }
});

test('file selection does not overlap a pending save or start the same row upload twice',async()=>{
  const c=harness(),h=uploadHarness(c);
  c.document.getElementById=()=>({disabled:true});
  h.start();await flush();assert.equal(h.uploads.length,0);assert.equal(h.drafts.length,0);
  c.document.getElementById=()=>null;
  h.start();h.start();await flush();
  assert.equal(h.uploads.length,2);assert.equal(h.drafts.length,1);
});

test('PDF preview failure keeps the original PDF accessible and allows a custom thumbnail next',async()=>{
  const c=harness(),h=uploadHarness(c,{previewFails:true});h.start();await flush();
  assert.equal(h.uploads.length,1);assert.equal(h.drafts.length,1);assert.match(h.drafts[0].driveUrl,/material-file/);
  assert.equal(h.drafts[0].thumbnailUrl,undefined);assert.match(h.values['[data-mat-upload-status]'].textContent,/직접 선택/);
});
