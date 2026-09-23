'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const media=require('../materialsMedia.js');

const photo='https://files.example.test/photo.jpg';
const pdf='https://files.example.test/guide.pdf';
const video='https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const imageData='data:image/jpeg;base64,YWJj';

test('resource URLs allow normal HTTPS/HTTP but reject executable, credentialed and malformed URLs',()=>{
  assert.equal(media.safeResourceUrl('  '+pdf+'  '),pdf);
  assert.equal(media.safeResourceUrl('http://example.test/file.pdf?a=1&b=2'),'http://example.test/file.pdf?a=1&b=2');
  for(const url of ['javascript:alert(1)','data:application/pdf;base64,YWJj','//example.test/a',
    'https://user:password@example.test/a','https://example.test/a" onload="x','https://example.test/white space',
    'https:\\example.test\a','https://example.test/\nfile','file:///tmp/test.pdf','https://']){
    assert.equal(media.safeResourceUrl(url),null,url);
  }
});

test('YouTube previews use exact trusted hosts and valid video IDs',()=>{
  for(const url of [video,'https://youtu.be/dQw4w9WgXcQ?t=30','https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ','https://youtube.com/live/dQw4w9WgXcQ']){
    assert.equal(media.youtubeId(url),'dQw4w9WgXcQ');
  }
  for(const url of ['https://notyoutube.com/watch?v=dQw4w9WgXcQ','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com/watch?v=too-short',
    'https://youtube.com/redirect?q=dQw4w9WgXcQ','https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ']){
    assert.equal(media.youtubeId(url),null,url);
  }
});

test('uploaded file thumbnail takes precedence and opens the original file URL',()=>{
  const note={photo:{dataUrl:photo},driveLinks:[{title:'Guide',driveUrl:pdf,thumbnailUrl:imageData,mimeType:'application/pdf'}]};
  assert.deepEqual(media.thumbnail(note,[video]),{src:imageData,href:pdf,kind:'file'});
});

test('a separate representative photo opens the attachment, while a photo-only note opens its image',()=>{
  assert.deepEqual(media.thumbnail({photo:{dataUrl:photo},driveLinks:[{driveUrl:pdf}]}),{src:photo,href:pdf,kind:'file'});
  assert.deepEqual(media.thumbnail({photo:{dataUrl:photo},driveLinks:[{driveUrl:video}]}),{src:photo,href:video,kind:'video'});
  assert.deepEqual(media.thumbnail({photo:{dataUrl:photo}}),{src:photo,href:photo,kind:'image'});
});

test('old links and body URLs receive YouTube previews without changing stored post content',()=>{
  const original={driveLinks:[{title:'영상',driveUrl:video}]};
  const before=JSON.stringify(original);
  assert.deepEqual(media.thumbnail(original),{src:'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',href:video,kind:'video'});
  assert.equal(JSON.stringify(original),before);
  assert.equal(media.thumbnail({},['javascript:bad',video]).href,video);
  assert.equal(media.thumbnail({photo:{dataUrl:'data:image/svg+xml;base64,YWJj'}}),null);
  assert.equal(media.thumbnail({driveLinks:[{driveUrl:pdf}]}),null);
});

test('attachment normalization preserves file metadata in existing drive_links JSON and rejects unsafe thumbnails',()=>{
  const original=[{title:' Guide ',driveUrl:pdf,thumbnailUrl:photo,fileName:'guide.pdf',fileSize:2048,mimeType:'application/pdf'},
    {driveUrl:'javascript:alert(1)',thumbnailUrl:photo},{driveUrl:video,thumbnailUrl:'data:image/svg+xml;base64,YWJj'}];
  assert.deepEqual(media.normalizeAttachments(JSON.stringify(original)),[
    {title:'Guide',driveUrl:pdf,thumbnailUrl:photo,fileName:'guide.pdf',fileSize:2048,mimeType:'application/pdf'},
    {title:'',driveUrl:video}]);
  assert.deepEqual(media.normalizeAttachments('{bad json'),[]);
  assert.deepEqual(media.normalizeAttachments({}),[]);
});

function renderer(options={}){
  const calls={pages:[],destroyed:0,rendered:0};
  const canvas={width:0,height:0,getContext:()=>({}),toDataURL:()=>imageData};
  const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render(args){
    calls.rendered++;calls.renderArgs=args;
    return {promise:options.renderError?Promise.reject(new Error('Cannot render')):Promise.resolve()};
  }};
  const pdfjs={getDocument(config){
    calls.config=config;
    return {promise:options.neverResolve?new Promise(()=>{}):Promise.resolve({getPage(number){calls.pages.push(number);return Promise.resolve(page);}}),
      destroy(){calls.destroyed++;return Promise.resolve();}};
  }};
  return {calls,canvas,pdfjs};
}
const pdfBytes=()=>new TextEncoder().encode('%PDF-1.7\nsynthetic PDF test');

test('PDF thumbnail renders only first page, caps dimensions, disables PDF actions and releases parser/canvas',async()=>{
  const fixture=renderer();
  const bytes=pdfBytes();
  const result=await media.renderPdfThumbnail(bytes,{pdfjs:fixture.pdfjs,createCanvas:()=>fixture.canvas});
  assert.equal(result,imageData);
  assert.deepEqual(fixture.calls.pages,[1]);
  assert.equal(fixture.calls.renderArgs.viewport.width,240);
  assert.equal(fixture.calls.renderArgs.viewport.height,320);
  assert.equal(fixture.calls.renderArgs.background,'#ffffff');
  assert.equal(fixture.calls.renderArgs.annotationMode,0);
  assert.equal(fixture.calls.config.isEvalSupported,false);
  assert.equal(fixture.calls.config.enableXfa,false);
  assert.notEqual(fixture.calls.config.data.buffer,bytes.buffer,'renderer transfer must not detach caller bytes');
  assert.equal(fixture.calls.destroyed,1);
  assert.equal(fixture.canvas.width,0);
  assert.equal(fixture.canvas.height,0);
});

test('PDF thumbnail failures and timeouts release resources for manual thumbnail fallback',async()=>{
  const broken=renderer({renderError:true});
  await assert.rejects(media.renderPdfThumbnail(pdfBytes(),{pdfjs:broken.pdfjs,createCanvas:()=>broken.canvas}),/Cannot render/);
  assert.equal(broken.calls.destroyed,1);
  const stalled=renderer({neverResolve:true});
  await assert.rejects(media.renderPdfThumbnail(pdfBytes(),{pdfjs:stalled.pdfjs,createCanvas:()=>stalled.canvas,timeoutMs:10}),/초과/);
  assert.equal(stalled.calls.destroyed,1);
});

test('invalid and oversized PDF files are rejected before loading or rendering a parser',async()=>{
  const fixture=renderer();
  await assert.rejects(media.renderPdfThumbnail(new TextEncoder().encode('not a pdf'),{pdfjs:fixture.pdfjs}),/올바른 PDF/);
  await assert.rejects(media.renderPdfThumbnail({size:media.MAX_PDF_BYTES+1,arrayBuffer(){throw new Error('must not read');}},{pdfjs:fixture.pdfjs}),/25MB/);
  assert.equal(fixture.calls.config,undefined);
  assert.equal(media.isPdf({name:'notes.PDF'}),true);
  assert.equal(media.isPdf({type:'application/pdf'}),true);
  assert.equal(media.isPdf({name:'notes.pdf.exe',type:'application/octet-stream'}),false);
});
